import { Router, type Request, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertUuid,
  normalizeName,
  normalizeOabNumber,
  normalizeUf,
  ValidationError,
} from "../domain/oab.ts";
import { permissionsOf } from "../permissions.ts";
import { HttpError, getSession, requireContext, resolveMembership, type Deps } from "./context.ts";

/**
 * Contrato do painel: `POST /api/v1/<operacao>` (ver src/client/transport.ts e docs/MIGRACAO.md §3).
 * `organization_id` NUNCA é aceito do cliente: o escritório vem da sessão + associação revalidada.
 */

/** Operações do contrato que dependem de fases futuras (publicações e coleta DJEN). */
const NEXT_PHASE = new Set([
  "djen_list",
  "djen_mutate",
  "djen_archive_preview",
  "djen_sync_manual",
  "djen_diagnostics",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function errCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code ?? x?.cause?.code;
}

/** Encaminha uma chamada ao Better Auth pelo handler completo (mantém limite de taxa e checagem de origem). */
async function viaAuthHandler(deps: Deps, req: Request, path: string, body: unknown) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers))
    if (typeof v === "string" && !["content-length", "content-type", "transfer-encoding"].includes(k))
      headers.set(k, v);
  headers.set("content-type", "application/json");
  headers.set("x-forwarded-for", req.ip || "127.0.0.1"); // IP validado pelo Express, não o do cliente
  return deps.auth.handler(
    new Request(deps.env.appUrl + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) }),
  );
}

function forwardCookies(from: globalThis.Response, res: Response) {
  for (const c of from.headers.getSetCookie()) res.append("Set-Cookie", c);
}

type Op = (deps: Deps, req: Request, res: Response, body: Record<string, unknown>) => Promise<unknown>;

const ops: Record<string, Op> = {
  // ── Sessão (contrato existente) ─────────────────────────────────────────────
  async session(deps, req) {
    const s = await getSession(deps, req);
    if (!s) return { usuario: null, escritorio: null, escritorios: [], permissoes: [] };
    const memberships = await deps.db
      .select({
        id: schema.organization.id,
        nome: schema.organization.name,
        papel: schema.member.role,
      })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .where(eq(schema.member.userId, s.user.id));
    const m = await resolveMembership(deps, s.user.id, s.session.id, s.session.activeOrganizationId);
    return {
      usuario: { id: s.user.id, nome: s.user.name, email: s.user.email },
      escritorio: m ? { id: m.organizationId, nome: m.organizationName, papel: m.role } : null,
      escritorios: memberships,
      permissoes: m ? permissionsOf(m.role) : [],
    };
  },

  async "sign-in"(deps, req, res, body) {
    const { email, password } = body;
    if (typeof email !== "string" || typeof password !== "string" || !email || !password || email.length > 254 || password.length > 128)
      throw new HttpError(400, "Informe e-mail e senha.");
    const r = await viaAuthHandler(deps, req, "/api/auth/sign-in/email", { email, password });
    if (r.status === 429) throw new HttpError(429, "Muitas tentativas. Aguarde um minuto e tente de novo.");
    if (!r.ok) throw new HttpError(401, "E-mail ou senha incorretos."); // mesma resposta p/ conta inexistente
    forwardCookies(r, res);
    return { ok: true };
  },

  async "sign-out"(deps, req, res) {
    const r = await viaAuthHandler(deps, req, "/api/auth/sign-out", {});
    forwardCookies(r, res);
    return { ok: true };
  },

  // ── OABs do escritório ──────────────────────────────────────────────────────
  async oab_list(deps, req) {
    const c = await requireContext(deps, req, ["attorney", "read"]);
    const rows = await withTenant(deps.db, c.organizationId, (tx) =>
      tx.select().from(schema.attorneys).orderBy(schema.attorneys.name),
    );
    return { oabs: rows.map(present) };
  },

  async oab_create(deps, req, _res, body) {
    const c = await requireContext(deps, req, ["attorney", "create"]);
    const name = normalizeName(body.name);
    const oabNumber = normalizeOabNumber(body.oab_number);
    const uf = normalizeUf(body.uf);
    try {
      const [row] = await withTenant(deps.db, c.organizationId, async (tx) => {
        const created = await tx
          .insert(schema.attorneys)
          .values({ organizationId: c.organizationId, name, oabNumber, uf, createdBy: c.userId })
          .returning();
        await tx.insert(schema.auditLog).values({
          organizationId: c.organizationId,
          actorUserId: c.userId,
          action: "oab.created",
          entityType: "attorney",
          entityId: created[0].id,
          details: { uf, oab_number: oabNumber },
        });
        return created;
      });
      return { oab: present(row) };
    } catch (e) {
      if (errCode(e) === "23505") throw new HttpError(409, "Esta OAB já está cadastrada no escritório.");
      throw e;
    }
  },

  async oab_update(deps, req, _res, body) {
    const c = await requireContext(deps, req, ["attorney", "update"]);
    const id = assertUuid(body.id);
    const patch: { name?: string; active?: boolean } = {};
    if (body.name !== undefined) patch.name = normalizeName(body.name);
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") throw new ValidationError("Valor de 'active' inválido.");
      patch.active = body.active;
    }
    if (Object.keys(patch).length === 0) throw new ValidationError("Nada para atualizar.");
    const [row] = await withTenant(deps.db, c.organizationId, async (tx) => {
      const updated = await tx
        .update(schema.attorneys)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.attorneys.id, id))
        .returning();
      if (updated[0])
        await tx.insert(schema.auditLog).values({
          organizationId: c.organizationId,
          actorUserId: c.userId,
          action:
            patch.active === undefined
              ? "oab.updated"
              : patch.active
                ? "oab.activated"
                : "oab.deactivated",
          entityType: "attorney",
          entityId: id,
          details: patch,
        });
      return updated;
    });
    // Outro escritório (ou id inexistente) é indistinguível: sempre 404.
    if (!row) throw new HttpError(404, "OAB não encontrada.");
    return { oab: present(row) };
  },

  // ── Auditoria ───────────────────────────────────────────────────────────────
  async audit_list(deps, req) {
    const c = await requireContext(deps, req, ["audit", "read"]);
    const rows = await withTenant(deps.db, c.organizationId, (tx) =>
      tx.select().from(schema.auditLog).orderBy(desc(schema.auditLog.createdAt)).limit(100),
    );
    return {
      eventos: rows.map((r) => ({
        id: r.id,
        acao: r.action,
        autor_id: r.actorUserId,
        entidade: r.entityType,
        entidade_id: r.entityId,
        detalhes: r.details,
        em: r.createdAt,
      })),
    };
  },
};

function present(r: typeof schema.attorneys.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    oab_number: r.oabNumber,
    uf: r.uf,
    active: r.active,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export function createV1Router(deps: Deps) {
  const router = Router();
  router.post("/:op", async (req, res, next) => {
    try {
      const body = isObj(req.body) ? req.body : {};
      const name = req.params.op;
      const op = Object.hasOwn(ops, name) ? ops[name] : undefined;
      if (op) return void res.json(await op(deps, req, res, body));
      if (NEXT_PHASE.has(name)) {
        // Autentica antes de responder: nem o estado "não implementado" é exposto a anônimos.
        await requireContext(deps, req);
        throw new HttpError(501, "Disponível na próxima fase (publicações e coletor DJEN).");
      }
      throw new HttpError(404, "Operação desconhecida.");
    } catch (e) {
      next(e);
    }
  });
  router.all("*", (_req, res) => res.status(405).set("Allow", "POST").json({ erro: "Método não permitido." }));
  return router;
}
