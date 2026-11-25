import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { Client, email, startBackend, type Backend } from "./helpers.ts";

// Termos de interesse (tarefa 1.6): gerência (interest_*) e efeito na aba/contadores de djen_list.
// O cenário "SPEC" é o de tests/a-migrar/sql-supabase/interesse-rollback.sql portado para a nova pilha.
let be: Backend;
before(async () => {
  be = await startBackend();
});
after(() => be.close());

let seq = 0;
async function newOffice(label: string) {
  const owner = be.client();
  const user = await owner.signUp(email(label), `Dono ${label}`);
  const org = await owner.createOffice(`Escritório ${label}`, `${label}-${++seq}-${Date.now()}`);
  return { owner, orgId: org.id as string, userId: user.id as string };
}
async function addMember(o: { owner: Client; orgId: string }, role: string) {
  const e = email(role);
  const inv = await o.owner.auth("/organization/invite-member", { email: e, role, organizationId: o.orgId });
  assert.equal(inv.status, 200, inv.text);
  const c = be.client();
  const u = await c.signUp(e, `Membro ${role}`);
  assert.equal((await c.auth("/organization/accept-invitation", { invitationId: inv.json.id })).status, 200);
  return { client: c, userId: u.id as string };
}
const newOab = async (o: { owner: Client }, name: string, n: string, uf = "GO") => (await o.owner.v1("oab_create", { name, oab_number: n, uf })).json.oab.id as string;

let sid = 5000;
async function seedPub(orgId: string, over: Record<string, unknown> = {}, attorneys: string[] = []) {
  const [p] = await be.raw
    .insert(schema.publications)
    .values({ organizationId: orgId, sourceId: String(++sid), tribunal: "TJGO", originalText: "Despacho comum.", availableOn: "2026-10-19", ...over } as any)
    .returning();
  for (const a of attorneys) await be.raw.insert(schema.publicationAttorneys).values({ organizationId: orgId, publicationId: p.id, attorneyId: a });
  return p;
}
const list = (c: Client, f: Record<string, unknown> = {}) => c.v1("djen_list", { p_filter: { limit: 100, ...f } });
const ids = (r: { json: any }) => r.json.rows.map((x: any) => x.source_id).sort();
const create = (c: Client, term: string, extra: Record<string, unknown> = {}) => c.v1("interest_create", { term, ...extra });

// ── Cenário da especificação do sistema de origem ─────────────────────────────

async function specOffice() {
  const O = await newOffice("spec");
  const a = await newOab(O, "Advogada Exemplo A", "123456", "GO");
  const b = await newOab(O, "Advogado Exemplo B", "234567", "RJ");
  const comum = [{ nome: "FULANO DE TAL", polo: "A" }];
  const p1 = await seedPub(O.orgId, { sourceId: "990001", tribunal: "TRT18", originalText: "Intimação de audiência.", recipients: [{ nome: "A.B.C.D. EXEMPLO EMPREENDIMENTOS LTDA", polo: "P" }] }, [a]);
  await seedPub(O.orgId, { sourceId: "990002", tribunal: "TJGO", originalText: "Despacho comum.", recipients: comum }, [a]);
  const p3 = await seedPub(O.orgId, { sourceId: "990003", tribunal: "TST", originalText: "RECORRIDO: a.b.c.d. empreendimentos", recipients: comum }, [a, b]);
  await seedPub(O.orgId, { sourceId: "990004", tribunal: "TRT18", originalText: "ABCD LTDA, A.B.C.DTDA e SA.B.C.D não são a sigla.", recipients: comum }, [a]);
  await seedPub(O.orgId, { sourceId: "990005", tribunal: "TJRJ", originalText: "Intimação comum.", recipients: comum }, [b]);
  const t = await create(O.owner, "A.B.C.D.", { attorney_id: a });
  assert.equal(t.status, 200, t.text);
  return { ...O, a, b, p1, p3, termId: t.json.term.id as string };
}

test("SPEC: a aba de interesse mostra as que casam; a aba do advogado dono do termo esconde as que casam; as demais abas e 'Todos' não mudam", async () => {
  const O = await specOffice();
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse" })), ["990001", "990003"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: O.a })), ["990002", "990004"], "990001 e 990003 saem da aba do advogado A");
  assert.deepEqual(ids(await list(O.owner)), ["990001", "990002", "990003", "990004", "990005"], "Todos: uma linha por publicação");
  assert.deepEqual(ids(await list(O.owner, { attorney: O.b })), ["990003", "990005"], "a 990003 permanece na aba do advogado B");
  // os vínculos NÃO foram alterados
  const links = await be.raw.select().from(schema.publicationAttorneys).where(eq(schema.publicationAttorneys.organizationId, O.orgId));
  assert.equal(links.filter((l) => l.publicationId === O.p1.id).length, 1);
  assert.equal(links.filter((l) => l.publicationId === O.p3.id).length, 2);
});

test("SPEC: contadores por aba = totais das listas e NÃO dependem da aba ativa", async () => {
  const O = await specOffice();
  const base = await list(O.owner);
  assert.deepEqual(base.json.tab_stats, {
    todos: { total: 5, revisar: 5 },
    [O.a]: { total: 2, revisar: 2 },
    [O.b]: { total: 2, revisar: 2 },
    interesse: { total: 2, revisar: 2 },
  });
  for (const f of [{ attorney: O.a }, { attorney: O.b }, { attorney: "interesse" }, { limit: 1, offset: 3 }, { status: "concluida" }])
    assert.deepEqual((await list(O.owner, f)).json.tab_stats, base.json.tab_stats, JSON.stringify(f));
  // os totais de cada aba são os totais das respectivas listas
  for (const [aba, key] of [["interesse", "interesse"], [O.a, O.a], [O.b, O.b]] as const)
    assert.equal((await list(O.owner, { attorney: aba })).json.total, base.json.tab_stats[key].total, aba);
  assert.equal((await list(O.owner)).json.total, base.json.tab_stats.todos.total);
  assert.deepEqual(base.json.attorney_stats.map((x: any) => [x.id, x.total]).sort(), [[O.a, 2], [O.b, 2]].sort());
});

test("SPEC: filtros e paginação valem DENTRO da aba de interesse, e os contadores obedecem aos mesmos filtros", async () => {
  const O = await specOffice();
  const tst = await list(O.owner, { attorney: "interesse", tribunal: "TST" });
  assert.equal(tst.json.total, 1);
  assert.equal(tst.json.tab_stats.interesse.total, 1, "contador com filtro");
  assert.equal((await list(O.owner, { attorney: "interesse", search: "recorrido" })).json.total, 1);
  const p = await list(O.owner, { attorney: "interesse", limit: 1, offset: 1 });
  assert.equal(p.json.rows.length, 1);
  assert.equal(p.json.total, 2, "o total não depende da página");
  assert.equal((await list(O.owner, { attorney: "interesse", start: "1900-01-01", end: "1900-01-02" })).status, 400, "datas anteriores a 2000 são recusadas");
  assert.equal((await list(O.owner, { attorney: "interesse", start: "2000-01-01", end: "2000-01-02" })).json.total, 0);
});

test("SPEC: status, anotação e arquivo funcionam dentro da aba de interesse", async () => {
  const O = await specOffice();
  assert.equal((await O.owner.v1("djen_mutate", { p_action: "status", p_ids: ["990001"], p_status: "em_analise", p_notes: "nota", p_providence: "providência" })).json, 1);
  assert.equal((await list(O.owner, { attorney: "interesse", status: "em_analise" })).json.total, 1);
  assert.equal((await O.owner.v1("djen_mutate", { p_action: "archive", p_ids: ["990001"] })).json, 1);
  assert.equal((await list(O.owner, { attorney: "interesse" })).json.total, 1);
  assert.equal((await list(O.owner, { attorney: "interesse", archived: true })).json.total, 1);
  assert.equal((await list(O.owner, { attorney: O.a, archived: true })).json.total, 0, "arquivada que casa também não aparece na aba do advogado");
  assert.equal((await O.owner.v1("djen_mutate", { p_action: "restore", p_ids: ["990001"] })).json, 1);
  assert.equal((await list(O.owner, { attorney: "interesse" })).json.total, 2);
});

test("SPEC: publicação nova que casa entra sozinha; descartada (tombstone) sai de todas as abas; outro escritório não vê nada", async () => {
  const O = await specOffice();
  const nova = await seedPub(O.orgId, { sourceId: "990006", tribunal: "TRT18", originalText: "EXECUTADO: A. B. C. D.", recipients: [] }, [O.a]);
  const ts = (await list(O.owner)).json.tab_stats;
  assert.deepEqual([ts.interesse.total, ts[O.a].total, ts.todos.total], [3, 2, 6], "entra na aba sem nenhuma ação manual");
  await O.owner.v1("djen_mutate", { p_action: "archive", p_ids: ["990006"] });
  await O.owner.v1("djen_mutate", { p_action: "remove", p_ids: ["990006"] });
  assert.equal((await list(O.owner)).json.tab_stats.interesse.total, 2, "tombstone sai da aba");
  void nova;

  const other = await newOffice("outra");
  const otherAb = await list(other.owner, { attorney: "interesse" });
  assert.equal(otherAb.status, 200);
  assert.equal(otherAb.json.total, 0);
  assert.ok(!("interesse" in otherAb.json.tab_stats), "escritório sem termos não tem a aba");
  assert.ok(!JSON.stringify((await list(other.owner)).json).includes("9900"));
});

// ── Comportamento da regra ────────────────────────────────────────────────────

test("termo SEM advogado só alimenta a aba de interesse: nenhuma aba de advogado esconde nada", async () => {
  const O = await newOffice("semadv");
  const a = await newOab(O, "Advogada A", "111");
  await seedPub(O.orgId, { sourceId: "800001", originalText: "contra A.B.C.D. Ltda" }, [a]);
  await create(O.owner, "A.B.C.D.");
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse" })), ["800001"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: a })), ["800001"], "continua na aba do advogado");
  assert.deepEqual((await list(O.owner)).json.tab_stats[a], { total: 1, revisar: 1 });
});

test("desativar o termo devolve as publicações à aba do advogado e some com a aba; reativar volta tudo", async () => {
  const O = await specOffice();
  assert.equal((await O.owner.v1("interest_update", { id: O.termId, active: false })).status, 200);
  assert.deepEqual(ids(await list(O.owner, { attorney: O.a })), ["990001", "990002", "990003", "990004"]);
  const off = await list(O.owner, { attorney: "interesse" });
  assert.equal(off.json.total, 0);
  assert.ok(!("interesse" in off.json.tab_stats), "sem termo ativo, sem aba");
  assert.deepEqual((await list(O.owner)).json.tab_stats[O.a], { total: 4, revisar: 4 });
  await O.owner.v1("interest_update", { id: O.termId, active: true });
  assert.deepEqual(ids(await list(O.owner, { attorney: O.a })), ["990002", "990004"]);
  assert.equal((await list(O.owner)).json.tab_stats.interesse.total, 2);
});

test("renomear o termo muda o efeito na hora; trocar o advogado dono muda de qual aba some; limpar o advogado para de esconder", async () => {
  const O = await specOffice();
  await O.owner.v1("interest_update", { id: O.termId, term: "Empreendimentos" });
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse" })), ["990001", "990003"], "'EXEMPLO EMPREENDIMENTOS' e 'empreendimentos' casam; a sigla não é mais o critério");
  await O.owner.v1("interest_update", { id: O.termId, term: "Despacho comum" });
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse" })), ["990002"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: O.a })), ["990001", "990003", "990004"]);

  await O.owner.v1("interest_update", { id: O.termId, attorney_id: O.b }); // agora o termo pertence à aba do advogado B
  assert.deepEqual(ids(await list(O.owner, { attorney: O.a })), ["990001", "990002", "990003", "990004"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: O.b })), ["990003", "990005"], "990002 não é de B; nada a esconder aqui");
  await O.owner.v1("interest_update", { id: O.termId, term: "Intimação comum", attorney_id: O.b });
  assert.deepEqual(ids(await list(O.owner, { attorney: O.b })), ["990003"], "990005 casa e sai da aba de B");
  await O.owner.v1("interest_update", { id: O.termId, attorney_id: null });
  assert.deepEqual(ids(await list(O.owner, { attorney: O.b })), ["990003", "990005"], "sem advogado: não esconde mais");
});

test("vários termos: casa com qualquer um; cada termo esconde só da aba do seu advogado", async () => {
  const O = await newOffice("varios");
  const a = await newOab(O, "Advogada A", "111");
  const b = await newOab(O, "Advogado B", "222", "RJ");
  await seedPub(O.orgId, { sourceId: "810001", originalText: "ALFA S/A" }, [a, b]);
  await seedPub(O.orgId, { sourceId: "810002", originalText: "BETA S/A" }, [a, b]);
  await seedPub(O.orgId, { sourceId: "810003", originalText: "GAMA S/A" }, [a, b]);
  await create(O.owner, "Alfa", { attorney_id: a });
  await create(O.owner, "Beta", { attorney_id: b });
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse" })), ["810001", "810002"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: a })), ["810002", "810003"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: b })), ["810001", "810003"]);
  const ts = (await list(O.owner)).json.tab_stats;
  assert.deepEqual([ts.todos.total, ts[a].total, ts[b].total, ts.interesse.total], [3, 2, 2, 2]);
});

test("casa pelo nome do destinatário OU pelo teor; destinatários corrompidos não derrubam a listagem", async () => {
  const O = await newOffice("dest");
  await seedPub(O.orgId, { sourceId: "820001", originalText: "sem nada", recipients: [{ nome: "Zeta Participações" }] });
  await seedPub(O.orgId, { sourceId: "820002", originalText: "cita Zeta Participações no teor", recipients: null });
  await seedPub(O.orgId, { sourceId: "820003", originalText: "nada", recipients: { nome: "Zeta Participações" } }); // não é lista
  await seedPub(O.orgId, { sourceId: "820004", originalText: "nada", recipients: "Zeta Participações" }); // texto solto
  await seedPub(O.orgId, { sourceId: "820005", originalText: "nada", recipients: [{ polo: "A" }, null, 5, { nome: 7 }] });
  await create(O.owner, "Zeta Participações");
  const r = await list(O.owner, { attorney: "interesse" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ids(r), ["820001", "820002"], "só os destinatários bem formados e o teor");
});

test("o termo também vale para o filtro de busca livre e de período dentro da aba, sem diferenciar maiúsculas nem acentos de caixa ASCII", async () => {
  const O = await newOffice("busca");
  await seedPub(O.orgId, { sourceId: "830001", availableOn: "2026-10-01", originalText: "REU: acme ltda" });
  await seedPub(O.orgId, { sourceId: "830002", availableOn: "2026-10-10", originalText: "Acme Ltda e outros" });
  await create(O.owner, "ACME LTDA");
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse" })), ["830001", "830002"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse", start: "2026-10-05" })), ["830002"]);
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse", search: "outros" })), ["830002"]);
});

// ── Gerência dos termos ───────────────────────────────────────────────────────

test("papéis: todos leem; só owner e admin criam e alteram; anônimo 401", async () => {
  const O = await newOffice("perm");
  const viewer = await addMember(O, "viewer");
  const member = await addMember(O, "member");
  const admin = await addMember(O, "admin");
  const made = await create(O.owner, "Termo Um");
  const id = made.json.term.id;
  for (const op of ["interest_list", "interest_create", "interest_update"]) assert.equal((await be.client().v1(op, {})).status, 401, op);
  for (const c of [viewer.client, member.client, O.owner, admin.client]) assert.equal((await c.v1("interest_list")).status, 200);
  for (const c of [viewer.client, member.client]) {
    assert.equal((await create(c, "Outro Termo")).status, 403);
    assert.equal((await c.v1("interest_update", { id, active: false })).status, 403);
  }
  assert.equal((await create(admin.client, "Termo Admin")).status, 200);
  assert.equal((await admin.client.v1("interest_update", { id, active: false })).status, 200);
  assert.equal((await O.owner.v1("interest_list")).json.terms.length, 2);
});

test("criar: normaliza, classifica (sigla/expressão), devolve o contrato e recusa duplicata mesmo escrita de outro jeito", async () => {
  const O = await newOffice("criar");
  const r = await create(O.owner, "  a.  b.  c.  d ");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ term: r.json.term.term, kind: r.json.term.kind, active: r.json.term.active, attorney_id: r.json.term.attorney_id }, { term: "a. b. c. d", kind: "sigla", active: true, attorney_id: null });
  for (const k of ["id", "created_at", "updated_at"]) assert.ok(r.json.term[k], k);
  assert.equal((await create(O.owner, "Empreendimentos Exemplo")).json.term.kind, "expressao");
  for (const dup of ["A.B.C.D.", "A. B. C. D.", "a.b.c.d", "A . B . C . D"]) {
    const d = await create(O.owner, dup);
    assert.equal(d.status, 409, dup);
    assert.equal(d.json.erro, "Este termo já está cadastrado no escritório.");
  }
  assert.equal((await create(O.owner, "EMPREENDIMENTOS   exemplo")).status, 409);
  assert.equal((await O.owner.v1("interest_list")).json.terms.length, 2, "a transação falha não deixa lixo");
  const other = await newOffice("criar2");
  assert.equal((await create(other.owner, "A.B.C.D.")).status, 200, "outro escritório pode ter o mesmo termo");
});

test("entradas inválidas são recusadas com 400/404 (nada chega ao banco)", async () => {
  const O = await newOffice("valida");
  const other = await newOffice("valida2");
  const foreign = await newOab(other, "Advogada Alheia", "999");
  const mine = await newOab(O, "Advogada Minha", "111");
  for (const term of ["", " ", "a", "x".repeat(81), "tem\u0000nulo", "tem\u0007sino", "...", 5, null, undefined, { a: 1 }, ["x"]])
    assert.equal((await create(O.owner, term as any)).status, 400, JSON.stringify(term));
  for (const attorney_id of ["xyz", 5, "", "00000000-0000-4000-8000-00000000000"])
    assert.equal((await create(O.owner, "Termo Valido", { attorney_id })).status, 400, JSON.stringify(attorney_id));
  assert.equal((await create(O.owner, "Termo Valido", { attorney_id: foreign })).status, 404, "OAB de outro escritório = inexistente");
  assert.equal((await create(O.owner, "Termo Valido", { attorney_id: "00000000-0000-4000-8000-000000000000" })).status, 404);
  assert.equal((await O.owner.v1("interest_list")).json.terms.length, 0);
  // quebra de linha e tab são espaço em branco: viram um espaço (não são "caracteres de controle" recusados)
  const spaced = await create(O.owner, "tem\n\tquebra");
  assert.equal(spaced.json.term.term, "tem quebra");
  const ok = await create(O.owner, "Termo Valido", { attorney_id: mine });
  assert.equal(ok.json.term.attorney_id, mine);
  const id = ok.json.term.id;
  for (const body of [{}, { id }, { id, active: "sim" }, { id, term: "" }, { id, attorney_id: "xyz" }, { id: "nao-e-uuid", active: false }])
    assert.equal((await O.owner.v1("interest_update", body)).status, 400, JSON.stringify(body));
  assert.equal((await O.owner.v1("interest_update", { id, attorney_id: foreign })).status, 404);
});

test("atualizar: renomeia (recalcula o padrão), ativa/desativa, troca/limpa o advogado; outro escritório = 404; duplicata = 409", async () => {
  const A = await newOffice("up-a");
  const B = await newOffice("up-b");
  const adv = await newOab(A, "Advogada A", "111");
  const t1 = (await create(A.owner, "Primeiro Termo")).json.term;
  const t2 = (await create(A.owner, "Segundo Termo")).json.term;

  const renamed = await A.owner.v1("interest_update", { id: t1.id, term: "  Novo   Nome " });
  assert.equal(renamed.json.term.term, "Novo Nome");
  const row = (await be.raw.select().from(schema.interestTerms).where(eq(schema.interestTerms.id, t1.id)))[0];
  assert.match(row.pattern, /novo/, "o padrão foi recalculado");
  assert.equal((await A.owner.v1("interest_update", { id: t1.id, active: false })).json.term.active, false);
  assert.equal((await A.owner.v1("interest_update", { id: t1.id, attorney_id: adv })).json.term.attorney_id, adv);
  assert.equal((await A.owner.v1("interest_update", { id: t1.id, attorney_id: null })).json.term.attorney_id, null);
  assert.equal((await A.owner.v1("interest_update", { id: t2.id, term: "novo nome" })).status, 409);
  const same = await A.owner.v1("interest_update", { id: t1.id, term: "Novo Nome" });
  assert.equal(same.status, 200, "regravar o próprio termo não é duplicata");

  const hijack = await B.owner.v1("interest_update", { id: t1.id, active: true, term: "Sequestrado" });
  const missing = await B.owner.v1("interest_update", { id: "00000000-0000-4000-8000-000000000000", active: true });
  assert.equal(hijack.status, 404);
  assert.deepEqual(hijack.json, missing.json, "alheio é indistinguível de inexistente");
  assert.equal((await A.owner.v1("interest_list")).json.terms.find((x: any) => x.id === t1.id).term, "Novo Nome");
  assert.equal((await B.owner.v1("interest_list")).json.terms.length, 0);
});

test("auditoria: cada mudança registra o autor; falhas não geram evento", async () => {
  const O = await newOffice("audit");
  const admin = await addMember(O, "admin");
  const t = (await create(admin.client, "Termo Auditado")).json.term;
  await create(admin.client, "termo auditado"); // 409
  await O.owner.v1("interest_update", { id: t.id, term: "Termo Renomeado" });
  await O.owner.v1("interest_update", { id: t.id, active: false });
  await O.owner.v1("interest_update", { id: t.id, active: true });
  await O.owner.v1("interest_update", { id: "00000000-0000-4000-8000-000000000000", active: true }); // 404
  const ev = (await O.owner.v1("audit_list")).json.eventos.filter((e: any) => e.acao.startsWith("interest."));
  assert.deepEqual(ev.map((e: any) => e.acao).sort(), ["interest.activated", "interest.created", "interest.deactivated", "interest.updated"]);
  const created = ev.find((e: any) => e.acao === "interest.created");
  assert.equal(created.autor_id, admin.userId);
  assert.equal(created.entidade_id, t.id);
  assert.deepEqual(created.detalhes, { term: "Termo Auditado", attorney_id: null });
  assert.equal(ev.find((e: any) => e.acao === "interest.updated").autor_id, O.userId);
});

test("a regex nunca vem do cliente: corpo com 'pattern' é ignorado e o termo vira texto literal", async () => {
  const O = await newOffice("literal");
  await seedPub(O.orgId, { sourceId: "840001", originalText: "contrato qualquer" });
  await seedPub(O.orgId, { sourceId: "840002", originalText: "o termo x.* literal aqui" });
  const r = await O.owner.v1("interest_create", { term: "x.*", pattern: ".*", attorney_id: null });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ids(await list(O.owner, { attorney: "interesse" })), ["840002"], "não casa tudo");
});
