import type { Request, Response } from "express";
import { and, asc, desc, eq, exists, ilike, inArray, isNotNull, isNull, gte, lte, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { withTenant } from "../db/tenant.ts";
import {
  escapeLike,
  MAX_BATCH,
  parseListFilter,
  parseMutate,
  parsePreviewDate,
  type ListFilter,
} from "../domain/publications.ts";
import { can, type Action } from "../permissions.ts";
import { HttpError, requireContext, type Deps } from "./context.ts";

type PublicationAction = Action<"publication">;

/**
 * Operações de publicações do painel (contrato: docs/MIGRACAO.md §3). TODAS passam por `withTenant`:
 * o escritório vem da associação revalidada na sessão, nunca do corpo; o RLS é a segunda barreira.
 *
 * Decisões de contagem (documentadas porque a interface depende delas):
 *  - `rows`/`total`: todos os filtros (aba, status, tribunal, período, busca, arquivadas).
 *  - `tab_stats` (contadores das abas): mesmos filtros, EXCETO aba e status, para não dependerem da aba
 *    ativa, da página nem do filtro de status ("N para atuar (M total)" = a revisar / todos os status).
 *  - `stats` (cabeçalho "a revisar • em análise • concluídas"): todos os filtros, inclusive a aba ativa,
 *    exceto o de status (para mostrar a distribuição).
 *  - Descartadas (tombstone) não aparecem em lista, contador nem aba.
 */
type Op = (deps: Deps, req: Request, res: Response, body: Record<string, unknown>) => Promise<unknown>;

const P = schema.publications;
const PA = schema.publicationAttorneys;

function conditions(f: ListFilter, opts: { status: boolean; attorney: boolean }): SQL[] {
  const c: SQL[] = [isNull(P.removedAt), f.archived ? isNotNull(P.archivedAt) : isNull(P.archivedAt)];
  if (f.tribunal) c.push(eq(P.tribunal, f.tribunal));
  if (f.start) c.push(gte(P.availableOn, f.start));
  if (f.end) c.push(lte(P.availableOn, f.end));
  if (f.search) {
    const like = `%${escapeLike(f.search)}%`;
    c.push(or(ilike(P.processNumber, like), ilike(P.processMask, like), ilike(P.tribunal, like), ilike(P.originalText, like))!);
  }
  if (opts.status && f.status !== "todos") c.push(eq(P.status, f.status));
  if (opts.attorney && f.attorney !== "todos")
    c.push(
      exists(
        sql`(select 1 from ${PA} where ${PA.publicationId} = ${P.id} and ${PA.attorneyId} = ${f.attorney})`,
      ),
    );
  return c;
}

const counts = () => ({
  total: sql<number>`count(*)::int`,
  revisar: sql<number>`(count(*) filter (where ${P.status} = 'a_revisar'))::int`,
  analise: sql<number>`(count(*) filter (where ${P.status} = 'em_analise'))::int`,
  concluida: sql<number>`(count(*) filter (where ${P.status} = 'concluida'))::int`,
});

async function djen_list(deps: Deps, req: Request, _res: Response, body: Record<string, unknown>) {
  const c = await requireContext(deps, req, ["publication", "read"]);
  const f = parseListFilter(body.p_filter);

  return withTenant(deps.db, c.organizationId, async (tx) => {
    const where = and(...conditions(f, { status: true, attorney: true }));

    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(P).where(where);

    const rows = await tx
      .select({
        id: P.id,
        source_id: P.sourceId,
        source_hash: P.sourceHash,
        tribunal: P.tribunal,
        judging_body: P.judgingBody,
        process_number: P.processNumber,
        process_mask: P.processMask,
        class_name: P.className,
        communication_type: P.communicationType,
        original_text: P.originalText,
        medium: P.medium,
        source_url: P.sourceUrl,
        available_on: P.availableOn,
        published_on: P.publishedOn,
        status: P.status,
        notes: P.notes,
        action_note: P.actionNote,
        first_seen_at: P.firstSeenAt,
        last_seen_at: P.lastSeenAt,
        archived_at: P.archivedAt,
      })
      .from(P)
      .where(where)
      .orderBy(f.order === "asc" ? asc(P.availableOn) : desc(P.availableOn), f.order === "asc" ? asc(P.id) : desc(P.id))
      .limit(f.limit)
      .offset(f.offset);

    const links = rows.length
      ? await tx
          .select({
            publicationId: PA.publicationId,
            id: schema.attorneys.id,
            name: schema.attorneys.name,
            oab_number: schema.attorneys.oabNumber,
            uf: schema.attorneys.uf,
          })
          .from(PA)
          .innerJoin(schema.attorneys, eq(schema.attorneys.id, PA.attorneyId))
          .where(inArray(PA.publicationId, rows.map((r) => r.id)))
          .orderBy(asc(schema.attorneys.name), asc(schema.attorneys.id))
      : [];
    const byPub = new Map<string, { id: string; name: string; oab_number: string; uf: string }[]>();
    for (const l of links) {
      const { publicationId, ...a } = l;
      (byPub.get(publicationId) ?? byPub.set(publicationId, []).get(publicationId)!).push(a);
    }

    // Cabeçalho: distribuição por status na aba ativa, ignorando o filtro de status.
    const [stats] = await tx
      .select(counts())
      .from(P)
      .where(and(...conditions(f, { status: false, attorney: true })));

    // Contadores das abas: independem da aba ativa, da página e do filtro de status.
    const tabWhere = and(...conditions(f, { status: false, attorney: false }));
    const [todos] = await tx.select({ total: counts().total, revisar: counts().revisar }).from(P).where(tabWhere);
    const perAttorney = await tx
      .select({ id: PA.attorneyId, total: counts().total, revisar: counts().revisar })
      .from(PA)
      .innerJoin(P, eq(P.id, PA.publicationId))
      .where(tabWhere)
      .groupBy(PA.attorneyId);

    // Abas: OABs ativas + inativas que ainda têm publicações vivas (o histórico continua acessível).
    const attorneys = await tx
      .select({
        id: schema.attorneys.id,
        name: schema.attorneys.name,
        oab_number: schema.attorneys.oabNumber,
        uf: schema.attorneys.uf,
      })
      .from(schema.attorneys)
      .where(
        or(
          eq(schema.attorneys.active, true),
          exists(
            sql`(select 1 from ${PA} join ${P} on ${P.id} = ${PA.publicationId}
                  where ${PA.attorneyId} = ${schema.attorneys.id} and ${P.removedAt} is null)`,
          ),
        ),
      )
      .orderBy(asc(schema.attorneys.name), asc(schema.attorneys.id));
    const stat = new Map(perAttorney.map((r) => [r.id, r]));

    const tribunals = await tx
      .selectDistinct({ tribunal: P.tribunal })
      .from(P)
      .where(and(isNull(P.removedAt), f.archived ? isNotNull(P.archivedAt) : isNull(P.archivedAt), isNotNull(P.tribunal)))
      .orderBy(asc(P.tribunal));

    // Coleta (diagnóstico resumido). Sem coletor ainda: tudo nulo/zero, sem inventar dados.
    const [latest] = await tx.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
    const [ok] = await tx
      .select({ at: sql<Date | null>`max(${schema.syncRuns.finishedAt})` })
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.status, "sucesso"));
    const [cur] = await tx
      .select({
        due: sql<Date | null>`min(${schema.syncCursors.nextDueAt})`,
        pending: sql<number>`coalesce(sum(greatest(0, (${schema.syncCursors.targetDay} - ${schema.syncCursors.scanDay}) + 1)), 0)::int`,
      })
      .from(schema.syncCursors)
      .innerJoin(schema.attorneys, eq(schema.attorneys.id, schema.syncCursors.attorneyId))
      .where(
        and(
          eq(schema.attorneys.active, true),
          isNotNull(schema.syncCursors.scanDay),
          isNotNull(schema.syncCursors.targetDay),
        ),
      );
    // `due` considera só OABs ativas; separado porque pending exige as duas datas.
    const [nextDue] = await tx
      .select({ due: sql<Date | null>`min(${schema.syncCursors.nextDueAt})` })
      .from(schema.syncCursors)
      .innerJoin(schema.attorneys, eq(schema.attorneys.id, schema.syncCursors.attorneyId))
      .where(eq(schema.attorneys.active, true));

    const tab_stats: Record<string, { total: number; revisar: number }> = {
      todos: { total: todos.total, revisar: todos.revisar },
    };
    for (const a of attorneys) tab_stats[a.id] = { total: stat.get(a.id)?.total ?? 0, revisar: stat.get(a.id)?.revisar ?? 0 };

    return {
      total,
      rows: rows.map((r) => ({ ...r, attorneys: byPub.get(r.id) ?? [] })),
      stats,
      attorney_stats: attorneys.map((a) => ({ ...a, total: tab_stats[a.id].total, revisar: tab_stats[a.id].revisar })),
      tab_stats,
      tribunals,
      pending_windows: cur?.pending ?? 0,
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
      next_due: nextDue?.due ?? null,
    };
  });
}

const NEEDS: Record<"status" | "archive" | "restore" | "remove", ["publication", PublicationAction]> = {
  status: ["publication", "review"],
  archive: ["publication", "archive"],
  restore: ["publication", "restore"],
  remove: ["publication", "discard"],
};

const AUDIT = {
  status: "publication.reviewed",
  archive: "publication.archived",
  restore: "publication.restored",
  remove: "publication.discarded",
} as const;

async function djen_mutate(deps: Deps, req: Request, _res: Response, body: Record<string, unknown>) {
  // Ordem importa: autenticar ANTES de validar (anônimo recebe 401, nunca 400), e só então checar o papel,
  // que depende da ação pedida.
  const c = await requireContext(deps, req);
  const m = parseMutate(body);
  if (!can(c.role, ...NEEDS[m.action])) throw new HttpError(403, "Seu papel no escritório não permite esta ação.");
  if (m.ids.length === 0) return 0;
  const now = new Date();
  const stamp = { updatedAt: now, updatedBy: c.userId };

  return withTenant(deps.db, c.organizationId, async (tx) => {
    const target = inArray(P.sourceId, m.ids);
    let affected: { sourceId: string }[];

    if (m.action === "status") {
      const set: Partial<typeof P.$inferInsert> = { ...stamp };
      if (m.status !== undefined) set.status = m.status;
      if (m.notes !== undefined) set.notes = m.notes;
      if (m.providence !== undefined) set.actionNote = m.providence;
      // Anotar/revisar vale para ativas e arquivadas; o descarte (tombstone) é intocável.
      affected = await tx.update(P).set(set).where(and(target, isNull(P.removedAt))).returning({ sourceId: P.sourceId });
    } else if (m.action === "archive") {
      affected = await tx
        .update(P)
        .set({ archivedAt: now, ...stamp })
        .where(and(target, isNull(P.archivedAt), isNull(P.removedAt)))
        .returning({ sourceId: P.sourceId });
    } else if (m.action === "restore") {
      affected = await tx
        .update(P)
        .set({ archivedAt: null, ...stamp })
        .where(and(target, isNotNull(P.archivedAt), isNull(P.removedAt)))
        .returning({ sourceId: P.sourceId });
    } else {
      // Descarte definitivo: só de arquivadas. Apaga conteúdo e vínculos; sobra o identificador mínimo.
      const gone = await tx
        .update(P)
        .set({
          removedAt: now,
          originalText: null,
          rawPayload: null,
          recipients: null,
          processNumber: null,
          processMask: null,
          notes: null,
          actionNote: null,
          sourceUrl: null,
          ...stamp,
        })
        .where(and(target, isNotNull(P.archivedAt), isNull(P.removedAt)))
        .returning({ id: P.id, sourceId: P.sourceId });
      if (gone.length)
        await tx.delete(PA).where(inArray(PA.publicationId, gone.map((g) => g.id)));
      affected = gone;
    }

    if (affected.length)
      await tx.insert(schema.auditLog).values({
        organizationId: c.organizationId,
        actorUserId: c.userId,
        action: AUDIT[m.action],
        entityType: "publication",
        // Nunca grava teor nem anotações na auditoria: só o que mudou e quais comunicações.
        details:
          m.action === "status"
            ? {
                count: affected.length,
                source_ids: affected.map((a) => a.sourceId),
                fields: [m.status !== undefined && "status", m.notes !== undefined && "notes", m.providence !== undefined && "action_note"].filter(Boolean),
                ...(m.status !== undefined ? { status: m.status } : {}),
              }
            : { count: affected.length, source_ids: affected.map((a) => a.sourceId) },
      });
    return affected.length;
  });
}

async function djen_archive_preview(deps: Deps, req: Request, _res: Response, body: Record<string, unknown>) {
  const c = await requireContext(deps, req, ["publication", "archive"]);
  const date = parsePreviewDate(body);
  return withTenant(deps.db, c.organizationId, async (tx) => {
    const where = and(isNull(P.removedAt), isNull(P.archivedAt), lte(P.availableOn, date));
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(P).where(where);
    // Ordem numérica do ID oficial (sem zeros à esquerda: comprimento, depois texto).
    const rows = await tx
      .select({ source_id: P.sourceId, process_number: P.processNumber, tribunal: P.tribunal })
      .from(P)
      .where(where)
      .orderBy(sql`length(${P.sourceId})`, asc(P.sourceId))
      .limit(MAX_BATCH);
    return { count, rows };
  });
}

export const publicationOps: Record<string, Op> = { djen_list, djen_mutate, djen_archive_preview };
