import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Privacidade (LGPD): a interface não pode carregar nada de terceiros — nem fontes, nem scripts, nem estilos.
test("index.html não referencia hosts externos para recursos (fontes, scripts, estilos, imagens)", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const bad = [...html.matchAll(/<(?:link|script|img|iframe|source)\b[^>]*\b(?:href|src)=["'](https?:)?\/\/[^"']+/gi)].map((m) => m[0]);
  assert.deepEqual(bad, []);
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/);
  assert.doesNotMatch(html, /@import\s+url\(\s*["']?https?:/i);
});

test("as fontes usadas pelo CSS (Inter e Fraunces) são importadas localmente em main.ts", () => {
  const main = fs.readFileSync("src/client/main.ts", "utf8");
  for (const f of ["inter/latin-400", "inter/latin-500", "inter/latin-600", "fraunces/latin-400", "fraunces/latin-500"])
    assert.match(main, new RegExp(`@fontsource/${f}\\.css`));
  for (const f of ["inter", "fraunces"]) assert.ok(fs.existsSync(`node_modules/@fontsource/${f}/package.json`), `${f} não instalado`);
});
