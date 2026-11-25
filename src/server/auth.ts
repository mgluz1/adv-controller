import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { organization as organizationPlugin } from "better-auth/plugins";
import { and, asc, eq } from "drizzle-orm";
import type { Env } from "./env.ts";
import { allowedOrigins, emailIsTrusted, validateAuthSecret } from "./env.ts";
import type { Mailer } from "./email/mailer.ts";
import * as schema from "./db/schema.ts";
import { withTenant } from "./db/tenant.ts";
import type { Db } from "./db/types.ts";
import { ac, roles } from "./permissions.ts";

export interface AuthDeps {
  db: Db;
  env: Env;
  /** E-mail transacional (verificação, recuperação de senha, convite). Sem ele nada é enviado. */
  mailer?: Mailer;
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

export function createAuth({ db, env, mailer }: AuthDeps) {
  if (!env.authSecret) throw new Error("BETTER_AUTH_SECRET ausente.");
  validateAuthSecret(env.authSecret, env.nodeEnv);
  const production = env.nodeEnv === "production";
  // E-mail só é PROVA DE POSSE com provedor real. Só então a verificação é obrigatória (login e aceite de convite).
  const trusted = emailIsTrusted(env);

  return betterAuth({
    appName: "Adv Controller",
    baseURL: env.appUrl,
    secret: env.authSecret,
    trustedOrigins: allowedOrigins(env),
    database: drizzleAdapter(db, { provider: "pg", schema }),

    emailAndPassword: {
      enabled: true,
      // Cadastro fechado (padrão em produção) é TOTAL: nem e-mail com convite pendente passa por aqui. O convidado cria a
      // conta por `invite_sign_up`, onde a prova de posse do e-mail é o link do convite (evita o sequestro prévio de conta).
      disableSignUp: !env.signupEnabled,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: trusted,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true, // trocar a senha encerra as sessões abertas (inclusive a de quem a roubou)
      sendResetPassword: mailer?.enabled
        ? async ({ user, url }) => void (await mailer.sendPasswordReset({ to: user.email, name: user.name, url }))
        : undefined,
    },

    emailVerification: mailer?.enabled
      ? {
          sendOnSignUp: true,
          sendOnSignIn: true, // quem tenta entrar sem verificar recebe um novo link
          autoSignInAfterVerification: true,
          expiresIn: 60 * 60,
          sendVerificationEmail: async ({ user, url }) => void (await mailer.sendVerification({ to: user.email, name: user.name, url })),
        }
      : undefined,

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
        "/request-password-reset": { window: 300, max: 5 },
        "/forget-password": { window: 300, max: 5 },
        "/reset-password": { window: 300, max: 10 },
        "/send-verification-email": { window: 300, max: 5 },
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
        requireEmailVerificationOnInvitation: trusted,
        sendInvitationEmail: mailer?.enabled
          ? async (d) =>
              void (await mailer.sendInvitation({
                to: d.email,
                invitationId: d.id,
                role: d.role,
                organizationName: d.organization.name,
                inviterName: d.inviter.user.name,
              }))
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
