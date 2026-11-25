/**
 * Modelos dos e-mails transacionais (pt-BR). Texto simples + HTML mínimo (sem imagens remotas, sem rastreamento).
 * Todo valor vindo de usuário (nomes) é escapado no HTML; links vêm do servidor, nunca do cliente.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

/** Nome com quebras de linha ou controle não entra em assunto/cabeçalho (injeção de cabeçalho de e-mail). */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

function layout(appName: string, title: string, paragraphs: string[], action: { label: string; url: string }, footer: string): { html: string; text: string } {
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f4f1;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px">
<tr><td><p style="margin:0 0 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b6b66">${esc(appName)}</p>
<h1 style="margin:0 0 16px;font-size:20px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${p}</p>`).join("\n")}
<p style="margin:22px 0"><a href="${esc(action.url)}" style="background:#1f4d3a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;display:inline-block">${esc(action.label)}</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#6b6b66">Se o botão não funcionar, copie e cole este endereço no navegador:</p>
<p style="margin:0 0 18px;font-size:12px;word-break:break-all;color:#6b6b66">${esc(action.url)}</p>
<p style="margin:0;font-size:12px;color:#6b6b66">${esc(footer)}</p></td></tr></table></td></tr></table></body></html>`;
  const text = [title, "", ...paragraphs.map((p) => p.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")), "", `${action.label}: ${action.url}`, "", footer].join("\n");
  return { html, text };
}

export function verificationEmail(a: { appName: string; to: string; name: string; url: string }): EmailMessage {
  const { html, text } = layout(
    a.appName,
    "Confirme seu e-mail",
    [`Olá, ${esc(oneLine(a.name))}.`, "Para ativar sua conta, confirme que este e-mail é seu. O link vale por 1 hora."],
    { label: "Confirmar e-mail", url: a.url },
    "Se você não criou uma conta, ignore esta mensagem: nada será feito.",
  );
  return { to: a.to, subject: `Confirme seu e-mail — ${oneLine(a.appName)}`, text, html };
}

export function passwordResetEmail(a: { appName: string; to: string; name: string; url: string }): EmailMessage {
  const { html, text } = layout(
    a.appName,
    "Redefinir sua senha",
    [`Olá, ${esc(oneLine(a.name))}.`, "Recebemos um pedido para redefinir a senha da sua conta. O link vale por 1 hora e só pode ser usado uma vez."],
    { label: "Criar nova senha", url: a.url },
    "Se não foi você, ignore esta mensagem: sua senha continua a mesma.",
  );
  return { to: a.to, subject: `Redefinição de senha — ${oneLine(a.appName)}`, text, html };
}

const ROLE_PT: Record<string, string> = { owner: "proprietário", admin: "administrador", member: "membro", viewer: "leitor" };

export function invitationEmail(a: { appName: string; to: string; inviterName: string; organizationName: string; role: string; url: string }): EmailMessage {
  const role = ROLE_PT[a.role] ?? "membro";
  const org = oneLine(a.organizationName);
  const { html, text } = layout(
    a.appName,
    `Convite para ${org}`,
    [
      `<strong>${esc(oneLine(a.inviterName))}</strong> convidou você para o escritório <strong>${esc(org)}</strong> como ${esc(role)}.`,
      "O convite vale por 7 dias e só funciona para este endereço de e-mail.",
    ],
    { label: "Aceitar convite", url: a.url },
    "Se você não esperava este convite, pode ignorá-lo.",
  );
  return { to: a.to, subject: `Convite para ${org} — ${oneLine(a.appName)}`, text, html };
}
