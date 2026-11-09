// ESPECIFICAÇÃO EXECUTÁVEL DO ADAPTADOR DJEN — A MIGRAR
//
// Estes 10 testes descrevem o comportamento exigido do cliente da API do DJEN (paginação completa,
// validação de OAB/UF/data, Retry-After, backoff limitado, 403 sem retry, IDs repetidos, total mutável,
// URL segura). O módulo original (coletor da Edge Function do Supabase) NÃO veio nesta pasta; o alvo
// abaixo é o caminho planejado. Quando o adaptador for reimplementado, mova este arquivo para
// tests/ e ele passa a rodar em `npm test` sem alterações (o adaptador é puro: recebe `fetcher`
// e `sleep` por injeção e não depende de Supabase).
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectDay,
  validatePage,
  safeUrl,
  day,
  SourceError,
} from "../../src/server/djen/client.ts";
const attorney = { oab_number: "123456", uf: "GO" };
const date = "2026-10-19";
// Fixtures exclusivamente de teste; nunca enviadas à API ou ao banco de produção.
const item = (id: number) => ({
  id,
  data_disponibilizacao: date,
  texto: "<script>alert(1)</script>",
  destinatarioadvogados: [{ advogado: { numero_oab: "123456", uf_oab: "GO" } }],
});
const page = (items: any[], count = items.length) =>
  new Response(JSON.stringify({ status: "success", items, count }), {
    headers: { "Content-Type": "application/json" },
  });
test("paginação percorre todas as páginas e confirma OAB", async () => {
  let calls = 0;
  const result = await collectDay(attorney, date, {
    pageSize: 1,
    sleep: async () => {},
    fetcher: async (url) => {
      calls++;
      assert.equal(
        new URL(String(url)).searchParams.get("pagina"),
        String(calls),
      );
      return page([item(calls)], 2);
    },
  });
  assert.equal(result.count, 2);
  assert.equal(calls, 2);
});
test("página vazia precoce não resulta em sucesso", async () => {
  await assert.rejects(
    collectDay(attorney, date, { fetcher: async () => page([], 2) }),
    /Página vazia/,
  );
});
test("JSON e filtro inválidos falham explicitamente", () => {
  for (const bad of [
    {},
    { status: "success", count: "0", items: [] },
    {
      status: "success",
      count: 1,
      items: [{ ...item(1), destinatarioadvogados: [] }],
    },
  ])
    assert.throws(() => validatePage(bad, attorney, date));
});
test("403 não é repetido e não é interpretado como vazio", async () => {
  let calls = 0;
  await assert.rejects(
    collectDay(attorney, date, {
      fetcher: async () => {
        calls++;
        return new Response("", { status: 403 });
      },
    }),
    (e: any) => e.status === 403,
  );
  assert.equal(calls, 1);
});
test("429 respeita Retry-After antes de nova chamada", async () => {
  let calls = 0;
  const waits: number[] = [];
  await collectDay(attorney, date, {
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetcher: async () =>
      ++calls === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
        : page([]),
  });
  assert.deepEqual(waits, [2000]);
});
test("Retry-After além do orçamento preserva falha explícita", async () => {
  await assert.rejects(
    collectDay(attorney, date, {
      fetcher: async () =>
        new Response("", { status: 429, headers: { "Retry-After": "120" } }),
    }),
    (e: any) => e instanceof SourceError && e.retryAfter === 120,
  );
});
test("IDs repetidos em páginas não completam janela", async () => {
  await assert.rejects(
    collectDay(attorney, date, {
      pageSize: 1,
      sleep: async () => {},
      fetcher: async () => page([item(1)], 2),
    }),
    /ID repetido/,
  );
});
test("mudança de total impede checkpoint", async () => {
  let n = 0;
  await assert.rejects(
    collectDay(attorney, date, {
      pageSize: 1,
      sleep: async () => {},
      fetcher: async () => page([item(++n)], n === 1 ? 2 : 3),
    }),
    /Total DJEN mudou/,
  );
});
test("5xx tem retries limitados", async () => {
  let n = 0;
  await assert.rejects(
    collectDay(attorney, date, {
      sleep: async () => {},
      fetcher: async () => {
        n++;
        return new Response("", { status: 503 });
      },
    }),
  );
  assert.equal(n, 3);
});
test("link javascript rejeitado; datas impossíveis rejeitadas", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://www.cnj.jus.br/"), "https://www.cnj.jus.br/");
  assert.throws(() => day("2026-02-31"));
});
test("total zero válido é distinguido de erro", async () => {
  const result = await collectDay(attorney, date, {
    fetcher: async () => page([]),
  });
  assert.equal(result.count, 0);
  assert.equal(result.status, 200);
});
