import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { assertSafeDatabaseUrl } from "../env.ts";
import * as schema from "./schema.ts";
import type { Db } from "./types.ts";

export interface Connection {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * Conexão com o Neon (node-postgres). Recusa destinos inseguros (Supabase, remoto sem TLS).
 * Use a URL COM pooler em runtime; `SET LOCAL` dentro de transação é compatível com o pooler.
 */
export function connect(databaseUrl: string): Connection {
  assertSafeDatabaseUrl(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "adv-controller",
  });
  // Erros de conexões ociosas não podem derrubar o processo.
  pool.on("error", (err) => console.error("[db] erro em conexão ociosa:", err.message));
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
