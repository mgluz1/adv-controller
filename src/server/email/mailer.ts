import type { Env } from "../env.ts";
import { invitationEmail, passwordResetEmail, verificationEmail } from "./templates.ts";
import { createLogTransport, createResendTransport, type EmailTransport } from "./transports.ts";

export const APP_NAME = "Adv Controller";

export interface Mailer {
  /** Com `false`, nenhum e-mail é enviado (recuperação de senha e cadastro por convite indisponíveis). */
  enabled: boolean;
  sendVerification(a: { to: string; name: string; url: string }): Promise<void>;
  sendPasswordReset(a: { to: string; name: string; url: string }): Promise<void>;
  sendInvitation(a: { to: string; inviterName: string; organizationName: string; role: string; invitationId: string }): Promise<void>;
}

/**
 * Entrega best-effort: uma falha do provedor nunca derruba a requisição do usuário nem vaza para a resposta;
 * vai para o log SEM destinatário completo, chave ou link. (Resposta idêntica com ou sem sucesso: sem enumeração de contas.)
 */
export function createMailer(opts: { env: Env; transport?: EmailTransport; log?: (m: string) => void }): Mailer {
  const { env } = opts;
  const log = opts.log ?? ((m: string) => console.error(`[e-mail] ${m}`));
  const transport =
    opts.transport ??
    (env.emailProvider === "resend"
      ? createResendTransport({ apiKey: env.resendApiKey!, from: env.emailFrom! })
      : env.emailProvider === "log"
        ? createLogTransport()
        : undefined);
  const mask = (to: string) => to.replace(/^(.).*(@.*)$/, "$1***$2");

  async function deliver(kind: string, to: string, build: () => ReturnType<typeof verificationEmail>) {
    if (!transport) return;
    try {
      await transport.send(build());
    } catch (e) {
      log(`falha ao enviar "${kind}" para ${mask(to)}: ${(e as Error).message}`);
    }
  }

  return {
    enabled: !!transport,
    sendVerification: ({ to, name, url }) => deliver("verificação", to, () => verificationEmail({ appName: APP_NAME, to, name, url })),
    sendPasswordReset: ({ to, name, url }) => deliver("recuperação de senha", to, () => passwordResetEmail({ appName: APP_NAME, to, name, url })),
    sendInvitation: ({ to, inviterName, organizationName, role, invitationId }) =>
      deliver("convite", to, () =>
        invitationEmail({ appName: APP_NAME, to, inviterName, organizationName, role, url: `${env.appUrl}/convite/${encodeURIComponent(invitationId)}` }),
      ),
  };
}
