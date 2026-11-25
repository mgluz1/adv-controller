/**
 * Configuração do servidor a partir de variáveis de ambiente, com validação estrita.
 * Nenhuma mensagem de erro inclui valores de segredos ou senhas de conexão.
 */

export type NodeEnv = "development" | "test" | "production";

export interface Env {
  nodeEnv: NodeEnv;
  port: number;
  /** URL pública do app (origem permitida para cookies/CSRF). */
  appUrl: string;
  /** Neon, endpoint com pooler: usada pelo servidor em runtime. */
  databaseUrl?: string;
  /** Neon, endpoint direto: usada pelas migrações. Cai para `databaseUrl` se ausente. */
  databaseUrlUnpooled?: string;
  authSecret?: string;
  /** Permite criar contas por conta própria (/sign-up). Padrão: só fora de produção. */
  signupEnabled: boolean;
  /** Saltos de proxy confiáveis (Express `trust proxy`); 0 = sem proxy. */
  trustProxy: number;
  /** Liga o coletor/agendador DESTE processo. Padrão: desligado (ligue em UMA instância; ver docs/BACKEND.md). */
  collectorEnabled: boolean;
  /** Intervalo mínimo entre o início de duas janelas (limite da fonte, por origem). Padrão 4 s; mínimo 2 s. */
  collectorMinIntervalMs: number;
  /** Base da API do DJEN. Padrão: a pública do CNJ. */
  djenBaseUrl?: string;
  /** Provedor de e-mail transacional. `none` = sem e-mail (recuperação de senha e cadastro por convite ficam indisponíveis). */
  emailProvider: EmailProvider;
  /** Remetente (ex.: `Adv Controller <nao-responda@seudominio.com.br>`). Obrigatório com provedor real. */
  emailFrom?: string;
  /** Chave do provedor (Resend). Nunca registrada em log. */
  resendApiKey?: string;
}

export type EmailProvider = "none" | "log" | "resend";

export const COLLECTOR_MIN_INTERVAL_FLOOR_MS = 2_000;

export class ConfigError extends Error {}

const PLACEHOLDER_SECRETS = /^(changeme|change-me|secret|password|test|dev|default|xxxxxxxx)/i;

export function parseEnv(
  src: Record<string, string | undefined> = process.env,
): Env {
  const raw = src.NODE_ENV;
  const nodeEnv: NodeEnv =
    raw === "production" || raw === "test" ? raw : "development";
  const port = Number(src.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError("PORT inválida.");
  const flag = src.AUTH_SIGNUP_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new ConfigError('AUTH_SIGNUP_ENABLED deve ser "true" ou "false".');
  const collectorFlag = src.COLLECTOR_ENABLED;
  if (collectorFlag !== undefined && collectorFlag !== "" && collectorFlag !== "true" && collectorFlag !== "false")
    throw new ConfigError('COLLECTOR_ENABLED deve ser "true" ou "false".');
  const collectorMinIntervalMs = Number(src.COLLECTOR_MIN_INTERVAL_MS || 4000);
  if (!Number.isInteger(collectorMinIntervalMs) || collectorMinIntervalMs < COLLECTOR_MIN_INTERVAL_FLOOR_MS || collectorMinIntervalMs > 600_000)
    throw new ConfigError(`COLLECTOR_MIN_INTERVAL_MS deve ser um inteiro entre ${COLLECTOR_MIN_INTERVAL_FLOOR_MS} e 600000 (abaixo disso o limite do DJEN seria arriscado).`);
  let djenBaseUrl: string | undefined;
  if (src.DJEN_BASE_URL) {
    try {
      const u = new URL(src.DJEN_BASE_URL);
      if (u.protocol !== "https:" || u.username || u.password) throw new Error();
      djenBaseUrl = src.DJEN_BASE_URL.replace(/\/+$/, "");
    } catch {
      throw new ConfigError("DJEN_BASE_URL deve ser uma URL https sem credenciais.");
    }
  }
  const rawProvider = src.EMAIL_PROVIDER || "none";
  if (rawProvider !== "none" && rawProvider !== "log" && rawProvider !== "resend")
    throw new ConfigError('EMAIL_PROVIDER deve ser "none", "log" (só desenvolvimento) ou "resend".');
  const emailProvider: EmailProvider = rawProvider;
  if (emailProvider === "log" && nodeEnv === "production")
    throw new ConfigError('EMAIL_PROVIDER="log" imprimiria links de acesso no log: não é permitido em produção.');
  const emailFrom = src.EMAIL_FROM?.trim() || undefined;
  if (emailProvider === "resend") {
    if (!src.RESEND_API_KEY) throw new ConfigError("RESEND_API_KEY é obrigatória com EMAIL_PROVIDER=resend.");
    if (!emailFrom || !/^[^<>\r\n]*<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(emailFrom))
      throw new ConfigError('EMAIL_FROM inválido: use "Nome <endereco@dominio>" ou "endereco@dominio".');
  }
  const trustProxy = Number(src.TRUST_PROXY || 0);
  if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 5)
    throw new ConfigError("TRUST_PROXY deve ser um inteiro de 0 a 5.");
  const appUrl = (src.BETTER_AUTH_URL || `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    "",
  );
  try {
    const u = new URL(appUrl);
    if (u.protocol !== "https:" && nodeEnv === "production")
      throw new ConfigError("BETTER_AUTH_URL deve usar https em produção.");
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError("BETTER_AUTH_URL inválida.");
  }
  return {
    nodeEnv,
    port,
    appUrl,
    databaseUrl: src.DATABASE_URL || undefined,
    databaseUrlUnpooled: src.DATABASE_URL_UNPOOLED || undefined,
    authSecret: src.BETTER_AUTH_SECRET || undefined,
    signupEnabled: flag === undefined ? nodeEnv !== "production" : flag === "true",
    trustProxy,
    collectorEnabled: collectorFlag === "true",
    collectorMinIntervalMs,
    djenBaseUrl,
    emailProvider,
    emailFrom,
    resendApiKey: emailProvider === "resend" ? src.RESEND_API_KEY : undefined,
  };
}

/** Só com provedor REAL o e-mail é prova de posse: verificação obrigatória, cadastro por convite e recuperação de senha. */
export const emailIsTrusted = (env: Pick<Env, "emailProvider">) => env.emailProvider === "resend";

/** Variáveis exigidas para o backend subir. Lista só os NOMES que faltam. */
export function missingBackendVars(env: Env): string[] {
  const m: string[] = [];
  if (!env.databaseUrl) m.push("DATABASE_URL");
  if (!env.authSecret) m.push("BETTER_AUTH_SECRET");
  return m;
}

export function validateAuthSecret(secret: string, nodeEnv: NodeEnv): void {
  if (secret.length < 32)
    throw new ConfigError("BETTER_AUTH_SECRET deve ter ao menos 32 caracteres.");
  if (nodeEnv === "production" && PLACEHOLDER_SECRETS.test(secret))
    throw new ConfigError("BETTER_AUTH_SECRET parece um valor de exemplo.");
}

export interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
  user: string;
  sslmode: string;
  isNeon: boolean;
  isPooled: boolean;
  isLocal: boolean;
}

/** Decompõe uma URL de conexão SEM expor a senha. */
export function describeDatabaseUrl(url: string): DatabaseTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError("URL de banco inválida.");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:")
    throw new ConfigError("A URL do banco deve começar com postgresql://.");
  const host = u.hostname.toLowerCase();
  return {
    host,
    port: u.port || "5432",
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    user: decodeURIComponent(u.username),
    sslmode: u.searchParams.get("sslmode") || "",
    isNeon: host.endsWith(".neon.tech"),
    isPooled: host.includes("-pooler."),
    isLocal: host === "localhost" || host === "127.0.0.1" || host === "::1",
  };
}

/**
 * Recusa destinos inseguros. Vale para o servidor e para as migrações:
 * - nunca Supabase (o sistema de origem);
 * - fora de localhost, TLS verificado é obrigatório.
 */
export function assertSafeDatabaseUrl(url: string): DatabaseTarget {
  const t = describeDatabaseUrl(url);
  if (/supabase/i.test(t.host))
    throw new ConfigError(
      "Destino recusado: o banco do sistema de origem (Supabase) não pode ser usado.",
    );
  if (!t.isLocal && !["require", "verify-full", "verify-ca"].includes(t.sslmode))
    throw new ConfigError(
      "A URL do banco remoto deve conter sslmode=require (TLS obrigatório).",
    );
  return t;
}

/**
 * Origens aceitas para cookies/CSRF. Em desenvolvimento aceita também o "gêmeo" localhost/127.0.0.1,
 * porque é comum abrir o app por um e abrir o outro.
 */
export function allowedOrigins(env: Pick<Env, "appUrl" | "nodeEnv">): string[] {
  const out = [env.appUrl];
  if (env.nodeEnv !== "production") {
    const u = new URL(env.appUrl);
    if (u.hostname === "127.0.0.1") out.push(env.appUrl.replace("127.0.0.1", "localhost"));
    if (u.hostname === "localhost") out.push(env.appUrl.replace("localhost", "127.0.0.1"));
  }
  return out;
}
