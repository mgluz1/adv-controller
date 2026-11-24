import test from "node:test";
import assert from "node:assert/strict";
import { addDays, backoffMs, diffDays, nextDailyDue, planCycle, todayBrt } from "../src/server/collector/schedule.ts";
import { MAX_TEXT, stripNul, toPublicationRow, TRUNCATED_MARK } from "../src/server/collector/normalize.ts";

// ── Calendário ────────────────────────────────────────────────────────────────

test("addDays/diffDays: virada de mês e ano, ano bissexto e datas inexistentes", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2026-10-19", -29), "2026-09-20");
  assert.equal(diffDays("2026-10-12", "2026-10-19"), 7);
  assert.equal(diffDays("2026-10-19", "2026-10-12"), -7);
  assert.equal(diffDays("2026-10-19", "2026-10-19"), 0);
  for (const bad of ["2026-02-31", "2026-13-01", "19/10/2026", "", "2026-1-1"]) assert.throws(() => addDays(bad, 1), bad);
});

test("todayBrt: o dia é o de Brasília (UTC-3), não o UTC", () => {
  assert.equal(todayBrt(new Date("2026-10-20T02:59:59Z")), "2026-10-19");
  assert.equal(todayBrt(new Date("2026-10-20T03:00:00Z")), "2026-10-20");
  assert.equal(todayBrt(new Date("2026-12-31T23:30:00Z")), "2026-12-31");
  assert.equal(todayBrt(new Date("2027-01-01T01:00:00Z")), "2026-12-31");
});

test("nextDailyDue: 09:00 de Brasília (12:00 UTC), sempre estritamente no futuro", () => {
  assert.equal(nextDailyDue(new Date("2026-10-19T11:59:59Z")).toISOString(), "2026-10-19T12:00:00.000Z");
  assert.equal(nextDailyDue(new Date("2026-10-19T12:00:00Z")).toISOString(), "2026-10-20T12:00:00.000Z");
  assert.equal(nextDailyDue(new Date("2026-10-19T18:00:00Z")).toISOString(), "2026-10-20T12:00:00.000Z");
  assert.equal(nextDailyDue(new Date("2026-12-31T20:00:00Z")).toISOString(), "2027-01-01T12:00:00.000Z");
});

// ── Planejamento do ciclo ─────────────────────────────────────────────────────

const T = "2026-10-19";

test("planCycle: primeira carga = últimos 30 dias (inclusive hoje), como reconciliação", () => {
  assert.deepEqual(planCycle(T, null, null), { start: "2026-09-20", reconcile: true });
});

test("planCycle: coleta normal recua 7 dias a partir da última janela concluída (sobreposição)", () => {
  assert.deepEqual(planCycle(T, "2026-10-18", "2026-10-17"), { start: "2026-10-12", reconcile: false });
  assert.deepEqual(planCycle(T, T, "2026-10-19"), { start: "2026-10-13", reconcile: false }, "reexecutar no mesmo dia relê a sobreposição");
});

test("planCycle: reconciliação de 30 dias a cada 7 dias", () => {
  assert.equal(planCycle(T, "2026-10-18", "2026-10-13").reconcile, false, "6 dias: ainda não");
  assert.deepEqual(planCycle(T, "2026-10-18", "2026-10-12"), { start: "2026-09-20", reconcile: true }, "7 dias: reconcilia");
  assert.deepEqual(planCycle(T, "2026-10-18", null), { start: "2026-09-20", reconcile: true }, "nunca reconciliada");
});

test("planCycle: lacuna — parado por dias, o recuo parte da última janela concluída e cobre todo o buraco", () => {
  // Última janela concluída há 40 dias (reconciliação também antiga): vale o início mais antigo.
  assert.deepEqual(planCycle(T, "2026-09-09", "2026-08-01"), { start: "2026-09-03", reconcile: true });
  // Sem reconciliação devida, a lacuna ainda é coberta.
  assert.deepEqual(planCycle(T, "2026-09-09", "2026-10-17"), { start: "2026-09-03", reconcile: false });
});

test("planCycle: teto de retroação (180 dias) e nunca depois de hoje", () => {
  assert.equal(planCycle(T, "2025-01-01", null).start, addDays(T, -179));
  assert.equal(planCycle(T, "2026-10-25", "2026-10-19").start, "2026-10-19", "última janela no futuro (relógio recuou): não passa de hoje");
});

// ── Recuo após falha ──────────────────────────────────────────────────────────

test("backoff: bloqueios esperam 60 min; 429 respeita Retry-After; instabilidade recua exponencialmente com teto", () => {
  const min = (ms: number) => ms / 60_000;
  for (const k of ["GEOBLOCK_CLOUDFRONT", "WAF_BLOCKED_OR_CHALLENGE", "FORBIDDEN_POLICY"] as const) assert.equal(min(backoffMs(k, 1)), 60);
  assert.equal(min(backoffMs("RATE_LIMITED", 1, 600)), 10);
  assert.equal(min(backoffMs("RATE_LIMITED", 1, 5)), 5, "mínimo de 5 min");
  assert.equal(min(backoffMs("RATE_LIMITED", 1, 999_999)), 360, "teto de 6 h");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((n) => min(backoffMs("SERVER_ERROR", n))), [2, 4, 8, 16, 32, 60, 60]);
  assert.equal(min(backoffMs("NETWORK_ERROR", 3)), 8);
  assert.equal(min(backoffMs("INCONSISTENT_SOURCE", 9)), 30);
  assert.equal(min(backoffMs("BUDGET_EXCEEDED", 9)), 5);
  assert.equal(min(backoffMs("INTERNAL", 9)), 15);
  assert.equal(min(backoffMs("SERVER_ERROR", 0)), 2, "contagem inválida não quebra");
});

// ── Normalização do item ──────────────────────────────────────────────────────

const NOW = new Date("2026-10-19T15:00:00Z");
const item = (over: Record<string, unknown> = {}) => ({ id: 123456, ...over }) as any;

test("normalização: campos, aliases e padrões; data de publicação nunca é inferida", () => {
  const r = toPublicationRow(
    item({
      hash: " abc ", siglaTribunal: "TJGO", nomeOrgao: "1ª Vara Cível", numero_processo: "00012345620268090001",
      numeroprocessocommascara: "0001234-56.2026.8.09.0001", nomeClasse: "Procedimento Comum", tipoComunicacao: "Intimação",
      texto: "Teor <b>x</b>", meiocompleto: "Diário de Justiça Eletrônico Nacional", link: "https://www.cnj.jus.br/x",
      destinatarios: [{ nome: " FULANO ", polo: "A" }, { nome: "", polo: "P" }, { nome: "CICLANO" }],
    }),
    "org-1", "2026-10-19", NOW,
  );
  assert.equal(r.sourceId, "123456");
  assert.equal(r.organizationId, "org-1");
  assert.equal(r.sourceHash, "abc");
  assert.equal(r.tribunal, "TJGO");
  assert.equal(r.processNumber, "00012345620268090001");
  assert.equal(r.processMask, "0001234-56.2026.8.09.0001");
  assert.equal(r.medium, "Diário de Justiça Eletrônico Nacional");
  assert.equal(r.originalText, "Teor <b>x</b>", "o teor é guardado como veio: o escape é na exibição");
  assert.equal(r.sourceUrl, "https://www.cnj.jus.br/x");
  assert.deepEqual(r.recipients, [{ nome: "FULANO", polo: "A" }, { nome: "CICLANO", polo: null }]);
  assert.equal(r.availableOn, "2026-10-19");
  assert.equal(r.publishedOn, null);
  assert.deepEqual([r.firstSeenAt, r.lastSeenAt], [NOW, NOW]);
});

test("normalização: processo só com um dos números usa o outro; meio alternativo; ausentes viram nulo", () => {
  const a = toPublicationRow(item({ numeroprocessocommascara: "0001-11", meio: "Diário" }), "o", "2026-10-19", NOW);
  assert.deepEqual([a.processNumber, a.processMask, a.medium], ["0001-11", "0001-11", "Diário"]);
  const b = toPublicationRow(item(), "o", "2026-10-19", NOW);
  for (const k of ["sourceHash", "tribunal", "judgingBody", "processNumber", "processMask", "className", "communicationType", "medium", "sourceUrl", "recipients"] as const)
    assert.equal(b[k], null, k);
  assert.equal(b.originalText, "(Sem teor de publicação registrado)", "o banco exige teor nas publicações vivas");
});

test("normalização: link inseguro é descartado, nunca guardado", () => {
  for (const link of ["javascript:alert(1)", "data:text/html,x", "ftp://x.test/", "https://u:p@x.test/", 5])
    assert.equal(toPublicationRow(item({ link }), "o", "2026-10-19", NOW).sourceUrl, null, String(link));
});

test("o caractere NUL (que o PostgreSQL recusa) é removido do teor, dos campos e do payload bruto", () => {
  const r = toPublicationRow(item({ texto: "a\u0000b", siglaTribunal: "TJ\u0000GO", extra: { aninhado: ["x\u0000y"], "k\u0000": 1 } }), "o", "2026-10-19", NOW);
  assert.equal(r.originalText, "ab");
  assert.equal(r.tribunal, "TJGO");
  assert.ok(!JSON.stringify(r.rawPayload).includes("\\u0000"));
  assert.deepEqual((r.rawPayload as any).extra, { aninhado: ["xy"], k: 1 });
  assert.equal(stripNul(5), 5);
  assert.equal(stripNul(null), null);
});

test("teor acima do máximo é cortado com marcador explícito (nunca em silêncio)", () => {
  const r = toPublicationRow(item({ texto: "x".repeat(MAX_TEXT + 500) }), "o", "2026-10-19", NOW);
  assert.ok(r.originalText!.endsWith(TRUNCATED_MARK));
  assert.ok(r.originalText!.length <= 2_000_000);
  assert.equal(toPublicationRow(item({ texto: "x".repeat(MAX_TEXT) }), "o", "2026-10-19", NOW).originalText!.length, MAX_TEXT, "no limite não corta");
});

test("destinatários: no máximo 100 e nomes longos são limitados", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ nome: `P${i}` }));
  assert.equal((toPublicationRow(item({ destinatarios: many }), "o", "2026-10-19", NOW).recipients as unknown[]).length, 100);
  const long = toPublicationRow(item({ destinatarios: [{ nome: "N".repeat(1000), polo: "P".repeat(100) }] }), "o", "2026-10-19", NOW).recipients as any[];
  assert.deepEqual([long[0].nome.length, long[0].polo.length], [300, 20]);
});
