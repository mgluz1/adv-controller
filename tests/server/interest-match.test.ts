import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MAX_TERM, normalizeTerm, termPattern } from "../../src/server/domain/interest.ts";
import { ValidationError } from "../../src/server/domain/oab.ts";

// A regra de casamento dos termos de interesse (REGRAS §6) avaliada no motor REAL de regex do PostgreSQL (`~*`),
// que é quem decide em produção. Matriz da especificação do sistema de origem + casos hostis.
let pg: PGlite;
before(async () => {
  pg = new PGlite();
});
after(() => pg.close());

/** Mesmo operador do banco: `texto ~* padrão`. */
async function matches(term: string, text: string): Promise<boolean> {
  const { pattern } = termPattern(term);
  const r = await pg.query<{ m: boolean }>("select ($1::text ~* $2::text) as m", [text, pattern]);
  return r.rows[0].m;
}
const yes = async (term: string, ...texts: string[]) => {
  for (const t of texts) assert.equal(await matches(term, t), true, `"${term}" deveria casar com: ${JSON.stringify(t)}`);
};
const no = async (term: string, ...texts: string[]) => {
  for (const t of texts) assert.equal(await matches(term, t), false, `"${term}" NÃO deveria casar com: ${JSON.stringify(t)}`);
};

// ── Normalização ──────────────────────────────────────────────────────────────

test("normalizeTerm: espaços colapsados, limites de tamanho, sem controle e com alguma letra/número", () => {
  assert.equal(normalizeTerm("  A.   B.\tC. D.  "), "A. B. C. D.");
  assert.equal(normalizeTerm("Ab"), "Ab");
  assert.equal(normalizeTerm("x".repeat(MAX_TERM)), "x".repeat(MAX_TERM));
  for (const bad of ["", " ", "a", "x".repeat(MAX_TERM + 1), "tem\u0000nulo", "tem\u0007sino", "...", "  . .  ", 5, null, undefined, {}, ["a.b."]])
    assert.throws(() => normalizeTerm(bad as any), ValidationError, JSON.stringify(bad));
});

test("termPattern: sigla vs expressão; 'A.B.C.D' e 'A. B. C. D.' são o MESMO termo; maiúsculas não importam", () => {
  assert.equal(termPattern("A.B.C.D.").kind, "sigla");
  assert.equal(termPattern("a. b. c. d").kind, "sigla");
  assert.equal(termPattern("Empreendimentos Exemplo").kind, "expressao");
  assert.equal(termPattern("ABCD").kind, "expressao", "sem pontos não é sigla");
  assert.equal(termPattern("S/A").kind, "expressao");
  const p = termPattern("A.B.C.D.").pattern;
  assert.equal(termPattern("a.b.c.d").pattern, p);
  assert.equal(termPattern("A. B. C. D.").pattern, p);
  assert.equal(termPattern("  a . b . c . d .").pattern, p);
  assert.notEqual(termPattern("A.B.C.E.").pattern, p);
  assert.ok(termPattern("x".repeat(MAX_TERM)).pattern.length < 1000, "cabe no CHECK do banco");
  assert.ok(termPattern("(a".repeat(MAX_TERM / 2)).pattern.length < 1000, "o pior caso de escape também cabe");
});

// ── Matriz da especificação: sigla A.B.C.D. ───────────────────────────────────

test("sigla A.B.C.D.: casa em todas as formas escritas com pontos, em qualquer caixa e com espaços entre as letras", async () => {
  await yes("A.B.C.D.", "A.B.C.D.", "a.b.c.d.", "A. B. C. D.", "a. b. c. d.", "A.  B.   C.    D.", "A.\nB.\nC.\nD.");
});

test("sigla A.B.C.D.: casa no meio de texto, com pontuação e nomes ao redor", async () => {
  await yes(
    "A.B.C.D.",
    "RÉU: A.B.C.D. EXEMPLO EMPREENDIMENTOS LTDA",
    "RECORRIDO: a.b.c.d. empreendimentos",
    "EXECUTADO: A. B. C. D.",
    "(A.B.C.D.)",
    "contra A.B.C.D., que foi citada",
    "- A.B.C.D.",
    "1)A.B.C.D.2)",
    "texto 123 A.B.C.D. 456",
    "x\nA.B.C.D.\ny",
    "contra a empresa A.B.C.D", // fim da frase, sem o ponto final
    "A.B.C.D, LTDA",
    "A.B.C.D;",
    "A. B. C. D",
  );
});

test("sigla A.B.C.D.: NÃO casa sem pontos, com letra colada antes ou depois, nem com letras faltando", async () => {
  await no(
    "A.B.C.D.",
    "ABCD LTDA", // forma sem pontos
    "A.B.C.DTDA", // letra colada depois
    "SA.B.C.D.", // letra colada antes
    "SA.B.C.D", // idem, sem o ponto final
    "A.B.C.D.LTDA", // letra colada depois do ponto final
    "XA.B.C.D.",
    "A.B.C.", // incompleta
    "A.B.C.E.", // outra sigla
    "A.B.C.D.E.", // é outra sigla (a quinta letra segue a sigla)
    "A.B.C.D.E", // idem, sem o ponto final
    "A.B.C.DE", // letra colada depois, sem ponto
    "A.B.C.D.e", // letra colada depois do ponto final
    "",
    "texto qualquer sem a sigla",
  );
});

test("sigla: letras acentuadas e maiúsculas/minúsculas mistas", async () => {
  await yes("Á.B.C.", "Á.B.C.", "á.b.c.", "x á. b. c. y");
  await no("Á.B.C.", "A.B.C.", "SÁ.B.C.");
});

// ── Expressões literais ───────────────────────────────────────────────────────

test("expressão: palavras exatas, espaços flexíveis, sem diferenciar maiúsculas, delimitada por não-letras", async () => {
  await yes("Empreendimentos Exemplo", "EMPREENDIMENTOS EXEMPLO LTDA", "empreendimentos   exemplo", "x Empreendimentos\nExemplo y", "(Empreendimentos Exemplo)");
  await no("Empreendimentos Exemplo", "EmpreendimentosExemplo", "XEmpreendimentos Exemplo", "Empreendimentos Exemplos", "Exemplo Empreendimentos", "Empreendimentos");
});

test("expressão: o termo é SEMPRE literal (nunca regex do usuário)", async () => {
  await yes("x.y", "veja x.y aqui");
  await no("x.y", "veja xzy aqui", "x y");
  await no("a|b", "só a", "só b");
  await yes("a|b", "o termo a|b literal");
  await no("a+", "aaaa", "a");
  await yes("a+", "soma a+ b");
  await no("x.*", "x qualquer coisa", "xyz");
  await yes("x.*", "o termo x.* literal");
  await yes("(alfa)", "contrato (alfa) assinado");
  await no("(alfa)", "contrato alfa assinado");
  await yes("[x]", "item [x] marcado");
  await no("[x]", "item x marcado");
  await yes("S/A", "EMPRESA S/A CNPJ", "empresa s/a");
  await yes("R$ 100", "valor R$ 100 mil");
  await yes("100%", "reajuste de 100% ao ano");
  await no("100%", "reajuste de 1000 ao ano");
  await yes("C:\\dir", "caminho C:\\dir aqui");
  await yes("^inicio$", "o ^inicio$ literal");
  await no("^inicio$", "inicio");
  await yes("a-b", "código a-b ok");
  await yes("{2}", "bloco {2} fim");
});

test("expressão com acento e caixa: o casamento acompanha o locale do banco (documentado)", async () => {
  // Em locale UTF-8 as letras acentuadas são "alpha" e dobram a caixa; no locale C do PGlite só ASCII.
  const ascii = await matches("acao civil", "ACAO CIVIL PUBLICA");
  assert.equal(ascii, true);
  assert.equal(await matches("acao civil", "ACAOCIVIL"), false);
});

// ── Robustez ──────────────────────────────────────────────────────────────────

test("padrões compilam e rodam rápido mesmo com termos longos e textos grandes (sem retrocesso catastrófico)", async () => {
  const hostile = ["A.B.C.D.E.F.G.H.I.J.K.L.M.N.O.P.", "a ".repeat(39).trim(), "(a(a(a(a(a(a(a(a(a(a", "\\a\\a\\a\\a\\a", "a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a."];
  const big = ("A. ".repeat(5000) + " texto ").repeat(20); // ~300 KB
  const t0 = Date.now();
  for (const term of hostile) {
    await matches(term, big);
    await matches(term, "a".repeat(100_000));
  }
  assert.ok(Date.now() - t0 < 5000, `muito lento: ${Date.now() - t0} ms`);
});

test("o padrão nunca contém letras escapadas (sequências como \\d, \\w, \\b não podem vazar do termo)", () => {
  for (const term of ["d w b s", "dbs", "D.W.B.S.", "x-d"]) {
    const { pattern } = termPattern(term);
    // só podemos ter `\s*` / `\s+` (estruturais) e barras antes de NÃO-alfanuméricos
    const stripped = pattern.replaceAll("\\s*", "").replaceAll("\\s+", "");
    assert.ok(!/\\[A-Za-z0-9]/.test(stripped), `escape perigoso em ${pattern}`);
  }
});
