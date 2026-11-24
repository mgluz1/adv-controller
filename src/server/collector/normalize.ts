/**
 * Item bruto do DJEN → linha de `publications` (pura, sem banco).
 * O adaptador (djen/client.ts) já garantiu ID, OAB e dia; aqui só se normaliza o conteúdo.
 */
import type * as schema from "../db/schema.ts";
import { safeUrl, type DjenItem } from "../djen/client.ts";

export type PublicationRow = typeof schema.publications.$inferInsert;

/** Teto do teor (o banco recusa acima de 2.000.000). Acima disso corta com marcador explícito, nunca em silêncio. */
export const MAX_TEXT = 1_990_000;
export const TRUNCATED_MARK = "\n\n[… texto truncado pelo sistema: excedeu o tamanho máximo armazenável]";
const MAX_RECIPIENTS = 100;

/** O PostgreSQL não aceita NUL (\u0000) em text/jsonb: um item assim derrubaria a janela inteira. */
export function stripNul<T>(v: T): T {
  if (typeof v === "string") return v.replaceAll("\u0000", "") as T;
  if (Array.isArray(v)) return v.map(stripNul) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[stripNul(k)] = stripNul(x);
    return out as T;
  }
  return v;
}

function text(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = stripNul(v).trim();
  return t === "" ? null : t.slice(0, max);
}

function recipients(v: unknown): { nome: string; polo: string | null }[] | null {
  if (!Array.isArray(v)) return null;
  const out: { nome: string; polo: string | null }[] = [];
  for (const r of v.slice(0, MAX_RECIPIENTS)) {
    const nome = text((r as { nome?: unknown })?.nome, 300);
    if (nome) out.push({ nome, polo: text((r as { polo?: unknown })?.polo, 20) });
  }
  return out;
}

export function toPublicationRow(item: DjenItem, organizationId: string, windowDay: string, now: Date): PublicationRow {
  const i = item as Record<string, unknown>;
  let original = typeof i.texto === "string" ? stripNul(i.texto) : "";
  if (original.trim() === "") original = "(Sem teor de publicação registrado)";
  if (original.length > MAX_TEXT) original = original.slice(0, MAX_TEXT) + TRUNCATED_MARK;
  return {
    organizationId,
    sourceId: String(item.id),
    sourceHash: text(i.hash, 200),
    tribunal: text(i.siglaTribunal, 40),
    judgingBody: text(i.nomeOrgao, 300),
    processNumber: text(i.numero_processo, 60) ?? text(i.numeroprocessocommascara, 60),
    processMask: text(i.numeroprocessocommascara, 60) ?? text(i.numero_processo, 60),
    className: text(i.nomeClasse, 300),
    communicationType: text(i.tipoComunicacao, 120),
    originalText: original,
    medium: text(i.meiocompleto, 300) ?? text(i.meio, 300),
    sourceUrl: safeUrl(i.link),
    recipients: recipients(i.destinatarios),
    availableOn: windowDay, // o adaptador garantiu que o item é deste dia
    publishedOn: null, // nunca inferida (REGRAS §7)
    rawPayload: stripNul(item),
    firstSeenAt: now,
    lastSeenAt: now,
  };
}
