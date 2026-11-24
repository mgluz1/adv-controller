import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { Client, email, startBackend, type Backend } from "./helpers.ts";

// djen_list / djen_mutate / djen_archive_preview (docs/MIGRACAO.md §3). As publicações são semeadas direto no
// banco (o coletor só chega na tarefa 1.4); tudo o mais passa pelo HTTP real, com sessão e RLS.
let be: Backend;
before(async () => {
  be = await startBackend();
});
after(() => be.close());

let seq = 0;
async function newOffice(label: string) {
  const owner = be.client();
  const e = email(label);
  const user = await owner.signUp(e, `Dono ${label}`);
  const org = await owner.createOffice(`Escritório ${label}`, `${label}-${++seq}-${Date.now()}`);
  return { owner, orgId: org.id, userId: user.id };
}
async function addMember(o: { owner: Client; orgId: string }, role: string) {
  const e = email(role);
  const inv = await o.owner.auth("/organization/invite-member", { email: e, role, organizationId: o.orgId });
  assert.equal(inv.status, 200, inv.text);
  const c = be.client();
  await c.signUp(e, `Membro ${role}`);
  assert.equal((await c.auth("/organization/accept-invitation", { invitationId: inv.json.id })).status, 200);
  return c;
}
async function newAttorney(o: { owner: Client }, name: string, n: string, uf = "GO", active = true) {
  const r = await o.owner.v1("oab_create", { name, oab_number: n, uf });
  assert.equal(r.status, 200, r.text);
  if (!active) assert.equal((await o.owner.v1("oab_update", { id: r.json.oab.id, active: false })).status, 200);
  return r.json.oab.id as string;
}

let sid = 1000;
async function seedPub(orgId: string, over: Record<string, unknown> = {}, attorneys: string[] = []) {
  const [p] = await be.raw
    .insert(schema.publications)
    .values({
      organizationId: orgId,
      sourceId: String(++sid),
      tribunal: "TJGO",
      processNumber: `000${sid}-11.2026.8.09.0001`,
      originalText: `Intimação da comunicação ${sid}`,
      availableOn: "2026-10-19",
      rawPayload: { id: sid },
      ...over,
    } as any)
    .returning();
  for (const a of attorneys)
    await be.raw.insert(schema.publicationAttorneys).values({ organizationId: orgId, publicationId: p.id, attorneyId: a });
  return p;
}
const list = (c: Client, f: Record<string, unknown> = {}) => c.v1("djen_list", { p_filter: f });
const ids = (r: { json: any }) => r.json.rows.map((x: any) => x.source_id);
const mutate = (c: Client, p_action: string, p_ids: unknown, extra: Record<string, unknown> = {}) =>
  c.v1("djen_mutate", { p_action, p_ids, ...extra });
const dbRow = async (orgId: string, sourceId: string) =>
  (await be.raw.select().from(schema.publications).where(sql`${schema.publications.organizationId} = ${orgId} and ${schema.publications.sourceId} = ${sourceId}`))[0];

// ── Acesso e papéis ───────────────────────────────────────────────────────────

test("anônimo não acessa nenhuma das operações (401)", async () => {
  const anon = be.client();
  for (const op of ["djen_list", "djen_mutate", "djen_archive_preview"]) assert.equal((await anon.v1(op, {})).status, 401, op);
});

test("papéis: viewer só lê; member revisa/arquiva/restaura; só owner/admin descartam", async () => {
  const O = await newOffice("papeis");
  const viewer = await addMember(O, "viewer");
  const member = await addMember(O, "member");
  const admin = await addMember(O, "admin");
  const p = await seedPub(O.orgId);
  const sid1 = p.sourceId;

  assert.equal((await list(viewer)).status, 200);
  assert.equal((await mutate(viewer, "status", [sid1], { p_status: "concluida" })).status, 403);
  assert.equal((await mutate(viewer, "archive", [sid1])).status, 403);
  assert.equal((await viewer.v1("djen_archive_preview", { p_date: "2026-12-31" })).status, 403);

  assert.equal((await mutate(member, "status", [sid1], { p_status: "em_analise" })).json, 1);
  assert.equal((await mutate(member, "archive", [sid1])).json, 1);
  assert.equal((await mutate(member, "restore", [sid1])).json, 1);
  assert.equal((await mutate(member, "archive", [sid1])).json, 1);
  assert.equal((await mutate(member, "remove", [sid1])).status, 403, "member não descarta");
  assert.equal((await dbRow(O.orgId, sid1)).removedAt, null);

  assert.equal((await mutate(admin, "remove", [sid1])).json, 1);
  assert.notEqual((await dbRow(O.orgId, sid1)).removedAt, null);
});

// ── Listagem ──────────────────────────────────────────────────────────────────

test("listagem: formato do contrato, só ativas, mais recentes primeiro, com as OABs de cada uma", async () => {
  const O = await newOffice("lista");
  const a1 = await newAttorney(O, "Ana Souza", "111");
  const p1 = await seedPub(O.orgId, { availableOn: "2026-10-10", tribunal: "TJGO" }, [a1]);
  const p2 = await seedPub(O.orgId, { availableOn: "2026-10-19", tribunal: "TRT18" });
  await seedPub(O.orgId, { archivedAt: new Date() });
  const r = await list(O.owner);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ids(r), [p2.sourceId, p1.sourceId]);
  assert.equal(r.json.total, 2);
  const row = r.json.rows.find((x: any) => x.source_id === p1.sourceId);
  for (const k of ["id", "source_id", "source_hash", "tribunal", "judging_body", "process_number", "process_mask", "class_name", "communication_type", "original_text", "medium", "source_url", "available_on", "published_on", "status", "notes", "action_note", "first_seen_at", "last_seen_at", "archived_at", "attorneys"])
    assert.ok(k in row, `campo ausente: ${k}`);
  assert.equal(row.available_on, "2026-10-10");
  assert.deepEqual(row.attorneys, [{ id: a1, name: "Ana Souza", oab_number: "111", uf: "GO" }]);
  assert.equal(row.status, "a_revisar");
  for (const k of ["total", "rows", "stats", "attorney_stats", "tab_stats", "tribunals", "pending_windows", "latest", "last_success", "next_due"])
    assert.ok(k in r.json, `resposta sem ${k}`);
  assert.deepEqual(r.json.tribunals, [{ tribunal: "TJGO" }, { tribunal: "TRT18" }]);
  assert.deepEqual([r.json.latest, r.json.last_success, r.json.next_due, r.json.pending_windows], [null, null, null, 0]);
});

test("filtros: status, tribunal, período, busca, ordem, arquivadas e paginação", async () => {
  const O = await newOffice("filtros");
  const a = await seedPub(O.orgId, { availableOn: "2026-10-01", tribunal: "TJGO", status: "a_revisar", processNumber: "0000001-11.2026.8.09.0001", originalText: "Despacho comum" });
  const b = await seedPub(O.orgId, { availableOn: "2026-10-10", tribunal: "TRT18", status: "em_analise", processNumber: "0000002-22.2026.5.18.0001", originalText: "Audiência marcada" });
  const c = await seedPub(O.orgId, { availableOn: "2026-10-20", tribunal: "TJGO", status: "concluida", processNumber: "0000003-33.2026.8.09.0001", originalText: "SENTENÇA publicada" });
  const d = await seedPub(O.orgId, { availableOn: "2026-10-05", archivedAt: new Date() });

  assert.deepEqual(ids(await list(O.owner, { status: "em_analise" })), [b.sourceId]);
  assert.deepEqual(ids(await list(O.owner, { status: "todos" })).length, 3);
  assert.deepEqual(ids(await list(O.owner, { tribunal: "TRT18" })), [b.sourceId]);
  assert.deepEqual(ids(await list(O.owner, { start: "2026-10-05", end: "2026-10-10" })), [b.sourceId]);
  assert.deepEqual(ids(await list(O.owner, { start: "2026-10-10" })), [c.sourceId, b.sourceId]);
  assert.deepEqual(ids(await list(O.owner, { end: "2026-10-01" })), [a.sourceId]);
  assert.deepEqual(ids(await list(O.owner, { search: "sentença" })), [c.sourceId], "busca sem diferenciar maiúsculas, no teor");
  assert.deepEqual(ids(await list(O.owner, { search: "0000002-22" })), [b.sourceId], "busca no nº do processo");
  assert.deepEqual(ids(await list(O.owner, { search: "trt18" })), [b.sourceId], "busca no tribunal");
  assert.deepEqual(ids(await list(O.owner, { order: "asc" })), [a.sourceId, b.sourceId, c.sourceId]);
  assert.deepEqual(ids(await list(O.owner, { archived: true })), [d.sourceId]);
  assert.deepEqual(ids(await list(O.owner, { archived: false })).length, 3);

  const p1 = await list(O.owner, { limit: 2, offset: 0 });
  const p2 = await list(O.owner, { limit: 2, offset: 2 });
  assert.deepEqual([p1.json.total, p2.json.total], [3, 3], "o total não depende da página");
  assert.deepEqual([...ids(p1), ...ids(p2)], [c.sourceId, b.sourceId, a.sourceId]);
  assert.deepEqual(ids(p2), [a.sourceId]);
});

test("a busca é literal: % e _ não são curingas e SQL injetado não surte efeito", async () => {
  const O = await newOffice("busca");
  await seedPub(O.orgId, { originalText: "texto simples" });
  const lit = await seedPub(O.orgId, { originalText: "reajuste de 100% no contrato" });
  await seedPub(O.orgId, { originalText: "a_b" });
  assert.deepEqual(ids(await list(O.owner, { search: "%" })), [lit.sourceId]);
  assert.equal((await list(O.owner, { search: "_" })).json.total, 1, "só o 'a_b' tem '_' literal");
  assert.equal((await list(O.owner, { search: "x'; drop table publications; --" })).json.total, 0);
  assert.equal((await list(O.owner)).json.total, 3, "a tabela continua intacta");
});

test("abas e contadores: N:N conta uma vez em 'todos', independem da aba, da página e do filtro de status", async () => {
  const O = await newOffice("abas");
  const a1 = await newAttorney(O, "Ana Souza", "111");
  const a2 = await newAttorney(O, "Bruno Lima", "222", "RJ");
  const a3 = await newAttorney(O, "Carla Inativa", "333", "SP", false); // inativa, sem publicações: sem aba
  const a4 = await newAttorney(O, "Dora Inativa", "444", "MG", false); // inativa, com publicações: mantém aba
  const p1 = await seedPub(O.orgId, { status: "a_revisar" }, [a1]);
  const p2 = await seedPub(O.orgId, { status: "em_analise" }, [a2]);
  const p3 = await seedPub(O.orgId, { status: "a_revisar" }, [a1, a2]); // uma linha, dois vínculos
  const p4 = await seedPub(O.orgId, { status: "concluida" }, [a4]);
  await seedPub(O.orgId, { status: "a_revisar", archivedAt: new Date() }, [a1]);
  void a3;

  const all = await list(O.owner);
  assert.equal(all.json.total, 4);
  assert.deepEqual(all.json.attorney_stats.map((a: any) => a.name), ["Ana Souza", "Bruno Lima", "Dora Inativa"]);
  assert.deepEqual(all.json.tab_stats, {
    todos: { total: 4, revisar: 2 },
    [a1]: { total: 2, revisar: 2 },
    [a2]: { total: 2, revisar: 1 },
    [a4]: { total: 1, revisar: 0 },
  });
  assert.deepEqual(all.json.attorney_stats.find((a: any) => a.id === a2), { id: a2, name: "Bruno Lima", oab_number: "222", uf: "RJ", total: 2, revisar: 1 });
  assert.deepEqual(all.json.stats, { total: 4, revisar: 2, analise: 1, concluida: 1 });

  const tab1 = await list(O.owner, { attorney: a1 });
  assert.deepEqual(ids(tab1).sort(), [p1.sourceId, p3.sourceId].sort());
  assert.deepEqual(tab1.json.stats, { total: 2, revisar: 2, analise: 0, concluida: 0 }, "cabeçalho acompanha a aba ativa");
  const tab2 = await list(O.owner, { attorney: a2 });
  assert.deepEqual(ids(tab2).sort(), [p2.sourceId, p3.sourceId].sort());
  assert.equal(ids(tab2).filter((x: string) => x === p3.sourceId).length, 1);

  // Independência: mesma contagem de abas com outra aba ativa, outra página e filtro de status.
  for (const f of [{ attorney: a1 }, { attorney: a2 }, { limit: 1, offset: 3 }, { status: "concluida" }, { attorney: a4, status: "em_analise" }])
    assert.deepEqual((await list(O.owner, f)).json.tab_stats, all.json.tab_stats, JSON.stringify(f));
  const onlyDone = await list(O.owner, { status: "concluida" });
  assert.deepEqual(ids(onlyDone), [p4.sourceId]);
  assert.equal(onlyDone.json.total, 1);
  assert.deepEqual(onlyDone.json.stats, all.json.stats, "stats ignora o filtro de status");

  // Os mesmos filtros (tribunal) valem para os contadores.
  await be.raw.update(schema.publications).set({ tribunal: "TRT18" }).where(eq(schema.publications.id, p2.id));
  const trt = await list(O.owner, { tribunal: "TRT18" });
  assert.deepEqual(trt.json.tab_stats.todos, { total: 1, revisar: 0 });
  assert.deepEqual(trt.json.tab_stats[a2], { total: 1, revisar: 0 });
  assert.deepEqual(trt.json.tab_stats[a1], { total: 0, revisar: 0 });

  // Arquivadas: universo próprio.
  const arq = await list(O.owner, { archived: true });
  assert.deepEqual(arq.json.tab_stats.todos, { total: 1, revisar: 1 });
  assert.deepEqual(arq.json.tab_stats[a1], { total: 1, revisar: 1 });
});

test("diagnóstico resumido: última execução, última com sucesso, próxima coleta e janelas pendentes (só OABs ativas)", async () => {
  const O = await newOffice("diag");
  const a1 = await newAttorney(O, "Ana Souza", "111");
  const a2 = await newAttorney(O, "Bruno Lima", "222", "RJ");
  const off = await newAttorney(O, "Carla Inativa", "333", "SP", false);
  await be.raw.insert(schema.syncCursors).values([
    { organizationId: O.orgId, attorneyId: a1, scanDay: "2026-10-17", targetDay: "2026-10-19", nextDueAt: new Date("2026-10-20T12:00:00Z") },
    { organizationId: O.orgId, attorneyId: a2, scanDay: "2026-10-19", targetDay: "2026-10-19", nextDueAt: new Date("2026-10-21T12:00:00Z") },
    { organizationId: O.orgId, attorneyId: off, scanDay: "2026-01-01", targetDay: "2026-10-19", nextDueAt: new Date("2026-01-02T12:00:00Z") },
  ]);
  await be.raw.insert(schema.syncRuns).values([
    { organizationId: O.orgId, attorneyId: a1, windowDay: "2026-10-18", status: "sucesso", startedAt: new Date("2026-10-19T12:00:00Z"), finishedAt: new Date("2026-10-19T12:00:05Z"), httpStatus: 200 },
    { organizationId: O.orgId, attorneyId: a1, windowDay: "2026-10-19", status: "erro", startedAt: new Date("2026-10-19T13:00:00Z"), finishedAt: new Date("2026-10-19T13:00:02Z"), httpStatus: 503, errorMessage: "Instabilidade" },
  ]);
  const r = (await list(O.owner)).json;
  assert.equal(r.pending_windows, 3 + 1, "a1: 3 dias; a2: 1 dia; inativa não conta");
  assert.equal(r.latest.status, "erro");
  assert.equal(r.latest.http_status, 503);
  assert.equal(r.latest.error_message, "Instabilidade");
  assert.equal(new Date(r.last_success).toISOString(), "2026-10-19T12:00:05.000Z");
  assert.equal(new Date(r.next_due).toISOString(), "2026-10-20T12:00:00.000Z", "a inativa não puxa a próxima coleta");
});

// ── Isolamento entre escritórios ──────────────────────────────────────────────

test("isolamento: outro escritório não lê, não altera, não arquiva, não descarta nem vê na prévia", async () => {
  const A = await newOffice("isoa");
  const B = await newOffice("isob");
  const pa = await seedPub(A.orgId, { sourceId: "777001", notes: "segredo de A" });
  await seedPub(A.orgId, { sourceId: "777002", archivedAt: new Date() });
  // B tem comunicação com o MESMO ID oficial: são linhas distintas.
  await seedPub(B.orgId, { sourceId: "777001", originalText: "de B" });

  const lb = await list(B.owner);
  assert.deepEqual(lb.json.rows.map((r: any) => [r.source_id, r.original_text]), [["777001", "de B"]]);
  assert.ok(!JSON.stringify(lb.json).includes("segredo de A"));

  assert.equal((await list(A.owner)).json.rows.find((r: any) => r.source_id === "777001").notes, "segredo de A");
  assert.equal((await mutate(B.owner, "status", ["777002"], { p_status: "concluida" })).json, 0, "id só existe em A");
  assert.equal((await mutate(B.owner, "restore", ["777002"])).json, 0);
  assert.equal((await mutate(B.owner, "remove", ["777002"])).json, 0);
  assert.equal((await dbRow(A.orgId, "777002")).removedAt, null);

  // Mutação de B no id compartilhado afeta só B.
  assert.equal((await mutate(B.owner, "archive", ["777001"])).json, 1);
  assert.equal((await dbRow(A.orgId, "777001")).archivedAt, null);
  assert.notEqual((await dbRow(B.orgId, "777001")).archivedAt, null);

  const prev = await B.owner.v1("djen_archive_preview", { p_date: "2030-01-01" });
  assert.equal(prev.json.count, 0);
  assert.equal((await A.owner.v1("djen_archive_preview", { p_date: "2030-01-01" })).json.count, 1);
  void pa;
});

test("o cliente não escolhe o escritório: organization_id no corpo e no filtro é ignorado", async () => {
  const A = await newOffice("cliA");
  const B = await newOffice("cliB");
  await seedPub(A.orgId, { sourceId: "888001" });
  const r = await B.owner.v1("djen_list", { organization_id: A.orgId, organizationId: A.orgId, p_filter: { organization_id: A.orgId } });
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 0);
  const m = await B.owner.v1("djen_mutate", { organization_id: A.orgId, p_action: "archive", p_ids: ["888001"] });
  assert.equal(m.json, 0);
});

// ── Mutações ──────────────────────────────────────────────────────────────────

test("status/anotação: grava, preserva o que não foi enviado e limpa com texto vazio", async () => {
  const O = await newOffice("status");
  const p = await seedPub(O.orgId);
  const r = await mutate(O.owner, "status", [p.sourceId], { p_status: "em_analise", p_notes: "  ligar ao cliente ", p_providence: "Protocolar recurso" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json, 1);
  let row = await dbRow(O.orgId, p.sourceId);
  assert.deepEqual([row.status, row.notes, row.actionNote, row.updatedBy], ["em_analise", "ligar ao cliente", "Protocolar recurso", O.userId]);
  assert.ok(row.originalText && row.rawPayload, "o conteúdo não é tocado");

  await mutate(O.owner, "status", [p.sourceId], { p_status: "concluida" });
  row = await dbRow(O.orgId, p.sourceId);
  assert.deepEqual([row.status, row.notes, row.actionNote], ["concluida", "ligar ao cliente", "Protocolar recurso"], "ausente = não altera");

  await mutate(O.owner, "status", [p.sourceId], { p_notes: "", p_providence: "   " });
  row = await dbRow(O.orgId, p.sourceId);
  assert.deepEqual([row.status, row.notes, row.actionNote], ["concluida", null, null], "vazio limpa");

  const listed = (await list(O.owner)).json.rows[0];
  assert.deepEqual([listed.status, listed.notes, listed.action_note], ["concluida", null, null]);
  // anotar publicação arquivada é permitido
  await mutate(O.owner, "archive", [p.sourceId]);
  assert.equal((await mutate(O.owner, "status", [p.sourceId], { p_notes: "pós-arquivo" })).json, 1);
});

test("arquivar e restaurar: 1 na primeira vez, 0 se já estava no estado; preserva teor, notas e vínculos", async () => {
  const O = await newOffice("arq");
  const a1 = await newAttorney(O, "Ana Souza", "111");
  const p = await seedPub(O.orgId, { notes: "importante" }, [a1]);
  assert.equal((await mutate(O.owner, "restore", [p.sourceId])).json, 0, "restaurar ativa não faz nada");
  assert.equal((await mutate(O.owner, "archive", [p.sourceId])).json, 1);
  assert.equal((await mutate(O.owner, "archive", [p.sourceId])).json, 0, "já arquivada");
  assert.equal((await list(O.owner)).json.total, 0);
  const arq = await list(O.owner, { archived: true });
  assert.deepEqual(ids(arq), [p.sourceId]);
  assert.equal(arq.json.rows[0].notes, "importante");
  assert.equal(arq.json.rows[0].attorneys.length, 1);
  assert.notEqual(arq.json.rows[0].archived_at, null);
  assert.equal((await mutate(O.owner, "restore", [p.sourceId])).json, 1);
  assert.equal((await list(O.owner)).json.total, 1);
  assert.equal((await list(O.owner, { archived: true })).json.total, 0);
  assert.equal((await dbRow(O.orgId, p.sourceId)).notes, "importante");
});

test("descartar: só arquivada; apaga conteúdo e vínculos; some de tudo; irreversível; reimportar não traz de volta", async () => {
  const O = await newOffice("desc");
  const a1 = await newAttorney(O, "Ana Souza", "111");
  const p = await seedPub(O.orgId, { notes: "sigilo", sourceUrl: "https://x.test/a", recipients: [{ nome: "FULANO" }] }, [a1]);
  const keep = await seedPub(O.orgId, {}, [a1]);

  assert.equal((await mutate(O.owner, "remove", [p.sourceId])).json, 0, "ativa não pode ser descartada");
  await mutate(O.owner, "archive", [p.sourceId]);
  assert.equal((await mutate(O.owner, "remove", [p.sourceId])).json, 1);

  const row = await dbRow(O.orgId, p.sourceId);
  assert.notEqual(row.removedAt, null);
  for (const k of ["originalText", "rawPayload", "recipients", "processNumber", "processMask", "notes", "actionNote", "sourceUrl"] as const)
    assert.equal(row[k], null, `${k} deveria estar apagado`);
  assert.equal((await be.raw.select().from(schema.publicationAttorneys).where(eq(schema.publicationAttorneys.publicationId, p.id))).length, 0, "vínculos apagados");
  assert.equal((await be.raw.select().from(schema.publicationAttorneys).where(eq(schema.publicationAttorneys.publicationId, keep.id))).length, 1, "só os do descartado");

  // Não aparece em lista, arquivadas, abas, tribunais nem na prévia.
  for (const f of [{}, { archived: true }]) {
    const r = await list(O.owner, f);
    assert.ok(!ids(r).includes(p.sourceId), JSON.stringify(f));
  }
  assert.deepEqual((await list(O.owner, { archived: true })).json.tab_stats.todos, { total: 0, revisar: 0 });
  assert.deepEqual((await list(O.owner)).json.tab_stats.todos, { total: 1, revisar: 1 });
  assert.equal((await O.owner.v1("djen_archive_preview", { p_date: "2030-01-01" })).json.count, 1);

  // Irreversível por qualquer operação.
  for (const [a, extra] of [["restore", {}], ["archive", {}], ["remove", {}], ["status", { p_status: "concluida", p_notes: "volta" }]] as const)
    assert.equal((await mutate(O.owner, a, [p.sourceId], extra)).json, 0, a);
  assert.notEqual((await dbRow(O.orgId, p.sourceId)).removedAt, null);

  // Reimportar (mesmo caminho do coletor: ON CONFLICT DO NOTHING) insere 0 linhas.
  const re = await be.raw
    .insert(schema.publications)
    .values({ organizationId: O.orgId, sourceId: p.sourceId, originalText: "VOLTOU", availableOn: "2026-10-19" })
    .onConflictDoNothing({ target: [schema.publications.organizationId, schema.publications.sourceId] })
    .returning();
  assert.equal(re.length, 0);
  assert.equal((await dbRow(O.orgId, p.sourceId)).originalText, null);
});

test("lote com vários IDs: afeta só os existentes e elegíveis; IDs repetidos contam uma vez; vazio devolve 0", async () => {
  const O = await newOffice("lote");
  const p1 = await seedPub(O.orgId);
  const p2 = await seedPub(O.orgId);
  const p3 = await seedPub(O.orgId, { archivedAt: new Date() });
  const r = await mutate(O.owner, "archive", [p1.sourceId, p1.sourceId, p2.sourceId, p3.sourceId, "999999999"]);
  assert.equal(r.json, 2, "p3 já arquivada e o ID inexistente não contam");
  assert.equal((await mutate(O.owner, "archive", [])).json, 0);
});

test("prévia e arquivamento em lote: só ativas até a data (inclusive), ordem numérica, exatamente os IDs da prévia", async () => {
  const O = await newOffice("previa");
  const mk = (sourceId: string, availableOn: string, over: Record<string, unknown> = {}) => seedPub(O.orgId, { sourceId, availableOn, ...over });
  await mk("20", "2026-10-01");
  await mk("3", "2026-10-02", { processNumber: null, tribunal: "TRT18" });
  await mk("100", "2026-10-03");
  await mk("5", "2026-10-04"); // depois do corte
  await mk("7", "2026-10-01", { archivedAt: new Date() }); // já arquivada
  await mk("8", "2026-10-01", { archivedAt: new Date(), removedAt: new Date(), originalText: null, rawPayload: null, recipients: null, processNumber: null, processMask: null, notes: null, actionNote: null, sourceUrl: null }); // descartada

  const prev = await O.owner.v1("djen_archive_preview", { p_date: "2026-10-03" });
  assert.equal(prev.status, 200, prev.text);
  assert.equal(prev.json.count, 3);
  assert.deepEqual(prev.json.rows.map((r: any) => r.source_id), ["3", "20", "100"], "ordem numérica, não alfabética");
  assert.deepEqual(prev.json.rows[0], { source_id: "3", process_number: null, tribunal: "TRT18" });

  // Confirmar com os IDs da prévia arquiva exatamente esses, ignorando filtros da lista.
  const n = await mutate(O.owner, "archive", prev.json.rows.map((r: any) => r.source_id));
  assert.equal(n.json, 3);
  assert.deepEqual(ids(await list(O.owner)), ["5"]);
  assert.equal((await O.owner.v1("djen_archive_preview", { p_date: "2026-10-03" })).json.count, 0);
});

test("prévia grande: conta exatamente, devolve no máximo 1.000 linhas; lote acima de 1.000 é recusado", async () => {
  const O = await newOffice("grande");
  const rows = Array.from({ length: 1005 }, (_, i) => ({
    organizationId: O.orgId,
    sourceId: String(500000 + i),
    originalText: "x",
    availableOn: "2026-09-01",
  }));
  await be.raw.insert(schema.publications).values(rows);
  const prev = await O.owner.v1("djen_archive_preview", { p_date: "2026-09-30" });
  assert.equal(prev.json.count, 1005);
  assert.equal(prev.json.rows.length, 1000);
  assert.equal(prev.json.rows[0].source_id, "500000");
  assert.equal(prev.json.rows[999].source_id, "500999");
  const over = await mutate(O.owner, "archive", Array.from({ length: 1001 }, (_, i) => String(500000 + i)));
  assert.equal(over.status, 400);
  assert.equal((await mutate(O.owner, "archive", prev.json.rows.map((r: any) => r.source_id))).json, 1000);
  assert.equal((await O.owner.v1("djen_archive_preview", { p_date: "2026-09-30" })).json.count, 5);
});

// ── Auditoria ─────────────────────────────────────────────────────────────────

test("auditoria: cada escrita registra o autor e o que mudou, sem teor nem anotações; sem evento quando nada mudou", async () => {
  const O = await newOffice("audit");
  const member = await addMember(O, "member");
  const p = await seedPub(O.orgId, { originalText: "TEOR CONFIDENCIAL" });
  await mutate(member, "status", [p.sourceId], { p_status: "em_analise", p_notes: "ANOTAÇÃO SECRETA" });
  await mutate(member, "archive", [p.sourceId]);
  await mutate(member, "archive", [p.sourceId]); // 0 afetadas: sem evento
  await mutate(O.owner, "restore", [p.sourceId]);
  await mutate(O.owner, "archive", [p.sourceId]);
  await mutate(O.owner, "remove", [p.sourceId]);

  const ev = (await O.owner.v1("audit_list")).json.eventos.filter((e: any) => e.acao.startsWith("publication."));
  assert.deepEqual(ev.map((e: any) => e.acao).sort(), ["publication.archived", "publication.archived", "publication.discarded", "publication.restored", "publication.reviewed"]);
  const reviewed = ev.find((e: any) => e.acao === "publication.reviewed");
  assert.equal(reviewed.detalhes.count, 1);
  assert.deepEqual(reviewed.detalhes.source_ids, [p.sourceId]);
  assert.deepEqual(reviewed.detalhes.fields, ["status", "notes"]);
  assert.equal(reviewed.detalhes.status, "em_analise");
  const memberId = (await be.raw.select().from(schema.user).where(eq(schema.user.email, (await be.raw.select().from(schema.user).where(sql`id = ${reviewed.autor_id}`))[0].email)))[0].id;
  assert.equal(reviewed.autor_id, memberId);
  assert.notEqual(reviewed.autor_id, O.userId, "autoria é de quem agiu");
  assert.ok(ev.every((e: any) => e.autor_id));
  const dump = JSON.stringify(ev);
  assert.ok(!dump.includes("ANOTAÇÃO SECRETA") && !dump.includes("TEOR CONFIDENCIAL"), "auditoria não vaza conteúdo");
});

// ── Validação de entrada ──────────────────────────────────────────────────────

test("entradas inválidas são recusadas com 400 (nada chega ao banco)", async () => {
  const O = await newOffice("valida");
  const p = await seedPub(O.orgId);
  const bad = async (op: string, body: unknown) => {
    const r = await O.owner.v1(op, body);
    assert.equal(r.status, 400, `${op} ${JSON.stringify(body).slice(0, 80)} → ${r.status} ${r.text}`);
    assert.ok(typeof r.json?.erro === "string");
  };
  for (const f of [
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "20" }, { offset: -1 }, { offset: 1e9 },
    { start: "2026-02-31" }, { start: "19/10/2026" }, { end: "x" }, { start: "2026-10-20", end: "2026-10-19" },
    { attorney: "xyz" }, { attorney: "interesse" }, { attorney: 5 },
    { status: "inventado" }, { status: 3 }, { order: "sideways" }, { archived: "sim" },
    { search: "x".repeat(201) }, { search: "tem\u0000nulo" }, { tribunal: "x".repeat(41) }, { search: { $ne: 1 } },
  ])
    await bad("djen_list", { p_filter: f });
  await bad("djen_list", { p_filter: "texto" });
  await bad("djen_list", { p_filter: [] });

  for (const b of [
    { p_action: "apagar", p_ids: [p.sourceId] },
    { p_action: "archive" },
    { p_action: "archive", p_ids: p.sourceId },
    { p_action: "archive", p_ids: ["abc"] },
    { p_action: "archive", p_ids: ["0123"] },
    { p_action: "archive", p_ids: ["1 or 1=1"] },
    { p_action: "archive", p_ids: [null] },
    { p_action: "archive", p_ids: [{}] },
    { p_action: "archive", p_ids: ["1234567890123456789"] },
    { p_action: "status", p_ids: [p.sourceId] },
    { p_action: "status", p_ids: [p.sourceId], p_status: "inventado" },
    { p_action: "status", p_ids: [p.sourceId], p_notes: "x".repeat(20001) },
    { p_action: "status", p_ids: [p.sourceId], p_providence: "x".repeat(2001) },
    { p_action: "status", p_ids: [p.sourceId], p_notes: 5 },
    { p_action: "status", p_ids: [p.sourceId], p_notes: "ctrl\u0001" },
  ])
    await bad("djen_mutate", b);

  for (const b of [{}, { p_date: "2026-02-31" }, { p_date: 20261019 }, { p_date: "1999-01-01" }, { p_date: "2026-10-19T00:00:00" }])
    await bad("djen_archive_preview", b);

  // Nada foi alterado pelas tentativas inválidas.
  const row = await dbRow(O.orgId, p.sourceId);
  assert.deepEqual([row.status, row.notes, row.archivedAt, row.removedAt], ["a_revisar", null, null, null]);
});

test("IDs podem vir como número (a interface os trata como número) e a resposta de mutação é um número JSON", async () => {
  const O = await newOffice("num");
  const p = await seedPub(O.orgId, { sourceId: "123456789" });
  const r = await O.owner.v1("djen_mutate", { p_action: "archive", p_ids: [123456789] });
  assert.equal(r.status, 200);
  assert.equal(r.json, 1);
  assert.equal(typeof r.json, "number");
  assert.equal((await dbRow(O.orgId, p.sourceId)).archivedAt !== null, true);
});
