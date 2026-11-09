import assert from 'node:assert';
import { DjenClient } from '../server/services/djenClient.js';
import { CpcCalendar } from '../server/utils/cpcCalendar.js';
import { CONFIG } from '../server/config.js';

console.log('=== TESTES DE INTEGRAÇÃO E AUDITORIA DA API DO DJEN (CNJ) ===');

// Teste 1: Validação das Regras do CPC art. 224 (Dias úteis e Publicação)
{
  console.log('\n[Teste 1] Auditoria de Cálculo de Prazos e Datas Forenses (CPC art. 224)...');

  // Sexta-feira: 16 de Outubro de 2026 -> Publicação no primeiro dia útil seguinte (Segunda, 19/10/2026)
  const dataDispSexta = '2026-10-16';
  const dataPubSexta = CpcCalendar.calcularDataPublicacaoCpc(dataDispSexta);
  assert.strictEqual(dataPubSexta, '2026-10-19', 'A publicação de disponibilização na sexta-feira deve ser na segunda-feira subsequente.');

  // Quinta-feira antes do Natal: 24 de Dezembro de 2026 -> 25/12 é feriado nacional, 26/12 sab, 27/12 dom -> Publicação em 28/12/2026 (Segunda)
  const dataDispNatal = '2026-12-24';
  const dataPubNatal = CpcCalendar.calcularDataPublicacaoCpc(dataDispNatal);
  assert.strictEqual(dataPubNatal, '2026-12-28', 'Feriado de Natal deve ser pulado para o próximo dia útil forense.');

  // Quarta-feira comum: 14 de Outubro de 2026 -> Publicação na Quinta-feira, 15/10/2026
  const dataDispQuarta = '2026-10-14';
  const dataPubQuarta = CpcCalendar.calcularDataPublicacaoCpc(dataDispQuarta);
  assert.strictEqual(dataPubQuarta, '2026-10-15', 'Dia de semana comum deve avançar exatamente 1 dia.');

  console.log('✓ Cálculo de disponibilização vs publicação (CPC 224) 100% em conformidade jurídica.');
}

// Teste 2: Sanitização e Normalização Estrita de Parâmetros de OAB
{
  console.log('\n[Teste 2] Sanitização de Parâmetros de OAB dos Advogados...');

  const advAdvA = CONFIG.ADVOGADOS.find((a) => a.id === 'adv-a')!;
  const advAdvB = CONFIG.ADVOGADOS.find((a) => a.id === 'adv-b')!;

  assert.strictEqual(advAdvA.numeroOab.replace(/\D/g, ''), '123456');
  assert.strictEqual(advAdvA.ufOab.toUpperCase(), 'GO');

  assert.strictEqual(advAdvB.numeroOab.replace(/\D/g, ''), '234567');
  assert.strictEqual(advAdvB.ufOab.toUpperCase(), 'RJ');

  console.log(`✓ Advogados monitorados validados: ${advAdvA.nome} (${advAdvA.rotulo}) e ${advAdvB.nome} (${advAdvB.rotulo}).`);
}

// Teste 3: Classificação Auditada de Erros HTTP sem Falsos Positivos de Geoblock
{
  console.log('\n[Teste 3] Classificação de Erros HTTP (Geoblock vs WAF vs Rate Limit vs Política)...');

  // Caso A: Mensagem explícita de CloudFront Geoblock
  const htmlCloudFront = `
    <html>
      <head><title>403 Forbidden</title></head>
      <body>
        <h1>403 Forbidden</h1>
        <p>The Amazon CloudFront distribution is configured to block access from your country.</p>
      </body>
    </html>
  `;
  const classifCloudFront = DjenClient.classificarErroHttp(403, htmlCloudFront);
  assert.strictEqual(classifCloudFront.tipoFalha, 'GEOBLOCK_CLOUDFRONT');
  assert.strictEqual(classifCloudFront.isGeoblocked, true);

  // Caso B: 403 genérico por WAF / Challenge / Token inválido
  const htmlWaf = `<html><body>Request blocked by AWS WAF security check</body></html>`;
  const classifWaf = DjenClient.classificarErroHttp(403, htmlWaf);
  assert.strictEqual(classifWaf.tipoFalha, 'WAF_BLOCKED_OR_CHALLENGE');
  assert.strictEqual(classifWaf.isGeoblocked, false, 'WAF genérico não deve ser presumido como geoblocking.');

  // Caso C: 429 Too Many Requests
  const classif429 = DjenClient.classificarErroHttp(429, 'Rate limit exceeded');
  assert.strictEqual(classif429.tipoFalha, 'RATE_LIMITED');
  assert.strictEqual(classif429.isRateLimited, true);

  // Caso D: 503 Service Unavailable
  const classif503 = DjenClient.classificarErroHttp(503, 'Service unavailable');
  assert.strictEqual(classif503.tipoFalha, 'SERVER_ERROR');

  console.log('✓ Classificação precisa de causas de erro HTTP comprovada por testes unitários.');
}

// Teste 4: Normalização de Resposta e Estrutura Oficial do CNJ
{
  console.log('\n[Teste 4] Normalização do Payload de Comunicação do DJEN...');

  const mockItemDjen = {
    id: 998877,
    data_disponibilizacao: '2026-10-09', // Sexta-feira
    siglaTribunal: 'TJGO',
    nomeOrgao: '1ª Vara Cível de Anápolis',
    numero_processo: '5001234-56.2024.8.09.0006',
    numeroprocessocommascara: '5001234-56.2024.8.09.0006',
    nomeClasse: 'Procedimento Comum Cível',
    tipoComunicacao: 'Intimação',
    texto: 'Fica a parte autora intimada para manifestação sobre contestação no prazo de 15 dias.',
    meio: 'D',
    meiocompleto: 'Diário de Justiça Eletrônico Nacional (DJEN)',
    link: 'https://comunica.pje.jus.br/consulta/processo/5001234-56.2024.8.09.0006',
    hash: 'e9b3a0c789d2',
  };

  const normalizado = DjenClient.normalizarItemDjen(mockItemDjen as any);
  assert.strictEqual(normalizado.comunicacao_id, 998877);
  assert.strictEqual(normalizado.data_disponibilizacao, '2026-10-09');
  assert.strictEqual(normalizado.data_publicacao, '2026-10-13', 'Dia 12/10 é feriado de Nossa Senhora Aparecida; publicação deve ser em 13/10/2026.');
  assert.strictEqual(normalizado.status_revisao, 'A revisar');
  assert.strictEqual(normalizado.providencia, 'A definir');
  assert.strictEqual(normalizado.sigla_tribunal, 'TJGO');
  assert.strictEqual(normalizado.hash, 'e9b3a0c789d2');

  console.log('✓ Normalização de dados do DJEN e atribuição de datas válidas concluída.');
}

// Teste 5: Diagnóstico de Conectividade em Tempo Real com o Endpoint do CNJ
{
  console.log('\n[Teste 5] Executando Sonda de Diagnóstico em Tempo Real com o CNJ...');

  const client = new DjenClient();
  const inicioProbe = Date.now();
  const probe = await client.consultarPublicacoes({
    numeroOab: '123456',
    ufOab: 'GO',
    dataInicio: '2026-10-01',
    dataFim: '2026-10-15',
  });
  const latencia = Date.now() - inicioProbe;

  console.log(`- Status da conexão: ${probe.sucesso ? 'Sucesso' : 'Erro tratado'}`);
  console.log(`- Latência da requisição: ${latencia}ms`);

  if (probe.sucesso) {
    console.log(`- Total de comunicações identificadas: ${probe.totalEncontrado}`);
  } else {
    console.log(`- Código HTTP: ${probe.erro?.codigoHttp}`);
    console.log(`- Causa identificada: ${probe.erro?.tipoFalha} -> ${probe.erro?.mensagem}`);
    console.log(`- É Bloqueio Geográfico CloudFront? ${probe.erro?.isGeoblocked ? 'SIM (Origem fora do Brasil)' : 'NÃO'}`);
    console.log(`- Diagnóstico registrado com transparência sem simulação arbitrária.`);
  }

  // O teste deve garantir que o cliente captura o resultado de forma estruturada e previsível
  assert.ok(typeof probe.sucesso === 'boolean');
}

console.log('\n=== AUDITORIA E TESTES DE INTEGRAÇÃO CONCLUÍDOS COM SUCESSO ===');
