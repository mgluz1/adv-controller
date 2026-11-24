/**
 * Regras de calendário e de recuo do coletor (puras, sem banco nem rede). docs/REGRAS_DE_NEGOCIO.md §2.
 *
 * Datas são AAAA-MM-DD (strings), sempre no fuso America/Sao_Paulo (o "dia" do DJEN é o dia de Brasília).
 * Comparar as strings equivale a comparar as datas.
 */
import type { FailureKind } from "../djen/client.ts";

/** Primeira importação de uma OAB: os últimos 30 dias (inclusive hoje). */
export const FIRST_IMPORT_DAYS = 30;
/** A cada coleta, rever os últimos 7 dias já coletados (a fonte pode publicar com atraso). */
export const OVERLAP_DAYS = 7;
/** Reconciliação: reler os últimos 30 dias... */
export const RECONCILE_DAYS = 30;
/** ...ao menos a cada 7 dias. */
export const RECONCILE_EVERY_DAYS = 7;
/** Teto de retroação ao recuperar uma lacuna (servidor parado por muito tempo). */
export const MAX_BACKFILL_DAYS = 180;
/** Coleta diária às 09:00 de Brasília = 12:00 UTC (o Brasil não tem horário de verão desde 2019). */
export const DAILY_RUN_UTC_HOUR = 12;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(day: string): number {
  const m = DAY.exec(day);
  if (!m) throw new Error(`Data inválida: ${day}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3]))
    throw new Error(`Data inexistente: ${day}`);
  return t;
}

export function addDays(day: string, n: number): string {
  return new Date(parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Dias de `a` até `b` (positivo se b é depois de a). */
export function diffDays(a: string, b: string): number {
  return Math.round((parse(b) - parse(a)) / 86_400_000);
}

const BRT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
/** "Hoje" em Brasília. */
export function todayBrt(now: Date): string {
  return BRT.format(now);
}

/** Próxima coleta diária (12:00 UTC = 09:00 de Brasília) ESTRITAMENTE depois de `now`. */
export function nextDailyDue(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_RUN_UTC_HOUR));
  return d.getTime() > now.getTime() ? d : new Date(d.getTime() + 86_400_000);
}

export interface CyclePlan {
  /** Primeiro dia a coletar (os dias seguem em ordem crescente até hoje). */
  start: string;
  /** Este ciclo é uma reconciliação de 30 dias? */
  reconcile: boolean;
}

/**
 * Planeja um ciclo de coleta de uma OAB.
 *  - Nunca coletada: últimos 30 dias.
 *  - Reconciliação (nunca feita ou há 7+ dias): últimos 30 dias.
 *  - Caso normal: recua 7 dias a partir da última janela concluída (sobreposição).
 *  - Lacuna (parado por dias): o recuo parte da última janela concluída, então cobre todo o buraco;
 *    se a reconciliação cair no mesmo ciclo vale o mais antigo dos dois inícios.
 *  O início nunca é anterior a MAX_BACKFILL_DAYS nem posterior a hoje.
 */
export function planCycle(today: string, lastCompleteDay: string | null, lastReconciledOn: string | null): CyclePlan {
  const floor = addDays(today, -(MAX_BACKFILL_DAYS - 1));
  const reconcileStart = addDays(today, -(RECONCILE_DAYS - 1));
  if (!lastCompleteDay) return { start: reconcileStart, reconcile: true };
  const overlapStart = addDays(lastCompleteDay, -(OVERLAP_DAYS - 1));
  const reconcile = !lastReconciledOn || diffDays(lastReconciledOn, today) >= RECONCILE_EVERY_DAYS;
  let start = reconcile && reconcileStart < overlapStart ? reconcileStart : overlapStart;
  if (start < floor) start = floor;
  if (start > today) start = today;
  return { start, reconcile };
}

const MIN = 60_000;

/**
 * Espera antes de tentar a mesma janela de novo. Falha preserva a janela (o cursor não avança).
 *  - bloqueios (403: geobloqueio/WAF/política): 60 min. Insistir só piora o bloqueio;
 *  - 429: o que a fonte pediu (Retry-After), no mínimo 5 min;
 *  - instabilidade (5xx/rede/timeout): recuo exponencial de 2 a 60 min;
 *  - resposta inconsistente/inválida: 30 min; orçamento estourado: 5 min; erro nosso: 15 min.
 */
export function backoffMs(kind: FailureKind | "INTERNAL", consecutiveFailures: number, retryAfterSec?: number): number {
  const n = Math.max(1, consecutiveFailures);
  switch (kind) {
    case "GEOBLOCK_CLOUDFRONT":
    case "WAF_BLOCKED_OR_CHALLENGE":
    case "FORBIDDEN_POLICY":
      return 60 * MIN;
    case "RATE_LIMITED":
      return Math.min(6 * 60 * MIN, Math.max(5 * MIN, (retryAfterSec ?? 0) * 1000));
    case "SERVER_ERROR":
    case "TIMEOUT":
    case "NETWORK_ERROR":
      return Math.min(60 * MIN, 2 * MIN * 2 ** Math.min(n - 1, 10));
    case "BUDGET_EXCEEDED":
      return 5 * MIN;
    case "BAD_REQUEST":
    case "INVALID_RESPONSE":
    case "INCONSISTENT_SOURCE":
      return 30 * MIN;
    default:
      return 15 * MIN;
  }
}
