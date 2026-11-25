import type { Request, Response } from "express";
import { asc, eq } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { withTenant } from "../db/tenant.ts";
import { normalizeTerm, termPattern } from "../domain/interest.ts";
import { assertUuid, ValidationError } from "../domain/oab.ts";
import { HttpError, requireContext, type Deps } from "./context.ts";
import type { Tx } from "../db/types.ts";

/**
 * Termos de interesse do escritório (REGRAS §6). Quem gerencia: owner/admin; todos os papéis leem.
 * Nunca se exclui um termo: ele é desativado (a aba e os contadores deixam de considerá-lo na hora).
 * O padrão de casamento é calculado no servidor (domain/interest.ts): o cliente nunca envia expressão regular.
 */
type Op = (deps: Deps, req: Request, res: Response, body: Record<string, unknown>) => Promise<unknown>;

const T = schema.interestTerms;

function errCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code ?? x?.cause?.code;
}

function present(r: typeof T.$inferSelect) {
  return {
    id: r.id,
    term: r.term,
    kind: termPattern(r.term).kind,
    active: r.active,
    attorney_id: r.attorneyId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** A OAB precisa ser do escritório (o RLS já esconde as dos outros: id alheio é indistinguível de inexistente). */
async function assertAttorney(tx: Tx, id: string) {
  const [a] = await tx.select({ id: schema.attorneys.id }).from(schema.attorneys).where(eq(schema.attorneys.id, id));
  if (!a) throw new HttpError(404, "OAB não encontrada.");
}

const optionalAttorneyId = (v: unknown): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : assertUuid(v, "advogado");

async function interest_list(deps: Deps, req: Request) {
  const c = await requireContext(deps, req, ["interest", "read"]);
  const rows = await withTenant(deps.db, c.organizationId, (tx) => tx.select().from(T).orderBy(asc(T.term), asc(T.id)));
  return { terms: rows.map(present) };
}

async function interest_create(deps: Deps, req: Request, _res: Response, body: Record<string, unknown>) {
  const c = await requireContext(deps, req, ["interest", "create"]);
  const term = normalizeTerm(body.term);
  const { pattern } = termPattern(term);
  const attorneyId = optionalAttorneyId(body.attorney_id) ?? null;
  try {
    const row = await withTenant(deps.db, c.organizationId, async (tx) => {
      if (attorneyId) await assertAttorney(tx, attorneyId);
      const [created] = await tx
        .insert(T)
        .values({ organizationId: c.organizationId, term, pattern, attorneyId, createdBy: c.userId })
        .returning();
      await tx.insert(schema.auditLog).values({
        organizationId: c.organizationId,
        actorUserId: c.userId,
        action: "interest.created",
        entityType: "interest_term",
        entityId: created.id,
        details: { term, attorney_id: attorneyId },
      });
      return created;
    });
    return { term: present(row) };
  } catch (e) {
    if (errCode(e) === "23505") throw new HttpError(409, "Este termo já está cadastrado no escritório.");
    throw e;
  }
}

async function interest_update(deps: Deps, req: Request, _res: Response, body: Record<string, unknown>) {
  const c = await requireContext(deps, req, ["interest", "update"]);
  const id = assertUuid(body.id);
  const patch: Partial<typeof T.$inferInsert> = {};
  if (body.term !== undefined) {
    const term = normalizeTerm(body.term);
    patch.term = term;
    patch.pattern = termPattern(term).pattern;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new ValidationError("Valor de 'active' inválido.");
    patch.active = body.active;
  }
  const attorneyId = optionalAttorneyId(body.attorney_id);
  if (attorneyId !== undefined) patch.attorneyId = attorneyId;
  if (Object.keys(patch).length === 0) throw new ValidationError("Nada para atualizar.");
  try {
    const row = await withTenant(deps.db, c.organizationId, async (tx) => {
      if (attorneyId) await assertAttorney(tx, attorneyId);
      const [updated] = await tx.update(T).set({ ...patch, updatedAt: new Date() }).where(eq(T.id, id)).returning();
      if (updated)
        await tx.insert(schema.auditLog).values({
          organizationId: c.organizationId,
          actorUserId: c.userId,
          action: patch.active === undefined ? "interest.updated" : patch.active ? "interest.activated" : "interest.deactivated",
          entityType: "interest_term",
          entityId: id,
          details: { ...(patch.term !== undefined ? { term: patch.term } : {}), ...(attorneyId !== undefined ? { attorney_id: attorneyId } : {}), ...(patch.active !== undefined ? { active: patch.active } : {}) },
        });
      return updated;
    });
    if (!row) throw new HttpError(404, "Termo não encontrado."); // de outro escritório = inexistente
    return { term: present(row) };
  } catch (e) {
    if (errCode(e) === "23505") throw new HttpError(409, "Este termo já está cadastrado no escritório.");
    throw e;
  }
}

export const interestOps: Record<string, Op> = { interest_list, interest_create, interest_update };
