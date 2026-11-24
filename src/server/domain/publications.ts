/**
 * Validação das entradas das operações de publicações (puras, sem banco).
 * Contrato: docs/MIGRACAO.md §3. Qualquer valor fora do esperado vira ValidationError (HTTP 400):
 * nada é "corrigido em silêncio" nem repassado ao banco sem validar.
 */
import { assertUuid, ValidationError } from "./oab.ts";

export const STATUSES = ["a_revisar", "em_analise", "concluida"] as const;
export type Status = (typeof STATUSES)[number];

/** Tamanho máximo de lote em djen_mutate e da prévia (mesmo teto da interface: 1.000). */
export const MAX_BATCH = 1000;
export const MAX_NOTES = 20_000;
export const MAX_ACTION_NOTE = 2_000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Data AAAA-MM-DD real (rejeita 2026-02-31). */
export function parseDay(value: unknown, label = "data"): string {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) throw new ValidationError(`${label} inválida: use AAAA-MM-DD.`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || y < 2000)
    throw new ValidationError(`${label} inexistente.`);
  return value as string;
}

export interface ListFilter {
  /** "todos" ou o id (uuid) de uma OAB. A aba "interesse" chega na tarefa 1.6. */
  attorney: "todos" | string;
  status: "todos" | Status;
  search?: string;
  start?: string;
  end?: string;
  order: "asc" | "desc";
  limit: number;
  offset: number;
  tribunal?: string;
  archived: boolean;
}

function optionalText(v: unknown, label: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${label} inválido.`);
  const t = v.trim();
  if (t === "") return undefined;
  if (t.length > max || CONTROL.test(t)) throw new ValidationError(`${label} inválido.`);
  return t;
}

function optionalInt(v: unknown, label: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new ValidationError(`${label} inválido: use um inteiro de ${min} a ${max}.`);
  return v;
}

export function parseListFilter(input: unknown): ListFilter {
  if (input === undefined || input === null) input = {};
  if (!isObj(input)) throw new ValidationError("Filtro inválido.");
  const f = input;

  let attorney: string = "todos";
  if (f.attorney !== undefined && f.attorney !== null && f.attorney !== "todos") {
    if (f.attorney === "interesse")
      throw new ValidationError("A aba de termos de interesse ainda não está disponível.");
    attorney = assertUuid(f.attorney, "advogado");
  }

  let status: ListFilter["status"] = "todos";
  if (f.status !== undefined && f.status !== null && f.status !== "todos") {
    if (typeof f.status !== "string" || !(STATUSES as readonly string[]).includes(f.status))
      throw new ValidationError("Status inválido.");
    status = f.status as Status;
  }

  const start = f.start === undefined || f.start === null || f.start === "" ? undefined : parseDay(f.start, "Data inicial");
  const end = f.end === undefined || f.end === null || f.end === "" ? undefined : parseDay(f.end, "Data final");
  if (start && end && start > end) throw new ValidationError("A data inicial é posterior à final.");

  let order: ListFilter["order"] = "desc";
  if (f.order !== undefined && f.order !== null) {
    if (f.order !== "asc" && f.order !== "desc") throw new ValidationError("Ordenação inválida.");
    order = f.order;
  }
  if (f.archived !== undefined && f.archived !== null && typeof f.archived !== "boolean")
    throw new ValidationError("Valor de 'archived' inválido.");

  return {
    attorney,
    status,
    search: optionalText(f.search, "Busca", 200),
    start,
    end,
    order,
    limit: optionalInt(f.limit, "Limite", 1, MAX_LIMIT, DEFAULT_LIMIT),
    offset: optionalInt(f.offset, "Deslocamento", 0, 1_000_000, 0),
    tribunal: optionalText(f.tribunal, "Tribunal", 40),
    archived: f.archived === true,
  };
}

/** Escapa curingas do LIKE: a busca é por texto literal ("100%" não casa tudo). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const ACTIONS = ["status", "archive", "restore", "remove"] as const;
export type Action = (typeof ACTIONS)[number];

export interface MutateInput {
  action: Action;
  /** IDs OFICIAIS da fonte (texto), sem repetição. */
  ids: string[];
  status?: Status;
  /** undefined = não alterar; null = limpar. */
  notes?: string | null;
  providence?: string | null;
}

const SOURCE_ID = /^[1-9][0-9]{0,17}$/;

/** Texto livre de anotação: vazio limpa; controle e excesso são recusados (não truncados). */
function freeText(v: unknown, label: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new ValidationError(`${label} inválido.`);
  const t = v.replace(/\r\n/g, "\n").trim();
  if (t.length > max) throw new ValidationError(`${label} muito longo (máximo ${max} caracteres).`);
  if (CONTROL.test(t)) throw new ValidationError(`${label} contém caracteres inválidos.`);
  return t === "" ? null : t;
}

export function parseMutate(body: Record<string, unknown>): MutateInput {
  const action = body.p_action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action))
    throw new ValidationError("Ação inválida.");
  const raw = body.p_ids;
  if (!Array.isArray(raw)) throw new ValidationError("Informe a lista de publicações (p_ids).");
  if (raw.length > MAX_BATCH)
    throw new ValidationError(`Lote grande demais: no máximo ${MAX_BATCH} publicações por operação.`);
  const ids = new Set<string>();
  for (const id of raw) {
    const s = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id;
    if (typeof s !== "string" || !SOURCE_ID.test(s)) throw new ValidationError("Identificador de publicação inválido.");
    ids.add(s);
  }

  const out: MutateInput = { action: action as Action, ids: [...ids] };
  if (action === "status") {
    if (body.p_status !== undefined && body.p_status !== null) {
      if (typeof body.p_status !== "string" || !(STATUSES as readonly string[]).includes(body.p_status))
        throw new ValidationError("Status inválido.");
      out.status = body.p_status as Status;
    }
    out.notes = freeText(body.p_notes, "Observações", MAX_NOTES);
    out.providence = freeText(body.p_providence, "Providência", MAX_ACTION_NOTE);
    if (out.status === undefined && out.notes === undefined && out.providence === undefined)
      throw new ValidationError("Nada para atualizar.");
  }
  return out;
}

export function parsePreviewDate(body: Record<string, unknown>): string {
  return parseDay(body.p_date, "Data de corte");
}
