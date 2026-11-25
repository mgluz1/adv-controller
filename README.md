# Adv Controller

SaaS para escritórios de advocacia acompanharem, revisarem e arquivarem as comunicações do
**Diário de Justiça Eletrônico Nacional (DJEN)** dirigidas às OABs de cada escritório.

> **Estado: backend com autenticação, escritórios, papéis, OABs, isolamento por RLS, auditoria e as operações de
> publicações (listar, revisar, arquivar, restaurar, descartar, lote).** O coletor e o agendador existem, mas **vêm desligados** e
> nunca foram testados contra a API real do DJEN. **Ainda não existem** o pagamento, o e-mail transacional e as telas de gestão (OABs, membros, termos). Veja [docs/BACKEND.md](docs/BACKEND.md).

## Visão do produto

- **Vários escritórios**, cada um isolado dos demais, com **vários usuários** e **várias OABs**.
- **Assinatura mensal** por escritório.
- Coleta automática do DJEN por OAB; painel denso estilo planilha com revisão, providências,
  anotações, arquivo/restauração, lote por data de corte e abas por advogado.

Multi-escritório, vários usuários e OABs por escritório **já existem no backend** (sem telas de gestão
ainda); a assinatura mensal é o alvo e ainda não foi implementada.

## O que já existe

| Camada | Estado |
|---|---|
| Interface (`index.html`, `src/client/main.ts`) | Pronta: tabela, filtros, abas dinâmicas, expansão do teor, modais de anotação/lote/diagnóstico, login, responsiva |
| Camada de dados (`src/client/api.ts`, `transport.ts`) | Mapeamento resposta→interface preservado; transporte provisório `POST /api/v1/<operacao>` |
| Servidor (`server.ts`, `src/server/`) | Express + Better Auth + Drizzle/Neon: login, escritórios, membros, papéis, OABs, auditoria |
| Banco (`drizzle/`) | Migrações versionadas, RLS forçado, papel de aplicação sem privilégios de dono |
| Adaptador DJEN (`src/server/djen/client.ts`) | Pronto e testado sem rede (26 testes); **ainda não validado contra a API real** |
| Esquema de publicações (`publications`, vínculos, cursores, execuções, termos) | Pronto, com RLS e testado; aplicado na branch `development` do Neon |
| Operações `djen_list`, `djen_mutate`, `djen_archive_preview` | Prontas e testadas (isolamento, papéis, auditoria) |
| Coletor + agendador (`src/server/collector/`) e `djen_sync_manual` | Prontos e testados; **desligados por padrão** (`COLLECTOR_ENABLED=true` em uma instância); nunca falaram com a API real do DJEN |
| Termos de interesse (aba, contadores, gerência) e `djen_diagnostics` | Prontos e testados |
| Assinaturas, e-mail transacional, telas de gestão | **Não implementados** |

## Rodando localmente

Requer **Node 22+**.

```sh
npm install
cp .env.example .env.local   # preencha DATABASE_URL_UNPOOLED (dono, migração) e BETTER_AUTH_SECRET (projeto Neon "adv-controller")
npm run db:plan              # valida o destino e mostra as migrações pendentes (não altera nada)
npm run db:migrate -- --confirm-host=<host> --confirm-project=adv-controller
npm run db:runtime-login -- --confirm-host=<host> --confirm-project=adv-controller   # credencial de runtime (não-dona)
npm run dev                  # http://127.0.0.1:3000
```

Sem `.env.local` o front sobe e a API responde `503` com instruções. Os testes **não** precisam do Neon.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` / `build` / `start` | Desenvolvimento (Vite), build estático em `dist/`, produção local |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unitários e de servidor (Postgres real em PGlite; sem rede, sem Neon) |
| `npm run test:e2e` | Playwright (Chrome local, servidor próprio sem banco, API interceptada) |
| `npm run db:generate` | Gera migração a partir de `src/server/db/schema.ts` |
| `npm run db:target` / `db:plan` | Valida o destino (somente leitura) / dry-run das migrações |
| `npm run db:migrate` | Aplica migrações no Neon, exige `--confirm-host` e `--confirm-project` |
| `npm run db:runtime-login` | Habilita o login do papel de runtime `adv_runtime` e grava `DATABASE_URL` em `.env.local` (mesmas confirmações) |

## Estrutura

```
index.html · src/client/   interface e camada de dados
server.ts · src/server/    servidor, autenticação, banco, rotas
drizzle/ · scripts/db.ts   migrações versionadas e CLI de migração segura
tests/                     api.test.ts, server/ (backend) e browser/ (E2E)
tests/a-migrar/            especificações executáveis que aguardam o backend (ver README da pasta)
referencia/legado/         código e testes do sistema anterior, só para consulta (não compila nem roda)
docs/                      MIGRACAO · REGRAS_DE_NEGOCIO · LIMPEZA_RELATORIO
```

## Documentação

- [docs/BACKEND.md](docs/BACKEND.md) — fase 1: arquitetura, modelo de segurança, plano de migração no Neon, riscos e pendências.
- [docs/MIGRACAO.md](docs/MIGRACAO.md) — o que falta, mapa Supabase→Neon/Drizzle/Better Auth, contrato das operações, ordem de trabalho.
- [docs/REGRAS_DE_NEGOCIO.md](docs/REGRAS_DE_NEGOCIO.md) — regras do DJEN, deduplicação, arquivo/tombstone, abas, segurança.
- [docs/LIMPEZA_RELATORIO.md](docs/LIMPEZA_RELATORIO.md) — o que foi removido, preservado e o que resta migrar.

## Segurança

Nunca versione `.env*` (ignorados), chaves de serviço ou dados reais de clientes. O teor das
publicações é sempre escapado e links de fonte só aceitam `http/https`.
