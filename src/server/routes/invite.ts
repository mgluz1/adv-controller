import type { Request, Response } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { createVerifiedUser, validatePerson } from "../admin/bootstrap.ts";
import * as schema from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { HttpError, type Deps } from "./context.ts";
import { forwardCookies, viaAuthHandler } from "./authBridge.ts";

type Op = (deps: Deps, req: Request, res: Response, body: Record<string, unknown>) => Promise<unknown>;

/** O id do convite é o segredo (chega só por e-mail ou pelo link que o dono compartilha). Ids do Better Auth: alfanuméricos. */
const INVITATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Limite simples por chave (memória do processo): as rotas são públicas e o id é o único segredo. */
const hits = new Map<string, { n: number; reset: number }>();
export function allowInviteLookup(key: string, now = Date.now(), max = 30): boolean {
  const h = hits.get(key);
  if (!h || h.reset <= now) {
    hits.set(key, { n: 1, reset: now + 60_000 });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return true;
  }
  return ++h.n <= max;
}

/** Só para testes: zera os contadores (todos os testes de um arquivo saem do mesmo IP). */
export const resetInviteLimiter = () => hits.clear();

async function pendingInvitation(db: Db, id: unknown) {
  if (typeof id !== "string" || !INVITATION_ID.test(id)) return null;
  const [inv] = await db
    .select({
      id: schema.invitation.id,
      email: schema.invitation.email,
      role: schema.invitation.role,
      expiresAt: schema.invitation.expiresAt,
      organization: schema.organization.name,
      inviter: schema.user.name,
    })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
    .innerJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
    .where(and(eq(schema.invitation.id, id), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())))
    .limit(1);
  return inv ?? null;
}

const accountExists = async (db: Db, email: string) =>
  ((await db.select({ n: sql<number>`count(*)::int` }).from(schema.user).where(sql`lower(${schema.user.email}) = ${email.toLowerCase()}`))[0]?.n ?? 0) > 0;

const NOT_FOUND = "Convite inválido ou expirado.";

/**
 * `invite_info {id}` (PÚBLICA): o que a tela do convite precisa antes de o convidado ter sessão. Quem tem o id já tem o convite;
 * inexistente, usado, cancelado e expirado respondem IGUAL (404).
 */
async function invite_info(deps: Deps, req: Request, _res: Response, body: Record<string, unknown>) {
  if (!allowInviteLookup(`info:${req.ip || "?"}`)) throw new HttpError(429, "Muitas consultas. Aguarde um minuto.");
  const inv = await pendingInvitation(deps.db, body.id);
  if (!inv) throw new HttpError(404, NOT_FOUND);
  return {
    organization: inv.organization,
    inviter: inv.inviter,
    role: inv.role,
    email: inv.email,
    expires_at: inv.expiresAt,
    account_exists: await accountExists(deps.db, inv.email),
  };
}

/**
 * `invite_sign_up {id, name, password}` (PÚBLICA): cria a conta do convidado. A PROVA DE POSSE do e-mail é o próprio link do
 * convite (o id só existe no e-mail dele / no link que o dono compartilhou), por isso a conta nasce verificada e o e-mail vem do
 * convite, NUNCA do corpo. É por aqui, e não pelo cadastro público, que se entra com o cadastro fechado: o cadastro público com
 * "exceção para convite" permitiria registrar o e-mail alheio antes do dono e sequestrar a conta. Entra logado (cookie); o aceite do
 * convite é um passo seguinte (`/api/auth/organization/accept-invitation`), refeito pela tela se falhar.
 */
async function invite_sign_up(deps: Deps, req: Request, res: Response, body: Record<string, unknown>) {
  if (!allowInviteLookup(`signup:${req.ip || "?"}`, Date.now(), 10)) throw new HttpError(429, "Muitas tentativas. Aguarde um minuto.");
  const inv = await pendingInvitation(deps.db, body.id);
  if (!inv) throw new HttpError(404, NOT_FOUND);
  const { name, password } = validatePerson({ name: body.name, password: body.password }); // 400 antes de qualquer gravação
  const email = inv.email.toLowerCase();
  if (await accountExists(deps.db, email)) throw new HttpError(409, "Já existe uma conta com o e-mail deste convite. Entre para aceitar.");
  try {
    await createVerifiedUser(deps.auth, { email, name, password });
  } catch (e) {
    const x = e as { code?: string; cause?: { code?: string } };
    if ((x.code ?? x.cause?.code) === "23505") throw new HttpError(409, "Já existe uma conta com o e-mail deste convite. Entre para aceitar.");
    throw e;
  }
  const r = await viaAuthHandler(deps, req, "/api/auth/sign-in/email", { email, password });
  if (!r.ok) throw new HttpError(500, "Conta criada, mas não foi possível entrar. Entre com o e-mail e a senha cadastrados.");
  forwardCookies(r, res);
  return { ok: true, email };
}

export const inviteOps: Record<string, Op> = { invite_info, invite_sign_up };
