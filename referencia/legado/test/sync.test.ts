import assert from 'node:assert';
import { DatabaseManager } from '../server/db/database.js';
import { DjenClient } from '../server/services/djenClient.js';
import { SyncService } from '../server/services/syncService.js';

console.log('--- INICIANDO TESTES DO SISTEMA DE MONITORAMENTO ---');

// Teste 1: Inicialização do banco em memória e esquema
{
  console.log('Teste 1: Criação de banco e esquema de tabelas...');
  const db = new DatabaseManager(':memory:');
  const meta = db.getSyncMetadata();
  assert.strictEqual(meta.status, 'idle');
  assert.strictEqual(meta.id, 1);
  console.log('✓ Esquema e metadados inicializados com sucesso.');
}

// Teste 2: Inserção, acúmulo e deduplicação com preservação de status
{
  console.log('Teste 2: Deduplicação e preservação de status/observações...');
  const db = new DatabaseManager(':memory:');

  const pub1 = {
    comunicacao_id: 101,
    sigla_tribunal: 'TJGO',
    nome_orgao: '1ª Vara Cível',
    numero_processo: '5001-2024',
    nome_classe: 'Procedimento Comum',
    tipo_comunicacao: 'Intimação',
    texto: 'Texto de intimação original',
    data_disponibilizacao: '2026-10-10',
    data_publicacao: '2026-10-13',
    status_revisao: 'A revisar',
    providencia: 'A definir',
    importado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };

  const r1 = db.salvarComunicacao(pub1, { id: 'adv-a', nome: 'Advogada Exemplo A', oab: 'OAB/GO 123456' });
  assert.strictEqual(r1.status, 'inserido');

  // Advogado altera o status para "Em andamento" e anota uma providência
  db.atualizarStatus(101, 'Em andamento', 'Elaborar contestação', 'Cliente já enviou os documentos');

  // Nova coleta traz a mesma publicação com texto ligeiramente atualizado pela fonte
  const pub1Atualizado = {
    ...pub1,
    texto: 'Texto de intimação republicado com retificação',
    status_revisao: 'A revisar', // A API traria o padrão
  };
  const r2 = db.salvarComunicacao(pub1Atualizado, { id: 'adv-a', nome: 'Advogada Exemplo A', oab: 'OAB/GO 123456' });
  assert.strictEqual(r2.status, 'atualizado');

  // O total de registros deve continuar sendo 1 (não duplicou)
  const list = db.listarComunicacoes({});
  assert.strictEqual(list.total, 1);
  // O status e a observação definidos pelo advogado DEVEM ser preservados!
  assert.strictEqual(list.publicacoes[0].status_revisao, 'Em andamento');
  assert.strictEqual(list.publicacoes[0].providencia, 'Elaborar contestação');
  assert.strictEqual(list.publicacoes[0].observacoes, 'Cliente já enviou os documentos');
  console.log('✓ Deduplicação correta e status/anotações internas preservadas.');
}

// Teste 3: Vínculo compartilhado entre dois advogados sem duplicar a publicação
{
  console.log('Teste 3: Vínculo compartilhado entre os dois advogados...');
  const db = new DatabaseManager(':memory:');

  const pubCompartilhada = {
    comunicacao_id: 202,
    sigla_tribunal: 'STJ',
    nome_orgao: '3ª Turma',
    numero_processo: 'REsp 123456',
    data_disponibilizacao: '2026-10-12',
    status_revisao: 'A revisar',
    importado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };

  db.salvarComunicacao(pubCompartilhada, { id: 'adv-a', nome: 'Advogada Exemplo A', oab: 'OAB/GO 123456' });
  db.salvarComunicacao(pubCompartilhada, { id: 'adv-b', nome: 'Advogado Exemplo B', oab: 'OAB/RJ 234567' });

  // Registro único de comunicação
  const todos = db.listarComunicacoes({});
  assert.strictEqual(todos.total, 1);
  assert.strictEqual(todos.publicacoes[0].advogados?.length, 2);

  // Aparece na aba da AdvA
  const abaAdvA = db.listarComunicacoes({ advogadoId: 'adv-a' });
  assert.strictEqual(abaAdvA.total, 1);

  // Aparece na aba do AdvB
  const abaAdvB = db.listarComunicacoes({ advogadoId: 'adv-b' });
  assert.strictEqual(abaAdvB.total, 1);

  console.log('✓ Vínculo compartilhado sem duplicar comunicação validado.');
}

// Teste 4: Tombstone e bloqueio de reimportação após remoção
{
  console.log('Teste 4: Remoção e bloqueio de reimportação (Tombstone)...');
  const db = new DatabaseManager(':memory:');

  const pub = {
    comunicacao_id: 303,
    sigla_tribunal: 'TJRJ',
    numero_processo: '000303-2024',
    data_disponibilizacao: '2026-10-01',
    status_revisao: 'A revisar',
    importado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };

  db.salvarComunicacao(pub, { id: 'adv-b', nome: 'Advogado Exemplo B', oab: 'OAB/RJ 234567' });
  assert.strictEqual(db.listarComunicacoes({}).total, 1);

  // Advogado remove a publicação
  const removido = db.removerIndividual(303, 'Processo já arquivado');
  assert.strictEqual(removido, true);
  assert.strictEqual(db.listarComunicacoes({}).total, 0);
  assert.strictEqual(db.isRemovida(303), true);

  // Nova coleta futura tenta reinserir a comunicação 303
  const tentouReimportar = db.salvarComunicacao(pub, { id: 'adv-b', nome: 'Advogado Exemplo B', oab: 'OAB/RJ 234567' });
  assert.strictEqual(tentouReimportar.status, 'ignorado_removido');
  assert.strictEqual(db.listarComunicacoes({}).total, 0);

  console.log('✓ Bloqueio de reimportação (tombstone) funcionando com sucesso.');
}

// Teste 5: Remoção em lote por data de corte
{
  console.log('Teste 5: Remoção em lote por data de corte...');
  const db = new DatabaseManager(':memory:');

  // Inserir publicações em diferentes datas
  const datas = ['2026-08-01', '2026-08-15', '2026-09-01', '2026-10-01'];
  datas.forEach((dt, idx) => {
    db.salvarComunicacao({
      comunicacao_id: 400 + idx,
      sigla_tribunal: 'TJGO',
      numero_processo: `Proc-${idx}`,
      data_disponibilizacao: dt,
      status_revisao: 'Concluído',
      importado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    }, { id: 'adv-a', nome: 'AdvA', oab: '123456' });
  });

  assert.strictEqual(db.listarComunicacoes({}).total, 4);

  // Prévia da remoção para corte em 2026-08-31 (deve afetar as 2 de agosto)
  const preview = db.previewRemocaoLote('2026-08-31');
  assert.strictEqual(preview.total, 2);

  // Executar remoção em lote
  const excluidos = db.removerLote('2026-08-31');
  assert.strictEqual(excluidos, 2);

  const restantes = db.listarComunicacoes({});
  assert.strictEqual(restantes.total, 2);
  assert.strictEqual(restantes.publicacoes[0].data_disponibilizacao, '2026-10-01');
  assert.strictEqual(restantes.publicacoes[1].data_disponibilizacao, '2026-09-01');

  // Os 2 IDs excluídos não podem ser reimportados
  assert.strictEqual(db.isRemovida(400), true);
  assert.strictEqual(db.isRemovida(401), true);
  assert.strictEqual(db.isRemovida(402), false);

  console.log('✓ Remoção em lote com prévia e catálogo de exclusões validada.');
}

// (Teste de sessões do Modo Demonstração removido: o modo demo foi descontinuado.)

// Teste 7: Normalizador do cliente DJEN
{
  console.log('Teste 7: Normalizador de dados do DJEN...');
  const raw = {
    id: 887766,
    data_disponibilizacao: '2026-10-15',
    siglaTribunal: 'TRT18',
    tipoComunicacao: 'Intimação',
    nomeOrgao: 'Vara do Trabalho',
    texto: 'Intimação para audiência',
    numeroprocessocommascara: '0010000-00.2024.5.18.0001',
    nomeClasse: 'Ação Trabalhista',
    meio: 'DJEN',
    hash: 'abc123hash',
  };

  const norm = DjenClient.normalizarItemDjen(raw as any);
  assert.strictEqual(norm.comunicacao_id, 887766);
  assert.strictEqual(norm.sigla_tribunal, 'TRT18');
  assert.strictEqual(norm.numero_processo_mascara, '0010000-00.2024.5.18.0001');
  assert.strictEqual(norm.status_revisao, 'A revisar');
  assert.strictEqual(norm.providencia, 'A definir');
  console.log('✓ Normalizador DJEN validado.');
}

console.log('--- TODOS OS TESTES PASSARAM COM SUCESSO! ---');
