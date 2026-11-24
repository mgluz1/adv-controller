import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { runtimeRoleProblems, verifySecurity, type Query } from "../../src/server/db/preflight.ts";
import { withTenant } from "../../src/server/db/tenant.ts";
import { createTestDb } from "./helpers.ts";

// Papel de RUNTIME (migração 0002): o servidor deixa de conectar como dono do esquema.
// `SET LOCAL ROLE adv_runtime` reproduz os privilégios dessa conexão (tabelas, DDL, BYPASSRLS são
// avaliados pelo papel corrente). O PGlite é processo único e não permite trocar o `session_user`
// (SET SESSION AUTHORIZATION vaza para os testes seguintes), então a permissão de assumir adv_app
// (SET ROLE) é provada à parte por pg_has_role(..., 'SET'), e na prática pelo db:runtime-login/Neon real.
let t: Awaited<ReturnType<typeof createTestDb>>;
const A = "org-a";
const B = "org-b";

const msg = (e: any) => `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
const rejectsWith = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e) => re.test(msg(e)), String(re));

/** Executa `fn` numa transação com os privilégios de adv_runtime (reverte ao final). */
const asRuntime = <T>(fn: (tx: any) => Promise<T>) =>
  t.db.transaction(async (tx) => {
    await tx.execute(sql`set local role adv_runtime`);
    return fn(tx);
  });

/** Query que roda com os privilégios do papel dado, para runtimeRoleProblems/verifySecurity. */
const queryAs =
  (role: string): Query =>
  async (s) =>
    t.client.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      return (await tx.query(s)).rows as Record<string, any>[];
    });

before(async () => {
  t = await createTestDb();
  const now = new Date();
  await t.raw.insert(schema.organization).values([
    { id: A, name: "Escritório A", slug: "a", createdAt: now },
    { id: B, name: "Escritório B", slug: "b", createdAt: now },
  ]);
  await t.raw.insert(schema.attorneys).values([
    { organizationId: A, name: "Advogada A1", oabNumber: "111", uf: "GO" },
    { organizationId: B, name: "Advogado B1", oabNumber: "222", uf: "RJ" },
  ]);
});
after(() => t.client.close());

test("adv_runtime NÃO acessa dados de escritório diretamente (nem com WHERE esquecido)", async () => {
  await rejectsWith(asRuntime((tx) => tx.select().from(schema.attorneys)), /permission denied/i);
  await rejectsWith(asRuntime((tx) => tx.select().from(schema.auditLog)), /permission denied/i);
  await rejectsWith(
    asRuntime((tx) => tx.insert(schema.attorneys).values({ organizationId: A, name: "Direto", oabNumber: "9", uf: "SP" })),
    /permission denied/i,
  );
  await rejectsWith(asRuntime((tx) => tx.execute(sql`delete from public.attorneys`)), /permission denied/i);
});

test("controle positivo: adv_runtime lê e grava as tabelas do Better Auth", async () => {
  const rows = await asRuntime(async (tx) => {
    await tx.insert(schema.user).values({ id: "rt-u1", name: "Runtime", email: "rt@x.test" });
    return tx.select().from(schema.user);
  });
  assert.ok(rows.some((r: any) => r.id === "rt-u1"));
});

test("controle positivo: via withTenant (SET ROLE adv_app) o runtime enxerga só o escritório ativo", async () => {
  const a = await asRuntime(async (tx) => {
    // mesmo caminho de src/server/db/tenant.ts, a partir dos privilégios de adv_runtime
    await tx.execute(sql`select set_config('app.organization_id', ${A}, true)`);
    await tx.execute(sql`set local role adv_app`);
    return tx.select().from(schema.attorneys);
  });
  assert.deepEqual(a.map((r: any) => r.name), ["Advogada A1"]);
});

test("adv_runtime não herda adv_app: sem SET ROLE, nada de domínio", async () => {
  const [r] = (await t.client.query(`select pg_has_role('adv_runtime','adv_app','USAGE') as inherits,
                                           pg_has_role('adv_runtime','adv_app','SET') as can_set`)).rows as any[];
  assert.equal(r.inherits, false);
  assert.equal(r.can_set, true);
});

test("adv_runtime não cria nem altera objetos (não é dono, sem DDL)", async () => {
  await rejectsWith(asRuntime((tx) => tx.execute(sql`create table public.intruso (id int)`)), /permission denied/i);
  await rejectsWith(asRuntime((tx) => tx.execute(sql`alter table public.attorneys disable row level security`)), /must be owner|permission denied/i);
  await rejectsWith(asRuntime((tx) => tx.execute(sql`drop table public."user" cascade`)), /must be owner|permission denied/i);
  await rejectsWith(asRuntime((tx) => tx.execute(sql`create role fugitivo bypassrls`)), /permission denied/i);
});

test("a migração nasce SEM login e SEM senha (segredo não entra em migração)", async () => {
  const [r] = (await t.client.query(
    `select rolcanlogin, rolpassword is null as no_pw from (select r.rolcanlogin, null::text as rolpassword from pg_roles r where r.rolname = 'adv_runtime') x`,
  )).rows as any[];
  assert.equal(r.rolcanlogin, false);
  assert.equal(r.no_pw, true);
});

test("runtimeRoleProblems: adv_runtime é aprovado", async () => {
  assert.deepEqual(await runtimeRoleProblems(queryAs("adv_runtime")), []);
});

test("runtimeRoleProblems: superusuário/dono é reprovado (RLS não o protegeria)", async () => {
  const problems = await runtimeRoleProblems(async (s) => (await t.client.query(s)).rows as Record<string, any>[]);
  const all = problems.join(" | ");
  assert.match(all, /superusuário/);
  assert.match(all, /dono de \d+ tabela/);
  assert.match(all, /diretamente/);
});

test("runtimeRoleProblems: papel comum com leitura direta de attorneys é reprovado", async () => {
  await t.client.exec(`create role curioso nologin; grant usage on schema public to curioso; grant select on public.attorneys to curioso; grant adv_app to curioso`);
  const problems = await runtimeRoleProblems(queryAs("curioso"));
  assert.match(problems.join(" | "), /diretamente/);
  assert.doesNotMatch(problems.join(" | "), /superusuário|dono de/);
});

test("verifySecurity aprova o estado migrado e inclui as verificações do runtime", async () => {
  const checks = await verifySecurity(async (s) => (await t.client.query(s)).rows as Record<string, any>[]);
  assert.ok(checks.some((c) => /adv_runtime existe/.test(c.name)));
  assert.ok(checks.some((c) => /adv_runtime assume adv_app/.test(c.name)));
  for (const c of checks) assert.ok(c.ok, `reprovado: ${c.name}`);
});

test("verifySecurity detecta adv_runtime com poder demais (mutação)", async () => {
  const q: Query = async (s) => (await t.client.query(s)).rows as Record<string, any>[];
  await t.client.exec(`grant select on public.attorneys to adv_runtime`);
  assert.ok((await verifySecurity(q)).some((c) => !c.ok && /adv_runtime assume adv_app/.test(c.name)), "acesso direto não detectado");
  await t.client.exec(`revoke select on public.attorneys from adv_runtime; grant adv_app to adv_runtime with inherit true, set true`);
  assert.ok((await verifySecurity(q)).some((c) => !c.ok && /adv_runtime assume adv_app/.test(c.name)), "herança não detectada");
  await t.client.exec(`grant adv_app to adv_runtime with inherit false, set true`);
  await t.client.exec(`alter role adv_runtime bypassrls`);
  assert.ok((await verifySecurity(q)).some((c) => !c.ok && /adv_runtime existe/.test(c.name)), "BYPASSRLS não detectado");
  await t.client.exec(`alter role adv_runtime nobypassrls`);
  for (const c of await verifySecurity(q)) assert.ok(c.ok, `deveria voltar a aprovar: ${c.name}`);
});

test("withTenant continua exigindo escritório válido", async () => {
  await rejectsWith(withTenant(t.db, "", async () => 1), /organizationId inválido/);
});
