import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError, requireContext, type Deps } from "./context.ts";

/**
 * `djen_sync_manual` ("Buscar agora"). Não coleta dentro da requisição (um ciclo são dezenas de janelas, uma a cada
 * 4 s): registra o pedido, torna as OABs ativas vencidas AGORA e acorda o agendador. O resultado aparece na listagem e
 * no diagnóstico.
 *
 * Limite: UMA solicitação a cada 5 minutos POR ESCRITÓRIO, compartilhado entre os usuários (REGRAS §2). O instante da
 * última solicitação é o do evento de auditoria `sync.requested` (que já carrega o autor); um lock de transação
 * serializa pedidos simultâneos, então só um passa.
 */
export const MANUAL_SYNC_COOLDOWN_MS = 5 * 60_000;

type Op = (deps: Deps, req: Request, res: Response, body: Record<string, unknown>) => Promise<unknown>;

async function djen_sync_manual(deps: Deps, req: Request): Promise<unknown> {
  const c = await requireContext(deps, req, ["sync", "request"]);
  const at = new Date().toISOString();

  const result = await withTenant(deps.db, c.organizationId, async (tx) => {
    // Serializa os pedidos deste escritório (liberado no fim da transação; compatível com pooler).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"sync_manual:" + c.organizationId}, 0))`);

    const [{ age, attorneys }] = (
      await tx.execute(sql`
        select coalesce((select extract(epoch from (now() - max(created_at))) from audit_log where action = 'sync.requested'), 1e12)::float8 as age,
               (select count(*) from attorneys where active)::int as attorneys`)
    ).rows as { age: number; attorneys: number }[];

    if (attorneys === 0) return { kind: "no_attorneys" as const };
    const waitMs = MANUAL_SYNC_COOLDOWN_MS - Number(age) * 1000;
    if (waitMs > 0) return { kind: "limited" as const, waitMs };

    // Vence agora, sem desfazer lease em andamento (a janela corrente termina) e passando por cima de recuo de falha:
    // quem pediu quer uma tentativa já. O limite acima evita insistir contra uma fonte bloqueando.
    await tx.execute(sql`
      insert into sync_cursors (organization_id, attorney_id, next_due_at)
      select organization_id, id, ${at}::timestamptz from attorneys where active
      on conflict (attorney_id) do nothing`);
    await tx.execute(sql`
      update sync_cursors c set next_due_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
       where exists (select 1 from attorneys a where a.id = c.attorney_id and a.active)
         and (c.lease_id is null or c.lease_until <= ${at}::timestamptz)`);
    await tx.insert(schema.auditLog).values({
      organizationId: c.organizationId,
      actorUserId: c.userId,
      action: "sync.requested",
      entityType: "sync",
      details: { attorneys },
    });
    return { kind: "ok" as const, attorneys };
  });

  if (result.kind === "no_attorneys")
    throw new HttpError(409, "Cadastre ao menos uma OAB ativa antes de solicitar a coleta.");
  if (result.kind === "limited")
    throw new HttpError(429, `Uma coleta já foi solicitada há pouco. Aguarde ${Math.max(1, Math.ceil(result.waitMs / 60_000))} min para solicitar de novo.`);

  deps.scheduler?.wake(c.organizationId);
  return {
    sucesso: true,
    mensagem: deps.scheduler?.enabled
      ? `Coleta solicitada para ${result.attorneys} OAB(s). As publicações novas aparecem aqui em instantes; acompanhe no diagnóstico.`
      : `Coleta solicitada para ${result.attorneys} OAB(s). Ela começa assim que o coletor do servidor estiver ativo.`,
  };
}

export const syncOps: Record<string, Op> = { djen_sync_manual };
