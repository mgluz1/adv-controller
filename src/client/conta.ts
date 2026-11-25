// Telas de conta (sem sessão ou antes de ter escritório): recuperar/redefinir senha, convite por link e criação do escritório.
// O conteúdo é montado dentro de #conta-painel; todo valor dinâmico passa por escapeHtml.
import {
  aceitarConvite,
  cadastrarPeloConvite,
  criarEscritorio,
  entrar,
  infoConvite,
  obterSessao,
  redefinirSenha,
  sair,
  solicitarRedefinicao,
  type Sessao,
} from "./api.ts";
import { escapeHtml, gerarSlug, idDoConvite, papelRotulo, validarNovaSenha } from "./util.ts";

const painel = () => document.getElementById("conta-painel")!;
const modal = () => document.getElementById("modal-conta")!;

function mostrar(html: string) {
  document.getElementById("modal-login")?.classList.remove("modal-visible");
  painel().innerHTML = html;
  modal().classList.add("modal-visible");
}
export function fecharConta() {
  modal().classList.remove("modal-visible");
}

const campo = (id: string, rotulo: string, tipo: string, extra = "") =>
  `<div class="login-field"><label for="${id}">${rotulo}</label><input id="${id}" type="${tipo}" ${extra} /></div>`;
const cabecalho = (eyebrow: string, titulo: string, sub = "") =>
  `<span class="login-eyebrow">${escapeHtml(eyebrow)}</span><h2 id="conta-titulo" class="login-title">${escapeHtml(titulo)}</h2>${sub ? `<p class="login-subtitle">${sub}</p>` : ""}`;
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
const msg = (texto: string, ok = false) => {
  const el = document.getElementById("conta-msg");
  if (!el) return;
  el.textContent = texto;
  el.className = ok ? "login-ok" : "";
  el.setAttribute("role", ok ? "status" : "alert");
};
/** Impede duplo envio e mostra o erro (já em pt-BR) no lugar certo. */
function aoEnviar(id: string, acao: (botao: HTMLButtonElement) => Promise<void>) {
  const form = document.getElementById(id) as HTMLFormElement;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const botao = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    botao.disabled = true;
    msg("");
    try {
      await acao(botao);
    } catch (e) {
      msg((e as Error).message);
    } finally {
      botao.disabled = false;
    }
  });
}
const irParaInicio = () => location.assign("/");

// ── Recuperar senha ───────────────────────────────────────────────────────────
export function telaRecuperar(voltar: () => void) {
  mostrar(`${cabecalho("Recuperar acesso", "Esqueci minha senha", "Informe o e-mail da conta. Se ele estiver cadastrado, enviaremos um link para criar uma nova senha.")}
    <form id="conta-form" novalidate>
      ${campo("conta-email", "E-mail", "email", 'autocomplete="username" autocapitalize="none" spellcheck="false" required')}
      <p id="conta-msg" role="alert"></p>
      <button class="btn-primary login-submit" type="submit">Enviar link</button>
    </form>
    <button type="button" class="login-link" id="conta-voltar">Voltar para entrar</button>`);
  document.getElementById("conta-voltar")!.addEventListener("click", voltar);
  aoEnviar("conta-form", async () => {
    const email = val("conta-email").trim();
    if (!email.includes("@")) throw new Error("Informe um e-mail válido.");
    await solicitarRedefinicao(email);
    // Resposta SEMPRE a mesma: a tela não revela se o e-mail tem conta.
    msg("Se existir uma conta com este e-mail, enviamos um link para criar uma nova senha. Confira também a caixa de spam. O link vale por 1 hora.", true);
  });
}

// ── Redefinir senha (link do e-mail → /redefinir-senha?token=…) ───────────────
export function telaRedefinir(busca = location.search) {
  const q = new URLSearchParams(busca);
  const token = q.get("token");
  if (!token || q.get("error")) {
    mostrar(`${cabecalho("Recuperar acesso", "Link inválido ou expirado", "Este link de redefinição não vale mais. Peça um novo.")}
      <div class="conta-acoes"><button type="button" class="btn-primary" id="conta-novo">Pedir novo link</button><button type="button" class="btn-secondary" id="conta-inicio">Ir para entrar</button></div>`);
    document.getElementById("conta-novo")!.addEventListener("click", () => telaRecuperar(irParaInicio));
    document.getElementById("conta-inicio")!.addEventListener("click", irParaInicio);
    return;
  }
  mostrar(`${cabecalho("Recuperar acesso", "Crie uma nova senha", "Use ao menos 10 caracteres. Ao trocar a senha, as sessões abertas em outros aparelhos são encerradas.")}
    <form id="conta-form" novalidate>
      ${campo("conta-senha", "Nova senha", "password", 'autocomplete="new-password" required')}
      ${campo("conta-senha2", "Repita a nova senha", "password", 'autocomplete="new-password" required')}
      <p id="conta-msg" role="alert"></p>
      <button class="btn-primary login-submit" type="submit">Salvar nova senha</button>
    </form>`);
  aoEnviar("conta-form", async () => {
    const erro = validarNovaSenha(val("conta-senha"), val("conta-senha2"));
    if (erro) throw new Error(erro);
    await redefinirSenha(val("conta-senha"), token);
    history.replaceState(null, "", "/redefinir-senha"); // tira o token (já usado) da barra de endereço
    mostrar(`${cabecalho("Recuperar acesso", "Senha alterada")}
      <p class="login-ok" role="status">Pronto. Entre com a nova senha.</p>
      <div class="conta-acoes"><button type="button" class="btn-primary" id="conta-inicio">Ir para entrar</button></div>`);
    document.getElementById("conta-inicio")!.addEventListener("click", irParaInicio);
  });
}

// ── Convite por link (/convite/<id>) ──────────────────────────────────────────
export async function telaConvite(id: string) {
  let info;
  try {
    info = await infoConvite(id);
  } catch (e) {
    mostrar(`${cabecalho("Convite", "Convite indisponível", escapeHtml((e as Error).message))}
      <p class="login-subtitle">Peça um novo convite a quem administra o escritório.</p>
      <div class="conta-acoes"><button type="button" class="btn-secondary" id="conta-inicio">Ir para entrar</button></div>`);
    document.getElementById("conta-inicio")!.addEventListener("click", irParaInicio);
    return;
  }
  const resumo = `<strong>${escapeHtml(info.inviter)}</strong> convidou você para o escritório <strong>${escapeHtml(info.organization)}</strong> como <strong>${escapeHtml(papelRotulo(info.role))}</strong>.`;
  const sessao: Sessao | null = await obterSessao(true).catch(() => null);
  const logado = sessao?.usuario ?? null;

  // 1) Logado com o e-mail convidado: só aceitar.
  if (logado && logado.email.toLowerCase() === info.email.toLowerCase()) {
    mostrar(`${cabecalho("Convite", "Aceitar convite", resumo)}
      <form id="conta-form"><p id="conta-msg" role="alert"></p><button class="btn-primary login-submit" type="submit">Aceitar convite</button></form>`);
    aoEnviar("conta-form", async () => {
      await aceitarConvite(id);
      irParaInicio();
    });
    return;
  }
  // 2) Logado com OUTRO e-mail: o convite é pessoal.
  if (logado) {
    mostrar(`${cabecalho("Convite", "Convite para outro e-mail", resumo)}
      <p class="login-subtitle">Este convite é para <strong>${escapeHtml(info.email)}</strong>, mas você está conectado como <strong>${escapeHtml(logado.email)}</strong>. Saia e entre com a conta convidada.</p>
      <div class="conta-acoes"><button type="button" class="btn-primary" id="conta-sair">Sair</button></div>`);
    document.getElementById("conta-sair")!.addEventListener("click", () => void sair());
    return;
  }
  // 3) Sem sessão, já tem conta: entrar (e-mail fixo, vem do convite).
  if (info.account_exists) {
    mostrar(`${cabecalho("Convite", "Entre para aceitar", resumo)}
      <form id="conta-form" novalidate>
        ${campo("conta-email", "E-mail do convite", "email", `value="${escapeHtml(info.email)}" readonly`)}
        ${campo("conta-senha", "Senha", "password", 'autocomplete="current-password" required')}
        <p id="conta-msg" role="alert"></p>
        <button class="btn-primary login-submit" type="submit">Entrar</button>
      </form>`);
    aoEnviar("conta-form", async () => {
      await entrar(info.email, val("conta-senha"));
      location.reload(); // volta a esta mesma página, agora logado: cai no caso 1
    });
    return;
  }
  // 4) Sem sessão, sem conta: criar a conta pelo link (o link é a prova de posse do e-mail).
  mostrar(`${cabecalho("Convite", "Crie sua conta", resumo)}
    <form id="conta-form" novalidate>
      ${campo("conta-email", "E-mail do convite", "email", `value="${escapeHtml(info.email)}" readonly`)}
      ${campo("conta-nome", "Seu nome", "text", 'autocomplete="name" required maxlength="120"')}
      ${campo("conta-senha", "Senha", "password", 'autocomplete="new-password" required')}
      ${campo("conta-senha2", "Repita a senha", "password", 'autocomplete="new-password" required')}
      <p id="conta-msg" role="alert"></p>
      <button class="btn-primary login-submit" type="submit">Criar conta e aceitar</button>
    </form>`);
  aoEnviar("conta-form", async () => {
    if (val("conta-nome").trim().length < 2) throw new Error("Informe seu nome.");
    const erro = validarNovaSenha(val("conta-senha"), val("conta-senha2"));
    if (erro) throw new Error(erro);
    await cadastrarPeloConvite(id, val("conta-nome").trim(), val("conta-senha"));
    try {
      await aceitarConvite(id);
    } catch (e) {
      // A conta existe e está logada; se o aceite falhar, a pessoa repete pelo mesmo link.
      msg(`Conta criada, mas não foi possível aceitar agora: ${(e as Error).message} Recarregue esta página para tentar de novo.`);
      return;
    }
    irParaInicio();
  });
}

// ── Primeiro acesso sem escritório ────────────────────────────────────────────
export function telaCriarEscritorio(sessao: Sessao) {
  mostrar(`${cabecalho("Primeiros passos", "Crie o seu escritório", "Cada escritório tem as suas OABs, equipe e publicações, isoladas das de qualquer outro. Se você foi convidado para um escritório, abra o link do convite que chegou ao seu e-mail em vez de criar um novo.")}
    <form id="conta-form" novalidate>
      ${campo("conta-nome", "Nome do escritório", "text", 'autocomplete="organization" required maxlength="120" placeholder="Ex.: Silva & Associados Advocacia"')}
      <p id="conta-msg" role="alert"></p>
      <button class="btn-primary login-submit" type="submit">Criar escritório</button>
    </form>
    <p class="login-note">Conectado como ${escapeHtml(sessao.usuario?.email ?? "")}.</p>
    <button type="button" class="login-link" id="conta-sair">Sair</button>`);
  document.getElementById("conta-sair")!.addEventListener("click", () => void sair());
  aoEnviar("conta-form", async () => {
    const nome = val("conta-nome").replace(/\s+/g, " ").trim();
    if (nome.length < 2 || nome.length > 120) throw new Error("Informe o nome do escritório (de 2 a 120 caracteres).");
    // O identificador precisa ser único: tenta de novo com outro sufixo se já existir.
    let ultimo: Error | null = null;
    for (let i = 0; i < 4; i++) {
      try {
        await criarEscritorio(nome, gerarSlug(nome));
        irParaInicio();
        return;
      } catch (e) {
        ultimo = e as Error;
        if (!/identificador/i.test(ultimo.message)) break;
      }
    }
    throw ultimo ?? new Error("Não foi possível criar o escritório.");
  });
}

/** Rotas públicas do app (links de e-mail). Devolve true se tratou a URL atual. */
export async function rotaPublica(): Promise<boolean> {
  const p = location.pathname.replace(/\/+$/, "") || "/";
  const id = idDoConvite(p);
  if (id) {
    await telaConvite(id);
    return true;
  }
  if (p === "/redefinir-senha") {
    telaRedefinir();
    return true;
  }
  return false;
}
