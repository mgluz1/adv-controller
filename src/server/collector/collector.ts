/**
 * Coletor do DJEN: UMA janela (um dia × uma OAB) por execução. docs/MIGRACAO.md §4, REGRAS §1–§3.
 *
 *  1. claim  (transação curta): escolhe uma OAB com trabalho vencido, grava um lease novo (fencing) e abre a
 *     execução em `sync_runs`. Nenhuma transação fica aberta durante a chamada de rede.
 *  2. coleta (sem transação): `collectDay` — completa e validada, ou falha explícita.
 *  3. commit (UMA transação): confere o lease; grava publicações + vínculos + execução + cursor. Tudo ou nada:
 *     o cursor só avança se a janela inteira foi gravada. Um worker com lease vencido/trocado é RECUSADO e nada é gravado.
 *  4. falha: libera o lease, conta a falha e adia a próxima tentativa (recuo); a janela se repete, nunca é pulada.
 *
 * Tempo: tudo usa o relógio da aplicação (`now`, injetável), inclusive nas comparações de lease; assim os testes
 * são determinísticos e não dependem do relógio do banco.
 * Isolamento: cada escritório é tratado dentro de `withTenant` (RLS). Não existe papel com visão global.
 * Pendências conscientes: gate de assinatura (Fase 3) entra em `organizationIds`; o ritmo global entre janelas
 * (mínimo 4 s) e o disparo diário/manual são do agendador (tarefa 1.5).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { withTenant } from "../db/tenant.ts";
import type { Db } from "../db/types.ts";
import { collectDay, SourceError, type DayResult, type FailureKind } from "../djen/client.ts";
import { toPublicationRow } from "./normalize.ts";
import { backoffMs, nextDailyDue, planCycle, todayBrt } from "./schedule.ts";

const P = schema.publications;
const PA = schema.publicationAttorneys;

/** O worker perdeu o lease (expirou e outro assumiu, ou o cursor mudou): nada foi gravado. */
export class StaleLeaseError extends Error {
  constructor(message = "Lease expirado ou substituído: a janela não foi gravada.") {
    super(message);
    this.name = "StaleLeaseError";
  }
}

export interface Claim {
  organizationId: string;
  attorneyId: string;
  oabNumber: string;
  uf: string;
  /** Dia da janela (AAAA-MM-DD). */
  day: string;
  /** Último dia do ciclo em andamento. */
  target: string;
  leaseId: string;
  runId: string;
}

export type Outcome =
  | { status: "idle" }
  | { status: "success"; claim: Claim; found: number; inserted: number; pages: number }
  | { status: "failed"; claim: Claim; kind: FailureKind | "INTERNAL"; message: string; retryAt: Date }
  | { status: "stale"; claim: Claim };

export const DEFAULT_LEASE_MS = 5 * 60_000;
const CHUNK = 200;
const chunks = <T>(a: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
const iso = (d: Date) => d.toISOString();

// ── 1. claim ──────────────────────────────────────────────────────────────────

/**
 * Reivindica a próxima janela do escritório, ou devolve null. Roda numa transação `withTenant`.
 * `FOR UPDATE SKIP LOCKED`: dois workers nunca pegam a mesma OAB; o lease cobre a parte fora da transação.
 */
export async function claimWindow(db: Db, organizationId: string, now: Date, leaseMs = DEFAULT_LEASE_MS): Promise<Claim | null> {
  return withTenant(db, organizationId, async (tx) => {
    const at = iso(now);
    // Toda OAB ativa tem cursor (criado sob demanda; vence imediatamente).
    await tx.execute(sql`
      insert into sync_cursors (organization_id, attorney_id, next_due_at)
      select organization_id, id, ${at}::timestamptz from attorneys where active
      on conflict (attorney_id) do nothing`);

    const found = await tx.execute(sql`
      select c.attorney_id, c.scan_day::text as scan_day, c.target_day::text as target_day,
             c.last_complete_day::text as last_complete_day, c.last_reconciled_on::text as last_reconciled_on,
             a.oab_number, a.uf
        from sync_cursors c
        join attorneys a on a.id = c.attorney_id and a.organization_id = c.organization_id
       where a.active
         and (c.lease_id is null or c.lease_until <= ${at}::timestamptz)
         and (c.next_due_at is null or c.next_due_at <= ${at}::timestamptz)
       order by c.next_due_at nulls first, c.attorney_id
       limit 1
         for update of c skip locked`);
    const row = found.rows[0] as
      | { attorney_id: string; scan_day: string | null; target_day: string | null; last_complete_day: string | null; last_reconciled_on: string | null; oab_number: string; uf: string }
      | undefined;
    if (!row) return null;

    // Ciclo em andamento continua de onde parou; senão planeja um novo (primeira carga, sobreposição, reconciliação, lacuna).
    let scan = row.scan_day;
    let target = row.target_day;
    let reconciledOn = row.last_reconciled_on;
    if (!(scan && target && scan <= target)) {
      const today = todayBrt(now);
      const plan = planCycle(today, row.last_complete_day, row.last_reconciled_on);
      scan = plan.start;
      target = today;
      // Marcado ao INICIAR o ciclo: o ciclo persiste (scan_day) e termina antes de outro começar.
      if (plan.reconcile) reconciledOn = today;
    }

    const leaseId = randomUUID();
    await tx.execute(sql`
      update sync_cursors
         set lease_id = ${leaseId}::uuid, lease_until = ${iso(new Date(now.getTime() + leaseMs))}::timestamptz,
             scan_day = ${scan}::date, target_day = ${target}::date, last_reconciled_on = ${reconciledOn}::date,
             updated_at = ${at}::timestamptz
       where attorney_id = ${row.attorney_id}::uuid`);
    // Execução anterior sem desfecho (worker morreu) é encerrada como abandonada.
    await tx.execute(sql`
      update sync_runs set status = 'erro', finished_at = ${at}::timestamptz, error_kind = 'ABANDONED',
             error_message = 'Execução abandonada: o lease expirou antes da conclusão.'
       where attorney_id = ${row.attorney_id}::uuid and status = 'executando'`);
    const [run] = await tx
      .insert(schema.syncRuns)
      .values({ organizationId, attorneyId: row.attorney_id, windowDay: scan!, trigger: "agendada", status: "executando", startedAt: now })
      .returning({ id: schema.syncRuns.id });

    return { organizationId, attorneyId: row.attorney_id, oabNumber: row.oab_number, uf: row.uf, day: scan!, target: target!, leaseId, runId: run.id };
  });
}

// ── 3. commit ─────────────────────────────────────────────────────────────────

/**
 * Grava a janela concluída, ATOMICAMENTE. Lança `StaleLeaseError` (sem gravar nada) se o lease não é mais deste worker.
 * Reimportar é seguro: o que já existe não é alterado (status, notas e providência ficam), arquivadas continuam arquivadas
 * e descartadas (tombstone) não voltam nem ganham vínculo.
 */
export async function commitWindow(db: Db, claim: Claim, result: DayResult, now: Date): Promise<{ found: number; inserted: number }> {
  return withTenant(db, claim.organizationId, async (tx) => {
    const at = iso(now);
    // (a) Fencing + avanço do cursor PRIMEIRO: se o lease não vale, a transação aborta antes de qualquer gravação.
    const moved = await tx.execute(sql`
      update sync_cursors
         set scan_day = ${claim.day}::date + 1,
             last_complete_day = case when ${claim.day}::date >= target_day then target_day else last_complete_day end,
             next_due_at = case when ${claim.day}::date >= target_day then ${iso(nextDailyDue(now))}::timestamptz else ${at}::timestamptz end,
             lease_id = null, lease_until = null, consecutive_failures = 0, last_error = null, updated_at = ${at}::timestamptz
       where attorney_id = ${claim.attorneyId}::uuid
         and lease_id = ${claim.leaseId}::uuid and lease_until > ${at}::timestamptz
         and scan_day = ${claim.day}::date
       returning attorney_id`);
    if (moved.rows.length === 0) throw new StaleLeaseError();

    // (b) Publicações novas (as existentes não são tocadas).
    const rows = result.items.map((it) => toPublicationRow(it, claim.organizationId, claim.day, now));
    let inserted = 0;
    for (const part of chunks(rows)) {
      const got = await tx.insert(P).values(part).onConflictDoNothing({ target: [P.organizationId, P.sourceId] }).returning({ id: P.id });
      inserted += got.length;
    }

    // (c) Vínculo OAB↔publicação para TODAS as vivas da janela (novas e já existentes, p.ex. achadas por outra OAB).
    const ids = rows.map((r) => r.sourceId);
    const live: { id: string; sourceId: string }[] = [];
    for (const part of chunks(ids)) {
      live.push(...(await tx.select({ id: P.id, sourceId: P.sourceId }).from(P).where(and(inArray(P.sourceId, part), isNull(P.removedAt)))));
    }
    for (const part of chunks(live)) {
      await tx
        .insert(PA)
        .values(part.map((p) => ({ organizationId: claim.organizationId, publicationId: p.id, attorneyId: claim.attorneyId })))
        .onConflictDoNothing();
    }
    // Visto de novo: só `last_seen_at`; nada do que o advogado anotou muda.
    for (const part of chunks(live.map((l) => l.id))) {
      await tx.update(P).set({ lastSeenAt: now }).where(inArray(P.id, part));
    }

    // (d) Encerra a execução.
    await tx
      .update(schema.syncRuns)
      .set({ status: "sucesso", finishedAt: now, httpStatus: result.status, pages: result.pages, itemsFound: rows.length, itemsInserted: inserted })
      .where(and(eq(schema.syncRuns.id, claim.runId), eq(schema.syncRuns.status, "executando")));
    return { found: rows.length, inserted };
  });
}

// ── 4. falha ──────────────────────────────────────────────────────────────────

/** Registra a falha e adia a janela. Só mexe no cursor se o lease ainda é deste worker. */
export async function failWindow(
  db: Db,
  claim: Claim,
  err: { kind: FailureKind | "INTERNAL"; message: string; httpStatus?: number; retryAfter?: number },
  now: Date,
): Promise<{ retryAt: Date; failures: number }> {
  return withTenant(db, claim.organizationId, async (tx) => {
    const at = iso(now);
    const message = err.message.slice(0, 500);
    const bumped = await tx.execute(sql`
      update sync_cursors
         set consecutive_failures = consecutive_failures + 1, last_error = ${message}, updated_at = ${at}::timestamptz
       where attorney_id = ${claim.attorneyId}::uuid and lease_id = ${claim.leaseId}::uuid
       returning consecutive_failures`);
    const failures = Number((bumped.rows[0] as { consecutive_failures: number } | undefined)?.consecutive_failures ?? 1);
    const retryAt = new Date(now.getTime() + backoffMs(err.kind, failures, err.retryAfter));
    if (bumped.rows.length)
      await tx.execute(sql`
        update sync_cursors set lease_id = null, lease_until = null, next_due_at = ${iso(retryAt)}::timestamptz
         where attorney_id = ${claim.attorneyId}::uuid and lease_id = ${claim.leaseId}::uuid`);
    await tx
      .update(schema.syncRuns)
      .set({ status: "erro", finishedAt: now, httpStatus: err.httpStatus ?? null, errorKind: err.kind, errorMessage: message })
      .where(and(eq(schema.syncRuns.id, claim.runId), eq(schema.syncRuns.status, "executando")));
    return { retryAt, failures };
  });
}

// ── Orquestração ──────────────────────────────────────────────────────────────

export interface CollectorOptions {
  db: Db;
  /** Troque nos testes; o padrão é o adaptador real. */
  collect?: typeof collectDay;
  now?: () => Date;
  leaseMs?: number;
  /** Escritórios elegíveis à coleta. Padrão: todos. É aqui que o gate de assinatura (Fase 3) vai entrar. */
  organizationIds?: () => Promise<string[]>;
  log?: (message: string) => void;
}

export function createCollector(options: CollectorOptions) {
  const { db } = options;
  const collect = options.collect ?? collectDay;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.error(`[coletor] ${m}`));
  let lastOrg: string | undefined;

  async function listOrganizations(): Promise<string[]> {
    if (options.organizationIds) return options.organizationIds();
    return (await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.id))).map((o) => o.id);
  }

  /** Rodízio entre escritórios: recomeça logo depois do último atendido, para um escritório grande não monopolizar a fila. */
  function rotate(orgs: string[]): string[] {
    if (!lastOrg) return orgs;
    const i = orgs.findIndex((o) => o > lastOrg!);
    return i <= 0 ? orgs : [...orgs.slice(i), ...orgs.slice(0, i)];
  }

  async function execute(claim: Claim): Promise<Outcome> {
    let result: DayResult;
    try {
      result = await collect({ oab_number: claim.oabNumber, uf: claim.uf }, claim.day);
    } catch (e) {
      const known = e instanceof SourceError;
      const kind = known ? e.kind : "INTERNAL";
      const message = known ? e.message : "Erro inesperado na coleta.";
      if (!known) log(`erro inesperado na coleta (${claim.attorneyId} ${claim.day}): ${(e as Error)?.message}`);
      const { retryAt } = await failWindow(db, claim, { kind, message, httpStatus: known ? e.status : undefined, retryAfter: known ? e.retryAfter : undefined }, now());
      return { status: "failed", claim, kind, message, retryAt };
    }
    try {
      const done = await commitWindow(db, claim, result, now());
      return { status: "success", claim, found: done.found, inserted: done.inserted, pages: result.pages };
    } catch (e) {
      if (e instanceof StaleLeaseError) return { status: "stale", claim };
      log(`erro ao gravar a janela (${claim.attorneyId} ${claim.day}): ${(e as Error)?.message}`);
      const message = "Falha ao gravar a janela; ela será repetida.";
      const { retryAt } = await failWindow(db, claim, { kind: "INTERNAL", message }, now()).catch(() => ({ retryAt: now() }));
      return { status: "failed", claim, kind: "INTERNAL", message, retryAt };
    }
  }

  return {
    /** Coleta no máximo UMA janela (a mais antiga vencida do próximo escritório com trabalho). */
    async collectNext(): Promise<Outcome> {
      const orgs = rotate(await listOrganizations());
      for (const org of orgs) {
        const claim = await claimWindow(db, org, now(), options.leaseMs);
        if (claim) {
          lastOrg = org;
          return execute(claim);
        }
      }
      return { status: "idle" };
    },
  };
}
