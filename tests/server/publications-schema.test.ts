import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { withTenant } from "../../src/server/db/tenant.ts";
import { runtimeRoleProblems, type Query } from "../../src/server/db/preflight.ts";
import { createTestDb } from "./helpers.ts";

// Esquema de publicações (migrações 0003 + 0004): isolamento, deduplicação, N:N, ciclo de vida
// (arquivar → restaurar → descartar/tombstone), privilégios mínimos e integridade no próprio banco.
let t: Awaited<ReturnType<typeof createTestDb>>;
const A = "org-a";
const B = "org-b";
let a1: string, a2: string, b1: string;

const msg = (e: any) => `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
const rejectsWith = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e) => re.test(msg(e)), String(re));
const RLS = /row-level security/i;
const CHECK = /check constraint|violates check/i;
const DENIED = /permission denied/i;
const UNIQUE = /unique|duplicate/i;
const FK = /foreign key|violates/i;

let seq = 100;
const pub = (org: string, over: Record<string, unknown> = {}) => ({
  organizationId: org,
  sourceId: String(++seq),
  tribunal: "TJGO",
  processNumber: "0001234-56.2026.8.09.0001",
  originalText: "Intimação <b>teor</b>",
  availableOn: "2026-10-19",
  recipients: [{ nome: "FULANO", polo: "A" }],
  rawPayload: { id: seq },
  ...over,
});

before(async () => {
  t = await createTestDb();
  const now = new Date();
  await t.raw.insert(schema.organization).values([
    { id: A, name: "Escritório A", slug: "a", createdAt: now },
    { id: B, name: "Escritório B", slug: "b", createdAt: now },
  ]);
  const ats = await t.raw
    .insert(schema.attorneys)
    .values([
      { organizationId: A, name: "Advogada A1", oabNumber: "111", uf: "GO" },
      { organizationId: A, name: "Advogado A2", oabNumber: "222", uf: "RJ" },
      { organizationId: B, name: "Advogado B1", oabNumber: "111", uf: "GO" },
    ])
    .returning();
  [a1, a2, b1] = ats.map((x) => x.id);
});
after(() => t.client.close());

/** Termo de teste: o conteúdo do padrão é irrelevante para estas verificações de esquema (a regra está em interest.test.ts). */
const term = (organizationId: string, t: string) => ({ organizationId, term: t, pattern: `p:${t}` });
const insertPub = (org: string, over: Record<string, unknown> = {}) =>
  withTenant(t.db, org, (tx) => tx.insert(schema.publications).values(pub(org, over) as any).returning());

// ── Isolamento ────────────────────────────────────────────────────────────────

test("publicações: cada escritório enxerga só as suas, mesmo sem WHERE", async () => {
  await insertPub(A, { sourceId: "9001" });
  await insertPub(B, { sourceId: "9002" });
  const a = await withTenant(t.db, A, (tx) => tx.select().from(schema.publications));
  const b = await withTenant(t.db, B, (tx) => tx.select().from(schema.publications));
  assert.ok(a.length >= 1 && a.every((r) => r.organizationId === A));
  assert.ok(b.length >= 1 && b.every((r) => r.organizationId === B));
  assert.ok(!a.some((r) => r.sourceId === "9002") && !b.some((r) => r.sourceId === "9001"));
});

test("não grava em outro escritório (WITH CHECK) em NENHUMA das tabelas novas", async () => {
  await rejectsWith(insertPub(B).then(() => insertPubAs(A, B)), RLS);
  await rejectsWith(
    withTenant(t.db, A, (tx) =>
      tx.insert(schema.interestTerms).values(term(B, "X.Y.Z.")),
    ),
    RLS,
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) =>
      tx.insert(schema.syncRuns).values({ organizationId: B, attorneyId: b1, windowDay: "2026-10-19" }),
    ),
    RLS,
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.insert(schema.syncCursors).values({ organizationId: B, attorneyId: b1 })),
    RLS,
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) =>
      tx.insert(schema.publicationAttorneys).values({ organizationId: B, publicationId: crypto.randomUUID(), attorneyId: b1 }),
    ),
    RLS,
  );
});
const insertPubAs = (ctx: string, target: string) =>
  withTenant(t.db, ctx, (tx) => tx.insert(schema.publications).values(pub(target) as any));

test("UPDATE em lote só alcança o próprio escritório e não move linha de escritório", async () => {
  const r = await withTenant(t.db, A, (tx) =>
    tx.update(schema.publications).set({ notes: "marca" }).where(sql`true`).returning({ org: schema.publications.organizationId }),
  );
  assert.ok(r.length >= 1 && r.every((x) => x.org === A));
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ organizationId: B }).where(sql`true`)),
    /row-level security|identidade/i,
  );
  const b = await withTenant(t.db, B, (tx) => tx.select().from(schema.publications));
  assert.ok(b.every((x) => x.notes !== "marca"));
});

test("vínculo entre escritórios é impossível NO BANCO, mesmo para quem ignora o RLS (FK composta)", async () => {
  const [pa] = await insertPub(A);
  // Superusuário (ignora RLS): ainda assim a chave composta recusa publicação de A com OAB de B.
  await rejectsWith(
    t.raw.insert(schema.publicationAttorneys).values({ organizationId: A, publicationId: pa.id, attorneyId: b1 }),
    FK,
  );
  await rejectsWith(
    t.raw.insert(schema.publicationAttorneys).values({ organizationId: B, publicationId: pa.id, attorneyId: b1 }),
    FK,
  );
  await rejectsWith(t.raw.insert(schema.syncCursors).values({ organizationId: A, attorneyId: b1 }), FK);
  await rejectsWith(
    t.raw.insert(schema.syncRuns).values({ organizationId: A, attorneyId: b1, windowDay: "2026-10-19" }),
    FK,
  );
});

// ── Deduplicação e N:N ────────────────────────────────────────────────────────

test("deduplicação: mesmo ID oficial no mesmo escritório = 1 linha; reimportar preserva status e notas", async () => {
  const [p] = await insertPub(A, { sourceId: "7001" });
  await withTenant(t.db, A, (tx) =>
    tx.update(schema.publications).set({ status: "em_analise", notes: "manual", actionNote: "ligar" }).where(eq(schema.publications.id, p.id)),
  );
  const again = await withTenant(t.db, A, (tx) =>
    tx
      .insert(schema.publications)
      .values(pub(A, { sourceId: "7001", originalText: "REIMPORTADO" }) as any)
      .onConflictDoNothing({ target: [schema.publications.organizationId, schema.publications.sourceId] })
      .returning(),
  );
  assert.equal(again.length, 0);
  const [now] = await withTenant(t.db, A, (tx) => tx.select().from(schema.publications).where(eq(schema.publications.sourceId, "7001")));
  assert.deepEqual([now.status, now.notes, now.actionNote, now.originalText], ["em_analise", "manual", "ligar", "Intimação <b>teor</b>"]);
  await rejectsWith(insertPub(A, { sourceId: "7001" }), UNIQUE);
});

test("o MESMO ID oficial pode existir em escritórios diferentes", async () => {
  await insertPub(A, { sourceId: "7002" });
  await insertPub(B, { sourceId: "7002" });
});

test("N:N: uma comunicação que atinge duas OABs = 1 linha e 2 vínculos; vínculo repetido é recusado", async () => {
  const [p] = await insertPub(A, { sourceId: "7003" });
  await withTenant(t.db, A, (tx) =>
    tx.insert(schema.publicationAttorneys).values([
      { organizationId: A, publicationId: p.id, attorneyId: a1 },
      { organizationId: A, publicationId: p.id, attorneyId: a2 },
    ]),
  );
  const links = await withTenant(t.db, A, (tx) =>
    tx.select().from(schema.publicationAttorneys).where(eq(schema.publicationAttorneys.publicationId, p.id)),
  );
  assert.equal(links.length, 2);
  await rejectsWith(
    withTenant(t.db, A, (tx) =>
      tx.insert(schema.publicationAttorneys).values({ organizationId: A, publicationId: p.id, attorneyId: a1 }),
    ),
    UNIQUE,
  );
  // reimportar pela segunda OAB não duplica: o vínculo existente é preservado
  const dup = await withTenant(t.db, A, (tx) =>
    tx.insert(schema.publicationAttorneys).values({ organizationId: A, publicationId: p.id, attorneyId: a2 }).onConflictDoNothing().returning(),
  );
  assert.equal(dup.length, 0);
});

// ── Ciclo de vida: arquivar → restaurar → descartar (tombstone) ───────────────

const tombstone = (id: string) =>
  withTenant(t.db, A, (tx) =>
    tx
      .update(schema.publications)
      .set({
        removedAt: new Date(),
        originalText: null, rawPayload: null, recipients: null, processNumber: null, processMask: null,
        notes: null, actionNote: null, sourceUrl: null,
      })
      .where(eq(schema.publications.id, id))
      .returning(),
  );

test("arquivar e restaurar preservam teor, notas e vínculos; reimportar arquivada continua arquivada", async () => {
  const [p] = await insertPub(A, { sourceId: "8001", notes: "n" });
  await withTenant(t.db, A, (tx) => tx.insert(schema.publicationAttorneys).values({ organizationId: A, publicationId: p.id, attorneyId: a1 }));
  await withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ archivedAt: new Date() }).where(eq(schema.publications.id, p.id)));
  const re = await withTenant(t.db, A, (tx) =>
    tx.insert(schema.publications).values(pub(A, { sourceId: "8001" }) as any).onConflictDoNothing().returning(),
  );
  assert.equal(re.length, 0);
  const [arq] = await withTenant(t.db, A, (tx) => tx.select().from(schema.publications).where(eq(schema.publications.id, p.id)));
  assert.ok(arq.archivedAt && arq.notes === "n" && arq.originalText);
  await withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ archivedAt: null }).where(eq(schema.publications.id, p.id)));
  const links = await withTenant(t.db, A, (tx) => tx.select().from(schema.publicationAttorneys).where(eq(schema.publicationAttorneys.publicationId, p.id)));
  assert.equal(links.length, 1);
});

test("tombstone: só de publicação arquivada, sem conteúdo, irreversível e sem vínculos", async () => {
  const [p] = await insertPub(A, { sourceId: "8002", notes: "sigilo" });
  await withTenant(t.db, A, (tx) => tx.insert(schema.publicationAttorneys).values({ organizationId: A, publicationId: p.id, attorneyId: a1 }));

  // 1) não nasce de publicação ativa
  await rejectsWith(tombstone(p.id), CHECK);
  await withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ archivedAt: new Date() }).where(eq(schema.publications.id, p.id)));
  // 2) descartar SEM apagar o conteúdo é recusado
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ removedAt: new Date() }).where(eq(schema.publications.id, p.id))),
    CHECK,
  );
  // 3) descartar apagando o conteúdo funciona; os vínculos são apagados pelo próprio escritório
  const [ts] = await tombstone(p.id);
  assert.ok(ts.removedAt && ts.originalText === null && ts.notes === null && ts.rawPayload === null && ts.processNumber === null);
  await withTenant(t.db, A, (tx) => tx.delete(schema.publicationAttorneys).where(eq(schema.publicationAttorneys.publicationId, p.id)));
  // 4) irreversível: não restaura, não reescreve, não vincula OAB
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ archivedAt: null, removedAt: null }).where(eq(schema.publications.id, p.id))),
    /imut|integrity|descartad/i,
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ notes: "volta" }).where(eq(schema.publications.id, p.id))),
    /imut|integrity|descartad/i,
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.insert(schema.publicationAttorneys).values({ organizationId: A, publicationId: p.id, attorneyId: a2 })),
    /vincular|integrity/i,
  );
  // 5) reimportar insere 0 linhas
  const re = await withTenant(t.db, A, (tx) =>
    tx.insert(schema.publications).values(pub(A, { sourceId: "8002" }) as any).onConflictDoNothing().returning(),
  );
  assert.equal(re.length, 0);
});

test("a identidade da publicação (ID oficial) não pode ser alterada", async () => {
  const [p] = await insertPub(A, { sourceId: "8003" });
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.publications).set({ sourceId: "8999" }).where(eq(schema.publications.id, p.id))),
    /identidade|integrity/i,
  );
});

// ── Privilégios mínimos ───────────────────────────────────────────────────────

test("adv_app não exclui publicações, cursores, execuções nem termos (só vínculos)", async () => {
  for (const tbl of [schema.publications, schema.syncCursors, schema.syncRuns, schema.interestTerms])
    await rejectsWith(withTenant(t.db, A, (tx) => tx.delete(tbl)), DENIED);
  await withTenant(t.db, A, (tx) => tx.delete(schema.publicationAttorneys).where(sql`false`)); // permitido
});

test("adv_runtime (login do servidor) não alcança NENHUMA tabela de domínio diretamente", async () => {
  for (const tbl of schema.TENANT_TABLES)
    await rejectsWith(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role adv_runtime`);
        return tx.execute(sql.raw(`select count(*) from public."${tbl}"`));
      }),
      DENIED,
    );
  const q: Query = async (s) =>
    t.client.transaction(async (tx) => {
      await tx.exec("set local role adv_runtime");
      return (await tx.query(s)).rows as Record<string, any>[];
    });
  assert.deepEqual(await runtimeRoleProblems(q), []);
});

// ── Integridade (CHECK / UNIQUE) ──────────────────────────────────────────────

test("restrições rejeitam dados inválidos mesmo sem passar pela API", async () => {
  const bad: Record<string, unknown>[] = [
    { sourceId: "0123" },
    { sourceId: "12a" },
    { sourceId: "" },
    { sourceId: "1234567890123456789" },
    { status: "inventado" },
    { sourceUrl: "javascript:alert(1)" },
    { originalText: null },
    { availableOn: null },
    { availableOn: "1999-12-31" },
    { notes: "x".repeat(20001) },
    { actionNote: "x".repeat(2001) },
  ];
  for (const b of bad) await rejectsWith(insertPub(A, { sourceId: String(++seq), ...b }), CHECK);
  await insertPub(A, { sourceUrl: "https://www.cnj.jus.br/x", publishedOn: null });
});

test("termos de interesse: únicos por escritório sem diferenciar maiúsculas; limites; sem controle", async () => {
  await withTenant(t.db, A, (tx) => tx.insert(schema.interestTerms).values(term(A, "A.B.C.D.")));
  await rejectsWith(withTenant(t.db, A, (tx) => tx.insert(schema.interestTerms).values(term(A, "a.b.c.d."))), UNIQUE);
  await withTenant(t.db, B, (tx) => tx.insert(schema.interestTerms).values(term(B, "A.B.C.D."))); // outro escritório pode
  for (const bad of ["x", "x".repeat(81), "tem\nquebra", "tem\u0001nulo"])
    await rejectsWith(withTenant(t.db, A, (tx) => tx.insert(schema.interestTerms).values(term(A, bad))), CHECK);
  const a = await withTenant(t.db, A, (tx) => tx.select().from(schema.interestTerms));
  assert.ok(a.every((r) => r.organizationId === A));
});

test("cursor e execuções: lease coerente, status e gatilho de coleta válidos; um cursor por OAB", async () => {
  await withTenant(t.db, A, (tx) => tx.insert(schema.syncCursors).values({ organizationId: A, attorneyId: a1, scanDay: "2026-10-19" }));
  await rejectsWith(withTenant(t.db, A, (tx) => tx.insert(schema.syncCursors).values({ organizationId: A, attorneyId: a1 })), UNIQUE);
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.syncCursors).set({ leaseId: crypto.randomUUID() }).where(eq(schema.syncCursors.attorneyId, a1))),
    CHECK,
  );
  await withTenant(t.db, A, (tx) =>
    tx.update(schema.syncCursors).set({ leaseId: crypto.randomUUID(), leaseUntil: new Date(Date.now() + 60_000) }).where(eq(schema.syncCursors.attorneyId, a1)),
  );
  await rejectsWith(
    withTenant(t.db, A, (tx) => tx.update(schema.syncCursors).set({ consecutiveFailures: -1 }).where(eq(schema.syncCursors.attorneyId, a1))),
    CHECK,
  );
  const [run] = await withTenant(t.db, A, (tx) =>
    tx.insert(schema.syncRuns).values({ organizationId: A, attorneyId: a1, windowDay: "2026-10-19" }).returning(),
  );
  assert.equal(run.status, "executando");
  await withTenant(t.db, A, (tx) =>
    tx.update(schema.syncRuns).set({ status: "sucesso", finishedAt: new Date(), httpStatus: 200, itemsFound: 2, itemsInserted: 2 }).where(eq(schema.syncRuns.id, run.id)),
  );
  for (const bad of [{ status: "ok" }, { trigger: "cron" }])
    await rejectsWith(withTenant(t.db, A, (tx) => tx.update(schema.syncRuns).set(bad as any).where(eq(schema.syncRuns.id, run.id))), CHECK);
  // o outro escritório não enxerga cursor nem execução
  assert.equal((await withTenant(t.db, B, (tx) => tx.select().from(schema.syncCursors))).length, 0);
  assert.equal((await withTenant(t.db, B, (tx) => tx.select().from(schema.syncRuns))).length, 0);
});

// ── Exclusão do escritório ────────────────────────────────────────────────────

test("excluir o escritório apaga em cascata todos os dados de domínio (inclusive tombstones)", async () => {
  const C = "org-c";
  await t.raw.insert(schema.organization).values({ id: C, name: "Escritório C", slug: "c", createdAt: new Date() });
  const [c1] = await t.raw.insert(schema.attorneys).values({ organizationId: C, name: "Advogado C1", oabNumber: "333", uf: "SP" }).returning();
  const [p] = await withTenant(t.db, C, (tx) => tx.insert(schema.publications).values(pub(C, { sourceId: "6001" }) as any).returning());
  await withTenant(t.db, C, (tx) => tx.insert(schema.publicationAttorneys).values({ organizationId: C, publicationId: p.id, attorneyId: c1.id }));
  await withTenant(t.db, C, (tx) => tx.insert(schema.syncCursors).values({ organizationId: C, attorneyId: c1.id }));
  await withTenant(t.db, C, (tx) => tx.insert(schema.syncRuns).values({ organizationId: C, attorneyId: c1.id, windowDay: "2026-10-19" }));
  await withTenant(t.db, C, (tx) => tx.insert(schema.interestTerms).values(term(C, "Z.Z.")));
  await t.raw.delete(schema.organization).where(eq(schema.organization.id, C));
  for (const tbl of schema.TENANT_TABLES) {
    const r = await t.db.execute(sql.raw(`select count(*)::int as n from public."${tbl}" where organization_id = 'org-c'`));
    assert.equal((r.rows[0] as any).n, 0, `sobrou dado em ${tbl}`);
  }
  // os outros escritórios continuam intactos
  assert.ok((await withTenant(t.db, A, (tx) => tx.select().from(schema.publications))).length > 0);
});

test("guarda: cada tabela nova tem RLS forçado e políticas por operação (e DELETE só nos vínculos)", async () => {
  const rows = (
    await t.db.execute(sql`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             array_agg(p.polcmd order by p.polcmd) filter (where p.polname is not null) as cmds
        from pg_class c left join pg_policy p on p.polrelid = c.oid
       where c.relnamespace = 'public'::regnamespace and c.relname = any(${sql.raw(`array[${schema.TENANT_TABLES.map((x) => `'${x}'`).join(",")}]`)})
       group by c.relname, c.relrowsecurity, c.relforcerowsecurity`)
  ).rows as any[];
  assert.equal(rows.length, schema.TENANT_TABLES.length);
  for (const r of rows) assert.ok(r.rls && r.forced && r.cmds?.length >= 2, `${r.name}: RLS/políticas incompletos`);
  const links = rows.find((r) => r.name === "publication_attorneys");
  assert.ok(links.cmds.includes("d"), "vínculos precisam de política de DELETE (descarte)");
  for (const r of rows.filter((x) => x.name !== "publication_attorneys" && x.name !== "audit_log"))
    assert.ok(!r.cmds.includes("d"), `${r.name} não deveria ter política de DELETE`);
});
