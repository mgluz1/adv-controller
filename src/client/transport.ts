/**
 * Camada de transporte entre o painel e o backend.
 *
 * ESTADO: costura de migração. O backend do sistema de origem foi removido e o
 * backend do Adv Controller (Neon PostgreSQL + Drizzle ORM + Better Auth) ainda não existe.
 * Hoje `/api/v1/*` responde 501 (ver server.ts), então toda chamada falha com uma mensagem clara.
 *
 * Contrato provisório: `POST /api/v1/<operacao>` com corpo JSON (os argumentos da operação) e
 * resposta JSON. As operações e seus formatos estão documentados em docs/MIGRACAO.md e são
 * consumidas apenas por api.ts — quando o backend real existir, é o único ponto a ajustar.
 */
import { traduzirErro } from "./util.ts";

export const API_BASE = "/api/v1";

export async function chamar<T = unknown>(
  operacao: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  let resposta: Response;
  try {
    resposta = await fetch(`${API_BASE}/${operacao}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error("Sem conexão com o servidor. Verifique sua internet.");
  }
  if (!resposta.ok) {
    let mensagem = "";
    try {
      mensagem = (await resposta.json())?.erro ?? "";
    } catch {
      /* corpo sem JSON */
    }
    throw new Error(mensagem || `Falha na requisição (HTTP ${resposta.status}).`);
  }
  return (await resposta.json()) as T;
}

/**
 * Chamadas ao Better Auth (`/api/auth/*`): organização, convites, recuperação de senha. Devolve o JSON; erros viram `Error` com a
 * mensagem em pt-BR (nunca o texto cru em inglês do servidor). `corpo` ausente + GET para consultas.
 */
export const AUTH_BASE = "/api/auth";

export async function chamarAuth<T = any>(caminho: string, corpo?: Record<string, unknown>, metodo: "POST" | "GET" = "POST"): Promise<T> {
  let resposta: Response;
  try {
    resposta = await fetch(`${AUTH_BASE}${caminho}`, {
      method: metodo,
      headers: metodo === "POST" ? { "Content-Type": "application/json" } : undefined,
      credentials: "same-origin",
      body: metodo === "POST" ? JSON.stringify(corpo ?? {}) : undefined,
    });
  } catch {
    throw new Error("Sem conexão com o servidor. Verifique sua internet.");
  }
  let json: unknown = null;
  try {
    json = await resposta.json();
  } catch {
    /* corpo sem JSON */
  }
  if (!resposta.ok) throw new Error(traduzirErro(resposta.status, json));
  return json as T;
}
