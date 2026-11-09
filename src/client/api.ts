import { chamar } from "./transport.ts";

// Camada de dados do painel. Toda comunicação com o backend passa por `chamar()` (transport.ts).
// As operações abaixo mantêm os nomes e formatos das RPCs do sistema de origem para preservar o
// mapeamento para o modelo da interface; ao implementar o backend (Neon + Drizzle + Better Auth),
// siga docs/MIGRACAO.md. Autenticação: substituir `haSessaoAtiva/entrar/sair` pelo cliente do Better Auth.
export interface PublicacaoItem {
  id: string;
  comunicacao_id: number;
  hash?: string;
  sigla_tribunal: string;
  nome_orgao: string;
  numero_processo: string;
  numero_processo_mascara: string;
  nome_classe: string;
  tipo_comunicacao: string;
  texto: string;
  meio: string;
  link_fonte?: string;
  data_disponibilizacao: string;
  data_publicacao?: string;
  status_revisao: string;
  observacoes?: string;
  providencia?: string;
  importado_em: string;
  atualizado_em: string;
  archived_at?: string;
  advogados: Array<{
    advogado_id: string;
    advogado_nome: string;
    advogado_oab: string;
  }>;
}
/** Aba de filtro: um advogado/OAB do escritório, ou a aba de termos de interesse. */
export interface AbaInfo {
  chave: string; // id do advogado, ou "interesse"
  rotulo: string;
  tipo: "advogado" | "interesse";
  total: number;
  aRevisar: number;
}
export interface ListarPublicacoesResponse {
  modo: "real";
  horarioLeituraBanco: string;
  horarioLeituraBancoFormatado: string;
  ultimaTentativaDjen?: string;
  ultimaTentativaDjenFormatada: string;
  ultimaColetaDjen?: string;
  ultimaColetaDjenFormatada: string;
  proximaColetaPrevista?: string;
  proximaColetaPrevistaFormatada: string;
  statusColeta: string;
  erroColeta?: string;
  duracaoUltimaColetaMs?: number;
  statusHttpUltimaColeta?: number;
  total: number;
  publicacoes: PublicacaoItem[];
  estatisticas: any;
  tribunais: string[];
  janelasPendentes: number;
  abas: AbaInfo[];
}
export type SistemaDiagnosticoResponse = any;
const fmt = (v?: string) =>
  v
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
      }).format(new Date(v))
    : "Não registrada";
const statusToDB: Record<string, string> = {
  "A revisar": "a_revisar",
  "Em análise": "em_analise",
  Concluída: "concluida",
};
const statusFromDB: Record<string, string> = {
  a_revisar: "A revisar",
  em_analise: "Em análise",
  concluida: "Concluída",
};
const rpc = (name: string, args: Record<string, unknown> = {}) =>
  chamar<any>(name, args);

// --- Autenticação (provisória; trocar pelo Better Auth) ---
export async function haSessaoAtiva(): Promise<boolean> {
  const r = await chamar<{ usuario: unknown | null }>("session");
  return !!r.usuario;
}
export async function entrar(email: string, password: string) {
  await chamar("sign-in", { email: email.trim().toLowerCase(), password });
}
export async function sair() {
  try {
    await chamar("sign-out");
  } finally {
    location.reload();
  }
}
export async function fetchPublicacoes(params: {
  advogadoId?: string;
  status?: string;
  busca?: string;
  dataInicio?: string;
  dataFim?: string;
  ordem?: string;
  limite?: number;
  offset?: number;
  tribunal?: string;
  archived?: boolean;
}): Promise<ListarPublicacoesResponse> {
  const data = await rpc("djen_list", {
    p_filter: {
      attorney: params.advogadoId,
      status: statusToDB[params.status || ""] || "todos",
      search: params.busca,
      start: params.dataInicio,
      end: params.dataFim,
      order: params.ordem,
      limit: params.limite,
      offset: params.offset,
      tribunal: params.tribunal,
      archived: params.archived,
    },
  });
  const r = data.latest;
  const now = new Date().toISOString();
  // Contagem de cada aba sob os mesmos filtros, calculada no servidor pela mesma regra que
  // seleciona as linhas; não depende da aba ativa nem da página carregada.
  const porAba: Record<string, { total: number; aRevisar: number }> = {};
  for (const [aba, s] of Object.entries<any>(data.tab_stats || {}))
    porAba[aba] = { total: s.total, aRevisar: s.revisar };
  // Abas dinâmicas: uma por advogado/OAB do escritório (na ordem recebida) + termos de interesse,
  // quando o servidor informar essa aba.
  const abas: AbaInfo[] = (data.attorney_stats as any[]).map((a) => ({
    chave: a.id,
    rotulo: `${a.name} — OAB/${a.uf} ${a.oab_number}`,
    tipo: "advogado" as const,
    total: porAba[a.id]?.total ?? a.total,
    aRevisar: porAba[a.id]?.aRevisar ?? a.revisar,
  }));
  if (porAba.interesse)
    abas.push({
      chave: "interesse",
      rotulo: "Termos de interesse",
      tipo: "interesse",
      total: porAba.interesse.total,
      aRevisar: porAba.interesse.aRevisar,
    });
  return {
    modo: "real",
    horarioLeituraBanco: now,
    horarioLeituraBancoFormatado: fmt(now),
    ultimaTentativaDjen: r?.started_at,
    ultimaTentativaDjenFormatada: fmt(r?.started_at),
    ultimaColetaDjen: data.last_success,
    ultimaColetaDjenFormatada: fmt(data.last_success),
    proximaColetaPrevista: data.next_due,
    proximaColetaPrevistaFormatada: fmt(data.next_due),
    statusColeta:
      r?.status === "erro"
        ? "failed"
        : r?.status === "executando"
          ? "running"
          : r?.status === "sucesso"
            ? "success"
            : "idle",
    erroColeta: r?.error_message,
    statusHttpUltimaColeta: r?.http_status,
    total: data.total,
    janelasPendentes: data.pending_windows,
    tribunais: data.tribunals.map((t: any) => t.tribunal),
    estatisticas: {
      total: data.stats.total,
      aRevisar: data.stats.revisar,
      pendentes: 0,
      emAndamento: data.stats.analise,
      concluidas: data.stats.concluida,
      porAba,
    },
    abas,
    publicacoes: data.rows.map((p: any) => ({
      id: p.id,
      comunicacao_id: Number(p.source_id),
      hash: p.source_hash,
      sigla_tribunal: p.tribunal,
      nome_orgao: p.judging_body,
      numero_processo: p.process_number,
      numero_processo_mascara: p.process_mask,
      nome_classe: p.class_name,
      tipo_comunicacao: p.communication_type,
      texto: p.original_text,
      meio: p.medium,
      link_fonte: p.source_url,
      data_disponibilizacao: p.available_on,
      data_publicacao: p.published_on,
      status_revisao: statusFromDB[p.status],
      observacoes: p.notes,
      providencia: p.action_note,
      importado_em: p.first_seen_at,
      atualizado_em: p.last_seen_at,
      archived_at: p.archived_at,
      advogados: p.attorneys.map((a: any) => ({
        advogado_id: a.id,
        advogado_nome: a.name,
        advogado_oab: `OAB/${a.uf} ${a.oab_number}`,
      })),
    })),
  };
}
export async function atualizarStatusPublicacao(
  id: number,
  status: string,
  providencia?: string,
  observacoes?: string,
) {
  const n = await rpc("djen_mutate", {
    p_action: "status",
    p_ids: [String(id)],
    p_status: statusToDB[status],
    p_notes: observacoes,
    p_providence: providencia,
  });
  if (n !== 1) throw new Error("Registro indisponível. Atualize a lista.");
  return { sucesso: true, mensagem: "Alteração salva." };
}
export async function removerPublicacao(id: number, _motivo?: string) {
  const n = await rpc("djen_mutate", {
    p_action: "archive",
    p_ids: [String(id)],
  });
  if (n !== 1) throw new Error("Registro indisponível.");
  return {
    sucesso: true,
    mensagem: "Publicação arquivada. Disponível no filtro Arquivadas.",
  };
}
export async function restaurarPublicacao(id: number) {
  return rpc("djen_mutate", { p_action: "restore", p_ids: [String(id)] });
}
export async function excluirPublicacao(id: number) {
  return rpc("djen_mutate", { p_action: "remove", p_ids: [String(id)] });
}
let preview: { date: string; ids: string[] } | null = null;
export function invalidarPreview() {
  preview = null;
}
export async function obterPreviewRemocaoLote(date: string) {
  // Operação `djen_archive_preview`: publicações ATIVAS (não arquivadas, não descartadas) com
  // disponibilização <= date, ordenadas por source_id, no máximo 1.000 linhas + contagem exata.
  const { count, rows } = (await rpc("djen_archive_preview", {
    p_date: date,
  })) as {
    count: number;
    rows: Array<{ source_id: string; process_number: string; tribunal: string }>;
  };
  if ((count || 0) > 1000)
    throw new Error(
      "Mais de 1.000 publicações: reduza a data de corte e processe em lotes menores.",
    );
  // A confirmação arquiva exatamente estes IDs: o lote confirmado é idêntico à prévia exibida.
  preview = { date, ids: rows.map((p) => p.source_id) };
  return {
    sucesso: true,
    totalAfetados: count || 0,
    processosAmostra: rows
      .slice(0, 5)
      .map((p) => p.process_number || "Não informado"),
    tribunais: [
      ...new Set<string>(rows.map((p) => p.tribunal).filter(Boolean)),
    ],
    mensagem:
      "Escopo: todas as publicações ativas desta conta disponibilizadas até a data, independentemente dos filtros da lista.",
  };
}
export async function executarRemocaoLote(date: string, _motivo?: string) {
  if (!preview || preview.date !== date)
    throw new Error("Calcule novamente a prévia.");
  const ids = preview.ids;
  preview = null;
  const n = await rpc("djen_mutate", { p_action: "archive", p_ids: ids });
  return {
    sucesso: true,
    totalRemovidos: n,
    mensagem: `${n} publicação(ões) arquivada(s), com histórico preservado.`,
  };
}
export async function dispararSincronizacaoManual() {
  // Operação `djen_sync_manual`: aplica o limite de uma solicitação a cada 5 min por escritório e
  // executa a coleta imediata. Resposta: { sucesso, mensagem?, erro? }.
  const data = await rpc("djen_sync_manual");
  if (!data?.sucesso)
    throw new Error(
      data?.erro ||
        "Coleta solicitada, mas a execução imediata falhou. Confira o diagnóstico.",
    );
  return data;
}
export async function obterDiagnosticoSistema() {
  // Operação `djen_diagnostics`: última tentativa, última janela concluída, próxima execução,
  // janelas pendentes, últimas 20 execuções do coletor e a última sonda da fonte.
  return (await rpc("djen_diagnostics")) as {
    latest: any;
    last_success: string | null;
    next_due: string | null;
    pending_windows: number;
    runs: any[];
    source_check: any | null;
  };
}
