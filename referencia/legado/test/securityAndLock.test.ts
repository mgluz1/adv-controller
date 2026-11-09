import assert from 'node:assert';
import { DatabaseManager } from '../server/db/database.js';
import { SyncService } from '../server/services/syncService.js';

console.log('=== TESTES DE SEGURANÇA, AUDITORIA E TRAVA DISTRIBUÍDA ===');

// (Teste de tokens HMAC removido: a autenticação será feita pelo Better Auth.)

// Teste 2: Registro e Listagem de Auditoria
{
  console.log('\n[Teste 2] Registro e Consulta de Logs de Auditoria de Operações...');

  const db = new DatabaseManager(':memory:');

  db.registrarAuditLog({
    usuario: 'Advogada Exemplo A',
    acao: 'STATUS_UPDATE',
    recurso_id: '5001',
    detalhes: JSON.stringify({ de: 'A revisar', para: 'Concluído', providencia: 'Recurso protocolado' }),
    ip: '192.168.1.100',
  });

  db.registrarAuditLog({
    usuario: 'Advogado Exemplo B',
    acao: 'DELETE_BATCH',
    detalhes: JSON.stringify({ dataCorte: '2026-08-01', totalRemovidos: 12 }),
    ip: '192.168.1.101',
  });

  const logs = db.listarAuditLogs(10);
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(logs[0].acao, 'DELETE_BATCH');
  assert.strictEqual(logs[0].usuario, 'Advogado Exemplo B');
  assert.strictEqual(logs[1].acao, 'STATUS_UPDATE');

  console.log('✓ Trilha de auditoria persistente validada com sucesso.');
}

// Teste 3: Trava Concorrente Distribuída com Expiração (Lease Lock)
{
  console.log('\n[Teste 3] Controle de Concorrência Distribuído (Distributed Lease Lock)...');

  const db = new DatabaseManager(':memory:');

  // Processo A adquire o lock por 500ms
  const lockA = db.adquirirLock('sync_djen', 'process-worker-A', 500);
  assert.strictEqual(lockA, true, 'Primeiro processo deve obter o lock.');

  // Processo B tenta adquirir o mesmo lock simultaneamente -> DEVE FALHAR
  const lockB = db.adquirirLock('sync_djen', 'process-worker-B', 500);
  assert.strictEqual(lockB, false, 'Segundo processo concorrente deve ser impedido de executar.');

  // Processo A conclui e libera o lock
  const liberado = db.liberarLock('sync_djen', 'process-worker-A');
  assert.strictEqual(liberado, true, 'Processo A deve conseguir liberar seu lock.');

  // Agora Processo B deve conseguir adquirir
  const lockB2 = db.adquirirLock('sync_djen', 'process-worker-B', 500);
  assert.strictEqual(lockB2, true, 'Processo B deve obter o lock após liberação.');

  console.log('✓ Trava persistente distribuída impede execuções concorrentes duplicadas.');
}

// Teste 4: Cálculo e Recuperação de Lacunas (Gap Recovery) na Sincronização
{
  console.log('\n[Teste 4] Identificação de Períodos Não Coletados e Recuperação de Lacunas...');

  const db = new DatabaseManager(':memory:');
  const syncService = new SyncService(db);

  // Caso 1: Primeira execução (sem histórico) -> Últimos 30 dias
  const janelaInicial = syncService.calcularJanelaConsulta(null, null);
  const hoje = new Date();
  const d30 = new Date(hoje);
  d30.setDate(d30.getDate() - 30);
  const d30Formatado = SyncService.formatDateYMD(d30);
  assert.strictEqual(janelaInicial.inicio, d30Formatado, 'Primeira consulta deve cobrir exatamente os últimos 30 dias.');

  // Caso 2: Servidor ficou offline por 6 dias (última janela terminou em 2026-10-10)
  // Com sobreposição de 4 dias, deve recuar para 2026-10-06 para cobrir toda a lacuna
  const janelaRecuperacao = syncService.calcularJanelaConsulta('2026-10-10T12:00:00Z', '2026-10-10');
  assert.strictEqual(janelaRecuperacao.inicio, '2026-10-06', 'Recuperação deve retroagir para cobrir lacunas com sobreposição.');

  console.log('✓ Cálculo de lacunas e recuperação pós-interrupção validado.');
}

console.log('\n=== TODOS OS TESTES DE SEGURANÇA E LOCK PASSARAM COM SUCESSO ===');
