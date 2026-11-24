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
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
    // Alvo das chaves estrangeiras compostas das tabelas filhas: garante que o filho e o pai são do MESMO escritório.
    unique("attorneys_org_id_unique").on(t.organizationId, t.id),
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


// ───────────────────── Publicações do DJEN (docs/REGRAS_DE_NEGOCIO.md) ─────────────────────
//
// Todas as tabelas abaixo têm `organization_id`, RLS forçado e privilégios mínimos para `adv_app`
// (migração 0004). Chaves estrangeiras entre tabelas de domínio são COMPOSTAS (organization_id, id):
// o banco recusa um vínculo entre escritórios mesmo que uma política fosse esquecida.

/**
 * Uma comunicação oficial = UMA linha por escritório, única por (escritório, ID oficial da fonte).
 * Reimportar não duplica nem apaga status/notas/providência (a camada de coleta faz ON CONFLICT DO NOTHING).
 *
 * Ciclo de vida: ativa → arquivada (`archived_at`) → descartada (`removed_at`, "tombstone").
 * O tombstone é a MESMA linha com teor, payload bruto, nº do processo, notas e destinatários apagados:
 * sobra só o identificador mínimo, para que reimportar insira 0 linhas. Um tombstone nunca volta
 * (gatilho em 0004) e só nasce de uma publicação arquivada (CHECK).
 */
export const publications = pgTable(
  "publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** ID oficial da comunicação no DJEN (texto: preserva o valor exato). */
    sourceId: text("source_id").notNull(),
    sourceHash: text("source_hash"),
    tribunal: text("tribunal"),
    judgingBody: text("judging_body"),
    processNumber: text("process_number"),
    processMask: text("process_mask"),
    className: text("class_name"),
    communicationType: text("communication_type"),
    /** Teor. Sempre exibido escapado (REGRAS §8). Nulo apenas em tombstone. */
    originalText: text("original_text"),
    medium: text("medium"),
    /** Só http/https (safeUrl no adaptador). */
    sourceUrl: text("source_url"),
    /** Destinatários [{nome, polo}]: usados no casamento dos termos de interesse. Nulo em tombstone. */
    recipients: jsonb("recipients"),
    availableOn: date("available_on", { mode: "string" }),
    /** Não inferida: nula quando a fonte não traz (REGRAS §7). */
    publishedOn: date("published_on", { mode: "string" }),
    status: text("status").notNull().default("a_revisar"),
    notes: text("notes"),
    actionNote: text("action_note"),
    /** Item bruto da fonte, para auditoria/reprocessamento. Nulo em tombstone. */
    rawPayload: jsonb("raw_payload"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
    removedAt: ts("removed_at"),
  },
  (t) => [
    unique("publications_org_source_unique").on(t.organizationId, t.sourceId),
    unique("publications_org_id_unique").on(t.organizationId, t.id),
    // Listagem padrão: ativas do escritório, mais recentes primeiro.
    index("publications_org_active_idx")
      .on(t.organizationId, t.availableOn.desc(), t.id)
      .where(sql`${t.archivedAt} is null and ${t.removedAt} is null`),
    index("publications_org_archived_idx")
      .on(t.organizationId, t.archivedAt)
      .where(sql`${t.archivedAt} is not null and ${t.removedAt} is null`),
    index("publications_org_status_idx")
      .on(t.organizationId, t.status)
      .where(sql`${t.archivedAt} is null and ${t.removedAt} is null`),
    index("publications_org_tribunal_idx").on(t.organizationId, t.tribunal),
    check("publications_source_id_chk", sql`${t.sourceId} ~ '^[1-9][0-9]{0,17}$'`),
    check("publications_status_chk", sql`${t.status} in ('a_revisar', 'em_analise', 'concluida')`),
    check("publications_notes_len_chk", sql`char_length(${t.notes}) <= 20000`),
    check("publications_action_note_len_chk", sql`char_length(${t.actionNote}) <= 2000`),
    check("publications_text_len_chk", sql`char_length(${t.originalText}) <= 2000000`),
    check("publications_source_url_chk", sql`${t.sourceUrl} is null or ${t.sourceUrl} ~* '^https?://'`),
    check("publications_available_on_chk", sql`${t.availableOn} is null or ${t.availableOn} >= date '2000-01-01'`),
    // Publicação viva (não descartada) tem os campos essenciais.
    check(
      "publications_live_chk",
      sql`${t.removedAt} is not null or (${t.originalText} is not null and ${t.availableOn} is not null)`,
    ),
    // Tombstone: só o identificador mínimo; e só nasce de publicação arquivada.
    check(
      "publications_tombstone_chk",
      sql`${t.removedAt} is null or (
        ${t.archivedAt} is not null
        and ${t.originalText} is null and ${t.rawPayload} is null and ${t.recipients} is null
        and ${t.processNumber} is null and ${t.processMask} is null
        and ${t.notes} is null and ${t.actionNote} is null and ${t.sourceUrl} is null
      )`,
    ),
  ],
).enableRLS();

/** Vínculo N:N: uma comunicação que atinge duas OABs é UMA linha e DOIS vínculos. Apagado no descarte. */
export const publicationAttorneys = pgTable(
  "publication_attorneys",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    publicationId: uuid("publication_id").notNull(),
    attorneyId: uuid("attorney_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "publication_attorneys_pk", columns: [t.publicationId, t.attorneyId] }),
    foreignKey({
      name: "publication_attorneys_publication_fk",
      columns: [t.organizationId, t.publicationId],
      foreignColumns: [publications.organizationId, publications.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "publication_attorneys_attorney_fk",
      columns: [t.organizationId, t.attorneyId],
      foreignColumns: [attorneys.organizationId, attorneys.id],
    }).onDelete("cascade"),
    index("publication_attorneys_attorney_idx").on(t.organizationId, t.attorneyId),
  ],
).enableRLS();

/**
 * Checkpoint de coleta POR OAB (docs/MIGRACAO.md §4). Só avança depois que a janela inteira foi
 * gravada. Lease com fencing: `lease_id` é trocado a cada claim; um commit com lease antigo/expirado é recusado.
 */
export const syncCursors = pgTable(
  "sync_cursors",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    attorneyId: uuid("attorney_id").primaryKey(),
    /** Próximo dia a coletar. */
    scanDay: date("scan_day", { mode: "string" }),
    /** Último dia a alcançar nesta rodada (hoje em America/Sao_Paulo). */
    targetDay: date("target_day", { mode: "string" }),
    lastCompleteDay: date("last_complete_day", { mode: "string" }),
    lastReconciledOn: date("last_reconciled_on", { mode: "string" }),
    nextDueAt: ts("next_due_at"),
    leaseId: uuid("lease_id"),
    leaseUntil: ts("lease_until"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "sync_cursors_attorney_fk",
      columns: [t.organizationId, t.attorneyId],
      foreignColumns: [attorneys.organizationId, attorneys.id],
    }).onDelete("cascade"),
    index("sync_cursors_org_due_idx").on(t.organizationId, t.nextDueAt),
    check("sync_cursors_lease_chk", sql`(${t.leaseId} is null) = (${t.leaseUntil} is null)`),
    check("sync_cursors_failures_chk", sql`${t.consecutiveFailures} >= 0`),
  ],
).enableRLS();

/** Histórico de execuções (uma janela = um dia × uma OAB). Alimenta o diagnóstico. */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    attorneyId: uuid("attorney_id").notNull(),
    windowDay: date("window_day", { mode: "string" }).notNull(),
    /** 'manual' (Buscar agora) ou 'agendada'. */
    trigger: text("trigger").notNull().default("agendada"),
    status: text("status").notNull().default("executando"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    httpStatus: integer("http_status"),
    pages: integer("pages"),
    itemsFound: integer("items_found"),
    itemsInserted: integer("items_inserted"),
    errorKind: text("error_kind"),
    errorMessage: text("error_message"),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    foreignKey({
      name: "sync_runs_attorney_fk",
      columns: [t.organizationId, t.attorneyId],
      foreignColumns: [attorneys.organizationId, attorneys.id],
    }).onDelete("cascade"),
    index("sync_runs_org_started_idx").on(t.organizationId, t.startedAt.desc()),
    check("sync_runs_status_chk", sql`${t.status} in ('executando', 'sucesso', 'erro')`),
    check("sync_runs_trigger_chk", sql`${t.trigger} in ('manual', 'agendada')`),
    check("sync_runs_error_len_chk", sql`char_length(${t.errorMessage}) <= 2000`),
  ],
).enableRLS();

/**
 * Termos de interesse por escritório (substitui a "sigla fixa" do sistema de origem).
 * A regra de casamento (REGRAS §6) é uma função única, usada por linhas E contadores; vem na tarefa 1.6.
 */
export const interestTerms = pgTable(
  "interest_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("interest_terms_org_term_unique").on(t.organizationId, sql`lower(${t.term})`),
    index("interest_terms_org_idx").on(t.organizationId),
    check("interest_terms_term_chk", sql`char_length(${t.term}) between 2 and 80 and ${t.term} !~ '[[:cntrl:]]'`),
  ],
).enableRLS();

/** Tabelas que pertencem a um escritório e passam por RLS (usado nos testes de guarda e na verificação pós-migração). */
export const TENANT_TABLES = [
  "attorneys",
  "audit_log",
  "publications",
  "publication_attorneys",
  "sync_cursors",
  "sync_runs",
  "interest_terms",
] as const;
