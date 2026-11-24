import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { MANUAL_SYNC_COOLDOWN_MS } from "../../src/server/routes/sync.ts";
import { Client, email, startBackend, type Backend } from "./helpers.ts";

// djen_sync_manual ("Buscar agora"): permissão, limite de 1 a cada 5 min POR ESCRITÓRIO (compartilhado), efeito nos cursores e wake.
let be: Backend;
const woke: (string | undefined)[] = [];
let enabled = true;
before(async () => {
  be = await startBackend({}, { scheduler: { get enabled() { return enabled; }, wake: (o) => void woke.push(o) } });
});
after(() => be.close());

let seq = 0;
async function newOffice(label: string) {
  const owner = be.client();
  await owner.signUp(email(label), `Dono ${label}`);
  const org = await owner.createOffice(`Escritório ${label}`, `${label}-${++seq}-${Date.now()}`);
  return { owner, orgId: org.id as string };
}
async function addMember(o: { owner: Client; orgId: string }, role: string) {
  const e = email(role);
  const inv = await o.owner.auth("/organization/invite-member", { email: e, role, organizationId: o.orgId });
  assert.equal(inv.status, 200, inv.text);
  const c = be.client();
  await c.signUp(e, `Membro ${role}`);
  assert.equal((await c.auth("/organization/accept-invitation", { invitationId: inv.json.id })).status, 200);
  return c;
}
const newOab = async (o: { owner: Client }, n: string, uf = "GO") => (await o.owner.v1("oab_create", { name: `Advogado ${n}`, oab_number: n, uf })).json.oab.id as string;
const sync = (c: Client) => c.v1("djen_sync_manual", {});
const requests = (orgId: string) => be.raw.select().from(schema.auditLog).where(sql`${schema.auditLog.organizationId} = ${orgId} and ${schema.auditLog.action} = 'sync.requested'`);
const cursor = async (att: string) => (await be.raw.select().from(schema.syncCursors).where(eq(schema.syncCursors.attorneyId, att)))[0];

test("anônimo 401; viewer e member 403; owner e admin podem", async () => {
  const O = await newOffice("perm");
  await newOab(O, "101");
  const viewer = await addMember(O, "viewer");
  const member = await addMember(O, "member");
  assert.equal((await sync(be.client())).status, 401);
  assert.equal((await sync(viewer)).status, 403);
  assert.equal((await sync(member)).status, 403);
  assert.equal((await requests(O.orgId)).length, 0, "negados não consomem o limite nem deixam rastro");
  assert.equal((await sync(O.owner)).status, 200);

  const P = await newOffice("perm2");
  await newOab(P, "102");
  const admin = await addMember(P, "admin");
  assert.equal((await sync(admin)).status, 200);
});

test("sem OAB ativa: 409 e o limite NÃO é consumido", async () => {
  const O = await newOffice("semoab");
  const r = await sync(O.owner);
  assert.equal(r.status, 409);
  assert.match(r.json.erro, /OAB ativa/);
  assert.equal((await requests(O.orgId)).length, 0);
  const id = await newOab(O, "103");
  await O.owner.v1("oab_update", { id, active: false });
  assert.equal((await sync(O.owner)).status, 409, "só inativas também não vale");
  await O.owner.v1("oab_update", { id, active: true });
  assert.equal((await sync(O.owner)).status, 200, "e o primeiro pedido válido passa de imediato");
});

test("sucesso: registra o autor, devolve a mensagem do contrato e acorda o agendador", async () => {
  const O = await newOffice("ok");
  await newOab(O, "104");
  await newOab(O, "105", "RJ");
  woke.length = 0;
  enabled = true;
  const r = await sync(O.owner);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sucesso, true);
  assert.match(r.json.mensagem, /2 OAB/);
  const ev = await requests(O.orgId);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].details, { attorneys: 2 });
  assert.ok(ev[0].actorUserId);
  assert.ok(woke.includes(O.orgId), "scheduler.wake(escritório)");
  // com o coletor desligado neste processo a mensagem avisa, mas o pedido fica registrado
  const Q = await newOffice("off");
  await newOab(Q, "106");
  enabled = false;
  const off = await sync(Q.owner);
  assert.equal(off.status, 200);
  assert.match(off.json.mensagem, /assim que o coletor/);
  enabled = true;
});

test("efeito: OABs ativas vencem AGORA (inclusive em recuo por falha); lease ativo e OAB inativa não são tocados; cursor ausente é criado", async () => {
  const O = await newOffice("efeito");
  const withBackoff = await newOab(O, "107");
  const leased = await newOab(O, "108", "RJ");
  const noCursor = await newOab(O, "109", "SP");
  const inactive = await newOab(O, "110", "MG");
  await O.owner.v1("oab_update", { id: inactive, active: false });
  const later = new Date(Date.now() + 3 * 3600_000);
  const lease = new Date(Date.now() + 4 * 60_000);
  await be.raw.insert(schema.syncCursors).values([
    { organizationId: O.orgId, attorneyId: withBackoff, nextDueAt: later, consecutiveFailures: 3, lastError: "recuo" },
    { organizationId: O.orgId, attorneyId: leased, nextDueAt: later, leaseId: crypto.randomUUID(), leaseUntil: lease },
    { organizationId: O.orgId, attorneyId: inactive, nextDueAt: later },
  ]);
  const t0 = Date.now();
  assert.equal((await sync(O.owner)).status, 200);
  assert.ok((await cursor(withBackoff)).nextDueAt!.getTime() <= Date.now() + 5000 && (await cursor(withBackoff)).nextDueAt!.getTime() >= t0 - 5000, "venceu agora");
  assert.equal((await cursor(withBackoff)).consecutiveFailures, 3, "o histórico de falhas é preservado");
  assert.equal((await cursor(leased)).nextDueAt!.getTime(), later.getTime(), "janela em andamento: não mexe");
  assert.equal((await cursor(inactive)).nextDueAt!.getTime(), later.getTime(), "inativa: não mexe");
  assert.ok(await cursor(noCursor), "cursor criado para a OAB que não tinha");
});

test("limite: 1 a cada 5 min POR ESCRITÓRIO, compartilhado entre usuários; outro escritório não é afetado; libera depois de 5 min", async () => {
  const O = await newOffice("lim");
  await newOab(O, "111");
  const admin = await addMember(O, "admin");
  const P = await newOffice("lim2");
  await newOab(P, "112");

  woke.length = 0;
  assert.equal((await sync(O.owner)).status, 200);
  const again = await sync(O.owner);
  assert.equal(again.status, 429);
  assert.match(again.json.erro, /Aguarde 5 min/);
  assert.equal((await sync(admin)).status, 429, "o limite é do escritório, não do usuário");
  assert.equal((await sync(P.owner)).status, 200, "outro escritório tem o seu próprio limite");
  assert.equal((await requests(O.orgId)).length, 1, "recusados não geram evento");
  assert.equal(woke.filter((x) => x === O.orgId).length, 1, "só o pedido aceito acorda o agendador");

  // 4 min depois ainda bloqueia e informa o que falta; 5 min depois libera
  await be.raw.update(schema.auditLog).set({ createdAt: new Date(Date.now() - 4 * 60_000) }).where(sql`${schema.auditLog.organizationId} = ${O.orgId} and ${schema.auditLog.action} = 'sync.requested'`);
  const near = await sync(O.owner);
  assert.equal(near.status, 429);
  assert.match(near.json.erro, /Aguarde 1 min/);
  await be.raw.update(schema.auditLog).set({ createdAt: new Date(Date.now() - MANUAL_SYNC_COOLDOWN_MS - 1000) }).where(sql`${schema.auditLog.organizationId} = ${O.orgId} and ${schema.auditLog.action} = 'sync.requested'`);
  assert.equal((await sync(admin)).status, 200);
  assert.equal((await requests(O.orgId)).length, 2);
});

test("pedidos simultâneos: só um passa", async () => {
  const O = await newOffice("conc");
  await newOab(O, "113");
  const admin = await addMember(O, "admin");
  const rs = await Promise.all([sync(O.owner), sync(admin), sync(O.owner), sync(admin), sync(O.owner)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429, 429, 429, 429]);
  assert.equal((await requests(O.orgId)).length, 1);
});

test("o cliente não escolhe o escritório: organization_id no corpo é ignorado", async () => {
  const A = await newOffice("ca");
  const B = await newOffice("cb");
  await newOab(A, "114");
  await newOab(B, "115");
  const r = await B.owner.v1("djen_sync_manual", { organization_id: A.orgId, organizationId: A.orgId });
  assert.equal(r.status, 200);
  assert.equal((await requests(A.orgId)).length, 0);
  assert.equal((await requests(B.orgId)).length, 1);
});

test("criar ou reativar uma OAB acorda o agendador (a primeira carga começa já); desativar não", async () => {
  const O = await newOffice("wake");
  woke.length = 0;
  const id = await newOab(O, "116");
  assert.ok(woke.includes(O.orgId), "oab_create");
  woke.length = 0;
  await O.owner.v1("oab_update", { id, active: false });
  assert.equal(woke.length, 0, "desativar não acorda");
  await O.owner.v1("oab_update", { id, name: "Novo Nome Válido" });
  assert.equal(woke.length, 0, "renomear não acorda");
  await O.owner.v1("oab_update", { id, active: true });
  assert.ok(woke.includes(O.orgId), "reativar");
  woke.length = 0;
  assert.equal((await O.owner.v1("oab_create", { name: "Duplicada", oab_number: "116", uf: "GO" })).status, 409);
  assert.equal(woke.length, 0, "falha não acorda");
});
