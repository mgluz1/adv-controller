import test from "node:test";
import assert from "node:assert/strict";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/server/db/schema.ts";
import { inspect, judge, knownTables, readMigrations, verifySecurity, type Query } from "../../src/server/db/preflight.ts";

const fresh = () => {
  const client = new PGlite();
  const q: Query = async (s) => (await client.query(s)).rows as Record<string, any>[];
  return { client, q, db: drizzle(client, { schema }) };
};

test("migrações versionadas: ordem, hashes e instruções", () => {
  const m = readMigrations();
  assert.deepEqual(m.map((x) => x.tag), ["0000_base", "0001_tenant_security"]);
  assert.ok(m.every((x) => /^[0-9a-f]{64}$/.test(x.hash) && x.statements.length > 0));
  assert.ok(m[0].when < m[1].when);
});

test("banco vazio: destino aprovado e todas as migrações pendentes", async () => {
  const { q, client } = fresh();
  const v = judge(await inspect(q), readMigrations());
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.pending.length, 2);
  await client.close();
});

test("depois de migrar: hashes do banco = hashes do repositório (nada pendente) e segurança verificada", async () => {
  const { q, client, db } = fresh();
  await migrate(db, { migrationsFolder: "./drizzle" });
  const ins = await inspect(q);
  assert.equal(ins.hasJournal, true);
  const v = judge(ins, readMigrations());
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.pending.length, 0);
  const checks = await verifySecurity(q);
  assert.ok(checks.length >= 6);
  for (const c of checks) assert.ok(c.ok, `reprovado: ${c.name}`);
  await client.close();
});

test("destino errado: banco com tabelas e sem histórico do Adv Controller é REPROVADO", async () => {
  const { q, client } = fresh();
  await client.exec(`create table public.clientes (id int primary key); create table public.processos (id int)`);
  const v = judge(await inspect(q), readMigrations());
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /banco errado/);
  await client.close();
});

test("tabela desconhecida ao lado do nosso esquema é reprovada", async () => {
  const { q, client, db } = fresh();
  await migrate(db, { migrationsFolder: "./drizzle" });
  await client.exec(`create table public.sobra (id int)`);
  const v = judge(await inspect(q), readMigrations());
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /sobra/);
  await client.close();
});

test("migração aplicada diferente da versionada (adulterada/de outro projeto) é reprovada", async () => {
  const { q, client, db } = fresh();
  await migrate(db, { migrationsFolder: "./drizzle" });
  await client.exec(`update drizzle.__drizzle_migrations set hash = 'adulterado' where id = 1`);
  const v = judge(await inspect(q), readMigrations());
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /difere/);
  await client.close();
});

test("a verificação de segurança detecta RLS desligado e privilégio excessivo", async () => {
  const { q, client, db } = fresh();
  await migrate(db, { migrationsFolder: "./drizzle" });
  await client.exec(`alter table public.attorneys no force row level security`);
  assert.ok((await verifySecurity(q)).some((c) => !c.ok && /attorneys/.test(c.name)));
  await client.exec(`alter table public.attorneys force row level security; grant delete on public.attorneys to adv_app`);
  assert.ok((await verifySecurity(q)).some((c) => !c.ok && /não exclui/.test(c.name)));
  await client.exec(`revoke delete on public.attorneys from adv_app; grant select on public."user" to adv_app`);
  assert.ok((await verifySecurity(q)).some((c) => !c.ok && /Better Auth/.test(c.name)));
  await client.close();
});

test("esquema Drizzle e migrações não divergem (tabelas e colunas idênticas)", async () => {
  const { q, client, db } = fresh();
  await migrate(db, { migrationsFolder: "./drizzle" });
  const dbTables = (await q(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).map((r) => r.table_name);
  assert.deepEqual(dbTables, knownTables());
  for (const t of Object.values(schema) as unknown[]) {
    if (!is(t, PgTable)) continue;
    const name = getTableName(t);
    const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='${name}' order by 1`)).map((r) => r.column_name);
    const expected = Object.values(getTableColumns(t)).map((c: any) => c.name).sort();
    assert.deepEqual(cols, expected, `colunas de ${name}`);
  }
  await client.close();
});
