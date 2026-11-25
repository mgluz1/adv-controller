import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as schema from "../../src/server/db/schema.ts";
import { createCollector } from "../../src/server/collector/collector.ts";
import { SourceError, type DayResult } from "../../src/server/djen/client.ts";
import { Client, email, startBackend, type Backend } from "./helpers.ts";

// djen_diagnostics (tarefa 1.6): contrato do painel (latest, last_success, next_due, pending_windows, runs[20], source_check)
// e extras de suporte (cursors, collector). Sem inventar dados: sem execuções, tudo nulo/zero.
let be: Backend;
let enabled = false;
before(async () => {
  be = await startBackend({}, { scheduler: { get enabled() { return enabled; }, wake: () => {} } });
});
after(() => be.close());

let seq = 0;
async function newOffice(label: string) {
  const owner = be.client();
  await owner.signUp(email(label), `Dono ${label}`);
  const org = await owner.createOffice(`Escritório ${label}`, `${label}-${++seq}-${Date.now()}`);
  return { owner, orgId: org.id as string };
}
async function addViewer(o: { owner: Client; orgId: string }) {
  const e = email("viewer");
  const inv = await o.owner.auth("/organization/invite-member", { email: e, role: "viewer", organizationId: o.orgId });
  const c = be.client();
  await c.signUp(e, "Leitor");
  assert.equal((await c.auth("/organization/accept-invitation", { invitationId: inv.json.id })).status, 200);
  return c;
}
const newOab = async (o: { owner: Client }, name: string, n: string, uf = "GO", active = true) => {
  const id = (await o.owner.v1("oab_create", { name, oab_number: n, uf })).json.oab.id as string;
  if (!active) await o.owner.v1("oab_update", { id, active: false });
  return id;
};
const diag = (c: Client) => c.v1("djen_diagnostics", {});
const at = (iso: string) => new Date(iso);

test("anônimo 401; qualquer papel (inclusive leitor) pode ler", async () => {
  const O = await newOffice("perm");
  assert.equal((await diag(be.client())).status, 401);
  assert.equal((await diag(O.owner)).status, 200);
  assert.equal((await diag(await addViewer(O))).status, 200);
});

test("escritório sem coleta: nada é inventado (nulos, zero, listas vazias)", async () => {
  const O = await newOffice("vazio");
  enabled = false;
  const r = (await diag(O.owner)).json;
  assert.deepEqual(
    { latest: r.latest, last_success: r.last_success, next_due: r.next_due, pending_windows: r.pending_windows, runs: r.runs, source_check: r.source_check, cursors: r.cursors, collector: r.collector },
    { latest: null, last_success: null, next_due: null, pending_windows: 0, runs: [], source_check: null, cursors: [], collector: { enabled: false } },
  );
  enabled = true;
  assert.deepEqual((await diag(O.owner)).json.collector, { enabled: true });
  enabled = false;
});

test("execuções: campos do contrato do painel, mais recentes primeiro, no máximo 20", async () => {
  const O = await newOffice("runs");
  const a = await newOab(O, "Advogada A", "111");
  const base = Date.parse("2026-10-19T12:00:00Z");
  await be.raw.insert(schema.syncRuns).values(
    Array.from({ length: 25 }, (_, i) => ({
      organizationId: O.orgId, attorneyId: a, windowDay: `2026-09-${String(i + 1).padStart(2, "0")}`,
      status: i % 5 === 4 ? "erro" : "sucesso", startedAt: new Date(base + i * 60_000), finishedAt: new Date(base + i * 60_000 + 3000),
      httpStatus: i % 5 === 4 ? 503 : 200, pages: 1, itemsFound: i, itemsInserted: i % 3, errorKind: i % 5 === 4 ? "SERVER_ERROR" : null, errorMessage: i % 5 === 4 ? "Instabilidade" : null,
    })),
  );
  const r = (await diag(O.owner)).json;
  assert.equal(r.runs.length, 20);
  assert.equal(r.runs[0].start_day, "2026-09-25", "a mais recente primeiro");
  assert.equal(r.runs[19].start_day, "2026-09-06");
  for (const k of ["id", "attorney_id", "start_day", "status", "started_at", "finished_at", "http_status", "fetched_count", "inserted_count", "error_message", "pages", "error_kind", "trigger"])
    assert.ok(k in r.runs[0], `campo ausente: ${k}`);
  const err = r.runs.find((x: any) => x.start_day === "2026-09-25");
  assert.deepEqual([err.status, err.http_status, err.error_kind, err.error_message, err.fetched_count, err.inserted_count], ["erro", 503, "SERVER_ERROR", "Instabilidade", 24, 0]);
  assert.equal(r.latest.window_day, "2026-09-25");
  assert.equal(r.latest.status, "erro");
});

test("resumo: última com sucesso, próxima execução e janelas pendentes consideram só OABs ativas — e batem com a listagem", async () => {
  const O = await newOffice("resumo");
  const a1 = await newOab(O, "Advogada A", "111");
  const a2 = await newOab(O, "Advogado B", "222", "RJ");
  const off = await newOab(O, "Advogada Inativa", "333", "SP", false);
  await be.raw.insert(schema.syncCursors).values([
    { organizationId: O.orgId, attorneyId: a1, scanDay: "2026-10-17", targetDay: "2026-10-19", nextDueAt: at("2026-10-20T12:00:00Z") },
    { organizationId: O.orgId, attorneyId: a2, scanDay: "2026-10-19", targetDay: "2026-10-19", nextDueAt: at("2026-10-21T12:00:00Z") },
    { organizationId: O.orgId, attorneyId: off, scanDay: "2026-01-01", targetDay: "2026-10-19", nextDueAt: at("2026-01-02T12:00:00Z") },
  ]);
  await be.raw.insert(schema.syncRuns).values([
    { organizationId: O.orgId, attorneyId: a1, windowDay: "2026-10-18", status: "sucesso", startedAt: at("2026-10-19T12:00:00Z"), finishedAt: at("2026-10-19T12:00:05Z"), httpStatus: 200 },
    { organizationId: O.orgId, attorneyId: a1, windowDay: "2026-10-19", status: "erro", startedAt: at("2026-10-19T13:00:00Z"), finishedAt: at("2026-10-19T13:00:02Z"), httpStatus: 503, errorMessage: "x" },
  ]);
  const d = (await diag(O.owner)).json;
  const l = (await O.owner.v1("djen_list", { p_filter: {} })).json;
  assert.equal(d.pending_windows, 4);
  assert.equal(new Date(d.last_success).toISOString(), "2026-10-19T12:00:05.000Z");
  assert.equal(new Date(d.next_due).toISOString(), "2026-10-20T12:00:00.000Z");
  for (const k of ["latest", "last_success", "next_due", "pending_windows"]) assert.deepEqual(d[k], l[k], `${k} igual na listagem e no diagnóstico`);
});

test("estado da fonte: vem da execução mais recente que OBTEVE resposta; uma janela em andamento não conta", async () => {
  const O = await newOffice("fonte");
  const a = await newOab(O, "Advogada A", "111");
  assert.equal((await diag(O.owner)).json.source_check, null);
  await be.raw.insert(schema.syncRuns).values({ organizationId: O.orgId, attorneyId: a, windowDay: "2026-10-18", status: "sucesso", startedAt: at("2026-10-19T12:00:00Z"), finishedAt: at("2026-10-19T12:00:04Z"), httpStatus: 200 });
  let sc = (await diag(O.owner)).json.source_check;
  assert.deepEqual([sc.http_status, sc.filter_verified, sc.error_kind, sc.message], [200, true, null, null]);
  assert.equal(new Date(sc.checked_at).toISOString(), "2026-10-19T12:00:04.000Z");

  // uma janela em andamento (sem HTTP ainda) não substitui o último estado conhecido
  await be.raw.insert(schema.syncRuns).values({ organizationId: O.orgId, attorneyId: a, windowDay: "2026-10-19", status: "executando", startedAt: at("2026-10-19T12:10:00Z") });
  sc = (await diag(O.owner)).json.source_check;
  assert.equal(sc.http_status, 200);

  await be.raw.insert(schema.syncRuns).values({ organizationId: O.orgId, attorneyId: a, windowDay: "2026-10-19", status: "erro", startedAt: at("2026-10-19T12:20:00Z"), finishedAt: at("2026-10-19T12:20:01Z"), httpStatus: 403, errorKind: "GEOBLOCK_CLOUDFRONT", errorMessage: "Bloqueio geográfico" });
  sc = (await diag(O.owner)).json.source_check;
  assert.deepEqual([sc.http_status, sc.filter_verified, sc.error_kind, sc.message], [403, false, "GEOBLOCK_CLOUDFRONT", "Bloqueio geográfico"]);
});

test("estado por OAB: todas aparecem (mesmo sem cursor), ordem por nome, datas como AAAA-MM-DD, falhas e lease", async () => {
  const O = await newOffice("cursor");
  const bruno = await newOab(O, "Bruno Lima", "222", "RJ");
  const ana = await newOab(O, "Ana Souza", "111");
  const inativa = await newOab(O, "Carla Inativa", "333", "SP", false);
  await be.raw.insert(schema.syncCursors).values([
    { organizationId: O.orgId, attorneyId: ana, scanDay: "2026-10-18", targetDay: "2026-10-19", lastCompleteDay: "2026-10-17", nextDueAt: at("2026-10-19T12:00:00Z"), consecutiveFailures: 2, lastError: "Instabilidade" },
    { organizationId: O.orgId, attorneyId: bruno, nextDueAt: at("2026-10-19T12:00:00Z"), leaseId: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 5 * 60_000) },
  ]);
  const c = (await diag(O.owner)).json.cursors;
  assert.deepEqual(c.map((x: any) => x.name), ["Ana Souza", "Bruno Lima", "Carla Inativa"]);
  const [a, b, i] = c;
  assert.deepEqual([a.scan_day, a.target_day, a.last_complete_day, a.consecutive_failures, a.last_error, a.leased, a.active], ["2026-10-18", "2026-10-19", "2026-10-17", 2, "Instabilidade", false, true]);
  assert.equal(b.leased, true);
  assert.deepEqual([i.active, i.scan_day, i.next_due_at, i.consecutive_failures], [false, null, null, null], "OAB sem cursor aparece com campos nulos");
  assert.ok(c.every((x: any) => x.attorney_id && x.oab_number && x.uf));
  void inativa;
});

test("isolamento: o diagnóstico de um escritório não mostra execuções nem OABs de outro", async () => {
  const A = await newOffice("iso-a");
  const B = await newOffice("iso-b");
  const a = await newOab(A, "Advogada Secreta", "777");
  await be.raw.insert(schema.syncRuns).values({ organizationId: A.orgId, attorneyId: a, windowDay: "2026-10-19", status: "erro", startedAt: new Date(), httpStatus: 500, errorMessage: "SEGREDO DE A" });
  const d = (await diag(B.owner)).json;
  assert.ok(!JSON.stringify(d).includes("SEGREDO DE A") && !JSON.stringify(d).includes("Secreta"));
  assert.deepEqual([d.runs.length, d.cursors.length, d.latest, d.source_check], [0, 0, null, null]);
  const body = (await B.owner.v1("djen_diagnostics", { organization_id: A.orgId, organizationId: A.orgId })).json;
  assert.equal(body.runs.length, 0, "organization_id no corpo é ignorado");
});

test("ponta a ponta com o coletor real: sucesso, falha e janelas pendentes aparecem no diagnóstico", async () => {
  const O = await newOffice("e2e");
  await newOab(O, "Advogada A", "111");
  let sick = false;
  const collect = async (_a: { oab_number: string; uf: string }, day: string): Promise<DayResult> => {
    if (sick) throw new SourceError("Instabilidade", 503, "SERVER_ERROR");
    return { count: 1, items: [{ id: Number(day.replaceAll("-", "")), texto: "x" } as any], status: 200, pages: 1 };
  };
  const c = createCollector({ db: be.db, collect, log: () => {}, organizationIds: async () => [O.orgId] });
  assert.equal((await c.collectNext()).status, "success");
  assert.equal((await c.collectNext()).status, "success");
  sick = true;
  assert.equal((await c.collectNext()).status, "failed");

  const d = (await diag(O.owner)).json;
  assert.equal(d.runs.length, 3);
  assert.deepEqual(d.runs.map((r: any) => r.status), ["erro", "sucesso", "sucesso"]);
  assert.deepEqual([d.runs[0].http_status, d.runs[0].error_kind], [503, "SERVER_ERROR"]);
  assert.deepEqual([d.runs[2].fetched_count, d.runs[2].inserted_count], [1, 1]);
  assert.equal(d.pending_windows, 28, "30 janelas no ciclo, 2 concluídas");
  assert.deepEqual([d.source_check.http_status, d.source_check.filter_verified], [503, false]);
  assert.ok(d.last_success);
  assert.equal(d.cursors[0].consecutive_failures, 1);
  assert.equal(d.cursors[0].last_error, "Instabilidade");
  assert.ok(d.next_due, "há recuo agendado");
});
