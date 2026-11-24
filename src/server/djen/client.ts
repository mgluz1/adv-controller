/**
 * Adaptador da API pública do DJEN (ComunicaAPI/CNJ): UMA janela = um dia × uma OAB.
 *
 * Regras (docs/REGRAS_DE_NEGOCIO.md §1; cada uma tem teste em tests/djen-adapter.test.ts):
 *  - percorre TODAS as páginas; página vazia antes do total é erro;
 *  - cada item deve trazer a OAB/UF consultada entre os destinatários (e a data consultada);
 *  - ID repetido entre páginas e mudança do total durante a paginação impedem o sucesso (o checkpoint não avança);
 *  - 403 não é repetido nem vira "vazio"; 429 respeita Retry-After; 5xx/rede têm no máximo 3 tentativas;
 *  - orçamento por janela: 45 s e 100 páginas. Estourar é FALHA explícita, nunca sucesso parcial;
 *  - total zero legítimo ≠ erro; datas impossíveis são rejeitadas; link de fonte só http/https.
 *
 * É código puro: `fetcher`, `sleep` e `now` são injetáveis (sem rede nos testes). Não grava nada e não
 * conhece banco, escritório nem agendamento: ritmo global entre janelas é responsabilidade do coletor.
 */

export const DJEN_BASE_URL = "https://comunicaapi.pje.jus.br/api/v1";

export type FailureKind =
  | "GEOBLOCK_CLOUDFRONT"
  | "WAF_BLOCKED_OR_CHALLENGE"
  | "FORBIDDEN_POLICY"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "BAD_REQUEST"
  | "INVALID_RESPONSE"
  | "BUDGET_EXCEEDED"
  | "INCONSISTENT_SOURCE";

/** Falha da coleta de uma janela. A janela inteira deve ser repetida; nada parcial é gravado. */
export class SourceError extends Error {
  constructor(
    message: string,
    public readonly status: number = 0,
    public readonly kind: FailureKind = "INVALID_RESPONSE",
    /** Segundos pedidos pela fonte (Retry-After), quando houver. */
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface Attorney {
  oab_number: string;
  uf: string;
}

export interface DjenItem {
  id: number;
  data_disponibilizacao?: string;
  datadisponibilizacao?: string;
  destinatarioadvogados?: { advogado?: { numero_oab?: string; uf_oab?: string } }[];
  [k: string]: unknown;
}

export interface Page {
  count: number;
  items: DjenItem[];
}

export interface DayResult {
  /** Total confirmado pela fonte (= items.length quando a janela é concluída). */
  count: number;
  items: DjenItem[];
  /** Status HTTP da última resposta (200). */
  status: number;
  pages: number;
  /** `x-ratelimit-remaining` da última resposta, se a fonte informar. */
  remaining?: number;
}

export interface CollectOptions {
  fetcher?: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  pageSize?: number;
  /** Orçamento total da janela (ms). Padrão 45 s. */
  budgetMs?: number;
  maxPages?: number;
  /** Tentativas por página para 5xx/rede/429. Padrão 3. */
  maxAttempts?: number;
  requestTimeoutMs?: number;
  /** Pausa de cortesia entre páginas (ms). Padrão 0: o ritmo global é do coletor. */
  pageDelayMs?: number;
}

const DEFAULTS = {
  pageSize: 50,
  budgetMs: 45_000,
  maxPages: 100,
  maxAttempts: 3,
  requestTimeoutMs: 15_000,
  pageDelayMs: 0,
  retryDelayMs: 1_000,
  /** Espera padrão quando a fonte responde 429 sem Retry-After. */
  defaultRetryAfterSec: 5,
};

// ── Validadores puros ─────────────────────────────────────────────────────────

/** Valida e devolve uma data AAAA-MM-DD real (rejeita 2026-02-31). */
export function day(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) throw new SourceError(`Data inválida: "${value}". Use AAAA-MM-DD.`, 0, "BAD_REQUEST");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d)
    throw new SourceError(`Data inexistente: "${value}".`, 0, "BAD_REQUEST");
  return value;
}

/** Só http/https; qualquer outro esquema (javascript:, data:…) ou URL com credenciais é descartado. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const oabDigits = (v: unknown) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
const ufNorm = (v: unknown) => String(v ?? "").trim().toUpperCase();

function normalizeAttorney(a: Attorney): { oab: string; uf: string } {
  const oab = oabDigits(a?.oab_number);
  const uf = ufNorm(a?.uf);
  if (!/^[1-9][0-9]{0,6}$/.test(oab) || !/^[A-Z]{2}$/.test(uf))
    throw new SourceError(`OAB inválida: "${a?.oab_number}" / "${a?.uf}".`, 0, "BAD_REQUEST");
  return { oab, uf };
}

/**
 * Valida UMA página da resposta. Lança em qualquer desvio: não existe "aceitar o que der".
 * Devolve só itens que comprovadamente pertencem à OAB/UF e ao dia consultados.
 */
export function validatePage(body: unknown, attorney: Attorney, date: string): Page {
  const want = normalizeAttorney(attorney);
  day(date);
  const b = body as { status?: unknown; count?: unknown; items?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new SourceError("Resposta do DJEN não é um objeto JSON.", 200, "INVALID_RESPONSE");
  if (b.status !== "success")
    throw new SourceError(`Resposta do DJEN sem status "success" (recebido: ${JSON.stringify(b.status)}).`, 200, "INVALID_RESPONSE");
  if (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 0)
    throw new SourceError("Resposta do DJEN com `count` ausente ou não numérico.", 200, "INVALID_RESPONSE");
  if (!Array.isArray(b.items))
    throw new SourceError("Resposta do DJEN sem lista `items`.", 200, "INVALID_RESPONSE");

  const items: DjenItem[] = [];
  for (const raw of b.items) {
    const it = raw as DjenItem;
    if (!it || typeof it !== "object")
      throw new SourceError("Item do DJEN inválido.", 200, "INVALID_RESPONSE");
    const id = Number(it.id ?? (it as { numeroComunicacao?: unknown }).numeroComunicacao);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new SourceError("Item do DJEN sem ID válido.", 200, "INVALID_RESPONSE");
    const dest = Array.isArray(it.destinatarioadvogados) ? it.destinatarioadvogados : [];
    const matches = dest.some(
      (d) => oabDigits(d?.advogado?.numero_oab) === want.oab && ufNorm(d?.advogado?.uf_oab) === want.uf,
    );
    if (!matches)
      throw new SourceError(
        `Item ${id} não traz a OAB ${want.oab}/${want.uf} consultada entre os destinatários.`,
        200,
        "INCONSISTENT_SOURCE",
      );
    const itemDate = String(it.data_disponibilizacao ?? it.datadisponibilizacao ?? "").slice(0, 10);
    if (itemDate && itemDate !== date)
      throw new SourceError(`Item ${id} é de ${itemDate}, fora do dia consultado (${date}).`, 200, "INCONSISTENT_SOURCE");
    items.push({ ...it, id });
  }
  return { count: b.count, items };
}

// ── Classificação de falhas HTTP (diagnóstico) ────────────────────────────────

/** Distingue o tipo de 403/429/5xx sem presumir que todo 403 é bloqueio geográfico. */
export function classifyHttpFailure(status: number, bodyText = ""): { kind: FailureKind; message: string } {
  const t = bodyText.toLowerCase();
  if (status === 403) {
    if (t.includes("cloudfront") && (t.includes("block access from your country") || t.includes("blocked by your country")))
      return { kind: "GEOBLOCK_CLOUDFRONT", message: "Bloqueio geográfico de borda (CloudFront/CNJ): o IP de origem está fora do Brasil." };
    if (["waf", "access denied", "challenge", "bot detection", "security check"].some((s) => t.includes(s)))
      return { kind: "WAF_BLOCKED_OR_CHALLENGE", message: "Acesso bloqueado por WAF/firewall do CNJ (regras de segurança ou cabeçalhos rejeitados)." };
    return { kind: "FORBIDDEN_POLICY", message: "Acesso negado (HTTP 403) pela API do DJEN." };
  }
  if (status === 429) return { kind: "RATE_LIMITED", message: "Limite de requisições excedido na API do DJEN (HTTP 429)." };
  if (status >= 500) return { kind: "SERVER_ERROR", message: `Instabilidade nos servidores do DJEN (HTTP ${status}).` };
  if (status === 400) return { kind: "BAD_REQUEST", message: "Parâmetros rejeitados pela API do DJEN (HTTP 400)." };
  return { kind: "INVALID_RESPONSE", message: `Resposta inesperada da API do DJEN (HTTP ${status}).` };
}

/** `Retry-After` em segundos ("2") ou data HTTP; devolve segundos (inteiro ≥ 0) ou undefined. */
function parseRetryAfter(h: string | null, nowMs: number): number | undefined {
  if (h === null || h.trim() === "") return undefined;
  if (/^\d+$/.test(h.trim())) return Number(h.trim());
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.ceil((t - nowMs) / 1000));
}

// ── Coleta de uma janela ──────────────────────────────────────────────────────

/**
 * Coleta TODAS as comunicações de uma OAB em um dia. Retorna só quando a janela está completa e
 * consistente; qualquer outra coisa lança `SourceError` e o chamador mantém o checkpoint onde estava.
 */
export async function collectDay(attorney: Attorney, date: string, options: CollectOptions = {}): Promise<DayResult> {
  const o = { ...DEFAULTS, ...options };
  const want = normalizeAttorney(attorney);
  day(date);
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const base = (options.baseUrl ?? DJEN_BASE_URL).replace(/\/+$/, "");
  const started = now();
  const left = () => o.budgetMs - (now() - started);

  const items: DjenItem[] = [];
  const seen = new Set<number>();
  let expected: number | undefined;
  let remaining: number | undefined;
  let status = 200;
  let pages = 0;

  for (let pagina = 1; ; pagina++) {
    if (pagina > o.maxPages)
      throw new SourceError(`Orçamento de ${o.maxPages} páginas estourado; a janela será repetida.`, 0, "BUDGET_EXCEEDED");

    const url =
      `${base}/comunicacao?` +
      new URLSearchParams({
        numeroOab: want.oab,
        ufOab: want.uf,
        dataDisponibilizacaoInicio: date,
        dataDisponibilizacaoFim: date,
        pagina: String(pagina),
        itensPorPagina: String(o.pageSize),
      }).toString();

    let body: unknown;
    for (let attempt = 1; ; attempt++) {
      if (left() <= 0) throw new SourceError(`Orçamento de ${o.budgetMs / 1000}s estourado; a janela será repetida.`, 0, "BUDGET_EXCEEDED");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(o.requestTimeoutMs, Math.max(1, left())));
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await fetcher(url, {
          signal: ctrl.signal,
          headers: { Accept: "application/json", "User-Agent": "AdvController/1.0 (monitoramento DJEN)" },
        });
      } catch (e) {
        netErr = e;
      } finally {
        clearTimeout(timer);
      }

      if (!res) {
        const aborted = (netErr as Error)?.name === "AbortError";
        if (attempt >= o.maxAttempts)
          throw new SourceError(
            aborted ? "Tempo limite esgotado ao consultar o DJEN." : `Falha de rede ao consultar o DJEN: ${(netErr as Error)?.message ?? "erro desconhecido"}`,
            aborted ? 408 : 0,
            aborted ? "TIMEOUT" : "NETWORK_ERROR",
          );
        await sleep(o.retryDelayMs * attempt);
        continue;
      }

      status = res.status;
      if (res.status === 403) {
        // Nunca repetir nem tratar como vazio: é bloqueio, não ausência de dados.
        const c = classifyHttpFailure(403, await res.text().catch(() => ""));
        throw new SourceError(c.message, 403, c.kind);
      }
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get("retry-after"), now()) ?? o.defaultRetryAfterSec;
        if (wait * 1000 > left())
          throw new SourceError(`DJEN pediu espera de ${wait}s (HTTP 429), acima do orçamento da janela.`, 429, "RATE_LIMITED", wait);
        if (attempt >= o.maxAttempts)
          throw new SourceError("Limite de requisições excedido na API do DJEN (HTTP 429).", 429, "RATE_LIMITED", wait);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= o.maxAttempts) {
          const c = classifyHttpFailure(res.status);
          throw new SourceError(c.message, res.status, c.kind);
        }
        await sleep(o.retryDelayMs * attempt);
        continue;
      }
      if (!res.ok) {
        const c = classifyHttpFailure(res.status, await res.text().catch(() => ""));
        throw new SourceError(c.message, res.status, c.kind);
      }
      try {
        body = await res.json();
      } catch {
        throw new SourceError("Resposta do DJEN não é um JSON válido.", res.status, "INVALID_RESPONSE");
      }
      const rl = res.headers.get("x-ratelimit-remaining");
      if (rl !== null && /^\d+$/.test(rl)) remaining = Number(rl);
      break;
    }

    pages++;
    const pg = validatePage(body, attorney, date);
    if (expected === undefined) expected = pg.count;
    else if (pg.count !== expected)
      throw new SourceError(`Total DJEN mudou durante a paginação (${expected} → ${pg.count}); a janela será repetida.`, status, "INCONSISTENT_SOURCE");

    if (pg.items.length === 0 && items.length < expected)
      throw new SourceError(`Página vazia (página ${pagina}) antes de completar o total (${items.length}/${expected}).`, status, "INCONSISTENT_SOURCE");

    for (const it of pg.items) {
      if (seen.has(it.id)) throw new SourceError(`ID repetido entre páginas (${it.id}); a janela não será concluída.`, status, "INCONSISTENT_SOURCE");
      seen.add(it.id);
      items.push(it);
    }
    if (items.length > expected)
      throw new SourceError(`A fonte devolveu mais itens (${items.length}) que o total informado (${expected}).`, status, "INCONSISTENT_SOURCE");
    if (items.length === expected) return { count: expected, items, status, pages, remaining };

    if (o.pageDelayMs > 0) await sleep(o.pageDelayMs);
  }
}
