import { defineConfig } from "drizzle-kit";

// Usado só para GERAR migrações (offline). Aplicar no Neon: `npm run db:plan` / `npm run db:migrate`
// (scripts/db.ts), que validam o destino antes. Não coloque credenciais neste arquivo.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  strict: true,
  verbose: true,
});
