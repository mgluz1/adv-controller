import { CONFIG } from '../config.js';
import { CpcCalendar } from '../utils/cpcCalendar.js';

export interface DjenAdvogadoRaw {
  id?: number;
  nome?: string;
  numero_oab?: string;
  uf_oab?: string;
}

export interface DjenDestinatarioAdvogadoRaw {
  id?: number;
  comunicacao_id?: number;
  advogado_id?: number;
  advogado?: DjenAdvogadoRaw;
}

export interface DjenDestinatarioRaw {
  nome?: string;
  polo?: string;
  comunicacao_id?: number;
}

export interface DjenItemRaw {
  id: number;
  data_disponibilizacao?: string;
  datadisponibilizacao?: string;
  siglaTribunal?: string;
  tipoComunicacao?: string;
  nomeOrgao?: string;
  texto?: string;
  numero_processo?: string;
  numeroprocessocommascara?: string;
  nomeClasse?: string;
  codigoClasse?: string;
  tipoDocumento?: string;
  meio?: string;
  meiocompleto?: string;
  link?: string;
  numeroComunicacao?: number;
  hash?: string;
  ativo?: boolean;
  destinatarios?: DjenDestinatarioRaw[];
  destinatarioadvogados?: DjenDestinatarioAdvogadoRaw[];
}

export interface DjenApiResponse {
  status?: string;
  message?: string;
  count?: number;
  items?: DjenItemRaw[];
}

export type TipoFalhaHttp = 
  | 'GEOBLOCK_CLOUDFRONT'
  | 'WAF_BLOCKED_OR_CHALLENGE'
  | 'FORBIDDEN_POLICY'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'BAD_REQUEST'
  | 'INVALID_RESPONSE';

export interface UltimaChamadaCnjDiagnostico {
  statusHttp: number;
  tipoFalha: TipoFalhaHttp | 'OK';
  popCloudFront?: string;
  requestId?: string;
  tempoRespostaMs: number;
  timestamp: string;
  urlConsultada: string;
  mensagem: string;
  isGeoblocked: boolean;
}

export interface DjenFetchResult {
  sucesso: boolean;
  totalEncontrado: number;
  itens: DjenItemRaw[];
  duracaoMs?: number;
  httpStatus?: number;
  popCloudFront?: string;
  requestId?: string;
  erro?: {
    codigoHttp?: number;
    tipoFalha: TipoFalhaHttp;
    mensagem: string;
    isGeoblocked: boolean;
    isRateLimited: boolean;
    popCloudFront?: string;
    requestId?: string;
    detalhes?: string;
  };
}

export class DjenClient {
  private baseUrl: string;
  private proxyUrl: string | null;
  private static ultimoDiagnostico: UltimaChamadaCnjDiagnostico | null = null;

  constructor(baseUrl: string = CONFIG.DJEN.BASE_URL, proxyUrl: string | null = CONFIG.DJEN.PROXY_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.proxyUrl = proxyUrl;
  }

  public static getUltimoDiagnostico(): UltimaChamadaCnjDiagnostico | null {
    return DjenClient.ultimoDiagnostico;
  }

  /**
   * Identifica a causa exata de respostas HTTP de erro, especialmente o código 403,
   * sem presumir levianamente que todo 403 seja geoblocking.
   */
  public static classificarErroHttp(status: number, bodyText: string, headers?: Headers): {
    tipoFalha: TipoFalhaHttp;
    mensagem: string;
    isGeoblocked: boolean;
    isRateLimited: boolean;
  } {
    const textoBaixo = (bodyText || '').toLowerCase();

    if (status === 403) {
      // 1. Caso específico de bloqueio geográfico do CloudFront / AWS da infraestrutura do CNJ
      if (
        textoBaixo.includes('cloudfront') &&
        (textoBaixo.includes('block access from your country') || textoBaixo.includes('blocked by your country'))
      ) {
        return {
          tipoFalha: 'GEOBLOCK_CLOUDFRONT',
          mensagem: 'Bloqueio geográfico de borda CloudFront (CNJ): O endereço IP de origem está fora do território brasileiro.',
          isGeoblocked: true,
          isRateLimited: false,
        };
      }

      // 2. Caso de WAF / Proteção de Bot / IP temporariamente restrito por volume
      if (
        textoBaixo.includes('waf') ||
        textoBaixo.includes('access denied') ||
        textoBaixo.includes('challenge') ||
        textoBaixo.includes('bot detection') ||
        textoBaixo.includes('security check')
      ) {
        return {
          tipoFalha: 'WAF_BLOCKED_OR_CHALLENGE',
          mensagem: 'Acesso bloqueado por WAF/Firewall de aplicação do CNJ (regras de segurança ou cabeçalhos rejeitados).',
          isGeoblocked: false,
          isRateLimited: false,
        };
      }

      // 3. 403 de política de endpoint ou credencial restrita
      return {
        tipoFalha: 'FORBIDDEN_POLICY',
        mensagem: 'Acesso negado (HTTP 403 Forbidden). A rota pública do DJEN rejeitou a consulta com os parâmetros fornecidos.',
        isGeoblocked: false,
        isRateLimited: false,
      };
    }

    if (status === 429) {
      return {
        tipoFalha: 'RATE_LIMITED',
        mensagem: 'Limite de requisições excedido na API do DJEN (HTTP 429 Too Many Requests).',
        isGeoblocked: false,
        isRateLimited: true,
      };
    }

    if (status >= 500) {
      return {
        tipoFalha: 'SERVER_ERROR',
        mensagem: `Instabilidade interna temporária nos servidores do CNJ / DJEN (HTTP ${status}).`,
        isGeoblocked: false,
        isRateLimited: false,
      };
    }

    if (status === 400) {
      return {
        tipoFalha: 'BAD_REQUEST',
        mensagem: `Parâmetros de consulta rejeitados pela API do DJEN (HTTP 400). Detalhes: ${bodyText.slice(0, 200)}`,
        isGeoblocked: false,
        isRateLimited: false,
      };
    }

    return {
      tipoFalha: 'INVALID_RESPONSE',
      mensagem: `Resposta inesperada da API do DJEN (HTTP ${status}).`,
      isGeoblocked: false,
      isRateLimited: false,
    };
  }

  /**
   * Realiza uma requisição HTTP à API com retentativas controladas,
   * backoff exponencial e tratamento auditado de erros.
   */
  private async requestComRetry(
    url: string,
    tentativas: number = CONFIG.DJEN.MAX_RETRIES
  ): Promise<{
    status: number;
    ok: boolean;
    data?: any;
    rawText?: string;
    headers?: Headers;
    duracaoMs: number;
    popCloudFront?: string;
    requestId?: string;
  }> {
    let ultimoErro: any = null;

    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
      const inicioReq = Date.now();
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.DJEN.TIMEOUT_MS);

        // Se houver proxy de saída configurado para o DJEN
        let targetUrl = url;
        if (this.proxyUrl) {
          if (this.proxyUrl.includes('?url=') || this.proxyUrl.includes('&url=')) {
            targetUrl = `${this.proxyUrl}${encodeURIComponent(url)}`;
          } else if (this.proxyUrl.startsWith('http')) {
            targetUrl = url.replace(this.baseUrl, this.proxyUrl.replace(/\/+$/, ''));
          }
        }

        const response = await fetch(targetUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'AdvController-MonitoramentoDJEN/2.0 (contato configurável por tenant)',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const duracaoMs = Date.now() - inicioReq;
        const popCloudFront = response.headers.get('x-amz-cf-pop') || undefined;
        const requestId = response.headers.get('x-amz-cf-id') || undefined;

        // Erro 403 (Auditoria detalhada)
        if (response.status === 403) {
          const bodyText = await response.text();
          const classif = DjenClient.classificarErroHttp(403, bodyText, response.headers);

          DjenClient.ultimoDiagnostico = {
            statusHttp: 403,
            tipoFalha: classif.tipoFalha,
            popCloudFront,
            requestId,
            tempoRespostaMs: duracaoMs,
            timestamp: new Date().toISOString(),
            urlConsultada: url,
            mensagem: classif.mensagem,
            isGeoblocked: classif.isGeoblocked,
          };

          return {
            status: 403,
            ok: false,
            rawText: bodyText,
            headers: response.headers,
            duracaoMs,
            popCloudFront,
            requestId,
          };
        }

        // Erro 429 (Rate Limit): espera com backoff exponencial
        if (response.status === 429) {
          if (tentativa < tentativas) {
            const espera = CONFIG.DJEN.RETRY_DELAY_MS * Math.pow(2, tentativa - 1);
            await new Promise((r) => setTimeout(r, espera));
            continue;
          }
          const diag: UltimaChamadaCnjDiagnostico = {
            statusHttp: 429,
            tipoFalha: 'RATE_LIMITED',
            popCloudFront,
            requestId,
            tempoRespostaMs: duracaoMs,
            timestamp: new Date().toISOString(),
            urlConsultada: url,
            mensagem: 'Limite de requisições excedido (HTTP 429 Too Many Requests).',
            isGeoblocked: false,
          };
          DjenClient.ultimoDiagnostico = diag;

          return {
            status: 429,
            ok: false,
            rawText: diag.mensagem,
            headers: response.headers,
            duracaoMs,
            popCloudFront,
            requestId,
          };
        }

        // Erro 5xx (Indisponibilidade do CNJ)
        if (response.status >= 500) {
          if (tentativa < tentativas) {
            const espera = CONFIG.DJEN.RETRY_DELAY_MS * tentativa;
            await new Promise((r) => setTimeout(r, espera));
            continue;
          }
          const msg = `Servidor do DJEN instável (HTTP ${response.status}).`;
          DjenClient.ultimoDiagnostico = {
            statusHttp: response.status,
            tipoFalha: 'SERVER_ERROR',
            popCloudFront,
            requestId,
            tempoRespostaMs: duracaoMs,
            timestamp: new Date().toISOString(),
            urlConsultada: url,
            mensagem: msg,
            isGeoblocked: false,
          };

          return {
            status: response.status,
            ok: false,
            rawText: msg,
            headers: response.headers,
            duracaoMs,
            popCloudFront,
            requestId,
          };
        }

        // Sucesso 200 OK
        if (response.ok) {
          const json = await response.json();
          DjenClient.ultimoDiagnostico = {
            statusHttp: response.status,
            tipoFalha: 'OK',
            popCloudFront,
            requestId,
            tempoRespostaMs: duracaoMs,
            timestamp: new Date().toISOString(),
            urlConsultada: url,
            mensagem: 'Consulta realizada com sucesso na API do DJEN.',
            isGeoblocked: false,
          };

          return {
            status: response.status,
            ok: true,
            data: json,
            headers: response.headers,
            duracaoMs,
            popCloudFront,
            requestId,
          };
        }

        const texto = await response.text();
        const classifGen = DjenClient.classificarErroHttp(response.status, texto, response.headers);
        DjenClient.ultimoDiagnostico = {
          statusHttp: response.status,
          tipoFalha: classifGen.tipoFalha,
          popCloudFront,
          requestId,
          tempoRespostaMs: duracaoMs,
          timestamp: new Date().toISOString(),
          urlConsultada: url,
          mensagem: classifGen.mensagem,
          isGeoblocked: classifGen.isGeoblocked,
        };

        return {
          status: response.status,
          ok: false,
          rawText: texto,
          headers: response.headers,
          duracaoMs,
          popCloudFront,
          requestId,
        };
      } catch (err: any) {
        ultimoErro = err;
        const duracaoMs = Date.now() - inicioReq;

        if (err.name === 'AbortError') {
          if (tentativa < tentativas) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          const timeoutMsg = `Tempo limite de conexão esgotado (${CONFIG.DJEN.TIMEOUT_MS / 1000}s).`;
          DjenClient.ultimoDiagnostico = {
            statusHttp: 408,
            tipoFalha: 'TIMEOUT',
            tempoRespostaMs: duracaoMs,
            timestamp: new Date().toISOString(),
            urlConsultada: url,
            mensagem: timeoutMsg,
            isGeoblocked: false,
          };
          return {
            status: 408,
            ok: false,
            rawText: timeoutMsg,
            duracaoMs,
          };
        }

        if (tentativa < tentativas) {
          await new Promise((r) => setTimeout(r, 1000 * tentativa));
        }
      }
    }

    const falhaRedeMsg = ultimoErro?.message || 'Falha de rede ao conectar com a API do DJEN.';
    DjenClient.ultimoDiagnostico = {
      statusHttp: 0,
      tipoFalha: 'NETWORK_ERROR',
      tempoRespostaMs: 0,
      timestamp: new Date().toISOString(),
      urlConsultada: url,
      mensagem: falhaRedeMsg,
      isGeoblocked: false,
    };

    return {
      status: 0,
      ok: false,
      rawText: falhaRedeMsg,
      duracaoMs: 0,
    };
  }

  /**
   * Executa uma sonda rápida em tempo real para verificar conectividade,
   * latência e código HTTP sem impactar os dados do banco.
   */
  public async executarSondaDiagnostica(numeroOab: string = '123456', ufOab: string = 'GO'): Promise<UltimaChamadaCnjDiagnostico> {
    const oabLimpa = numeroOab.replace(/\D/g, '');
    const ufLimpa = ufOab.trim().toUpperCase();
    const query = new URLSearchParams({
      numeroOab: oabLimpa,
      ufOab: ufLimpa,
      pagina: '1',
      itensPorPagina: '1',
    });
    const url = `${this.baseUrl}/comunicacao?${query.toString()}`;
    const res = await this.requestComRetry(url, 1);

    if (DjenClient.ultimoDiagnostico) {
      return DjenClient.ultimoDiagnostico;
    }

    return {
      statusHttp: res.status,
      tipoFalha: res.ok ? 'OK' : 'INVALID_RESPONSE',
      popCloudFront: res.popCloudFront,
      requestId: res.requestId,
      tempoRespostaMs: res.duracaoMs,
      timestamp: new Date().toISOString(),
      urlConsultada: url,
      mensagem: res.ok ? 'Conexão operacional com o DJEN.' : (res.rawText || 'Sem resposta'),
      isGeoblocked: res.status === 403,
    };
  }

  /**
   * Consulta as comunicações para uma OAB/UF em um período específico,
   * percorrendo todas as páginas de forma auditável e segura.
   */
  public async consultarPublicacoes(params: {
    numeroOab: string;
    ufOab: string;
    dataInicio: string; // YYYY-MM-DD
    dataFim: string;    // YYYY-MM-DD
  }): Promise<DjenFetchResult> {
    const itensColetados: DjenItemRaw[] = [];
    let paginaAtual = 1;
    let totalContagem = 0;
    const itensPorPagina = CONFIG.DJEN.ITEMS_PER_PAGE;
    const inicioTotal = Date.now();

    // Normalização estrita da OAB: apenas dígitos
    const oabLimpa = params.numeroOab.replace(/\D/g, '');
    const ufLimpa = params.ufOab.trim().toUpperCase();

    // Validação preliminar de parâmetros
    if (!oabLimpa || !ufLimpa || !/^[A-Z]{2}$/.test(ufLimpa)) {
      return {
        sucesso: false,
        totalEncontrado: 0,
        itens: [],
        erro: {
          tipoFalha: 'BAD_REQUEST',
          mensagem: `Parâmetros de OAB inválidos: "${params.numeroOab}" UF: "${params.ufOab}".`,
          isGeoblocked: false,
          isRateLimited: false,
        },
      };
    }

    while (true) {
      const queryParams = new URLSearchParams({
        numeroOab: oabLimpa,
        ufOab: ufLimpa,
        dataDisponibilizacaoInicio: params.dataInicio,
        dataDisponibilizacaoFim: params.dataFim,
        pagina: String(paginaAtual),
        itensPorPagina: String(itensPorPagina),
      });

      const url = `${this.baseUrl}/comunicacao?${queryParams.toString()}`;
      const res = await this.requestComRetry(url);

      if (!res.ok) {
        const classif = DjenClient.classificarErroHttp(res.status, res.rawText || '', res.headers);
        return {
          sucesso: false,
          totalEncontrado: 0,
          itens: [],
          duracaoMs: res.duracaoMs,
          httpStatus: res.status,
          popCloudFront: res.popCloudFront,
          requestId: res.requestId,
          erro: {
            codigoHttp: res.status,
            tipoFalha: classif.tipoFalha,
            mensagem: classif.mensagem,
            isGeoblocked: classif.isGeoblocked,
            isRateLimited: classif.isRateLimited,
            popCloudFront: res.popCloudFront,
            requestId: res.requestId,
            detalhes: `Consulta OAB/${ufLimpa} ${oabLimpa} [Período: ${params.dataInicio} a ${params.dataFim}, Página: ${paginaAtual}]. Resposta bruta: ${(res.rawText || '').slice(0, 300)}`,
          },
        };
      }

      const body = res.data as DjenApiResponse;
      if (!body) {
        return {
          sucesso: false,
          totalEncontrado: 0,
          itens: [],
          duracaoMs: res.duracaoMs,
          httpStatus: res.status,
          erro: {
            codigoHttp: res.status,
            tipoFalha: 'INVALID_RESPONSE',
            mensagem: 'Resposta vazia ou corpo inválido retornado pelo DJEN.',
            isGeoblocked: false,
            isRateLimited: false,
          },
        };
      }

      totalContagem = body.count || 0;
      const itensPagina = Array.isArray(body.items) ? body.items : [];

      if (itensPagina.length === 0) {
        // Consulta válida concluída sem resultados para esta página/período
        break;
      }

      itensColetados.push(...itensPagina);

      // Critério de parada: count atingido ou última página retornou menos itens que a capacidade
      if (itensColetados.length >= totalContagem || itensPagina.length < itensPorPagina) {
        break;
      }

      paginaAtual++;

      // Pausa de cortesia entre requisições de página
      if (CONFIG.DJEN.PAGE_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, CONFIG.DJEN.PAGE_DELAY_MS));
      }
    }

    return {
      sucesso: true,
      totalEncontrado: totalContagem,
      itens: itensColetados,
      duracaoMs: Date.now() - inicioTotal,
      httpStatus: 200,
    };
  }

  /**
   * Converte o item bruto do DJEN para o formato do banco de dados local ou PostgreSQL,
   * aplicando com rigor o cálculo de data de publicação forense (CPC art. 224, § 2º).
   */
  public static normalizarItemDjen(item: DjenItemRaw): {
    comunicacao_id: number;
    hash?: string;
    sigla_tribunal: string;
    nome_orgao: string;
    numero_processo: string;
    numero_processo_mascara: string;
    nome_classe: string;
    tipo_comunicacao: string;
    texto: string;
    meio: string;
    link_fonte?: string;
    data_disponibilizacao: string;
    data_publicacao: string;
    status_revisao: string;
    providencia: string;
    raw_json: string;
    importado_em: string;
    atualizado_em: string;
  } {
    const agora = new Date().toISOString();
    const dataDisp = item.data_disponibilizacao || item.datadisponibilizacao || '';

    // Data de publicação CPC art. 224, § 2º: 1º dia útil seguinte à disponibilização
    const dataPub = CpcCalendar.calcularDataPublicacaoCpc(dataDisp);

    const procNumero = item.numero_processo || item.numeroprocessocommascara || 'Sem número';
    const procMascara = item.numeroprocessocommascara || item.numero_processo || 'Sem número';

    return {
      comunicacao_id: Number(item.id || item.numeroComunicacao),
      hash: item.hash || undefined,
      sigla_tribunal: (item.siglaTribunal || 'Tribunal não informado').trim(),
      nome_orgao: (item.nomeOrgao || 'Órgão julgador não informado').trim(),
      numero_processo: procNumero.trim(),
      numero_processo_mascara: procMascara.trim(),
      nome_classe: (item.nomeClasse || 'Não informada').trim(),
      tipo_comunicacao: (item.tipoComunicacao || 'Intimação').trim(),
      texto: item.texto || '(Sem teor de publicação registrado)',
      meio: item.meiocompleto || item.meio || 'Diário de Justiça Eletrônico Nacional (DJEN)',
      link_fonte: item.link || undefined,
      data_disponibilizacao: dataDisp,
      data_publicacao: dataPub,
      status_revisao: 'A revisar',
      providencia: 'A definir',
      raw_json: JSON.stringify(item),
      importado_em: agora,
      atualizado_em: agora,
    };
  }
}
