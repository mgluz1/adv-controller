import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler, type CollectorLike } from "../src/server/collector/scheduler.ts";
import type { Claim, Outcome } from "../src/server/collector/collector.ts";

// Agendador (tarefa 1.5): ritmo global, espera ociosa, resiliência e parada limpa. Sem banco e sem rede.
const claim = {} as Claim;
const ok: Outcome = { status: "success", claim, found: 0, inserted: 0, pages: 1 };
const idle: Outcome = { status: "idle" };
const failed: Outcome = { status: "failed", claim, kind: "SERVER_ERROR", message: "x", retryAt: new Date() };

/** Relógio e sleep falsos: dormir só adianta o relógio. */
function harness(script: Array<Outcome | Error>, opts: { windowMs?: number; nextWake?: () => Date | null; minIntervalMs?: number; idleMs?: number } = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const starts: number[] = [];
  const wakes: (string | undefined)[] = [];
  let i = 0;
  const collector: CollectorLike = {
    async collectNext() {
      starts.push(t);
      const r = script[Math.min(i++, script.length - 1)];
      if (r instanceof Error) throw r;
      if (r.status !== "idle") t += opts.windowMs ?? 0; // uma janela leva tempo; ociosa não
      return r;
    },
    wake: (o) => void wakes.push(o),
    nextWakeAt: () => opts.nextWake?.() ?? null,
  };
  const logs: string[] = [];
  const s = createScheduler({
    collector,
    minIntervalMs: opts.minIntervalMs ?? 4000,
    idleMs: opts.idleMs ?? 60_000,
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    log: (m) => logs.push(m),
  });
  return { s, sleeps, starts, wakes, logs, now: () => t, advance: (ms: number) => void (t += ms) };
}

test("ritmo: no mínimo 4 s entre o INÍCIO de duas janelas, descontando o tempo que a janela já levou", async () => {
  const h = harness([ok], { windowMs: 1000 });
  for (let i = 0; i < 5; i++) assert.equal((await h.s.step()).waitMs, 0);
  assert.deepEqual(h.sleeps, [3000, 3000, 3000, 3000], "a 1ª não espera; as demais completam os 4 s");
  assert.deepEqual(h.starts.slice(1).map((x, i) => x - h.starts[i]), [4000, 4000, 4000, 4000]);
});

test("janela mais longa que o intervalo não ganha espera extra", async () => {
  const h = harness([ok], { windowMs: 10_000 });
  await h.s.step();
  await h.s.step();
  await h.s.step();
  assert.deepEqual(h.sleeps, []);
});

test("falha e 'stale' também contam como janela para o ritmo (a fonte foi consultada)", async () => {
  const h = harness([failed, { status: "stale", claim }, ok], { windowMs: 0 });
  await h.s.step();
  await h.s.step();
  await h.s.step();
  assert.deepEqual(h.sleeps, [4000, 4000]);
});

test("ociosa: espera até o menor vencimento conhecido, entre 1 s e o teto (60 s)", async () => {
  const cases: [number | null, number][] = [
    [20_000, 20_000], // vence em 20 s
    [5 * 60_000, 60_000], // longe: teto
    [null, 60_000], // nada avaliado: teto
    [100, 1_000], // quase agora: piso (nada de laço quente)
    [-5_000, 1_000], // já venceu
  ];
  for (const [delta, expected] of cases) {
    const h = harness([idle], { nextWake: () => null });
    // recria com nextWake relativo ao relógio do próprio harness
    const g = harness([idle], { nextWake: () => (delta === null ? null : new Date(g.now() + delta)) });
    const r = await g.s.step();
    assert.equal(r.outcome.status, "idle");
    assert.equal(r.waitMs, expected, `delta=${delta}`);
    void h;
  }
});

test("ociosa não conta para o ritmo: depois de um tempo parado, a próxima janela sai sem espera", async () => {
  const h = harness([ok, idle, ok], { windowMs: 0 });
  await h.s.step(); // janela
  await h.s.step(); // ocioso (esperou o ritmo, pois acabou de coletar)
  h.advance(60_000);
  const before = h.sleeps.length;
  await h.s.step(); // janela
  assert.equal(h.sleeps.length, before, "sem espera: o ritmo já foi cumprido");
});

test("erro ao acionar o coletor nunca derruba o agendador: recuo de 30 s a 5 min e zera ao voltar", async () => {
  const boom = new Error("banco fora do ar");
  const h = harness([boom, boom, boom, boom, boom, boom, boom, ok]);
  const waits: number[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await h.s.step();
    assert.equal(r.outcome.status, "error");
    waits.push(r.waitMs / 1000);
  }
  assert.deepEqual(waits, [30, 60, 120, 240, 300, 300, 300], "dobra até o teto de 5 min");
  assert.equal(h.logs.length, 7);
  assert.ok(h.logs[0].includes("banco fora do ar"), "o motivo vai para o log do servidor");
  assert.equal((await h.s.step()).outcome.status, "success");
  const again = harness([boom]);
  assert.equal((await again.s.step()).waitMs, 30_000);
});

test("o erro vira resultado 'error' sem vazar o detalhe para quem consome o resultado", async () => {
  const h = harness([new Error("senha=hunter2")]);
  const r = await h.s.step();
  assert.ok(!JSON.stringify(r).includes("hunter2"));
});

// ── Laço real (timers reais, valores minúsculos) ──────────────────────────────

function loopHarness(extra: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  let calls = 0;
  let wakeCalls = 0;
  const collector: CollectorLike = {
    async collectNext() {
      calls++;
      return idle;
    },
    wake: () => void wakeCalls++,
    nextWakeAt: () => null,
  };
  const logs: string[] = [];
  const s = createScheduler({ collector, minIntervalMs: 1, idleMs: 60_000, log: (m) => logs.push(m), ...extra });
  return { s, logs, calls: () => calls, wakeCalls: () => wakeCalls };
}
/** Garante que o laço pare mesmo se o teste falhar (senão o processo de teste ficaria preso num timer). */
async function withLoop(s: { start(): void; stop(ms?: number): Promise<void> }, body: () => Promise<void>) {
  s.start();
  try {
    await body();
  } finally {
    await s.stop(500);
  }
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condição não atingida a tempo");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("laço: wake() acorda o agendador ocioso na hora; stop() para sem esperar o fim da espera", async () => {
  const h = loopHarness();
  await withLoop(h.s, async () => {
    await until(() => h.calls() === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.calls(), 1, "ocioso: dorme (até 60 s) em vez de girar");
    h.s.wake("org-1");
    await until(() => h.calls() === 2);
    assert.equal(h.wakeCalls(), 1, "o aviso chega ao coletor para esquecer as dicas");
    const t0 = Date.now();
    await h.s.stop();
    assert.ok(Date.now() - t0 < 1000, "parou sem esperar os 60 s");
    assert.equal(h.s.running, false);
    const n = h.calls();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.calls(), n, "parado de verdade");
  });
});

test("laço: start() é idempotente (um único laço) e stop() também; pode reiniciar", async () => {
  const h = loopHarness();
  await withLoop(h.s, async () => {
    h.s.start();
    h.s.start();
    await until(() => h.calls() >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.calls(), 1, "três start() não criam três laços");
    await h.s.stop();
    await h.s.stop();
    h.s.start();
    await until(() => h.calls() >= 2);
  });
});

test("laço: stop() espera a janela em andamento terminar", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let stopped = false;
  const collector: CollectorLike = {
    async collectNext() {
      await gate;
      return ok;
    },
    wake: () => {},
    nextWakeAt: () => null,
  };
  const s = createScheduler({ collector, minIntervalMs: 1, log: () => {} });
  s.start();
  try {
    await new Promise((r) => setTimeout(r, 20));
    const p = s.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stopped, false, "ainda há uma janela em andamento");
    release();
    await p;
    assert.equal(stopped, true);
  } finally {
    release();
    await s.stop(500);
  }
});

test("laço: stop() desiste depois do prazo se a janela travar (o lease vence sozinho) e avisa no log", async () => {
  const collector: CollectorLike = {
    collectNext: () => new Promise<Outcome>(() => {}), // nunca termina
    wake: () => {},
    nextWakeAt: () => null,
  };
  const logs: string[] = [];
  const s = createScheduler({ collector, minIntervalMs: 1, log: (m) => logs.push(m) });
  s.start();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await s.stop(100);
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(logs.some((l) => l.includes("lease")));
});

test("laço: um erro no coletor não mata o laço (recupera e continua)", async () => {
  let calls = 0;
  const collector: CollectorLike = {
    async collectNext() {
      calls++;
      if (calls === 1) throw new Error("falha transitória");
      return idle;
    },
    wake: () => {},
    nextWakeAt: () => null,
  };
  const logs: string[] = [];
  const s = createScheduler({ collector, minIntervalMs: 1, log: (m) => logs.push(m) });
  await withLoop(s, async () => {
    await until(() => logs.length === 1); // o erro foi tratado (collectNext é chamado de forma síncrona em start())
    await new Promise((r) => setTimeout(r, 20)); // e o laço já entrou no recuo de 30 s
    assert.ok(s.running);
    s.wake(); // o aviso interrompe o recuo
    await until(() => calls >= 2);
    assert.ok(logs[0].includes("falha transitória"));
  });
});
