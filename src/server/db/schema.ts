/**
 * Esquema do banco (Neon PostgreSQL) — Drizzle ORM.
 *
 * Duas famílias de tabelas:
 *  1. Tabelas do Better Auth (user, session, account, verification, organization, member,
 *     invitation, rateLimit). Os NOMES DAS EXPORTAÇÕES devem permanecer iguais aos modelos do
 *     Better Auth; um teste (tests/server/schema-drift.test.ts) compara este arquivo com as tabelas
 *     que a biblioteca exige em runtime. "organization" = escritório (tenant).
 *  2. Tabelas de domínio, SEMPRE com `organization_id`, RLS habilitado e forçado (ver a migração
 *     de segurança em drizzle/). Só são acessadas pelo papel `adv_app`, dentro de `withTenant()`.
 *
 * Migrações: `npm run db:generate` (versionadas em drizzle/). Não edite migrações já aplicadas.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

// ───────────────────────── Better Auth ─────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Escritório ativo da sessão. NÃO é confiado: toda requisição revalida a associação.
    activeOrganizationId: text("active_organization_id"),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/** Escritório (tenant). */
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: ts("created_at").notNull(),
  metadata: text("metadata"),
});

/** Usuário ↔ escritório, com papel (owner | admin | member | viewer). */
export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("member_org_user_unique").on(t.organizationId, t.userId),
    index("member_user_id_idx").on(t.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("invitation_org_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);

/** Limitador de taxa do Better Auth (storage "database"). */
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// ───────────────────────── Domínio (multi-escritório) ─────────────────────────

/**
 * OABs monitoradas, por escritório. A mesma OAB pode existir em escritórios diferentes
 * (cada um enxerga só a sua); dentro de um escritório (uf, número) é único.
 * Nunca excluída: desativada (`active=false`), para não perder o vínculo com publicações futuras.
 */
export const attorneys = pgTable(
  "attorneys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    oabNumber: text("oab_number").notNull(),
    uf: text("uf").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("attorneys_org_uf_oab_unique").on(t.organizationId, t.uf, t.oabNumber),
    index("attorneys_org_idx").on(t.organizationId),
    check("attorneys_oab_number_chk", sql`${t.oabNumber} ~ '^[1-9][0-9]{0,6}$'`),
    check("attorneys_uf_chk", sql`${t.uf} ~ '^[A-Z]{2}$'`),
    check(
      "attorneys_name_chk",
      sql`char_length(${t.name}) between 3 and 120`,
    ),
  ],
).enableRLS();

/** Trilha de auditoria. Somente inserção (o papel de aplicação não tem UPDATE/DELETE). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.organizationId, t.createdAt),
    check("audit_log_action_chk", sql`char_length(${t.action}) between 1 and 80`),
  ],
).enableRLS();

/** Tabelas que pertencem a um escritório e passam por RLS (usado nos testes de guarda). */
export const TENANT_TABLES = ["attorneys", "audit_log"] as const;
