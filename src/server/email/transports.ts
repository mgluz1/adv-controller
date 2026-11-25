import type { EmailMessage } from "./templates.ts";

/** Entrega de e-mail. Nunca lança por detalhe do provedor: o erro vai para o log do servidor, sem a chave nem o corpo. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export class EmailDeliveryError extends Error {}

/** Resend (https://resend.com): API REST simples. A chave só viaja no cabeçalho Authorization. */
export function createResendTransport(opts: { apiKey: string; from: string; fetcher?: typeof fetch; timeoutMs?: number }): EmailTransport {
  const fetcher = opts.fetcher ?? fetch;
  return {
    async send(m) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
      try {
        const res = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: opts.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new EmailDeliveryError(`o provedor de e-mail respondeu HTTP ${res.status}`);
      } catch (e) {
        if (e instanceof EmailDeliveryError) throw e;
        throw new EmailDeliveryError((e as Error)?.name === "AbortError" ? "tempo esgotado ao enviar e-mail" : "falha de rede ao enviar e-mail");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** SÓ DESENVOLVIMENTO: imprime a mensagem (com os links) no log. Recusado em produção por parseEnv. */
export function createLogTransport(log: (line: string) => void = (l) => console.log(l)): EmailTransport {
  return {
    async send(m) {
      log(`[e-mail:dev] para=${m.to} assunto="${m.subject}"\n${m.text}`);
    },
  };
}

/** Testes: guarda as mensagens enviadas. */
export function createMemoryTransport() {
  const sent: EmailMessage[] = [];
  return {
    sent,
    transport: { async send(m: EmailMessage) { sent.push(m); } } satisfies EmailTransport,
    last: (to?: string) => [...sent].reverse().find((m) => !to || m.to.toLowerCase() === to.toLowerCase()),
  };
}
