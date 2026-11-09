import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../../src/server/app.ts";
import { createAuth } from "../../src/server/auth.ts";
import * as schema from "../../src/server/db/schema.ts";
import type { Db } from "../../src/server/db/types.ts";
import { parseEnv, type Env } from "../../src/server/env.ts";

/** Postgres real (PGlite) com as MIGRAÇÕES VERSIONADAS de drizzle/ aplicadas. Nada de rede. */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return { db: db as unknown as Db, raw: db, client };
}

export const APP_URL = "http://adv.test";
export const PASSWORD = "senha-forte-123";

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    BETTER_AUTH_URL: APP_URL,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    AUTH_SIGNUP_ENABLED: "true",
    ...overrides,
  });
}

/** Cliente HTTP com cookie jar (um por "navegador"/usuário). */
export class Client {
  private jar = new Map<string, string>();
  constructor(
    private base: string,
    public origin = APP_URL,
  ) {}

  get cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(
    path: string,
    body?: unknown,
    opts: { method?: string; headers?: Record<string, string | null>; raw?: string } = {},
  ) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.origin) headers.origin = this.origin;
    if (this.jar.size) headers.cookie = this.cookieHeader;
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (v === null) delete headers[k];
      else headers[k] = v;
    }
    const res = await fetch(this.base + path, {
      method: opts.method ?? "POST",
      headers,
      body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === "";
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* não-JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Operação do contrato do painel. */
  v1(op: string, body: unknown = {}) {
    return this.request(`/api/v1/${op}`, body);
  }
  /** Endpoint nativo do Better Auth. */
  auth(path: string, body: unknown = {}, method = "POST") {
    return this.request(`/api/auth${path}`, method === "GET" ? undefined : body, { method });
  }

  async signUp(email: string, name = "Fulano de Tal") {
    const r = await this.auth("/sign-up/email", { name, email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`sign-up falhou: ${r.status} ${r.text}`);
    return r.json.user as { id: string; email: string };
  }
  async signIn(email: string, password = PASSWORD) {
    return this.v1("sign-in", { email, password });
  }
  async createOffice(name: string, slug: string) {
    const r = await this.auth("/organization/create", { name, slug });
    if (r.status !== 200) throw new Error(`organization/create falhou: ${r.status} ${r.text}`);
    return r.json as { id: string; name: string };
  }
}

export interface Backend {
  db: Db;
  raw: Awaited<ReturnType<typeof createTestDb>>["raw"];
  env: Env;
  url: string;
  client: (origin?: string) => Client;
  close: () => Promise<void>;
}

export async function startBackend(envOverrides: Record<string, string> = {}): Promise<Backend> {
  const { db, raw, client: pg } = await createTestDb();
  const env = testEnv(envOverrides);
  const auth = createAuth({ db, env });
  const app = createApp({ auth, db, env });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    raw,
    env,
    url,
    client: (origin = APP_URL) => new Client(url, origin),
    close: async () => {
      await new Promise((r) => server.close(r));
      await pg.close();
    },
  };
}

let n = 0;
/** E-mail único por teste. */
export const email = (prefix = "u") => `${prefix}${++n}-${randomBytes(3).toString("hex")}@exemplo.test`;
