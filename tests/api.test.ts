import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPublicacoes,
  atualizarStatusPublicacao,
  obterPreviewRemocaoLote,
  executarRemocaoLote,
  invalidarPreview,
} from "../src/client/api.ts";

// Todas as chamadas são simuladas: nenhum teste faz requisição de rede.
type Chamada = { operacao: string; corpo: any };
function simular(respostas: Record<string, (corpo: any) => unknown>) {
  const chamadas: Chamada[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const operacao = String(url).split("/").pop()!;
    const corpo = init?.body ? JSON.parse(String(init.body)) : {};
    chamadas.push({ operacao, corpo });
    if (!respostas[operacao]) return new Response("{}", { status: 501 });
    return new Response(JSON.stringify(respostas[operacao](corpo)), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return chamadas;
}

const adv = (id: string, name: string, oab: string, uf: string) => ({
  id,
  name,
  oab_number: oab,
  uf,
});
const listagem = (extra: Record<string, unknown> = {}) => ({
  total: 1,
  rows: [
    {
      id: "p1",
      source_id: "777",
      available_on: "2026-01-02",
      tribunal: "TJXX",
      status: "em_analise",
      attorneys: [adv("u1", "Advogada A", "111", "GO"), adv("u2", "Advogado B", "222", "RJ")],
    },
  ],
  stats: { total: 1, revisar: 0, analise: 1, concluida: 0 },
  attorney_stats: [
    { ...adv("u1", "Advogada A", "111", "GO"), total: 4, revisar: 2 },
    { ...adv("u2", "Advogado B", "222", "RJ"), total: 1, revisar: 0 },
  ],
  tab_stats: {
    todos: { total: 5, revisar: 2 },
    u1: { total: 4, revisar: 2 },
    u2: { total: 1, revisar: 0 },
    interesse: { total: 2, revisar: 1 },
  },
  tribunals: [{ tribunal: "TJXX" }],
  pending_windows: 0,
  latest: null,
  last_success: null,
  next_due: null,
  ...extra,
});

test("abas são geradas a partir dos advogados do escritório, sem OAB fixa no código", async () => {
  simular({ djen_list: () => listagem() });
  const r = await fetchPublicacoes({});
  assert.deepEqual(
    r.abas.map((a) => [a.chave, a.tipo, a.total, a.aRevisar]),
    [
      ["u1", "advogado", 4, 2],
      ["u2", "advogado", 1, 0],
      ["interesse", "interesse", 2, 1],
    ],
  );
  assert.equal(r.abas[0].rotulo, "Advogada A — OAB/GO 111");
  assert.equal(r.estatisticas.porAba.todos.total, 5);
  const p = r.publicacoes[0];
  assert.equal(p.comunicacao_id, 777);
  assert.equal(p.status_revisao, "Em análise");
  assert.deepEqual(p.advogados.map((a) => a.advogado_id), ["u1", "u2"]);
});

test("aba de interesse só existe quando o servidor a informa", async () => {
  const { interesse: _, ...semInteresse } = listagem().tab_stats;
  simular({ djen_list: () => listagem({ tab_stats: semInteresse }) });
  const r = await fetchPublicacoes({});
  assert.deepEqual(r.abas.map((a) => a.chave), ["u1", "u2"]);
});

test("filtros da interface viram o filtro do servidor", async () => {
  const chamadas = simular({ djen_list: () => listagem() });
  await fetchPublicacoes({ advogadoId: "u2", status: "Concluída", busca: "x", archived: true, limite: 20, offset: 40 });
  await fetchPublicacoes({});
  const [com, sem] = chamadas.map((c) => c.corpo.p_filter);
  assert.equal(com.attorney, "u2");
  assert.equal(com.status, "concluida");
  assert.equal(com.archived, true);
  assert.equal(com.offset, 40);
  assert.equal(sem.status, "todos");
});

test("mutação que não afeta exatamente 1 registro é erro explícito", async () => {
  simular({ djen_mutate: () => 0 });
  await assert.rejects(atualizarStatusPublicacao(1, "Concluída"), /indisponível/);
});

test("lote: confirma exatamente os IDs da prévia e exige prévia atual", async () => {
  const chamadas = simular({
    djen_archive_preview: () => ({
      count: 2,
      rows: [
        { source_id: "10", process_number: "P1", tribunal: "TJXX" },
        { source_id: "11", process_number: "", tribunal: "TJYY" },
      ],
    }),
    djen_mutate: (c) => c.p_ids.length,
  });
  await assert.rejects(executarRemocaoLote("2026-01-01"), /Calcule novamente/);
  const prev = await obterPreviewRemocaoLote("2026-01-01");
  assert.equal(prev.totalAfetados, 2);
  assert.deepEqual(prev.processosAmostra, ["P1", "Não informado"]);
  await assert.rejects(executarRemocaoLote("2026-02-02"), /Calcule novamente/); // data diferente
  const r = await executarRemocaoLote("2026-01-01");
  assert.equal(r.totalRemovidos, 2);
  assert.deepEqual(chamadas.at(-1)!.corpo.p_ids, ["10", "11"]);
  await assert.rejects(executarRemocaoLote("2026-01-01"), /Calcule novamente/); // prévia é de uso único
});

test("lote acima de 1.000 publicações é recusado; prévia pode ser invalidada", async () => {
  simular({ djen_archive_preview: () => ({ count: 1001, rows: [] }) });
  await assert.rejects(obterPreviewRemocaoLote("2026-01-01"), /Mais de 1\.000/);
  invalidarPreview();
});
