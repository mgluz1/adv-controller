import type { Request, Response } from "express";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { withTenant } from "../db/tenant.ts";
import type { Tx } from "../db/types.ts";
import { requireContext, type Deps } from "./context.ts";

type Op = (deps: Deps, req: Request, res: Response, body: Record<string, unknown>) => Promise<unknown>;

const R = schema.syncRuns;
const C = schema.syncCursors;
const A = schema.attorneys;

/** Resumo da coleta do escritório (alimenta a listagem e o diagnóstico). Sem inventar dados: sem execuções, tudo nulo/zero. */
export async function collectionSummary(tx: Tx) {
  const [latest] = await tx.select().from(R).orderBy(desc(R.startedAt)).limit(1);
  const [ok] = await tx
    .select({ at: sql<Date | null>`max(${R.finishedAt})` })
    .from(R)
    .where(eq(R.status, "sucesso"));
  // Janelas pendentes e próxima execução consideram só OABs ATIVAS.
  const [pending] = await tx
    .select({ n: sql<number>`coalesce(sum(greatest(0, (${C.targetDay} - ${C.scanDay}) + 1)), 0)::int` })
    .from(C)
    .innerJoin(A, eq(A.id, C.attorneyId))
    .where(and(eq(A.active, true), isNotNull(C.scanDay), isNotNull(C.targetDay)));
  const [due] = await tx
    .select({ at: sql<Date | null>`min(${C.nextDueAt})` })
    .from(C)
    .innerJoin(A, eq(A.id, C.attorneyId))
    .where(eq(A.active, true));
  return {
    latest: latest
      ? {
          id: latest.id,
          attorney_id: latest.attorneyId,
          window_day: latest.windowDay,
          trigger: latest.trigger,
          status: latest.status,
          started_at: latest.startedAt,
          finished_at: latest.finishedAt,
          http_status: latest.httpStatus,
          error_message: latest.errorMessage,
        }
      : null,
    last_success: ok?.at ?? null,
    next_due: due?.at ?? null,
    pending_windows: pending?.n ?? 0,
  };
}

/**
 * `djen_diagnostics` (qualquer papel lê). Contrato do painel: última tentativa, última janela concluída, próxima execução,
 * janelas pendentes, últimas 20 execuções e o estado da fonte. Não há "sonda" separada: cada janela É uma sonda (o adaptador
 * valida a OAB de cada item), então `source_check` vem da execução mais recente que obteve resposta da fonte.
 */
async function djen_diagnostics(deps: Deps, req: Request) {
  const c = await requireContext(deps, req, ["sync", "read"]);
  return withTenant(deps.db, c.organizationId, async (tx) => {
    const summary = await collectionSummary(tx);

    const runs = await tx
      .select({
        id: R.id,
        attorney_id: R.attorneyId,
        start_day: R.windowDay,
        trigger: R.trigger,
        status: R.status,
        started_at: R.startedAt,
        finished_at: R.finishedAt,
        http_status: R.httpStatus,
        pages: R.pages,
        fetched_count: R.itemsFound,
        inserted_count: R.itemsInserted,
        error_kind: R.errorKind,
        error_message: R.errorMessage,
      })
      .from(R)
      .orderBy(desc(R.startedAt), desc(R.id))
      .limit(20);

    const [answered] = await tx.select().from(R).where(isNotNull(R.httpStatus)).orderBy(desc(R.startedAt), desc(R.id)).limit(1);

    // Estado por OAB (suporte): o que o coletor sabe de cada uma.
    const cursors = await tx
      .select({
        attorney_id: A.id,
        name: A.name,
        oab_number: A.oabNumber,
        uf: A.uf,
        active: A.active,
        scan_day: sql<string | null>`${C.scanDay}::text`,
        target_day: sql<string | null>`${C.targetDay}::text`,
        last_complete_day: sql<string | null>`${C.lastCompleteDay}::text`,
        next_due_at: C.nextDueAt,
        leased: sql<boolean>`(${C.leaseId} is not null and ${C.leaseUntil} > now())`,
        consecutive_failures: C.consecutiveFailures,
        last_error: C.lastError,
      })
      .from(A)
      .leftJoin(C, eq(C.attorneyId, A.id))
      .orderBy(asc(A.name), asc(A.id));

    return {
      ...summary,
      runs,
      source_check: answered
        ? {
            http_status: answered.httpStatus,
            checked_at: answered.finishedAt ?? answered.startedAt,
            // Uma janela concluída com sucesso prova que a fonte respondeu e que a OAB consultada confere em todos os itens.
            filter_verified: answered.status === "sucesso",
            error_kind: answered.errorKind,
            message: answered.errorMessage,
          }
        : null,
      cursors,
      collector: { enabled: !!deps.scheduler?.enabled },
    };
  });
}

export const diagnosticsOps: Record<string, Op> = { djen_diagnostics };
