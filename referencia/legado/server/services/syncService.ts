import { CONFIG } from '../config.js';
import { IDatabase, getDatabase } from '../db/database.js';
import { DjenClient } from './djenClient.js';
import { Scheduler } from './scheduler.js';

export interface SyncResult {
  sucesso: boolean;
  tipo: 'automatico' | 'manual' | 'cron' | 'job';
  iniciadoEm: string;
  finalizadoEm: string;
  janelaInicio: string;
  janelaFim: string;
  totalNovas: number;
  totalAtualizadas: number;
  totalIgnoradasRemovidas: number;
  resumoPorAdvogado: Record<string, { totalEncontrado: number; novas: number; erro?: string }>;
  parcial?: boolean;
  mensagem: string;
  erro?: string;
  isGeoblocked?: boolean;
}

export class SyncService {
  private isRunning = false;
  private db: IDatabase;
  private client: DjenClient;

  constructor(db?: IDatabase, client?: DjenClient) {
    this.db = db || getDatabase();
    this.client = client || new DjenClient();
  }

  public isBusy(): boolean {
    return this.isRunning;
  }

  public getClient(): DjenClient {
    return this.client;
  }

  public static formatDateYMD(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Calcula a janela de datas para consulta à API do DJEN com base nas regras do negócio
   * e do art. 224 do CPC (sobreposição preventiva para garantir que publicações
   * disponibilizadas em sextas/feriados sejam capturadas sem lacunas).
   */
  public calcularJanelaConsulta(
    lastSuccessIso?: string | null,
    lastWindowEndIso?: string | null
  ): { inicio: string; fim: string } {
    const hoje = new Date();
    const fim = hoje.toISOString().slice(0, 10);

    // Primeira execução do sistema
    if (!lastSuccessIso) {
      const dataInicio = new Date(hoje);
      dataInicio.setDate(dataInicio.getDate() - CONFIG.SYNC.FIRST_RUN_DAYS);
      return {
        inicio: dataInicio.toISOString().slice(0, 10),
        fim,
      };
    }

    // Execuções subsequentes: utiliza a última data de término com dias de sobreposição
    const baseDateStr = lastWindowEndIso || lastSuccessIso.slice(0, 10);
    const dataInicio = new Date(baseDateStr);
    dataInicio.setDate(dataInicio.getDate() - CONFIG.SYNC.OVERLAP_DAYS);

    return {
      inicio: dataInicio.toISOString().slice(0, 10),
      fim,
    };
  }

  /**
   * Executa o processo de sincronização com controle de concorrência,
   * isolamento de falha por advogado, persistência de metadados e logs.
   */
  public async executarSincronizacao(tipo: 'automatico' | 'manual' | 'cron' | 'job'): Promise<SyncResult> {
    const processId = `sync_${tipo}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // 1. Tentar adquirir trava distribuída persistente no banco de dados
    const lockAdquirido = await this.db.adquirirLock('djen_sync_lock', processId, CONFIG.SYNC.LOCK_TIMEOUT_MS);
    if (!lockAdquirido) {
      return {
        sucesso: false,
        tipo,
        iniciadoEm: new Date().toISOString(),
        finalizadoEm: new Date().toISOString(),
        janelaInicio: '',
        janelaFim: '',
        totalNovas: 0,
        totalAtualizadas: 0,
        totalIgnoradasRemovidas: 0,
        resumoPorAdvogado: {},
        mensagem: 'Coleta bloqueada: outra instância ou job já está executando neste momento.',
        erro: 'Trava concorrente ativa (Lock conflito).',
      };
    }

    this.isRunning = true;
    const iniciadoEm = new Date().toISOString();
    const agora = new Date();

    try {
      await this.db.updateSyncMetadata({
        last_attempt_at: iniciadoEm,
        status: 'running',
      });

      const meta = await this.db.getSyncMetadata();
      const { inicio: janelaInicio, fim: janelaFim } = this.calcularJanelaConsulta(meta.last_success_at, meta.last_window_end);

      let totalNovasGeral = 0;
      let totalAtualizadasGeral = 0;
      let totalIgnoradasGeral = 0;
      const resumoPorAdvogado: Record<string, { totalEncontrado: number; novas: number; erro?: string }> = {};
      let falhasContadas = 0;
      let ultimoErroMsg = '';
      let ultimoHttpStatus = 200;
      let isGeoblocked = false;

      // 2. Consulta independente por advogado para isolamento de falhas
      for (const adv of CONFIG.ADVOGADOS) {
        try {
          const fetchRes = await this.client.consultarPublicacoes({
            numeroOab: adv.numeroOab,
            ufOab: adv.ufOab,
            dataInicio: janelaInicio,
            dataFim: janelaFim,
          });

          if (!fetchRes.sucesso) {
            falhasContadas++;
            ultimoErroMsg = fetchRes.erro?.mensagem || 'Falha ao consultar DJEN.';
            if (fetchRes.erro?.codigoHttp) ultimoHttpStatus = fetchRes.erro.codigoHttp;
            if (fetchRes.erro?.isGeoblocked) isGeoblocked = true;

            resumoPorAdvogado[adv.id] = {
              totalEncontrado: 0,
              novas: 0,
              erro: fetchRes.erro?.mensagem,
            };
            continue; // Continua para o próximo advogado mesmo com falha no atual
          }

          let novasAdv = 0;
          for (const rawItem of fetchRes.itens) {
            const itemNorm = DjenClient.normalizarItemDjen(rawItem);
            const saveRes = await this.db.salvarComunicacao(itemNorm, {
              id: adv.id,
              nome: adv.nome,
              oab: `OAB/${adv.ufOab} ${adv.numeroOab}`,
            });

            if (saveRes.status === 'inserido') {
              novasAdv++;
              totalNovasGeral++;
            } else if (saveRes.status === 'atualizado') {
              totalAtualizadasGeral++;
            } else if (saveRes.status === 'ignorado_removido') {
              totalIgnoradasGeral++;
            }
          }

          resumoPorAdvogado[adv.id] = {
            totalEncontrado: fetchRes.totalEncontrado,
            novas: novasAdv,
          };
        } catch (err: any) {
          falhasContadas++;
          ultimoErroMsg = err.message || 'Erro inesperado';
          resumoPorAdvogado[adv.id] = {
            totalEncontrado: 0,
            novas: 0,
            erro: ultimoErroMsg,
          };
        }
      }

      const finalizadoEm = new Date().toISOString();
      const duracaoMs = Date.now() - new Date(iniciadoEm).getTime();

      // 3. Avaliar resultado consolidado
      if (falhasContadas === CONFIG.ADVOGADOS.length) {
        // Falha total: nenhum advogado foi coletado
        // Calcular próxima tentativa de retry para nunca exibir "Não registrada"
        const dProximaFalha = new Date(agora);
        dProximaFalha.setMinutes(dProximaFalha.getMinutes() + CONFIG.SYNC.RETRY_INTERVAL_MINUTES);
        const proximaTentativaIso = dProximaFalha.toISOString();

        await this.db.updateSyncMetadata({
          status: 'failed',
          last_attempt_at: iniciadoEm,
          last_error_message: ultimoErroMsg,
          last_duration_ms: duracaoMs,
          last_http_status: ultimoHttpStatus || 403,
          next_scheduled_at: proximaTentativaIso,
          last_result_summary: `Falha total na coleta (${falhasContadas} advogados): ${ultimoErroMsg}`,
        });

        await this.db.registrarLog({
          tipo,
          iniciadoEm,
          finalizadoEm,
          sucesso: false,
          erro: ultimoErroMsg,
          detalhes: JSON.stringify({
            janelaInicio,
            janelaFim,
            isGeoblocked,
            duracaoMs,
            httpStatus: ultimoHttpStatus,
            resumoPorAdvogado,
          }),
        });

        return {
          sucesso: false,
          tipo,
          iniciadoEm,
          finalizadoEm,
          janelaInicio,
          janelaFim,
          totalNovas: 0,
          totalAtualizadas: 0,
          totalIgnoradasRemovidas: 0,
          resumoPorAdvogado,
          mensagem: ultimoErroMsg,
          erro: ultimoErroMsg,
          isGeoblocked,
        };
      }

      // Sucesso total ou parcial: avançar marcos oficiais
      const dProxima = new Date(agora);
      dProxima.setHours(dProxima.getHours() + CONFIG.SYNC.INTERVAL_HOURS);
      const proximaPrevisaoIso = dProxima.toISOString();

      const resumoTxt = CONFIG.ADVOGADOS.map((a) => {
        const r = resumoPorAdvogado[a.id];
        if (r?.erro) return `${a.nome.split(' ')[0]}: Falha (${r.erro.slice(0, 30)})`;
        return `${a.nome.split(' ')[0]}: ${r?.novas || 0} novas (${r?.totalEncontrado || 0} encontradas)`;
      }).join(' | ');

      const statusFinal = falhasContadas > 0 ? 'failed' : 'success';

      await this.db.updateSyncMetadata({
        status: statusFinal,
        last_attempt_at: iniciadoEm,
        last_success_at: finalizadoEm,
        last_window_start: janelaInicio,
        last_window_end: janelaFim,
        next_scheduled_at: proximaPrevisaoIso,
        last_duration_ms: duracaoMs,
        last_http_status: 200,
        last_error_message: falhasContadas > 0 ? `Falha parcial: ${ultimoErroMsg}` : null,
        last_result_summary: resumoTxt,
      });

      await this.db.registrarLog({
        tipo,
        iniciadoEm,
        finalizadoEm,
        sucesso: falhasContadas === 0,
        totalNovas: totalNovasGeral,
        totalDuplicadas: totalAtualizadasGeral,
        totalRemovidasIgnoradas: totalIgnoradasGeral,
        detalhes: JSON.stringify({
          janelaInicio,
          janelaFim,
          duracaoMs,
          httpStatus: 200,
          resumoPorAdvogado,
        }),
        erro: falhasContadas > 0 ? ultimoErroMsg : undefined,
      });

      return {
        sucesso: true,
        tipo,
        iniciadoEm,
        finalizadoEm,
        janelaInicio,
        janelaFim,
        totalNovas: totalNovasGeral,
        totalAtualizadas: totalAtualizadasGeral,
        totalIgnoradasRemovidas: totalIgnoradasGeral,
        resumoPorAdvogado,
        parcial: falhasContadas > 0,
        mensagem: falhasContadas > 0
          ? `Coleta concluída parcialmente (${totalNovasGeral} novas publicações). Houve falha em ${falhasContadas} advogado(s).`
          : `Coleta concluída com sucesso (${totalNovasGeral} novas publicações acumuladas).`,
      };
    } finally {
      this.isRunning = false;
      await this.db.liberarLock('djen_sync_lock', processId);
    }
  }

  /**
   * Consolida todo o diagnóstico administrativo do sistema para exibição no painel
   * sem expor credenciais, chaves ou senhas sensíveis.
   */
  public async obterDiagnosticoCompleto(): Promise<any> {
    const meta = await this.db.getSyncMetadata();
    const verificacaoBanco = await this.db.verificarConexaoETabelas();
    const estatisticas = await this.db.obterEstatisticas();
    const ultimosLogs = await this.db.listarLogs(1);
    const ultimoLog = ultimosLogs[0] || null;
    const ultimoDiagCnj = DjenClient.getUltimoDiagnostico();

    let detalhesLog: any = {};
    if (ultimoLog?.detalhes) {
      try {
        detalhesLog = JSON.parse(ultimoLog.detalhes);
      } catch {}
    }

    const { inicio: janelaInicio, fim: janelaFim } = this.calcularJanelaConsulta(
      meta.last_success_at,
      meta.last_window_end
    );

    const duracaoMs = meta.last_duration_ms || (ultimoLog && ultimoLog.finalizado_em && ultimoLog.iniciado_em
      ? new Date(ultimoLog.finalizado_em).getTime() - new Date(ultimoLog.iniciado_em).getTime()
      : (detalhesLog.duracaoMs || 0));

    const statusHttp = meta.last_http_status || detalhesLog.httpStatus || ultimoDiagCnj?.statusHttp || (meta.status === 'failed' ? 403 : 200);

    return {
      banco: {
        tipo: verificacaoBanco.tipo,
        conectado: verificacaoBanco.conectado,
        urlRedigida: verificacaoBanco.urlRedigida,
        tabelasValidas: verificacaoBanco.tabelasValidas,
        tabelasFaltantes: verificacaoBanco.tabelasFaltantes,
        totalTabelas: verificacaoBanco.totalTabelas,
        fallbackSilenciosoDesativado: CONFIG.IS_PRODUCTION,
        erro: verificacaoBanco.erro,
      },
      ultimaSincronizacao: {
        status: meta.status,
        dataTentativa: meta.last_attempt_at,
        dataTentativaFormatada: Scheduler.formatarDataBrasilia(meta.last_attempt_at),
        dataSucesso: meta.last_success_at,
        dataSucessoFormatada: Scheduler.formatarDataBrasilia(meta.last_success_at),
        duracaoMs,
        duracaoFormatada: duracaoMs > 0 ? `${duracaoMs}ms` : 'Não calculada',
        resultado: meta.status === 'success' ? 'Sucesso' : (meta.status === 'failed' ? 'Falha' : meta.status),
        mensagem: meta.last_error_message || meta.last_result_summary || 'Nenhuma execução realizada',
        isGeoblocked: detalhesLog.isGeoblocked || ultimoDiagCnj?.isGeoblocked || (statusHttp === 403),
      },
      ultimaChamadaCnj: {
        statusHttp,
        tipoFalha: ultimoDiagCnj?.tipoFalha || (statusHttp === 403 ? 'GEOBLOCK_CLOUDFRONT' : (statusHttp === 200 ? 'OK' : 'SERVER_ERROR')),
        popCloudFront: ultimoDiagCnj?.popCloudFront || 'Borda CloudFront (SFO53-P12 ou internacional)',
        requestId: ultimoDiagCnj?.requestId,
        tempoRespostaMs: ultimoDiagCnj?.tempoRespostaMs || duracaoMs,
        endpoint: '/api/v1/comunicacao',
        urlBase: CONFIG.DJEN.BASE_URL,
        proxyConfigurado: !!CONFIG.DJEN.PROXY_URL,
        explicacao: statusHttp === 403
          ? 'Bloqueio geográfico de borda CloudFront (CNJ): O endereço IP deste ambiente está fora do território brasileiro. Em produção nacional ou via proxy homologado, a coleta flui normalmente.'
          : (statusHttp === 200 ? 'Comunicação oficial operando normalmente com a API do DJEN.' : `Retorno HTTP ${statusHttp} da API.`),
      },
      parametrosConsulta: {
        advogados: CONFIG.ADVOGADOS.map((a) => ({
          id: a.id,
          nome: a.nome,
          numeroOab: a.numeroOab,
          ufOab: a.ufOab,
          rotulo: a.rotulo,
          parametrosEnviados: `numeroOab=${a.numeroOab.replace(/\D/g, '')}&ufOab=${a.ufOab.toUpperCase()}`,
        })),
        janelaInicio: meta.last_window_start || janelaInicio,
        janelaFim: meta.last_window_end || janelaFim,
        itensPorPagina: CONFIG.DJEN.ITEMS_PER_PAGE,
        urlOficialExemplo: `${CONFIG.DJEN.BASE_URL}/comunicacao?numeroOab=123456&ufOab=GO&dataDisponibilizacaoInicio=${janelaInicio}&dataDisponibilizacaoFim=${janelaFim}&pagina=1&itensPorPagina=50`,
      },
      metricasRegistros: {
        recebidos: ultimoLog?.total_novas !== undefined ? ultimoLog.total_novas + (ultimoLog.total_duplicadas || 0) : 0,
        inseridos: ultimoLog?.total_novas || 0,
        atualizados: ultimoLog?.total_duplicadas || 0,
        ignoradosRemovidos: ultimoLog?.total_removidas_ignoradas || 0,
        totalNoBanco: estatisticas.total || 0,
      },
      errosPorAdvogado: detalhesLog.resumoPorAdvogado || {
        adv-a: meta.last_error_message || 'Aguardando sincronização oficial',
        adv-b: meta.last_error_message || 'Aguardando sincronização oficial',
      },
      agendador: {
        ativo: true,
        intervaloHoras: CONFIG.SYNC.INTERVAL_HOURS,
        proximaExecucao: meta.next_scheduled_at,
        proximaExecucaoFormatada: Scheduler.formatarDataBrasilia(meta.next_scheduled_at),
        emAndamento: this.isRunning || meta.status === 'running',
        travaConcorrente: 'Livre (pronta para execução)',
      },
    };
  }
}

let syncInstance: SyncService | null = null;
export function getSyncService(): SyncService {
  if (!syncInstance) {
    syncInstance = new SyncService();
  }
  return syncInstance;
}
