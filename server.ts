import express from "express";
import path from "node:path";
import { config } from "dotenv";
import { createApp } from "./src/server/app.ts";
import { createAuth } from "./src/server/auth.ts";
import { connect, type Connection } from "./src/server/db/client.ts";
import { createCollector } from "./src/server/collector/collector.ts";
import { createMailer } from "./src/server/email/mailer.ts";
import { createScheduler } from "./src/server/collector/scheduler.ts";
import { runtimeRoleProblems } from "./src/server/db/preflight.ts";
import { collectDay } from "./src/server/djen/client.ts";
import { assertSafeDatabaseUrl, missingBackendVars, parseEnv } from "./src/server/env.ts";

config({ path: [".env.local", ".env"], quiet: true });
const env = parseEnv();
const missing = missingBackendVars(env);

let conn: Connection | undefined;
let app: express.Express;
let scheduler: ReturnType<typeof createScheduler> | undefined;

if (missing.length === 0) {
  conn = connect(env.databaseUrl!);
  const t = assertSafeDatabaseUrl(env.databaseUrl!);
  console.log(`Backend: banco ${t.database}@${t.host}${t.isPooled ? " (pooler)" : ""} como "${t.user}"`); // sem senha
  // A credencial de runtime não pode ser a do dono do esquema (ver drizzle/0002_runtime_role.sql).
  const problems = await runtimeRoleProblems(async (s) => (await conn!.pool.query(s)).rows).catch((e: Error) => [
    `falha ao verificar o papel de conexão: ${e.message}`,
  ]);
  if (problems.length) {
    for (const p of problems) console.error(`[segurança] ${p}`);
    if (env.nodeEnv === "production") {
      console.error("Recusando subir em produção com credencial de runtime insegura. Use o papel adv_runtime (npm run db:runtime-login).");
      process.exit(1);
    }
    console.warn("[segurança] Em desenvolvimento isto é apenas um aviso. Em produção seria fatal.");
  }
  // Coletor DJEN: só neste processo se COLLECTOR_ENABLED=true (ligue em UMA instância; ver docs/BACKEND.md).
  if (env.collectorEnabled) {
    const collector = createCollector({
      db: conn.db,
      collect: (attorney, day) => collectDay(attorney, day, { baseUrl: env.djenBaseUrl }),
    });
    scheduler = createScheduler({ collector, minIntervalMs: env.collectorMinIntervalMs });
    console.log(`Coletor DJEN: ligado (uma janela a cada ${env.collectorMinIntervalMs / 1000} s, no mínimo).`);
  } else {
    console.log("Coletor DJEN: desligado neste processo (COLLECTOR_ENABLED != true).");
  }
  const mailer = createMailer({ env });
  console.log(`E-mail transacional: ${mailer.enabled ? env.emailProvider : "desligado (recuperação de senha e cadastro por convite indisponíveis)"}.`);
  app = createApp({
    auth: createAuth({ db: conn.db, env, mailer }),
    db: conn.db,
    env,
    mailer,
    scheduler: { enabled: !!scheduler, wake: (org) => scheduler?.wake(org) },
  });
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

const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`Adv Controller: http://127.0.0.1:${env.port}`);
  scheduler?.start();
});

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    // Para o coletor primeiro (espera a janela em andamento), depois o HTTP e por último o banco.
    void (async () => {
      await scheduler?.stop(30_000);
      server.close(() => void conn?.close().finally(() => process.exit(0)));
    })();
    setTimeout(() => process.exit(1), 45_000).unref();
  });
