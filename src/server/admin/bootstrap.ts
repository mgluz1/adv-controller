/**
 * Criação administrativa do PRIMEIRO usuário (dono de um escritório) quando o cadastro aberto está desligado (padrão em
 * produção). Roda no servidor/CLI com acesso ao banco: não há endpoint HTTP para isto, de propósito.
 * O operador é a prova de posse do e-mail, por isso o e-mail já nasce verificado.
 */
import { eq, sql } from "drizzle-orm";
import type { Auth } from "../auth.ts";
import * as schema from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { ValidationError } from "../domain/oab.ts";

export interface CreateOwnerInput {
  email: string;
  name: string;
  password: string;
  /** Se informado, cria também o escritório e torna o usuário seu dono. */
  office?: string;
}

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

export function slugify(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "escritorio";
}

export function validatePerson(i: { name: unknown; password: unknown }): { name: string; password: string } {
  const name = typeof i.name === "string" ? i.name.replace(/\s+/g, " ").trim() : "";
  // eslint-disable-next-line no-control-regex
  if (name.length < 2 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new ValidationError("Nome inválido: use de 2 a 120 caracteres.");
  if (typeof i.password !== "string" || i.password.length < 10 || i.password.length > 128)
    throw new ValidationError("Senha inválida: use de 10 a 128 caracteres.");
  return { name, password: i.password };
}

export function validateOwnerInput(i: CreateOwnerInput): CreateOwnerInput {
  const email = typeof i.email === "string" ? i.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) throw new ValidationError("E-mail inválido.");
  const { name, password } = validatePerson(i);
  let office: string | undefined;
  if (i.office !== undefined) {
    office = typeof i.office === "string" ? i.office.replace(/\s+/g, " ").trim() : "";
    // eslint-disable-next-line no-control-regex
    if (office.length < 2 || office.length > 120 || /[\u0000-\u001f\u007f]/.test(office)) throw new ValidationError("Nome do escritório inválido: use de 2 a 120 caracteres.");
  }
  return { email, name, password, office };
}

/**
 * Cria usuário com e-mail JÁ verificado, pela via interna (não passa pelo cadastro público, que pode estar fechado).
 * Só para quem JÁ provou a posse do e-mail por outro meio: o operador (CLI) ou o portador do link do convite.
 */
export async function createVerifiedUser(auth: Auth, u: { email: string; name: string; password: string }): Promise<{ id: string }> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: u.email, name: u.name, emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(u.password) });
  return { id: user.id };
}

export async function createOwner({ auth, db }: { auth: Auth; db: Db }, input: CreateOwnerInput): Promise<{ userId: string; organizationId?: string; slug?: string }> {
  const v = validateOwnerInput(input);
  const [exists] = await db.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${v.email}`).limit(1);
  if (exists) throw new ValidationError("Já existe um usuário com este e-mail.");

  // A API pública de cadastro respeita o cadastro fechado; o operador usa a via interna (mesmo hash de senha do login).
  const user = await createVerifiedUser(auth, v);
  if (!v.office) return { userId: user.id };

  // Slug único: o Better Auth recusa repetição, então tentamos com sufixo.
  const base = slugify(v.office);
  for (let n = 0; n < 20; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const [taken] = await db.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.slug, slug)).limit(1);
    if (taken) continue;
    const org = await auth.api.createOrganization({ body: { name: v.office, slug, userId: user.id } });
    return { userId: user.id, organizationId: org!.id, slug };
  }
  throw new ValidationError("Não foi possível gerar um identificador único para o escritório.");
}
