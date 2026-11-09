# Migração para Neon PostgreSQL + Drizzle ORM + Better Auth

Estado: o painel (interface, filtros, abas, revisão, arquivo) está preservado e testado contra
fixtures. **Fase 1 do backend concluída** (autenticação, escritórios, membros, papéis, OABs, RLS,
auditoria): ver [BACKEND.md](BACKEND.md). **Faltam** publicações, coletor DJEN e pagamento. Este
documento diz o que falta e como cada peça do sistema de origem se traduz para a nova pilha.

> Tudo marcado **(proposta)** é recomendação de arquitetura, não decisão aprovada. Confirme
> detalhes de Neon, Drizzle e Better Auth na documentação vigente antes de implementar: nada daqui
> foi verificado contra os serviços (a etapa foi 100% offline).

## 1. Lacuna crítica: arquivos que não vieram para esta pasta

A cópia recebida não contém a pasta `supabase/` do sistema de origem nem alguns arquivos da raiz.
Por isso `tsc` e `npm test` **já falhavam antes da limpeza** (importavam um módulo inexistente).

| Ausente | Conteúdo | Impacto |
|---|---|---|
| `supabase/functions/_shared/djen.ts` | adaptador do DJEN (`collectDay`, `validatePage`, `safeUrl`, `day`, `SourceError`) | O teste que o especifica está em `tests/a-migrar/djen-adapter.test.ts`; o módulo precisa ser **reescrito ou recuperado**. É código puro (sem Supabase) e fácil de portar. |
| `supabase/functions/djen-sync/index.ts` | coletor: uma janela dia×OAB por execução, lease, transação | Reimplementar como serviço de coleta (ver §4). |
| `supabase/migrations/*.sql` (5 aplicadas + `…_djen_members.sql`, não aplicada) | esquema, RLS, RPCs (`djen_list`, `djen_mutate`, `djen_commit`, `djen_claim`, `is_<sigla>`, `publication_tabs`…), cron/Vault, índices | **A lógica SQL real não está aqui.** Só existe como comportamento nos testes SQL (`tests/a-migrar/sql-supabase/`) e em [REGRAS_DE_NEGOCIO.md](REGRAS_DE_NEGOCIO.md). O esquema legado SQLite/PG em `referencia/` é anterior e foi substituído. |
| `supabase/ativar_conta.sql`, `verificar_coleta.sql`, `config.toml` | procedimentos operacionais | Não migrar: viram onboarding e telas administrativas do SaaS. |
| `.nvmrc`, `.env.example`, `.env.local` | versão do Node (22) e variáveis | `.env.example` foi recriado (sem segredos); Node 22 consta em `engines`. |

**Ação sugerida ao responsável (ainda pendente):** se a lógica SQL original (principalmente `djen_list`/`publication_tabs`
e `djen_commit`) for útil como referência, copie `supabase/migrations/` e `supabase/functions/` do
projeto de origem **para fora** deste repositório (ex.: `referencia/origem/`, ignorado pelo Git)
e sanitize antes de versionar. Esta etapa não acessou o projeto original.

## 2. Mapa de conceitos

| Sistema de origem (Supabase) | Função | Destino (proposta) |
|---|---|---|
| Supabase Auth (`signInWithPassword`) | login e sessão | **Better Auth** (e-mail/senha, sessão por cookie). Substituir `haSessaoAtiva`/`entrar`/`sair` em `src/client/api.ts` pelo cliente do Better Auth. |
| `djen_accounts` (allowlist por dono) | quem pode usar | Estado do escritório/assinatura (**ativo, em atraso, cancelado**) — vira a base da cobrança mensal. |
| `djen_members` (multiusuário, **nunca aplicada**) | usuários de um escritório | Membros de organização (**o plugin de organizações do Better Auth** atende; verificar) ou tabela própria. |
| RLS por `owner_id` + RPCs `SECURITY DEFINER` | isolamento e escrita | Sem PostgREST no Neon: **toda consulta filtra por `organization_id`** na camada de servidor, com testes de isolamento (os cenários de `database-rollback.sql`/`members-rollback.sql`). RLS no Postgres via `SET LOCAL` é opcional como defesa extra. |
| RPCs `djen_*` | API do painel | Rotas/handlers do servidor usando Drizzle, em transação onde a regra exigir (§3). |
| `djen_attorneys` | OABs monitoradas | Tabela `oabs`/`advogados` por escritório (nome, número, UF, ativo). **Substitui as duas OABs fixas do sistema de origem.** |
| `djen_publications` + `djen_publication_attorneys` | publicações e vínculo N:N | Mesmas tabelas; chave única (`organization_id`, `source_id`). Colunas: ver o mapeamento de campos em `src/client/api.ts` (`fetchPublicacoes`). |
| `djen_sync_cursors` (lease, fencing, `scan_day`, `target_day`, `last_complete_day`, `last_reconciled_on`, `next_due_at`) | checkpoint por OAB | Mesma tabela e semântica (§4). |
| `djen_sync_runs`, `djen_source_checks`, `djen_audit` | diagnóstico e auditoria | Mesmas tabelas. |
| `djen_private.is_<sigla>` / `publication_tabs` | aba de “sigla de interesse” (uma sigla fixa do escritório de origem) | Tabela `termos_de_interesse` **por escritório** + uma única função de casamento (regra em REGRAS_DE_NEGOCIO §6). |
| Edge Function + `pg_cron` + `pg_net` + Vault | coleta agendada e segredo | **Agendador externo** chamando um endpoint protegido (proposta: não depender de `pg_cron` com o banco que suspende por inatividade). Segredo do agendador em variável de ambiente. |
| `@supabase/supabase-js` no frontend | cliente | Removido. Resta `fetch` em `src/client/transport.ts`. |

## 3. Contrato das operações consumidas pelo painel

Todas: `POST /api/v1/<operacao>`, corpo JSON, resposta JSON, cookie de sessão. Erros: status ≠ 2xx
com `{ "erro": "mensagem para o usuário" }`. Os nomes/argumentos foram mantidos do sistema de origem
para não mexer no mapeamento da interface; se mudar, ajuste **somente** `src/client/api.ts`.
A fixture executável do contrato está em `tests/browser/ui.spec.ts` e `tests/api.test.ts`.

| Operação | Argumentos | Resposta |
|---|---|---|
| `session` ✅ | — | `{ usuario, escritorio:{id,nome,papel}, escritorios[], permissoes[] }` (anônimo: `usuario:null`) |
| `sign-in` / `sign-out` ✅ | `{ email, password }` / — | `{ ok }` — delegam ao handler do Better Auth (cookie, limite de taxa) |
| `oab_list` / `oab_create` / `oab_update` / `audit_list` ✅ | ver [BACKEND.md](BACKEND.md) | **novas** (fase 1): OABs por escritório e auditoria |
| `djen_list` (501) | `{ p_filter: { attorney, status, search, start, end, order, limit, offset, tribunal, archived } }` — `attorney` = `"todos"` \| id do advogado \| `"interesse"`; `status` = `todos`\|`a_revisar`\|`em_analise`\|`concluida` | `{ total, rows[], stats{total,revisar,analise,concluida}, attorney_stats[{id,name,oab_number,uf,total,revisar}], tab_stats{todos,<id>…,interesse?}{total,revisar}, tribunals[{tribunal}], pending_windows, latest, last_success, next_due }` — `rows[]`: ver os campos mapeados em `api.ts` |
| `djen_mutate` (501) | `{ p_action: "status"\|"archive"\|"restore"\|"remove", p_ids: string[], p_status?, p_notes?, p_providence? }` | número de registros afetados (a UI exige `1` nas ações individuais) |
| `djen_archive_preview` (501) | `{ p_date }` | `{ count, rows[{source_id, process_number, tribunal}] }` (máx. 1.000 linhas) |
| `djen_sync_manual` (501) | — | `{ sucesso, mensagem?, erro? }` (limite: 1 a cada 5 min por escritório) |
| `djen_diagnostics` (501) | — | `{ latest, last_success, next_due, pending_windows, runs[20], source_check }` |

Diferenças deliberadas em relação ao sistema de origem: `attorney_stats` agora traz `id` e `name`
(as abas são geradas dos dados, sem OAB fixa); `djen_archive_preview` e `djen_sync_manual` /
`djen_diagnostics` substituem leituras diretas de tabela e a chamada à Edge Function;
`djen_setup` (provisionamento no primeiro login) foi removido — vira **onboarding do escritório**.

## 4. Coleta (serviço de sincronização)

Reimplementar mantendo as regras de REGRAS_DE_NEGOCIO §1–§3: lease com fencing por OAB, uma janela
por execução, commit transacional (publicações + vínculos + cursor), 0 duplicatas na repetição.
Pontos novos do multi-escritório **(proposta)**:

- o claim de janelas deve ser **justo entre escritórios** e respeitar o limite global da fonte
  (o limite do CNJ é por origem/IP, não por escritório);
- a OAB é cadastrada **por escritório**; a mesma OAB em dois escritórios gera consultas duplicadas
  (decidir se compartilha o cache de resposta por OAB/dia ou paga a consulta duas vezes);
- escritório suspenso/cancelado (assinatura) **para de ser coletado**.

## 5. Ordem sugerida

1. Recuperar/reescrever o adaptador DJEN e mover `tests/a-migrar/djen-adapter.test.ts` para `tests/`
   (10 testes; roda sem rede).
2. Esquema Drizzle: usuários/sessões (Better Auth), organizações e membros, `oabs`, publicações,
   vínculos, cursores, execuções, verificações de fonte, auditoria, termos de interesse.
3. Operações da §3 com testes de isolamento entre escritórios portados dos SQL em
   `tests/a-migrar/sql-supabase/` (para Vitest/`node:test` + banco de teste Neon/branch).
4. Better Auth no Express (`/api/auth/*`) e troca do trecho provisório em `api.ts`.
5. Serviço de coleta + agendador.
6. Onboarding de escritório, cadastro de OABs e termos de interesse (hoje inexistentes).
7. Assinatura mensal: **nada existe no código** (não há o que remover); definir provedor e ciclo
   de vida (trial, atraso, cancelamento) antes do esquema de organizações.
8. Pendências operacionais herdadas: descarte definitivo nunca exercido em produção; hospedagem,
   domínio, e-mail/recuperação de senha e backup por configurar; dados reais do sistema de origem
   **não** devem ser migrados para o produto (pertencem ao escritório de origem).
