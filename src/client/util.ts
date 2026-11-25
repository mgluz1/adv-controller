// Utilitários puros da interface (sem DOM): testados em tests/client-util.test.ts.

export function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export const PAPEIS = ["owner", "admin", "member", "viewer"] as const;
export type Papel = (typeof PAPEIS)[number];

const ROTULO: Record<string, string> = { owner: "Proprietário", admin: "Administrador", member: "Membro", viewer: "Leitor" };
const DESCRICAO: Record<string, string> = {
  owner: "Tudo, inclusive excluir o escritório",
  admin: "Gerencia equipe, OABs, termos e coleta",
  member: "Revisa, arquiva e restaura publicações",
  viewer: "Somente leitura",
};
/** Papéis do Better Auth podem vir compostos ("admin,member"). Papel desconhecido vira o próprio texto, sem inventar permissão. */
export const papelRotulo = (p: string | null | undefined) =>
  (p ?? "").split(",").map((x) => ROTULO[x.trim()] ?? x.trim()).filter(Boolean).join(" + ") || "—";
export const papelDescricao = (p: string) => DESCRICAO[p] ?? "";

/** Papéis que um usuário pode ATRIBUIR ao convidar/alterar (o servidor impõe a regra; aqui só se evita oferecer o que será recusado). */
export function papeisAtribuiveis(meuPapel: string | null | undefined): Papel[] {
  const mine = (meuPapel ?? "").split(",").map((x) => x.trim());
  if (mine.includes("owner")) return ["owner", "admin", "member", "viewer"];
  if (mine.includes("admin")) return ["admin", "member", "viewer"];
  return [];
}

/** Mensagens do Better Auth (inglês) → pt-BR. Códigos desconhecidos caem num texto por status, nunca em inglês cru. */
const CODIGOS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "E-mail ou senha incorretos.",
  INVALID_PASSWORD: "Senha incorreta.",
  EMAIL_NOT_VERIFIED: "Confirme seu e-mail pelo link que enviamos antes de entrar. Se não chegou, tente entrar de novo para receber outro.",
  INVALID_TOKEN: "Este link é inválido ou expirou. Peça um novo.",
  TOKEN_EXPIRED: "Este link expirou. Peça um novo.",
  PASSWORD_TOO_SHORT: "A senha precisa ter ao menos 10 caracteres.",
  PASSWORD_TOO_LONG: "A senha é longa demais (máximo de 128 caracteres).",
  USER_ALREADY_EXISTS: "Já existe uma conta com este e-mail.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Já existe uma conta com este e-mail.",
  INVALID_EMAIL: "E-mail inválido.",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "Esta pessoa já faz parte do escritório.",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "Esta pessoa já foi convidada. Cancele o convite anterior para enviar outro.",
  INVITATION_NOT_FOUND: "Convite inválido, expirado ou já usado.",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: "Este convite é para outro e-mail. Entre com a conta convidada.",
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION: "Confirme seu e-mail antes de aceitar o convite.",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: "Seu papel não permite convidar pessoas.",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: "Seu papel não permite convidar com este papel.",
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: "Seu papel não permite alterar este membro.",
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: "Seu papel não permite remover este membro.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: "Você é o único proprietário: promova outra pessoa antes de sair.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: "O escritório precisa ter ao menos um proprietário.",
  ORGANIZATION_SLUG_ALREADY_TAKEN: "Este identificador de escritório já existe.",
  MEMBER_NOT_FOUND: "Membro não encontrado.",
  ORGANIZATION_NOT_FOUND: "Escritório não encontrado.",
};
const POR_STATUS: Record<number, string> = {
  400: "Dados inválidos. Confira e tente de novo.",
  401: "Sessão expirada ou credenciais inválidas. Entre de novo.",
  403: "Você não tem permissão para esta ação.",
  404: "Não encontrado.",
  409: "Já existe um registro igual.",
  429: "Muitas tentativas. Aguarde um minuto e tente de novo.",
};
export function traduzirErro(status: number, corpo: unknown): string {
  const b = (corpo ?? {}) as { erro?: unknown; code?: unknown; message?: unknown };
  if (typeof b.erro === "string" && b.erro) return b.erro; // /api/v1 já responde em pt-BR
  if (typeof b.code === "string" && CODIGOS[b.code]) return CODIGOS[b.code];
  return POR_STATUS[status] ?? (status >= 500 ? "Erro no servidor. Tente de novo em instantes." : "Não foi possível concluir. Tente de novo.");
}

/** Identificador de escritório: minúsculas, sem acento, [a-z0-9-], com sufixo curto para evitar colisão. */
export function slugBase(nome: string): string {
  return (
    nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
    "escritorio"
  );
}
export function gerarSlug(nome: string, aleatorio: () => number = Math.random): string {
  const sufixo = Math.floor(aleatorio() * 36 ** 4).toString(36).padStart(4, "0");
  return `${slugBase(nome)}-${sufixo}`;
}

/** Link que o convidado abre (o dono pode copiá-lo e compartilhar quando não há e-mail). */
export const linkConvite = (origem: string, id: string) => `${origem.replace(/\/+$/, "")}/convite/${encodeURIComponent(id)}`;

/** Extrai o id do convite de /convite/<id> (ou null). */
export function idDoConvite(pathname: string): string | null {
  const m = /^\/convite\/([A-Za-z0-9_-]{8,64})\/?$/.exec(pathname);
  return m ? m[1] : null;
}

export const UFS = ["AC","AL","AM","AP","BA","CE","DF","ES","GO","MA","MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN","RO","RR","RS","SC","SE","SP","TO"];

/** Senha nova válida para o formulário (o servidor valida de novo). */
export function validarNovaSenha(senha: string, confirmacao: string): string | null {
  if (senha.length < 10) return "A senha precisa ter ao menos 10 caracteres.";
  if (senha.length > 128) return "A senha é longa demais (máximo de 128 caracteres).";
  if (senha !== confirmacao) return "As senhas não conferem.";
  return null;
}
