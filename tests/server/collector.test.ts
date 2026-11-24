import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { claimWindow, commitWindow, createCollector, failWindow, StaleLeaseError, type Outcome } from "../../src/server/collector/collector.ts";
import { addDays } from "../../src/server/collector/schedule.ts";
import { SourceError, type DayResult, type DjenItem } from "../../src/server/djen/client.ts";
import { createTestDb } from "./helpers.ts";

// Coletor (tarefa 1.4) contra Postgres real (PGlite com as migrações versionadas).
// Porta os cenários de tests/a-migrar/sql-supabase/database-rollback.sql: lease, fencing, deduplicação, N:N,
// arquivar/descartar, atomicidade, isolamento. O DJEN é simulado por `collect`; nada toca a rede.
let t: Awaited<ReturnType<typeof createTestDb>>;
before(async () => {
  t = await createTestDb();
});
after(() => t.client.close());

let seq = 0;
const mkOrg = async (label = "o") => {
  const id = `org-${label}-${++seq}`;
  await t.raw.insert(schema.organization).values({ id, name: id, slug: id, createdAt: new Date() });
  return id;
};
const mkAtt = async (org: string, n: string, uf = "GO", active = true) =>
  (await t.raw.insert(schema.attorneys).values({ organizationId: org, name: `Advogado ${n}`, oabNumber: n, uf, active }).returning())[0].id;

const T0 = new Date("2026-10-19T15:00:00Z"); // 12:00 em Brasília; "hoje" = 2026-10-19
let clock = T0;
const now = () => clock;
const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));
beforeEach(() => void (clock = T0));

type Plan = Record<string, DjenItem[] | Error>;
/** DJEN simulado: responde por dia; `calls` registra (oab, dia). */
function fakeDjen(plan: Plan | ((oab: string, day: string) => DjenItem[] | Error) = {}) {
  const calls: { oab: string; uf: string; day: string }[] = [];
  const collect = async (a: { oab_number: string; uf: string }, day: string): Promise<DayResult> => {
    calls.push({ oab: a.oab_number, uf: a.uf, day });
    const r = typeof plan === "function" ? plan(a.oab_number, day) : (plan[day] ?? []);
    if (r instanceof Error) throw r;
    return { count: r.length, items: r, status: 200, pages: 1 };
  };
  return { collect, calls };
}
const it = (id: number, over: Record<string, unknown> = {}): DjenItem => ({ id, texto: `Teor ${id}`, siglaTribunal: "TJGO", numero_processo: `000${id}`, ...over }) as DjenItem;
/** Os testes compartilham um banco: cada coletor é restrito aos escritórios do próprio teste (o padrão atende todos). */
const collector = (collect: ReturnType<typeof fakeDjen>["collect"], orgs: string | string[], extra: Record<string, unknown> = {}) =>
  createCollector({ db: t.db, collect, now, log: () => {}, organizationIds: async () => (Array.isArray(orgs) ? orgs : [orgs]), ...extra } as any);
const cursor = async (att: string) => (await t.raw.select().from(schema.syncCursors).where(eq(schema.syncCursors.attorneyId, att)))[0];
const runs = (att: string) => t.raw.select().from(schema.syncRuns).where(eq(schema.syncRuns.attorneyId, att)).orderBy(schema.syncRuns.startedAt, schema.syncRuns.windowDay);
const pubs = async (org: string) => t.raw.select().from(schema.publications).where(eq(schema.publications.organizationId, org));
const links = async (org: string) => t.raw.select().from(schema.publicationAttorneys).where(eq(schema.publicationAttorneys.organizationId, org));
/** Roda o coletor até ficar ocioso (cada janela 4 s depois da anterior, como fará o agendador). */
async function drain(c: ReturnType<typeof collector>, max = 400) {
  const out: Outcome[] = [];
  for (let i = 0; i < max; i++) {
    const o = await c.collectNext();
    if (o.status === "idle") return out;
    out.push(o);
    advance(4_000);
  }
  throw new Error("o coletor não ficou ocioso");
}
/** Refaz uma janela já concluída (como um retry/reinício na mesma data). */
const rewind = (att: string, day: string) =>
  t.client.exec(`update sync_cursors set scan_day='${day}', target_day='${day}', next_due_at=null, lease_id=null, lease_until=null where attorney_id='${att}'`);

// ── Ciclo de coleta e recuperação de lacunas ──────────────────────────────────

test("primeira carga: 30 dias, um por vez, do mais antigo ao mais novo; depois fica ocioso até as 09:00 de Brasília", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "111");
  const d = fakeDjen();
  const out = await drain(collector(d.collect, org));
  assert.equal(out.length, 30);
  assert.ok(out.every((o) => o.status === "success"));
  assert.deepEqual(d.calls.map((c) => c.day), Array.from({ length: 30 }, (_, i) => addDays("2026-10-19", i - 29)));
  assert.deepEqual([d.calls[0].oab, d.calls[0].uf], ["111", "GO"]);
  const c = await cursor(att);
  assert.deepEqual([c.lastCompleteDay, c.scanDay, c.targetDay, c.lastReconciledOn], ["2026-10-19", "2026-10-20", "2026-10-19", "2026-10-19"]);
  assert.equal(c.leaseId, null);
  assert.equal(c.consecutiveFailures, 0);
  assert.equal(c.nextDueAt!.toISOString(), "2026-10-20T12:00:00.000Z");
  const r = await runs(att);
  assert.equal(r.length, 30);
  assert.ok(r.every((x) => x.status === "sucesso" && x.httpStatus === 200 && x.finishedAt));
  assert.equal((await collector(d.collect, org).collectNext()).status, "idle", "nada vencido: ocioso");
});

test("dia seguinte: relê os 7 dias anteriores (sobreposição) e avança até hoje", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "112");
  const d = fakeDjen();
  await drain(collector(d.collect, org));
  d.calls.length = 0;
  clock = new Date("2026-10-20T12:00:00Z"); // venceu a coleta diária
  await drain(collector(d.collect, org));
  // 7 dias já coletados (13 a 19/10, sobreposição) + o dia novo (20/10)
  assert.deepEqual(d.calls.map((c) => c.day), ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]);
  void att;
});

test("reconciliação: a cada 7 dias relê 30 dias", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "113");
  const d = fakeDjen();
  await drain(collector(d.collect, org));
  d.calls.length = 0;
  clock = new Date("2026-10-26T12:00:00Z"); // 7 dias depois da última reconciliação (19/10)
  await drain(collector(d.collect, org));
  assert.equal(d.calls.length, 30);
  assert.equal(d.calls[0].day, "2026-09-27");
  assert.equal(d.calls[29].day, "2026-10-26");
  assert.equal((await cursor(att)).lastReconciledOn, "2026-10-26");
});

test("lacuna: parado por 40 dias, o recuo parte da última janela concluída e cobre todo o buraco", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "114");
  const d = fakeDjen();
  await drain(collector(d.collect, org));
  d.calls.length = 0;
  clock = new Date("2026-11-28T12:00:00Z"); // 40 dias depois
  await drain(collector(d.collect, org));
  const days = d.calls.map((c) => c.day);
  assert.equal(days[0], "2026-10-13", "última concluída (19/10) − 6");
  assert.equal(days.at(-1), "2026-11-28");
  assert.equal(new Set(days).size, days.length);
  // nenhum dia entre a última concluída e hoje ficou de fora
  for (let x = "2026-10-13"; x <= "2026-11-28"; x = addDays(x, 1)) assert.ok(days.includes(x), `faltou ${x}`);
  assert.equal((await cursor(att)).lastCompleteDay, "2026-11-28");
});

test("lacuna muito longa: respeita o teto de retroação de 180 dias", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "115");
  await t.raw.insert(schema.syncCursors).values({ organizationId: org, attorneyId: att, lastCompleteDay: "2025-01-01", lastReconciledOn: "2025-01-01" });
  const claim = await claimWindow(t.db, org, now());
  assert.equal(claim!.day, addDays("2026-10-19", -179));
  assert.equal(claim!.target, "2026-10-19");
});

test("uma falha no meio do ciclo retoma do dia que falhou (nunca pula nem recomeça)", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "116");
  let failOnce = true;
  const d = fakeDjen((_o, day) => (day === "2026-10-05" && failOnce ? new SourceError("Instabilidade", 503, "SERVER_ERROR") : []));
  const c = collector(d.collect, org);
  const first = await drain(c);
  assert.equal(first.at(-1)!.status, "failed");
  assert.equal(first.length, 16, "15 dias ok (20/09 a 04/10) e a falha em 05/10");
  assert.equal((await cursor(att)).scanDay, "2026-10-05");
  failOnce = false;
  clock = new Date(clock.getTime() + 3 * 60_000); // passou o recuo de 2 min
  const rest = await drain(c);
  assert.ok(rest.every((o) => o.status === "success"));
  assert.equal(d.calls.filter((x) => x.day === "2026-09-20").length, 1, "dias já concluídos não são refeitos");
  assert.equal(d.calls.filter((x) => x.day === "2026-10-05").length, 2, "só o que falhou repete");
  assert.equal((await cursor(att)).lastCompleteDay, "2026-10-19");
});

// ── Lease, fencing e concorrência ─────────────────────────────────────────────

test("trava de sobreposição: com o lease ativo ninguém mais pega a mesma OAB", async () => {
  const org = await mkOrg();
  await mkAtt(org, "211");
  const a = await claimWindow(t.db, org, now());
  assert.ok(a);
  assert.equal(await claimWindow(t.db, org, now()), null);
  advance(4 * 60_000); // ainda dentro do lease de 5 min
  assert.equal(await claimWindow(t.db, org, now()), null);
});

test("duas OABs do mesmo escritório: cada claim pega uma diferente", async () => {
  const org = await mkOrg();
  const a1 = await mkAtt(org, "212");
  const a2 = await mkAtt(org, "213", "RJ");
  const x = await claimWindow(t.db, org, now());
  const y = await claimWindow(t.db, org, now());
  assert.deepEqual([x!.attorneyId, y!.attorneyId].sort(), [a1, a2].sort());
  assert.equal(await claimWindow(t.db, org, now()), null);
});

test("worker obsoleto é recusado: lease vencido e assumido por outro; nada é gravado; a execução antiga vira 'abandonada'", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "214");
  const a = (await claimWindow(t.db, org, now()))!;
  advance(6 * 60_000); // o lease de A (5 min) venceu
  const b = (await claimWindow(t.db, org, now()))!;
  assert.ok(b, "B assume a janela de A");
  assert.notEqual(a.leaseId, b.leaseId);
  assert.equal(a.day, b.day);

  const result: DayResult = { count: 1, items: [it(900001)], status: 200, pages: 1 };
  await assert.rejects(commitWindow(t.db, a, result, now()), StaleLeaseError);
  assert.equal((await pubs(org)).length, 0, "o worker obsoleto não grava nada");
  assert.equal((await cursor(att)).scanDay, a.day, "nem move o cursor");

  assert.deepEqual(await commitWindow(t.db, b, result, now()), { found: 1, inserted: 1 });
  const r = await runs(att);
  assert.deepEqual(r.map((x) => [x.status, x.errorKind]), [["erro", "ABANDONED"], ["sucesso", null]]);
});

test("lease vencido sem ninguém ter assumido também é recusado (mesmo token, tarde demais)", async () => {
  const org = await mkOrg();
  await mkAtt(org, "215");
  const a = (await claimWindow(t.db, org, now()))!;
  advance(5 * 60_000 + 1);
  await assert.rejects(commitWindow(t.db, a, { count: 1, items: [it(900002)], status: 200, pages: 1 }, now()), StaleLeaseError);
  assert.equal((await pubs(org)).length, 0);
});

test("o cursor mudou por fora (outra posição): o commit é recusado", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "216");
  const a = (await claimWindow(t.db, org, now()))!;
  await t.client.exec(`update sync_cursors set scan_day = '${addDays(a.day, 3)}' where attorney_id = '${att}'`);
  await assert.rejects(commitWindow(t.db, a, { count: 0, items: [], status: 200, pages: 1 }, now()), StaleLeaseError);
});

test("ponta a ponta: o worker A demora, B assume e conclui; ao terminar, A é descartado como 'stale' sem duplicar nada", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "217");
  const itemsOfDay = [it(910001), it(910002)];
  let b: ReturnType<typeof collector>;
  let bOutcome: Outcome | undefined;
  const dB = fakeDjen((_o, _d) => itemsOfDay);
  b = collector(dB.collect, org);
  const dA = {
    collect: async (a: { oab_number: string; uf: string }, day: string): Promise<DayResult> => {
      // enquanto A "coleta" (lento), o lease vence e B pega a mesma janela
      advance(6 * 60_000);
      bOutcome = await b.collectNext();
      return { count: itemsOfDay.length, items: itemsOfDay, status: 200, pages: 1 };
    },
  };
  const out = await collector(dA.collect, org).collectNext();
  assert.equal(bOutcome!.status, "success");
  assert.equal(out.status, "stale");
  assert.equal((await pubs(org)).length, 2, "sem duplicar");
  assert.equal((await links(org)).length, 2);
  void att;
});

// ── Gravação: deduplicação, N:N, arquivar, descartar ──────────────────────────

test("commit grava publicação, vínculo, execução e cursor; o conteúdo vai como veio", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "311");
  const claim = (await claimWindow(t.db, org, now()))!;
  const items = [
    it(920001, { siglaTribunal: "TRT18", texto: "<script>alert(1)</script>", link: "https://www.cnj.jus.br/x", destinatarios: [{ nome: "A.B.C.D. LTDA", polo: "P" }] }),
    it(920002, { link: "javascript:alert(1)" }),
  ];
  const done = await commitWindow(t.db, claim, { count: 2, items, status: 200, pages: 1 }, now());
  assert.deepEqual(done, { found: 2, inserted: 2 });
  const ps = await pubs(org);
  assert.equal(ps.length, 2);
  const p1 = ps.find((p) => p.sourceId === "920001")!;
  assert.deepEqual([p1.tribunal, p1.originalText, p1.sourceUrl, p1.status, p1.archivedAt, p1.removedAt], ["TRT18", "<script>alert(1)</script>", "https://www.cnj.jus.br/x", "a_revisar", null, null]);
  assert.deepEqual(p1.recipients, [{ nome: "A.B.C.D. LTDA", polo: "P" }]);
  assert.equal(p1.availableOn, claim.day);
  assert.equal(ps.find((p) => p.sourceId === "920002")!.sourceUrl, null, "link inseguro descartado");
  assert.equal((await links(org)).length, 2);
  const [run] = await runs(att);
  assert.deepEqual([run.status, run.itemsFound, run.itemsInserted, run.pages, run.httpStatus], ["sucesso", 2, 2, 1, 200]);
  assert.equal((await cursor(att)).leaseId, null);
});

test("reimportar a mesma janela insere 0 e PRESERVA status, notas e providência; só last_seen_at muda", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "312");
  const c1 = (await claimWindow(t.db, org, now()))!;
  await commitWindow(t.db, c1, { count: 1, items: [it(930001)], status: 200, pages: 1 }, now());
  await t.client.exec(`update publications set status='em_analise', notes='manual', action_note='ligar' where organization_id='${org}'`);
  const before = (await pubs(org))[0];

  advance(60_000);
  await rewind(att, c1.day);
  const c2 = (await claimWindow(t.db, org, now()))!;
  assert.equal(c2.day, c1.day);
  const done = await commitWindow(t.db, c2, { count: 1, items: [it(930001, { texto: "REPUBLICADO" })], status: 200, pages: 1 }, now());
  assert.deepEqual(done, { found: 1, inserted: 0 });
  const after = (await pubs(org));
  assert.equal(after.length, 1);
  assert.deepEqual([after[0].status, after[0].notes, after[0].actionNote, after[0].originalText], ["em_analise", "manual", "ligar", "Teor 930001"]);
  assert.ok(after[0].lastSeenAt! > before.lastSeenAt!);
  assert.equal((await links(org)).length, 1, "o vínculo não duplica");
});

test("a mesma comunicação achada por duas OABs: 1 publicação e 2 vínculos", async () => {
  const org = await mkOrg();
  const a1 = await mkAtt(org, "313");
  const a2 = await mkAtt(org, "314", "RJ");
  const shared = it(940001);
  const both = fakeDjen((_o, day) => (day === "2026-10-19" ? [shared] : []));
  await drain(collector(both.collect, org));
  assert.equal((await pubs(org)).length, 1);
  const ls = await links(org);
  assert.deepEqual(ls.map((l) => l.attorneyId).sort(), [a1, a2].sort());
  const runsInserted = [...(await runs(a1)), ...(await runs(a2))].map((r) => r.itemsInserted ?? 0).reduce((a, b) => a + b, 0);
  assert.equal(runsInserted, 1, "só uma das duas execuções inseriu");
});

test("arquivada que é reimportada continua arquivada; descartada (tombstone) não volta nem ganha vínculo", async () => {
  const org = await mkOrg();
  const a1 = await mkAtt(org, "315");
  const a2 = await mkAtt(org, "316", "RJ");
  const c1 = (await claimWindow(t.db, org, now()))!;
  const day = c1.day;
  const batch = (n: number[]) => ({ count: n.length, items: n.map((x) => it(x)), status: 200, pages: 1 }) as DayResult;
  await commitWindow(t.db, c1, batch([950001, 950002]), now());

  await t.client.exec(`update publications set archived_at = now() where organization_id='${org}'`);
  await t.client.exec(`delete from publication_attorneys where publication_id = (select id from publications where source_id='950002' and organization_id='${org}')`);
  await t.client.exec(`update publications set removed_at = now(), original_text=null, raw_payload=null, recipients=null, process_number=null, process_mask=null, notes=null, action_note=null, source_url=null where source_id='950002' and organization_id='${org}'`);

  // a outra OAB acha as duas
  await t.client.exec(`update sync_cursors set scan_day='${day}', target_day='${day}', next_due_at=null, lease_id=null, lease_until=null where attorney_id='${a2}'`);
  let c2 = (await claimWindow(t.db, org, now()))!;
  if (c2.attorneyId === a1) {
    await rewind(a1, day); // garante que o claim seguinte seja o da OAB 2
    c2 = (await claimWindow(t.db, org, now()))!;
  }
  const done = await commitWindow(t.db, c2, batch([950001, 950002]), now());
  assert.equal(done.inserted, 0, "nada novo");
  const ps = await pubs(org);
  const live = ps.find((p) => p.sourceId === "950001")!;
  const dead = ps.find((p) => p.sourceId === "950002")!;
  assert.notEqual(live.archivedAt, null, "arquivada continua arquivada");
  assert.notEqual(dead.removedAt, null);
  assert.equal(dead.originalText, null, "o conteúdo descartado não volta");
  const ls = await links(org);
  assert.ok(ls.some((l) => l.publicationId === live.id && l.attorneyId === c2.attorneyId), "vínculo novo à publicação viva");
  assert.ok(!ls.some((l) => l.publicationId === dead.id), "tombstone nunca ganha vínculo");
});

test("atomicidade: se a gravação falha no meio, NADA é gravado, o cursor não anda e a janela se repete", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "317");
  const d = fakeDjen((_o, day) => (day === "2026-09-20" ? [it(960001), it(960002)] : []));
  // sabotagem: a última etapa do commit (encerrar a execução como sucesso) falha, depois de publicações e vínculos gravados
  await t.client.exec(`
    create function test_boom() returns trigger language plpgsql as $$ begin if new.status = 'sucesso' then raise exception 'falha injetada'; end if; return new; end $$;
    create trigger test_boom before update on sync_runs for each row execute function test_boom();`);
  try {
    const o = await collector(d.collect, org).collectNext();
    assert.equal(o.status, "failed");
    assert.equal((o as any).kind, "INTERNAL");
    assert.ok(!(o as any).message.includes("falha injetada"), "o erro interno não vaza para o registro visível");
    assert.equal((await pubs(org)).length, 0, "nenhuma publicação gravada");
    assert.equal((await links(org)).length, 0, "nenhum vínculo gravado");
    const c = await cursor(att);
    assert.equal(c.scanDay, "2026-09-20", "o cursor não avançou");
    assert.equal(c.leaseId, null, "lease liberado");
    assert.equal(c.consecutiveFailures, 1);
    const [r] = await runs(att);
    assert.deepEqual([r.status, r.errorKind], ["erro", "INTERNAL"]);
  } finally {
    await t.client.exec(`drop trigger test_boom on sync_runs; drop function test_boom();`);
  }
  // sem a sabotagem, a mesma janela é refeita e dá certo, sem duplicar
  advance(20 * 60_000);
  const ok = await collector(d.collect, org).collectNext();
  assert.equal(ok.status, "success");
  assert.equal((await pubs(org)).length, 2);
});

test("janela grande: 450 itens são gravados em lotes, com 450 vínculos", async () => {
  const org = await mkOrg();
  await mkAtt(org, "318");
  const c = (await claimWindow(t.db, org, now()))!;
  const items = Array.from({ length: 450 }, (_, i) => it(970000 + i));
  assert.deepEqual(await commitWindow(t.db, c, { count: 450, items, status: 200, pages: 9 }, now()), { found: 450, inserted: 450 });
  assert.equal((await pubs(org)).length, 450);
  assert.equal((await links(org)).length, 450);
});

test("o NUL no teor (que o PostgreSQL recusa) não derruba a janela", async () => {
  const org = await mkOrg();
  await mkAtt(org, "319");
  const c = (await claimWindow(t.db, org, now()))!;
  await commitWindow(t.db, c, { count: 1, items: [it(980001, { texto: "ab\u0000cd", extra: { x: "1\u00002" } })], status: 200, pages: 1 }, now());
  const [p] = await pubs(org);
  assert.equal(p.originalText, "abcd");
  assert.deepEqual((p.rawPayload as any).extra, { x: "12" });
});

// ── Falhas e recuo ────────────────────────────────────────────────────────────

test("429: libera o lease, conta a falha, respeita o Retry-After e repete a MESMA janela depois", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "411");
  let limited = true;
  const d = fakeDjen(() => (limited ? new SourceError("Limite excedido", 429, "RATE_LIMITED", 600) : []));
  const c = collector(d.collect, org);
  const o = await c.collectNext();
  assert.equal(o.status, "failed");
  assert.equal((o as any).kind, "RATE_LIMITED");
  assert.equal((o as any).retryAt.toISOString(), new Date(T0.getTime() + 10 * 60_000).toISOString());
  const cur = await cursor(att);
  assert.deepEqual([cur.leaseId, cur.consecutiveFailures, cur.scanDay, cur.lastError], [null, 1, "2026-09-20", "Limite excedido"]);
  const [r] = await runs(att);
  assert.deepEqual([r.status, r.httpStatus, r.errorKind, r.errorMessage], ["erro", 429, "RATE_LIMITED", "Limite excedido"]);

  assert.equal((await c.collectNext()).status, "idle", "ainda no recuo");
  advance(9 * 60_000);
  assert.equal((await c.collectNext()).status, "idle");
  advance(61_000);
  limited = false;
  const ok = await c.collectNext();
  assert.equal(ok.status, "success");
  assert.equal(d.calls.filter((x) => x.day === "2026-09-20").length, 2);
  const after = await cursor(att);
  assert.deepEqual([after.consecutiveFailures, after.lastError], [0, null], "sucesso zera a contagem");
});

test("bloqueio (403) espera 60 min; falhas seguidas de instabilidade recuam 2, 4, 8 min", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "412");
  let err: SourceError = new SourceError("Bloqueio geográfico", 403, "GEOBLOCK_CLOUDFRONT");
  const d = fakeDjen(() => err);
  const c = collector(d.collect, org);
  const o1 = (await c.collectNext()) as any;
  assert.equal(o1.kind, "GEOBLOCK_CLOUDFRONT");
  assert.equal(o1.retryAt.getTime() - clock.getTime(), 60 * 60_000);

  advance(61 * 60_000);
  err = new SourceError("Instabilidade", 503, "SERVER_ERROR");
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const o = (await c.collectNext()) as any;
    assert.equal(o.status, "failed");
    waits.push((o.retryAt.getTime() - clock.getTime()) / 60_000);
    advance(o.retryAt.getTime() - clock.getTime() + 1000);
  }
  assert.deepEqual(waits, [4, 8, 16], "a contagem já tinha 1 falha do bloqueio");
  assert.equal((await cursor(att)).consecutiveFailures, 4);
});

test("erro inesperado no coletor vira INTERNAL com mensagem genérica (o detalhe fica só no log)", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "413");
  const logs: string[] = [];
  const c = createCollector({ db: t.db, now, organizationIds: async () => [org], log: (m) => logs.push(m), collect: async () => { throw new Error("senha=hunter2 vazou"); } });
  const o = (await c.collectNext()) as any;
  assert.equal(o.kind, "INTERNAL");
  assert.ok(!o.message.includes("hunter2"));
  assert.ok(logs.some((l) => l.includes("hunter2")), "o detalhe vai para o log do servidor");
  const [r] = await runs(att);
  assert.ok(!JSON.stringify(r).includes("hunter2"));
});

test("falha de um worker que já perdeu o lease não mexe no cursor de quem assumiu", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "414");
  const a = (await claimWindow(t.db, org, now()))!;
  advance(6 * 60_000);
  const b = (await claimWindow(t.db, org, now()))!;
  await failWindow(t.db, a, { kind: "SERVER_ERROR", message: "tardio" }, now());
  const c = await cursor(att);
  assert.equal(c.leaseId, b.leaseId, "o lease de B continua intacto");
  assert.equal(c.consecutiveFailures, 0);
});

// ── Isolamento e escolha do trabalho ──────────────────────────────────────────

test("escritórios isolados e atendidos em rodízio; a MESMA OAB em dois escritórios é coletada separadamente", async () => {
  const A = await mkOrg("a");
  const B = await mkOrg("b");
  await mkAtt(A, "511");
  await mkAtt(B, "511"); // mesma OAB, outro escritório
  const d = fakeDjen((_o, day) => (day === "2026-10-19" ? [it(990001)] : []));
  const c = collector(d.collect, [A, B]);
  const orgs: string[] = [];
  for (let i = 0; i < 6; i++) {
    const o = await c.collectNext();
    assert.equal(o.status, "success");
    orgs.push((o as any).claim.organizationId);
    advance(4_000);
  }
  assert.deepEqual(orgs, [A, B, A, B, A, B], "rodízio: nenhum escritório monopoliza");
  await drain(c);
  for (const org of [A, B]) {
    const ps = await pubs(org);
    assert.equal(ps.length, 1, "cada escritório tem a sua cópia");
    assert.equal(ps[0].organizationId, org);
    assert.equal((await links(org)).length, 1);
  }
  assert.equal(d.calls.filter((x) => x.day === "2026-10-19").length, 2, "consultou duas vezes: não há cache compartilhado entre escritórios (decisão registrada)");
});

test("OAB inativa não é coletada; reativada, volta a ser; escritório sem OABs fica ocioso", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "512", "GO", false);
  const empty = await mkOrg("vazio");
  const d = fakeDjen();
  const c = collector(d.collect, [empty, org]);
  assert.equal((await c.collectNext()).status, "idle");
  assert.equal(d.calls.length, 0);
  await t.client.exec(`update attorneys set active = true where id = '${att}'`);
  assert.equal((await c.collectNext()).status, "success");
});

test("OAB desativada no meio do ciclo para de ser coletada (a janela em andamento termina)", async () => {
  const org = await mkOrg();
  const att = await mkAtt(org, "513");
  const d = fakeDjen();
  const c = collector(d.collect, org);
  await c.collectNext();
  await t.client.exec(`update attorneys set active = false where id = '${att}'`);
  assert.equal((await c.collectNext()).status, "idle");
  assert.equal(d.calls.length, 1);
});

test("padrão: atende todos os escritórios em rodízio; um escritório excluído some do trabalho (banco próprio)", async () => {
  const own = await createTestDb();
  try {
    const mk = async (id: string, oab: string) => {
      await own.raw.insert(schema.organization).values({ id, name: id, slug: id, createdAt: new Date() });
      await own.raw.insert(schema.attorneys).values({ organizationId: id, name: `Advogado ${oab}`, oabNumber: oab, uf: "GO" });
    };
    await mk("org-1", "701");
    await mk("org-2", "702");
    const d = fakeDjen();
    const c = createCollector({ db: own.db, collect: d.collect, now, log: () => {} });
    await c.collectNext();
    await c.collectNext();
    assert.deepEqual(d.calls.map((x) => x.oab), ["701", "702"], "rodízio entre os dois escritórios");
    await own.raw.delete(schema.organization).where(eq(schema.organization.id, "org-1"));
    d.calls.length = 0;
    for (let i = 0; i < 4; i++) await c.collectNext();
    assert.equal(d.calls.length, 4);
    assert.ok(d.calls.every((x) => x.oab === "702"), "o escritório excluído não recebe mais chamadas");
  } finally {
    await own.client.close();
  }
});

test("o coletor só enxerga dados do escritório que está atendendo (RLS): cursor e execução de outro escritório não vazam", async () => {
  const A = await mkOrg("rls-a");
  const B = await mkOrg("rls-b");
  await mkAtt(A, "611");
  await mkAtt(B, "612");
  const cA = (await claimWindow(t.db, A, now()))!;
  const cB = (await claimWindow(t.db, B, now()))!;
  assert.notEqual(cA.attorneyId, cB.attorneyId);
  // Um commit com o escritório trocado não encontra o lease (RLS esconde o cursor de A de quem atende B).
  await assert.rejects(commitWindow(t.db, { ...cA, organizationId: B }, { count: 0, items: [], status: 200, pages: 1 }, now()), StaleLeaseError);
  assert.equal((await t.raw.select().from(schema.syncCursors).where(and(eq(schema.syncCursors.attorneyId, cA.attorneyId)))).length, 1);
  const stillA = (await t.raw.select().from(schema.syncCursors).where(eq(schema.syncCursors.attorneyId, cA.attorneyId)))[0];
  assert.equal(stillA.leaseId, cA.leaseId, "o cursor de A não foi tocado");
  void sql;
});
