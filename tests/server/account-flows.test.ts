import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { createOwner, slugify } from "../../src/server/admin/bootstrap.ts";
import { ValidationError } from "../../src/server/domain/oab.ts";
import { resetInviteLimiter } from "../../src/server/routes/invite.ts";
import type { EmailMessage } from "../../src/server/email/templates.ts";
import { Client, PASSWORD, email, startBackend, type Backend } from "./helpers.ts";

// Fluxos de conta (Fase 2): convite, cadastro, verificação de e-mail, recuperação de senha e bootstrap do primeiro dono.
// E-mail simulado em memória; nenhuma rede. Três configurações: A) cadastro fechado + e-mail real, B) cadastro aberto + e-mail
// real, C) cadastro fechado sem e-mail.
const RESEND = { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FROM: "Adv Controller <nao-responda@exemplo.com.br>" };
let A: Backend, B: Backend, C: Backend;
before(async () => {
  A = await startBackend({ AUTH_SIGNUP_ENABLED: "false", ...RESEND }, { mail: true });
  B = await startBackend({ AUTH_SIGNUP_ENABLED: "true", ...RESEND }, { mail: true });
  C = await startBackend({ AUTH_SIGNUP_ENABLED: "false" }, { mail: "env" }); // sem provedor: o mailer fica desligado
});
beforeEach(resetInviteLimiter);
after(async () => {
  await A.close();
  await B.close();
  await C.close();
});

const NEW_PASSWORD = "outra-senha-forte-456";
let seq = 0;
const linkOf = (m: EmailMessage) => new URL(m.text.match(/https?:\/\/\S+/g)!.pop()!);
const follow = (c: Client, u: URL) => c.request(u.pathname + u.search, undefined, { method: "GET" });

/** Cria o dono pela via administrativa (o cadastro público está fechado) e o autentica. */
async function owner(be: Backend, label: string, office = `Escritório ${label}`) {
  const e = email(label);
  const r = await createOwner({ auth: be.auth, db: be.db }, { email: e, name: `Dono ${label}`, password: PASSWORD, office: `${office} ${++seq}` });
  const c = be.client();
  assert.equal((await c.signIn(e)).status, 200);
  return { c, email: e, ...r };
}
async function invite(be: Backend, o: { c: Client; organizationId?: string }, to: string, role = "member") {
  const r = await o.c.auth("/organization/invite-member", { email: to, role, organizationId: o.organizationId });
  assert.equal(r.status, 200, r.text);
  return r.json.id as string;
}
const user = async (be: Backend, e: string) => (await be.raw.select().from(schema.user).where(sql`lower(${schema.user.email}) = ${e.toLowerCase()}`))[0];

// ── Convite (cadastro fechado + e-mail real) ──────────────────────────────────

test("convite: e-mail enviado com o link do app, consulta pública, cadastro pelo link, aceite e uso único", async () => {
  const o = await owner(A, "dono");
  const invited = email("convidada");
  const id = await invite(A, o, invited, "admin");

  const mail = A.mail.last(invited)!;
  assert.ok(mail, "o convite foi enviado por e-mail");
  assert.match(mail.subject, /Convite para Escrit/);
  assert.equal(linkOf(mail).toString(), `http://adv.test/convite/${id}`);
  assert.match(mail.text, /administrador/);

  // sem sessão, o convidado vê para onde foi convidado
  const anon = A.client();
  const info = await anon.v1("invite_info", { id });
  assert.equal(info.status, 200, info.text);
  assert.deepEqual([info.json.email, info.json.role, info.json.account_exists, info.json.inviter], [invited, "admin", false, `Dono dono`]);
  assert.match(info.json.organization, /Escrit/);

  // cria a conta pelo link: já entra logado, e-mail verificado, e-mail vindo do CONVITE (o corpo é ignorado)
  const su = await anon.v1("invite_sign_up", { id, name: "Bia Convidada", password: PASSWORD, email: "outra@pessoa.test", organization_id: "x" });
  assert.equal(su.status, 200, su.text);
  assert.equal(su.json.email, invited);
  assert.equal((await user(A, "outra@pessoa.test")), undefined, "o e-mail do corpo não vale");
  const created = await user(A, invited);
  assert.equal(created.emailVerified, true, "o link do convite é a prova de posse do e-mail");
  const sess = (await anon.v1("session")).json;
  assert.equal(sess.usuario.email, invited);
  assert.equal(sess.escritorio, null, "ainda não aceitou");

  const acc = await anon.auth("/organization/accept-invitation", { invitationId: id });
  assert.equal(acc.status, 200, acc.text);
  const after = (await anon.v1("session")).json;
  assert.equal(after.escritorio.papel, "admin");
  assert.ok(after.permissoes.includes("member:create"));

  // uso único: o link morre; quem tem o id não consegue criar outra conta
  assert.equal((await A.client().v1("invite_info", { id })).status, 404);
  assert.equal((await A.client().v1("invite_sign_up", { id, name: "Ladra", password: PASSWORD })).status, 404);
  // e dá para entrar depois, normalmente
  assert.equal((await A.client().signIn(invited)).status, 200);
  // a trilha de auditoria do escritório registra o ingresso, com autor
  const ev = (await o.c.v1("audit_list")).json.eventos.map((e: any) => e.acao);
  assert.ok(ev.includes("member.invited") && ev.includes("member.joined"));
});

test("SEQUESTRO PRÉVIO: com cadastro fechado, nem o e-mail com convite pendente passa pelo cadastro público", async () => {
  const o = await owner(A, "dono2");
  const victim = email("vitima");
  await invite(A, o, victim);
  const attacker = A.client();
  const r = await attacker.auth("/sign-up/email", { name: "Atacante", email: victim, password: "senha-do-atacante-123" });
  assert.ok(r.status === 400 || r.status === 403, `status ${r.status}: ${r.text}`);
  assert.equal(await user(A, victim), undefined, "nenhuma conta foi criada para o e-mail da vítima");
  assert.equal((await attacker.v1("session")).json.usuario, null);
  // e sem convite, idem
  assert.ok([400, 403].includes((await A.client().auth("/sign-up/email", { name: "X", email: email("qualquer"), password: PASSWORD })).status));
});

test("invite_sign_up: convite inexistente, expirado, cancelado e já usado respondem IGUAL (404) e nada é criado", async () => {
  const o = await owner(A, "dono3");
  const e1 = email("expira"), e2 = email("cancela");
  const expired = await invite(A, o, e1);
  const canceled = await invite(A, o, e2);
  await A.raw.update(schema.invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitation.id, expired));
  assert.equal((await o.c.auth("/organization/cancel-invitation", { invitationId: canceled })).status, 200);
  const anon = A.client();
  const answers = [];
  for (const id of [expired, canceled, "inexistente123456", "x", "../../etc/passwd", "a".repeat(200), 5 as any, null as any]) {
    const r = await anon.v1("invite_sign_up", { id, name: "Fulana", password: PASSWORD });
    assert.equal(r.status, 404, String(id));
    const i = await anon.v1("invite_info", { id });
    assert.equal(i.status, 404);
    answers.push(JSON.stringify([r.json, i.json]));
  }
  assert.equal(new Set(answers).size, 1, "todas as respostas são idênticas: nada de enumeração");
  assert.equal(await user(A, e1), undefined);
  assert.equal(await user(A, e2), undefined);
});

test("invite_sign_up: valida nome e senha ANTES de gravar; recusa e-mail que já tem conta (409) sem alterá-la", async () => {
  const o = await owner(A, "dono4");
  const target = email("fraca");
  const id = await invite(A, o, target);
  const anon = A.client();
  for (const body of [{ name: "Ok Nome", password: "curta" }, { name: "Ok Nome", password: "x".repeat(129) }, { name: "", password: PASSWORD }, { name: "n\u0000ul", password: PASSWORD }, { name: "Ok Nome" }, { password: PASSWORD }, { name: 5, password: PASSWORD }])
    assert.equal((await anon.v1("invite_sign_up", { id, ...body })).status, 400, JSON.stringify(body));
  assert.equal(await user(A, target), undefined, "falhas de validação não criam nada");
  assert.equal((await anon.v1("invite_sign_up", { id, name: "Ok Nome", password: PASSWORD })).status, 200);

  // e-mail que JÁ tem conta: a rota recusa e não mexe na conta existente (a conta existente entra e aceita normalmente)
  const existing = await owner(A, "existente");
  const id2 = await invite(A, o, existing.email);
  const info = await A.client().v1("invite_info", { id: id2 });
  assert.equal(info.json.account_exists, true);
  const hijack = await A.client().v1("invite_sign_up", { id: id2, name: "Invasor", password: "senha-do-invasor-123" });
  assert.equal(hijack.status, 409);
  assert.equal((await A.client().signIn(existing.email, "senha-do-invasor-123")).status, 401, "a senha da conta não mudou");
  const acc = await existing.c.auth("/organization/accept-invitation", { invitationId: id2 });
  assert.equal(acc.status, 200, "quem já tem conta (verificada) entra e aceita");
});

test("o convite é pessoal: outra pessoa logada não consegue aceitar o convite alheio", async () => {
  const o = await owner(A, "dono5");
  const id = await invite(A, o, email("alvo"));
  const other = await owner(A, "intruso");
  const r = await other.c.auth("/organization/accept-invitation", { invitationId: id });
  assert.notEqual(r.status, 200);
  assert.equal((await A.client().v1("invite_info", { id })).status, 200, "o convite segue válido para o dono do e-mail");
});

// ── Verificação de e-mail e recuperação de senha (cadastro aberto + e-mail real) ──

test("cadastro público com e-mail real: não entra sem verificar; o link verifica e entra; reenvia ao tentar entrar", async () => {
  const e = email("aberto");
  const c = B.client();
  const r = await c.auth("/sign-up/email", { name: "Ana Aberta", email: e, password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.equal((await c.v1("session")).json.usuario, null, "sem sessão até verificar");
  const mail = B.mail.last(e)!;
  assert.match(mail.subject, /Confirme seu e-mail/);

  const blocked = await B.client().signIn(e);
  assert.equal(blocked.status, 401, "o contrato /api/v1 devolve o erro genérico de credencial");
  const direct = await B.client().auth("/sign-in/email", { email: e, password: PASSWORD });
  assert.equal(direct.status, 403);
  assert.equal(direct.json.code, "EMAIL_NOT_VERIFIED");
  assert.ok(B.mail.sent.filter((m) => m.to === e).length >= 2, "novo link ao tentar entrar sem verificar");

  const v = await follow(c, linkOf(mail));
  assert.ok([200, 302].includes(v.status), `verificação: ${v.status}`);
  assert.equal((await user(B, e)).emailVerified, true);
  assert.equal((await c.v1("session")).json.usuario.email, e, "entra logo após verificar");
  assert.equal((await B.client().signIn(e)).status, 200);
});

test("token de verificação inválido ou adulterado não verifica ninguém", async () => {
  const e = email("adulterado");
  await B.client().auth("/sign-up/email", { name: "Ana", email: e, password: PASSWORD });
  const u = linkOf(B.mail.last(e)!);
  u.searchParams.set("token", u.searchParams.get("token")!.slice(0, -4) + "AAAA");
  await follow(B.client(), u);
  assert.equal((await user(B, e)).emailVerified, false);
});

test("convite com e-mail real: conta de cadastro público ainda NÃO verificada não consegue aceitar (não há sessão)", async () => {
  const o = await owner(B, "dono-b");
  const e = email("naoverificada");
  const c = B.client();
  await c.auth("/sign-up/email", { name: "Não Verificada", email: e, password: PASSWORD });
  const id = await invite(B, o, e);
  assert.equal((await c.auth("/organization/accept-invitation", { invitationId: id })).status, 401, "sem sessão");
  assert.equal((await B.client().signIn(e)).status, 401, "e não entra sem verificar");
});

test("recuperação de senha: link por e-mail, redefine, encerra as sessões antigas, token de uso único", async () => {
  const o = await owner(A, "esqueceu");
  const oldSession = o.c;
  assert.ok((await oldSession.v1("session")).json.usuario);

  const req = A.client();
  const redirectTo = "http://adv.test/redefinir-senha";
  const r1 = await req.auth("/request-password-reset", { email: o.email, redirectTo });
  assert.equal(r1.status, 200, r1.text);
  const mail = A.mail.last(o.email)!;
  assert.match(mail.subject, /Redefinição de senha/);

  const hop = await follow(req, linkOf(mail));
  assert.equal(hop.status, 302);
  const dest = new URL(hop.headers.get("location")!);
  assert.equal(dest.origin + dest.pathname, redirectTo);
  const token = dest.searchParams.get("token")!;
  assert.ok(token);

  assert.equal((await req.auth("/reset-password", { newPassword: "curta", token })).status, 400, "senha fraca recusada");
  const done = await req.auth("/reset-password", { newPassword: NEW_PASSWORD, token });
  assert.equal(done.status, 200, done.text);
  assert.equal((await A.client().signIn(o.email, PASSWORD)).status, 401, "a senha antiga não vale mais");
  assert.equal((await A.client().signIn(o.email, NEW_PASSWORD)).status, 200);
  assert.equal((await oldSession.v1("session")).json.usuario, null, "a sessão aberta antes da troca foi encerrada");
  assert.notEqual((await req.auth("/reset-password", { newPassword: "terceira-senha-789", token })).status, 200, "o token é de uso único");
});

test("recuperação de senha não revela se o e-mail existe: mesma resposta, e nenhum e-mail para quem não tem conta", async () => {
  const o = await owner(A, "existe");
  const before = A.mail.sent.length;
  const known = await A.client().auth("/request-password-reset", { email: o.email, redirectTo: "http://adv.test/redefinir-senha" });
  const unknown = await A.client().auth("/request-password-reset", { email: email("naoexiste"), redirectTo: "http://adv.test/redefinir-senha" });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, known.json, "corpo idêntico");
  assert.equal(A.mail.sent.length, before + 1, "só quem tem conta recebe");
});

test("redirecionamento do e-mail só vale para o próprio app (nada de enviar o token para outro site)", async () => {
  const o = await owner(A, "redirect");
  for (const redirectTo of ["https://atacante.test/captura", "//atacante.test", "javascript:alert(1)"]) {
    const r = await A.client().auth("/request-password-reset", { email: o.email, redirectTo });
    assert.notEqual(r.status, 200, redirectTo);
  }
});

// ── Sem e-mail ────────────────────────────────────────────────────────────────

test("sem provedor de e-mail: nada é enviado, a recuperação de senha fica indisponível e o convite funciona pelo link compartilhado", async () => {
  const o = await owner(C, "sememail");
  const rec = (await C.client().v1("session")).json.recursos;
  assert.deepEqual(rec, { recuperacao_senha: false, cadastro_aberto: false, cadastro_por_convite: true, verificacao_email: false });
  const req = await C.client().auth("/request-password-reset", { email: o.email, redirectTo: "http://adv.test/redefinir-senha" });
  assert.notEqual(req.status, 500, "a recuperação indisponível não derruba nada");

  const invited = email("manual");
  const id = await invite(C, o, invited); // sem e-mail: o dono compartilha /convite/<id> por conta própria
  const c = C.client();
  assert.equal((await c.v1("invite_sign_up", { id, name: "Cida Manual", password: PASSWORD })).status, 200);
  assert.equal((await c.auth("/organization/accept-invitation", { invitationId: id })).status, 200);
  assert.ok((await c.v1("session")).json.escritorio);
});

test("recursos da sessão refletem a configuração do servidor", async () => {
  assert.deepEqual((await A.client().v1("session")).json.recursos, { recuperacao_senha: true, cadastro_aberto: false, cadastro_por_convite: true, verificacao_email: true });
  assert.deepEqual((await B.client().v1("session")).json.recursos, { recuperacao_senha: true, cadastro_aberto: true, cadastro_por_convite: true, verificacao_email: true });
});

// ── Bootstrap do primeiro dono ────────────────────────────────────────────────

test("bootstrap: cria dono com e-mail verificado, senha com hash, escritório e papel de dono; funciona com o cadastro fechado", async () => {
  const e = email("primeiro");
  const r = await createOwner({ auth: C.auth, db: C.db }, { email: `  ${e.toUpperCase()}  `, name: "  Primeira   Dona ", password: PASSWORD, office: "Silva & Associados" });
  assert.ok(r.userId && r.organizationId);
  assert.match(r.slug!, /^silva-associados/);
  const u = await user(C, e);
  assert.deepEqual([u.email, u.name, u.emailVerified], [e.toLowerCase(), "Primeira Dona", true]);
  const [acct] = await C.raw.select().from(schema.account).where(eq(schema.account.userId, u.id));
  assert.notEqual(acct.password, PASSWORD, "senha armazenada com hash");
  assert.ok(acct.password!.length > 40);
  const c = C.client();
  assert.equal((await c.signIn(e)).status, 200);
  const s = (await c.v1("session")).json;
  assert.equal(s.escritorio.papel, "owner");
  assert.equal(s.escritorio.nome, "Silva & Associados");
});

test("bootstrap: e-mail repetido, entradas inválidas e nome de escritório repetido (slug único)", async () => {
  const e = email("dup");
  await createOwner({ auth: C.auth, db: C.db }, { email: e, name: "Dona Um", password: PASSWORD });
  await assert.rejects(createOwner({ auth: C.auth, db: C.db }, { email: e.toUpperCase(), name: "Dona Dois", password: PASSWORD }), /Já existe/);
  for (const bad of [
    { email: "sem-arroba", name: "Fulana", password: PASSWORD },
    { email: email("x"), name: "", password: PASSWORD },
    { email: email("x"), name: "Fulana", password: "curta" },
    { email: email("x"), name: "Fulana", password: PASSWORD, office: "" },
    { email: "a b@x.test", name: "Fulana", password: PASSWORD },
  ])
    await assert.rejects(createOwner({ auth: C.auth, db: C.db }, bad as any), ValidationError, JSON.stringify(bad));
  const a = await createOwner({ auth: C.auth, db: C.db }, { email: email("s1"), name: "Um", password: PASSWORD, office: "Mesmo Nome" });
  const b = await createOwner({ auth: C.auth, db: C.db }, { email: email("s2"), name: "Dois", password: PASSWORD, office: "Mesmo Nome" });
  assert.notEqual(a.slug, b.slug);
  assert.equal(b.slug, `${a.slug}-2`);
  assert.deepEqual([slugify("  Ação & Cia. Ltda!  "), slugify("!!!"), slugify("A".repeat(100)).length], ["acao-cia-ltda", "escritorio", 40]);
});

test("e-mail do convite escapa o nome do escritório e de quem convida (nada de HTML injetado)", async () => {
  const e = email("dono-xss");
  const r = await createOwner({ auth: A.auth, db: A.db }, { email: e, name: "Dono Normal", password: PASSWORD, office: "<script>alert(1)</script> & Cia" });
  const c = A.client();
  await c.signIn(e);
  const invited = email("xss");
  await c.auth("/organization/invite-member", { email: invited, role: "member", organizationId: r.organizationId });
  const m = A.mail.last(invited)!;
  assert.ok(!m.html.includes("<script>"));
  assert.ok(m.html.includes("&lt;script&gt;"));
});
