import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "./schema.ts";

/** Banco tipado, independente do driver (node-postgres em produção, PGlite nos testes). */
export type Db = PgDatabase<any, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
