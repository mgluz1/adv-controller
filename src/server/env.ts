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
}

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
  };
}

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
