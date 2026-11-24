# Testes a migrar

Especificações executáveis do sistema de origem que **só voltam a rodar quando o backend existir**.
Ficam fora do `tsconfig` e de `npm test` de propósito. Dados do escritório de origem foram
substituídos por fixtures fictícias.

| Arquivo | O que especifica | Como reativar |
|---|---|---|
| ~~`djen-adapter.test.ts`~~ | **Migrado**: agora em `tests/djen-adapter.test.ts`, contra `src/server/djen/client.ts` | — |
| `probe-djen.ts` | Sonda manual à API real (exige `OAB_NUMBER` e `OAB_UF`) | O adaptador já existe: pode rodar de um computador com internet (faz requisição de rede) |
| `sql-supabase/database-rollback.sql` | Isolamento entre contas, lease, deduplicação, N:N entre OABs, arquivar/restaurar/tombstone, atomicidade, limite de coleta manual | **Portado em parte**: isolamento, deduplicação, N:N, arquivar/restaurar/tombstone e acesso anônimo estão em `tests/server/publications-*.test.ts`. **Faltam** (coletor, tarefas 1.4/1.5): lease/fencing, atomicidade do commit da janela e limite de 1 coleta manual a cada 5 min |
| `sql-supabase/interesse-rollback.sql` | Aba de termos de interesse: casamento, exclusão da aba do advogado, contadores, filtros, paginação, isolamento | idem |
| `sql-supabase/members-rollback.sql` | Vários usuários por escritório, revogação imediata, escritório desativado, auditoria com autor | **Portado em parte**: revogação imediata, papéis e auditoria com autor em `tests/server/tenant.test.ts` e `publications-api.test.ts`. Resta o caso de escritório desativado (assinatura, Fase 3) |
