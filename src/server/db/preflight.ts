/**
 * Verificações de destino e plano de migração, independentes do driver.
 * Usado por scripts/db.ts (Neon, via pg) e pelos testes (PGlite). Só LÊ, exceto onde dito.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

export type Query = (sql: string) => Promise<Record<string, any>[]>;

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}
export interface PlannedMigration extends JournalEntry {
  sql: string;
  hash: string;
  statements: string[];
}

export function knownTables(): string[] {
  return (Object.values(schema) as unknown[])
    .filter((v: unknown): v is PgTable => is(v, PgTable))
    .map((t) => getTableName(t))
    .sort();
}

export function readMigrations(folder = "./drizzle"): PlannedMigration[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries.map((e) => {
    const sql = readFileSync(join(folder, `${e.tag}.sql`), "utf8");
    return {
      ...e,
      sql,
      hash: createHash("sha256").update(sql).digest("hex"), // mesmo cálculo do migrador do Drizzle
      statements: sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean),
    };
  });
}

export interface Inspection {
  database: string;
  user: string;
  serverVersion: string;
  publicTables: string[];
  hasJournal: boolean;
  applied: { hash: string; created_at: number }[];
}

export async function inspect(q: Query): Promise<Inspection> {
  const [info] = await q("select current_database() as db, current_user as usr, version() as v");
  const tables = await q(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  );
  const [j] = await q(
    "select count(*)::int as n from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations'",
  );
  const hasJournal = j.n > 0;
  const applied = hasJournal
    ? (await q('select hash, created_at from "drizzle"."__drizzle_migrations" order by created_at')).map((r) => ({
        hash: String(r.hash),
        created_at: Number(r.created_at),
      }))
    : [];
  return {
    database: info.db,
    user: info.usr,
    serverVersion: String(info.v).split(" on ")[0],
    publicTables: tables.map((t) => t.table_name),
    hasJournal,
    applied,
  };
}

export interface Verdict {
  ok: boolean;
  problems: string[];
  warnings: string[];
  pending: PlannedMigration[];
}

/**
 * Decide se é seguro migrar ESTE banco. Recusa quando o destino não parece ser um banco
 * do Adv Controller (proteção contra apontar para o banco errado):
 *  - tabelas existentes sem histórico de migrações do Adv Controller;
 *  - tabelas desconhecidas ao lado do nosso esquema;
 *  - migração já aplicada diferente da versionada no repositório (adulterada/de outro projeto).
 */
export function judge(ins: Inspection, migrations: PlannedMigration[]): Verdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  const known = new Set(knownTables());

  if (!ins.hasJournal && ins.publicTables.length > 0)
    problems.push(
      `O banco "${ins.database}" tem ${ins.publicTables.length} tabela(s) no schema public e nenhum histórico de migrações do Adv Controller. Pode ser o banco errado — nada será aplicado.`,
    );
  const unknown = ins.publicTables.filter((t) => !known.has(t));
  if (ins.hasJournal && unknown.length)
    problems.push(`Tabelas desconhecidas no schema public: ${unknown.join(", ")}.`);

  ins.applied.forEach((a, i) => {
    const mine = migrations[i];
    if (!mine) problems.push(`O banco tem mais migrações aplicadas (${ins.applied.length}) do que o repositório (${migrations.length}).`);
    else if (mine.hash !== a.hash)
      problems.push(`A migração aplicada nº ${i + 1} (${mine.tag}) difere da versionada no repositório.`);
  });

  const last = ins.applied.reduce((m, a) => Math.max(m, a.created_at), 0);
  const pending = migrations.filter((m) => m.when > last);
  if (pending.length === 0) warnings.push("Nenhuma migração pendente.");
  return { ok: problems.length === 0, problems, warnings, pending };
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Pós-migração: confirma as garantias de segurança NO banco real (somente leitura). */
export async function verifySecurity(q: Query): Promise<Check[]> {
  const checks: Check[] = [];
  const [role] = await q(
    "select rolsuper, rolbypassrls, rolcanlogin, rolcreaterole from pg_roles where rolname = 'adv_app'",
  );
  checks.push({
    name: "papel adv_app existe sem superusuário/BYPASSRLS/login/CREATEROLE",
    ok: !!role && !role.rolsuper && !role.rolbypassrls && !role.rolcanlogin && !role.rolcreaterole,
  });
  const [canSet] = await q("select pg_has_role(current_user, 'adv_app', 'MEMBER') as ok");
  checks.push({ name: "o papel de conexão pode assumir adv_app (SET ROLE)", ok: !!canSet?.ok });
  for (const t of ["attorneys", "audit_log"]) {
    const [r] = await q(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = '${t}'`,
    );
    checks.push({
      name: `${t}: RLS habilitado e forçado, com políticas`,
      ok: !!r && r.rls && r.forced && r.policies > 0,
      detail: r ? `políticas=${r.policies}` : "tabela ausente",
    });
  }
  const [priv] = await q(
    `select bool_or(has_table_privilege('adv_app', format('public.%I', tablename), 'SELECT')) as leak
       from pg_tables where schemaname = 'public'
        and tablename in ('user','session','account','verification','organization','member','invitation','rate_limit')`,
  );
  checks.push({ name: "adv_app sem acesso às tabelas do Better Auth", ok: priv?.leak === false });
  const [del] = await q(
    `select has_table_privilege('adv_app', 'public.attorneys', 'DELETE') as a,
            has_table_privilege('adv_app', 'public.audit_log', 'UPDATE') as b,
            has_table_privilege('adv_app', 'public.audit_log', 'DELETE') as c`,
  );
  checks.push({ name: "adv_app não exclui OABs nem altera/exclui auditoria", ok: !del.a && !del.b && !del.c });

  // Papel de runtime (migração 0002): sem privilégios especiais, sem acesso direto a dados de escritório.
  const [rt] = await q(
    "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'adv_runtime'",
  );
  checks.push({
    name: "papel adv_runtime existe sem superusuário/BYPASSRLS/CREATEROLE/CREATEDB",
    ok: !!rt && !rt.rolsuper && !rt.rolbypassrls && !rt.rolcreaterole && !rt.rolcreatedb,
  });
  const [rtScope] = await q(
    `select
       (pg_has_role('adv_runtime', 'adv_app', 'SET')) as can_set,
       (pg_has_role('adv_runtime', 'adv_app', 'USAGE')) as inherits,
       (select count(*)::int from pg_tables where schemaname = 'public' and tableowner = 'adv_runtime') as owned,
       (has_table_privilege('adv_runtime', 'public.attorneys', 'SELECT,INSERT,UPDATE,DELETE')
         or has_table_privilege('adv_runtime', 'public.audit_log', 'SELECT,INSERT,UPDATE,DELETE')) as direct`,
  );
  checks.push({
    name: "adv_runtime assume adv_app só via SET ROLE (sem herdar), não é dono de tabelas e não acessa dados de escritório direto",
    ok: !!rtScope && rtScope.can_set === true && rtScope.inherits === false && rtScope.owned === 0 && rtScope.direct === false,
  });
  return checks;
}

/**
 * Executada na conexão de RUNTIME (a do servidor): reprova credencial com poder demais.
 * Dono de tabelas, superusuário ou BYPASSRLS tornam o RLS inútil se algum código esquecer `withTenant`.
 * Lista só problemas; quem chama decide se é fatal (produção) ou aviso (desenvolvimento).
 */
export async function runtimeRoleProblems(q: Query): Promise<string[]> {
  const problems: string[] = [];
  const [r] = await q(
    `select current_user as usr, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
            (select count(*)::int from pg_tables where schemaname = 'public' and tableowner = current_user) as owned,
            (to_regclass('public.attorneys') is not null
              and has_table_privilege(current_user, 'public.attorneys', 'SELECT')) as direct_read,
            pg_has_role(current_user, 'adv_app', 'SET') as can_set
       from pg_roles r where r.rolname = current_user`,
  );
  if (!r) return ["não foi possível identificar o papel de conexão."];
  const who = `"${r.usr}"`;
  if (r.rolsuper) problems.push(`${who} é superusuário.`);
  if (r.rolbypassrls) problems.push(`${who} tem BYPASSRLS.`);
  if (r.rolcreaterole || r.rolcreatedb) problems.push(`${who} pode criar papéis/bancos.`);
  if (r.owned > 0) problems.push(`${who} é dono de ${r.owned} tabela(s): o RLS não o protege contra um WHERE esquecido.`);
  if (r.direct_read) problems.push(`${who} lê dados de escritório diretamente (fora de withTenant).`);
  if (!r.can_set) problems.push(`${who} não pode assumir adv_app (SET ROLE): withTenant falharia.`);
  return problems;
}
