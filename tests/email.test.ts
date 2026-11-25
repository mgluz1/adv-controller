import test from "node:test";
import assert from "node:assert/strict";
import { createMailer } from "../src/server/email/mailer.ts";
import { invitationEmail, passwordResetEmail, verificationEmail } from "../src/server/email/templates.ts";
import { EmailDeliveryError, createLogTransport, createMemoryTransport, createResendTransport } from "../src/server/email/transports.ts";
import { ConfigError, emailIsTrusted, parseEnv } from "../src/server/env.ts";
import { allowInviteLookup } from "../src/server/routes/invite.ts";

// E-mail transacional: modelos, transportes e configuração. Sem rede (o fetch é simulado).
const URL_ = "https://app.exemplo.com.br/api/auth/verify-email?token=abc123&callbackURL=%2F";

// ── Modelos ───────────────────────────────────────────────────────────────────

test("modelos: pt-BR, com o link em texto e em HTML, e rodapé de 'ignore se não foi você'", () => {
  const v = verificationEmail({ appName: "Adv Controller", to: "ana@x.test", name: "Ana", url: URL_ });
  assert.equal(v.to, "ana@x.test");
  assert.match(v.subject, /Confirme seu e-mail/);
  assert.ok(v.text.includes(URL_) && v.html.includes("verify-email?token=abc123"));
  assert.match(v.text, /ignore esta mensagem/);
  const r = passwordResetEmail({ appName: "Adv Controller", to: "a@x.test", name: "Ana", url: "https://a.test/r" });
  assert.match(r.subject, /Redefinição de senha/);
  assert.match(r.text, /só pode ser usado uma vez/);
  const i = invitationEmail({ appName: "Adv Controller", to: "a@x.test", inviterName: "Bia", organizationName: "Silva & Cia", role: "admin", url: "https://a.test/convite/x" });
  assert.match(i.subject, /Convite para Silva & Cia/);
  assert.match(i.text, /administrador/);
  assert.match(i.text, /7 dias/);
});

test("modelos: nomes e links são escapados no HTML (nada de script, atributo ou marcação injetados)", () => {
  const evil = `<script>alert(1)</script>"'&`;
  const m = invitationEmail({ appName: "Adv Controller", to: "a@x.test", inviterName: evil, organizationName: evil, role: "member", url: `https://a.test/c?x="><img src=x onerror=alert(1)>` });
  for (const bad of ["<script>", "<img src=x", 'onerror=alert(1)>']) assert.ok(!m.html.includes(bad), `HTML contém ${bad}`);
  assert.ok(m.html.includes("&lt;script&gt;"));
  const v = verificationEmail({ appName: "App", to: "a@x.test", name: evil, url: "https://a.test" });
  assert.ok(!v.html.includes("<script>"));
});

test("modelos: quebra de linha no nome não entra no assunto (injeção de cabeçalho)", () => {
  const m = invitationEmail({ appName: "Adv Controller", to: "a@x.test", inviterName: "Bia", organizationName: "Escritório\r\nBcc: roubo@mal.test", role: "member", url: "https://a.test" });
  assert.ok(!/[\r\n]/.test(m.subject), JSON.stringify(m.subject));
  const v = verificationEmail({ appName: "App", to: "a@x.test", name: "X\nY", url: "https://a.test" });
  assert.ok(!/[\r\n]/.test(v.subject));
  assert.ok(m.subject.length < 200);
});

test("outros caracteres de controle (NUL, sino, DEL) também ficam fora do assunto e do nome", () => {
  const ctl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);
  const m = invitationEmail({ appName: "Adv Controller", to: "a@x.test", inviterName: "Bia\u0007", organizationName: "Esc\u0000rit\u0007ório\u007f X", role: "member", url: "https://a.test" });
  assert.ok(!ctl(m.subject), JSON.stringify(m.subject));
  assert.ok(!ctl(m.html.replace(/\n/g, "")), "HTML sem controle além das quebras de linha do próprio modelo");
  assert.ok(!ctl(verificationEmail({ appName: "App", to: "a@x.test", name: "N\u0000\u0007\u007fome", url: "https://a.test" }).subject));
});

test("papel desconhecido vira 'membro' no convite", () => {
  const m = invitationEmail({ appName: "App", to: "a@x.test", inviterName: "B", organizationName: "E", role: "hacker", url: "https://a.test" });
  assert.match(m.text, /como membro/);
});

// ── Transporte Resend ─────────────────────────────────────────────────────────

const msg = { to: "ana@x.test", subject: "Assunto", text: "texto", html: "<p>html</p>" };

test("Resend: POST com a chave só no cabeçalho Authorization e o corpo esperado", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const t = createResendTransport({ apiKey: "re_SEGREDO", from: "App <a@b.com>", fetcher: (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{}", { status: 200 }))) as any });
  await t.send(msg);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal((calls[0].init.headers as any).Authorization, "Bearer re_SEGREDO");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual([body.from, body.to, body.subject], ["App <a@b.com>", ["ana@x.test"], "Assunto"]);
  assert.ok(!String(calls[0].init.body).includes("re_SEGREDO"), "a chave não vai no corpo");
});

test("Resend: erro HTTP, rede e tempo esgotado viram EmailDeliveryError SEM vazar a chave nem o corpo da resposta", async () => {
  const mk = (f: any, timeoutMs?: number) => createResendTransport({ apiKey: "re_SEGREDO", from: "a@b.com", fetcher: f, timeoutMs });
  for (const t of [
    mk(async () => new Response('{"message":"re_SEGREDO inválida"}', { status: 401 })),
    mk(async () => { throw new TypeError("fetch failed re_SEGREDO"); }),
    mk((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))), 20),
  ]) {
    await assert.rejects(t.send(msg), (e: any) => e instanceof EmailDeliveryError && !e.message.includes("re_SEGREDO") && !e.message.includes("inválida"));
  }
});

// ── Mailer ────────────────────────────────────────────────────────────────────

const env = (o: Record<string, string> = {}) => parseEnv({ NODE_ENV: "test", BETTER_AUTH_URL: "https://app.exemplo.com.br", ...o });

test("mailer: sem provedor não envia nada e informa enabled=false", async () => {
  const m = createMailer({ env: env() });
  assert.equal(m.enabled, false);
  await m.sendVerification({ to: "a@x.test", name: "A", url: "https://x" }); // não lança
});

test("mailer: o convite aponta para /convite/<id> do app e usa o transporte", async () => {
  const mem = createMemoryTransport();
  const m = createMailer({ env: env(), transport: mem.transport });
  assert.equal(m.enabled, true);
  await m.sendInvitation({ to: "novo@x.test", inviterName: "Bia", organizationName: "Silva", role: "member", invitationId: "abc/def 123" });
  assert.equal(mem.sent.length, 1);
  assert.ok(mem.sent[0].text.includes("https://app.exemplo.com.br/convite/abc%2Fdef%20123"), "o id é codificado na URL");
});

test("mailer: falha do provedor NUNCA lança para quem chamou e o log não traz o e-mail completo, a chave nem o link", async () => {
  const logs: string[] = [];
  const m = createMailer({
    env: env(),
    log: (l) => logs.push(l),
    transport: { send: async () => { throw new EmailDeliveryError("o provedor de e-mail respondeu HTTP 500"); } },
  });
  await m.sendPasswordReset({ to: "ana.silva@exemplo.com", name: "Ana", url: "https://app/reset?token=SEGREDOTOKEN" });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("a***@exemplo.com"));
  assert.ok(!logs[0].includes("ana.silva") && !logs[0].includes("SEGREDOTOKEN"));
});

test("transporte de log imprime a mensagem (só desenvolvimento)", async () => {
  const out: string[] = [];
  await createLogTransport((l) => out.push(l)).send(msg);
  assert.ok(out[0].includes("ana@x.test") && out[0].includes("texto"));
});

// ── Configuração ──────────────────────────────────────────────────────────────

test("parseEnv: provedor de e-mail validado; 'log' proibido em produção; Resend exige chave e remetente válidos", () => {
  assert.equal(parseEnv({}).emailProvider, "none");
  assert.equal(parseEnv({ EMAIL_PROVIDER: "log" }).emailProvider, "log");
  assert.throws(() => parseEnv({ EMAIL_PROVIDER: "sendgrid" }), ConfigError);
  assert.throws(() => parseEnv({ NODE_ENV: "production", BETTER_AUTH_URL: "https://x.com", EMAIL_PROVIDER: "log" }), ConfigError, "imprimiria links de acesso no log");
  assert.throws(() => parseEnv({ EMAIL_PROVIDER: "resend", EMAIL_FROM: "a@b.com" }), ConfigError, "sem chave");
  assert.throws(() => parseEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k" }), ConfigError, "sem remetente");
  for (const bad of ["sem-arroba", "A <a@b>", "a@b.com\r\nBcc: x@y.com", "<a@b.com", "Nome <a@b.com> extra"])
    assert.throws(() => parseEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", EMAIL_FROM: bad }), ConfigError, bad);
  for (const ok of ["a@b.com", "Adv Controller <nao-responda@seudominio.com.br>"]) {
    const e = parseEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", EMAIL_FROM: ok });
    assert.equal(e.emailFrom, ok);
    assert.equal(emailIsTrusted(e), true);
  }
  assert.equal(emailIsTrusted(parseEnv({ EMAIL_PROVIDER: "log" })), false, "log não prova posse do e-mail");
  assert.equal(emailIsTrusted(parseEnv({})), false);
  assert.equal(parseEnv({ EMAIL_PROVIDER: "none", RESEND_API_KEY: "k" }).resendApiKey, undefined, "chave sem provedor é descartada");
});

// ── Consulta pública de convite ───────────────────────────────────────────────

test("consulta de convite: 30 por minuto por IP, depois bloqueia até a janela virar; IPs independentes", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) assert.equal(allowInviteLookup("ip-a", t0 + i, 30), true, `#${i + 1}`);
  assert.equal(allowInviteLookup("ip-a", t0 + 100, 30), false);
  assert.equal(allowInviteLookup("ip-b", t0 + 100, 30), true, "outro IP não é afetado");
  assert.equal(allowInviteLookup("ip-a", t0 + 61_000, 30), true, "nova janela");
});
