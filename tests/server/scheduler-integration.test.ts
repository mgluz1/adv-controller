import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { createCollector } from "../../src/server/collector/collector.ts";
import { createScheduler } from "../../src/server/collector/scheduler.ts";
import { todayBrt } from "../../src/server/collector/schedule.ts";
import type { DayResult, DjenItem } from "../../src/server/djen/client.ts";
import { createTestDb } from "./helpers.ts";

// Agendador REAL + coletor REAL + banco REAL (PGlite), relógio real e intervalos minúsculos. O DJEN é simulado.
const until = async (cond: () => Promise<boolean> | boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condição não atingida a tempo");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("ponta a ponta: primeira carga completa, ocioso sem consultar, e OAB nova acorda o laço", async () => {
  const t = await createTestDb();
  const starts: number[] = [];
  const calls: { oab: string; day: string }[] = [];
  const collect = async (a: { oab_number: string; uf: string }, day: string): Promise<DayResult> => {
    starts.push(Date.now());
    calls.push({ oab: a.oab_number, day });
    const items: DjenItem[] = [{ id: Number(day.replaceAll("-", "")) * 10 + (a.oab_number === "222" ? 2 : 1), texto: `Teor ${day}`, siglaTribunal: "TJGO" } as DjenItem];
    return { count: 1, items, status: 200, pages: 1 };
  };
  const collector = createCollector({ db: t.db, collect, log: () => {} });
  const MIN = 20;
  const scheduler = createScheduler({ collector, minIntervalMs: MIN, idleMs: 200, log: () => {} });
  const handle = { wake: (o?: string) => scheduler.wake(o) };
  try {
    await t.raw.insert(schema.organization).values({ id: "org-e2e", name: "E2E", slug: "e2e", createdAt: new Date() });
    const [a1] = await t.raw.insert(schema.attorneys).values({ organizationId: "org-e2e", name: "Advogado 111", oabNumber: "111", uf: "GO" }).returning();
    scheduler.start();

    // 1ª carga: 30 janelas, uma por vez, até hoje
    const today = todayBrt(new Date());
    await until(async () => (await t.raw.select().from(schema.syncCursors).where(eq(schema.syncCursors.attorneyId, a1.id)))[0]?.lastCompleteDay === today);
    assert.equal(calls.length, 30);
    assert.equal(new Set(calls.map((c) => c.day)).size, 30);
    assert.deepEqual(calls.map((c) => c.day), [...calls.map((c) => c.day)].sort(), "do mais antigo ao mais novo");
    const gaps = starts.slice(1).map((s, i) => s - starts[i]);
    assert.ok(gaps.every((g) => g >= MIN - 3), `ritmo respeitado (menor intervalo: ${Math.min(...gaps)} ms)`);
    assert.equal((await t.raw.select().from(schema.publications)).length, 30);
    assert.equal((await t.raw.select().from(schema.publicationAttorneys)).length, 30);
    const runs = await t.raw.select().from(schema.syncRuns);
    assert.equal(runs.length, 30);
    assert.ok(runs.every((r) => r.status === "sucesso"));

    // Ocioso: o agendador dorme e o banco não é consultado.
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.length, n, "nada vencido: nenhuma consulta ao DJEN");

    // OAB nova + wake (é o que a rota faz): começa na hora, sem esperar a dica de 5 min
    const [a2] = await t.raw.insert(schema.attorneys).values({ organizationId: "org-e2e", name: "Advogado 222", oabNumber: "222", uf: "RJ" }).returning();
    handle.wake("org-e2e");
    await until(async () => (await t.raw.select().from(schema.syncCursors).where(eq(schema.syncCursors.attorneyId, a2.id)))[0]?.lastCompleteDay === today);
    assert.equal(calls.filter((c) => c.oab === "222").length, 30);
    assert.equal((await t.raw.select().from(schema.publications)).length, 60);
  } finally {
    await scheduler.stop(2000);
    await t.client.close();
  }
  const after = calls.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.length, after, "parado de verdade");
});

test("ponta a ponta: uma falha da fonte não trava o laço nem pula o dia; ao recuperar, termina o ciclo", async () => {
  const t = await createTestDb();
  let sick = true;
  const days: string[] = [];
  const collect = async (_a: { oab_number: string; uf: string }, day: string): Promise<DayResult> => {
    days.push(day);
    if (sick && days.length === 4) {
      const { SourceError } = await import("../../src/server/djen/client.ts");
      throw new SourceError("Instabilidade", 503, "SERVER_ERROR");
    }
    return { count: 0, items: [], status: 200, pages: 1 };
  };
  let clock = Date.now();
  const collector = createCollector({ db: t.db, collect, now: () => new Date(clock), log: () => {} });
  const scheduler = createScheduler({ collector, minIntervalMs: 5, idleMs: 100, now: () => new Date(clock), log: () => {} });
  try {
    await t.raw.insert(schema.organization).values({ id: "org-f", name: "F", slug: "f", createdAt: new Date() });
    const [a] = await t.raw.insert(schema.attorneys).values({ organizationId: "org-f", name: "Advogado 333", oabNumber: "333", uf: "GO" }).returning();
    scheduler.start();
    await until(async () => (await t.raw.select().from(schema.syncCursors).where(eq(schema.syncCursors.attorneyId, a.id)))[0]?.consecutiveFailures === 1);
    const stuck = (await t.raw.select().from(schema.syncCursors))[0];
    assert.equal(stuck.scanDay, days[3], "o cursor ficou NO dia que falhou");
    assert.equal(days.length, 4);
    // passa o recuo (2 min) e a fonte volta
    sick = false;
    clock += 3 * 60_000;
    scheduler.wake();
    await until(async () => (await t.raw.select().from(schema.syncCursors))[0]?.lastCompleteDay === todayBrt(new Date(clock)));
    assert.equal(days.filter((d) => d === days[3]).length, 2, "só o dia que falhou foi repetido");
    assert.equal(new Set(days).size, 30);
  } finally {
    await scheduler.stop(2000);
    await t.client.close();
  }
});
