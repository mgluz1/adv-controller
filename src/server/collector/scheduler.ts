/**
 * Agendador: o laço que chama o coletor, uma janela por vez, respeitando o ritmo da fonte.
 *
 *  - Ritmo: no mínimo `minIntervalMs` (4 s) entre o INÍCIO de duas janelas. O limite do CNJ é por origem, não por escritório.
 *  - Coleta diária e continuação: não há relógio próprio. O coletor decide quando algo vence (09:00 de Brasília para o ciclo
 *    diário; imediato enquanto houver janelas pendentes); o laço só acorda no menor vencimento conhecido (no máximo a cada `idleMs`).
 *  - Resiliência: nenhum erro derruba o laço (banco fora do ar ⇒ recuo exponencial de 30 s a 5 min).
 *  - Parada limpa: `stop()` espera a janela em andamento terminar (ou o prazo), para não deixar lease pendurado.
 *
 * ATENÇÃO — uma instância só: rode o laço em UMA instância (COLLECTOR_ENABLED=true). Duas instâncias continuam corretas
 * (lease/fencing), mas cada uma respeitaria o intervalo sozinha e a fonte receberia o dobro do ritmo.
 */
import type { Outcome } from "./collector.ts";

export interface CollectorLike {
  collectNext(): Promise<Outcome>;
  wake(organizationId?: string): void;
  nextWakeAt(): Date | null;
}

export interface SchedulerOptions {
  collector: CollectorLike;
  /** Mínimo entre o início de duas janelas. Padrão 4 s. */
  minIntervalMs?: number;
  /** Máximo de espera quando ocioso. Padrão 60 s. */
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface StepResult {
  outcome: Outcome | { status: "error"; message: string };
  /** Quanto esperar antes do próximo passo (0 = já; o ritmo é imposto no início do passo seguinte). */
  waitMs: number;
}

const ERROR_BACKOFF_BASE_MS = 30_000;
const ERROR_BACKOFF_MAX_MS = 5 * 60_000;
const MIN_IDLE_WAIT_MS = 1_000;

export function createScheduler(options: SchedulerOptions) {
  const { collector } = options;
  const minIntervalMs = options.minIntervalMs ?? 4_000;
  const idleMs = options.idleMs ?? 60_000;
  const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.error(`[agendador] ${m}`));

  let lastWindowStart: number | undefined;
  let errors = 0;
  let stopped = true;
  let loop: Promise<void> | undefined;
  const sleepers = new Set<() => void>();

  /** Um passo: respeita o ritmo, coleta no máximo uma janela e diz quanto esperar. Nunca lança. */
  async function step(): Promise<StepResult> {
    if (lastWindowStart !== undefined) {
      const gap = lastWindowStart + minIntervalMs - now().getTime();
      if (gap > 0) await sleep(gap);
    }
    const startedAt = now().getTime();
    let outcome: Outcome;
    try {
      outcome = await collector.collectNext();
    } catch (e) {
      errors++;
      const waitMs = Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * 2 ** (errors - 1));
      log(`erro no coletor (${errors}ª seguida; nova tentativa em ${Math.round(waitMs / 1000)} s): ${(e as Error)?.message ?? e}`);
      return { outcome: { status: "error", message: "Erro ao acionar o coletor." }, waitMs };
    }
    errors = 0;
    if (outcome.status === "idle") {
      const wake = collector.nextWakeAt();
      const until = wake ? wake.getTime() - now().getTime() : idleMs;
      return { outcome, waitMs: Math.max(MIN_IDLE_WAIT_MS, Math.min(idleMs, until)) };
    }
    // Só janelas de verdade contam. O ritmo parte do instante em que a chamada à fonte COMEÇOU (o claim no banco vem
    // antes e varia); se o coletor não informar, vale o início do passo. Nunca mais que um intervalo à frente.
    const began = outcome.startedAt?.getTime() ?? startedAt;
    lastWindowStart = Math.min(Math.max(began, startedAt - minIntervalMs), now().getTime());
    return { outcome, waitMs: 0 };
  }

  /** Dorme, mas acorda na hora se `wake()` ou `stop()` forem chamados. */
  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      sleepers.add(done);
    });
  }

  async function run() {
    while (!stopped) {
      const { waitMs } = await step();
      if (stopped) break;
      if (waitMs > 0) await interruptibleSleep(waitMs);
    }
  }

  return {
    step,
    get running() {
      return !stopped;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      loop = run().catch((e) => log(`laço encerrado por erro inesperado: ${(e as Error)?.message ?? e}`));
    },
    /** Para o laço e espera a janela em andamento (até `timeoutMs`). Idempotente. */
    async stop(timeoutMs = 60_000) {
      stopped = true;
      for (const wake of [...sleepers]) wake();
      if (!loop) return;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        loop.then(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), timeoutMs);
            }),
      ]);
      clearTimeout(timer);
      if (timedOut) log(`parada: a janela em andamento não terminou em ${timeoutMs / 1000} s; o lease vence sozinho.`);
      loop = undefined;
    },
    /** Há trabalho novo: esquece as dicas do coletor e acorda o laço ocioso. */
    wake(organizationId?: string) {
      collector.wake(organizationId);
      for (const w of [...sleepers]) w();
    },
  };
}
