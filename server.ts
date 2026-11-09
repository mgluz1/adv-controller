import express from "express";
import path from "node:path";
import { config } from "dotenv";
import { createApp } from "./src/server/app.ts";
import { createAuth } from "./src/server/auth.ts";
import { connect, type Connection } from "./src/server/db/client.ts";
import { assertSafeDatabaseUrl, missingBackendVars, parseEnv } from "./src/server/env.ts";

config({ path: [".env.local", ".env"], quiet: true });
const env = parseEnv();
const missing = missingBackendVars(env);

let conn: Connection | undefined;
let app: express.Express;

if (missing.length === 0) {
  conn = connect(env.databaseUrl!);
  const t = assertSafeDatabaseUrl(env.databaseUrl!);
  console.log(`Backend: banco ${t.database}@${t.host}${t.isPooled ? " (pooler)" : ""}`); // sem senha
  app = createApp({ auth: createAuth({ db: conn.db, env }), db: conn.db, env });
} else if (env.nodeEnv === "production") {
  console.error(`Configuração ausente em produção: ${missing.join(", ")}`);
  process.exit(1);
} else {
  // Desenvolvimento sem banco: o front sobe, a API responde 503 com instruções (sem simular dados).
  console.warn(`Backend desativado (faltam ${missing.join(", ")}). Veja .env.example.`);
  app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use("/api", (_req, res) =>
    res.status(503).json({
      erro: `Backend não configurado: defina ${missing.join(" e ")} em .env.local.`,
    }),
  );
}

if (env.nodeEnv === "production") {
  app.use(express.static(path.resolve("dist")));
  app.get("*", (_req, res) => res.sendFile(path.resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

const server = app.listen(env.port, "127.0.0.1", () =>
  console.log(`Adv Controller: http://127.0.0.1:${env.port}`),
);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    server.close(() => void conn?.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
