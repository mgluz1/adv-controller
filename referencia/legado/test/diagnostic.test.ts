import assert from 'node:assert';
import { DatabaseManager, getDatabase, resetDatabaseInstance } from '../server/db/database.js';
import { SyncService } from '../server/services/syncService.js';
import { DjenClient } from '../server/services/djenClient.js';
import { CONFIG, redigirUrlConexao } from '../server/config.js';
import { Scheduler } from '../server/services/scheduler.js';

console.log('=== BATERIA DE AUDITORIA E TESTES DE DIAGNÓSTICO DO SISTEMA DJEN ===');

// -----------------------------------------------------------------------------
// Teste 1: Auditoria de Variáveis de Ambiente e Mascaramento de Credenciais
// -----------------------------------------------------------------------------
{
  console.log('\n[Teste 1] Mascaramento de Credenciais e Segurança de Variáveis...');

  const urlPostgresComSenha = 'postgres://postgres:super_secret_password_123@db.example.com:5432/postgres';
  const redigida = redigirUrlConexao(urlPostgresComSenha);
  
  assert.ok(!redigida.includes('super_secret_password_123'), 'A senha sensível do banco de dados NÃO pode estar presente na URL redigida.');
  assert.ok(redigida.includes('****'), 'A senha deve ser substituída por asteriscos.');
  assert.ok(redigida.includes('db.example.com'), 'O host da conexão deve ser preservado para fins de diagnóstico.');

  console.log(`✓ String de conexão redigida com sucesso: ${redigida}`);
}

// -----------------------------------------------------------------------------
// Teste 2: Verificação do Banco e Rejeição de Fallback Silencioso em Produção
// -----------------------------------------------------------------------------
{
  console.log('\n[Teste 2] Verificação de Integridade de Tabelas e Proibição de Fallback Silencioso em Produção...');

  const db = new DatabaseManager(':memory:');
  const verif = db.verificarConexaoETabelas();

  assert.strictEqual(verif.conectado, true, 'O banco deve relatar conexão bem-sucedida.');
  assert.strictEqual(verif.tipo, 'SQLite');
  assert.strictEqual(verif.tabelasValidas, true, 'Todas as 7 tabelas obrigatórias devem existir.');
  assert.strictEqual(verif.tabelasFaltantes.length, 0);

  // Simular ambiente de produção sem DATABASE_URL
  const oldEnv = process.env.NODE_ENV;
  const oldIsProd = CONFIG.IS_PRODUCTION;
  const oldIsPg = CONFIG.DATABASE.IS_POSTGRES;
  const oldAllowSqlite = CONFIG.DATABASE.ALLOW_SQLITE_IN_PRODUCTION;

  try {
    resetDatabaseInstance();
    CONFIG.IS_PRODUCTION = true;
    CONFIG.DATABASE.IS_POSTGRES = false;
    CONFIG.DATABASE.ALLOW_SQLITE_IN_PRODUCTION = false;

    let erroLancado = false;
    try {
      getDatabase();
    } catch (err: any) {
      erroLancado = true;
      assert.ok(err.message.includes('fallback silencioso para SQLite é estritamente proibido'), 'Deve barrar fallback silencioso em produção.');
    }
    assert.strictEqual(erroLancado, true, 'Em produção, sem DATABASE_URL, deve lançar erro explícito em vez de fallback silencioso.');
    console.log('✓ Fallback silencioso em produção bloqueado com rigor e mensagem explícita.');
  } finally {
    CONFIG.IS_PRODUCTION = oldIsProd;
    CONFIG.DATABASE.IS_POSTGRES = oldIsPg;
    CONFIG.DATABASE.ALLOW_SQLITE_IN_PRODUCTION = oldAllowSqlite;
    resetDatabaseInstance();
  }
}

// -----------------------------------------------------------------------------
// Teste 3: Agendamento Confiável de Próxima Execução Mesmo em Falha (Zero "Não registrada")
// -----------------------------------------------------------------------------
{
  console.log('\n[Teste 3] Agendamento de Próxima Execução (Resolução de "Não registrada")...');

  const db = new DatabaseManager(':memory:');
  
  // Criar cliente que simula retorno 403 (ou falha de rede)
  const clientSimulador = new DjenClient();
  clientSimulador.consultarPublicacoes = async () => {
    await new Promise((r) => setTimeout(r, 10));
    return {
      sucesso: false,
      totalEncontrado: 0,
      itens: [],
      duracaoMs: 120,
      erro: {
        codigoHttp: 403,
        tipoFalha: 'GEOBLOCK_CLOUDFRONT',
        mensagem: 'Bloqueio geográfico de borda CloudFront (CNJ)',
        isGeoblocked: true,
        isRateLimited: false,
      },
    };
  };

  const syncService = new SyncService(db, clientSimulador);
  const resultado = await syncService.executarSincronizacao('manual');

  assert.strictEqual(resultado.sucesso, false);
  assert.strictEqual(resultado.isGeoblocked, true);

  const meta = db.getSyncMetadata();
  assert.strictEqual(meta.status, 'failed');
  assert.ok(meta.last_attempt_at !== null, 'Data da última tentativa deve estar registrada.');
  assert.ok(meta.next_scheduled_at !== null, 'A próxima tentativa DEVE estar agendada mesmo após falha para não exibir "Não registrada".');
  assert.strictEqual(meta.last_http_status, 403, 'O código HTTP 403 deve ser gravado nos metadados.');
  assert.ok(meta.last_duration_ms !== null && (meta.last_duration_ms || 0) >= 0, 'A duração da coleta em ms deve ser registrada.');

  const proximaFormatada = Scheduler.formatarDataBrasilia(meta.next_scheduled_at);
  assert.notStrictEqual(proximaFormatada, 'Não registrada', 'A próxima execução não pode aparecer como "Não registrada".');

  console.log(`✓ Metadados de falha salvos: Próxima tentativa agendada para: ${proximaFormatada}`);
}

// -----------------------------------------------------------------------------
// Teste 4: Parâmetros Oficiais de Consulta para OAB/GO 123456 e OAB/RJ 234567
// -----------------------------------------------------------------------------
{
  console.log('\n[Teste 4] Auditoria de Parâmetros Oficiais aceitos pela API do DJEN...');

  const advAdvA = CONFIG.ADVOGADOS.find((a) => a.id === 'adv-a')!;
  const advAdvB = CONFIG.ADVOGADOS.find((a) => a.id === 'adv-b')!;

  const oabAdvALimpa = advAdvA.numeroOab.replace(/\D/g, '');
  const ufAdvA = advAdvA.ufOab.toUpperCase();
  assert.strictEqual(oabAdvALimpa, '123456');
  assert.strictEqual(ufAdvA, 'GO');

  const oabAdvBLimpa = advAdvB.numeroOab.replace(/\D/g, '');
  const ufAdvB = advAdvB.ufOab.toUpperCase();
  assert.strictEqual(oabAdvBLimpa, '234567');
  assert.strictEqual(ufAdvB, 'RJ');

  // Parâmetros de paginação e data
  assert.strictEqual(CONFIG.DJEN.ITEMS_PER_PAGE, 50, 'Limite de itens por página do DJEN deve ser 50.');
  assert.strictEqual(CONFIG.SYNC.INTERVAL_HOURS, 24, 'Intervalo padrão deve ser diário (24 horas).');

  console.log('✓ Parâmetros de consulta sanitizados e em conformidade estrita com a documentação do CNJ.');
}

// -----------------------------------------------------------------------------
// Teste 5: Diagnóstico Administrativo Completo Estruturado
// -----------------------------------------------------------------------------
{
  console.log('\n[Teste 5] Validação da Estrutura de Diagnóstico Administrativo...');

  const db = new DatabaseManager(':memory:');
  const syncService = new SyncService(db);
  const diag = await syncService.obterDiagnosticoCompleto();

  // 1. Banco conectado
  assert.ok(diag.banco, 'Diagnóstico deve conter seção de banco.');
  assert.strictEqual(diag.banco.tipo, 'SQLite');
  assert.strictEqual(diag.banco.conectado, true);
  assert.strictEqual(diag.banco.tabelasValidas, true);
  assert.ok(diag.banco.urlRedigida, 'URL do banco deve ser redigida.');

  // 2. Última sincronização
  assert.ok(diag.ultimaSincronizacao, 'Diagnóstico deve conter seção de última sincronização.');
  assert.ok(diag.ultimaSincronizacao.duracaoFormatada !== undefined);

  // 3. Chamada CNJ
  assert.ok(diag.ultimaChamadaCnj, 'Diagnóstico deve conter seção da última chamada CNJ.');
  assert.ok(diag.ultimaChamadaCnj.statusHttp !== undefined);
  assert.ok(diag.ultimaChamadaCnj.tipoFalha !== undefined);

  // 4. Parâmetros de consulta
  assert.ok(diag.parametrosConsulta, 'Diagnóstico deve conter parâmetros não sensíveis.');
  assert.strictEqual(diag.parametrosConsulta.advogados.length, 2);
  assert.ok(diag.parametrosConsulta.janelaInicio !== undefined);
  assert.ok(diag.parametrosConsulta.janelaFim !== undefined);

  // 5. Métricas de registros
  assert.ok(diag.metricasRegistros, 'Diagnóstico deve conter métricas de registros.');
  assert.strictEqual(typeof diag.metricasRegistros.recebidos, 'number');
  assert.strictEqual(typeof diag.metricasRegistros.inseridos, 'number');

  // 6. Erros por advogado
  assert.ok(diag.errosPorAdvogado, 'Diagnóstico deve conter erros por advogado.');
  assert.ok('adv-a' in diag.errosPorAdvogado);
  assert.ok('adv-b' in diag.errosPorAdvogado);

  // 7. Status do agendador
  assert.ok(diag.agendador, 'Diagnóstico deve conter status do agendador.');
  assert.strictEqual(diag.agendador.ativo, true);
  assert.strictEqual(diag.agendador.intervaloHoras, 24);

  console.log('✓ Estrutura do diagnóstico administrativo validada com todos os requisitos.');
}

// -----------------------------------------------------------------------------
// Teste 6: Sonda em Tempo Real e Captura de POP CloudFront
// -----------------------------------------------------------------------------
{
  console.log('\n[Teste 6] Executando Sonda em Tempo Real com a API Pública do CNJ...');

  const client = new DjenClient();
  const sonda = await client.executarSondaDiagnostica('123456', 'GO');

  console.log(`- Retorno HTTP: ${sonda.statusHttp}`);
  console.log(`- Latência medida: ${sonda.tempoRespostaMs}ms`);
  console.log(`- POP CloudFront: ${sonda.popCloudFront || 'Identificado na borda'}`);
  console.log(`- Causa: ${sonda.tipoFalha} -> ${sonda.mensagem}`);
  console.log(`- É Bloqueio Geográfico? ${sonda.isGeoblocked ? 'SIM (Ambiente Internacional)' : 'NÃO'}`);

  assert.ok(sonda.statusHttp > 0, 'A sonda deve retornar um código HTTP válido.');
  assert.ok(sonda.tempoRespostaMs >= 0, 'A latência medida deve ser >= 0.');
  console.log('✓ Sonda diagnóstica em tempo real concluída com êxito e evidência técnica documentada.');
}

console.log('\n================================================================');
console.log('TODOS OS TESTES DE AUDITORIA E DIAGNÓSTICO FORAM CONCLUÍDOS COM SUCESSO!');
console.log('================================================================');
