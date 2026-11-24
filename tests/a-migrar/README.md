# Testes a migrar

Especificações executáveis do sistema de origem que **só voltam a rodar quando o backend existir**.
Ficam fora do `tsconfig` e de `npm test` de propósito. Dados do escritório de origem foram
substituídos por fixtures fictícias.

| Arquivo | O que especifica | Como reativar |
|---|---|---|
| ~~`djen-adapter.test.ts`~~ | **Migrado**: agora em `tests/djen-adapter.test.ts`, contra `src/server/djen/client.ts` | — |
| `probe-djen.ts` | Sonda manual à API real (exige `OAB_NUMBER` e `OAB_UF`) | O adaptador já existe: pode rodar de um computador com internet (faz requisição de rede) |
| `sql-supabase/database-rollback.sql` | Isolamento entre contas, lease, deduplicação, N:N entre OABs, arquivar/restaurar/tombstone, atomicidade, limite de coleta manual | Portar os **cenários** para testes de integração com Drizzle (os SQL usam `auth.users`, roles `anon/authenticated` e funções do sistema de origem: não rodam no Neon) |
| `sql-supabase/interesse-rollback.sql` | Aba de termos de interesse: casamento, exclusão da aba do advogado, contadores, filtros, paginação, isolamento | idem |
| `sql-supabase/members-rollback.sql` | Vários usuários por escritório, revogação imediata, escritório desativado, auditoria com autor | idem |
