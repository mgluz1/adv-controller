import { test, expect, type Page } from "@playwright/test";

// Nenhum teste fala com um backend real: as operações de /api/v1/* são interceptadas com fixtures
// locais (dados fictícios). O contrato das operações está em docs/MIGRACAO.md.

// Isolamento: os testes nunca saem do localhost (fontes externas e qualquer outro host são abortados).
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
});

const OAB_A = { id: "adv-a-id", name: "Advogada TESTE", oab_number: "123456", uf: "GO" };
const OAB_B = { id: "adv-b-id", name: "Advogado TESTE", oab_number: "234567", uf: "RJ" };

/** Intercepta /api/v1/*; `operacao(nome, corpo)` devolve o JSON da resposta (ou undefined para abortar). */
async function interceptarApi(
  page: Page,
  operacao: (nome: string, corpo: any) => unknown,
) {
  let logado = false;
  await page.route("**/api/v1/**", async (route) => {
    const nome = new URL(route.request().url()).pathname.split("/").pop()!;
    const corpo = route.request().postDataJSON() || {};
    let data: unknown;
    if (nome === "session")
      data = { usuario: logado ? { id: "u1", email: "fixture@example.invalid" } : null };
    else if (nome === "sign-in") {
      logado = true;
      data = { ok: true };
    } else data = operacao(nome, corpo);
    if (data === undefined) return route.abort();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
}

async function entrar(page: Page) {
  await page.goto("/");
  await page.getByLabel("E-mail", { exact: true }).fill("fixture@example.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("fixture-only-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

test("interface exige login e, sem backend configurado, nada simula sessão nem dados", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("dialog", { name: "Acesso do escritório" }),
  ).toBeVisible();
  await expect(page.getByLabel("E-mail", { exact: true })).toBeVisible();
  // Servidor de teste sem banco: a API responde 503 e não simula sessão nem dados.
  expect((await request.post("/api/v1/session")).status()).toBe(503);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/login-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Entrar", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/login-mobile.png" });
  // Mostrar/ocultar senha
  const senha = page.getByLabel("Senha", { exact: true });
  await expect(senha).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Mostrar senha" }).click();
  await expect(senha).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Ocultar senha" }).click();
  await expect(senha).toHaveAttribute("type", "password");
  // Campos com 16px ou mais: o iOS não dá zoom ao focar
  const fonte = await page
    .locator("#login-email")
    .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(fonte).toBeGreaterThanOrEqual(16);
});

test("UI com fixture isolada: filtros, expansão, notas, arquivo e prevenção de XSS", async ({
  page,
}) => {
  let archived = false;
  let removed = false;
  let status = "a_revisar";
  let notes = "";
  let note = "";
  let lastFilter: any;
  const fixture = () => ({
    id: "fixture",
    source_id: "123456",
    available_on: "2026-10-19",
    published_on: null,
    tribunal: "TJGO",
    judging_body: "TESTE LOCAL",
    process_number: "123' onclick='alert(1)",
    process_mask: "123",
    class_name: "TESTE",
    communication_type: "TESTE",
    original_text: '<img src=x onerror="window.xss=true">',
    status,
    notes,
    action_note: note,
    first_seen_at: "2026-10-19T12:00:00Z",
    last_seen_at: "2026-10-19T12:00:00Z",
    archived_at: archived ? "2026-10-19T12:00:00Z" : null,
    attorneys: [OAB_A, OAB_B],
  });
  await interceptarApi(page, (nome, corpo) => {
    if (nome === "djen_list") {
      lastFilter = corpo.p_filter;
      const visible = !removed && !!corpo.p_filter?.archived === archived;
      return {
        total: visible ? 1 : 0,
        rows: visible ? [fixture()] : [],
        stats: { total: visible ? 1 : 0, revisar: 1, analise: 0, concluida: 0 },
        attorney_stats: [
          { ...OAB_A, total: 1, revisar: 1 },
          { ...OAB_B, total: 1, revisar: 1 },
        ],
        tab_stats: {
          todos: { total: 1, revisar: 1 },
          [OAB_A.id]: { total: 1, revisar: 1 },
          [OAB_B.id]: { total: 1, revisar: 1 },
        },
        tribunals: [{ tribunal: "TJGO" }],
        pending_windows: 0,
        latest: null,
        last_success: null,
        next_due: null,
      };
    }
    if (nome === "djen_mutate") {
      if (corpo.p_action === "archive") archived = true;
      if (corpo.p_action === "restore") archived = false;
      if (corpo.p_action === "remove") removed = true;
      if (corpo.p_action === "status") {
        status = corpo.p_status;
        notes = corpo.p_notes ?? notes;
        note = corpo.p_providence ?? note;
      }
      return 1;
    }
  });
  await entrar(page);
  await expect(page.locator(".pub-row")).toHaveCount(1);
  // As abas são geradas a partir dos advogados informados pelo servidor
  await expect(page.locator(".lawyer-tab")).toHaveCount(3);
  await page.getByRole("button", { name: OAB_B.name, exact: false }).click();
  await expect.poll(() => lastFilter?.attorney).toBe(OAB_B.id);
  await page.getByLabel("Tribunal", { exact: true }).selectOption("TJGO");
  await expect.poll(() => lastFilter?.tribunal).toBe("TJGO");
  await page.locator(".pub-row").click();
  await expect(page.locator(".full-text-pre")).toContainText("<img");
  expect(await page.evaluate(() => !!(window as any).xss)).toBe(false);
  await expect(page.locator(".badge-adv")).toHaveCount(2);
  await expect(page.locator(".badge-adv.tag-adv-0")).toHaveCount(1);
  await expect(page.locator(".badge-adv.tag-adv-1")).toHaveCount(1);
  await expect(page.locator(".col-data-pub .data-principal")).toHaveText(
    "Não informada",
  );
  await page.getByRole("button", { name: "Anotar Providência" }).click();
  await page.locator("#input-anotacao-obs").fill("Nota teste");
  await page.locator("#input-anotacao-providencia").fill("Revisar teste");
  await page.locator("#btn-salvar-anotacao").click();
  await expect.poll(() => notes).toBe("Nota teste");
  await page.locator(".select-status").selectOption("Em análise");
  await expect.poll(() => status).toBe("em_analise");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Arquivar", exact: true }).click();
  await expect(page.locator(".pub-row")).toHaveCount(0);
  await page.getByLabel("Arquivo", { exact: true }).selectOption("archived");
  await expect(page.locator(".pub-row")).toHaveCount(1);
  await page.locator(".pub-row").click();
  await page.getByRole("button", { name: "Restaurar", exact: true }).click();
  await expect(page.locator(".pub-row")).toHaveCount(0);
});

test("aba de termos de interesse: contadores por aba e exclusão só na apresentação da aba do advogado A", async ({
  page,
}) => {
  // Fixture local: reproduz a resposta do servidor para uma publicação que casa com os termos de
  // interesse e está vinculada às duas OABs. A regra em si é especificada em docs/REGRAS_DE_NEGOCIO.md.
  const abasPedidas: string[] = [];
  const pub = {
    id: "fixture-interesse",
    source_id: "999001",
    available_on: "2026-10-19",
    published_on: null,
    tribunal: "TRT18",
    judging_body: "VARA TESTE",
    process_number: "0000000-00.2026.5.18.0000",
    process_mask: "0000000-00.2026.5.18.0000",
    class_name: "TESTE",
    communication_type: "Intimação",
    original_text: "RÉU: A.B.C.D. EXEMPLO EMPREENDIMENTOS LTDA",
    status: "a_revisar",
    notes: null,
    action_note: null,
    first_seen_at: "2026-10-19T12:00:00Z",
    last_seen_at: "2026-10-19T12:00:00Z",
    archived_at: null,
    attorneys: [OAB_A, OAB_B],
  };
  await interceptarApi(page, (nome, corpo) => {
    if (nome !== "djen_list") return undefined;
    const aba = corpo.p_filter?.attorney || "todos";
    abasPedidas.push(aba);
    const visivel = aba !== OAB_A.id;
    return {
      total: visivel ? 1 : 0,
      rows: visivel ? [pub] : [],
      stats: { total: visivel ? 1 : 0, revisar: visivel ? 1 : 0, analise: 0, concluida: 0 },
      attorney_stats: [
        { ...OAB_A, total: 0, revisar: 0 },
        { ...OAB_B, total: 1, revisar: 1 },
      ],
      tab_stats: {
        todos: { total: 1, revisar: 1 },
        [OAB_A.id]: { total: 0, revisar: 0 },
        [OAB_B.id]: { total: 1, revisar: 1 },
        interesse: { total: 1, revisar: 1 },
      },
      tribunals: [{ tribunal: "TRT18" }],
      pending_windows: 0,
      latest: null,
      last_success: null,
      next_due: null,
    };
  });
  await entrar(page);

  const aba = (chave: string) => page.locator(`.lawyer-tab[data-lawyer="${chave}"]`);
  await expect(aba("interesse")).toContainText("Termos de interesse");
  await expect(page.locator("#badge-tab-interesse")).toHaveText("1 para atuar (1 total)");
  await expect(page.locator(`[id="badge-tab-${OAB_A.id}"]`)).toHaveText("0 para atuar (0 total)");
  await expect(page.locator(`[id="badge-tab-${OAB_B.id}"]`)).toHaveText("1 para atuar (1 total)");
  await expect(page.locator("#badge-tab-todos")).toHaveText("1");
  await expect(page.locator(".pub-row")).toHaveCount(1);

  await aba("interesse").click();
  await expect(aba("interesse")).toHaveClass(/active/);
  await expect(page.locator(".pub-row")).toHaveCount(1);
  expect(abasPedidas.at(-1)).toBe("interesse");

  await aba(OAB_A.id).click();
  await expect(page.locator(".pub-row")).toHaveCount(0);
  await expect(page.locator("#empty-state")).toBeVisible();
  expect(abasPedidas.at(-1)).toBe(OAB_A.id);
  // Contadores não dependem da aba ativa
  await expect(page.locator("#badge-tab-todos")).toHaveText("1");
  await expect(page.locator("#badge-tab-interesse")).toHaveText("1 para atuar (1 total)");

  await aba(OAB_B.id).click();
  await expect(page.locator(".pub-row")).toHaveCount(1);

  await aba("todos").click();
  await expect(aba("todos")).toHaveClass(/active/);
  await expect(aba(OAB_B.id)).not.toHaveClass(/active/);
  await expect(page.locator(".pub-row")).toHaveCount(1);
  expect(abasPedidas.at(-1)).toBe("todos");
  await page.waitForTimeout(400); // fim das transições de CSS antes da captura
  await page.screenshot({ path: "test-results/aba-interesse.png" });
});
