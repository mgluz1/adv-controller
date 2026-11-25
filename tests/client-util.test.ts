import test from "node:test";
import assert from "node:assert/strict";
import { PAPEIS, UFS, escapeHtml, gerarSlug, idDoConvite, linkConvite, papeisAtribuiveis, papelRotulo, slugBase, traduzirErro, validarNovaSenha } from "../src/client/util.ts";

// Utilitários puros da interface (sem DOM).
test("escapeHtml: neutraliza marcação e aspas; vazio e nulo viram texto vazio", () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')">&`), "&lt;img src=x onerror=&quot;alert(&#039;x&#039;)&quot;&gt;&amp;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(""), "");
});

test("papéis: rótulos em pt-BR; papel composto e desconhecido não inventam nome", () => {
  assert.deepEqual(PAPEIS.map(papelRotulo), ["Proprietário", "Administrador", "Membro", "Leitor"]);
  assert.equal(papelRotulo("admin,member"), "Administrador + Membro");
  assert.equal(papelRotulo("root"), "root");
  assert.equal(papelRotulo(null), "—");
  assert.equal(papelRotulo(""), "—");
});

test("papéis atribuíveis: dono atribui todos; admin nunca atribui 'owner'; os demais, nenhum", () => {
  assert.deepEqual(papeisAtribuiveis("owner"), ["owner", "admin", "member", "viewer"]);
  assert.deepEqual(papeisAtribuiveis("admin"), ["admin", "member", "viewer"]);
  assert.deepEqual(papeisAtribuiveis("member"), []);
  assert.deepEqual(papeisAtribuiveis("viewer"), []);
  assert.deepEqual(papeisAtribuiveis(null), []);
  assert.deepEqual(papeisAtribuiveis("viewer,admin"), ["admin", "member", "viewer"], "papéis somados valem o mais alto");
});

test("traduzirErro: mensagem do /api/v1 vale como está; códigos do Better Auth viram pt-BR; o resto cai num texto por status (nunca inglês cru)", () => {
  assert.equal(traduzirErro(409, { erro: "Esta OAB já está cadastrada no escritório." }), "Esta OAB já está cadastrada no escritório.");
  assert.match(traduzirErro(403, { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }), /Confirme seu e-mail/);
  assert.match(traduzirErro(400, { code: "INVALID_TOKEN", message: "Invalid token" }), /link/);
  assert.match(traduzirErro(403, { code: "CODIGO_NOVO_DESCONHECIDO", message: "Some english text" }), /permissão/);
  for (const [status, re] of [[400, /inválidos/], [401, /Entre de novo/], [404, /Não encontrado/], [409, /Já existe/], [429, /Muitas tentativas/], [500, /servidor/], [418, /Não foi possível/]] as const)
    assert.match(traduzirErro(status, { message: "English" }), re, String(status));
  assert.ok(!/[A-Za-z]{4,} [A-Za-z]{4,} [A-Za-z]{4,}/.test(traduzirErro(500, { message: "Internal server error occurred" })), "sem inglês");
  assert.match(traduzirErro(500, null), /servidor/);
  assert.match(traduzirErro(400, "texto"), /inválidos/);
});

test("slug do escritório: sem acento, minúsculo, só [a-z0-9-], com sufixo curto determinístico quando o aleatório é injetado", () => {
  assert.equal(slugBase("  Ação & Cia. Ltda!  "), "acao-cia-ltda");
  assert.equal(slugBase("!!!"), "escritorio");
  assert.equal(slugBase("A".repeat(100)).length, 40);
  assert.match(gerarSlug("Silva & Associados"), /^silva-associados-[a-z0-9]{4}$/);
  assert.equal(gerarSlug("X Y", () => 0), "x-y-0000");
  assert.match(gerarSlug("Qualquer", () => 0.999999999), /^qualquer-[a-z0-9]{4}$/);
  assert.notEqual(gerarSlug("Mesmo Nome", () => 0.1), gerarSlug("Mesmo Nome", () => 0.2));
});

test("link e id do convite: só o formato esperado; o id é codificado e o caminho não aceita lixo", () => {
  assert.equal(linkConvite("https://app.exemplo.com.br/", "abc123XYZ_-9"), "https://app.exemplo.com.br/convite/abc123XYZ_-9");
  assert.equal(linkConvite("https://a.test", "a/b c"), "https://a.test/convite/a%2Fb%20c");
  assert.equal(idDoConvite("/convite/abc123XYZ_-9"), "abc123XYZ_-9");
  assert.equal(idDoConvite("/convite/abc123XYZ_-9/"), "abc123XYZ_-9");
  for (const ruim of ["/convite/", "/convite/curto", "/convite/../etc", "/convite/a b c d e f g h", "/outra/abc123XYZ_-9", "/convite/abc123XYZ_-9/extra", "/convite/" + "x".repeat(65), "/"])
    assert.equal(idDoConvite(ruim), null, ruim);
});

test("nova senha: 10 a 128 caracteres e confirmação igual", () => {
  assert.match(validarNovaSenha("curta", "curta")!, /ao menos 10/);
  assert.match(validarNovaSenha("x".repeat(129), "x".repeat(129))!, /longa demais/);
  assert.match(validarNovaSenha("senha-forte-123", "outra-senha-123")!, /não conferem/);
  assert.equal(validarNovaSenha("senha-forte-123", "senha-forte-123"), null);
  assert.equal(validarNovaSenha("x".repeat(10), "x".repeat(10)), null);
});

test("UFs: as 27 unidades, sem repetição", () => {
  assert.equal(UFS.length, 27);
  assert.equal(new Set(UFS).size, 27);
  assert.ok(UFS.includes("DF") && UFS.includes("GO") && !UFS.includes("EX"));
});
