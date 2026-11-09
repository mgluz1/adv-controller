import {
  fetchPublicacoes,
  atualizarStatusPublicacao,
  removerPublicacao,
  obterPreviewRemocaoLote,
  executarRemocaoLote,
  dispararSincronizacaoManual,
  obterDiagnosticoSistema,
  haSessaoAtiva,
  entrar,
  sair,
  restaurarPublicacao,
  excluirPublicacao,
  invalidarPreview,
  PublicacaoItem,
  ListarPublicacoesResponse,
  AbaInfo,
} from "./api.js";

// =========================================================================
// UTILITÁRIO DE ESCAPE XSS (SEGURANÇA DE CONTEÚDO EXTERNO)
// =========================================================================
function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Formatar data YYYY-MM-DD para DD/MM/AAAA
function formatarDataBR(dataStr?: string | null): string {
  if (!dataStr) return "Não informada";
  const partes = dataStr.split("-");
  if (partes.length === 3) {
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
  }
  return dataStr;
}

// =========================================================================
// ESTADO GLOBAL DA INTERFACE
// =========================================================================
interface AppState {
  advogado: string;
  status: string;
  busca: string;
  periodoDias: string;
  tribunal: string;
  archived: boolean;
  ordem: "desc" | "asc";
  pagina: number;
  itensPorPagina: number;
  expandedIds: Set<number>;
  carregando: boolean;
  sincronizando: boolean;
}

const state: AppState = {
  advogado: "todos",
  status: "todos",
  busca: "",
  periodoDias: "todos",
  tribunal: "",
  archived: false,
  ordem: "desc",
  pagina: 1,
  itensPorPagina: 20,
  expandedIds: new Set<number>(),
  carregando: false,
  sincronizando: false,
};

let dadosAtuais: ListarPublicacoesResponse | null = null;
// Variação visual do marcador de cada advogado (0–3), pela ordem das abas.
let corPorAdvogado = new Map<string, number>();
let buscaDebounceTimer: any = null;
let loadSequence = 0;

// =========================================================================
// EXIBIÇÃO DE TOAST
// =========================================================================
function mostrarToast(
  mensagem: string,
  tipo: "info" | "sucesso" | "erro" = "sucesso",
) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = mensagem;
  toast.className = `toast toast-${tipo} visible`;

  clearTimeout((toast as any)._timeout);
  (toast as any)._timeout = setTimeout(() => {
    toast.className = "toast";
  }, 4000);
}

// =========================================================================
// CARREGAMENTO DE DADOS
// =========================================================================
async function carregarDados() {
  const sequence = ++loadSequence;
  state.carregando = true;
  atualizarIndicadoresCarregamento();

  try {
    // Calcular período em datas se selecionado
    let dataInicio: string | undefined;
    let dataFim: string | undefined;

    if (state.periodoDias !== "todos") {
      const dias = parseInt(state.periodoDias, 10);
      const hoje = new Date();
      const pass = new Date();
      pass.setDate(hoje.getDate() - dias);
      dataInicio = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
      }).format(pass);
      dataFim = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
      }).format(hoje);
    }

    const offset = (state.pagina - 1) * state.itensPorPagina;

    const res = await fetchPublicacoes({
      tribunal: state.tribunal,
      archived: state.archived,
      advogadoId: state.advogado,
      status: state.status,
      busca: state.busca,
      dataInicio,
      dataFim,
      ordem: state.ordem,
      limite: state.itensPorPagina,
      offset,
    });

    if (sequence !== loadSequence) return;
    dadosAtuais = res;
    renderizarInterface();
  } catch (err: any) {
    if (sequence !== loadSequence) return;
    dadosAtuais = null;
    mostrarToast(err.message || "Erro ao carregar dados.", "erro");
    renderizarErro(err.message);
  } finally {
    if (sequence === loadSequence) {
      state.carregando = false;
      atualizarIndicadoresCarregamento();
    }
  }
}

// =========================================================================
// RENDERIZAÇÃO PRINCIPAL
// =========================================================================
function renderizarInterface() {
  if (!dadosAtuais) return;

  // 1. Atualizar Header e Metadados
  atualizarHeaderEMetadados(dadosAtuais);

  // 2. Renderizar abas por advogado e atualizar badges
  renderizarAbas(dadosAtuais.abas, dadosAtuais.estatisticas);

  // 3. Renderizar Linhas da Tabela
  renderizarTabela(dadosAtuais.publicacoes, dadosAtuais.total);

  const tribunais = document.getElementById(
    "filter-tribunal",
  ) as HTMLSelectElement;
  tribunais.innerHTML =
    '<option value="">Tribunal: Todos</option>' +
    dadosAtuais.tribunais
      .map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
      .join("");
  tribunais.value = state.tribunal;
  // 4. Renderizar Paginação
  renderizarPaginacao(dadosAtuais.total);

  // 5. Atualizar banner de estado da coleta
  atualizarBannerModo();
}

function atualizarIndicadoresCarregamento() {
  const btnSync = document.getElementById(
    "btn-buscar-agora",
  ) as HTMLButtonElement | null;
  if (btnSync) {
    btnSync.disabled = state.sincronizando || state.carregando;
    btnSync.classList.toggle("loading", state.sincronizando);
  }

  const spinner = document.getElementById("table-loading-spinner");
  if (spinner) {
    spinner.style.display = state.carregando ? "flex" : "none";
  }
}

function atualizarHeaderEMetadados(dados: ListarPublicacoesResponse) {
  // Horário de leitura do banco pelo cliente
  const pillBanco = document.getElementById("pill-horario-banco");
  if (pillBanco) {
    pillBanco.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
      </svg>
      <span>Dados lidos do banco: <strong>${escapeHtml(dados.horarioLeituraBancoFormatado)}</strong></span>
    `;
  }

  // Horário da última consulta no DJEN oficial pelo servidor
  const pillDjen = document.getElementById("pill-horario-djen");
  if (pillDjen) {
    let textoDjen = "Nenhuma coleta registrada";
    let statusClass = "";

    if (
      dados.ultimaColetaDjenFormatada &&
      dados.ultimaColetaDjenFormatada !== "Não registrada"
    ) {
      textoDjen = dados.ultimaColetaDjenFormatada;
    } else if (
      dados.ultimaTentativaDjenFormatada &&
      dados.ultimaTentativaDjenFormatada !== "Não registrada"
    ) {
      const detalheErro =
        dados.statusColeta === "failed"
          ? "(Falha na última tentativa)"
          : `(${dados.statusColeta})`;
      textoDjen = `${dados.ultimaTentativaDjenFormatada} ${detalheErro}`;
      statusClass = "pill-warning";
    }

    pillDjen.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
        <path d="M3 3v5h5"/>
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
        <path d="M16 21h5v-5"/>
      </svg>
      <span>Última coleta DJEN: <strong>${escapeHtml(textoDjen)}</strong></span>
    `;
    if (statusClass) {
      pillDjen.title =
        dados.erroColeta || "Consulte o diagnóstico da última tentativa";
    }
  }

  // Próxima coleta automática prevista
  const pillProxima = document.getElementById("pill-proxima-coleta");
  if (pillProxima) {
    const textoProx =
      dados.proximaColetaPrevistaFormatada &&
      dados.proximaColetaPrevistaFormatada !== "Não registrada"
        ? dados.proximaColetaPrevistaFormatada
        : "Aguardando ativação da conta";
    pillProxima.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
      <span>Próxima automação: <strong>${escapeHtml(textoProx)}</strong></span>
    `;
  }

  // Contador geral de pendências e a revisar
  const pendingCounter = document.getElementById("pending-counter-text");
  if (pendingCounter) {
    const aRevisar = dados.estatisticas.aRevisar || 0;
    const pendentes = dados.estatisticas.pendentes || 0;
    const emAndamento = dados.estatisticas.emAndamento || 0;
    pendingCounter.textContent = `${aRevisar} a revisar • ${emAndamento} em análise • ${dados.estatisticas.concluidas || 0} concluídas`;
  }
}

function renderizarAbas(abas: AbaInfo[], stats: any) {
  const nav = document.getElementById("lawyer-tabs");
  if (!nav) return;
  // Contadores vêm de porAba: mesma regra das linhas, independentes da aba ativa.
  const porAba = stats.porAba || {};

  // Abas dinâmicas (advogados do escritório + termos de interesse): recriadas a cada carga;
  // "Todos" é fixa no HTML. Texto via textContent (sem HTML vindo do servidor).
  nav.querySelectorAll(".lawyer-tab:not([data-lawyer='todos'])").forEach((el) => el.remove());
  corPorAdvogado = new Map(
    abas.filter((a) => a.tipo === "advogado").map((a, i) => [a.chave, i % 4]),
  );
  for (const aba of abas) {
    const btn = document.createElement("button");
    btn.className = "lawyer-tab" + (state.advogado === aba.chave ? " active" : "");
    btn.dataset.lawyer = aba.chave;
    if (aba.tipo === "interesse")
      btn.title =
        "Comunicações que citam os termos de interesse do escritório no teor ou entre as partes";
    const rotulo = document.createElement("span");
    rotulo.textContent = aba.rotulo;
    const badge = document.createElement("span");
    badge.className = "tab-badge" + (aba.aRevisar > 0 ? " badge-has-pending" : "");
    badge.id = `badge-tab-${aba.chave}`;
    badge.textContent = `${aba.aRevisar} para atuar (${aba.total} total)`;
    btn.append(rotulo, badge);
    nav.append(btn);
  }

  // Aba Todos
  nav
    .querySelector("[data-lawyer='todos']")
    ?.classList.toggle("active", state.advogado === "todos");
  const badgeTodos = document.getElementById("badge-tab-todos");
  if (badgeTodos) {
    badgeTodos.textContent = String(porAba.todos?.total || 0);
  }
}

function renderizarTabela(publicacoes: PublicacaoItem[], total: number) {
  const tbody = document.getElementById("tbody-publicacoes");
  const emptyState = document.getElementById("empty-state");
  if (!tbody || !emptyState) return;

  if (total === 0) {
    tbody.innerHTML = "";
    emptyState.style.display = "block";
    return;
  }

  emptyState.style.display = "none";

  let html = "";
  for (const pub of publicacoes) {
    const isExpanded = state.expandedIds.has(pub.comunicacao_id);
    const isConcluida = pub.status_revisao === "Concluída";

    // Status classes
    let statusClass = "status-a-revisar";
    if (pub.status_revisao === "Pendente") statusClass = "status-pendente";
    else if (pub.status_revisao === "Em análise")
      statusClass = "status-andamento";
    else if (pub.status_revisao === "Concluída")
      statusClass = "status-concluido";

    // Advogados tags
    const advTags = (pub.advogados || [])
      .map((a) => {
        const label = a.advogado_nome + " — " + a.advogado_oab;
        const cls = `tag-adv-${corPorAdvogado.get(a.advogado_id) ?? 0}`;
        return `<span class="badge-adv ${cls}">${escapeHtml(label)}</span>`;
      })
      .join(" ");

    html += `
      <tr class="pub-row ${isConcluida ? "row-concluida" : ""} ${isExpanded ? "row-expanded-parent" : ""}" 
          data-id="${pub.comunicacao_id}" 
          onclick="window.handleRowClick(event, ${pub.comunicacao_id})">
        
        <!-- Coluna 1: Tribunal & Órgão -->
        <td class="col-tribunal">
          <div class="tribunal-cell">
            <span class="tribunal-sigla">${escapeHtml(pub.sigla_tribunal || "—")}</span>
            <span class="orgao-texto" title="${escapeHtml(pub.nome_orgao)}">${escapeHtml(pub.nome_orgao || "Não informado")}</span>
          </div>
        </td>

        <!-- Coluna 2: Classe & Tipo -->
        <td class="col-classe">
          <div class="classe-cell">
            <span class="classe-nome" title="${escapeHtml(pub.nome_classe)}">${escapeHtml(pub.nome_classe || "Não informada")}</span>
            <span class="comunicacao-tipo-tag">${escapeHtml(pub.tipo_comunicacao || "Não informado")}</span>
          </div>
        </td>

        <!-- Coluna 3: Nº do Processo (Fixa horizontalmente) -->
        <td class="col-processo">
          <div class="processo-cell">
            <span class="num-processo font-mono">${escapeHtml(pub.numero_processo_mascara || pub.numero_processo || "Sem número")}</span>
            <div class="advogados-row">${advTags}</div>
          </div>
        </td>

        <!-- Coluna 4: Data de Disponibilização -->
        <td class="col-data-disp font-mono text-center">
          <div class="data-disp-box">
            <span class="data-principal">${escapeHtml(formatarDataBR(pub.data_disponibilizacao))}</span>
            <span class="data-label-sub">DJE / DJEN</span>
          </div>
        </td>

        <!-- Coluna 5: Data de Publicação (CPC art. 224) -->
        <td class="col-data-pub font-mono text-center">
          <div class="data-pub-box">
            <span class="data-principal">${escapeHtml(formatarDataBR(pub.data_publicacao))}</span>
            <span class="data-label-sub">Informada pela fonte</span>
          </div>
        </td>

        <!-- Coluna 6: O que deve ser feito (Providência) -->
        <td class="col-providencia">
          <div class="providencia-cell">
            <span class="providencia-texto ${!pub.providencia || pub.providencia === "A definir" ? "providencia-indefinida" : ""}">
              ${escapeHtml(pub.providencia || "A definir")}
            </span>
            ${pub.observacoes ? `<span class="obs-icon" title="Observação: ${escapeHtml(pub.observacoes)}">📝</span>` : ""}
          </div>
        </td>

        <!-- Coluna 7: Status de Revisão (Select Editável com Soft UI) -->
        <td class="col-status" onclick="event.stopPropagation()">
          <div class="select-status-wrapper">
            <select class="select-status ${statusClass}" 
                    data-id="${pub.comunicacao_id}" 
                    onchange="window.handleStatusChange(${pub.comunicacao_id}, this.value)">
              <option value="A revisar" ${pub.status_revisao === "A revisar" ? "selected" : ""}>A revisar</option>
              
              <option value="Em análise" ${pub.status_revisao === "Em análise" ? "selected" : ""}>Em análise</option>
              <option value="Concluída" ${pub.status_revisao === "Concluída" ? "selected" : ""}>Concluída</option>
            </select>
          </div>
        </td>
      </tr>
    `;

    // Linha expandida com teor integral e ações operacionais
    if (isExpanded) {
      html += `
        <tr class="expanded-row" id="exp-${pub.comunicacao_id}">
          <td colspan="7">
            <div class="expanded-content">
              
              <!-- Barra de ações superiores da publicação -->
              <div class="expanded-toolbar">
                <div class="expanded-title-area">
                  <span class="expanded-badge-djen">Fonte: ${escapeHtml(pub.meio || "DJEN Oficial")}</span>
                  <span class="expanded-id-tag font-mono">ID Comunicação: #${pub.comunicacao_id}</span>
                  ${pub.hash ? `<span class="expanded-hash-tag font-mono">Hash: ${escapeHtml(pub.hash.slice(0, 16))}...</span>` : ""}
                </div>

                <div class="expanded-actions">
                  <button class="btn-action-icon" title="Copiar número do processo" onclick="window.copiarProcesso(${pub.comunicacao_id})">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                    </svg>
                    <span>Copiar Processo</span>
                  </button>

                  <button class="btn-action-icon" title="Copiar texto integral" onclick="window.copiarTextoIntegral(${pub.comunicacao_id})">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                    <span>Copiar Texto</span>
                  </button>

                  <button class="btn-action-icon" title="Editar anotação ou providência" onclick="window.abrirModalAnotacao(${pub.comunicacao_id})">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                    <span>Anotar Providência</span>
                  </button>

                  <button class="btn-action-icon btn-action-danger" title="Remover publicação do painel" onclick="window.confirmarRemocaoIndividual(${pub.comunicacao_id}, '')">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    <span>Arquivar</span>
                  </button>
                </div>
              </div>

              <div class="legal-notice-box">Datas e teor reproduzem a fonte. Prazos e providências precisam de conferência pelo advogado responsável.</div>
              ${pub.link_fonte && /^https?:\/\//.test(pub.link_fonte) ? `<a href="${escapeHtml(pub.link_fonte)}" target="_blank" rel="noopener noreferrer">Abrir fonte oficial</a>` : ""}
              ${pub.archived_at ? `<button class="btn-secondary" onclick="window.restaurarPublicacao(${pub.comunicacao_id})">Restaurar</button><button class="btn-danger" onclick="window.excluirPublicacao(${pub.comunicacao_id})">Apagar conteúdo definitivamente</button>` : ""}
              <!-- Caixa com Texto Integral -->
              <div class="full-text-container">
                <div class="full-text-header">
                  <span>Teor Integral da Comunicação Judicial</span>
                  <span class="font-mono text-muted text-xs">Importado em: ${escapeHtml(pub.importado_em ? pub.importado_em.slice(0, 16).replace("T", " ") : "—")}</span>
                </div>
                <pre class="full-text-pre" id="texto-pub-${pub.comunicacao_id}">${escapeHtml(pub.texto || "Conteúdo não disponibilizado pela fonte oficial.")}</pre>
              </div>

            </div>
          </td>
        </tr>
      `;
    }
  }

  tbody.innerHTML = html;
}

function renderizarPaginacao(total: number) {
  const paginacaoContainer = document.getElementById("table-pagination");
  if (!paginacaoContainer) return;

  const totalPaginas = Math.ceil(total / state.itensPorPagina) || 1;
  const inicio = (state.pagina - 1) * state.itensPorPagina + 1;
  const fim = Math.min(state.pagina * state.itensPorPagina, total);

  paginacaoContainer.innerHTML = `
    <div class="pagination-info">
      Mostrando <strong>${total > 0 ? inicio : 0}</strong> a <strong>${fim}</strong> de <strong>${total}</strong> registros
    </div>
    <div class="pagination-controls">
      <button class="btn-page" ${state.pagina <= 1 ? "disabled" : ""} onclick="window.mudarPagina(${state.pagina - 1})">
        &larr; Anterior
      </button>
      <span class="page-indicator">Página ${state.pagina} de ${totalPaginas}</span>
      <button class="btn-page" ${state.pagina >= totalPaginas ? "disabled" : ""} onclick="window.mudarPagina(${state.pagina + 1})">
        Próxima &rarr;
      </button>
    </div>
  `;
}

function renderizarErro(msg: string) {
  const tbody = document.getElementById("tbody-publicacoes");
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center p-6 text-red-600">
          <div class="error-box">
            <strong>Falha ao carregar publicações:</strong>
            <p>${escapeHtml(msg)}</p>
            <button class="btn-primary mt-2" onclick="window.carregarDados()">Tentar novamente</button>
          </div>
        </td>
      </tr>
    `;
  }
}

function atualizarBannerModo() {
  const banner = document.getElementById("banner-modo");
  if (banner) {
    banner.className = "banner-modo banner-real";
    const health = dadosAtuais?.statusColeta === "failed"
      ? `Última janela falhou: ${dadosAtuais.erroColeta || "consulte o diagnóstico"}`
      : dadosAtuais?.statusColeta === "running" ? "Janela em execução"
      : dadosAtuais?.statusColeta === "success" ? "Última janela concluída" : "Nenhuma coleta registrada";
    banner.textContent = `Coleta DJEN • ${health} • ${dadosAtuais?.janelasPendentes || 0} OAB(s) com janelas pendentes`;
  }
}

// =========================================================================
// MÉTODOS GLOBAIS DE INTERAÇÃO
// =========================================================================
declare global {
  interface Window {
    copiarProcesso: (id: number) => void;
    restaurarPublicacao: (id: number) => void;
    excluirPublicacao: (id: number) => void;
    handleRowClick: (event: MouseEvent, id: number) => void;
    handleStatusChange: (id: number, status: string) => void;
    copiarTexto: (texto: string, msg: string) => void;
    copiarTextoIntegral: (id: number) => void;
    confirmarRemocaoIndividual: (id: number, processo: string) => void;
    abrirModalAnotacao: (id: number) => void;
    abrirModalDiagnostico: () => void;
    fecharModalDiagnostico: () => void;
    mudarPagina: (novaPagina: number) => void;
    carregarDados: () => void;
  }
}

window.handleRowClick = function (event: MouseEvent, id: number) {
  if ((event.target as HTMLElement).closest("button, select, input, a")) {
    return;
  }
  if (state.expandedIds.has(id)) {
    state.expandedIds.delete(id);
  } else {
    state.expandedIds.add(id);
  }
  if (dadosAtuais) {
    renderizarTabela(dadosAtuais.publicacoes, dadosAtuais.total);
  }
};

window.handleStatusChange = async function (id: number, novoStatus: string) {
  try {
    await atualizarStatusPublicacao(id, novoStatus);
    mostrarToast(`Status alterado para "${novoStatus}".`, "sucesso");
    // Atualizar no objeto local
    if (dadosAtuais) {
      const item = dadosAtuais.publicacoes.find((p) => p.comunicacao_id === id);
      if (item) {
        item.status_revisao = novoStatus as any;
      }
    }
    carregarDados();
  } catch (err: any) {
    mostrarToast(err.message || "Erro ao alterar status.", "erro");
    carregarDados();
  }
};

window.copiarTexto = function (texto: string, msg: string) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(texto)
      .then(() => {
        mostrarToast(msg, "sucesso");
      })
      .catch(() => {
        fallbackCopiar(texto, msg);
      });
  } else {
    fallbackCopiar(texto, msg);
  }
};

function fallbackCopiar(texto: string, msg: string) {
  const ta = document.createElement("textarea");
  ta.value = texto;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    mostrarToast(msg, "sucesso");
  } catch {
    mostrarToast("Não foi possível copiar automaticamente.", "erro");
  }
  document.body.removeChild(ta);
}

window.copiarTextoIntegral = function (id: number) {
  const el = document.getElementById(`texto-pub-${id}`);
  if (el) {
    window.copiarTexto(
      el.textContent || "",
      "Texto integral copiado para a área de transferência!",
    );
  }
};

window.confirmarRemocaoIndividual = async function (
  id: number,
  processo: string,
) {
  const confirmou = window.confirm(
    `Arquivar 1 publicação?\n\n` +
      `Ela sairá da lista ativa. O histórico será preservado e você poderá restaurá-la no filtro Arquivadas.`,
  );
  if (!confirmou) return;

  try {
    const res = await removerPublicacao(
      id,
      "Remoção individual solicitada pelo usuário",
    );
    mostrarToast(res.mensagem || "Publicação removida com sucesso.", "sucesso");
    state.expandedIds.delete(id);
    carregarDados();
  } catch (err: any) {
    mostrarToast(err.message || "Erro ao remover publicação.", "erro");
  }
};

window.abrirModalAnotacao = function (id: number) {
  const item = dadosAtuais?.publicacoes.find((p) => p.comunicacao_id === id);
  if (!item) return;

  const modal = document.getElementById("modal-anotacao");
  const inputProv = document.getElementById(
    "input-anotacao-providencia",
  ) as HTMLInputElement | null;
  const inputObs = document.getElementById(
    "input-anotacao-obs",
  ) as HTMLTextAreaElement | null;
  const pubIdHidden = document.getElementById(
    "input-anotacao-pub-id",
  ) as HTMLInputElement | null;

  if (modal && inputProv && inputObs && pubIdHidden) {
    pubIdHidden.value = String(id);
    inputProv.value = item.providencia || "";
    inputObs.value = item.observacoes || "";
    modal.classList.add("modal-visible");
  }
};

window.mudarPagina = function (novaPagina: number) {
  if (novaPagina < 1) return;
  state.pagina = novaPagina;
  carregarDados();
};

// =========================================================================
// EVENT LISTENERS DE FILTROS E MODAIS
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  // Tela de acesso: exige sessão ativa antes de carregar qualquer dado
  const login = document.getElementById("modal-login")!;
  const message = document.getElementById("login-message")!;
  // Mostrar/ocultar senha (útil no celular, onde é fácil errar a digitação)
  const toggleSenha = document.getElementById("login-toggle-senha");
  const campoSenha = document.getElementById("login-password") as HTMLInputElement | null;
  toggleSenha?.addEventListener("click", () => {
    if (!campoSenha) return;
    const mostrar = campoSenha.type === "password";
    campoSenha.type = mostrar ? "text" : "password";
    toggleSenha.setAttribute("aria-pressed", String(mostrar));
    toggleSenha.setAttribute("aria-label", mostrar ? "Ocultar senha" : "Mostrar senha");
    campoSenha.focus();
  });
  document
    .getElementById("login-form")!
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await entrar(
          (document.getElementById("login-email") as HTMLInputElement).value,
          (document.getElementById("login-password") as HTMLInputElement).value,
        );
        location.reload();
      } catch (err: any) {
        message.textContent = err.message;
      }
    });
  document
    .getElementById("btn-sair")!
    .addEventListener("click", () => void sair());
  let authenticated = false;
  try {
    authenticated = await haSessaoAtiva();
  } catch (err: any) {
    message.textContent = err.message;
  }
  if (!authenticated) {
    login.classList.add("modal-visible");
    return;
  }
  login.classList.remove("modal-visible");
  document
    .getElementById("filter-tribunal")!
    .addEventListener("change", (e) => {
      state.tribunal = (e.target as HTMLSelectElement).value;
      state.pagina = 1;
      void carregarDados();
    });
  document.getElementById("filter-archive")!.addEventListener("change", (e) => {
    state.archived = (e.target as HTMLSelectElement).value === "archived";
    state.pagina = 1;
    void carregarDados();
  });

  // 1. Abas de Advogados (delegação: as abas são recriadas a cada carga)
  document.getElementById("lawyer-tabs")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".lawyer-tab");
    if (!btn) return;
    document
      .querySelectorAll(".lawyer-tab")
      .forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    state.advogado = btn.dataset.lawyer || "todos";
    state.pagina = 1;
    carregarDados();
  });

  // 2. Campo de Busca com Debounce
  const searchInput = document.getElementById(
    "search-input",
  ) as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(buscaDebounceTimer);
      buscaDebounceTimer = setTimeout(() => {
        state.busca = (e.target as HTMLInputElement).value;
        state.pagina = 1;
        carregarDados();
      }, 350);
    });
  }

  // 3. Filtro por Status
  const filterStatus = document.getElementById(
    "filter-status",
  ) as HTMLSelectElement | null;
  if (filterStatus) {
    filterStatus.addEventListener("change", (e) => {
      state.status = (e.target as HTMLSelectElement).value;
      state.pagina = 1;
      carregarDados();
    });
  }

  // 4. Filtro por Período
  const filterPeriodo = document.getElementById(
    "filter-periodo",
  ) as HTMLSelectElement | null;
  if (filterPeriodo) {
    filterPeriodo.addEventListener("change", (e) => {
      state.periodoDias = (e.target as HTMLSelectElement).value;
      state.pagina = 1;
      carregarDados();
    });
  }

  // 5. Botão "Buscar Agora" (Disparo Manual de Coleta)
  const btnBuscarAgora = document.getElementById("btn-buscar-agora");
  if (btnBuscarAgora) {
    btnBuscarAgora.addEventListener("click", async () => {
      if (state.sincronizando) return;
      state.sincronizando = true;
      atualizarIndicadoresCarregamento();
      mostrarToast("Iniciando sincronização com a API do DJEN...", "info");

      try {
        const res = await dispararSincronizacaoManual();
        mostrarToast(res.mensagem || "Coleta oficial concluída!", "sucesso");
        carregarDados();
      } catch (err: any) {
        mostrarToast(err.message || "Falha ao sincronizar com o DJEN.", "erro");
      } finally {
        state.sincronizando = false;
        atualizarIndicadoresCarregamento();
      }
    });
  }

  // 6. Ordenação por Colunas
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const campo = th.getAttribute("data-sort");
      if (campo === "dataDisponibilizacao") {
        state.ordem = state.ordem === "desc" ? "asc" : "desc";
        th.classList.toggle("sorted-asc", state.ordem === "asc");
        th.classList.toggle("sorted-desc", state.ordem === "desc");
        carregarDados();
      }
    });
  });

  // 7. Modal de Remoção em Lote
  configurarModalRemocaoLote();

  // 8. Modal de Anotação
  configurarModalAnotacao();

  // 9. Modal de Diagnóstico Administrativo
  configurarModalDiagnostico();

  // Inicialização
  carregarDados();
});

// =========================================================================
// MODAL DE REMOÇÃO EM LOTE
// =========================================================================
function configurarModalRemocaoLote() {
  const btnAbrir = document.getElementById("btn-abrir-remocao-lote");
  const modal = document.getElementById("modal-remocao-lote");
  const btnFechar = document.getElementById("btn-fechar-modal-lote");
  const btnCancelar = document.getElementById("btn-cancelar-lote");
  const btnCalcular = document.getElementById("btn-calcular-preview-lote");
  const btnConfirmar = document.getElementById(
    "btn-confirmar-remocao-lote",
  ) as HTMLButtonElement | null;
  const inputDataCorte = document.getElementById(
    "input-data-corte-lote",
  ) as HTMLInputElement | null;
  const previewBox = document.getElementById("box-preview-lote");

  if (btnAbrir && modal) {
    btnAbrir.addEventListener("click", () => {
      invalidarPreview();
      // Data padrão: 30 dias atrás
      if (inputDataCorte) {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        inputDataCorte.value = d.toISOString().slice(0, 10);
      }
      if (previewBox) previewBox.innerHTML = "";
      if (btnConfirmar) btnConfirmar.disabled = true;
      modal.classList.add("modal-visible");
    });
  }

  const fechar = () => modal?.classList.remove("modal-visible");
  btnFechar?.addEventListener("click", fechar);
  btnCancelar?.addEventListener("click", fechar);

  inputDataCorte?.addEventListener("input", () => {
    invalidarPreview();
    if (btnConfirmar) btnConfirmar.disabled = true;
    if (previewBox)
      previewBox.textContent = "Recalcule a prévia após alterar a data.";
  });
  btnCalcular?.addEventListener("click", async () => {
    const dataCorte = inputDataCorte?.value;
    if (!dataCorte) {
      mostrarToast("Selecione uma data de corte válida.", "erro");
      return;
    }

    try {
      if (previewBox) {
        previewBox.innerHTML =
          '<span class="loading-text">Calculando registros no banco de dados...</span>';
      }
      const preview = await obterPreviewRemocaoLote(dataCorte);

      if (previewBox) {
        if (preview.totalAfetados === 0) {
          previewBox.innerHTML = `
            <div class="preview-empty">
              <span>Nenhuma publicação localizada com data de disponibilização até <strong>${formatarDataBR(dataCorte)}</strong>.</span>
            </div>
          `;
          if (btnConfirmar) btnConfirmar.disabled = true;
        } else {
          const amostra = preview.processosAmostra
            .map((p) => `<code>${escapeHtml(p)}</code>`)
            .join(", ");
          previewBox.innerHTML = `
            <div class="preview-success">
              <strong>${preview.totalAfetados} publicação(ões) afetada(s)</strong>
              <p>Tribunais: ${escapeHtml(preview.tribunais.join(", ") || "Diversos")}</p>
              <p class="text-xs text-muted">Amostra: ${amostra}</p>
              <div class="preview-alert">
                Todas as publicações ativas desta conta até a data serão arquivadas, independentemente dos filtros. Você poderá restaurá-las. O lote confirmado corresponde exatamente a esta prévia.
              </div>
            </div>
          `;
          if (btnConfirmar) btnConfirmar.disabled = false;
        }
      }
    } catch (err: any) {
      mostrarToast(err.message || "Erro ao calcular prévia.", "erro");
    }
  });

  btnConfirmar?.addEventListener("click", async () => {
    const dataCorte = inputDataCorte?.value;
    if (!dataCorte) return;

    btnConfirmar.disabled = true;
    try {
      const res = await executarRemocaoLote(
        dataCorte,
        `Remoção em lote por data de corte (${dataCorte})`,
      );
      mostrarToast(res.mensagem, "sucesso");
      fechar();
      carregarDados();
    } catch (err: any) {
      mostrarToast(err.message || "Erro ao executar remoção em lote.", "erro");
      btnConfirmar.disabled = false;
    }
  });
}

// =========================================================================
// MODAL DE ANOTAÇÕES INTERNAS
// =========================================================================
function configurarModalAnotacao() {
  const modal = document.getElementById("modal-anotacao");
  const btnFechar = document.getElementById("btn-fechar-modal-anotacao");
  const btnCancelar = document.getElementById("btn-cancelar-anotacao");
  const btnSalvar = document.getElementById("btn-salvar-anotacao");

  const fechar = () => modal?.classList.remove("modal-visible");
  btnFechar?.addEventListener("click", fechar);
  btnCancelar?.addEventListener("click", fechar);

  btnSalvar?.addEventListener("click", async () => {
    const pubId = parseInt(
      (document.getElementById("input-anotacao-pub-id") as HTMLInputElement)
        .value,
      10,
    );
    const providencia = (
      document.getElementById("input-anotacao-providencia") as HTMLInputElement
    ).value;
    const observacoes = (
      document.getElementById("input-anotacao-obs") as HTMLTextAreaElement
    ).value;

    const item = dadosAtuais?.publicacoes.find(
      (p) => p.comunicacao_id === pubId,
    );
    const statusAtual = item?.status_revisao || "A revisar";

    try {
      await atualizarStatusPublicacao(
        pubId,
        statusAtual,
        providencia,
        observacoes,
      );
      mostrarToast("Anotação e providência salvas com sucesso!", "sucesso");
      fechar();
      carregarDados();
    } catch (err: any) {
      mostrarToast(err.message || "Erro ao salvar anotação.", "erro");
    }
  });
}

// =========================================================================
// MODAL DE DIAGNÓSTICO ADMINISTRATIVO DO SISTEMA E CONEXÃO CNJ
// =========================================================================
function configurarModalDiagnostico() {
  const modal = document.getElementById("modal-diagnostico")!;
  const close = () => modal.classList.remove("modal-visible");
  window.fecharModalDiagnostico = close;
  window.abrirModalDiagnostico = async () => {
    modal.classList.add("modal-visible");
    const body = modal.querySelector(".modal-body")!;
    body.textContent = "Consultando registros reais…";
    try {
      const d = await obterDiagnosticoSistema();
      body.innerHTML = `<p>Última tentativa: ${escapeHtml(d.latest?.started_at || "Nenhuma")}</p><p>Última janela concluída: ${escapeHtml(d.last_success || "Nenhuma")}</p><p>Próxima execução/continuação: ${escapeHtml(d.next_due || "Conta ainda não ativada")}</p><p>OABs com janelas pendentes: ${Number(d.pending_windows)}</p><p>Última sonda da Edge: HTTP ${Number(d.source_check?.http_status || 0)} • ${escapeHtml(d.source_check?.checked_at || "Não executada")} • filtro validado: ${d.source_check?.filter_verified ? "sim" : "não"}</p><h4>Últimas janelas (uma janela não representa todo o histórico)</h4>${d.runs.map((r: any) => `<p>${escapeHtml(r.start_day)} • ${escapeHtml(r.status)} • recebidos: ${Number(r.fetched_count)} • novos: ${Number(r.inserted_count)} • HTTP ${Number(r.http_status || 0)} ${escapeHtml(r.error_message || "")}</p>`).join("")}`;
    } catch (err: any) {
      body.textContent = err.message;
    }
  };
  document
    .getElementById("btn-atualizar-diagnostico")
    ?.addEventListener("click", () => void window.abrirModalDiagnostico());
  document
    .getElementById("btn-abrir-diagnostico")
    ?.addEventListener("click", () => void window.abrirModalDiagnostico());
  for (const id of [
    "btn-fechar-modal-diagnostico",
    "btn-fechar-modal-diagnostico-footer",
  ])
    document.getElementById(id)?.addEventListener("click", close);
}
window.copiarProcesso = (id) => {
  const p = dadosAtuais?.publicacoes.find((p) => p.comunicacao_id === id);
  if (p)
    window.copiarTexto(
      p.numero_processo_mascara || p.numero_processo,
      "Número copiado.",
    );
};
window.restaurarPublicacao = async (id) => {
  try {
    await restaurarPublicacao(id);
    await carregarDados();
  } catch (e: any) {
    mostrarToast(e.message, "erro");
  }
};
window.excluirPublicacao = async (id) => {
  if (
    !confirm(
      "Apagar definitivamente o teor e os dados pessoais de 1 publicação arquivada? Esta operação não pode ser desfeita. O identificador mínimo será retido para impedir reimportação.",
    )
  )
    return;
  try {
    const n = await excluirPublicacao(id);
    if (n !== 1) throw new Error("Registro indisponível.");
    await carregarDados();
  } catch (e: any) {
    mostrarToast(e.message, "erro");
  }
};
