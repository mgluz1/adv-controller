import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/server/db/schema.ts";
import { TENANT_TABLES } from "../../src/server/db/schema.ts";
import { withTenant } from "../../src/server/db/tenant.ts";
import { createTestDb } from "./helpers.ts";

// Segurança NO BANCO: mesmo com uma consulta sem WHERE, o papel de aplicação só alcança o escritório ativo.
let t: Awaited<ReturnType<typeof createTestDb>>;
const A = "org-a";
const B = "org-b";

const msg = (e: any) => `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
const rejectsWith = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e) => re.test(msg(e)), String(re));

before(async () => {
  t = await createTestDb();
  const now = new Date();
  await t.raw.insert(schema.user).values([
    { id: "u1", name: "Um", email: "u1@x.test" },
    { id: "u2", name: "Dois", email: "u2@x.test" },
  ]);
  await t.raw.insert(schema.organization).values([
    { id: A, name: "Escritório A", slug: "a", createdAt: now },
    { id: B, name: "Escritório B", slug: "b", createdAt: now },
  ]);
  await t.raw.insert(schema.attorneys).values([
    { organizationId: A, name: "Advogada A1", oabNumber: "111", uf: "GO" },
    { organizationId: B, name: "Advogado B1", oabNumber: "111", uf: "GO" }, // mesma OAB, outro escritório
    { organizationId: B, name: "Advogado B2", oabNumber: "222", uf: "RJ" },
  ]);
  await t.raw.insert(schema.auditLog).values([
    { organizationId: A, action: "x.a" },
    { organizationId: B, action: "x.b" },
  ]);
});
after(() => t.client.close());

test("sem escritório definido, o papel de aplicação não enxerga nada", async () => {
  const rows = await t.db.transaction(async (tx) => {
    await tx.execute(sql`set local role adv_app`);
    return tx.select().from(schema.attorneys);
  });
  assert.equal(rows.length, 0);
});

test("escritório vazio ('') equivale a nenhum escritório", async () => {
  const rows = await t.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', '', true)`);
    await tx.execute(sql`set local role adv_app`);
    return tx.select().from(schema.attorneys);
  });
  assert.equal(rows.length, 0);
});

test("withTenant enxerga só o próprio escritório, mesmo sem WHERE", async () => {
  const a = await withTenant(t.db, A, (tx) => tx.select().from(schema.attorneys));
  const b = await withTenant(t.db, B, (tx) => tx.select().from(schema.attorneys));
  assert.deepEqual(a.map((r) => r.name), ["Advogada A1"]);
  assert.deepEqual(b.map((r) => r.name).sort(), ["Advogado B1", "Advogado B2"]);
});

test("não é possível gravar em outro escritório (WITH CHECK)", async () => {
  await rejectsWith(
    withTenant(t.db, A, (tx) =>
      tx.insert(schema.attorneys).values({ organizationId: B, name: "Intruso", oabNumber: "999", uf: "SP" }),
    ),
    /row-level security/i,
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) =>
      tx.insert(schema.auditLog).values({ organizationId: B, action: "forjado" }),
    ),
    /row-level security/i,
  );
});

test("UPDATE de linha de outro escritório não afeta nada; não dá para mover linha de escritório", async () => {
  const r = await withTenant(t.db, A, (tx) =>
    tx.update(schema.attorneys).set({ name: "Hackeado" }).where(sql`true`).returning(),
  );
  assert.equal(r.length, 1); // só a do A
  assert.equal(r[0].organizationId, A);
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.attorneys).set({ organizationId: B }).where(sql`true`)),
    /row-level security/i,
  );
  const b = await withTenant(t.db, B, (tx) => tx.select().from(schema.attorneys));
  assert.ok(b.every((x) => !x.name.includes("Hackeado")));
});

test("o papel de aplicação não pode excluir OABs", async () => {
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.delete(schema.attorneys)),
    /permission denied/i,
  );
});

test("trilha de auditoria é somente-inserção e isolada por escritório", async () => {
  const a = await withTenant(t.db, A, (tx) => tx.select().from(schema.auditLog));
  assert.deepEqual(a.map((r) => r.action), ["x.a"]);
  await withTenant(t.db, A, (tx) => tx.insert(schema.auditLog).values({ organizationId: A, action: "ok" }));
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.auditLog).set({ action: "adulterado" })),
    /permission denied/i,
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.delete(schema.auditLog)),
    /permission denied/i,
  );
});

test("o papel de aplicação não tem acesso às tabelas do Better Auth", async () => {
  for (const table of ["user", "session", "account", "verification", "organization", "member", "invitation", "rate_limit"])
    await rejectsWith(
      withTenant(t.db, A, (tx) => tx.execute(sql.raw(`select * from "${table}"`))),
      /permission denied/i,
    );
});

test("fora de withTenant o papel volta ao original (sem vazamento de papel entre requisições)", async () => {
  const before = await t.db.execute(sql`select current_user as u`);
  await withTenant(t.db, A, (tx) => tx.select().from(schema.attorneys));
  const after = await t.db.execute(sql`select current_user as u`);
  assert.deepEqual(after.rows[0], before.rows[0]);
  assert.notEqual((after.rows[0] as any).u, "adv_app");
});

test("adv_app não é superusuário, não ignora RLS e não é dono de nenhuma tabela", async () => {
  const role = await t.db.execute(
    sql`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname = 'adv_app'`,
  );
  assert.deepEqual(role.rows[0], {
    rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false,
  });
  const owned = await t.db.execute(sql`select tablename from pg_tables where schemaname='public' and tableowner='adv_app'`);
  assert.equal(owned.rows.length, 0);
});

test("GUARDA: toda tabela com organization_id tem RLS forçado + política, ou é inacessível a adv_app", async () => {
  const tables = await t.db.execute(sql`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
           bool_or(has_table_privilege('adv_app', c.oid, 'SELECT') or has_table_privilege('adv_app', c.oid, 'INSERT')
                or has_table_privilege('adv_app', c.oid, 'UPDATE') or has_table_privilege('adv_app', c.oid, 'DELETE')) as app_access
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
    where c.relkind = 'r'
    group by c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity`);
  const found = (tables.rows as any[]).map((r) => r.name);
  for (const r of tables.rows as any[]) {
    const safe = (r.rls && r.forced && r.policies > 0) || !r.app_access;
    assert.ok(safe, `tabela ${r.name} tem organization_id mas não está protegida`);
  }
  // As tabelas de domínio declaradas no esquema precisam estar, de fato, protegidas por RLS.
  for (const name of TENANT_TABLES) {
    const r = (tables.rows as any[]).find((x) => x.name === name);
    assert.ok(r, `tabela ${name} não encontrada`);
    assert.ok(r.rls && r.forced && r.policies > 0, `tabela ${name} sem RLS forçado`);
  }
  assert.ok(found.includes("attorneys") && found.includes("audit_log"));
});

test("restrições do banco rejeitam OAB/UF/nome inválidos mesmo sem passar pela API", async () => {
  const bad = [
    { name: "Nome Válido", oabNumber: "0123", uf: "GO" },
    { name: "Nome Válido", oabNumber: "12345678", uf: "GO" },
    { name: "Nome Válido", oabNumber: "123", uf: "go" },
    { name: "Nome Válido", oabNumber: "12a", uf: "GO" },
    { name: "ab", oabNumber: "123", uf: "GO" },
  ];
  for (const v of bad)
    await rejectsWith(
      withTenant(t.db, A, (tx) => tx.insert(schema.attorneys).values({ organizationId: A, ...v })),
      /check constraint|violates/i,
    );
  await rejectsWith(
    withTenant(t.db, A, (tx) =>
      tx.insert(schema.attorneys).values({ organizationId: A, name: "Duplicada", oabNumber: "111", uf: "GO" }),
    ),
    /unique|duplicate/i,
  );
});

test("migrações são idempotentes (reaplicar não altera nada)", async () => {
  await migrate(t.raw, { migrationsFolder: "./drizzle" });
});
