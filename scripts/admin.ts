/**
 * Administração do produto (sem endpoint HTTP, de propósito).
 *
 *   npm run admin:create-owner -- --confirm-host=<host> --email=<e-mail> --name="<nome>" [--office="<escritório>"]
 *
 * Cria o PRIMEIRO usuário (com e-mail já verificado) e, se pedido, o escritório do qual ele é dono: é como se entra em produção, onde o
 * cadastro aberto vem desligado. A senha vem de ADMIN_PASSWORD ou de um prompt sem eco; NUNCA é impressa nem passada em argumento.
 * Conecta com DATABASE_URL (papel de runtime). Exige --confirm-host igual ao host do banco (proteção contra apontar para o banco errado).
 */
import { config } from "dotenv";
import { createOwner } from "../src/server/admin/bootstrap.ts";
import { createAuth } from "../src/server/auth.ts";
import { connect } from "../src/server/db/client.ts";
import { ValidationError } from "../src/server/domain/oab.ts";
import { assertSafeDatabaseUrl, parseEnv } from "../src/server/env.ts";

config({ path: [".env.local", ".env"], quiet: true });
const [cmd = "", ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
function fail(m: string): never {
  console.error(`\n✗ ${m}`);
  process.exit(1);
}

/** Lê a senha sem eco (TTY) ou de ADMIN_PASSWORD. */
async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) fail("Sem terminal interativo: defina ADMIN_PASSWORD no ambiente (nunca em argumento).");
  process.stdout.write("Senha (10 a 128 caracteres, não aparece na tela): ");
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

if (cmd !== "create-owner") fail('Comando desconhecido. Use: create-owner --confirm-host=<host> --email=<e-mail> --name="<nome>" [--office="<escritório>"]');

let env: ReturnType<typeof parseEnv>;
try {
  env = parseEnv();
} catch (e) {
  fail((e as Error).message);
}
if (!env.databaseUrl) fail("Defina DATABASE_URL em .env.local (conexão de runtime, papel adv_runtime).");
if (!env.authSecret) fail("Defina BETTER_AUTH_SECRET em .env.local.");
let target: ReturnType<typeof assertSafeDatabaseUrl>;
try {
  target = assertSafeDatabaseUrl(env.databaseUrl);
} catch (e) {
  fail((e as Error).message); // Supabase, sem TLS, URL inválida: mensagem sem senha
}
if (!target.isNeon && !target.isLocal) fail(`O host "${target.host}" não é do Neon nem local. Nada foi feito.`);
if (flag("confirm-host") !== target.host) fail(`Confirmação ausente ou incorreta. Use --confirm-host=${target.host}`);
const email = flag("email");
const name = flag("name");
if (!email || !name) fail("Informe --email e --name.");

console.log("Destino");
console.log(`  host     : ${target.host}${target.isPooled ? "  (POOLER)" : ""}`);
console.log(`  banco    : ${target.database}`);
console.log(`  usuário  : ${target.user}`);

const password = await readPassword();
const conn = connect(env.databaseUrl);
try {
  const auth = createAuth({ db: conn.db, env });
  const r = await createOwner({ auth, db: conn.db }, { email: email!, name: name!, password, office: flag("office") });
  console.log(`\n✓ Usuário criado (id ${r.userId}), e-mail verificado.`);
  if (r.organizationId) console.log(`✓ Escritório criado (id ${r.organizationId}, identificador "${r.slug}"); o usuário é o dono.`);
  console.log("Entre pela interface com o e-mail e a senha informados.");
} catch (e) {
  if (e instanceof ValidationError) fail(e.message);
  fail(`Erro: ${(e as Error).message.replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgresql://***@")}`);
} finally {
  await conn.close().catch(() => {});
}
