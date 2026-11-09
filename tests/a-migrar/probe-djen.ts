// SONDA REAL À API DO DJEN (faz requisição de rede). Uso manual e pontual:
//   OAB_NUMBER=<n> OAB_UF=<UF> node --import tsx tests/a-migrar/probe-djen.ts
// Depende do adaptador a ser reimplementado em src/server/djen/client.ts. Não grava nada.
import { collectDay } from "../../src/server/djen/client.ts";
const date =
  process.env.DJEN_TEST_DAY ||
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
    new Date(),
  );
try {
  const r = await collectDay(
    {
      oab_number: process.env.OAB_NUMBER!, // obrigatório: informe uma OAB sua/autorizada
      uf: process.env.OAB_UF!,
    },
    date,
  );
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      day: date,
      http_status: r.status,
      count: r.count,
      filter_verified: true,
      rate_limit_remaining: r.remaining,
      saved: 0,
    }),
  );
} catch (e: any) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      http_status: e.status || 0,
      error: e.message,
      saved: 0,
    }),
  );
  process.exitCode = 1;
}
