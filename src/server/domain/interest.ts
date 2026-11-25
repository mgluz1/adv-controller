/**
 * Termos de interesse por escritório (docs/REGRAS_DE_NEGOCIO.md §6).
 *
 * Um termo é uma SIGLA (`A.B.C.D.`) ou uma EXPRESSÃO literal. A regra de casamento é UMA só e vive aqui: o termo vira um padrão
 * de expressão regular (POSIX ARE do PostgreSQL), guardado em `interest_terms.pattern` e avaliado no banco com `~*`. Linhas da
 * lista e contadores das abas usam exatamente o mesmo predicado (routes/publications.ts → `interestMatch`).
 *
 * Casa no TEOR ou nos NOMES dos destinatários, sem diferenciar maiúsculas, e só quando o termo está DELIMITADO por não-letras.
 *   sigla "A.B.C.D."  casa:  A.B.C.D.  ·  a.b.c.d.  ·  A. B. C. D.  ·  "RÉU: A.B.C.D. EXEMPLO LTDA"  ·  "...da A.B.C.D" (sem o ponto final)
 *                     não casa:  ABCD LTDA (sem pontos) · A.B.C.DTDA (letra colada depois) · SA.B.C.D. (letra colada antes)
 *                                · A.B.C.D.E. (é outra sigla)
 */
import { ValidationError } from "./oab.ts";

export const MIN_TERM = 2;
export const MAX_TERM = 80;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Fronteiras: início/fim ou um caractere que NÃO é letra (inclui acentuadas, conforme o locale do banco). */
const BEFORE = "(^|[^[:alpha:]])";
const AFTER = "($|[^[:alpha:]])";
const SIGLA = /^(?:\p{L}\s*\.\s*)*\p{L}\s*\.?$/u;

export type TermKind = "sigla" | "expressao";

/** Espaços internos normalizados; 2 a 80 caracteres; sem caracteres de controle. */
export function normalizeTerm(input: unknown): string {
  if (typeof input !== "string") throw new ValidationError("Termo inválido.");
  const t = input.replace(/\s+/g, " ").trim();
  if (t.length < MIN_TERM || t.length > MAX_TERM || CONTROL.test(t))
    throw new ValidationError(`Termo inválido: use de ${MIN_TERM} a ${MAX_TERM} caracteres, sem caracteres de controle.`);
  if (!/[\p{L}\p{N}]/u.test(t)) throw new ValidationError("O termo precisa ter ao menos uma letra ou número.");
  return t;
}

/** Escapa um caractere para dentro de uma ARE (o termo é sempre literal: nunca vira regex do usuário). */
const esc = (c: string) => c.replace(/[\\^$.|?*+()[\]{}\-\/]/g, "\\$&");

/**
 * Padrão de casamento do termo. Determinístico e puro. Sigla: cada letra seguida de ponto, espaços opcionais entre elas
 * (`A.B.C.D` e `A. B. C. D.` são o mesmo termo). Expressão: palavras literais separadas por espaço flexível.
 */
export function termPattern(term: string): { kind: TermKind; pattern: string } {
  const t = normalizeTerm(term);
  if (SIGLA.test(t) && t.includes(".")) {
    const letters = [...t.replace(/[\s.]/g, "")].map((c) => c.toLowerCase());
    // Entre as letras: ponto + espaços opcionais. Depois da ÚLTIMA letra o ponto é opcional ("...A.B.C.D" no fim da frase),
    // mas a sigla continua delimitada: com ponto, o que vem depois não pode ser letra (A.B.C.D.LTDA); sem ponto, não pode ser
    // letra nem ponto (A.B.C.DTDA, A.B.C.D.E.). Perder uma intimação custa mais que uma sobra, por isso o ponto final é tolerado.
    const body = letters.map(esc).join("\\.\\s*");
    return { kind: "sigla", pattern: `${BEFORE}${body}(\\.($|[^[:alpha:]])|($|[^[:alpha:].]))` };
  }
  const words = t.toLowerCase().split(" ").map((w) => [...w].map(esc).join(""));
  return { kind: "expressao", pattern: BEFORE + words.join("\\s+") + AFTER };
}
