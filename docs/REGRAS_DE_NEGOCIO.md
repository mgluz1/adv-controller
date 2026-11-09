# Regras de negócio preservadas

Especificação do comportamento que o Adv Controller deve manter. Foi extraída do código, dos
testes e da documentação do sistema de origem (validado em operação com dados reais por ele).
A implementação original em SQL/Edge Function **não veio nesta pasta**; estas regras, os testes em
[`tests/a-migrar/`](../tests/a-migrar) e o código em [`referencia/`](../referencia) são o que
permite reimplementá-la sem retrabalho. Cada regra aponta onde está a evidência.

Legenda: **[vigente]** implementado e testado nesta pasta · **[a migrar]** especificado, aguardando
reimplementação · **[decisão]** depende de decisão de produto.

## 1. Fonte e coleta (DJEN / CNJ)

- **[a migrar]** Consulta por OAB + UF e por dia de disponibilização, paginada, na API pública do
  DJEN (`/comunicacao`; base configurável). Evidência: `tests/a-migrar/djen-adapter.test.ts`,
  `referencia/legado/server/services/djenClient.ts`.
- Uma **janela = um dia × uma OAB** por execução. Só avança o checkpoint (cursor) depois que a janela
  inteira foi gravada com sucesso, numa transação. Falha preserva a janela e registra o erro.
- Orçamento por janela: 45 s e 100 páginas. Estourar o orçamento é falha explícita (a janela se
  repete), nunca sucesso parcial.
- Validações obrigatórias do adaptador (cada uma tem um teste):
  1. percorre **todas** as páginas; página vazia antes do total é erro (“Página vazia”);
  2. cada item deve trazer a OAB/UF consultada entre os destinatários; JSON inválido, `count` não
     numérico ou item sem destinatário compatível falham;
  3. ID repetido entre páginas e **mudança do total** durante a paginação impedem o checkpoint;
  4. `403` **não** é repetido nem tratado como “vazio”; `429` respeita `Retry-After` (espera real;
     acima do orçamento vira falha com `retryAfter`); `5xx` tem no máximo 3 tentativas;
  5. total zero legítimo ≠ erro; datas impossíveis (`2026-02-31`) são rejeitadas;
  6. URL de fonte só aceita `http`/`https` (`javascript:` é descartado).
- Classificação de falhas HTTP (bloqueio geográfico de borda vs. WAF vs. política vs. limite de
  taxa vs. instabilidade) está em `referencia/legado/.../djenClient.ts` (`classificarErroHttp`) e
  **não** estava coberta pelo adaptador novo: vale reaproveitar para o diagnóstico.
- Campos do item bruto e aliases aceitos (`data_disponibilizacao`|`datadisponibilizacao`,
  `numero_processo`|`numeroprocessocommascara`, `meio`|`meiocompleto`, `id`|`numeroComunicacao`…):
  `referencia/legado/.../djenClient.ts` (`normalizarItemDjen`).
- Limite da fonte: após uma chamada, `x-ratelimit-remaining` foi observado em 19 (limite aparente de
  20 por janela de taxa). O coletor serializa o início de janelas (intervalo mínimo global de 4 s).

## 2. Agenda e recuperação de lacunas **[a migrar]**

- Coleta diária às 09:00 de Brasília (12:00 UTC) + continuação a cada minuto **somente** quando
  houver janela pendente.
- Primeira importação: 30 dias. Sobreposição de 7 dias a cada coleta. Reconciliação de 30 dias ao
  menos a cada 7 dias. Servidor/serviço parado → o cursor recua para cobrir a lacuna
  (`calcularJanelaConsulta`, `referencia/legado/.../syncService.ts`; teste de “gap recovery”).
- **Lease com fencing** por OAB: só um worker por vez; lease expirado invalida o worker antigo
  (um commit de worker obsoleto é recusado). Evidência: `tests/a-migrar/sql-supabase/database-rollback.sql`
  (“overlap lock”, “stale worker”) e `referencia/legado/test/securityAndLock.test.ts`.
- Solicitação manual (“Buscar agora”): no máximo 1 a cada 5 minutos **por escritório**
  (compartilhado entre usuários).

## 3. Deduplicação **[a migrar]**

- Uma comunicação oficial = **uma única linha**, única por (escritório, ID oficial da fonte).
- Uma comunicação que atinge duas OABs gera **uma linha e dois vínculos** (N:N).
- Reimportar (retry, reinício, janela repetida) insere 0 linhas e **preserva** status, notas e
  providência já anotados. Evidência: `database-rollback.sql` (“duplicate”, “notes”, “shared publication”).

## 4. Revisão

- **[vigente na UI]** Status: `a_revisar` → `em_analise` → `concluida`; providência (texto) e
  observações internas por publicação. Escrita sempre por operação servidora com identidade
  validada; nenhuma escrita direta pelo cliente.
- As operações de escrita (status, arquivar, restaurar, descartar, solicitar coleta) registram
  auditoria com o autor (`members-rollback.sql`: “autoria na auditoria”).

## 5. Arquivar, restaurar e descartar **[a migrar]**

- **Arquivar** tira da lista ativa preservando teor, notas e vínculos; **restaurar** devolve.
  Uma publicação arquivada reimportada continua arquivada.
- **Descartar definitivamente** (a UI só o oferece para publicações arquivadas) apaga teor, payload bruto, nº do processo, notas e
  vínculos e mantém apenas o identificador mínimo (*tombstone*): a reimportação passa a inserir
  0 linhas. Tombstone não aparece em nenhuma aba, contador ou lista e não pode ser restaurado.
- **Arquivamento em lote por data de corte** **[vigente na UI]**: a prévia lista as publicações
  ativas com disponibilização ≤ data (máx. 1.000; acima disso a UI exige reduzir a data); a
  confirmação arquiva **exatamente os IDs da prévia**, de uso único, ignorando filtros da lista.
  Evidência: `tests/api.test.ts`.
- Atomicidade: um lote com item inválido não grava nenhum item nem move o cursor.

## 6. Abas, contadores e filtros

- **[vigente na UI]** Abas: “Todos” + uma por advogado/OAB do escritório + (opcional) “Termos de
  interesse”. São geradas dos dados; não há OAB fixa no código. Evidência: `tests/api.test.ts`,
  `tests/browser/ui.spec.ts`.
- Contadores por aba são calculados **no servidor, sob os mesmos filtros** das linhas e **não
  dependem da aba ativa nem da página**. “N para atuar (M total)” = a revisar / total.
- Filtros: advogado (aba), tribunal, status, arquivadas/ativas, período (7, 15 ou 30 dias, ou todo o
  histórico; datas calculadas em `America/Sao_Paulo`), busca livre (processo, tribunal, teor), ordenação
  por data de disponibilização, paginação (20/página).
- **Termos de interesse [a migrar, decisão de modelo]**: no sistema de origem havia **uma sigla fixa
  do escritório** (aba própria). No SaaS isso vira **configuração por escritório** (lista de
  termos). Regra de casamento a preservar (única função, usada por linhas **e** contadores):
  - casa quando o termo aparece no **teor** ou nos **destinatários**, sem diferenciar maiúsculas;
  - a sigla é composta por letras **seguidas de ponto**, com espaços opcionais entre elas
    (`A.B.C.D.`, `a.b.c.d.`, `A. B. C. D.`) e **delimitada** por não-letras;
  - **não** casa: forma sem pontos (`ABCD LTDA`), letra colada depois (`A.B.C.DTDA`), letra colada
    antes (`SA.B.C.D`).
  - Publicações novas entram automaticamente na aba. A publicação que casa **deixa de ser exibida**
    na aba do advogado correspondente, mas **o vínculo não é alterado** (continua nas demais abas
    a que pertence). Evidência: `tests/a-migrar/sql-supabase/interesse-rollback.sql`.

## 7. Datas e prazos **[decisão]**

- A **data de publicação** não é inferida: mostra “Não informada” quando a fonte não traz. Prazos
  **não** são calculados; a UI avisa que exigem conferência do advogado responsável.
- O sistema anterior calculava a data de publicação pelo CPC art. 224 §2º (primeiro dia útil
  seguinte à disponibilização), com feriados nacionais e móveis (Páscoa/Meeus). Foi desligado de
  propósito (feriados forenses locais e suspensões de prazo tornam o cálculo inseguro). O código
  está preservado em `referencia/legado/server/utils/cpcCalendar.ts`. Retomar só por decisão
  explícita de produto.

## 8. Segurança de conteúdo e acesso

- **[vigente]** O teor é sempre exibido como texto escapado (`escapeHtml`; a fixture de XSS dos
  testes E2E garante isso); links de fonte só `http/https` com `rel="noopener noreferrer"`.
- **[a migrar]** Isolamento total entre escritórios: um usuário nunca lê, altera nem arquiva dados
  de outro (testes `database-rollback.sql`: “cross account read/update”). Acesso anônimo a qualquer
  rota de dados → 401/403. Usuário sem vínculo a escritório (ou de escritório desativado) não vê
  nada e não executa nenhuma operação; **remover o vínculo corta o acesso imediatamente**
  (`members-rollback.sql`: “revogação”). Membros do mesmo escritório veem e operam o mesmo conjunto;
  o limite de coleta manual e a auditoria (com autor) são compartilhados.
- Segredos nunca no frontend; o coletor se autentica por segredo próprio (agendador) ou por sessão
  de usuário, jamais anônimo.
