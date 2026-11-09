/**
 * Utilitário de Calendário Jurídico e Prazos Processuais
 * Aplica as regras do Código de Processo Civil (CPC, art. 224)
 * para cálculo da data de publicação e contagem de dias úteis.
 */

// Feriados Nacionais fixos no Brasil (Mês e Dia)
const FERIADOS_NACIONAIS_FIXOS = [
  '01-01', // Confraternização Universal
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalho
  '09-07', // Independência do Brasil
  '10-12', // Nossa Senhora Aparecida
  '11-02', // Finados
  '11-15', // Proclamação da República
  '11-20', // Dia Nacional de Zumbi e da Consciência Negra (Lei 14.759/2023)
  '12-25', // Natal
];

/**
 * Calcula a data da Páscoa (Algoritmo de Meeus/Jones/Butcher)
 */
function calcularPascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
}

/**
 * Obtém a lista de feriados móveis (Carnaval, Sexta-feira Santa, Corpus Christi) para o ano.
 */
function obterFeriadosMoveis(ano: number): string[] {
  const pascoa = calcularPascoa(ano);
  const msPorDia = 86400000;

  // Carnaval: terça-feira (47 dias antes da Páscoa)
  const carnavalSeg = new Date(pascoa.getTime() - 48 * msPorDia);
  const carnavalTer = new Date(pascoa.getTime() - 47 * msPorDia);
  // Sexta-feira Santa: 2 dias antes da Páscoa
  const sextaSanta = new Date(pascoa.getTime() - 2 * msPorDia);
  // Corpus Christi: 60 dias após a Páscoa
  const corpusChristi = new Date(pascoa.getTime() + 60 * msPorDia);

  const formatar = (d: Date) => {
    const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(d.getUTCDate()).padStart(2, '0');
    return `${mes}-${dia}`;
  };

  return [formatar(carnavalSeg), formatar(carnavalTer), formatar(sextaSanta), formatar(corpusChristi)];
}

export class CpcCalendar {
  /**
   * Verifica se uma data é dia útil para fins forenses (segunda a sexta, sem feriado nacional).
   */
  public static isDiaUtil(data: Date): boolean {
    const diaSemana = data.getUTCDay();
    // 0 = Domingo, 6 = Sábado
    if (diaSemana === 0 || diaSemana === 6) {
      return false;
    }

    const ano = data.getUTCFullYear();
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(data.getUTCDate()).padStart(2, '0');
    const chave = `${mes}-${dia}`;

    if (FERIADOS_NACIONAIS_FIXOS.includes(chave)) {
      return false;
    }

    const feriadosMoveis = obterFeriadosMoveis(ano);
    if (feriadosMoveis.includes(chave)) {
      return false;
    }

    return true;
  }

  /**
   * Converte string YYYY-MM-DD em objeto Date UTC
   */
  public static parseYMD(dataYMD: string): Date {
    const partes = dataYMD.split('-').map((p) => parseInt(p, 10));
    return new Date(Date.UTC(partes[0], partes[1] - 1, partes[2], 12, 0, 0));
  }

  /**
   * Formata Date para YYYY-MM-DD
   */
  public static formatYMD(data: Date): string {
    const ano = data.getUTCFullYear();
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(data.getUTCDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }

  /**
   * Obtém o próximo dia útil a partir de uma data de referência (exclusiva ou inclusiva).
   */
  public static obterProximoDiaUtil(dataReferencia: Date, incluirMesmoDia: boolean = false): Date {
    const atual = new Date(dataReferencia.getTime());
    if (!incluirMesmoDia) {
      atual.setUTCDate(atual.getUTCDate() + 1);
    }

    while (!CpcCalendar.isDiaUtil(atual)) {
      atual.setUTCDate(atual.getUTCDate() + 1);
    }

    return atual;
  }

  /**
   * Calcula a data de publicação legal com base na data de disponibilização no DJEN:
   * CPC art. 224, § 2º: Considera-se como data da publicação o primeiro dia útil seguinte
   * ao da disponibilização da informação no Diário da Justiça Eletrônico.
   */
  public static calcularDataPublicacaoCpc(dataDisponibilizacaoYMD: string): string {
    if (!dataDisponibilizacaoYMD || !/^\d{4}-\d{2}-\d{2}$/.test(dataDisponibilizacaoYMD)) {
      return dataDisponibilizacaoYMD;
    }

    const dataDisp = CpcCalendar.parseYMD(dataDisponibilizacaoYMD);
    const dataPub = CpcCalendar.obterProximoDiaUtil(dataDisp, false);
    return CpcCalendar.formatYMD(dataPub);
  }

  /**
   * Calcula a data de início do prazo processual:
   * CPC art. 224, § 3º: A contagem do prazo terá início no primeiro dia útil que seguir ao da publicação.
   */
  public static calcularInicioPrazoCpc(dataPublicacaoYMD: string): string {
    if (!dataPublicacaoYMD || !/^\d{4}-\d{2}-\d{2}$/.test(dataPublicacaoYMD)) {
      return dataPublicacaoYMD;
    }

    const dataPub = CpcCalendar.parseYMD(dataPublicacaoYMD);
    const dataInicio = CpcCalendar.obterProximoDiaUtil(dataPub, false);
    return CpcCalendar.formatYMD(dataInicio);
  }
}
