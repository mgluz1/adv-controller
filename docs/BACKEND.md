# Backend — fase 1 (autenticação, escritórios, membros, OABs)

Node.js + Express · Neon PostgreSQL · Drizzle ORM · Better Auth. Esta fase entrega a **base
multi-escritório segura**. Ainda **não** há coletor DJEN, publicações nem pagamento.

## O que existe

| Área | Onde | Resumo |
|---|---|---|
| Configuração | `src/server/env.ts` | Validação estrita do ambiente; recusa Supabase e banco remoto sem TLS; mensagens nunca contêm senhas |
| Conexão | `src/server/db/client.ts` | `pg.Pool` para o Neon (pooler), timeouts, erro de conexão ociosa não derruba o processo |
| Esquema | `src/server/db/schema.ts` | 8 tabelas do Better Auth + `attorneys` (OABs) + `audit_log` |
| Migrações | `drizzle/0000_base.sql`, `0001_tenant_security.sql` | Versionadas; a 2ª cria o papel `adv_app`, RLS forçado e permissões mínimas |
| Isolamento | `src/server/db/tenant.ts` | `withTenant()`: único caminho para dados de escritório |
| Autenticação | `src/server/auth.ts` | E-mail/senha, sessão em cookie, limite de taxa, organizações/membros/convites |
| Permissões | `src/server/permissions.ts` | Papéis `owner · admin · member · viewer`; fonte única para Better Auth e operações |
| API | `src/server/app.ts`, `routes/` | `/api/auth/*` (Better Auth) e `/api/v1/<operacao>` (contrato do painel) |
| Migração remota segura | `scripts/db.ts`, `src/server/db/preflight.ts` | `db:target`, `db:plan` (dry-run), `db:migrate` com confirmações |

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
| `djen_list`, `djen_mutate`, `djen_archive_preview`, `djen_sync_manual`, `djen_diagnostics` | login + escritório | **501** “próxima fase” (contrato preservado; sem simular dados) |

Gestão de membros, convites e do escritório usa os endpoints nativos `/api/auth/organization/*`
(criar escritório, `invite-member`, `accept-invitation`, `update-member-role`, `remove-member`,
`set-active`, `leave`, `update`, `delete`, `get-full-organization`), já sujeitos à matriz de papéis.

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
   `audit_log` somente-inserção (sem `UPDATE`/`DELETE`).
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

## Testes (73 de servidor/unidade + 3 E2E; todos locais)

Rodam contra **Postgres real em PGlite** aplicando as migrações versionadas — sem rede e sem tocar
o Neon. `npm test` (unitários + servidor) e `npm run test:e2e` (navegador, servidor próprio sem banco).

| Arquivo | Cobre |
|---|---|
| `tests/server/db-security.test.ts` (13) | RLS, WITH CHECK, sem DELETE, auditoria imutável, papel sem privilégios, guarda de tabelas, CHECKs |
| `tests/server/tenant.test.ts` (22) | Isolamento entre escritórios, forja de escritório ativo, matriz de papéis, remoção imediata, escalada, convites, auditoria |
| `tests/server/auth.test.ts` (11) | Contrato, login/logout, enumeração, cookie, CSRF, corpos inválidos, cabeçalhos |
| `tests/server/production.test.ts` (4) | Cookie Secure, HSTS, limite de taxa, `X-Forwarded-For` forjado, CSRF nativo |
| `tests/server/preflight.test.ts` (8) | Validação de destino, plano de migração, detecção de banco errado, verificação de segurança |
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

## Riscos conhecidos e pontos a validar

| # | Risco | Mitigação / ação |
|---|---|---|
| 1 | **Não validado no Neon real** (só PGlite). Criar papel e `GRANT adv_app TO CURRENT_USER` dependem de permissões do papel de migração e do PostgreSQL 16+ | A verificação pós-migração reprova se `SET ROLE` ou o RLS não funcionarem. Rode `db:plan` e a 1ª migração numa **branch do Neon** |
| 2 | Não foi possível **provar** que a URL pertence ao projeto `adv-controller` | Confirmação humana obrigatória (`--confirm-host`, `--confirm-project`) + recusa de bancos que não parecem do Adv Controller. Conferir o host no console |
| 3 | **Sem provedor de e-mail:** sem verificação de e-mail, sem recuperação de senha, convite compartilhado manualmente (link/ID) | Pendente (fase seguinte). Convite só pode ser aceito pelo e-mail convidado |
| 4 | **Primeiro usuário em produção:** cadastro vem desligado | Ligar `AUTH_SIGNUP_ENABLED=true` temporariamente ou criar rotina administrativa de bootstrap (pendente) |
| 5 | Com cadastro ligado, qualquer pessoa cria escritórios; não há trial/assinatura que limite | Gate por assinatura vem com o pagamento |
| 6 | **A conexão do servidor é a do dono do esquema**: código que consultar `attorneys` direto, sem `withTenant`, **ignora RLS** | Regra de revisão: dados de escritório só via `withTenant`. Endurecimento recomendado: login separado, não-dono, para o runtime |
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

- Esquema e operações de **publicações** (`djen_list`, `djen_mutate`, lote, diagnóstico) e o **coletor DJEN**
  (regras em [REGRAS_DE_NEGOCIO.md](REGRAS_DE_NEGOCIO.md)); termos de interesse por escritório.
- **Pagamento/assinatura** (estado do escritório: trial, ativo, em atraso, cancelado).
- E-mail transacional (verificação, recuperação de senha, convites).
- **Interface** de onboarding (criar escritório), gestão de membros/OABs e seleção de escritório: o
  backend existe, mas o painel ainda não tem essas telas.
- Autenticação em dois fatores, painel administrativo, retenção/exportação de dados (LGPD).
