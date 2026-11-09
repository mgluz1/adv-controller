import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { Auth } from "../auth.ts";
import * as schema from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { can, type Action, type Resource } from "../permissions.ts";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Deps {
  auth: Auth;
  db: Db;
  env: import("../env.ts").Env;
}

export interface Context {
  userId: string;
  userName: string;
  userEmail: string;
  /** Escritório ativo, SEMPRE derivado de uma associação revalidada no banco nesta requisição. */
  organizationId: string;
  organizationName: string;
  role: string;
}

export async function getSession({ auth }: Deps, req: Request) {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

/**
 * Resolve a associação do usuário ao escritório ativo. O `activeOrganizationId` guardado na sessão é
 * apenas uma preferência: confere-se no banco, a cada requisição, que o usuário ainda é membro. Se não
 * for (removido, id forjado ou nulo), cai para o escritório mais antigo do qual ele é membro e, se não
 * houver nenhum, devolve null. Dados de um escritório só são alcançados por uma associação verificada.
 */
export async function resolveMembership(
  { db }: Deps,
  userId: string,
  sessionId: string,
  activeOrganizationId: string | null | undefined,
) {
  const cols = {
    role: schema.member.role,
    organizationId: schema.member.organizationId,
    organizationName: schema.organization.name,
  };
  if (activeOrganizationId) {
    const [m] = await db
      .select(cols)
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .where(
        and(
          eq(schema.member.userId, userId),
          eq(schema.member.organizationId, activeOrganizationId),
        ),
      )
      .limit(1);
    if (m) return m;
  }
  const [first] = await db
    .select(cols)
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt))
    .limit(1);
  if (first && first.organizationId !== activeOrganizationId)
    await db
      .update(schema.session)
      .set({ activeOrganizationId: first.organizationId })
      .where(eq(schema.session.id, sessionId));
  return first ?? null;
}

/** 401 sem sessão · 403 sem escritório/permissão. Devolve o contexto confiável da requisição. */
export async function requireContext<R extends Resource>(
  deps: Deps,
  req: Request,
  needs?: [R, Action<R>],
): Promise<Context> {
  const s = await getSession(deps, req);
  if (!s) throw new HttpError(401, "Faça login para continuar.");
  const m = await resolveMembership(deps, s.user.id, s.session.id, s.session.activeOrganizationId);
  if (!m) throw new HttpError(403, "Você não pertence a nenhum escritório.");
  if (needs && !can(m.role, needs[0], needs[1]))
    throw new HttpError(403, "Seu papel no escritório não permite esta ação.");
  return {
    userId: s.user.id,
    userName: s.user.name,
    userEmail: s.user.email,
    organizationId: m.organizationId,
    organizationName: m.organizationName,
    role: m.role,
  };
}
