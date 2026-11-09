import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { organization as organizationPlugin } from "better-auth/plugins";
import { and, asc, eq } from "drizzle-orm";
import type { Env } from "./env.ts";
import { allowedOrigins, validateAuthSecret } from "./env.ts";
import * as schema from "./db/schema.ts";
import { withTenant } from "./db/tenant.ts";
import type { Db } from "./db/types.ts";
import { ac, roles } from "./permissions.ts";

export interface AuthDeps {
  db: Db;
  env: Env;
  /** Entrega do convite (e-mail). Sem provedor de e-mail ainda: o convite é compartilhado por link/ID. */
  sendInvitation?: (data: {
    invitationId: string;
    email: string;
    role: string;
    organizationName: string;
    inviterName: string;
  }) => Promise<void>;
}

/** Ações de organização do Better Auth que entram na trilha de auditoria do escritório. */
const AUDITED: Record<string, string> = {
  "/organization/invite-member": "member.invited",
  "/organization/cancel-invitation": "invitation.canceled",
  "/organization/accept-invitation": "member.joined",
  "/organization/remove-member": "member.removed",
  "/organization/leave": "member.left",
  "/organization/update-member-role": "member.role_changed",
  "/organization/update": "office.updated",
};

export function createAuth({ db, env, sendInvitation }: AuthDeps) {
  if (!env.authSecret) throw new Error("BETTER_AUTH_SECRET ausente.");
  validateAuthSecret(env.authSecret, env.nodeEnv);
  const production = env.nodeEnv === "production";

  return betterAuth({
    appName: "Adv Controller",
    baseURL: env.appUrl,
    secret: env.authSecret,
    trustedOrigins: allowedOrigins(env),
    database: drizzleAdapter(db, { provider: "pg", schema }),

    emailAndPassword: {
      enabled: true,
      disableSignUp: !env.signupEnabled,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      // Verificação de e-mail e recuperação de senha dependem de um provedor de e-mail (pendente).
      requireEmailVerification: false,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 dias
      updateAge: 60 * 60 * 24, // renova a cada 1 dia de uso
      // Sem cookieCache: toda requisição consulta a sessão no banco (revogação imediata).
    },

    advanced: {
      useSecureCookies: production,
      cookiePrefix: "adv",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },

    rateLimit: {
      enabled: production || undefined,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
      },
    },

    databaseHooks: {
      session: {
        create: {
          // Ao entrar, ativa o escritório mais antigo do usuário. É só conveniência: a associação é
          // revalidada em TODA requisição (routes/context.ts).
          before: async (s) => {
            const [first] = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, s.userId))
              .orderBy(asc(schema.member.createdAt))
              .limit(1);
            return { data: { ...s, activeOrganizationId: first?.organizationId ?? null } };
          },
        },
      },
    },

    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const action = AUDITED[ctx.path];
        if (!action) return;
        const returned: any = ctx.context.returned;
        if (!returned || returned instanceof Error || returned.status >= 400) return;
        const current = await getSessionFromCtx(ctx);
        const actor = current?.user;
        const body: any = ctx.body ?? {};
        const orgId: unknown =
          returned.organizationId ??
          returned.member?.organizationId ??
          body.organizationId ??
          current?.session.activeOrganizationId;
        if (typeof orgId !== "string" || !actor) return;
        try {
          await withTenant(db, orgId, (tx) =>
            tx.insert(schema.auditLog).values({
              organizationId: orgId,
              actorUserId: actor.id,
              action,
              entityType: "member",
              entityId: typeof body.memberId === "string" ? body.memberId : null,
              // Sem dados sensíveis: só o que identifica o alvo da ação.
              details: {
                ...(typeof body.email === "string" && { email: body.email }),
                ...(typeof body.role === "string" && { role: body.role }),
                ...(typeof body.memberIdOrEmail === "string" && { target: body.memberIdOrEmail }),
              },
            }),
          );
        } catch (e) {
          console.error("[audit] falha ao registrar", action, (e as Error).message);
        }
      }),
    },

    plugins: [
      organizationPlugin({
        ac,
        roles,
        creatorRole: "owner",
        allowUserToCreateOrganization: true,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: false,
        sendInvitationEmail: sendInvitation
          ? async (d) =>
              sendInvitation({
                invitationId: d.id,
                email: d.email,
                role: d.role,
                organizationName: d.organization.name,
                inviterName: d.inviter.user.name,
              })
          : undefined,
        organizationHooks: {
          // Higiene: quem sai do escritório não deve manter esse escritório como "ativo" em sessões.
          afterRemoveMember: async ({ member, organization }) => {
            await db
              .update(schema.session)
              .set({ activeOrganizationId: null })
              .where(
                and(
                  eq(schema.session.userId, member.userId),
                  eq(schema.session.activeOrganizationId, organization.id),
                ),
              );
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
