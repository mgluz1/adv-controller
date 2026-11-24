# Backend — fase 1 (autenticação, escritórios, membros, OABs)

Node.js + Express · Neon PostgreSQL · Drizzle ORM · Better Auth. Esta fase entrega a **base
multi-escritório segura**. Ainda **não** há coletor DJEN, publicações nem pagamento.

## O que existe

| Área | Onde | Resumo |
|---|---|---|
| Configuração | `src/server/env.ts` | Validação estrita do ambiente; recusa Supabase e banco remoto sem TLS; mensagens nunca contêm senhas |
| Conexão | `src/server/db/client.ts` | `pg.Pool` para o Neon (pooler), timeouts, erro de conexão ociosa não derruba o processo |
| Esquema | `src/server/db/schema.ts` | 8 tabelas do Better Auth + `attorneys` (OABs) + `audit_log` + publicações: `publications`, `publication_attorneys`, `sync_cursors`, `sync_runs`, `interest_terms` (ver *Esquema de publicações*) |
| Migrações | `drizzle/0000_base.sql`, `0001_tenant_security.sql`, `0002_runtime_role.sql`, `0003_publications.sql`, `0004_publications_security.sql` | Versionadas; a 2ª cria o papel `adv_app`, RLS forçado e permissões mínimas; a 3ª cria o papel de runtime `adv_runtime` (sem login nem senha na migração) |
| Isolamento | `src/server/db/tenant.ts` | `withTenant()`: único caminho para dados de escritório |
| Autenticação | `src/server/auth.ts` | E-mail/senha, sessão em cookie, limite de taxa, organizações/membros/convites |
| Permissões | `src/server/permissions.ts` | Papéis `owner · admin · member · viewer`; fonte única para Better Auth e operações |
| Coletor e agendador | `src/server/collector/` | Uma janela (dia × OAB) por execução, com lease/fencing, commit atômico e recuperação de lacunas; o agendador faz o laço com ritmo global (ver *Coletor*). **Desligado por padrão** (`COLLECTOR_ENABLED`) |
| API | `src/server/app.ts`, `routes/` | `/api/auth/*` (Better Auth) e `/api/v1/<operacao>` (contrato do painel) |
| Migração remota segura | `scripts/db.ts`, `src/server/db/preflight.ts` | `db:target`, `db:plan` (dry-run), `db:migrate` e `db:runtime-login`, com confirmações. Usam só `DATABASE_URL_UNPOOLED` (dono); `DATABASE_URL` é o runtime |

### Contrato `/api/v1` implementado

Mantém `POST /api/v1/<operacao>` do [MIGRACAO.md](MIGRACAO.md) §3. Erros: `{ "erro": "..." }`.

| Operação | Permissão | Resposta |
|---|---|---|
| `session` | — | `{ usuario, escritorio:{id,nome,papel}, escritorios[], permissoes[] }` (anônimo: `usuario:null`) |
| `sign-in` `{email,password}` / `sign-out` | — | `{ ok:true }` + cookie. Passa pelo handler do Better Auth (limite de taxa, origem). Erro genérico: *“E-mail ou senha incorretos.”* |
| `oab_list` | `attorney:read` | `{ oabs:[{id,name,oab_number,uf,active,created_at,updated_at}] }` |
| `oab_create` `{name,oab_number,uf}` | `attorney:create` | `{ oab }` · 409 se a OAB já existe no escritório |
| `oab_update` `{id,name?,active?}` | `attorney:update` | `{ oab }` · 404 também para OAB de outro escritório · **nunca exclui** (desativa) |
| `audit_list` | `audit:read` | `{ eventos[] }` (últimos 100) |
| `djen_list` `{p_filter}` | `publication:read` | `{ total, rows[], stats, attorney_stats[], tab_stats, tribunals[], pending_windows, latest, last_success, next_due }` (ver *Publicações*) |
| `djen_mutate` `{p_action, p_ids, p_status?, p_notes?, p_providence?}` | `review` · `archive` · `restore` · `discard` conforme a ação | **número** de publicações afetadas (a UI exige `1` nas ações individuais) |
| `djen_archive_preview` `{p_date}` | `publication:archive` | `{ count, rows[{source_id, process_number, tribunal}] }` (até 1.000 linhas; `count` exato) |
| `djen_sync_manual` | `sync:request` (owner/admin) | `{ sucesso, mensagem }` · **429** se já houve pedido nos últimos 5 min (limite do escritório, compartilhado) · 409 sem OAB ativa |
| `djen_diagnostics` | login + escritório | **501** “próxima fase” (tarefa 1.6; sem simular dados) |

Gestão de membros, convites e do escritório usa os endpoints nativos `/api/auth/organization/*`
(criar escritório, `invite-member`, `accept-invitation`, `update-member-role`, `remove-member`,
`set-active`, `leave`, `update`, `delete`, `get-full-organization`), já sujeitos à matriz de papéis.

### Publicações (`src/server/routes/publications.ts`)

- **Identificadores:** `p_ids` são os **IDs oficiais da fonte** (`source_id`), como a interface já envia; aceita número ou texto
  (`^[1-9][0-9]{0,17}$`), sem repetição, até 1.000 por chamada. IDs de outro escritório simplesmente não casam (resultado `0`).
- **Autenticação antes de validação:** anônimo sempre recebe 401, mesmo com corpo inválido.
- **`djen_mutate`:** `status` (também `p_notes`/`p_providence`: ausente = mantém; texto vazio = limpa) vale para ativas e
  arquivadas; `archive` só de ativas; `restore` só de arquivadas; `remove` (descarte/tombstone) **só de arquivadas** e apaga
  conteúdo e vínculos na mesma transação. Descartada não aceita mais nenhuma operação (`0`). Cada escrita com efeito grava **um**
  evento de auditoria com o autor, a contagem e os `source_id`; **nunca** o teor nem o texto das anotações.
- **Contagens (decisão):** `rows`/`total` obedecem a todos os filtros. `tab_stats` (contadores das abas, “N para atuar (M total)”)
  usa os mesmos filtros **exceto aba e status**: não depende da aba ativa, da página nem do filtro de status. `stats` (cabeçalho)
  usa todos os filtros exceto status. Uma comunicação ligada a duas OABs conta **uma vez** em `todos` e uma em cada aba.
  Abas = OABs ativas + inativas que ainda têm publicações vivas. Descartadas não aparecem em lugar nenhum.
- **Busca:** texto literal (curingas `%`/`_` escapados) em nº do processo, tribunal e teor, sem diferenciar maiúsculas.
- **Fora desta tarefa:** aba/contador de “termos de interesse” (`attorney: "interesse"` responde 400 até a tarefa 1.6) e a coleta
  (`latest`, `last_success`, `next_due` e `pending_windows` vêm de `sync_runs`/`sync_cursors` e hoje são nulos/0).

### Papéis

| | owner | admin | member | viewer |
|---|:-:|:-:|:-:|:-:|
| Excluir escritório; promover/rebaixar/remover donos | ✓ | | | |
| Editar escritório; gerenciar membros e convites | ✓ | ✓ | | |
| Cadastrar/editar OABs | ✓ | ✓ | | |
| Ver auditoria; solicitar coleta | ✓ | ✓ | | |
| Revisar/arquivar/restaurar publicações (fase futura) | ✓ | ✓ | ✓ | |
| Descartar publicações (fase futura) | ✓ | ✓ | | |
| Ler OABs e publicações | ✓ | ✓ | ✓ | ✓ |

Um usuário pode ter papéis diferentes em escritórios diferentes e trocar o escritório ativo.

## Modelo de segurança (defesa em camadas)

1. **O cliente nunca escolhe o escritório.** `organization_id` do corpo é ignorado. O escritório vem
   da sessão e é **revalidado no banco a cada requisição** (`routes/context.ts`): o
   `activeOrganizationId` da sessão é só uma preferência. Remover o vínculo corta o acesso na hora,
   com a mesma sessão; um id forjado na sessão cai para o escritório real do usuário.
2. **RLS no PostgreSQL.** Dados de escritório só são acessados dentro de `withTenant()`, que abre uma
   transação, fixa `app.organization_id` (local) e troca para `adv_app`. Esse papel não é dono,
   não é superusuário, não tem BYPASSRLS nem login, e RLS é **forçado** nas tabelas. Um `WHERE`
   esquecido não vaza dados; gravar em outro escritório é recusado (`WITH CHECK`).
3. **Menor privilégio.** `adv_app`: sem acesso às tabelas do Better Auth; sem `DELETE` em OABs;
   `audit_log` somente-inserção (sem `UPDATE`/`DELETE`). **Credencial de runtime separada da de migração:** o servidor
   conecta como `adv_runtime` (não é dono, sem BYPASSRLS/CREATEROLE, só DML nas tabelas do Better Auth, **nenhum**
   acesso direto a `attorneys`/`audit_log`; chega aos dados de escritório apenas por `SET ROLE adv_app` em `withTenant`).
   No startup o servidor reprova credencial de dono/superusuário/BYPASSRLS (`runtimeRoleProblems`): **fatal em produção**.
4. **Guardas automáticas.** Um teste reprova qualquer tabela com `organization_id` sem RLS forçado +
   política (ou acessível a `adv_app`), e outro reprova divergência entre esquema, migrações e o que o
   Better Auth exige. Tabela nova de domínio **precisa** de migração de segurança análoga.
5. **Autenticação.** Senha ≥ 10 caracteres (scrypt); cookie `HttpOnly`, `SameSite=Lax`, `Secure` +
   prefixo `__Secure-` em produção; sessão de 7 dias consultada no banco (sem cache); login com erro
   genérico (sem enumeração de contas); limite de taxa em banco (login 5/min, cadastro 10/h) com o IP
   fornecido pelo Express (`TRUST_PROXY`), não por `X-Forwarded-For` do cliente.
6. **CSRF.** `/api/v1`: `Origin` obrigatório e igual ao do app (ou `Sec-Fetch-Site: same-origin`).
   `/api/auth/*`: verificação de origem do Better Auth. Corpo JSON limitado a 64 kB.
7. **Escalada de papéis.** Admin não promove a dono, não rebaixa nem remove donos; último dono não sai
   nem é rebaixado; convite é pessoal; papéis desconhecidos (`constructor`, `__proto__`…) não concedem nada.
8. **Auditoria** com autor: OABs (criar/editar/ativar/desativar) e membros (convidar, entrar, mudar
   papel, remover, sair, cancelar convite, editar escritório).
9. **Entrada.** OAB (1–7 dígitos, normalizada), UF (27 válidas), nome (3–120, sem controle), UUIDs;
   as mesmas restrições existem como `CHECK` no banco. Consultas 100% parametrizadas.
10. **Cadastro aberto não é o padrão em produção** (`AUTH_SIGNUP_ENABLED` ausente ⇒ falso).

## Testes (216 de servidor/unidade + 3 E2E; todos locais)

Rodam contra **Postgres real em PGlite** aplicando as migrações versionadas — sem rede e sem tocar
o Neon. `npm test` (unitários + servidor) e `npm run test:e2e` (navegador, servidor próprio sem banco).

| Arquivo | Cobre |
|---|---|
| `tests/server/db-security.test.ts` (13) | RLS, WITH CHECK, sem DELETE, auditoria imutável, papel sem privilégios, guarda de tabelas, CHECKs |
| `tests/server/tenant.test.ts` (22) | Isolamento entre escritórios, forja de escritório ativo, matriz de papéis, remoção imediata, escalada, convites, auditoria |
| `tests/server/auth.test.ts` (11) | Contrato, login/logout, enumeração, cookie, CSRF, corpos inválidos, cabeçalhos |
| `tests/server/production.test.ts` (4) | Cookie Secure, HSTS, limite de taxa, `X-Forwarded-For` forjado, CSRF nativo |
| `tests/server/preflight.test.ts` (8) | Validação de destino, plano de migração, detecção de banco errado, verificação de segurança |
| `tests/server/runtime-role.test.ts` (12) | Papel `adv_runtime`: sem acesso direto a dados de escritório, grava só o Better Auth, não herda `adv_app`, sem DDL, sem login na migração, `runtimeRoleProblems`, mutações do `verifySecurity` |
| `tests/server/publications-schema.test.ts` (17) | Tabelas de publicações: isolamento, WITH CHECK, FK composta, deduplicação, N:N, arquivar/restaurar/tombstone, privilégios mínimos, CHECKs, cascata |
| `tests/server/publications-api.test.ts` (18) | `djen_list`/`djen_mutate`/`djen_archive_preview`: papéis, filtros, contadores, isolamento, ciclo arquivar/restaurar/descartar, lote por IDs exatos, auditoria, validação |
| `tests/scheduler.test.ts` (12) | Agendador: ritmo de 4 s, espera ociosa, recuo de erros, `wake()`, `stop()` limpo (relógio falso e timers reais) |
| `tests/server/scheduler-integration.test.ts` (2) | Agendador + coletor + banco reais: primeira carga de 30 janelas, ociosidade, OAB nova acorda o laço, falha e recuperação |
| `tests/server/sync-manual.test.ts` (8) | Coleta manual: papéis, limite de 5 min por escritório (compartilhado, simultâneo), efeito nos cursores, `wake` |
| `tests/server/collector.test.ts` (32) | Coletor: ciclo (30 dias, sobreposição, reconciliação, lacuna), lease/fencing, atomicidade, deduplicação, N:N, arquivada/tombstone, falhas e recuo, rodízio, isolamento |
| `tests/collector-pure.test.ts` (15) | Calendário, planejamento do ciclo, recuo e normalização do item (sem banco) |
| `tests/djen-adapter.test.ts` (26) | Adaptador DJEN (sem rede) |
| `tests/server/unit.test.ts` (9) | Ambiente, destino do banco (Supabase/TLS), permissões, validações, aderência do esquema |

Os testes de negação têm **controles positivos** (a mesma chamada, com o papel certo, funciona), e as
camadas de isolamento foram validadas por mutação (remover `SET ROLE` ou a revalidação de associação
derruba os testes).

## Migração para o Neon — plano para aprovação (NADA foi aplicado)

Não havia credencial do Neon neste ambiente e nenhuma ferramenta que identifique o projeto pelo nome.
Por isso nenhuma migração remota foi executada. O destino é validado pelo fluxo abaixo.

**Alterações planejadas** (banco novo, schema `public` + schema `drizzle`):

- `0000_base` — cria 10 tabelas: `user, session, account, verification, organization, member,
  invitation, rate_limit` (Better Auth) e `attorneys, audit_log` (domínio), com chaves estrangeiras
  (`ON DELETE CASCADE` ao escritório), índices e `CHECK`s. Habilita RLS nas duas tabelas de domínio.
- `0001_tenant_security` — cria o papel `adv_app` (`NOLOGIN NOSUPERUSER NOBYPASSRLS …`); `GRANT adv_app
  TO CURRENT_USER`; função `app_current_org()`; `GRANT` mínimos; `FORCE ROW LEVEL SECURITY`; 5 políticas.
- Cria `drizzle.__drizzle_migrations` (histórico). **Nenhum dado é lido, alterado ou apagado.**

**Passo a passo:**

1. No console do Neon, no projeto **`adv-controller`**, copie a conexão **direta** e a **com pooler**
   para `.env.local` (`DATABASE_URL_UNPOOLED`, `DATABASE_URL`). Gere `BETTER_AUTH_SECRET`
   (`openssl rand -base64 32`). Veja `.env.example`.
2. `npm run db:target` — conecta (somente leitura), mostra host/banco/usuário (sem senha) e valida.
   Reprova: Supabase, sem TLS, host que não é `*.neon.tech`, banco com tabelas e sem o histórico do
   Adv Controller, tabelas desconhecidas, migração aplicada diferente da do repositório.
3. `npm run db:plan` — dry-run: lista as instruções pendentes. Não altera nada.
4. Depois da sua aprovação: `npm run db:migrate -- --confirm-host=<host> --confirm-project=adv-controller`.
   Aplica e roda a **verificação de segurança no banco real** (papel, RLS forçado, privilégios).
5. `npm run dev` e teste o fluxo (cadastro → escritório → OAB).

## Esquema de publicações (migrações 0003 + 0004)

| Tabela | Papel | `adv_app` pode |
|---|---|---|
| `publications` | Uma comunicação oficial por escritório, única por (escritório, `source_id`). Ciclo: ativa → arquivada (`archived_at`) → descartada (`removed_at`) | SELECT, INSERT, UPDATE (**nunca DELETE**) |
| `publication_attorneys` | Vínculo N:N publicação↔OAB (1 linha + 2 vínculos quando atinge duas OABs) | SELECT, INSERT, **DELETE** (único DELETE de domínio: o descarte apaga os vínculos) |
| `sync_cursors` | Checkpoint e lease com fencing, um por OAB | SELECT, INSERT, UPDATE |
| `sync_runs` | Uma janela (dia × OAB) por linha: status, HTTP, itens, erro | SELECT, INSERT, UPDATE |
| `interest_terms` | Termos de interesse por escritório (único sem diferenciar maiúsculas) | SELECT, INSERT, UPDATE |

Garantias **no banco** (valem mesmo para um bug de aplicação): RLS forçado + política por operação em todas; chaves
estrangeiras **compostas** `(organization_id, id)` (um vínculo entre escritórios é impossível até para quem ignora o RLS);
**tombstone** é a mesma linha com teor, payload, nº do processo, notas, destinatários e link apagados (CHECK), só nasce de
publicação arquivada (CHECK) e nunca volta (gatilho `publications_guard`); a identidade (escritório + ID oficial) não muda;
não se vincula OAB a tombstone (gatilho `publication_attorneys_guard`); CHECKs de status, ID oficial, URL `http(s)`, datas e
tamanhos. `adv_runtime` não acessa nenhuma delas diretamente.

Ainda **não** existem: a função de casamento dos termos de interesse (tarefa 1.6) e a tabela de sondas da fonte
(`source_checks`, tarefa 1.6). As operações `djen_list/mutate/archive_preview` existem (tarefa 1.3). `sync_cursors` e `sync_runs` só têm o esquema; a lógica de
claim/fencing vem com o coletor (1.4). Dados de escritório a coletar para **todos** os escritórios exigem enumerar `organization`
(o runtime lê) e chamar `withTenant` por escritório: não há papel com visão global, de propósito.

## Coletor (`src/server/collector/`)

Fluxo de **uma janela** (dia × OAB), sem nenhuma transação aberta durante a chamada de rede:

1. **claim** (`claimWindow`, transação curta): cria o cursor das OABs ativas, escolhe a mais antiga vencida com
   `FOR UPDATE SKIP LOCKED`, grava um **lease novo** (5 min) e abre a execução em `sync_runs`. Execução anterior sem desfecho vira `ABANDONED`.
2. **coleta** (`collectDay`, adaptador 1.1): completa e validada, ou falha explícita.
3. **commit** (`commitWindow`, UMA transação): primeiro o **fencing** (`lease_id` igual, `lease_until` no futuro e `scan_day` na posição
   esperada); se não vale, `StaleLeaseError` e nada é gravado. Depois publicações (`ON CONFLICT DO NOTHING`), vínculos para as vivas
   (inclusive as já existentes, achadas por outra OAB), `last_seen_at` e o encerramento da execução. Tudo ou nada.
4. **falha** (`failWindow`): libera o lease, conta a falha, adia a janela e **a repete** (o cursor nunca pula). Só mexe no cursor se o lease ainda é do worker.

**Ciclo e lacunas** (`schedule.ts`): primeira carga = últimos 30 dias, do mais antigo ao mais novo; coleta normal relê os **7 dias** já coletados
(sobreposição) + dias novos; reconciliação de 30 dias a cada 7; parado por dias ⇒ o recuo parte da última janela concluída e cobre o buraco
(teto de 180 dias). Concluído o ciclo, `next_due_at` = próximo 09:00 de Brasília (12:00 UTC); com janelas pendentes, vence imediatamente.
`last_reconciled_on` é gravado ao **iniciar** o ciclo de reconciliação (o ciclo persiste em `scan_day` e termina antes de outro começar).

**Recuo após falha:** bloqueio 403 = 60 min; 429 = o `Retry-After` (mín. 5 min, teto 6 h); 5xx/rede/timeout = 2, 4, 8… até 60 min; resposta
inconsistente = 30 min; orçamento estourado = 5 min; erro interno = 15 min (mensagem genérica no registro; detalhe só no log do servidor).

**Agendador** (`scheduler.ts`): laço que chama `collectNext()` uma janela por vez. **Ritmo:** no mínimo 4 s (`COLLECTOR_MIN_INTERVAL_MS`,
piso 2 s) entre o **início da chamada à fonte** de duas janelas (o limite do CNJ é por origem, não por escritório). Não há relógio próprio:
o coletor decide o que vence (09:00 de Brasília para o ciclo diário; imediato enquanto houver janelas pendentes) e o laço, quando ocioso, dorme
até o menor vencimento conhecido (entre 1 s e 60 s). Erro ao acionar o coletor (p.ex. banco fora) nunca derruba o laço: recuo de 30 s a 5 min.
`stop()` espera a janela em andamento (até 30 s no desligamento do servidor); o lease vence sozinho se travar.

**Dicas por escritório:** um escritório sem trabalho não é reconsultado a cada janela. O coletor guarda até quando ele só terá trabalho
(menor `next_due_at`, fim de lease), limitado a 5 min para enxergar mudanças feitas por **outra instância**. `wake(escritório)` apaga a dica; é
chamado ao **criar/reativar uma OAB** (a primeira carga começa na hora) e na coleta manual. Custo ocioso: uma consulta por escritório a cada 5 min.

**Coleta manual** (`djen_sync_manual`, `routes/sync.ts`): não coleta dentro da requisição (um ciclo são dezenas de janelas); registra o pedido,
vence as OABs ativas **agora** (passando por cima de recuo de falha, sem tocar em janela com lease ativo) e acorda o agendador. Limite de **1 a cada 5 min
por escritório, compartilhado entre usuários**: o instante é o do evento de auditoria `sync.requested` (com o autor), e um lock de transação
(`pg_advisory_xact_lock`) serializa pedidos simultâneos. Sem OAB ativa responde 409 **sem consumir** o limite.

**Subir o coletor** (ver `.env.example`): `COLLECTOR_ENABLED=true` em **UMA** instância, num host com processo persistente. Várias instâncias continuam
corretas (lease/fencing), mas cada uma respeitaria o intervalo sozinha e a fonte receberia o dobro do ritmo; eleição de líder fica para quando houver
mais de uma instância. Padrão desligado: `npm run dev` nunca consulta o CNJ por engano. `DJEN_BASE_URL` (https) troca a base da API.

**Decisões e limites conhecidos**
- O relógio é o da aplicação (`now` injetável), inclusive no lease; não depende do relógio do banco.
- **Escritórios:** o coletor lista `organization` (o runtime lê) e entra em cada um com `withTenant`, em rodízio. Não há papel com visão global.
  Com as dicas, um escritório ocioso custa uma consulta a cada 5 min; acima de alguns milhares de escritórios vale um índice global de “escritórios com trabalho vencido”.
- **Sem cache compartilhado:** a mesma OAB em dois escritórios é consultada duas vezes (decisão registrada; reavaliar se a fonte limitar).
- **Gate de assinatura:** entra em `organizationIds` (Fase 3); hoje todos os escritórios são coletados.
- **Capacidade (limite do CNJ):** com intervalo global de 4 s ≈ 21.600 janelas/dia. Uma OAB gasta ~8 janelas/dia (7 de sobreposição + 1 nova) e, em média,
  +4,3/dia de reconciliação ⇒ ~12 janelas/dia ⇒ **~1.750 OABs** no total antes de saturar. Para escalar: reduzir a sobreposição, coletar por intervalo de datas ou dividir por origem/IP.
- **Não validado contra a API real do DJEN** (mesma limitação do adaptador).

## Estado da branch `development` do Neon (24/11/2026)

Projeto `adv-controller` (`lucky-base-99617459`, sa-east-1, PostgreSQL 18). Branch `development` criada a partir de `production`,
Neon Auth desativado nela (estava vazio) e as 5 migrações (0000–0004) aplicadas. **A `production` continua vazia e intocada.**

- O ambiente de nuvem onde isto foi feito só alcança HTTPS: o driver `pg` (TCP 5432) não conecta. As migrações foram aplicadas
  pela API HTTPS do Neon, reproduzindo o migrador do Drizzle (mesmos SQL e mesmos hashes em `drizzle.__drizzle_migrations`).
- Verificação: impressão digital do esquema (colunas, constraints, índices, políticas, RLS, privilégios, papéis, diário) **idêntica**
  à do banco de teste; teste funcional no Neon real (transação revertida) provou RLS, isolamento entre escritórios, `WITH CHECK`,
  ausência de `DELETE`/`UPDATE` de auditoria e que `adv_runtime` não lê dados de escritório, não cria tabelas nem papéis.
- **Falta, a partir de um computador com acesso à porta 5432:** `npm run db:target` e `db:plan` (devem apontar "nenhuma migração pendente"),
  e `npm run db:runtime-login -- ...` (habilita o login de `adv_runtime` e grava `DATABASE_URL`). Só então `npm run dev` contra o Neon.
- A branch `production` **não pôde ser protegida**: o plano atual do Neon não permite branches protegidas.

## Riscos conhecidos e pontos a validar

| # | Risco | Mitigação / ação |
|---|---|---|
| 1 | **Não validado no Neon real** (só PGlite). Criar papel e `GRANT adv_app TO CURRENT_USER` dependem de permissões do papel de migração e do PostgreSQL 16+ | A verificação pós-migração reprova se `SET ROLE` ou o RLS não funcionarem. Rode `db:plan` e a 1ª migração numa **branch do Neon** |
| 2 | Não foi possível **provar** que a URL pertence ao projeto `adv-controller` | Confirmação humana obrigatória (`--confirm-host`, `--confirm-project`) + recusa de bancos que não parecem do Adv Controller. Conferir o host no console |
| 3 | **Sem provedor de e-mail:** sem verificação de e-mail, sem recuperação de senha, convite compartilhado manualmente (link/ID) | Pendente (fase seguinte). Convite só pode ser aceito pelo e-mail convidado |
| 4 | **Primeiro usuário em produção:** cadastro vem desligado | Ligar `AUTH_SIGNUP_ENABLED=true` temporariamente ou criar rotina administrativa de bootstrap (pendente) |
| 5 | Com cadastro ligado, qualquer pessoa cria escritórios; não há trial/assinatura que limite | Gate por assinatura vem com o pagamento |
| 6 | ~~A conexão do servidor era a do dono do esquema~~ **Resolvido** (migração 0002): o runtime usa `adv_runtime`; consulta direta a `attorneys` falha com `permission denied`, e o servidor recusa subir em produção com credencial de dono | Manter: tabela de domínio nova **não** ganha acesso automático para `adv_runtime` (sem `ALTER DEFAULT PRIVILEGES`) |
| 7 | `TRUST_PROXY` errado atrás de proxy: todos os usuários parecem ter o mesmo IP (limite de taxa global) ou o IP pode ser forjado | Definir `TRUST_PROXY` conforme a hospedagem; há teste do caso forjado |
| 8 | Sem CSP: a interface usa atributos `onclick` e estilos inline | O teor é sempre escapado (teste de XSS). CSP exige refatorar os handlers |
| 9 | Auditoria cobre OABs e membros, não tentativas de login; é apagada se o escritório for excluído (cascata) | Decidir retenção (LGPD) antes de produção |
| 10 | Excluir escritório é irreversível e apaga seus dados | Só o dono pode; considerar exclusão lógica com prazo |
| 11 | Todo membro enxerga a lista de membros do escritório (comportamento do Better Auth) | Aceitável; revisar se algum papel deve ocultar |
| 12 | Servidor escuta só em `127.0.0.1` | Ajustar no deploy (fora do escopo desta fase) |
| 13 | Dependências: 4 avisos moderados, todos do `esbuild` interno do `drizzle-kit` (ferramenta de desenvolvimento, não roda em produção) | Acompanhar atualização do drizzle-kit |
| 14 | Better Auth evolui rápido (versão fixada em 1.7.18) | Teste de aderência do esquema reprova atualizações que exijam novas colunas |
| 15 | `activeOrganizationId` da sessão guarda um id sem chave estrangeira | Sem risco de acesso (revalidado); apenas higiene |

## Pendências (fora desta fase)

- `djen_diagnostics`; termos de interesse (casamento + aba); eleição de líder do coletor (só se houver mais de uma instância); tela de "Buscar agora" já existe na interface e usa `djen_sync_manual`.
- **Pagamento/assinatura** (estado do escritório: trial, ativo, em atraso, cancelado).
- E-mail transacional (verificação, recuperação de senha, convites).
- **Interface** de onboarding (criar escritório), gestão de membros/OABs e seleção de escritório: o
  backend existe, mas o painel ainda não tem essas telas.
- Autenticação em dois fatores, painel administrativo, retenção/exportação de dados (LGPD).
