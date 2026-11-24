// Especificação executável do adaptador DJEN (src/server/djen/client.ts). Puro: sem rede, sem banco.
// Os 10 primeiros testes vêm do sistema de origem; os demais cobrem comportamentos adicionados na reescrita.
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyHttpFailure,
  collectDay,
  validatePage,
  safeUrl,
  day,
  SourceError,
} from "../src/server/djen/client.ts";
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

// ── Comportamentos adicionados na reescrita ───────────────────────────────────

test("a consulta usa OAB só com dígitos, UF maiúscula, o mesmo dia no início e no fim e a paginação pedida", async () => {
  let seen = "";
  await collectDay({ oab_number: "00123456", uf: " go " }, date, {
    pageSize: 7,
    fetcher: async (url) => {
      seen = url;
      return page([]);
    },
  });
  const u = new URL(seen);
  assert.equal(u.pathname.endsWith("/comunicacao"), true);
  assert.equal(u.searchParams.get("numeroOab"), "123456");
  assert.equal(u.searchParams.get("ufOab"), "GO");
  assert.equal(u.searchParams.get("dataDisponibilizacaoInicio"), date);
  assert.equal(u.searchParams.get("dataDisponibilizacaoFim"), date);
  assert.equal(u.searchParams.get("itensPorPagina"), "7");
});

test("OAB ou UF inválidas falham antes de qualquer chamada de rede", async () => {
  let calls = 0;
  const fetcher = async () => (calls++, page([]));
  for (const bad of [
    { oab_number: "", uf: "GO" },
    { oab_number: "abc", uf: "GO" },
    { oab_number: "12345678", uf: "GO" },
    { oab_number: "123", uf: "G" },
  ])
    await assert.rejects(collectDay(bad, date, { fetcher }), (e: any) => e instanceof SourceError && e.kind === "BAD_REQUEST");
  await assert.rejects(collectDay(attorney, "2026-02-31", { fetcher }), SourceError);
  assert.equal(calls, 0);
});

test("item de OUTRA OAB, de OUTRO dia ou sem ID válido reprova a página", () => {
  const other = { ...item(1), destinatarioadvogados: [{ advogado: { numero_oab: "999", uf_oab: "GO" } }] };
  const otherUf = { ...item(1), destinatarioadvogados: [{ advogado: { numero_oab: "123456", uf_oab: "SP" } }] };
  const otherDay = { ...item(1), data_disponibilizacao: "2026-10-18" };
  const noId = { ...item(1), id: undefined };
  for (const bad of [other, otherUf, otherDay, noId])
    assert.throws(() => validatePage({ status: "success", count: 1, items: [bad] }, attorney, date), SourceError);
});

test("aceita aliases do item (datadisponibilizacao, numeroComunicacao) e OAB com máscara/zeros", () => {
  const aliased = {
    numeroComunicacao: 42,
    datadisponibilizacao: `${date}T00:00:00`,
    destinatarioadvogados: [{ advogado: { numero_oab: "0123.456", uf_oab: "go" } }],
  };
  const r = validatePage({ status: "success", count: 1, items: [aliased] }, attorney, date);
  assert.equal(r.items[0].id, 42);
});

test("429 sem Retry-After usa espera padrão e depois conclui", async () => {
  let calls = 0;
  const waits: number[] = [];
  const r = await collectDay(attorney, date, {
    sleep: async (ms) => void waits.push(ms),
    fetcher: async () => (++calls === 1 ? new Response("", { status: 429 }) : page([])),
  });
  assert.equal(r.count, 0);
  assert.deepEqual(waits, [5000]);
});

test("429 persistente esgota as tentativas e falha com RATE_LIMITED", async () => {
  let calls = 0;
  await assert.rejects(
    collectDay(attorney, date, {
      sleep: async () => {},
      fetcher: async () => (calls++, new Response("", { status: 429, headers: { "Retry-After": "1" } })),
    }),
    (e: any) => e.kind === "RATE_LIMITED" && e.status === 429,
  );
  assert.equal(calls, 3);
});

test("5xx que se recupera na 2ª tentativa conclui a janela", async () => {
  let n = 0;
  const r = await collectDay(attorney, date, {
    sleep: async () => {},
    fetcher: async () => (++n === 1 ? new Response("", { status: 502 }) : page([item(1)], 1)),
  });
  assert.equal(r.count, 1);
  assert.equal(n, 2);
});

test("falha de rede tem 3 tentativas e vira NETWORK_ERROR", async () => {
  let n = 0;
  await assert.rejects(
    collectDay(attorney, date, {
      sleep: async () => {},
      fetcher: async () => {
        n++;
        throw new TypeError("fetch failed");
      },
    }),
    (e: any) => e.kind === "NETWORK_ERROR",
  );
  assert.equal(n, 3);
});

test("orçamento de páginas estourado é falha explícita (nunca sucesso parcial)", async () => {
  let n = 0;
  await assert.rejects(
    collectDay(attorney, date, {
      pageSize: 1,
      maxPages: 3,
      sleep: async () => {},
      fetcher: async () => page([item(++n)], 999),
    }),
    (e: any) => e.kind === "BUDGET_EXCEEDED",
  );
  assert.equal(n, 3);
});

test("orçamento de tempo estourado durante a espera é falha explícita", async () => {
  let t = 0;
  await assert.rejects(
    collectDay(attorney, date, {
      budgetMs: 10_000,
      now: () => t,
      sleep: async (ms) => void (t += ms),
      fetcher: async () => new Response("", { status: 429, headers: { "Retry-After": "6" } }),
    }),
    (e: any) => e instanceof SourceError && (e.kind === "BUDGET_EXCEEDED" || e.kind === "RATE_LIMITED"),
  );
});

test("a fonte devolver mais itens que o total informado reprova a janela", async () => {
  await assert.rejects(
    collectDay(attorney, date, { fetcher: async () => page([item(1), item(2)], 1) }),
    /mais itens/,
  );
});

test("lê x-ratelimit-remaining quando a fonte informa", async () => {
  const r = await collectDay(attorney, date, {
    fetcher: async () =>
      new Response(JSON.stringify({ status: "success", items: [], count: 0 }), {
        headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "19" },
      }),
  });
  assert.equal(r.remaining, 19);
});

test("corpo que não é JSON e 4xx genérico falham sem repetir", async () => {
  let calls = 0;
  await assert.rejects(collectDay(attorney, date, { fetcher: async () => (calls++, new Response("<html>", { status: 200 })) }), /JSON/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(collectDay(attorney, date, { fetcher: async () => (calls++, new Response("", { status: 400 })) }), (e: any) => e.kind === "BAD_REQUEST");
  assert.equal(calls, 1);
});

test("classificação do 403: geobloqueio, WAF e política são distintos", () => {
  assert.equal(classifyHttpFailure(403, "CloudFront: we block access from your country").kind, "GEOBLOCK_CLOUDFRONT");
  assert.equal(classifyHttpFailure(403, "Request blocked by WAF").kind, "WAF_BLOCKED_OR_CHALLENGE");
  assert.equal(classifyHttpFailure(403, "").kind, "FORBIDDEN_POLICY");
  assert.equal(classifyHttpFailure(503).kind, "SERVER_ERROR");
});

test("safeUrl rejeita esquemas perigosos, credenciais embutidas e lixo", () => {
  for (const bad of ["data:text/html,x", "ftp://x.test/", "https://user:pw@x.test/", "", "não é url", null, undefined, 5])
    assert.equal(safeUrl(bad as any), null);
  assert.equal(safeUrl("http://x.test/a?b=1"), "http://x.test/a?b=1");
});
