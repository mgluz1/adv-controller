import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PASSWORD, email, startBackend, type Backend } from "./helpers.ts";

let be: Backend;
before(async () => {
  be = await startBackend();
});
after(() => be.close());

test("anônimo: session devolve usuario=null e operações de dados exigem login (401)", async () => {
  const c = be.client();
  const s = await c.v1("session");
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { usuario: null, escritorio: null, escritorios: [], permissoes: [] });
  for (const op of ["oab_list", "oab_create", "oab_update", "audit_list", "djen_list", "djen_mutate"])
    assert.equal((await c.v1(op)).status, 401, op);
  assert.equal((await c.v1("operacao_inexistente")).status, 404);
  for (const op of ["constructor", "__proto__", "toString", "hasOwnProperty"])
    assert.equal((await c.v1(op)).status, 404, `op ${op}`); // sem acesso a propriedades herdadas
});

test("cadastro → login → sessão → logout (contrato /api/v1)", async () => {
  const c = be.client();
  const e = email("a");
  const user = await c.signUp(e, "Ana Advogada");
  assert.equal(user.email, e);
  let s = await c.v1("session");
  assert.equal(s.json.usuario.email, e);
  assert.equal(s.json.escritorio, null); // ainda sem escritório
  assert.equal((await c.v1("sign-out")).status, 200);
  assert.equal((await c.v1("session")).json.usuario, null);
  const login = await c.signIn(e);
  assert.equal(login.status, 200);
  assert.deepEqual(login.json, { ok: true });
  s = await c.v1("session");
  assert.equal(s.json.usuario.nome, "Ana Advogada");
});

test("login com senha errada ou conta inexistente: mesma resposta genérica (sem enumeração)", async () => {
  const c = be.client();
  const e = email("b");
  await c.signUp(e);
  const errada = await be.client().signIn(e, "senha-errada-123");
  const inexistente = await be.client().signIn(email("nao"), PASSWORD);
  assert.equal(errada.status, 401);
  assert.equal(inexistente.status, 401);
  assert.deepEqual(errada.json, inexistente.json);
  assert.equal(errada.json.erro, "E-mail ou senha incorretos.");
});

test("cookie de sessão: HttpOnly, SameSite=Lax, sem expor token no corpo do contrato", async () => {
  const c = be.client();
  const e = email("c");
  await c.signUp(e);
  const r = await be.client().signIn(e);
  const raw = r.headers.getSetCookie().join("\n");
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.doesNotMatch(r.text, /token/i);
});

test("senha curta é recusada no cadastro", async () => {
  const r = await be.client().auth("/sign-up/email", { name: "Fulano", email: email("d"), password: "curta" });
  assert.equal(r.status, 400);
});

test("CSRF: POST do contrato com origem estranha ou sem origem é recusado", async () => {
  const c = be.client();
  await c.signUp(email("e"));
  const estranha = be.client("http://evil.test");
  assert.equal((await estranha.v1("oab_list")).status, 403);
  const semOrigem = be.client("");
  assert.equal((await semOrigem.v1("session")).status, 403);
  // mesmo com o cookie válido de outro cliente
  const roubado = be.client("http://evil.test");
  assert.equal((await roubado.request("/api/v1/session", {})).status, 403);
});

test("métodos e corpos inválidos no contrato", async () => {
  const c = be.client();
  assert.equal((await c.request("/api/v1/session", undefined, { method: "GET" })).status, 405);
  assert.equal((await c.request("/api/v1/session", undefined, { raw: "{não é json" })).status, 400);
  const grande = await c.request("/api/v1/session", undefined, { raw: JSON.stringify({ x: "a".repeat(70_000) }) });
  assert.equal(grande.status, 413);
});

test("operações futuras (publicações/coleta) exigem login e respondem 501 com sessão", async () => {
  const c = be.client();
  await c.signUp(email("f"));
  await c.createOffice("Escritório F", `f-${Date.now()}`);
  assert.equal((await c.v1("djen_list")).status, 501);
  assert.equal((await c.v1("djen_sync_manual")).status, 501);
});

test("health responde sem detalhes internos", async () => {
  const r = await be.client().request("/api/health", undefined, { method: "GET" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test("cabeçalhos de segurança e sem cache nas respostas da API", async () => {
  const r = await be.client().v1("session");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-powered-by"), null);
});

test("cadastro desativado (AUTH_SIGNUP_ENABLED=false): /sign-up é recusado", async () => {
  const fechado = await startBackend({ AUTH_SIGNUP_ENABLED: "false" });
  try {
    const r = await fechado.client().auth("/sign-up/email", { name: "Fulano", email: email("g"), password: PASSWORD });
    assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
  } finally {
    await fechado.close();
  }
});
