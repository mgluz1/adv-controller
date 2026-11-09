import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PASSWORD, email, startBackend, type Backend } from "./helpers.ts";

// Modo produção: cookies Secure, HSTS, limite de taxa ativo e CSRF nos endpoints nativos.
const ORIGIN = "https://adv.test";
let be: Backend;
before(async () => {
  be = await startBackend({ NODE_ENV: "production", BETTER_AUTH_URL: ORIGIN });
});
after(() => be.close());

// Primeiro: os testes de limite de taxa abaixo esgotam a janela do IP local.
test("endpoints nativos do Better Auth recusam origem estranha (CSRF)", async () => {
  const evil = be.client("https://evil.test");
  const r = await evil.auth("/sign-in/email", { email: email("q"), password: PASSWORD });
  assert.equal(r.status, 403);
  const r2 = await evil.auth("/sign-up/email", { name: "Fulano", email: email("q2"), password: PASSWORD });
  assert.equal(r2.status, 403);
});

test("produção: cookie Secure + HttpOnly + SameSite=Lax e HSTS", async () => {
  const c = be.client(ORIGIN);
  const r = await c.auth("/sign-up/email", { name: "Fulano", email: email("p"), password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  const raw = r.headers.getSetCookie().join("\n");
  assert.match(raw, /Secure/i);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /__Secure-adv/);
  assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
});

test("produção: limite de taxa no login (5 por minuto) responde 429 com mensagem", async () => {
  const e = email("rl");
  await be.client(ORIGIN).auth("/sign-up/email", { name: "Fulano", email: e, password: PASSWORD });
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await be.client(ORIGIN).signIn(e, "senha-errada-123")).status);
  assert.ok(statuses.includes(429), `esperava 429 em ${statuses}`);
  const bloqueado = await be.client(ORIGIN).signIn(e, PASSWORD); // até a senha certa fica bloqueada na janela
  assert.equal(bloqueado.status, 429);
  assert.match(bloqueado.json.erro, /Muitas tentativas/);
});

test("produção: X-Forwarded-For forjado não burla o limite (IP vem do Express)", async () => {
  const e = email("xf");
  await be.client(ORIGIN).auth("/sign-up/email", { name: "Fulano", email: e, password: PASSWORD });
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const c = be.client(ORIGIN);
    const r = await c.request("/api/v1/sign-in", { email: e, password: "senha-errada-123" }, { headers: { "x-forwarded-for": `10.0.0.${i}` } });
    statuses.push(r.status);
  }
  assert.ok(statuses.includes(429), `IP forjado burlou o limite: ${statuses}`);
});
