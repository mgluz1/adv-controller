/** Regras de validação de OAB e nome de advogado (puras, sem banco). */

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
] as const;

export class ValidationError extends Error {}

/** "12.345", " 012345 " → "12345". Só dígitos, 1 a 7, sem zeros à esquerda. */
export function normalizeOabNumber(input: unknown): string {
  if (typeof input !== "string" && typeof input !== "number")
    throw new ValidationError("Número da OAB inválido.");
  const digits = String(input).replace(/[.\s]/g, "").replace(/^0+/, "");
  if (!/^[1-9][0-9]{0,6}$/.test(digits))
    throw new ValidationError("Número da OAB inválido: use de 1 a 7 dígitos.");
  return digits;
}

export function normalizeUf(input: unknown): string {
  const uf = typeof input === "string" ? input.trim().toUpperCase() : "";
  if (!(UFS as readonly string[]).includes(uf))
    throw new ValidationError("UF inválida.");
  return uf;
}

/** Nome de 3 a 120 caracteres, sem caracteres de controle, espaços internos normalizados. */
export function normalizeName(input: unknown): string {
  if (typeof input !== "string") throw new ValidationError("Nome inválido.");
  const name = input.replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  if (name.length < 3 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name))
    throw new ValidationError("Nome inválido: use de 3 a 120 caracteres.");
  return name;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(input: unknown, label = "id"): string {
  if (typeof input !== "string" || !UUID.test(input))
    throw new ValidationError(`${label} inválido.`);
  return input.toLowerCase();
}
