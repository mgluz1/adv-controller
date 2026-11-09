import { CONFIG } from '../config.js';
import { getDatabase } from '../db/database.js';
import { getSyncService } from './syncService.js';

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs = 5 * 60 * 1000; // Checagem a cada 5 minutos

  public iniciar() {
    console.log(`[Scheduler] Inicializando agendador interno (ciclos de ${CONFIG.SYNC.INTERVAL_HOURS} horas)...`);

    // 1. Checagem inicial na inicialização do servidor
    this.verificarExecucaoPendente().catch((err) => {
      console.error('[Scheduler] Erro na verificação inicial:', err);
    });

    // 2. Loop de checagem periódica
    this.timer = setInterval(() => {
      this.verificarExecucaoPendente().catch((err) => {
        console.error('[Scheduler] Erro no ciclo de checagem:', err);
      });
    }, this.checkIntervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public parar() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Verifica se há coleta agendada pendente ou vencida e a dispara com resiliência.
   */
  public async verificarExecucaoPendente() {
    const db = getDatabase();
    const meta = await db.getSyncMetadata();
    const syncService = getSyncService();

    if (syncService.isBusy()) {
      return;
    }

    const agora = new Date();

    // Se nunca foi executada nenhuma tentativa no sistema
    if (!meta.last_attempt_at) {
      console.log(`[Scheduler] Nenhuma tentativa registrada. Iniciando primeira coleta no DJEN...`);
      try {
        await syncService.executarSincronizacao('automatico');
      } catch (err: any) {
        console.warn('[Scheduler] Primeira coleta automática finalizou com aviso:', err.message);
      }
      return;
    }

    // Se não há próximo agendamento definido, calcular um agendamento válido
    if (!meta.next_scheduled_at) {
      const proximaPrevisao = new Date(agora);
      if (meta.status === 'failed') {
        proximaPrevisao.setMinutes(proximaPrevisao.getMinutes() + CONFIG.SYNC.RETRY_INTERVAL_MINUTES);
      } else {
        proximaPrevisao.setHours(proximaPrevisao.getHours() + CONFIG.SYNC.INTERVAL_HOURS);
      }
      await db.updateSyncMetadata({ next_scheduled_at: proximaPrevisao.toISOString() });
      return;
    }

    // Se há um horário agendado que já passou
    const dataAgendada = new Date(meta.next_scheduled_at);
    if (agora >= dataAgendada) {
      console.log(`[Scheduler] Horário agendado atingido (${meta.next_scheduled_at}). Iniciando coleta periódica...`);
      try {
        await syncService.executarSincronizacao('automatico');
      } catch (err: any) {
        console.warn('[Scheduler] Coleta periódica automática finalizou com aviso:', err.message);
      }
    }
  }

  /**
   * Formata uma data ISO no padrão brasileiro com fuso America/Sao_Paulo
   */
  public static formatarDataBrasilia(dataIso?: string | null): string {
    if (!dataIso) return 'Não registrada';
    try {
      const d = new Date(dataIso);
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: CONFIG.TIMEZONE,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d) + ' (Horário de Brasília)';
    } catch {
      return dataIso;
    }
  }
}

let schedulerInstance: Scheduler | null = null;
export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}
