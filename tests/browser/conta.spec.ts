import { test, expect, type Page } from "@playwright/test";

// Telas de conta e de gestão (Fase 2). Nenhum teste fala com backend real: /api/v1/* e /api/auth/* são interceptados por uma
// API falsa COM ESTADO (para a interface poder criar, convidar, aceitar e depois enxergar o resultado). Dados fictícios.
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
});

const PERMS: Record<string, string[]> = {
  owner: ["attorney:create", "attorney:read", "attorney:update", "audit:read", "interest:create", "interest:read", "interest:update", "invitation:cancel", "invitation:create", "member:create", "member:delete", "member:update", "organization:delete", "organization:update", "publication:read", "sync:read", "sync:request"],
  admin: ["attorney:create", "attorney:read", "attorney:update", "audit:read", "interest:create", "interest:read", "interest:update", "invitation:cancel", "invitation:create", "member:create", "member:delete", "member:update", "organization:update", "publication:read", "sync:read", "sync:request"],
  member: ["attorney:read", "interest:read", "publication:read", "sync:read"],
  viewer: ["attorney:read", "interest:read", "publication:read", "sync:read"],
};

interface Mundo {
  logado: string | null; // e-mail do usuário logado
  escritorios: { id: string; nome: string; papel: string }[];
  ativo: string | null;
  recursos: Record<string, boolean>;
  oabs: any[];
  termos: any[];
  membros: any[];
  convites: any[];
  convite: any | null; // convite consultável por /convite/<id>
  erros: Record<string, { status: number; body: any }>; // forçar erro por rota
  chamadas: { rota: string; corpo: any }[];
}
const OWNER = { id: "m-1", role: "owner", user: { id: "u1", name: "Dona Teste", email: "dona@exemplo.test" } };
const mundo = (o: Partial<Mundo> = {}): Mundo => ({
  logado: "dona@exemplo.test",
  escritorios: [{ id: "org-1", nome: "Silva & Associados", papel: "owner" }],
  ativo: "org-1",
  recursos: { recuperacao_senha: true, cadastro_aberto: false, cadastro_por_convite: true, verificacao_email: true },
  oabs: [],
  termos: [],
  membros: [OWNER],
  convites: [],
  convite: null,
  erros: {},
  chamadas: [],
  ...o,
});

async function instalar(page: Page, w: Mundo) {
  const esc = () => w.escritorios.find((e) => e.id === w.ativo) ?? null;
  const ok = (body: unknown, status = 200) => ({ status, body });
  await page.route("**/api/v1/**", async (route) => {
    const nome = new URL(route.request().url()).pathname.split("/").pop()!;
    const corpo = route.request().postDataJSON() ?? {};
    w.chamadas.push({ rota: nome, corpo });
    let r = ok({});
    if (w.erros[nome]) r = w.erros[nome];
    else if (nome === "session") {
      const e = w.logado ? esc() : null;
      r = ok({ usuario: w.logado ? { id: "u1", email: w.logado } : null, escritorio: e, escritorios: w.logado ? w.escritorios : [], permissoes: e ? PERMS[e.papel] ?? [] : [], recursos: w.recursos });
    } else if (nome === "sign-in") {
      w.logado = corpo.email;
      r = ok({ ok: true });
    } else if (nome === "sign-out") {
      w.logado = null;
      r = ok({ ok: true });
    } else if (nome === "djen_list") {
      const ativas = w.oabs.filter((o) => o.active);
      r = ok({
        total: 0, rows: [], stats: { total: 0, revisar: 0, analise: 0, concluida: 0 },
        attorney_stats: ativas.map((o) => ({ id: o.id, name: o.name, oab_number: o.oab_number, uf: o.uf, total: 0, revisar: 0 })),
        tab_stats: { todos: { total: 0, revisar: 0 }, ...Object.fromEntries(ativas.map((o) => [o.id, { total: 0, revisar: 0 }])) },
        tribunals: [], pending_windows: 0, latest: null, last_success: null, next_due: null,
      });
    } else if (nome === "oab_list") r = ok({ oabs: w.oabs });
    else if (nome === "oab_create") {
      const o = { id: `oab-${w.oabs.length + 1}`, name: corpo.name, oab_number: corpo.oab_number, uf: corpo.uf, active: true };
      w.oabs.push(o);
      r = ok({ oab: o });
    } else if (nome === "oab_update") {
      const o = w.oabs.find((x) => x.id === corpo.id);
      Object.assign(o, { ...(corpo.active !== undefined && { active: corpo.active }), ...(corpo.name && { name: corpo.name }) });
      r = ok({ oab: o });
    } else if (nome === "interest_list") r = ok({ terms: w.termos });
    else if (nome === "interest_create") {
      const t = { id: `t-${w.termos.length + 1}`, term: corpo.term, kind: /\./.test(corpo.term) ? "sigla" : "expressao", active: true, attorney_id: corpo.attorney_id ?? null };
      w.termos.push(t);
      r = ok({ term: t });
    } else if (nome === "interest_update") {
      const t = w.termos.find((x) => x.id === corpo.id);
      for (const k of ["active", "attorney_id", "term"]) if (k in corpo) t[k] = corpo[k];
      r = ok({ term: t });
    } else if (nome === "invite_info") r = w.convite && w.convite.id === corpo.id ? ok(w.convite.info) : ok({ erro: "Convite inválido ou expirado." }, 404);
    else if (nome === "invite_sign_up") {
      w.logado = w.convite.info.email;
      r = ok({ ok: true, email: w.logado });
    }
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
  });
  await page.route("**/api/auth/**", async (route) => {
    const rota = new URL(route.request().url()).pathname.replace("/api/auth", "");
    const corpo = route.request().postDataJSON() ?? {};
    w.chamadas.push({ rota, corpo });
    let r = ok({});
    if (w.erros[rota]) r = w.erros[rota];
    else if (rota === "/organization/get-full-organization") r = ok({ id: w.ativo, name: esc()?.nome, members: w.membros, invitations: w.convites });
    else if (rota === "/organization/invite-member") {
      const c = { id: "convite-novo-123", email: corpo.email, role: corpo.role, status: "pending", expiresAt: "2026-12-31T12:00:00Z" };
      w.convites.push(c);
      r = ok(c);
    } else if (rota === "/organization/cancel-invitation") w.convites = w.convites.filter((c) => c.id !== corpo.invitationId);
    else if (rota === "/organization/update-member-role") w.membros.find((m) => m.id === corpo.memberId).role = corpo.role;
    else if (rota === "/organization/remove-member") w.membros = w.membros.filter((m) => m.id !== corpo.memberIdOrEmail);
    else if (rota === "/organization/create") {
      w.escritorios.push({ id: "org-novo", nome: corpo.name, papel: "owner" });
      w.ativo = "org-novo";
      r = ok({ id: "org-novo" });
    } else if (rota === "/organization/set-active") w.ativo = corpo.organizationId;
    else if (rota === "/organization/accept-invitation") {
      w.escritorios.push({ id: "org-convite", nome: w.convite.info.organization, papel: w.convite.info.role });
      w.ativo = "org-convite";
    }
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
  });
}
const chamou = (w: Mundo, rota: string) => w.chamadas.filter((c) => c.rota === rota);

// ── Recuperação de senha ──────────────────────────────────────────────────────

test("login: 'Esqueci minha senha' só aparece quando o servidor oferece e-mail; o pedido tem resposta genérica", async ({ page }) => {
  const sem = mundo({ logado: null, recursos: { recuperacao_senha: false, cadastro_aberto: false, cadastro_por_convite: true, verificacao_email: false } });
  await instalar(page, sem);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Entrar", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Esqueci minha senha" })).toBeHidden();

  const w = mundo({ logado: null });
  const p2 = await page.context().newPage();
  await instalar(p2, w);
  await p2.goto("/");
  await p2.getByRole("button", { name: "Esqueci minha senha" }).click();
  await expect(p2.getByRole("heading", { name: "Esqueci minha senha" })).toBeVisible();
  await p2.locator("#conta-email").fill("ana@exemplo.test");
  await p2.getByRole("button", { name: "Enviar link" }).click();
  await expect(p2.locator("#conta-msg")).toContainText("Se existir uma conta com este e-mail");
  const req = chamou(w, "/request-password-reset")[0].corpo;
  expect(req.email).toBe("ana@exemplo.test");
  expect(req.redirectTo).toMatch(/\/redefinir-senha$/);
  // voltar ao login
  await p2.getByRole("button", { name: "Voltar para entrar" }).click();
  await expect(p2.getByRole("button", { name: "Entrar", exact: true })).toBeVisible();
});

test("redefinir senha: valida no cliente, envia o token, esconde o token da barra de endereço e oferece voltar ao login", async ({ page }) => {
  const w = mundo({ logado: null });
  await instalar(page, w);
  await page.goto("/redefinir-senha?token=TOKEN-SECRETO-123");
  await expect(page.getByRole("heading", { name: "Crie uma nova senha" })).toBeVisible();
  await page.locator("#conta-senha").fill("curta");
  await page.locator("#conta-senha2").fill("curta");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page.locator("#conta-msg")).toContainText("ao menos 10 caracteres");
  await page.locator("#conta-senha").fill("senha-nova-forte-1");
  await page.locator("#conta-senha2").fill("senha-DIFERENTE-1");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page.locator("#conta-msg")).toContainText("não conferem");
  expect(chamou(w, "/reset-password")).toHaveLength(0);

  await page.locator("#conta-senha2").fill("senha-nova-forte-1");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page.getByRole("heading", { name: "Senha alterada" })).toBeVisible();
  expect(chamou(w, "/reset-password")[0].corpo).toEqual({ newPassword: "senha-nova-forte-1", token: "TOKEN-SECRETO-123" });
  expect(page.url()).not.toContain("TOKEN");
  await page.getByRole("button", { name: "Ir para entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("redefinir senha: sem token ou com erro do servidor mostra 'link inválido' e permite pedir outro", async ({ page }) => {
  const w = mundo({ logado: null });
  await instalar(page, w);
  for (const url of ["/redefinir-senha", "/redefinir-senha?error=INVALID_TOKEN", "/redefinir-senha?token=x&error=INVALID_TOKEN"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Link inválido ou expirado" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Pedir novo link" }).click();
  await expect(page.getByRole("heading", { name: "Esqueci minha senha" })).toBeVisible();
});

test("erro do servidor na redefinição aparece em português", async ({ page }) => {
  const w = mundo({ logado: null, erros: { "/reset-password": { status: 400, body: { code: "INVALID_TOKEN", message: "Invalid token" } } } });
  await instalar(page, w);
  await page.goto("/redefinir-senha?token=velho");
  await page.locator("#conta-senha").fill("senha-nova-forte-1");
  await page.locator("#conta-senha2").fill("senha-nova-forte-1");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page.locator("#conta-msg")).toContainText("inválido ou expirou");
  await expect(page.locator("#conta-msg")).not.toContainText("Invalid token");
});

// ── Convite por link ──────────────────────────────────────────────────────────

const INFO = { organization: "Silva & Associados", inviter: "Dona Teste", role: "admin", email: "bia@exemplo.test", expires_at: "2026-12-31T12:00:00Z", account_exists: false };

test("convite sem conta: mostra o resumo escapado, e-mail fixo, cria a conta, aceita e entra no escritório", async ({ page }) => {
  const info = { ...INFO, organization: `<img src=x onerror="window.__xss=1">Escritório`, inviter: "<b>Dona</b>" };
  const w = mundo({ logado: null, escritorios: [], ativo: null, convite: { id: "convite-abc-123", info } });
  await instalar(page, w);
  await page.goto("/convite/convite-abc-123");
  await expect(page.getByRole("heading", { name: "Crie sua conta" })).toBeVisible();
  await expect(page.locator("#conta-painel")).toContainText("Administrador");
  await expect(page.locator("#conta-painel img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  await expect(page.locator("#conta-email")).toHaveValue("bia@exemplo.test");
  await expect(page.locator("#conta-email")).toHaveAttribute("readonly", "");

  await page.locator("#conta-nome").fill("Bia Convidada");
  await page.locator("#conta-senha").fill("senha-forte-123");
  await page.locator("#conta-senha2").fill("senha-forte-999");
  await page.getByRole("button", { name: "Criar conta e aceitar" }).click();
  await expect(page.locator("#conta-msg")).toContainText("não conferem");
  expect(chamou(w, "invite_sign_up")).toHaveLength(0);

  await page.locator("#conta-senha2").fill("senha-forte-123");
  await page.getByRole("button", { name: "Criar conta e aceitar" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(chamou(w, "invite_sign_up")[0].corpo).toEqual({ id: "convite-abc-123", name: "Bia Convidada", password: "senha-forte-123" });
  expect(chamou(w, "/organization/accept-invitation")[0].corpo).toEqual({ invitationId: "convite-abc-123" });
  await expect(page.locator("#office-name")).toContainText("Escritório");
});

test("convite com conta existente: pede só a senha (e-mail fixo) e, logado, aceita", async ({ page }) => {
  const w = mundo({ logado: null, escritorios: [], ativo: null, convite: { id: "convite-abc-123", info: { ...INFO, account_exists: true } } });
  await instalar(page, w);
  await page.goto("/convite/convite-abc-123");
  await expect(page.getByRole("heading", { name: "Entre para aceitar" })).toBeVisible();
  await expect(page.locator("#conta-email")).toHaveValue("bia@exemplo.test");
  await expect(page.locator("#conta-email")).toHaveAttribute("readonly", "");
  await page.locator("#conta-senha").fill("qualquer-senha-123");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Aceitar convite" })).toBeVisible(); // recarregou já logado
  expect(chamou(w, "sign-in")[0].corpo).toEqual({ email: "bia@exemplo.test", password: "qualquer-senha-123" });
  await page.getByRole("button", { name: "Aceitar convite" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#office-name")).toContainText("Silva");
  expect(chamou(w, "/organization/accept-invitation")).toHaveLength(1);
});

test("convite: e-mail igual com outra caixa de letras conta como a mesma pessoa e oferece aceitar", async ({ page }) => {
  const w = mundo({ logado: "Bia@Exemplo.TEST", escritorios: [], ativo: null, convite: { id: "convite-abc-123", info: INFO } });
  await instalar(page, w);
  await page.goto("/convite/convite-abc-123");
  await expect(page.getByRole("heading", { name: "Aceitar convite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Aceitar convite" })).toBeVisible();
});

test("convite é pessoal: logado com OUTRO e-mail vê o aviso e só pode sair", async ({ page }) => {
  const w = mundo({ logado: "outra@exemplo.test", escritorios: [], ativo: null, convite: { id: "convite-abc-123", info: INFO } });
  await instalar(page, w);
  await page.goto("/convite/convite-abc-123");
  await expect(page.getByRole("heading", { name: "Convite para outro e-mail" })).toBeVisible();
  await expect(page.locator("#conta-painel")).toContainText("bia@exemplo.test");
  await expect(page.locator("#conta-painel")).toContainText("outra@exemplo.test");
  await expect(page.getByRole("button", { name: "Aceitar convite" })).toHaveCount(0);
  expect(chamou(w, "/organization/accept-invitation")).toHaveLength(0);
});

test("convite inválido, expirado ou usado: mensagem única, sem formulário", async ({ page }) => {
  const w = mundo({ logado: null, convite: null });
  await instalar(page, w);
  await page.goto("/convite/inexistente12345");
  await expect(page.getByRole("heading", { name: "Convite indisponível" })).toBeVisible();
  await expect(page.locator("#conta-painel")).toContainText("inválido ou expirado");
  await expect(page.locator("#conta-form")).toHaveCount(0);
  await page.goto("/convite/curto"); // formato inválido nem chega a existir como rota de convite
  await expect(page.locator("#modal-login")).toBeVisible();
});

// ── Onboarding e seletor de escritório ────────────────────────────────────────

test("primeiro acesso sem escritório: cria o escritório com identificador único e entra", async ({ page }) => {
  const w = mundo({ escritorios: [], ativo: null });
  await instalar(page, w);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Crie o seu escritório" })).toBeVisible();
  await expect(page.locator("#conta-painel")).toContainText("dona@exemplo.test");
  await page.getByRole("button", { name: "Criar escritório" }).click();
  await expect(page.locator("#conta-msg")).toContainText("Informe o nome do escritório");
  await page.locator("#conta-nome").fill("  Ação   & Cia. Advocacia ");
  await page.getByRole("button", { name: "Criar escritório" }).click();
  await expect(page).toHaveURL(/\/$/);
  const criado = chamou(w, "/organization/create")[0].corpo;
  expect(criado.name).toBe("Ação & Cia. Advocacia");
  expect(criado.slug).toMatch(/^acao-cia-advocacia-[a-z0-9]{4}$/);
  await expect(page.locator("#office-name")).toContainText("Ação & Cia. Advocacia");
});

test("identificador já existente: tenta de novo com outro sufixo até conseguir", async ({ page }) => {
  let n = 0;
  const w = mundo({ escritorios: [], ativo: null });
  await instalar(page, w);
  await page.route("**/api/auth/organization/create", async (route) => {
    n++;
    if (n < 3) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "ORGANIZATION_SLUG_ALREADY_TAKEN", message: "slug taken" }) });
    w.escritorios.push({ id: "org-novo", nome: "Banca", papel: "owner" });
    w.ativo = "org-novo";
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");
  await page.locator("#conta-nome").fill("Banca");
  await page.getByRole("button", { name: "Criar escritório" }).click();
  await expect(page.locator("#office-name")).toContainText("Banca");
  expect(n).toBe(3);
});

test("cabeçalho: um escritório mostra o nome; vários mostram o seletor, que troca o escritório ativo", async ({ page }) => {
  const w = mundo({ escritorios: [{ id: "org-1", nome: "Silva & Associados", papel: "owner" }, { id: "org-2", nome: "Costa Advogados", papel: "member" }] });
  await instalar(page, w);
  await page.goto("/");
  const sel = page.getByLabel("Escritório ativo");
  await expect(sel).toBeVisible();
  await expect(page.locator("#office-name")).toBeHidden();
  await expect(sel.locator("option")).toHaveText(["Silva & Associados", "Costa Advogados"]);
  await sel.selectOption("org-2");
  await expect.poll(() => chamou(w, "/organization/set-active").length).toBe(1);
  expect(chamou(w, "/organization/set-active")[0].corpo).toEqual({ organizationId: "org-2" });
  await expect(page.getByLabel("Escritório ativo")).toHaveValue("org-2"); // recarregou no escritório novo
});

// ── Configurações ─────────────────────────────────────────────────────────────

test("primeiros passos: escritório sem OABs abre o cadastro uma vez e deixa um atalho na tela vazia", async ({ page }) => {
  const w = mundo();
  await instalar(page, w);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Configurações do escritório" })).toBeVisible();
  await expect(page.locator("#config-corpo")).toContainText("Nenhuma OAB cadastrada");
  await page.getByRole("button", { name: "Fechar" }).click();
  await expect(page.locator("#modal-config")).not.toHaveClass(/modal-visible/);
  await page.reload();
  await expect(page.locator("#modal-config")).not.toHaveClass(/modal-visible/); // só uma vez por sessão do navegador
  await expect(page.locator("#empty-primeiros-passos")).toBeVisible();
  await page.getByRole("button", { name: "Cadastrar a primeira OAB" }).click();
  await expect(page.locator("#modal-config")).toHaveClass(/modal-visible/);
});

async function abrirConfig(page: Page, aba: string) {
  // Sem OABs o modal já abre sozinho (primeiros passos) e cobre o cabeçalho; com ele aberto, só troca a aba.
  if (!(await page.locator("#modal-config").evaluate((el) => el.classList.contains("modal-visible")))) await page.getByRole("button", { name: "Configurações" }).click();
  await page.getByRole("tab", { name: aba }).click();
}

test("OABs: cadastra (exige UF), lista, desativa e reativa; nomes com HTML não executam", async ({ page }) => {
  const w = mundo({ oabs: [{ id: "oab-0", name: `<img src=x onerror="window.__xss=1">Ana`, oab_number: "111", uf: "GO", active: true }] });
  await instalar(page, w);
  await page.goto("/");
  await abrirConfig(page, "OABs");
  await expect(page.locator("#config-corpo")).toContainText("OAB/GO 111");
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  await expect(page.locator("#config-corpo img")).toHaveCount(0);

  await page.locator("#oab-nome").fill("Bruno Lima");
  await page.locator("#oab-numero").fill("222");
  await page.getByRole("button", { name: "Adicionar OAB" }).click();
  await expect(page.locator("#config-msg")).toContainText("Escolha a UF");
  expect(chamou(w, "oab_create")).toHaveLength(0);
  await page.locator("#oab-uf").selectOption("RJ");
  await page.getByRole("button", { name: "Adicionar OAB" }).click();
  await expect(page.locator("#config-corpo")).toContainText("OAB/RJ 222");
  await expect(page.locator("#config-msg")).toContainText("OAB cadastrada");
  expect(chamou(w, "oab_create")[0].corpo).toEqual({ name: "Bruno Lima", oab_number: "222", uf: "RJ" });

  await page.getByRole("button", { name: "Desativar" }).last().click();
  await expect(page.locator("#config-corpo .pill.off")).toHaveText("Inativa");
  await page.getByRole("button", { name: "Reativar" }).click();
  await expect(page.locator("#config-corpo .pill.off")).toHaveCount(0);
});

test("OABs: erro do servidor (duplicada) aparece em português dentro da tela", async ({ page }) => {
  const w = mundo({ oabs: [{ id: "oab-0", name: "Ana Souza", oab_number: "111", uf: "GO", active: true }], erros: { oab_create: { status: 409, body: { erro: "Esta OAB já está cadastrada no escritório." } } } });
  await instalar(page, w);
  await page.goto("/");
  await abrirConfig(page, "OABs");
  await page.locator("#oab-nome").fill("Ana Souza");
  await page.locator("#oab-numero").fill("111");
  await page.locator("#oab-uf").selectOption("GO");
  await page.getByRole("button", { name: "Adicionar OAB" }).click();
  await expect(page.locator("#config-msg")).toContainText("Esta OAB já está cadastrada no escritório.");
});

test("permissões: leitor vê tudo mas não tem formulários nem botões de alteração em nenhuma aba", async ({ page }) => {
  const w = mundo({
    escritorios: [{ id: "org-1", nome: "Silva", papel: "viewer" }],
    oabs: [{ id: "oab-0", name: "Ana", oab_number: "111", uf: "GO", active: true }],
    termos: [{ id: "t-0", term: "A.B.C.D.", kind: "sigla", active: true, attorney_id: "oab-0" }],
    membros: [OWNER, { id: "m-2", role: "viewer", user: { id: "u1", name: "Leitor", email: "dona@exemplo.test" } }],
  });
  w.membros[1].user.id = "u1";
  await instalar(page, w);
  await page.goto("/");
  await abrirConfig(page, "OABs");
  await expect(page.locator("#form-oab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Desativar" })).toHaveCount(0);
  await expect(page.locator("#config-corpo")).toContainText("não permite cadastrar OABs");
  await abrirConfig(page, "Termos de interesse");
  await expect(page.locator("#form-termo")).toHaveCount(0);
  await expect(page.locator("[data-acao=termo-toggle]")).toHaveCount(0);
  await expect(page.locator("#config-corpo")).toContainText("A.B.C.D.");
  await abrirConfig(page, "Equipe e convites");
  await expect(page.locator("#form-convite")).toHaveCount(0);
  await expect(page.locator("[data-acao=remover]")).toHaveCount(0);
  await expect(page.locator("[data-acao=papel]")).toHaveCount(0);
  await expect(page.locator("#config-corpo")).toContainText("não permite convidar");
});

test("termos de interesse: explica a regra, cadastra com advogado dono, troca o advogado e desativa", async ({ page }) => {
  const w = mundo({ oabs: [{ id: "oab-0", name: "Ana Souza", oab_number: "111", uf: "GO", active: true }] });
  await instalar(page, w);
  await page.goto("/");
  await abrirConfig(page, "Termos de interesse");
  await expect(page.locator("#config-corpo")).toContainText("não casa");
  await expect(page.locator("#config-corpo")).toContainText("ABCD LTDA");
  await page.locator("#termo-texto").fill("A.B.C.D.");
  await page.locator("#termo-adv").selectOption("oab-0");
  await page.getByRole("button", { name: "Adicionar termo" }).click();
  await expect(page.locator("#config-corpo")).toContainText("Sigla");
  expect(chamou(w, "interest_create")[0].corpo).toEqual({ term: "A.B.C.D.", attorney_id: "oab-0" });
  await expect(page.locator('[data-acao="termo-adv"]')).toHaveValue("oab-0");
  await page.locator('[data-acao="termo-adv"]').selectOption("");
  await expect.poll(() => chamou(w, "interest_update").length).toBe(1);
  expect(chamou(w, "interest_update")[0].corpo).toEqual({ id: "t-1", attorney_id: null });
  await page.getByRole("button", { name: "Desativar" }).click();
  await expect(page.locator("#config-corpo .pill.off")).toHaveText("Inativo");
});

test("equipe: lista, convida (mostra o link para copiar), cancela, troca papel e remove; admin não mexe em dono", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const w = mundo({
    membros: [OWNER, { id: "m-2", role: "member", user: { id: "u2", name: "Caio Membro", email: "caio@exemplo.test" } }],
    convites: [{ id: "convite-velho-1", email: "velho@exemplo.test", role: "viewer", status: "pending", expiresAt: "2026-12-30T12:00:00Z" }],
    recursos: { recuperacao_senha: false, cadastro_aberto: false, cadastro_por_convite: true, verificacao_email: false },
  });
  await instalar(page, w);
  await page.goto("/");
  await abrirConfig(page, "Equipe e convites");
  await expect(page.locator("#config-corpo")).toContainText("Dona Teste");
  await expect(page.locator("#config-corpo")).toContainText("Você");
  await expect(page.locator("#config-corpo")).toContainText("não envia e-mails"); // sem provedor: avisa que o dono compartilha o link
  await expect(page.locator("#config-corpo")).toContainText("velho@exemplo.test");
  await expect(page.locator('select[data-acao="papel"]')).toHaveCount(1); // não dá para mexer no próprio papel

  await page.locator("#convite-email").fill("nao-e-email");
  await page.getByRole("button", { name: "Convidar", exact: true }).click();
  await expect(page.locator("#config-msg")).toContainText("e-mail válido");
  await page.locator("#convite-email").fill("  Nova@Exemplo.test ");
  await page.locator("#convite-papel").selectOption("admin");
  await page.getByRole("button", { name: "Convidar", exact: true }).click();
  await expect(page.locator("#convite-link")).toHaveValue(/\/convite\/convite-novo-123$/);
  expect(chamou(w, "/organization/invite-member")[0].corpo).toEqual({ email: "nova@exemplo.test", role: "admin" });
  await expect(page.locator("#config-msg")).toContainText("Copie o link");
  await page.locator(".copy-box").getByRole("button", { name: "Copiar link" }).click();
  await expect(page.locator("#config-msg")).toContainText("Link copiado");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/convite\/convite-novo-123$/);

  await page.locator('select[data-acao="papel"]').selectOption("viewer");
  await expect(page.locator("#config-msg")).toContainText("Papel atualizado");
  expect(chamou(w, "/organization/update-member-role")[0].corpo).toEqual({ memberId: "m-2", role: "viewer" });

  await page.locator('[data-acao="cancelar"]').first().click();
  await expect.poll(() => chamou(w, "/organization/cancel-invitation").length).toBe(1);
  expect(chamou(w, "/organization/cancel-invitation")[0].corpo).toEqual({ invitationId: "convite-velho-1" });

  page.once("dialog", (d) => void d.dismiss());
  await page.locator('[data-acao="remover"]').click();
  expect(chamou(w, "/organization/remove-member")).toHaveLength(0); // cancelou a confirmação: nada removido
  page.once("dialog", (d) => void d.accept());
  await page.locator('[data-acao="remover"]').click();
  await expect(page.locator("#config-msg")).toContainText("Membro removido");
  expect(chamou(w, "/organization/remove-member")[0].corpo).toEqual({ memberIdOrEmail: "m-2" });
});

test("equipe: admin não vê controles sobre o proprietário e não oferece o papel 'Proprietário'", async ({ page }) => {
  const w = mundo({
    escritorios: [{ id: "org-1", nome: "Silva", papel: "admin" }],
    membros: [OWNER, { id: "m-2", role: "admin", user: { id: "u1", name: "Eu Admin", email: "dona@exemplo.test" } }, { id: "m-3", role: "member", user: { id: "u3", name: "Caio", email: "c@x.test" } }],
  });
  await instalar(page, w);
  await page.goto("/");
  await abrirConfig(page, "Equipe e convites");
  await expect(page.locator('select[data-acao="papel"]')).toHaveCount(1); // só o membro Caio (nem o dono, nem eu)
  await expect(page.locator('[data-acao="remover"]')).toHaveCount(1);
  expect(await page.locator("#convite-papel option").allTextContents()).toEqual(["Administrador", "Membro", "Leitor"]);
  expect(await page.locator('select[data-acao="papel"] option').allTextContents()).toEqual(["Administrador", "Membro", "Leitor"]);
});

test("equipe: nomes e e-mails com HTML não executam", async ({ page }) => {
  const w = mundo({ membros: [OWNER, { id: "m-2", role: "member", user: { id: "u2", name: `<img src=x onerror="window.__xss=1">`, email: `"><script>window.__xss=2</script>@x.test` } }] });
  await instalar(page, w);
  await page.goto("/");
  await abrirConfig(page, "Equipe e convites");
  await expect(page.locator("#config-corpo")).toContainText("<img");
  await expect(page.locator("#config-corpo img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});

test("o modal fecha com Esc e clicando fora; as abas são navegáveis e marcam a ativa", async ({ page }) => {
  const w = mundo({ oabs: [{ id: "o", name: "Ana", oab_number: "1", uf: "GO", active: true }] });
  await instalar(page, w);
  await page.goto("/");
  await page.getByRole("button", { name: "Configurações" }).click();
  await expect(page.getByRole("tab", { name: "OABs" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Equipe e convites" }).click();
  await expect(page.getByRole("tab", { name: "Equipe e convites" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "OABs" })).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-config")).not.toHaveClass(/modal-visible/);
  await page.getByRole("button", { name: "Configurações" }).click();
  await page.locator("#modal-config").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#modal-config")).not.toHaveClass(/modal-visible/);
});

// ── Fontes locais (privacidade) ───────────────────────────────────────────────

test("fontes Inter e Fraunces carregam do próprio servidor e nenhuma requisição sai para terceiros", async ({ page }) => {
  const externos: string[] = [];
  page.on("request", (r) => {
    if (!/^(http:\/\/127\.0\.0\.1|data:|blob:)/.test(r.url())) externos.push(r.url());
  });
  await instalar(page, mundo({ logado: null }));
  await page.goto("/");
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('400 16px "Inter"'), document.fonts.load('600 16px "Inter"'), document.fonts.load('400 32px "Fraunces"')]);
  });
  const ok = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")));
  expect(ok).toEqual(expect.arrayContaining(["Inter", "Fraunces"]));
  expect(externos).toEqual([]);
});
