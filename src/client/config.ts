// Configurações do escritório (OABs, termos de interesse, equipe e convites) e o seletor de escritório do cabeçalho.
// A interface só ESCONDE o que o papel não pode fazer; quem impõe as regras é o servidor (e o banco).
import {
  alterarPapelMembro,
  atualizarOab,
  atualizarTermo,
  cancelarConvite,
  convidarMembro,
  criarOab,
  criarTermo,
  listarOabs,
  listarTermos,
  obterEscritorioCompleto,
  removerMembro,
  temPermissao,
  trocarEscritorio,
  type Oab,
  type Sessao,
} from "./api.ts";
import { PAPEIS, UFS, escapeHtml, linkConvite, papelDescricao, papelRotulo, papeisAtribuiveis } from "./util.ts";

type Aba = "oabs" | "termos" | "equipe";
let sessao: Sessao;
let aba: Aba = "oabs";

const corpo = () => document.getElementById("config-corpo")!;
const modal = () => document.getElementById("modal-config")!;
const fmtData = (iso: string) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(iso));

function aviso(texto: string, ok = false) {
  const el = document.getElementById("config-msg");
  if (!el) return;
  el.textContent = texto;
  el.className = "config-msg" + (ok ? " ok" : "");
}
async function executar(acao: () => Promise<void>, okMsg?: string) {
  try {
    await acao();
    if (okMsg) aviso(okMsg, true);
  } catch (e) {
    aviso((e as Error).message);
  }
}
const ufOptions = (sel = "") => `<option value="">UF</option>` + UFS.map((u) => `<option value="${u}"${u === sel ? " selected" : ""}>${u}</option>`).join("");

// ── Cabeçalho: escritório ativo e botão de configurações ──────────────────────
export function montarCabecalho(s: Sessao) {
  sessao = s;
  const barra = document.getElementById("office-bar")!;
  const nome = document.getElementById("office-name")!;
  const seletor = document.getElementById("office-select") as HTMLSelectElement;
  if (!s.escritorio) return;
  barra.hidden = false;
  if (s.escritorios.length > 1) {
    seletor.hidden = false;
    nome.hidden = true;
    seletor.innerHTML = s.escritorios.map((e) => `<option value="${escapeHtml(e.id)}"${e.id === s.escritorio!.id ? " selected" : ""}>${escapeHtml(e.nome)}</option>`).join("");
    seletor.addEventListener("change", async () => {
      seletor.disabled = true;
      try {
        await trocarEscritorio(seletor.value);
        location.reload();
      } catch {
        seletor.disabled = false;
        seletor.value = s.escritorio!.id;
      }
    });
  } else {
    nome.hidden = false;
    nome.textContent = s.escritorio.nome;
    nome.title = `${s.escritorio.nome} — ${papelRotulo(s.escritorio.papel)}`;
  }
  const btn = document.getElementById("btn-abrir-config") as HTMLButtonElement;
  btn.hidden = false;
  btn.addEventListener("click", () => abrirConfig());
  document.getElementById("btn-fechar-config")!.addEventListener("click", fecharConfig);
  modal().addEventListener("click", (ev) => ev.target === modal() && fecharConfig());
  document.addEventListener("keydown", (ev) => ev.key === "Escape" && modal().classList.contains("modal-visible") && fecharConfig());
  document.querySelectorAll<HTMLButtonElement>(".config-tab").forEach((t) => t.addEventListener("click", () => void trocarAba(t.dataset.tab as Aba)));
}

export function abrirConfig(destino?: Aba) {
  modal().classList.add("modal-visible");
  void trocarAba(destino ?? aba);
}
function fecharConfig() {
  modal().classList.remove("modal-visible");
}
async function trocarAba(nova: Aba) {
  aba = nova;
  document.querySelectorAll<HTMLButtonElement>(".config-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === nova)));
  corpo().innerHTML = `<p class="config-help">Carregando…</p>`;
  try {
    if (nova === "oabs") await renderOabs();
    else if (nova === "termos") await renderTermos();
    else await renderEquipe();
  } catch (e) {
    corpo().innerHTML = `<p class="config-msg" role="alert" id="config-msg">${escapeHtml((e as Error).message)}</p>`;
  }
}

// ── OABs ──────────────────────────────────────────────────────────────────────
async function renderOabs() {
  const oabs = await listarOabs();
  const gerencia = temPermissao(sessao, "attorney:update");
  const cria = temPermissao(sessao, "attorney:create");
  corpo().innerHTML = `
    <div><h3>OABs monitoradas</h3>
    <p class="config-help">A coleta no DJEN começa assim que a OAB é cadastrada (primeiro os últimos 30 dias). Uma OAB nunca é excluída: desative-a para parar a coleta; as publicações já coletadas continuam disponíveis.</p></div>
    ${
      oabs.length
        ? `<table class="config-table"><thead><tr><th>Advogado(a)</th><th>OAB</th><th>Situação</th><th></th></tr></thead><tbody>${oabs
            .map(
              (o) => `<tr class="${o.active ? "" : "inativa"}"><td>${escapeHtml(o.name)}</td><td>OAB/${escapeHtml(o.uf)} ${escapeHtml(o.oab_number)}</td>
              <td><span class="pill ${o.active ? "" : "off"}">${o.active ? "Ativa" : "Inativa"}</span></td>
              <td class="acoes">${gerencia ? `<button class="btn-secondary btn-mini" data-acao="oab-toggle" data-id="${escapeHtml(o.id)}" data-ativa="${o.active}">${o.active ? "Desativar" : "Reativar"}</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<div class="config-vazio">Nenhuma OAB cadastrada. Cadastre a primeira para começar a receber publicações.</div>`
    }
    ${
      cria
        ? `<form class="config-form" id="form-oab" novalidate>
            <label class="grow">Nome do(a) advogado(a)<input id="oab-nome" maxlength="120" autocomplete="off" required /></label>
            <label>Número da OAB<input id="oab-numero" inputmode="numeric" maxlength="9" autocomplete="off" required style="width:120px" /></label>
            <label>UF<select id="oab-uf" required>${ufOptions()}</select></label>
            <button class="btn-primary" type="submit">Adicionar OAB</button></form>`
        : `<p class="config-help">Seu papel (${escapeHtml(papelRotulo(sessao.escritorio?.papel))}) não permite cadastrar OABs.</p>`
    }
    <p id="config-msg" class="config-msg" role="alert"></p>`;
  document.getElementById("form-oab")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void executar(async () => {
      const nome = (document.getElementById("oab-nome") as HTMLInputElement).value;
      const numero = (document.getElementById("oab-numero") as HTMLInputElement).value;
      const uf = (document.getElementById("oab-uf") as HTMLSelectElement).value;
      if (!uf) throw new Error("Escolha a UF da OAB.");
      await criarOab(nome, numero, uf);
      await renderOabs();
      aviso("OAB cadastrada. A coleta no DJEN começa em instantes.", true);
    });
  });
  corpo().querySelectorAll<HTMLButtonElement>('[data-acao="oab-toggle"]').forEach((b) =>
    b.addEventListener("click", () =>
      void executar(async () => {
        await atualizarOab(b.dataset.id!, { active: b.dataset.ativa !== "true" });
        await renderOabs();
      }),
    ),
  );
}

// ── Termos de interesse ───────────────────────────────────────────────────────
async function renderTermos() {
  const [termos, oabs] = await Promise.all([listarTermos(), listarOabs().catch((): Oab[] => [])]);
  const cria = temPermissao(sessao, "interest:create");
  const gerencia = temPermissao(sessao, "interest:update");
  const nomeOab = (id: string | null) => {
    const o = oabs.find((x) => x.id === id);
    return o ? `${o.name} (OAB/${o.uf} ${o.oab_number})` : "—";
  };
  const opcoesOab = (sel: string | null) => `<option value="">Nenhum (só na aba de interesse)</option>` + oabs.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === sel ? " selected" : ""}>${escapeHtml(o.name)} — OAB/${escapeHtml(o.uf)} ${escapeHtml(o.oab_number)}</option>`).join("");
  corpo().innerHTML = `
    <div><h3>Termos de interesse</h3>
    <p class="config-help">Destaque publicações que citam um cliente ou uma sigla no <strong>teor</strong> ou entre as <strong>partes</strong>, sem diferenciar maiúsculas. Elas ganham uma aba própria. Uma <strong>sigla</strong> é escrita com pontos (<code>A.B.C.D.</code>, que também casa com <code>A. B. C. D.</code>) e só vale como palavra inteira: não casa <code>ABCD LTDA</code> nem <code>A.B.C.DTDA</code>. Qualquer outro texto vale como expressão exata.</p>
    <p class="config-help">Se você escolher um advogado, as publicações que casam <strong>saem da aba dele</strong> e ficam só na aba de interesse (continuam nas abas de outros advogados vinculados e em "Todos").</p></div>
    ${
      termos.length
        ? `<table class="config-table"><thead><tr><th>Termo</th><th>Tipo</th><th>Sai da aba de</th><th>Situação</th><th></th></tr></thead><tbody>${termos
            .map(
              (t) => `<tr class="${t.active ? "" : "inativa"}"><td><code>${escapeHtml(t.term)}</code></td><td>${t.kind === "sigla" ? "Sigla" : "Expressão"}</td>
              <td>${gerencia ? `<select class="config-select" data-acao="termo-adv" data-id="${escapeHtml(t.id)}" aria-label="Advogado do termo ${escapeHtml(t.term)}">${opcoesOab(t.attorney_id)}</select>` : escapeHtml(nomeOab(t.attorney_id))}</td>
              <td><span class="pill ${t.active ? "" : "off"}">${t.active ? "Ativo" : "Inativo"}</span></td>
              <td class="acoes">${gerencia ? `<button class="btn-secondary btn-mini" data-acao="termo-toggle" data-id="${escapeHtml(t.id)}" data-ativo="${t.active}">${t.active ? "Desativar" : "Reativar"}</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<div class="config-vazio">Nenhum termo cadastrado.</div>`
    }
    ${
      cria
        ? `<form class="config-form" id="form-termo" novalidate>
            <label class="grow">Termo (sigla ou expressão)<input id="termo-texto" maxlength="80" autocomplete="off" placeholder="Ex.: A.B.C.D." required /></label>
            <label class="grow">Sai da aba de (opcional)<select id="termo-adv">${opcoesOab(null)}</select></label>
            <button class="btn-primary" type="submit">Adicionar termo</button></form>`
        : `<p class="config-help">Seu papel (${escapeHtml(papelRotulo(sessao.escritorio?.papel))}) não permite alterar os termos.</p>`
    }
    <p id="config-msg" class="config-msg" role="alert"></p>`;
  document.getElementById("form-termo")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void executar(async () => {
      const texto = (document.getElementById("termo-texto") as HTMLInputElement).value;
      const adv = (document.getElementById("termo-adv") as HTMLSelectElement).value || null;
      await criarTermo(texto, adv);
      await renderTermos();
      aviso("Termo adicionado. A aba de interesse já considera as publicações existentes.", true);
    });
  });
  corpo().querySelectorAll<HTMLButtonElement>('[data-acao="termo-toggle"]').forEach((b) =>
    b.addEventListener("click", () => void executar(async () => { await atualizarTermo(b.dataset.id!, { active: b.dataset.ativo !== "true" }); await renderTermos(); })),
  );
  corpo().querySelectorAll<HTMLSelectElement>('[data-acao="termo-adv"]').forEach((s) =>
    s.addEventListener("change", () => void executar(async () => { await atualizarTermo(s.dataset.id!, { attorney_id: s.value || null }); aviso("Termo atualizado.", true); })),
  );
}

// ── Equipe e convites ─────────────────────────────────────────────────────────
async function renderEquipe() {
  const esc = await obterEscritorioCompleto();
  const meuPapel = sessao.escritorio?.papel ?? "";
  const meuId = sessao.usuario?.id;
  const atribuiveis = papeisAtribuiveis(meuPapel);
  const convida = temPermissao(sessao, "invitation:create");
  const gerenciaMembros = temPermissao(sessao, "member:update");
  const remove = temPermissao(sessao, "member:delete");
  const souDono = meuPapel.split(",").includes("owner");
  const pendentes = (esc.invitations ?? []).filter((i) => i.status === "pending");
  const emailAtivo = sessao.recursos.recuperacao_senha; // e-mail transacional ligado no servidor

  corpo().innerHTML = `
    <div><h3>Equipe</h3>
    <p class="config-help">${PAPEIS.map((p) => `<strong>${papelRotulo(p)}</strong>: ${papelDescricao(p)}`).join(" · ")}.</p></div>
    <table class="config-table"><thead><tr><th>Pessoa</th><th>Papel</th><th></th></tr></thead><tbody>${esc.members
      .map((m) => {
        const eu = m.user.id === meuId;
        const alvoEhDono = m.role.split(",").includes("owner");
        const editavel = gerenciaMembros && !eu && (souDono || !alvoEhDono);
        return `<tr><td>${escapeHtml(m.user.name)}${eu ? ' <span class="pill">Você</span>' : ""}<br /><span class="config-help">${escapeHtml(m.user.email)}</span></td>
          <td>${editavel ? `<select class="config-select" data-acao="papel" data-id="${escapeHtml(m.id)}" aria-label="Papel de ${escapeHtml(m.user.name)}">${atribuiveis.map((p) => `<option value="${p}"${m.role === p ? " selected" : ""}>${papelRotulo(p)}</option>`).join("")}</select>` : escapeHtml(papelRotulo(m.role))}</td>
          <td class="acoes">${remove && !eu && (souDono || !alvoEhDono) ? `<button class="btn-secondary btn-mini" data-acao="remover" data-id="${escapeHtml(m.id)}" data-nome="${escapeHtml(m.user.name)}">Remover</button>` : ""}</td></tr>`;
      })
      .join("")}</tbody></table>
    ${
      pendentes.length
        ? `<div><h3>Convites pendentes</h3></div><table class="config-table"><thead><tr><th>E-mail</th><th>Papel</th><th>Vale até</th><th></th></tr></thead><tbody>${pendentes
            .map(
              (i) => `<tr><td>${escapeHtml(i.email)}</td><td>${escapeHtml(papelRotulo(i.role))}</td><td><span class="pill pend">${escapeHtml(fmtData(i.expiresAt))}</span></td>
              <td class="acoes"><button class="btn-secondary btn-mini" data-acao="copiar" data-link="${escapeHtml(linkConvite(location.origin, i.id))}">Copiar link</button>
              ${convida ? `<button class="btn-secondary btn-mini" data-acao="cancelar" data-id="${escapeHtml(i.id)}">Cancelar</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : ""
    }
    ${
      convida
        ? `<div><h3>Convidar pessoa</h3><p class="config-help">${emailAtivo ? "A pessoa recebe um e-mail com o link do convite (vale por 7 dias) e cria a conta por ele." : "Este servidor não envia e-mails: depois de convidar, copie o link e envie você mesmo. O link vale por 7 dias e só funciona para o e-mail informado."}</p></div>
          <form class="config-form" id="form-convite" novalidate>
            <label class="grow">E-mail<input id="convite-email" type="email" autocomplete="off" autocapitalize="none" spellcheck="false" required /></label>
            <label>Papel<select id="convite-papel">${atribuiveis.filter((p) => p !== "owner" || souDono).map((p) => `<option value="${p}"${p === "member" ? " selected" : ""}>${papelRotulo(p)}</option>`).join("")}</select></label>
            <button class="btn-primary" type="submit">Convidar</button></form>
          <div id="convite-resultado"></div>`
        : `<p class="config-help">Seu papel (${escapeHtml(papelRotulo(meuPapel))}) não permite convidar pessoas.</p>`
    }
    <p id="config-msg" class="config-msg" role="alert"></p>`;

  document.getElementById("form-convite")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void executar(async () => {
      const email = (document.getElementById("convite-email") as HTMLInputElement).value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("Informe um e-mail válido.");
      const papel = (document.getElementById("convite-papel") as HTMLSelectElement).value;
      const inv = await convidarMembro(email, papel);
      await renderEquipe();
      const link = linkConvite(location.origin, inv.id);
      document.getElementById("convite-resultado")!.innerHTML = `<div class="copy-box"><input id="convite-link" readonly value="${escapeHtml(link)}" aria-label="Link do convite" /><button class="btn-secondary btn-mini" data-acao="copiar" data-link="${escapeHtml(link)}">Copiar link</button></div>`;
      ligarCopiar();
      aviso(emailAtivo ? `Convite enviado para ${email}. O link abaixo também funciona.` : `Convite criado para ${email}. Copie o link abaixo e envie à pessoa.`, true);
    });
  });
  corpo().querySelectorAll<HTMLSelectElement>('[data-acao="papel"]').forEach((s) =>
    s.addEventListener("change", () => void executar(async () => { await alterarPapelMembro(s.dataset.id!, s.value); await renderEquipe(); aviso("Papel atualizado.", true); })),
  );
  corpo().querySelectorAll<HTMLButtonElement>('[data-acao="remover"]').forEach((b) =>
    b.addEventListener("click", () => {
      if (!confirm(`Remover ${b.dataset.nome} do escritório? A pessoa perde o acesso imediatamente.`)) return;
      void executar(async () => { await removerMembro(b.dataset.id!); await renderEquipe(); aviso("Membro removido.", true); });
    }),
  );
  corpo().querySelectorAll<HTMLButtonElement>('[data-acao="cancelar"]').forEach((b) =>
    b.addEventListener("click", () => void executar(async () => { await cancelarConvite(b.dataset.id!); await renderEquipe(); aviso("Convite cancelado.", true); })),
  );
  ligarCopiar();
}

function ligarCopiar() {
  corpo().querySelectorAll<HTMLButtonElement>('[data-acao="copiar"]').forEach((b) => {
    if (b.dataset.ligado) return;
    b.dataset.ligado = "1";
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.link!);
        aviso("Link copiado.", true);
      } catch {
        aviso(`Copie manualmente: ${b.dataset.link}`);
      }
    });
  });
}
