/**
 * Migrações no Neon, com validação de destino.
 *
 *   npm run db:target                         descreve e valida o destino (somente leitura)
 *   npm run db:plan                           + mostra o que SERIA aplicado (dry-run, não altera nada)
 *   npm run db:migrate -- --confirm-host=<host> --confirm-project=adv-controller
 *                                             aplica as migrações pendentes e verifica a segurança
 *
 * Usa DATABASE_URL_UNPOOLED (endpoint direto) ou, se ausente, DATABASE_URL. Lê .env.local.
 * Nunca imprime a senha. Recusa Supabase, TLS ausente e bancos que não parecem ser do Adv Controller.
 */
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { assertSafeDatabaseUrl, parseEnv } from "../src/server/env.ts";
import { inspect, judge, readMigrations, verifySecurity, type Query } from "../src/server/db/preflight.ts";

config({ path: [".env.local", ".env"], quiet: true });
const [cmd = "target", ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
function fail(m: string): never {
  console.error(`\n✗ ${m}`);
  process.exit(1);
}

let env: ReturnType<typeof parseEnv>;
try {
  env = parseEnv();
} catch (e) {
  fail((e as Error).message);
}
const url = env.databaseUrlUnpooled ?? env.databaseUrl;
if (!url) fail("Defina DATABASE_URL_UNPOOLED (ou DATABASE_URL) em .env.local com a conexão do projeto Neon 'adv-controller'.");
let target: ReturnType<typeof assertSafeDatabaseUrl>;
try {
  target = assertSafeDatabaseUrl(url!);
} catch (e) {
  fail((e as Error).message);
}
if (!target.isNeon && !target.isLocal) fail(`O host "${target.host}" não é do Neon (*.neon.tech) nem local. Nada foi feito.`);

console.log("Destino");
console.log(`  host     : ${target.host}${target.isPooled ? "  (POOLER)" : ""}`);
console.log(`  banco    : ${target.database}`);
console.log(`  usuário  : ${target.user}`);
console.log(`  TLS      : ${target.sslmode || "(local)"}`);
if (target.isPooled) console.log("  ! Endpoint com pooler. Para migrações prefira o endpoint direto (DATABASE_URL_UNPOOLED).");

const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000, application_name: "adv-controller-migrate" });
const q: Query = async (sql) => (await pool.query(sql)).rows;

try {
  const ins = await inspect(q);
  console.log(`  servidor : ${ins.serverVersion}`);
  console.log(`  conectado: banco "${ins.database}" como "${ins.user}"`);
  console.log(`  tabelas  : ${ins.publicTables.length} no schema public; histórico de migrações: ${ins.hasJournal ? ins.applied.length + " aplicada(s)" : "nenhum"}`);

  const migrations = readMigrations();
  const v = judge(ins, migrations);
  for (const w of v.warnings) console.log(`  · ${w}`);
  if (!v.ok) {
    for (const p of v.problems) console.error(`  ✗ ${p}`);
    fail("Destino reprovado na validação.");
  }
  console.log("  ✓ Destino validado.");

  if (cmd === "target") process.exit(0);

  console.log(`\nMigrações pendentes (${v.pending.length}):`);
  for (const m of v.pending) {
    console.log(`\n  ${m.tag}.sql — ${m.statements.length} instrução(ões)`);
    for (const s of m.statements) console.log("    " + s.replace(/\s+/g, " ").slice(0, 110));
  }

  if (cmd === "plan") {
    console.log("\nDry-run: nada foi alterado. Para aplicar:");
    console.log(`  npm run db:migrate -- --confirm-host=${target.host} --confirm-project=adv-controller`);
    process.exit(0);
  }

  if (cmd !== "apply" && cmd !== "migrate") fail(`Comando desconhecido: ${cmd}`);
  if (flag("confirm-host") !== target.host) fail(`Confirmação ausente ou incorreta. Use --confirm-host=${target.host}`);
  if (flag("confirm-project") !== "adv-controller")
    fail("Confirme que o banco pertence ao projeto Neon 'adv-controller': --confirm-project=adv-controller");
  if (v.pending.length === 0) {
    console.log("\nNada a aplicar.");
  } else {
    console.log("\nAplicando…");
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle", migrationsSchema: "drizzle", migrationsTable: "__drizzle_migrations" });
    console.log("✓ Migrações aplicadas.");
  }
  console.log("\nVerificação de segurança no banco:");
  const checks = await verifySecurity(q);
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  if (checks.some((c) => !c.ok)) fail("Verificação de segurança reprovada.");
} catch (e) {
  fail(`Erro: ${(e as Error).message.replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgresql://***@")}`);
} finally {
  await pool.end().catch(() => {});
}
