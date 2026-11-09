import assert from 'node:assert';
import { DatabaseManager } from '../server/db/database.js';

console.log('=== TESTES DE MIGRAÇÃO, EXPORTAÇÃO E INTEGRIDADE DE DADOS ===');

{
  console.log('\n[Teste 1] Exportação e Importação Íntegra de Dados entre Ambientes...');

  const dbOrigem = new DatabaseManager(':memory:');

  // Popular dbOrigem
  const pub = {
    comunicacao_id: 888001,
    sigla_tribunal: 'TJGO',
    nome_orgao: 'Vara de Família e Sucessões',
    numero_processo: '5008881-2024',
    numero_processo_mascara: '5008881-2024',
    nome_classe: 'Inventário',
    tipo_comunicacao: 'Intimação',
    texto: 'Intimação dos herdeiros para primeiras declarações.',
    meio: 'DJEN',
    data_disponibilizacao: '2026-10-10',
    data_publicacao: '2026-10-13',
    status_revisao: 'Em andamento',
    providencia: 'Apresentar plano de partilha',
    observacoes: 'Documentos do imóvel rural anexados',
    importado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };

  dbOrigem.salvarComunicacao(pub, { id: 'adv-a', nome: 'Advogada Exemplo A', oab: 'OAB/GO 123456' });
  dbOrigem.salvarComunicacao(pub, { id: 'adv-b', nome: 'Advogado Exemplo B', oab: 'OAB/RJ 234567' });

  // Inserir uma exclusão (tombstone)
  dbOrigem.salvarComunicacao({
    comunicacao_id: 888002,
    sigla_tribunal: 'TJRJ',
    numero_processo: '0008882-2024',
    data_disponibilizacao: '2026-09-01',
    status_revisao: 'A revisar',
    importado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  }, { id: 'adv-b', nome: 'Advogado Exemplo B', oab: 'OAB/RJ 234567' });

  dbOrigem.removerIndividual(888002, 'Processo extinto sem resolução');

  // Exportar dados completos
  const dump = dbOrigem.exportarDados();
  assert.strictEqual(dump.comunicacoes.length, 1);
  assert.strictEqual(dump.comunicacoes_advogados.length, 2);
  assert.strictEqual(dump.comunicacoes_removidas.length, 1);

  // Criar um novo banco de destino (simulando restauração / migração)
  const dbDestino = new DatabaseManager(':memory:');
  const resImport = dbDestino.importarDados(dump);

  assert.strictEqual(resImport.inseridos, 1);
  assert.strictEqual(resImport.advogadosVinculados, 2);
  assert.strictEqual(resImport.removidasPreservadas, 1);

  // Verificar se o banco de destino possui os dados íntegros
  const listaDestino = dbDestino.listarComunicacoes({});
  assert.strictEqual(listaDestino.total, 1);
  assert.strictEqual(listaDestino.publicacoes[0].comunicacao_id, 888001);
  assert.strictEqual(listaDestino.publicacoes[0].status_revisao, 'Em andamento');
  assert.strictEqual(listaDestino.publicacoes[0].providencia, 'Apresentar plano de partilha');
  assert.strictEqual(listaDestino.publicacoes[0].observacoes, 'Documentos do imóvel rural anexados');
  assert.strictEqual(listaDestino.publicacoes[0].advogados?.length, 2);

  // Verificar se o tombstone foi preservado no banco de destino
  assert.strictEqual(dbDestino.isRemovida(888002), true);

  console.log('✓ Exportação e restauração com fidelidade de status, notas e tombstones comprovada.');
}

console.log('\n=== TESTES DE MIGRAÇÃO E INTEGRIDADE CONCLUÍDOS COM SUCESSO ===');
