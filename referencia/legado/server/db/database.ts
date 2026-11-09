import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { CONFIG } from '../config.js';

export interface ComunicacaoRecord {
  id?: number;
  comunicacao_id: number;
  hash?: string;
  sigla_tribunal?: string;
  nome_orgao?: string;
  numero_processo?: string;
  numero_processo_mascara?: string;
  nome_classe?: string;
  tipo_comunicacao?: string;
  texto?: string;
  meio?: string;
  link_fonte?: string;
  data_disponibilizacao: string;
  data_publicacao?: string;
  status_revisao: string;
  observacoes?: string;
  providencia?: string;
  raw_json?: string;
  importado_em: string;
  atualizado_em: string;
  advogados?: Array<{
    advogado_id: string;
    advogado_nome: string;
    advogado_oab: string;
  }>;
}

export interface SyncMetadata {
  id: number;
  last_attempt_at?: string | null;
  last_success_at?: string | null;
  last_window_start?: string | null;
  last_window_end?: string | null;
  next_scheduled_at?: string | null;
  status: 'idle' | 'running' | 'success' | 'failed';
  last_error_message?: string | null;
  last_result_summary?: string | null;
  last_duration_ms?: number | null;
  last_http_status?: number | null;
}

export interface DatabaseVerificationResult {
  conectado: boolean;
  tipo: 'SQLite' | 'PostgreSQL';
  urlRedigida: string;
  tabelasValidas: boolean;
  tabelasFaltantes: string[];
  totalTabelas: number;
  erro?: string;
}

export interface AuditLogRecord {
  id?: number;
  usuario: string;
  acao: string;
  recurso_id?: string;
  detalhes?: string;
  ip?: string;
  criado_em?: string;
}

export interface IDatabase {
  listarComunicacoes(filtros: {
    advogadoId?: string;
    status?: string;
    busca?: string;
    dataInicio?: string;
    dataFim?: string;
    ordem?: 'asc' | 'desc';
    limite?: number;
    offset?: number;
  }): { publicacoes: ComunicacaoRecord[]; total: number } | Promise<{ publicacoes: ComunicacaoRecord[]; total: number }>;

  obterEstatisticas(): any | Promise<any>;

  isRemovida(comunicacaoId: number): boolean | Promise<boolean>;

  salvarComunicacao(
    record: Omit<ComunicacaoRecord, 'id'>,
    advogado: { id: string; nome: string; oab: string }
  ): { status: 'inserido' | 'atualizado' | 'ignorado_removido' } | Promise<{ status: 'inserido' | 'atualizado' | 'ignorado_removido' }>;

  atualizarStatus(
    comunicacaoId: number,
    statusRevisao: string,
    providencia?: string,
    observacoes?: string,
    usuario?: string
  ): boolean | Promise<boolean>;

  removerIndividual(comunicacaoId: number, motivo?: string, usuario?: string): boolean | Promise<boolean>;

  previewRemocaoLote(dataCorte: string): { total: number; processosAmostra: string[]; tribunais: string[] } | Promise<{ total: number; processosAmostra: string[]; tribunais: string[] }>;

  removerLote(dataCorte: string, motivo?: string, usuario?: string): number | Promise<number>;

  getSyncMetadata(): SyncMetadata | Promise<SyncMetadata>;

  updateSyncMetadata(meta: Partial<SyncMetadata>): void | Promise<void>;

  registrarLog(log: {
    tipo: string;
    iniciadoEm: string;
    finalizadoEm?: string;
    sucesso: boolean;
    totalNovas?: number;
    totalDuplicadas?: number;
    totalRemovidasIgnoradas?: number;
    detalhes?: string;
    erro?: string;
  }): void | Promise<void>;

  listarLogs(limite?: number): any[] | Promise<any[]>;

  adquirirLock(lockName: string, holderId: string, ttlMs?: number): boolean | Promise<boolean>;

  liberarLock(lockName: string, holderId: string): boolean | Promise<boolean>;

  registrarAuditLog(log: AuditLogRecord): void | Promise<void>;

  listarAuditLogs(limite?: number): AuditLogRecord[] | Promise<AuditLogRecord[]>;

  verificarConexaoETabelas(): DatabaseVerificationResult | Promise<DatabaseVerificationResult>;

  exportarDados(): {
    comunicacoes: any[];
    comunicacoes_advogados: any[];
    comunicacoes_removidas: any[];
    sync_metadata: any;
    sync_logs: any[];
    audit_logs: any[];
  } | Promise<any>;

  importarDados(payload: {
    comunicacoes: any[];
    comunicacoes_advogados: any[];
    comunicacoes_removidas: any[];
    sync_metadata?: any;
    sync_logs?: any[];
  }): { inseridos: number; advogadosVinculados: number; removidasPreservadas: number } | Promise<any>;
}

/**
 * Adaptador SQLite (node:sqlite DatabaseSync)
 * Fornece persistência rápida, sem dependências externas, para ambiente local e testes.
 */
export class DatabaseManager implements IDatabase {
  private db: DatabaseSync;

  constructor(filePath?: string) {
    if (filePath && filePath !== ':memory:') {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(filePath);
    } else {
      this.db = new DatabaseSync(':memory:');
    }
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS comunicacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comunicacao_id INTEGER UNIQUE NOT NULL,
        hash TEXT,
        sigla_tribunal TEXT,
        nome_orgao TEXT,
        numero_processo TEXT,
        numero_processo_mascara TEXT,
        nome_classe TEXT,
        tipo_comunicacao TEXT,
        texto TEXT,
        meio TEXT,
        link_fonte TEXT,
        data_disponibilizacao TEXT NOT NULL,
        data_publicacao TEXT,
        status_revisao TEXT DEFAULT 'A revisar',
        observacoes TEXT,
        providencia TEXT DEFAULT 'A definir',
        raw_json TEXT,
        importado_em TEXT NOT NULL,
        atualizado_em TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comunicacoes_advogados (
        comunicacao_id INTEGER NOT NULL,
        advogado_id TEXT NOT NULL,
        advogado_nome TEXT NOT NULL,
        advogado_oab TEXT NOT NULL,
        PRIMARY KEY (comunicacao_id, advogado_id),
        FOREIGN KEY (comunicacao_id) REFERENCES comunicacoes (comunicacao_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS comunicacoes_removidas (
        comunicacao_id INTEGER PRIMARY KEY,
        numero_processo TEXT,
        removido_em TEXT NOT NULL,
        motivo TEXT,
        usuario TEXT DEFAULT 'advocacia'
      );

      CREATE TABLE IF NOT EXISTS sync_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_window_start TEXT,
        last_window_end TEXT,
        next_scheduled_at TEXT,
        status TEXT DEFAULT 'idle',
        last_error_message TEXT,
        last_result_summary TEXT,
        last_duration_ms INTEGER,
        last_http_status INTEGER
      );

      CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL,
        iniciado_em TEXT NOT NULL,
        finalizado_em TEXT,
        sucesso INTEGER NOT NULL,
        total_novas INTEGER DEFAULT 0,
        total_duplicadas INTEGER DEFAULT 0,
        total_removidas_ignoradas INTEGER DEFAULT 0,
        detalhes TEXT,
        erro TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_locks (
        lock_name TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT NOT NULL,
        acao TEXT NOT NULL,
        recurso_id TEXT,
        detalhes TEXT,
        ip TEXT,
        criado_em TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_comunicacoes_data_disp ON comunicacoes (data_disponibilizacao);
      CREATE INDEX IF NOT EXISTS idx_comunicacoes_status ON comunicacoes (status_revisao);
      CREATE INDEX IF NOT EXISTS idx_comunicacoes_proc ON comunicacoes (numero_processo);
      CREATE INDEX IF NOT EXISTS idx_comunicacoes_adv ON comunicacoes_advogados (advogado_id);

      INSERT OR IGNORE INTO sync_metadata (id, status) VALUES (1, 'idle');
    `);

    // Migrações seguras para bancos SQLite já criados
    try {
      this.db.exec(`ALTER TABLE sync_metadata ADD COLUMN last_duration_ms INTEGER;`);
    } catch {
      // Já existe
    }
    try {
      this.db.exec(`ALTER TABLE sync_metadata ADD COLUMN last_http_status INTEGER;`);
    } catch {
      // Já existe
    }
  }

  public listarComunicacoes(filtros: {
    advogadoId?: string;
    status?: string;
    busca?: string;
    dataInicio?: string;
    dataFim?: string;
    ordem?: 'asc' | 'desc';
    limite?: number;
    offset?: number;
  }): { publicacoes: ComunicacaoRecord[]; total: number } {
    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (filtros.advogadoId && filtros.advogadoId !== 'todos') {
      whereClauses.push(`c.comunicacao_id IN (
        SELECT ca.comunicacao_id FROM comunicacoes_advogados ca WHERE ca.advogado_id = ?
      )`);
      params.push(filtros.advogadoId);
    }

    if (filtros.status && filtros.status !== 'todos') {
      whereClauses.push(`c.status_revisao = ?`);
      params.push(filtros.status);
    }

    if (filtros.dataInicio) {
      whereClauses.push(`c.data_disponibilizacao >= ?`);
      params.push(filtros.dataInicio);
    }

    if (filtros.dataFim) {
      whereClauses.push(`c.data_disponibilizacao <= ?`);
      params.push(filtros.dataFim);
    }

    if (filtros.busca && filtros.busca.trim().length > 0) {
      const termo = `%${filtros.busca.trim().toLowerCase()}%`;
      whereClauses.push(`(
        LOWER(COALESCE(c.numero_processo, '')) LIKE ? OR
        LOWER(COALESCE(c.numero_processo_mascara, '')) LIKE ? OR
        LOWER(COALESCE(c.sigla_tribunal, '')) LIKE ? OR
        LOWER(COALESCE(c.nome_orgao, '')) LIKE ? OR
        LOWER(COALESCE(c.nome_classe, '')) LIKE ? OR
        LOWER(COALESCE(c.texto, '')) LIKE ? OR
        LOWER(COALESCE(c.providencia, '')) LIKE ?
      )`);
      for (let i = 0; i < 7; i++) {
        params.push(termo);
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const orderSql = filtros.ordem === 'asc' 
      ? 'ORDER BY c.data_disponibilizacao ASC, c.id ASC' 
      : 'ORDER BY c.data_disponibilizacao DESC, c.id DESC';

    const countQuery = `SELECT COUNT(*) as total FROM comunicacoes c ${whereSql}`;
    const countResult = (this.db.prepare(countQuery).get(...params) as { total: number }) || { total: 0 };
    const total = countResult.total;

    const limite = filtros.limite && filtros.limite > 0 ? filtros.limite : 50;
    const offset = filtros.offset && filtros.offset >= 0 ? filtros.offset : 0;

    const dataQuery = `
      SELECT c.* FROM comunicacoes c
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(dataQuery).all(...params, limite, offset) as unknown as ComunicacaoRecord[];

    const advStmt = this.db.prepare(`
      SELECT advogado_id, advogado_nome, advogado_oab 
      FROM comunicacoes_advogados 
      WHERE comunicacao_id = ?
    `);

    const publicacoes = rows.map((r) => {
      const advs = advStmt.all(r.comunicacao_id) as unknown as Array<{
        advogado_id: string;
        advogado_nome: string;
        advogado_oab: string;
      }>;
      return {
        ...r,
        advogados: advs,
      };
    });

    return { publicacoes, total };
  }

  public obterEstatisticas() {
    const totalRow = (this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status_revisao = 'A revisar' THEN 1 ELSE 0 END) as aRevisar,
        SUM(CASE WHEN status_revisao = 'Pendente' THEN 1 ELSE 0 END) as pendentes,
        SUM(CASE WHEN status_revisao = 'Em andamento' THEN 1 ELSE 0 END) as emAndamento,
        SUM(CASE WHEN status_revisao = 'Concluído' THEN 1 ELSE 0 END) as concluidas
      FROM comunicacoes
    `).get() as any) || {};

    const porAdvogado: Record<string, { total: number; pendentes: number; aRevisar: number }> = {};
    for (const adv of CONFIG.ADVOGADOS) {
      const advRow = (this.db.prepare(`
        SELECT 
          COUNT(DISTINCT c.comunicacao_id) as total,
          SUM(CASE WHEN c.status_revisao = 'Pendente' THEN 1 ELSE 0 END) as pendentes,
          SUM(CASE WHEN c.status_revisao = 'A revisar' THEN 1 ELSE 0 END) as aRevisar
        FROM comunicacoes c
        JOIN comunicacoes_advogados ca ON c.comunicacao_id = ca.comunicacao_id
        WHERE ca.advogado_id = ?
      `).get(adv.id) as any) || {};

      porAdvogado[adv.id] = {
        total: advRow.total || 0,
        pendentes: advRow.pendentes || 0,
        aRevisar: advRow.aRevisar || 0,
      };
    }

    return {
      total: totalRow.total || 0,
      aRevisar: totalRow.aRevisar || 0,
      pendentes: totalRow.pendentes || 0,
      emAndamento: totalRow.emAndamento || 0,
      concluidas: totalRow.concluidas || 0,
      porAdvogado,
    };
  }

  public isRemovida(comunicacaoId: number): boolean {
    const row = this.db.prepare(`
      SELECT comunicacao_id FROM comunicacoes_removidas WHERE comunicacao_id = ?
    `).get(comunicacaoId);
    return !!row;
  }

  public salvarComunicacao(
    record: Omit<ComunicacaoRecord, 'id'>,
    advogado: { id: string; nome: string; oab: string }
  ): { status: 'inserido' | 'atualizado' | 'ignorado_removido' } {
    if (this.isRemovida(record.comunicacao_id)) {
      return { status: 'ignorado_removido' };
    }

    const agora = new Date().toISOString();
    const existente = this.db.prepare(`
      SELECT comunicacao_id, status_revisao, observacoes, providencia 
      FROM comunicacoes 
      WHERE comunicacao_id = ?
    `).get(record.comunicacao_id) as any;

    if (!existente) {
      this.db.prepare(`
        INSERT INTO comunicacoes (
          comunicacao_id, hash, sigla_tribunal, nome_orgao, numero_processo,
          numero_processo_mascara, nome_classe, tipo_comunicacao, texto, meio,
          link_fonte, data_disponibilizacao, data_publicacao, status_revisao,
          observacoes, providencia, raw_json, importado_em, atualizado_em
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `).run(
        record.comunicacao_id,
        record.hash || null,
        record.sigla_tribunal || null,
        record.nome_orgao || null,
        record.numero_processo || null,
        record.numero_processo_mascara || null,
        record.nome_classe || null,
        record.tipo_comunicacao || null,
        record.texto || null,
        record.meio || null,
        record.link_fonte || null,
        record.data_disponibilizacao,
        record.data_publicacao || null,
        record.status_revisao || 'A revisar',
        record.observacoes || null,
        record.providencia || 'A definir',
        record.raw_json || null,
        record.importado_em || agora,
        agora
      );

      this.db.prepare(`
        INSERT OR IGNORE INTO comunicacoes_advogados (
          comunicacao_id, advogado_id, advogado_nome, advogado_oab
        ) VALUES (?, ?, ?, ?)
      `).run(record.comunicacao_id, advogado.id, advogado.nome, advogado.oab);

      return { status: 'inserido' };
    }

    // Atualização mantendo status e notas
    this.db.prepare(`
      UPDATE comunicacoes SET
        hash = COALESCE(?, hash),
        sigla_tribunal = COALESCE(?, sigla_tribunal),
        nome_orgao = COALESCE(?, nome_orgao),
        numero_processo = COALESCE(?, numero_processo),
        numero_processo_mascara = COALESCE(?, numero_processo_mascara),
        nome_classe = COALESCE(?, nome_classe),
        tipo_comunicacao = COALESCE(?, tipo_comunicacao),
        texto = COALESCE(?, texto),
        meio = COALESCE(?, meio),
        link_fonte = COALESCE(?, link_fonte),
        data_disponibilizacao = ?,
        data_publicacao = COALESCE(?, data_publicacao),
        raw_json = COALESCE(?, raw_json),
        atualizado_em = ?
      WHERE comunicacao_id = ?
    `).run(
      record.hash || null,
      record.sigla_tribunal || null,
      record.nome_orgao || null,
      record.numero_processo || null,
      record.numero_processo_mascara || null,
      record.nome_classe || null,
      record.tipo_comunicacao || null,
      record.texto || null,
      record.meio || null,
      record.link_fonte || null,
      record.data_disponibilizacao,
      record.data_publicacao || null,
      record.raw_json || null,
      agora,
      record.comunicacao_id
    );

    this.db.prepare(`
      INSERT OR IGNORE INTO comunicacoes_advogados (
        comunicacao_id, advogado_id, advogado_nome, advogado_oab
      ) VALUES (?, ?, ?, ?)
    `).run(record.comunicacao_id, advogado.id, advogado.nome, advogado.oab);

    return { status: 'atualizado' };
  }

  public atualizarStatus(
    comunicacaoId: number,
    statusRevisao: string,
    providencia?: string,
    observacoes?: string,
    usuario: string = 'advocacia'
  ): boolean {
    const agora = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE comunicacoes SET
        status_revisao = ?,
        providencia = COALESCE(?, providencia),
        observacoes = COALESCE(?, observacoes),
        atualizado_em = ?
      WHERE comunicacao_id = ?
    `).run(
      statusRevisao,
      providencia !== undefined ? providencia : null,
      observacoes !== undefined ? observacoes : null,
      agora,
      comunicacaoId
    );

    const ok = result.changes > 0;
    if (ok) {
      this.registrarAuditLog({
        usuario,
        acao: 'STATUS_UPDATE',
        recurso_id: String(comunicacaoId),
        detalhes: JSON.stringify({ statusRevisao, providencia, observacoes }),
      });
    }
    return ok;
  }

  public removerIndividual(comunicacaoId: number, motivo?: string, usuario: string = 'advocacia'): boolean {
    const pub = this.db.prepare(`
      SELECT comunicacao_id, numero_processo FROM comunicacoes WHERE comunicacao_id = ?
    `).get(comunicacaoId) as any;

    if (!pub) return false;

    const agora = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO comunicacoes_removidas (comunicacao_id, numero_processo, removido_em, motivo, usuario)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      comunicacaoId,
      pub.numero_processo || null,
      agora,
      motivo || 'Remoção individual confirmada pelo usuário',
      usuario
    );

    this.db.prepare(`DELETE FROM comunicacoes WHERE comunicacao_id = ?`).run(comunicacaoId);

    this.registrarAuditLog({
      usuario,
      acao: 'DELETE_SINGLE',
      recurso_id: String(comunicacaoId),
      detalhes: JSON.stringify({ numeroProcesso: pub.numero_processo, motivo }),
    });

    return true;
  }

  public previewRemocaoLote(dataCorte: string): { total: number; processosAmostra: string[]; tribunais: string[] } {
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as total FROM comunicacoes WHERE data_disponibilizacao <= ?
    `).get(dataCorte) as any;

    const total = countRow?.total || 0;

    const amostraRows = this.db.prepare(`
      SELECT DISTINCT numero_processo_mascara, sigla_tribunal 
      FROM comunicacoes 
      WHERE data_disponibilizacao <= ?
      LIMIT 5
    `).all(dataCorte) as any[];

    const tribunaisRows = this.db.prepare(`
      SELECT DISTINCT sigla_tribunal 
      FROM comunicacoes 
      WHERE data_disponibilizacao <= ?
    `).all(dataCorte) as any[];

    return {
      total,
      processosAmostra: amostraRows.map((r) => r.numero_processo_mascara || 'Sem número'),
      tribunais: tribunaisRows.map((r) => r.sigla_tribunal).filter(Boolean),
    };
  }

  public removerLote(dataCorte: string, motivo?: string, usuario: string = 'advocacia'): number {
    const afetadas = this.db.prepare(`
      SELECT comunicacao_id, numero_processo FROM comunicacoes WHERE data_disponibilizacao <= ?
    `).all(dataCorte) as any[];

    if (afetadas.length === 0) return 0;

    const agora = new Date().toISOString();
    const motivoFinal = motivo || `Remoção em lote por data de corte (${dataCorte})`;

    const insertTombstone = this.db.prepare(`
      INSERT OR REPLACE INTO comunicacoes_removidas (comunicacao_id, numero_processo, removido_em, motivo, usuario)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const item of afetadas) {
      insertTombstone.run(item.comunicacao_id, item.numero_processo || null, agora, motivoFinal, usuario);
    }

    const delResult = this.db.prepare(`DELETE FROM comunicacoes WHERE data_disponibilizacao <= ?`).run(dataCorte);

    this.registrarAuditLog({
      usuario,
      acao: 'DELETE_BATCH',
      detalhes: JSON.stringify({ dataCorte, totalRemovidos: delResult.changes, motivo: motivoFinal }),
    });

    return Number(delResult.changes);
  }

  public getSyncMetadata(): SyncMetadata {
    const row = this.db.prepare(`SELECT * FROM sync_metadata WHERE id = 1`).get() as any;
    if (!row) {
      return { id: 1, status: 'idle' };
    }
    return row as SyncMetadata;
  }

  public updateSyncMetadata(meta: Partial<SyncMetadata>): void {
    const campos: string[] = [];
    const params: (string | number | null)[] = [];

    if (meta.last_attempt_at !== undefined) {
      campos.push('last_attempt_at = ?');
      params.push(meta.last_attempt_at);
    }
    if (meta.last_success_at !== undefined) {
      campos.push('last_success_at = ?');
      params.push(meta.last_success_at);
    }
    if (meta.last_window_start !== undefined) {
      campos.push('last_window_start = ?');
      params.push(meta.last_window_start);
    }
    if (meta.last_window_end !== undefined) {
      campos.push('last_window_end = ?');
      params.push(meta.last_window_end);
    }
    if (meta.next_scheduled_at !== undefined) {
      campos.push('next_scheduled_at = ?');
      params.push(meta.next_scheduled_at);
    }
    if (meta.status !== undefined) {
      campos.push('status = ?');
      params.push(meta.status);
    }
    if (meta.last_error_message !== undefined) {
      campos.push('last_error_message = ?');
      params.push(meta.last_error_message);
    }
    if (meta.last_result_summary !== undefined) {
      campos.push('last_result_summary = ?');
      params.push(meta.last_result_summary);
    }
    if (meta.last_duration_ms !== undefined) {
      campos.push('last_duration_ms = ?');
      params.push(meta.last_duration_ms);
    }
    if (meta.last_http_status !== undefined) {
      campos.push('last_http_status = ?');
      params.push(meta.last_http_status);
    }

    if (campos.length > 0) {
      const sql = `UPDATE sync_metadata SET ${campos.join(', ')} WHERE id = 1`;
      this.db.prepare(sql).run(...params);
    }
  }

  public registrarLog(log: {
    tipo: string;
    iniciadoEm: string;
    finalizadoEm?: string;
    sucesso: boolean;
    totalNovas?: number;
    totalDuplicadas?: number;
    totalRemovidasIgnoradas?: number;
    detalhes?: string;
    erro?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO sync_logs (
        tipo, iniciado_em, finalizado_em, sucesso, total_novas,
        total_duplicadas, total_removidas_ignoradas, detalhes, erro
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.tipo,
      log.iniciadoEm,
      log.finalizadoEm || null,
      log.sucesso ? 1 : 0,
      log.totalNovas || 0,
      log.totalDuplicadas || 0,
      log.totalRemovidasIgnoradas || 0,
      log.detalhes || null,
      log.erro || null
    );
  }

  public listarLogs(limite: number = 20): any[] {
    return this.db.prepare(`
      SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?
    `).all(limite);
  }

  // Trava distribuída persistente com expiração (Lease Lock)
  public adquirirLock(lockName: string, holderId: string, ttlMs: number = CONFIG.SYNC.LOCK_TIMEOUT_MS): boolean {
    const agora = new Date();
    const agoraIso = agora.toISOString();
    const expiraIso = new Date(agora.getTime() + ttlMs).toISOString();

    // Limpar lock expirado
    this.db.prepare(`DELETE FROM sync_locks WHERE lock_name = ? AND expires_at < ?`).run(lockName, agoraIso);

    try {
      this.db.prepare(`
        INSERT INTO sync_locks (lock_name, holder_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(lockName, holderId, agoraIso, expiraIso);
      return true;
    } catch {
      // Outro processo/container já possui o lock ativo
      return false;
    }
  }

  public liberarLock(lockName: string, holderId: string): boolean {
    const res = this.db.prepare(`
      DELETE FROM sync_locks WHERE lock_name = ? AND holder_id = ?
    `).run(lockName, holderId);
    return res.changes > 0;
  }

  public registrarAuditLog(log: AuditLogRecord): void {
    const agora = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO audit_logs (usuario, acao, recurso_id, detalhes, ip, criado_em)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      log.usuario,
      log.acao,
      log.recurso_id || null,
      log.detalhes || null,
      log.ip || null,
      log.criado_em || agora
    );
  }

  public listarAuditLogs(limite: number = 50): AuditLogRecord[] {
    return this.db.prepare(`
      SELECT * FROM audit_logs ORDER BY id DESC, criado_em DESC LIMIT ?
    `).all(limite) as unknown as AuditLogRecord[];
  }

  public verificarConexaoETabelas(): DatabaseVerificationResult {
    try {
      const rows = this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all() as any[];
      const tabelasExistentes = new Set(rows.map((r) => r.name));
      const obrigatorias = [
        'comunicacoes',
        'comunicacoes_advogados',
        'comunicacoes_removidas',
        'sync_metadata',
        'sync_logs',
        'sync_locks',
        'audit_logs',
      ];
      const faltantes = obrigatorias.filter((t) => !tabelasExistentes.has(t));
      return {
        conectado: true,
        tipo: 'SQLite',
        urlRedigida: `sqlite:${path.basename(CONFIG.PATHS.DB_FILE)}`,
        tabelasValidas: faltantes.length === 0,
        tabelasFaltantes: faltantes,
        totalTabelas: tabelasExistentes.size,
      };
    } catch (err: any) {
      return {
        conectado: false,
        tipo: 'SQLite',
        urlRedigida: `sqlite:${path.basename(CONFIG.PATHS.DB_FILE)}`,
        tabelasValidas: false,
        tabelasFaltantes: [],
        totalTabelas: 0,
        erro: err.message,
      };
    }
  }

  public exportarDados() {
    const comunicacoes = this.db.prepare(`SELECT * FROM comunicacoes`).all();
    const comunicacoes_advogados = this.db.prepare(`SELECT * FROM comunicacoes_advogados`).all();
    const comunicacoes_removidas = this.db.prepare(`SELECT * FROM comunicacoes_removidas`).all();
    const sync_metadata = this.db.prepare(`SELECT * FROM sync_metadata WHERE id = 1`).get();
    const sync_logs = this.db.prepare(`SELECT * FROM sync_logs ORDER BY id DESC LIMIT 100`).all();
    const audit_logs = this.db.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100`).all();

    return {
      comunicacoes,
      comunicacoes_advogados,
      comunicacoes_removidas,
      sync_metadata,
      sync_logs,
      audit_logs,
    };
  }

  public importarDados(payload: {
    comunicacoes: any[];
    comunicacoes_advogados: any[];
    comunicacoes_removidas: any[];
    sync_metadata?: any;
    sync_logs?: any[];
  }) {
    let inseridos = 0;
    let advs = 0;
    let rems = 0;

    const insertPub = this.db.prepare(`
      INSERT OR REPLACE INTO comunicacoes (
        comunicacao_id, hash, sigla_tribunal, nome_orgao, numero_processo,
        numero_processo_mascara, nome_classe, tipo_comunicacao, texto, meio,
        link_fonte, data_disponibilizacao, data_publicacao, status_revisao,
        observacoes, providencia, raw_json, importado_em, atualizado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of payload.comunicacoes || []) {
      insertPub.run(
        c.comunicacao_id,
        c.hash || null,
        c.sigla_tribunal || null,
        c.nome_orgao || null,
        c.numero_processo || null,
        c.numero_processo_mascara || null,
        c.nome_classe || null,
        c.tipo_comunicacao || null,
        c.texto || null,
        c.meio || null,
        c.link_fonte || null,
        c.data_disponibilizacao,
        c.data_publicacao || null,
        c.status_revisao || 'A revisar',
        c.observacoes || null,
        c.providencia || 'A definir',
        c.raw_json || null,
        c.importado_em || new Date().toISOString(),
        c.atualizado_em || new Date().toISOString()
      );
      inseridos++;
    }

    const insertAdv = this.db.prepare(`
      INSERT OR REPLACE INTO comunicacoes_advogados (
        comunicacao_id, advogado_id, advogado_nome, advogado_oab
      ) VALUES (?, ?, ?, ?)
    `);

    for (const ca of payload.comunicacoes_advogados || []) {
      insertAdv.run(ca.comunicacao_id, ca.advogado_id, ca.advogado_nome, ca.advogado_oab);
      advs++;
    }

    const insertRem = this.db.prepare(`
      INSERT OR REPLACE INTO comunicacoes_removidas (
        comunicacao_id, numero_processo, removido_em, motivo, usuario
      ) VALUES (?, ?, ?, ?, ?)
    `);

    for (const cr of payload.comunicacoes_removidas || []) {
      insertRem.run(cr.comunicacao_id, cr.numero_processo || null, cr.removido_em, cr.motivo || null, cr.usuario || 'advocacia');
      rems++;
    }

    if (payload.sync_metadata) {
      this.updateSyncMetadata(payload.sync_metadata);
    }

    return { inseridos, advogadosVinculados: advs, removidasPreservadas: rems };
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignorar se já estiver fechado
    }
  }
}

/**
 * Adaptador PostgreSQL (produção)
 */
export class PostgresDatabaseManager implements IDatabase {
  private pool: pg.Pool;
  private connectionString: string;

  constructor(connectionString: string = CONFIG.DATABASE.URL) {
    this.connectionString = connectionString;
    this.pool = new pg.Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }

  public async listarComunicacoes(filtros: {
    advogadoId?: string;
    status?: string;
    busca?: string;
    dataInicio?: string;
    dataFim?: string;
    ordem?: 'asc' | 'desc';
    limite?: number;
    offset?: number;
  }): Promise<{ publicacoes: ComunicacaoRecord[]; total: number }> {
    const whereClauses: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    if (filtros.advogadoId && filtros.advogadoId !== 'todos') {
      whereClauses.push(`c.comunicacao_id IN (
        SELECT ca.comunicacao_id FROM public.comunicacoes_advogados ca WHERE ca.advogado_id = $${pIdx++}
      )`);
      params.push(filtros.advogadoId);
    }

    if (filtros.status && filtros.status !== 'todos') {
      whereClauses.push(`c.status_revisao = $${pIdx++}`);
      params.push(filtros.status);
    }

    if (filtros.dataInicio) {
      whereClauses.push(`c.data_disponibilizacao >= $${pIdx++}`);
      params.push(filtros.dataInicio);
    }

    if (filtros.dataFim) {
      whereClauses.push(`c.data_disponibilizacao <= $${pIdx++}`);
      params.push(filtros.dataFim);
    }

    if (filtros.busca && filtros.busca.trim().length > 0) {
      const termo = `%${filtros.busca.trim().toLowerCase()}%`;
      whereClauses.push(`(
        LOWER(COALESCE(c.numero_processo, '')) LIKE $${pIdx} OR
        LOWER(COALESCE(c.numero_processo_mascara, '')) LIKE $${pIdx} OR
        LOWER(COALESCE(c.sigla_tribunal, '')) LIKE $${pIdx} OR
        LOWER(COALESCE(c.nome_orgao, '')) LIKE $${pIdx} OR
        LOWER(COALESCE(c.nome_classe, '')) LIKE $${pIdx} OR
        LOWER(COALESCE(c.texto, '')) LIKE $${pIdx} OR
        LOWER(COALESCE(c.providencia, '')) LIKE $${pIdx}
      )`);
      params.push(termo);
      pIdx++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const orderSql = filtros.ordem === 'asc' 
      ? 'ORDER BY c.data_disponibilizacao ASC, c.id ASC' 
      : 'ORDER BY c.data_disponibilizacao DESC, c.id DESC';

    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int as total FROM public.comunicacoes c ${whereSql}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    const limite = filtros.limite && filtros.limite > 0 ? filtros.limite : 50;
    const offset = filtros.offset && filtros.offset >= 0 ? filtros.offset : 0;

    const dataQuery = `
      SELECT c.* FROM public.comunicacoes c
      ${whereSql}
      ${orderSql}
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `;
    const dataRes = await this.pool.query(dataQuery, [...params, limite, offset]);
    const rows = dataRes.rows as ComunicacaoRecord[];

    // Carregar advogados
    const advRes = await this.pool.query(`
      SELECT comunicacao_id, advogado_id, advogado_nome, advogado_oab 
      FROM public.comunicacoes_advogados
      WHERE comunicacao_id = ANY($1::bigint[])
    `, [rows.map((r) => r.comunicacao_id)]);

    const advMap = new Map<number, any[]>();
    for (const a of advRes.rows) {
      const arr = advMap.get(Number(a.comunicacao_id)) || [];
      arr.push({
        advogado_id: a.advogado_id,
        advogado_nome: a.advogado_nome,
        advogado_oab: a.advogado_oab,
      });
      advMap.set(Number(a.comunicacao_id), arr);
    }

    const publicacoes = rows.map((r) => ({
      ...r,
      comunicacao_id: Number(r.comunicacao_id),
      data_disponibilizacao: typeof r.data_disponibilizacao === 'object' ? (r.data_disponibilizacao as any).toISOString().slice(0, 10) : String(r.data_disponibilizacao),
      data_publicacao: r.data_publicacao ? (typeof r.data_publicacao === 'object' ? (r.data_publicacao as any).toISOString().slice(0, 10) : String(r.data_publicacao)) : undefined,
      advogados: advMap.get(Number(r.comunicacao_id)) || [],
    }));

    return { publicacoes, total };
  }

  public async obterEstatisticas() {
    const totalRes = await this.pool.query(`
      SELECT 
        COUNT(*)::int as total,
        COUNT(CASE WHEN status_revisao = 'A revisar' THEN 1 END)::int as a_revisar,
        COUNT(CASE WHEN status_revisao = 'Pendente' THEN 1 END)::int as pendentes,
        COUNT(CASE WHEN status_revisao = 'Em andamento' THEN 1 END)::int as em_andamento,
        COUNT(CASE WHEN status_revisao = 'Concluído' THEN 1 END)::int as concluidas
      FROM public.comunicacoes
    `);
    const tRow = totalRes.rows[0] || {};

    const porAdvogado: Record<string, { total: number; pendentes: number; aRevisar: number }> = {};
    for (const adv of CONFIG.ADVOGADOS) {
      const advRes = await this.pool.query(`
        SELECT 
          COUNT(DISTINCT c.comunicacao_id)::int as total,
          COUNT(CASE WHEN c.status_revisao = 'Pendente' THEN 1 END)::int as pendentes,
          COUNT(CASE WHEN c.status_revisao = 'A revisar' THEN 1 END)::int as a_revisar
        FROM public.comunicacoes c
        JOIN public.comunicacoes_advogados ca ON c.comunicacao_id = ca.comunicacao_id
        WHERE ca.advogado_id = $1
      `, [adv.id]);
      const aRow = advRes.rows[0] || {};
      porAdvogado[adv.id] = {
        total: aRow.total || 0,
        pendentes: aRow.pendentes || 0,
        aRevisar: aRow.a_revisar || 0,
      };
    }

    return {
      total: tRow.total || 0,
      aRevisar: tRow.a_revisar || 0,
      pendentes: tRow.pendentes || 0,
      emAndamento: tRow.em_andamento || 0,
      concluidas: tRow.concluidas || 0,
      porAdvogado,
    };
  }

  public async isRemovida(comunicacaoId: number): Promise<boolean> {
    const res = await this.pool.query(`
      SELECT comunicacao_id FROM public.comunicacoes_removidas WHERE comunicacao_id = $1
    `, [comunicacaoId]);
    return res.rows.length > 0;
  }

  public async salvarComunicacao(
    record: Omit<ComunicacaoRecord, 'id'>,
    advogado: { id: string; nome: string; oab: string }
  ): Promise<{ status: 'inserido' | 'atualizado' | 'ignorado_removido' }> {
    if (await this.isRemovida(record.comunicacao_id)) {
      return { status: 'ignorado_removido' };
    }

    const agora = new Date().toISOString();
    const exRes = await this.pool.query(`
      SELECT comunicacao_id FROM public.comunicacoes WHERE comunicacao_id = $1
    `, [record.comunicacao_id]);

    if (exRes.rows.length === 0) {
      await this.pool.query(`
        INSERT INTO public.comunicacoes (
          comunicacao_id, hash, sigla_tribunal, nome_orgao, numero_processo,
          numero_processo_mascara, nome_classe, tipo_comunicacao, texto, meio,
          link_fonte, data_disponibilizacao, data_publicacao, status_revisao,
          observacoes, providencia, raw_json, importado_em, atualizado_em
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18, $19
        )
      `, [
        record.comunicacao_id,
        record.hash || null,
        record.sigla_tribunal || null,
        record.nome_orgao || null,
        record.numero_processo || null,
        record.numero_processo_mascara || null,
        record.nome_classe || null,
        record.tipo_comunicacao || null,
        record.texto || null,
        record.meio || null,
        record.link_fonte || null,
        record.data_disponibilizacao,
        record.data_publicacao || null,
        record.status_revisao || 'A revisar',
        record.observacoes || null,
        record.providencia || 'A definir',
        record.raw_json ? JSON.parse(record.raw_json) : null,
        record.importado_em || agora,
        agora,
      ]);

      await this.pool.query(`
        INSERT INTO public.comunicacoes_advogados (
          comunicacao_id, advogado_id, advogado_nome, advogado_oab
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (comunicacao_id, advogado_id) DO NOTHING
      `, [record.comunicacao_id, advogado.id, advogado.nome, advogado.oab]);

      return { status: 'inserido' };
    }

    await this.pool.query(`
      UPDATE public.comunicacoes SET
        hash = COALESCE($1, hash),
        sigla_tribunal = COALESCE($2, sigla_tribunal),
        nome_orgao = COALESCE($3, nome_orgao),
        numero_processo = COALESCE($4, numero_processo),
        numero_processo_mascara = COALESCE($5, numero_processo_mascara),
        nome_classe = COALESCE($6, nome_classe),
        tipo_comunicacao = COALESCE($7, tipo_comunicacao),
        texto = COALESCE($8, texto),
        meio = COALESCE($9, meio),
        link_fonte = COALESCE($10, link_fonte),
        data_disponibilizacao = $11,
        data_publicacao = COALESCE($12, data_publicacao),
        raw_json = COALESCE($13, raw_json),
        atualizado_em = $14
      WHERE comunicacao_id = $15
    `, [
      record.hash || null,
      record.sigla_tribunal || null,
      record.nome_orgao || null,
      record.numero_processo || null,
      record.numero_processo_mascara || null,
      record.nome_classe || null,
      record.tipo_comunicacao || null,
      record.texto || null,
      record.meio || null,
      record.link_fonte || null,
      record.data_disponibilizacao,
      record.data_publicacao || null,
      record.raw_json ? JSON.parse(record.raw_json) : null,
      agora,
      record.comunicacao_id,
    ]);

    await this.pool.query(`
      INSERT INTO public.comunicacoes_advogados (
        comunicacao_id, advogado_id, advogado_nome, advogado_oab
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (comunicacao_id, advogado_id) DO NOTHING
    `, [record.comunicacao_id, advogado.id, advogado.nome, advogado.oab]);

    return { status: 'atualizado' };
  }

  public async atualizarStatus(
    comunicacaoId: number,
    statusRevisao: string,
    providencia?: string,
    observacoes?: string,
    usuario: string = 'advocacia'
  ): Promise<boolean> {
    const agora = new Date().toISOString();
    const res = await this.pool.query(`
      UPDATE public.comunicacoes SET
        status_revisao = $1,
        providencia = COALESCE($2, providencia),
        observacoes = COALESCE($3, observacoes),
        atualizado_em = $4
      WHERE comunicacao_id = $5
    `, [
      statusRevisao,
      providencia !== undefined ? providencia : null,
      observacoes !== undefined ? observacoes : null,
      agora,
      comunicacaoId,
    ]);

    const ok = (res.rowCount || 0) > 0;
    if (ok) {
      await this.registrarAuditLog({
        usuario,
        acao: 'STATUS_UPDATE',
        recurso_id: String(comunicacaoId),
        detalhes: JSON.stringify({ statusRevisao, providencia, observacoes }),
      });
    }
    return ok;
  }

  public async removerIndividual(comunicacaoId: number, motivo?: string, usuario: string = 'advocacia'): Promise<boolean> {
    const pubRes = await this.pool.query(`
      SELECT comunicacao_id, numero_processo FROM public.comunicacoes WHERE comunicacao_id = $1
    `, [comunicacaoId]);

    if (pubRes.rows.length === 0) return false;
    const pub = pubRes.rows[0];

    const agora = new Date().toISOString();
    await this.pool.query(`
      INSERT INTO public.comunicacoes_removidas (comunicacao_id, numero_processo, removido_em, motivo, usuario)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (comunicacao_id) DO UPDATE SET
        removido_em = EXCLUDED.removido_em,
        motivo = EXCLUDED.motivo,
        usuario = EXCLUDED.usuario
    `, [
      comunicacaoId,
      pub.numero_processo || null,
      agora,
      motivo || 'Remoção individual confirmada pelo usuário',
      usuario,
    ]);

    await this.pool.query(`DELETE FROM public.comunicacoes WHERE comunicacao_id = $1`, [comunicacaoId]);

    await this.registrarAuditLog({
      usuario,
      acao: 'DELETE_SINGLE',
      recurso_id: String(comunicacaoId),
      detalhes: JSON.stringify({ numeroProcesso: pub.numero_processo, motivo }),
    });

    return true;
  }

  public async previewRemocaoLote(dataCorte: string): Promise<{ total: number; processosAmostra: string[]; tribunais: string[] }> {
    const countRes = await this.pool.query(`
      SELECT COUNT(*)::int as total FROM public.comunicacoes WHERE data_disponibilizacao <= $1
    `, [dataCorte]);

    const amostraRes = await this.pool.query(`
      SELECT DISTINCT numero_processo_mascara, sigla_tribunal 
      FROM public.comunicacoes 
      WHERE data_disponibilizacao <= $1
      LIMIT 5
    `, [dataCorte]);

    const tribRes = await this.pool.query(`
      SELECT DISTINCT sigla_tribunal 
      FROM public.comunicacoes 
      WHERE data_disponibilizacao <= $1
    `, [dataCorte]);

    return {
      total: countRes.rows[0]?.total || 0,
      processosAmostra: amostraRes.rows.map((r) => r.numero_processo_mascara || 'Sem número'),
      tribunais: tribRes.rows.map((r) => r.sigla_tribunal).filter(Boolean),
    };
  }

  public async removerLote(dataCorte: string, motivo?: string, usuario: string = 'advocacia'): Promise<number> {
    const selRes = await this.pool.query(`
      SELECT comunicacao_id, numero_processo FROM public.comunicacoes WHERE data_disponibilizacao <= $1
    `, [dataCorte]);

    if (selRes.rows.length === 0) return 0;

    const agora = new Date().toISOString();
    const motivoFinal = motivo || `Remoção em lote por data de corte (${dataCorte})`;

    for (const item of selRes.rows) {
      await this.pool.query(`
        INSERT INTO public.comunicacoes_removidas (comunicacao_id, numero_processo, removido_em, motivo, usuario)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (comunicacao_id) DO UPDATE SET
          removido_em = EXCLUDED.removido_em,
          motivo = EXCLUDED.motivo,
          usuario = EXCLUDED.usuario
      `, [item.comunicacao_id, item.numero_processo || null, agora, motivoFinal, usuario]);
    }

    const delRes = await this.pool.query(`
      DELETE FROM public.comunicacoes WHERE data_disponibilizacao <= $1
    `, [dataCorte]);

    await this.registrarAuditLog({
      usuario,
      acao: 'DELETE_BATCH',
      detalhes: JSON.stringify({ dataCorte, totalRemovidos: delRes.rowCount, motivo: motivoFinal }),
    });

    return delRes.rowCount || 0;
  }

  public async getSyncMetadata(): Promise<SyncMetadata> {
    const res = await this.pool.query(`SELECT * FROM public.sync_metadata WHERE id = 1`);
    if (res.rows.length === 0) {
      return { id: 1, status: 'idle' };
    }
    const r = res.rows[0];
    return {
      id: 1,
      last_attempt_at: r.last_attempt_at ? r.last_attempt_at.toISOString() : null,
      last_success_at: r.last_success_at ? r.last_success_at.toISOString() : null,
      last_window_start: r.last_window_start ? r.last_window_start.toISOString().slice(0, 10) : null,
      last_window_end: r.last_window_end ? r.last_window_end.toISOString().slice(0, 10) : null,
      next_scheduled_at: r.next_scheduled_at ? r.next_scheduled_at.toISOString() : null,
      status: r.status || 'idle',
      last_error_message: r.last_error_message || null,
      last_result_summary: r.last_result_summary || null,
      last_duration_ms: r.last_duration_ms ? Number(r.last_duration_ms) : null,
      last_http_status: r.last_http_status ? Number(r.last_http_status) : null,
    };
  }

  public async updateSyncMetadata(meta: Partial<SyncMetadata>): Promise<void> {
    const campos: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    if (meta.last_attempt_at !== undefined) {
      campos.push(`last_attempt_at = $${pIdx++}`);
      params.push(meta.last_attempt_at);
    }
    if (meta.last_success_at !== undefined) {
      campos.push(`last_success_at = $${pIdx++}`);
      params.push(meta.last_success_at);
    }
    if (meta.last_window_start !== undefined) {
      campos.push(`last_window_start = $${pIdx++}`);
      params.push(meta.last_window_start);
    }
    if (meta.last_window_end !== undefined) {
      campos.push(`last_window_end = $${pIdx++}`);
      params.push(meta.last_window_end);
    }
    if (meta.next_scheduled_at !== undefined) {
      campos.push(`next_scheduled_at = $${pIdx++}`);
      params.push(meta.next_scheduled_at);
    }
    if (meta.status !== undefined) {
      campos.push(`status = $${pIdx++}`);
      params.push(meta.status);
    }
    if (meta.last_error_message !== undefined) {
      campos.push(`last_error_message = $${pIdx++}`);
      params.push(meta.last_error_message);
    }
    if (meta.last_result_summary !== undefined) {
      campos.push(`last_result_summary = $${pIdx++}`);
      params.push(meta.last_result_summary);
    }
    if (meta.last_duration_ms !== undefined) {
      campos.push(`last_duration_ms = $${pIdx++}`);
      params.push(meta.last_duration_ms);
    }
    if (meta.last_http_status !== undefined) {
      campos.push(`last_http_status = $${pIdx++}`);
      params.push(meta.last_http_status);
    }

    if (campos.length > 0) {
      await this.pool.query(
        `UPDATE public.sync_metadata SET ${campos.join(', ')}, updated_at = NOW() WHERE id = 1`,
        params
      );
    }
  }

  public async registrarLog(log: any): Promise<void> {
    await this.pool.query(`
      INSERT INTO public.sync_logs (
        tipo, iniciado_em, finalizado_em, sucesso, total_novas,
        total_duplicadas, total_removidas_ignoradas, detalhes, erro
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      log.tipo,
      log.iniciadoEm,
      log.finalizadoEm || null,
      log.sucesso,
      log.totalNovas || 0,
      log.totalDuplicadas || 0,
      log.totalRemovidasIgnoradas || 0,
      log.detalhes || null,
      log.erro || null,
    ]);
  }

  public async listarLogs(limite: number = 20): Promise<any[]> {
    const res = await this.pool.query(`
      SELECT * FROM public.sync_logs ORDER BY id DESC LIMIT $1
    `, [limite]);
    return res.rows;
  }

  public async adquirirLock(lockName: string, holderId: string, ttlMs: number = CONFIG.SYNC.LOCK_TIMEOUT_MS): Promise<boolean> {
    const agora = new Date();
    const expira = new Date(agora.getTime() + ttlMs);

    // Limpar lock expirado
    await this.pool.query(`
      DELETE FROM public.sync_locks WHERE lock_name = $1 AND expires_at < $2
    `, [lockName, agora]);

    try {
      await this.pool.query(`
        INSERT INTO public.sync_locks (lock_name, holder_id, acquired_at, expires_at)
        VALUES ($1, $2, $3, $4)
      `, [lockName, holderId, agora, expira]);
      return true;
    } catch {
      return false;
    }
  }

  public async liberarLock(lockName: string, holderId: string): Promise<boolean> {
    const res = await this.pool.query(`
      DELETE FROM public.sync_locks WHERE lock_name = $1 AND holder_id = $2
    `, [lockName, holderId]);
    return (res.rowCount || 0) > 0;
  }

  public async registrarAuditLog(log: AuditLogRecord): Promise<void> {
    await this.pool.query(`
      INSERT INTO public.audit_logs (usuario, acao, recurso_id, detalhes, ip, criado_em)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
      log.usuario,
      log.acao,
      log.recurso_id || null,
      log.detalhes || null,
      log.ip || null,
    ]);
  }

  public async listarAuditLogs(limite: number = 50): Promise<AuditLogRecord[]> {
    const res = await this.pool.query(`
      SELECT * FROM public.audit_logs ORDER BY id DESC, criado_em DESC LIMIT $1
    `, [limite]);
    return res.rows;
  }

  public async verificarConexaoETabelas(): Promise<DatabaseVerificationResult> {
    try {
      await this.pool.query('SELECT 1');
      const res = await this.pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      const tabelasExistentes = new Set(res.rows.map((r: any) => r.table_name));
      const obrigatorias = [
        'comunicacoes',
        'comunicacoes_advogados',
        'comunicacoes_removidas',
        'sync_metadata',
        'sync_logs',
        'sync_locks',
        'audit_logs',
      ];
      const faltantes = obrigatorias.filter((t) => !tabelasExistentes.has(t));
      return {
        conectado: true,
        tipo: 'PostgreSQL',
        urlRedigida: this.connectionString ? this.connectionString.replace(/:([^:@]+)@/, ':****@') : 'Não informada',
        tabelasValidas: faltantes.length === 0,
        tabelasFaltantes: faltantes,
        totalTabelas: tabelasExistentes.size,
      };
    } catch (err: any) {
      return {
        conectado: false,
        tipo: 'PostgreSQL',
        urlRedigida: this.connectionString ? this.connectionString.replace(/:([^:@]+)@/, ':****@') : 'Não informada',
        tabelasValidas: false,
        tabelasFaltantes: [],
        totalTabelas: 0,
        erro: err.message,
      };
    }
  }

  public async exportarDados(): Promise<any> {
    const cRes = await this.pool.query(`SELECT * FROM public.comunicacoes`);
    const caRes = await this.pool.query(`SELECT * FROM public.comunicacoes_advogados`);
    const crRes = await this.pool.query(`SELECT * FROM public.comunicacoes_removidas`);
    const smRes = await this.pool.query(`SELECT * FROM public.sync_metadata WHERE id = 1`);
    const slRes = await this.pool.query(`SELECT * FROM public.sync_logs ORDER BY id DESC LIMIT 100`);
    const alRes = await this.pool.query(`SELECT * FROM public.audit_logs ORDER BY id DESC LIMIT 100`);

    return {
      comunicacoes: cRes.rows,
      comunicacoes_advogados: caRes.rows,
      comunicacoes_removidas: crRes.rows,
      sync_metadata: smRes.rows[0],
      sync_logs: slRes.rows,
      audit_logs: alRes.rows,
    };
  }

  public async importarDados(payload: any): Promise<any> {
    let inseridos = 0;
    for (const c of payload.comunicacoes || []) {
      await this.pool.query(`
        INSERT INTO public.comunicacoes (
          comunicacao_id, hash, sigla_tribunal, nome_orgao, numero_processo,
          numero_processo_mascara, nome_classe, tipo_comunicacao, texto, meio,
          link_fonte, data_disponibilizacao, data_publicacao, status_revisao,
          observacoes, providencia, raw_json, importado_em, atualizado_em
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        ON CONFLICT (comunicacao_id) DO UPDATE SET
          texto = EXCLUDED.texto,
          atualizado_em = EXCLUDED.atualizado_em
      `, [
        c.comunicacao_id,
        c.hash || null,
        c.sigla_tribunal || null,
        c.nome_orgao || null,
        c.numero_processo || null,
        c.numero_processo_mascara || null,
        c.nome_classe || null,
        c.tipo_comunicacao || null,
        c.texto || null,
        c.meio || null,
        c.link_fonte || null,
        c.data_disponibilizacao,
        c.data_publicacao || null,
        c.status_revisao || 'A revisar',
        c.observacoes || null,
        c.providencia || 'A definir',
        c.raw_json ? (typeof c.raw_json === 'string' ? JSON.parse(c.raw_json) : c.raw_json) : null,
        c.importado_em || new Date().toISOString(),
        c.atualizado_em || new Date().toISOString(),
      ]);
      inseridos++;
    }

    let advs = 0;
    for (const ca of payload.comunicacoes_advogados || []) {
      await this.pool.query(`
        INSERT INTO public.comunicacoes_advogados (
          comunicacao_id, advogado_id, advogado_nome, advogado_oab
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (comunicacao_id, advogado_id) DO NOTHING
      `, [ca.comunicacao_id, ca.advogado_id, ca.advogado_nome, ca.advogado_oab]);
      advs++;
    }

    let rems = 0;
    for (const cr of payload.comunicacoes_removidas || []) {
      await this.pool.query(`
        INSERT INTO public.comunicacoes_removidas (
          comunicacao_id, numero_processo, removido_em, motivo, usuario
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (comunicacao_id) DO NOTHING
      `, [cr.comunicacao_id, cr.numero_processo || null, cr.removido_em, cr.motivo || null, cr.usuario || 'advocacia']);
      rems++;
    }

    return { inseridos, advogadosVinculados: advs, removidasPreservadas: rems };
  }
}

// Singleton do Database
let defaultDbInstance: IDatabase | null = null;

export function resetDatabaseInstance(): void {
  defaultDbInstance = null;
}

export function getDatabase(): IDatabase {
  if (!defaultDbInstance) {
    if (CONFIG.IS_PRODUCTION) {
      if (!CONFIG.DATABASE.IS_POSTGRES && !CONFIG.DATABASE.ALLOW_SQLITE_IN_PRODUCTION) {
        throw new Error(
          '[Segurança/Produção] A variável DATABASE_URL (PostgreSQL) não está configurada. ' +
          'Em conformidade com as diretrizes da banca, em ambiente de produção o fallback silencioso para SQLite é estritamente proibido. ' +
          'Configure DATABASE_URL com a instância PostgreSQL ou sinalize ALLOW_SQLITE_IN_PRODUCTION=true explicitamente.'
        );
      }
    }

    if (CONFIG.DATABASE.IS_POSTGRES) {
      defaultDbInstance = new PostgresDatabaseManager(CONFIG.DATABASE.URL);
    } else {
      defaultDbInstance = new DatabaseManager(CONFIG.PATHS.DB_FILE);
    }
  }
  return defaultDbInstance;
}
