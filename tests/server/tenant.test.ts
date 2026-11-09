import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import * as schema from "../../src/server/db/schema.ts";
import { Client, email, startBackend, type Backend } from "./helpers.ts";

let be: Backend;
before(async () => {
  be = await startBackend();
});
after(() => be.close());

let seq = 0;
/** Cria um usuário e um escritório do qual ele é dono. */
async function newOffice(label: string) {
  const owner = be.client();
  const e = email(label);
  const user = await owner.signUp(e, `Dono ${label}`);
  const org = await owner.createOffice(`Escritório ${label}`, `${label}-${++seq}-${Date.now()}`);
  return { owner, orgId: org.id, userId: user.id, email: e };
}

/** Convida e aceita: devolve o cliente (logado) de um novo membro com o papel dado. */
async function addMember(o: { owner: Client; orgId: string }, role: string, label = role) {
  const e = email(label);
  const inv = await o.owner.auth("/organization/invite-member", { email: e, role, organizationId: o.orgId });
  assert.equal(inv.status, 200, `convite: ${inv.text}`);
  const c = be.client();
  const user = await c.signUp(e, `Membro ${label}`);
  const acc = await c.auth("/organization/accept-invitation", { invitationId: inv.json.id });
  assert.equal(acc.status, 200, `aceite: ${acc.text}`);
  return { client: c, email: e, userId: user.id, invitationId: inv.json.id as string };
}

const oab = (n: string, uf = "GO", name = "Advogado de Teste") => ({ name, oab_number: n, uf });

test("escritório isolado: cada um enxerga só as suas OABs", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  const created = await A.owner.v1("oab_create", oab("12.345", "go", "  Ana   Souza "));
  assert.equal(created.status, 200, created.text);
  assert.deepEqual(
    { n: created.json.oab.oab_number, uf: created.json.oab.uf, name: created.json.oab.name, active: created.json.oab.active },
    { n: "12345", uf: "GO", name: "Ana Souza", active: true },
  );
  assert.equal((await A.owner.v1("oab_list")).json.oabs.length, 1);
  assert.equal((await B.owner.v1("oab_list")).json.oabs.length, 0);
});

test("mesma OAB em escritórios diferentes é permitida; duplicada no mesmo escritório → 409", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  assert.equal((await A.owner.v1("oab_create", oab("777"))).status, 200);
  assert.equal((await B.owner.v1("oab_create", oab("777"))).status, 200);
  const dup = await A.owner.v1("oab_create", oab("000777")); // normaliza para a mesma
  assert.equal(dup.status, 409);
  assert.equal(dup.json.erro, "Esta OAB já está cadastrada no escritório.");
  // a transação falha não deixa lixo nem trava o escritório
  assert.equal((await A.owner.v1("oab_create", oab("778"))).status, 200);
});

test("por id: outro escritório não lê nem altera (404 indistinguível de inexistente)", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  const id = (await A.owner.v1("oab_create", oab("101"))).json.oab.id;
  const tentativa = await B.owner.v1("oab_update", { id, name: "Sequestrada", active: false });
  assert.equal(tentativa.status, 404);
  const inexistente = await B.owner.v1("oab_update", { id: "00000000-0000-4000-8000-000000000000", name: "Fulano" });
  assert.equal(inexistente.status, 404);
  assert.deepEqual(tentativa.json, inexistente.json);
  const a = (await A.owner.v1("oab_list")).json.oabs[0];
  assert.equal(a.name, "Advogado de Teste");
  assert.equal(a.active, true);
});

test("o cliente não escolhe o escritório: organization_id/organizationId no corpo são ignorados", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  const r = await B.owner.v1("oab_create", { ...oab("202"), organization_id: A.orgId, organizationId: A.orgId });
  assert.equal(r.status, 200);
  assert.equal((await A.owner.v1("oab_list")).json.oabs.length, 0);
  assert.equal((await B.owner.v1("oab_list")).json.oabs.length, 1);
});

test("escritório ativo forjado na sessão não dá acesso: vale só a associação real", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  await A.owner.v1("oab_create", oab("303", "GO", "Segredo do A"));
  // Simula adulteração direta do dado de sessão do usuário B apontando para o escritório A.
  await be.db.update(schema.session).set({ activeOrganizationId: A.orgId }).where(eq(schema.session.userId, B.userId));
  const list = await B.owner.v1("oab_list");
  assert.equal(list.status, 200);
  assert.equal(list.json.oabs.length, 0, "não pode enxergar OABs do A");
  const s = await B.owner.v1("session");
  assert.equal(s.json.escritorio.id, B.orgId, "a sessão se autocorrige para o escritório real");
});

test("trocar o escritório ativo para um do qual não é membro é recusado pelo Better Auth", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  const r = await B.owner.auth("/organization/set-active", { organizationId: A.orgId });
  assert.ok(r.status >= 400, `status ${r.status}`);
  assert.equal((await B.owner.v1("session")).json.escritorio.id, B.orgId);
});

test("usuário sem escritório: 403 nas operações de dados", async () => {
  const c = be.client();
  await c.signUp(email("sem"));
  assert.equal((await c.v1("oab_list")).status, 403);
  assert.equal((await c.v1("oab_create", oab("1"))).status, 403);
  assert.equal((await c.v1("audit_list")).status, 403);
});

test("entrada inválida → 400 (OAB, UF, nome, id, tipos)", async () => {
  const A = await newOffice("a");
  const c = A.owner;
  for (const bad of [
    { ...oab("0"), },
    oab("12345678"),
    oab("abc"),
    oab("123", "XX"),
    oab("123", "G"),
    { ...oab("123"), name: "ab" },
    { ...oab("123"), name: "x".repeat(121) },
    { ...oab("123"), name: "Nome\u0000Controle" },
    { oab_number: 123, uf: "GO" },
    { name: ["Fulano"], oab_number: "123", uf: "GO" },
  ])
    assert.equal((await c.v1("oab_create", bad)).status, 400, JSON.stringify(bad));
  assert.equal((await c.v1("oab_update", { id: "não-é-uuid", name: "Fulano" })).status, 400);
  const id = (await c.v1("oab_create", oab("404"))).json.oab.id;
  assert.equal((await c.v1("oab_update", { id })).status, 400); // nada para atualizar
  assert.equal((await c.v1("oab_update", { id, active: "sim" })).status, 400);
  assert.equal((await c.v1("oab_list")).json.oabs.length, 1);
});

test("injeção de SQL nos campos é tratada como texto", async () => {
  const A = await newOffice("a");
  const r = await A.owner.v1("oab_create", { name: "Robert'); DROP TABLE attorneys;--", oab_number: "55", uf: "GO" });
  assert.equal(r.status, 200);
  assert.equal(r.json.oab.name, "Robert'); DROP TABLE attorneys;--");
  assert.equal((await A.owner.v1("oab_list")).json.oabs.length, 1);
});

test("desativar/reativar OAB (nunca excluir) e auditoria com autor", async () => {
  const A = await newOffice("a");
  const id = (await A.owner.v1("oab_create", oab("606"))).json.oab.id;
  assert.equal((await A.owner.v1("oab_update", { id, active: false })).json.oab.active, false);
  assert.equal((await A.owner.v1("oab_update", { id, active: true, name: "Novo Nome" })).json.oab.name, "Novo Nome");
  const ev = (await A.owner.v1("audit_list")).json.eventos as any[];
  assert.deepEqual(
    ev.map((e) => e.acao).reverse().filter((a) => a.startsWith("oab.")),
    ["oab.created", "oab.deactivated", "oab.activated"],
  );
  assert.ok(ev.every((e) => e.autor_id === A.userId || e.autor_id === null));
});

test("auditoria é isolada por escritório", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  await A.owner.v1("oab_create", oab("707"));
  const evB = (await B.owner.v1("audit_list")).json.eventos as any[];
  assert.ok(evB.every((e) => !String(e.acao).startsWith("oab.")));
});

// ───────────────────────── papéis e permissões ─────────────────────────

test("matriz de permissões por papel (owner/admin/member/viewer) nas operações de OAB e auditoria", async () => {
  const O = await newOffice("a");
  const id = (await O.owner.v1("oab_create", oab("808"))).json.oab.id;
  const admin = await addMember(O, "admin");
  const member = await addMember(O, "member");
  const viewer = await addMember(O, "viewer");
  const matrix: Array<[string, Client, number, number, number, number]> = [
    // papel, cliente, oab_list, oab_create, oab_update, audit_list
    ["owner", O.owner, 200, 200, 200, 200],
    ["admin", admin.client, 200, 200, 200, 200],
    ["member", member.client, 200, 403, 403, 403],
    ["viewer", viewer.client, 200, 403, 403, 403],
  ];
  let n = 900;
  for (const [role, c, list, create, update, audit] of matrix) {
    assert.equal((await c.v1("oab_list")).status, list, `${role} oab_list`);
    assert.equal((await c.v1("oab_create", oab(String(++n)))).status, create, `${role} oab_create`);
    assert.equal((await c.v1("oab_update", { id, name: "Renomeada Por " + role })).status, update, `${role} oab_update`);
    assert.equal((await c.v1("audit_list")).status, audit, `${role} audit_list`);
  }
  const s = await member.client.v1("session");
  assert.equal(s.json.escritorio.papel, "member");
  assert.ok(s.json.permissoes.includes("publication:review"));
  assert.ok(!s.json.permissoes.includes("attorney:create"));
});

test("membro novo vê o escritório para o qual foi convidado (ativado automaticamente)", async () => {
  const O = await newOffice("a");
  await O.owner.v1("oab_create", oab("111"));
  const m = await addMember(O, "member");
  const s = await m.client.v1("session");
  assert.equal(s.json.escritorio.id, O.orgId);
  assert.equal((await m.client.v1("oab_list")).json.oabs.length, 1);
});

test("remover o vínculo corta o acesso IMEDIATAMENTE, com a mesma sessão", async () => {
  const O = await newOffice("a");
  await O.owner.v1("oab_create", oab("121"));
  const m = await addMember(O, "admin");
  assert.equal((await m.client.v1("oab_list")).status, 200);
  const rm = await O.owner.auth("/organization/remove-member", { memberIdOrEmail: m.email, organizationId: O.orgId });
  assert.equal(rm.status, 200, rm.text);
  assert.equal((await m.client.v1("oab_list")).status, 403);
  assert.equal((await m.client.v1("oab_create", oab("122"))).status, 403);
  assert.equal((await m.client.v1("session")).json.escritorio, null);
});

test("rebaixar de papel vale imediatamente", async () => {
  const O = await newOffice("a");
  const m = await addMember(O, "admin");
  assert.equal((await m.client.v1("oab_create", oab("131"))).status, 200);
  const members = await O.owner.auth("/organization/get-full-organization", undefined, "GET");
  const memberId = (members.json.members as any[]).find((x) => x.userId === m.userId).id;
  const up = await O.owner.auth("/organization/update-member-role", { memberId, role: "viewer", organizationId: O.orgId });
  assert.equal(up.status, 200, up.text);
  assert.equal((await m.client.v1("oab_create", oab("132"))).status, 403);
  assert.equal((await m.client.v1("oab_list")).status, 200);
});

test("escalada de privilégio: admin não promove a dono, não mexe em dono, não remove dono", async () => {
  const O = await newOffice("a");
  const admin = await addMember(O, "admin");
  const other = await addMember(O, "member");
  const full = await O.owner.auth("/organization/get-full-organization", undefined, "GET");
  const idOf = (uid: string) => (full.json.members as any[]).find((x) => x.userId === uid).id;
  const ownerMemberId = idOf(O.userId);
  // Controles positivos: as MESMAS chamadas, com formato correto e papel permitido, funcionam.
  const ctrlInv = await admin.client.auth("/organization/invite-member", { email: email("ok"), role: "member", organizationId: O.orgId });
  assert.equal(ctrlInv.status, 200, "admin convida membro comum");
  const ctrlRole = await admin.client.auth("/organization/update-member-role", { memberId: idOf(other.userId), role: "viewer", organizationId: O.orgId });
  assert.equal(ctrlRole.status, 200, "admin rebaixa membro comum");
  // convidar como dono
  const inv = await admin.client.auth("/organization/invite-member", { email: email("x"), role: "owner", organizationId: O.orgId });
  assert.ok(inv.status >= 400, `admin convidou como dono: ${inv.status} ${inv.text}`);
  // promover a si mesmo / a terceiro
  const self = await admin.client.auth("/organization/update-member-role", { memberId: idOf(admin.userId), role: "owner", organizationId: O.orgId });
  assert.ok(self.status >= 400, `admin se promoveu: ${self.status}`);
  const third = await admin.client.auth("/organization/update-member-role", { memberId: idOf(other.userId), role: "owner", organizationId: O.orgId });
  assert.ok(third.status >= 400, `admin promoveu terceiro: ${third.status}`);
  // rebaixar o dono
  const demote = await admin.client.auth("/organization/update-member-role", { memberId: ownerMemberId, role: "viewer", organizationId: O.orgId });
  assert.ok(demote.status >= 400, `admin rebaixou o dono: ${demote.status}`);
  // remover o dono
  const rm = await admin.client.auth("/organization/remove-member", { memberIdOrEmail: O.email, organizationId: O.orgId });
  assert.ok(rm.status >= 400, `admin removeu o dono: ${rm.status} ${rm.text}`);
  // o dono continua dono
  assert.equal((await O.owner.v1("session")).json.escritorio.papel, "owner");
});

test("member e viewer não gerenciam membros, convites nem o escritório", async () => {
  const O = await newOffice("a");
  const member = await addMember(O, "member");
  const viewer = await addMember(O, "viewer");
  for (const m of [member, viewer]) {
    const inv = await m.client.auth("/organization/invite-member", { email: email("y"), role: "member", organizationId: O.orgId });
    assert.ok(inv.status >= 400, `convite por ${m.email}: ${inv.status}`);
    const rm = await m.client.auth("/organization/remove-member", { memberIdOrEmail: O.email, organizationId: O.orgId });
    assert.ok(rm.status >= 400);
    const upd = await m.client.auth("/organization/update", { data: { name: "Hackeado" }, organizationId: O.orgId });
    assert.ok(upd.status >= 400);
    const del = await m.client.auth("/organization/delete", { organizationId: O.orgId });
    assert.ok(del.status >= 400);
  }
  const admin = await addMember(O, "admin");
  const del = await admin.client.auth("/organization/delete", { organizationId: O.orgId });
  assert.ok(del.status >= 400, "admin não exclui o escritório");
  // Controles positivos: o dono faz exatamente as mesmas chamadas e funcionam.
  assert.equal((await O.owner.auth("/organization/update", { data: { name: "Renomeado" }, organizationId: O.orgId })).status, 200);
  assert.equal((await admin.client.auth("/organization/update", { data: { name: "Renomeado 2" }, organizationId: O.orgId })).status, 200, "admin edita o escritório");
  const P = await newOffice("del");
  assert.equal((await P.owner.auth("/organization/delete", { organizationId: P.orgId })).status, 200, "dono exclui o próprio escritório");
  assert.equal((await P.owner.v1("oab_list")).status, 403, "e perde o acesso aos dados dele");
});

test("o último dono não pode sair nem ser rebaixado", async () => {
  const O = await newOffice("a");
  const extra = await addMember(O, "member");
  assert.equal((await extra.client.auth("/organization/leave", { organizationId: O.orgId })).status, 200, "controle: membro comum pode sair");
  const leave = await O.owner.auth("/organization/leave", { organizationId: O.orgId });
  assert.ok(leave.status >= 400, `saiu: ${leave.status}`);
  const full = await O.owner.auth("/organization/get-full-organization", undefined, "GET");
  const memberId = (full.json.members as any[])[0].id;
  const demote = await O.owner.auth("/organization/update-member-role", { memberId, role: "admin", organizationId: O.orgId });
  assert.ok(demote.status >= 400, `rebaixou o único dono: ${demote.status}`);
});

test("convite é pessoal: outro usuário não aceita; convite não vale para outro escritório", async () => {
  const O = await newOffice("a");
  const alvo = email("alvo");
  const inv = await O.owner.auth("/organization/invite-member", { email: alvo, role: "member", organizationId: O.orgId });
  assert.equal(inv.status, 200);
  const intruso = be.client();
  await intruso.signUp(email("intruso"));
  const r = await intruso.auth("/organization/accept-invitation", { invitationId: inv.json.id });
  assert.ok(r.status >= 400, `intruso aceitou: ${r.status}`);
  assert.equal((await intruso.v1("oab_list")).status, 403);
});

test("papéis inexistentes não concedem nada", async () => {
  const O = await newOffice("a");
  const e = email("z");
  const inv = await O.owner.auth("/organization/invite-member", { email: e, role: "superusuario", organizationId: O.orgId });
  if (inv.status === 200) {
    const c = be.client();
    await c.signUp(e);
    await c.auth("/organization/accept-invitation", { invitationId: inv.json.id });
    assert.notEqual((await c.v1("oab_create", oab("141"))).status, 200);
    assert.notEqual((await c.v1("oab_list")).status, 200);
  } else assert.ok(inv.status >= 400);
});

test("membros/convites/papéis geram trilha de auditoria com o autor", async () => {
  const O = await newOffice("a");
  const m = await addMember(O, "member");
  const full = await O.owner.auth("/organization/get-full-organization", undefined, "GET");
  const memberId = (full.json.members as any[]).find((x) => x.userId === m.userId).id;
  await O.owner.auth("/organization/update-member-role", { memberId, role: "viewer", organizationId: O.orgId });
  await O.owner.auth("/organization/remove-member", { memberIdOrEmail: m.email, organizationId: O.orgId });
  const ev = (await O.owner.v1("audit_list")).json.eventos as any[];
  const acoes = ev.map((e) => e.acao);
  for (const a of ["member.invited", "member.joined", "member.role_changed", "member.removed"])
    assert.ok(acoes.includes(a), `falta ${a} em ${acoes}`);
  const joined = ev.find((e) => e.acao === "member.joined");
  assert.equal(joined.autor_id, m.userId);
  const invited = ev.find((e) => e.acao === "member.invited");
  assert.equal(invited.autor_id, O.userId);
  assert.ok(!JSON.stringify(ev).includes("password"));
});

test("um usuário em dois escritórios mantém os papéis separados", async () => {
  const A = await newOffice("a");
  const B = await newOffice("b");
  await A.owner.v1("oab_create", oab("151"));
  const inv = await B.owner.auth("/organization/invite-member", { email: A.email, role: "viewer", organizationId: B.orgId });
  assert.equal(inv.status, 200);
  assert.equal((await A.owner.auth("/organization/accept-invitation", { invitationId: inv.json.id })).status, 200);
  // Aceitar o convite ativa o escritório B, onde ele é viewer; no A ele continua dono.
  const sess = (await A.owner.v1("session")).json;
  assert.equal(sess.escritorios.length, 2);
  assert.equal(sess.escritorio.id, B.orgId);
  assert.equal(sess.escritorio.papel, "viewer");
  assert.equal((await A.owner.v1("oab_create", oab("153"))).status, 403);
  assert.equal((await A.owner.v1("oab_list")).json.oabs.length, 0, "no B não aparece nada do A");
  // Troca explícita de volta para o A → dono, com os dados do A.
  assert.equal((await A.owner.auth("/organization/set-active", { organizationId: A.orgId })).status, 200);
  assert.equal((await A.owner.v1("session")).json.escritorio.papel, "owner");
  assert.equal((await A.owner.v1("oab_create", oab("152"))).status, 200);
  assert.equal((await A.owner.v1("oab_list")).json.oabs.length, 2);
});
