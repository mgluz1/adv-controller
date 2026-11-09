import path from 'node:path';
import dotenv from 'dotenv';

// Carregar variáveis de ambiente de .env se existir
dotenv.config();

/**
 * Função utilitária para mascarar senhas em strings de conexão de banco de dados,
 * garantindo que credenciais sensíveis nunca apareçam em logs ou diagnósticos.
 */
export function redigirUrlConexao(url?: string | null): string {
  if (!url) return 'Não configurada';
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch {
    return url.replace(/:([^:@]+)@/, ':****@');
  }
}

export const CONFIG = {
  // Fuso horário oficial para exibição de datas e horários jurídicos (CNJ)
  TIMEZONE: process.env.TIMEZONE || 'America/Sao_Paulo',

  // Ambiente
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PRODUCTION: process.env.NODE_ENV === 'production',

  // Advogados/OABs monitorados. EXEMPLO FICTÍCIO: no SaaS, OABs pertencem a cada escritório (tenant)
  // e vêm do banco, nunca de configuração global.
  ADVOGADOS: [
    { id: 'adv-a', nome: 'Advogada Exemplo A', numeroOab: '123456', ufOab: 'GO', rotulo: 'Advogada Exemplo A — OAB/GO 123.456' },
    { id: 'adv-b', nome: 'Advogado Exemplo B', numeroOab: '234567', ufOab: 'RJ', rotulo: 'Advogado Exemplo B — OAB/RJ 234.567' },
  ],

  // Parâmetros da API do DJEN (ComunicaAPI CNJ - Diário de Justiça Eletrônico Nacional)
  DJEN: {
    BASE_URL: process.env.DJEN_BASE_URL || 'https://comunicaapi.pje.jus.br/api/v1',
    PROXY_URL: process.env.DJEN_PROXY_URL || process.env.HTTPS_PROXY || null,
    TIMEOUT_MS: process.env.DJEN_TIMEOUT_MS ? parseInt(process.env.DJEN_TIMEOUT_MS, 10) : 15000,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 2000,
    ITEMS_PER_PAGE: 50, // Limite padrão aceito pelo DJEN por página
    PAGE_DELAY_MS: 300, // Intervalo de cortesia entre requisições de páginas
  },

  // Parâmetros de Coleta Automática (Padrão recomendado: Coleta Diária a cada 24 horas)
  SYNC: {
    INTERVAL_HOURS: process.env.SYNC_INTERVAL_HOURS ? parseInt(process.env.SYNC_INTERVAL_HOURS, 10) : 24,
    RETRY_INTERVAL_MINUTES: process.env.SYNC_RETRY_INTERVAL_MINUTES ? parseInt(process.env.SYNC_RETRY_INTERVAL_MINUTES, 10) : 30,
    FIRST_RUN_DAYS: process.env.SYNC_FIRST_RUN_DAYS ? parseInt(process.env.SYNC_FIRST_RUN_DAYS, 10) : 30,
    OVERLAP_DAYS: process.env.SYNC_OVERLAP_DAYS ? parseInt(process.env.SYNC_OVERLAP_DAYS, 10) : 4,
    LOCK_TIMEOUT_MS: 15 * 60 * 1000, // 15 minutos de lease para trava distribuída
  },

  // Autenticação e Segurança
  SECURITY: {
    AUTH_ENABLED: process.env.AUTH_ENABLED === 'true' || process.env.NODE_ENV === 'production',
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || '',
    CRON_SECRET: process.env.CRON_SECRET || '',
    DEMO_MODE_ENABLED: process.env.DEMO_MODE_ENABLED !== 'false', // Desativável em prod
  },

  // Banco de Dados: SQLite local por padrão ou PostgreSQL via DATABASE_URL
  DATABASE: {
    URL: process.env.DATABASE_URL || '',
    IS_POSTGRES: !!(
      process.env.DATABASE_URL &&
      (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://'))
    ),
    // Em produção, fallback silencioso para SQLite é expressamente proibido, a menos que sinalizado explicitamente
    ALLOW_SQLITE_IN_PRODUCTION: process.env.ALLOW_SQLITE_IN_PRODUCTION === 'true',
  },

  // Caminhos locais de armazenamento SQLite
  PATHS: {
    DATA_DIR: path.resolve(process.cwd(), 'data'),
    DB_FILE: path.resolve(process.cwd(), 'data', 'publicacoes.db'),
  },

  // Porta do servidor HTTP
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
};
