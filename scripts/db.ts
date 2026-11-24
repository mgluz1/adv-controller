/**
 * Migrações no Neon, com validação de destino.
 *
 *   npm run db:target                         descreve e valida o destino (somente leitura)
 *   npm run db:plan                           + mostra o que SERIA aplicado (dry-run, não altera nada)
 *   npm run db:migrate -- --confirm-host=<host> --confirm-project=adv-controller
 *                                             aplica as migrações pendentes e verifica a segurança
 *   npm run db:runtime-login -- --confirm-host=<host> --confirm-project=adv-controller
 *                                             habilita o login do papel adv_runtime com senha nova e grava
 *                                             DATABASE_URL (pooler) em .env.local. Rodar de novo ROTACIONA a senha
 *
 * Usa SOMENTE DATABASE_URL_UNPOOLED (endpoint direto, credencial de MIGRAÇÃO = dono do esquema).
 * DATABASE_URL é a credencial de RUNTIME (adv_runtime) e nunca é usada aqui. Lê .env.local.
 * Nunca imprime a senha. Recusa Supabase, TLS ausente e bancos que não parecem ser do Adv Controller.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { assertSafeDatabaseUrl, parseEnv } from "../src/server/env.ts";
import { inspect, judge, readMigrations, runtimeRoleProblems, verifySecurity, type Query } from "../src/server/db/preflight.ts";

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
// Sem fallback para DATABASE_URL: aquela é a credencial de runtime, sem poder de migrar.
const url = env.databaseUrlUnpooled;
if (!url) fail("Defina DATABASE_URL_UNPOOLED em .env.local: conexão DIRETA do projeto Neon 'adv-controller' com o papel dono do esquema (migração).");
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

function requireConfirmations() {
  if (flag("confirm-host") !== target.host) fail(`Confirmação ausente ou incorreta. Use --confirm-host=${target.host}`);
  if (flag("confirm-project") !== "adv-controller")
    fail("Confirme que o banco pertence ao projeto Neon 'adv-controller': --confirm-project=adv-controller");
}

/** Grava/atualiza uma variável em .env.local (arquivo ignorado pelo Git) com permissão 600. */
function upsertEnvLocal(name: string, value: string) {
  const file = ".env.local";
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const line = `${name}=${value}`;
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = line;
  else lines.push(line);
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Habilita o login de adv_runtime com senha aleatória nova; a senha vai só para .env.local. */
async function runtimeLogin() {
  const [r] = await q("select 1 as ok from pg_roles where rolname = 'adv_runtime'");
  if (!r) fail("O papel adv_runtime não existe. Aplique a migração 0002_runtime_role antes.");
  const password = randomBytes(24).toString("base64url"); // [A-Za-z0-9_-]: seguro dentro de literal SQL
  await pool.query(`ALTER ROLE adv_runtime LOGIN PASSWORD '${password}'`);

  // Endpoint com pooler: mesmo host com "-pooler" no primeiro rótulo.
  const u = new URL(url!);
  const [first, ...restHost] = u.hostname.split(".");
  const poolerHost = first.endsWith("-pooler") ? u.hostname : [`${first}-pooler`, ...restHost].join(".");
  const runtime = new URL(url!);
  runtime.hostname = poolerHost;
  runtime.username = "adv_runtime";
  runtime.password = password;
  runtime.searchParams.set("sslmode", "require");
  upsertEnvLocal("DATABASE_URL", runtime.toString());
  console.log(`\n✓ adv_runtime habilitado. DATABASE_URL (${poolerHost}) gravada em .env.local (permissão 600). Senha NÃO exibida.`);

  // Prova em conexão nova, pela mesma rota que o servidor usa.
  const rt = new pg.Pool({ connectionString: runtime.toString(), max: 1, connectionTimeoutMillis: 20_000 });
  try {
    const problems = await runtimeRoleProblems(async (s) => (await rt.query(s)).rows);
    if (problems.length) {
      for (const p of problems) console.error(`  ✗ ${p}`);
      fail("A credencial de runtime foi reprovada.");
    }
    console.log("  ✓ Conexão de runtime validada: não é dono, não é superusuário, sem BYPASSRLS, sem acesso direto a dados de escritório, assume adv_app.");
  } finally {
    await rt.end().catch(() => {});
  }
}

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

  if (cmd === "runtime-login") {
    requireConfirmations();
    if (v.pending.length > 0) fail("Há migrações pendentes. Rode db:migrate antes: o papel adv_runtime vem da migração 0002.");
    await runtimeLogin();
    process.exit(0);
  }

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
  requireConfirmations();
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
