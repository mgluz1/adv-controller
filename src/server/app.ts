import express, { type ErrorRequestHandler } from "express";
import { toNodeHandler } from "better-auth/node";
import { sql } from "drizzle-orm";
import { allowedOrigins } from "./env.ts";
import { ValidationError } from "./domain/oab.ts";
import { HttpError, type Deps } from "./routes/context.ts";
import { createV1Router } from "./routes/v1.ts";

/** Aplicação Express do backend (sem front/Vite — quem serve o front é o server.ts). */
export function createApp(deps: Deps) {
  const { auth, db, env } = deps;
  const origins = allowedOrigins(env);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.trustProxy || false);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (env.nodeEnv === "production")
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Better Auth (sign-up/in/out, organizações, membros, convites). Antes do parser de JSON.
  // O IP usado no limite de taxa vem do Express (`trust proxy`), nunca de um X-Forwarded-For forjado.
  app.all("/api/auth/*", (req, _res, next) => {
    req.headers["x-forwarded-for"] = req.ip || "127.0.0.1";
    next();
  }, toNodeHandler(auth));

  // Operações do painel. Proteção CSRF: a origem da requisição deve ser a do app.
  app.use(
    "/api/v1",
    (req, _res, next) => {
      if (req.method === "POST") {
        const origin = req.get("origin");
        const ok = origin
          ? origins.includes(origin)
          : req.get("sec-fetch-site") === "same-origin";
        if (!ok) return next(new HttpError(403, "Origem não permitida."));
      }
      next();
    },
    express.json({ limit: "64kb" }),
    createV1Router(deps),
  );

  app.use("/api", (_req, res) => res.status(404).json({ erro: "Rota não encontrada." }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ erro: err.message });
    if (err instanceof ValidationError) return void res.status(400).json({ erro: err.message });
    if (err?.type === "entity.too.large") return void res.status(413).json({ erro: "Requisição grande demais." });
    if (err?.type === "entity.parse.failed") return void res.status(400).json({ erro: "JSON inválido." });
    console.error("[erro]", err?.message ?? err); // detalhes só no log do servidor
    res.status(500).json({ erro: "Erro interno." });
  };
  app.use(onError);
  return app;
}
