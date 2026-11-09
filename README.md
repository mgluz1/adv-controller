# Adv Controller

SaaS para escritórios de advocacia acompanharem, revisarem e arquivarem as comunicações do
**Diário de Justiça Eletrônico Nacional (DJEN)** dirigidas às OABs de cada escritório.

> **Estado: fase 1 do backend pronta** (autenticação, escritórios com vários usuários, papéis,
> OABs por escritório, isolamento por RLS e auditoria). **Ainda não existem** publicações, coletor DJEN
> nem pagamento (essas operações respondem `501`). Veja [docs/BACKEND.md](docs/BACKEND.md).

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
| Publicações, coleta DJEN, assinaturas | **Não implementados** |

## Rodando localmente

Requer **Node 22+**.

```sh
npm install
cp .env.example .env.local   # preencha DATABASE_URL e BETTER_AUTH_SECRET (projeto Neon "adv-controller")
npm run db:plan              # valida o destino e mostra as migrações pendentes (não altera nada)
npm run db:migrate -- --confirm-host=<host> --confirm-project=adv-controller
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
