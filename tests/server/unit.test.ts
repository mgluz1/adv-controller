import test from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { getAuthTables } from "better-auth/db";
import { createAuth } from "../../src/server/auth.ts";
import * as schema from "../../src/server/db/schema.ts";
import type { Db } from "../../src/server/db/types.ts";
import {
  ConfigError,
  allowedOrigins,
  assertSafeDatabaseUrl,
  describeDatabaseUrl,
  missingBackendVars,
  parseEnv,
  validateAuthSecret,
} from "../../src/server/env.ts";
import {
  ValidationError,
  assertUuid,
  normalizeName,
  normalizeOabNumber,
  normalizeUf,
} from "../../src/server/domain/oab.ts";
import { ROLE_NAMES, can, parseRoles, permissionsOf } from "../../src/server/permissions.ts";
import { testEnv } from "./helpers.ts";

// ───────── aderência do esquema ao Better Auth ─────────
test("esquema Drizzle cobre TODAS as tabelas e campos que o Better Auth exige em runtime", () => {
  const auth = createAuth({ db: {} as Db, env: testEnv() });
  const required = getAuthTables(auth.options as any);
  const tables = schema as unknown as Record<string, any>;
  for (const [model, def] of Object.entries(required)) {
    const table = tables[model];
    assert.ok(table, `falta a tabela/exportação "${model}" no esquema`);
    const cols = getTableColumns(table) as Record<string, { notNull: boolean }>;
    assert.ok(cols.id, `${model}.id`);
    for (const [field, attr] of Object.entries(def.fields as Record<string, any>)) {
      assert.ok(cols[field], `falta a coluna ${model}.${field}`);
      if (attr.required && attr.defaultValue === undefined && attr.input !== false)
        assert.ok(cols[field].notNull, `${model}.${field} deveria ser NOT NULL`);
    }
  }
});

// ───────── ambiente e destino do banco ─────────
test("parseEnv: padrões seguros e validações", () => {
  const dev = parseEnv({});
  assert.equal(dev.nodeEnv, "development");
  assert.equal(dev.signupEnabled, true);
  assert.equal(dev.appUrl, "http://127.0.0.1:3000");
  const prod = parseEnv({ NODE_ENV: "production", BETTER_AUTH_URL: "https://app.exemplo.com.br/" });
  assert.equal(prod.signupEnabled, false, "cadastro aberto NÃO é o padrão em produção");
  assert.equal(prod.appUrl, "https://app.exemplo.com.br");
  assert.throws(() => parseEnv({ NODE_ENV: "production", BETTER_AUTH_URL: "http://app.exemplo.com.br" }), ConfigError);
  assert.throws(() => parseEnv({ PORT: "abc" }), ConfigError);
  assert.throws(() => parseEnv({ AUTH_SIGNUP_ENABLED: "talvez" }), ConfigError);
  assert.throws(() => parseEnv({ TRUST_PROXY: "99" }), ConfigError);
  assert.equal(parseEnv({ NODE_ENV: "production", BETTER_AUTH_URL: "https://x.com", AUTH_SIGNUP_ENABLED: "true" }).signupEnabled, true);
});

test("missingBackendVars lista só os NOMES, nunca valores", () => {
  assert.deepEqual(missingBackendVars(parseEnv({})), ["DATABASE_URL", "BETTER_AUTH_SECRET"]);
  assert.deepEqual(missingBackendVars(parseEnv({ DATABASE_URL: "postgresql://u:p@h/d", BETTER_AUTH_SECRET: "x" })), []);
});

test("segredo da autenticação: mínimo de 32 caracteres e sem valores de exemplo em produção", () => {
  assert.throws(() => validateAuthSecret("curto", "development"), ConfigError);
  assert.throws(() => validateAuthSecret("changeme".padEnd(40, "x"), "production"), ConfigError);
  validateAuthSecret("a1b2c3d4".repeat(5), "production");
});

test("destino do banco: Supabase recusado; remoto exige TLS; local liberado", () => {
  const neon = "postgresql://dono:SENHA-SECRETA@ep-cool-123-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require";
  const t = assertSafeDatabaseUrl(neon);
  assert.deepEqual(
    { host: t.host, isNeon: t.isNeon, isPooled: t.isPooled, database: t.database, user: t.user },
    { host: "ep-cool-123-pooler.sa-east-1.aws.neon.tech", isNeon: true, isPooled: true, database: "neondb", user: "dono" },
  );
  assert.doesNotMatch(JSON.stringify(t), /SENHA-SECRETA/, "a senha nunca aparece na descrição do destino");
  assert.throws(() => assertSafeDatabaseUrl("postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres?sslmode=require"), /Supabase/);
  assert.throws(() => assertSafeDatabaseUrl("postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require"), /Supabase/);
  assert.throws(() => assertSafeDatabaseUrl("postgresql://u:p@ep-x.neon.tech/db"), /TLS/);
  assert.throws(() => assertSafeDatabaseUrl("postgresql://u:p@ep-x.neon.tech/db?sslmode=disable"), /TLS/);
  assert.equal(assertSafeDatabaseUrl("postgresql://u:p@localhost:5432/dev").isLocal, true);
  assert.throws(() => assertSafeDatabaseUrl("mysql://u:p@h/db"), ConfigError);
  assert.throws(() => describeDatabaseUrl("não é url"), ConfigError);
  try {
    assertSafeDatabaseUrl("postgresql://u:SENHA-SECRETA@ep-x.neon.tech/db");
  } catch (e) {
    assert.doesNotMatch((e as Error).message, /SENHA-SECRETA/);
  }
});

test("origens permitidas: em produção só a do app; em dev também o gêmeo localhost", () => {
  assert.deepEqual(allowedOrigins({ appUrl: "https://app.x.com", nodeEnv: "production" }), ["https://app.x.com"]);
  assert.deepEqual(allowedOrigins({ appUrl: "http://127.0.0.1:3000", nodeEnv: "development" }), ["http://127.0.0.1:3000", "http://localhost:3000"]);
});

// ───────── permissões ─────────
test("permissões por papel", () => {
  assert.deepEqual([...ROLE_NAMES].sort(), ["admin", "member", "owner", "viewer"]);
  assert.equal(can("owner", "organization", "delete"), true);
  assert.equal(can("admin", "organization", "delete"), false);
  assert.equal(can("admin", "attorney", "create"), true);
  assert.equal(can("member", "attorney", "create"), false);
  assert.equal(can("member", "publication", "review"), true);
  assert.equal(can("member", "publication", "discard"), false);
  assert.equal(can("viewer", "publication", "review"), false);
  assert.equal(can("viewer", "publication", "read"), true);
  assert.equal(can("member", "audit", "read"), false);
});

test("vários papéis somam; papel desconhecido, vazio ou nulo não concede nada", () => {
  assert.deepEqual(parseRoles("admin, member"), ["admin", "member"]);
  assert.equal(can("viewer,admin", "attorney", "create"), true);
  for (const r of ["root", "OWNER", "", null, undefined, "owner2", "__proto__", "constructor"])
    assert.equal(can(r as any, "attorney", "read"), false, String(r));
  assert.deepEqual(permissionsOf("root"), []);
  assert.ok(permissionsOf("viewer").includes("attorney:read"));
  assert.ok(!permissionsOf("viewer").includes("attorney:create"));
});

// ───────── domínio ─────────
test("normalização de OAB, UF e nome", () => {
  assert.equal(normalizeOabNumber("12.345"), "12345");
  assert.equal(normalizeOabNumber(" 012345 "), "12345");
  assert.equal(normalizeOabNumber(7), "7");
  for (const bad of ["", "0", "12345678", "12a", "1e3", -5, null, undefined, {}, "１２３"])
    assert.throws(() => normalizeOabNumber(bad), ValidationError, String(bad));
  assert.equal(normalizeUf(" go "), "GO");
  for (const bad of ["XX", "G", "", null, 12]) assert.throws(() => normalizeUf(bad), ValidationError);
  assert.equal(normalizeName("  Ana   Maria  "), "Ana Maria");
  for (const bad of ["ab", "", "x".repeat(121), "a\u0000bc", null, 5]) assert.throws(() => normalizeName(bad), ValidationError);
  assert.equal(assertUuid("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.throws(() => assertUuid("1; drop table x"), ValidationError);
});
