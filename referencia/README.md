# Referência (somente leitura)

Código e testes do sistema **anterior** (Express + SQLite/PostgreSQL), mantidos porque contêm
algoritmos que ainda não existem no Adv Controller. **Nada aqui é compilado, testado ou servido**:
fica fora do `tsconfig`, do build e dos scripts, e seus imports não resolvem (`pg`, `node:sqlite`,
etc.). Dados do escritório de origem foram substituídos por exemplos fictícios.

Use como especificação, não como dependência. O que vale reaproveitar:

| Arquivo | Valor |
|---|---|
| `legado/server/utils/cpcCalendar.ts` | Datas de publicação/início de prazo pelo CPC art. 224 (dias úteis, feriados nacionais e móveis). **Desligado de propósito** no produto atual (ver REGRAS_DE_NEGOCIO §7) |
| `legado/server/services/djenClient.ts` | Classificação de falhas HTTP (geobloqueio/WAF/política/limite), diagnóstico, aliases de campos, normalização do item |
| `legado/server/services/syncService.ts` | Janela de consulta e recuperação de lacunas (`calcularJanelaConsulta`) |
| `legado/server/db/database.ts` | Deduplicação, vínculo N:N, tombstone anti-reimportação, remoção em lote, lease lock, auditoria |
| `legado/test/*.test.ts` | Cenários correspondentes (dedupe, tombstone, lote, lock, gap recovery, normalizador, CPC) |
| `legado/schema-sqlite-pg-legado.sql.reference` | Esquema anterior (substituído) |

**Não** aplique o esquema, não execute o código e não copie `config.ts` para o produto: lá as OABs
eram globais; no SaaS pertencem a cada escritório.
