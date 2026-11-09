# Relatório da limpeza — 05/11/2026

Objetivo: transformar a pasta `adv-controller` (cópia do Controller Moraes Luz) em base
independente do **Adv Controller**, preservando interface, regras e testes. Sem funcionalidades
novas, sem rede, sem deploy.

## Escopo e limites respeitados

- Trabalho restrito a `/Users/miguelluz/Developer/adv-controller`. Nada foi acessado ou executado no
  projeto original, no Supabase (nenhum MCP/CLI/URL) ou em qualquer serviço remoto.
- Sem `npm install` (lockfile regenerado com `--offline --package-lock-only`; `npm prune --offline`).
- Os testes E2E bloqueiam qualquer requisição fora de `127.0.0.1`.

## Segurança do processo (backup)

| Item | Onde | Conteúdo |
|---|---|---|
| Tarball | `.backups/pre-limpeza-20261105-191341.tar.gz` (SHA-256 em `.backups/SHA256SUMS.txt`, verificado) | Estado original completo, 68 arquivos, inclusive `dist/` e o SQLite legado. Sem `node_modules` (regenerável) |
| Commit de segurança | branch **local** `backup/pre-limpeza`, commit `f83704f` | Estado original versionável (55 arquivos). Contém nomes, OABs e o ID do projeto Supabase de origem: **não publicar**. Fora dele (cobertos pelo tarball): `node_modules`, `dist`, `test-results`, SQLite |
| Git do produto | branch `main`, **histórico novo (órfão)**, sem commits | O histórico do produto nasce sem dados do escritório. A limpeza ainda **não foi commitada** |

Ambos ficam dentro do projeto e estão no `.gitignore` (`.backups/`) ou na branch local. Quando o
conteúdo for revisado, apague o tarball e a branch (`git branch -D backup/pre-limpeza`).

## Diagnóstico inicial

- Repositório Git vazio (sem commits, remotos ou hooks); **sem `.gitignore`**; nada versionado.
- Varredura de segredos: **nenhuma chave privada**. Encontrados: URL do projeto Supabase de origem e
  chave *publicável* embutidas em `index.html`, `dist/` e testes; ID de um usuário real do Auth em um
  teste SQL; chaves padrão no código legado (`ADMIN_API_KEY`, `CRON_SECRET`); nomes de advogados,
  OABs, domínio de e-mail e a sigla de um cliente do escritório.
- **O projeto já estava quebrado**: `tsc` e `npm test` falhavam porque a pasta `supabase/`
  (adaptador DJEN, coletor, migrações) **não veio na cópia**. Ver “O que ainda precisa ser migrado”.

## Removido

| O quê | Motivo |
|---|---|
| `@supabase/supabase-js`, CLI `supabase` e o script `supabase` (`package.json`, lockfile, `node_modules`) | Vínculo direto com o Supabase |
| Importação, `createClient`, `VITE_SUPABASE_*`, RPC/`from()`/`functions.invoke` em `api.ts`; `preconnect` ao projeto em `index.html` | Conexão com o projeto de origem |
| `src/client/login.ts` (+ teste) | Login por “usuário → e-mail interno do escritório”; contas passam a ser e-mail (Better Auth) |
| `scripts/check-anonymous.ts` | Sondava REST/RPC/Edge do Supabase de origem (o conceito foi registrado em REGRAS §8) |
| `public/imagens/*` (logo, emblema, favicon, og-image) e `apple-touch-icon` | Marca do escritório; trocada por monograma provisório em SVG |
| `dist/`, `test-results/`, `.DS_Store` | Artefatos gerados (o build embutia URL e chave publicável de origem) |
| `docs/ATIVAR_CONTA`, `AUDITORIA`, `HOMOLOGACAO`, `RELATORIO_IMPLANTACAO` | Histórico operacional do escritório (ID do projeto, evidências, passos de ativação). O que era regra de negócio foi extraído para `REGRAS_DE_NEGOCIO.md` |
| `_REVISAR_PARA_APAGAR/` inteira | Triagem anterior. Do legado: `demoService` (modo demo), auth HMAC e rotas `/api`, CLIs de backup/job, docs do sistema antigo, `bun.lock`, SQLite (0 comunicações, só logs), README |
| Abas e rótulos fixos de dois advogados e da sigla de um cliente, mapeamento OAB→aba fixa em `api.ts`, classes CSS por advogado | Dados do escritório de origem no código |
| Mensagem “Utilize Supabase Auth” e rota `410` em `server.ts`; texto “uso exclusivo da equipe” do escritório na tela de login | Referências ao sistema de origem |
| Chaves padrão (`ADMIN_API_KEY`, `CRON_SECRET`), `SUPABASE_DB_URL`, advogados reais em `legado/server/config.ts` | Credenciais/dados no código |
| Teste de login do escritório em `djen.test.ts` | Específico do escritório/Supabase Auth |

## Preservado

| O quê | Onde agora | Situação |
|---|---|---|
| Interface completa: tabela densa, expansão do teor, filtros (tribunal, status, arquivo, período, busca), ordenação, paginação, modais (anotação, lote, diagnóstico), login com mostrar/ocultar senha, responsividade, tokens CSS | `index.html`, `src/client/main.ts` | Vigente; 3 E2E verdes. Paleta herdada do escritório (ver pendências) |
| Mapeamento resposta→modelo da interface, status, formatação, escape/XSS, prévia→lote por IDs exatos | `src/client/api.ts`, `main.ts` | Vigente; 6 testes unitários |
| Contadores por aba independentes da aba ativa; aba de termos de interesse; exclusão só na apresentação | UI + `docs/REGRAS_DE_NEGOCIO.md` §6 | UI vigente; regra de servidor a migrar |
| Adaptador do DJEN (paginação, Retry-After, 403, 5xx, IDs repetidos, total mutável…) | `tests/a-migrar/djen-adapter.test.ts` (10 testes) | Especificação; **módulo ausente** |
| Deduplicação, N:N entre OABs, lease/fencing, arquivar/restaurar/tombstone, atomicidade, multiusuário, isolamento | `tests/a-migrar/sql-supabase/*.sql` (sanitizados) | Cenários para portar |
| Classificação de falhas HTTP, aliases do item, janela de lacunas, dedupe/tombstone/lote/lock em TS, calendário CPC art. 224 | `referencia/legado/` (sanitizado) | Referência, não executa |
| Regras, agenda e limites validados em produção pelo sistema de origem | `docs/REGRAS_DE_NEGOCIO.md` | Documentado |

## Adaptações feitas (sem funcionalidade nova)

- **`src/client/transport.ts`** (novo, ~35 linhas): único ponto de saída para o backend,
  `POST /api/v1/<operacao>`. `server.ts` responde `501` em `/api`.
- **`api.ts`**: mesmas operações e formatos de resposta, sem Supabase; `attorney_stats` passou a
  trazer `id`/`name`, e as abas **são geradas dos dados**. Leituras diretas de tabela viraram as
  operações `djen_archive_preview`, `djen_diagnostics` e `djen_sync_manual`. `djen_setup` foi
  descontinuado (onboarding). Contrato em `docs/MIGRACAO.md` §3.
- **UI**: marca “Adv Controller” e monograma SVG provisório; login por e-mail; marcadores de
  advogado cíclicos (`tag-adv-0..3`).
- `package.json` (`adv-controller`, sem Supabase), `tsconfig` (exclui `referencia/` e `tests/a-migrar/`),
  `playwright.config` (sobe o servidor local), `.gitignore` e `.env.example` (sem segredos; o código só lê `PORT` e `NODE_ENV`).
- Testes novos: `tests/api.test.ts` (6) e E2E reescritos para o contrato novo (3).

## Validação (tudo local e offline)

| Verificação | Antes | Depois |
|---|---|---|
| `tsc --noEmit` | falhava (módulo inexistente) | passa |
| `npm test` | falhava | 6/6 |
| `vite build` | não medido (o relatório antigo registra 257,78 kB com supabase-js) | passa (30,6 kB); bundle sem “supabase”/URL de origem |
| Playwright (Chrome local, rede bloqueada) | — | 3/3; capturas de login (desktop/mobile) e abas conferidas visualmente |
| Varredura de resíduos (nomes, OABs, URL/ID/chaves do projeto, domínio, sigla do cliente, UUID) fora de `.backups`/`node_modules` | muitos | **zero**. Restam apenas o nome da tecnologia em `docs/` e a role `service_role` num SQL de referência |
| Lockfile | 49 menções a supabase | 0 (regenerado offline) |

**Não verificado:** nada contra Neon, Drizzle ou Better Auth (nem instalados); `tests/a-migrar/` e
`referencia/` não executam; o contrato `/api/v1` é proposta; nenhuma execução contra o DJEN real.

## O que ainda precisa ser migrado

1. **Recuperar ou reescrever o que não veio na cópia**: `supabase/functions/_shared/djen.ts`,
   `djen-sync/index.ts`, `supabase/migrations/*` (5 + 1 não aplicada de multiusuário),
   `ativar_conta.sql`, `verificar_coleta.sql`, `config.toml`, `.nvmrc`. Sem eles a lógica SQL
   (`djen_list`, `publication_tabs`, `djen_commit`, `djen_claim`) só existe como comportamento
   nos testes. Detalhes e plano em `docs/MIGRACAO.md`.
2. Backend inteiro: Better Auth, esquema Drizzle/Neon, operações da §3, coleta e agendador.
3. Multi-escritório de verdade: organizações, membros, OABs por escritório, termos de interesse
   configuráveis, onboarding.
4. **Assinatura mensal**: não há nada no código (nem a remover); definir provedor e ciclo de vida.
5. Portar os testes de isolamento/regra de `tests/a-migrar/sql-supabase/` para a nova pilha.
6. Reativar `djen-adapter.test.ts` (`tests/`) quando o adaptador existir.

## Decisões e riscos para o responsável

- **Identidade visual**: a paleta (verde/dourado/bronze) é a institucional do escritório; foi
  mantida para não perder o acabamento, mas deve ser trocada pela marca do produto (só tokens CSS
  e o monograma provisório). O mesmo vale para o nome “banca” em alguns textos.
- **Datas/prazos**: o calendário CPC está em `referencia/`, desligado como no sistema de origem.
  Retomar exige decisão de produto e revisão jurídica.
- **LGPD**: o `index.html` carrega fontes do Google (envia IP do usuário). Hospedar as fontes
  localmente é recomendável antes de abrir o produto.
- **Dados reais** do escritório de origem (45 publicações em produção) **não** devem ser migrados.
- A branch `backup/pre-limpeza` e o tarball têm dados do escritório: guarde fora do repositório
  do produto e descarte quando não precisar mais.

## Para fechar a etapa (comandos sugeridos, não executados)

```sh
git add -A && git status           # conferir antes
git commit -m "chore: base independente do Adv Controller"   # primeiro commit do histórico novo
```
