import type { DatabaseSync, StatementSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

/**
 * SQLite storage on Node's built-in `node:sqlite` (Node ≥ 22.5). The database lives on disk in
 * WAL mode, so writes are incremental and readers never block the ingest path.
 */

export const DB_PATH = process.env.AGENT_MONITOR_DB ?? path.join(process.cwd(), 'agent-monitor.db');
let _db: DatabaseSync;
let _txDepth = 0;

type Param = string | number | bigint | null | undefined;
type Bindable = (string | number | bigint | null)[];

// Prepared-statement cache: preparing is the dominant cost for the small hot-path queries.
const _stmts = new Map<string, StatementSync>();
const MAX_CACHED = 300;

function stmtFor(sql: string): StatementSync {
  let s = _stmts.get(sql);
  if (!s) {
    if (_stmts.size >= MAX_CACHED) _stmts.clear();
    s = _db.prepare(sql);
    _stmts.set(sql, s);
  }
  return s;
}

function bindable(params: Param[]): Bindable {
  return params.map(p => (p === undefined ? null : p));
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export interface InitOptions {
  /**
   * Move WAL checkpoints (the only step that fsyncs the database file) to a worker thread so
   * the event loop never stalls on disk flushes during large imports. Used by the server.
   */
  backgroundCheckpoints?: boolean;
}

let _checkpointer: Worker | null = null;

export async function initDb(opts: InitOptions = {}): Promise<void> {
  let sqlite: typeof import('node:sqlite');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqlite = require('node:sqlite');
  } catch {
    throw new Error(`Agent Monitor needs Node.js 22.5 or later for its built-in SQLite engine (running ${process.version}).`);
  }
  if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new sqlite.DatabaseSync(DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -65536;
    PRAGMA journal_size_limit = 67108864;
  `);
  createSchema();
  if (opts.backgroundCheckpoints && DB_PATH !== ':memory:') startCheckpointer();
}

// Runs in a worker thread with its own connection. PASSIVE checkpoints never block the writer;
// a TRUNCATE is attempted when the WAL grows large so the file does not keep growing.
const CHECKPOINTER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout = 2000');
const wal = workerData.path + '-wal';
const tick = () => {
  try {
    const size = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
    if (size === 0) return;
    db.exec(size > 128 * 1024 * 1024 ? 'PRAGMA wal_checkpoint(TRUNCATE)' : 'PRAGMA wal_checkpoint(PASSIVE)');
  } catch { /* busy: retry on the next tick */ }
};
const timer = setInterval(tick, workerData.intervalMs);
parentPort.on('message', m => {
  if (m === 'stop') { clearInterval(timer); tick(); try { db.close(); } catch {} parentPort.postMessage('stopped'); }
});
`;

function startCheckpointer(): void {
  _db.exec('PRAGMA wal_autocheckpoint = 0');
  _checkpointer = new Worker(CHECKPOINTER_SRC, { eval: true, workerData: { path: DB_PATH, intervalMs: 3000 } });
  _checkpointer.on('error', err => {
    console.warn('[db] checkpoint worker failed, falling back to inline checkpoints:', err.message);
    _checkpointer = null;
    try { _db.exec('PRAGMA wal_autocheckpoint = 4000'); } catch { /* closed */ }
  });
  _checkpointer.unref();
}

/** Let SQLite refresh planner statistics after bulk writes (cheap when nothing changed much). */
export function optimizeDb(): void {
  try { _db.exec('PRAGMA optimize'); } catch { /* ignore */ }
}

const WAL_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Background PASSIVE checkpoints cannot reset the WAL while writes keep arriving, so bulk
 * importers call this between batches; it truncates the WAL once it exceeds 64 MB.
 */
export function maybeTruncateWal(): void {
  if (!_checkpointer || !_db?.isOpen) return;
  try {
    if (fs.statSync(`${DB_PATH}-wal`).size > WAL_LIMIT_BYTES) _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch { /* no WAL yet, or busy */ }
}

/** Checkpoint the WAL into the main file and close the database (call on shutdown). */
export function flushDb(): void {
  if (_checkpointer) { void _checkpointer.terminate(); _checkpointer = null; }
  if (!_db?.isOpen) return;
  try { _db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy — WAL is still durable */ }
  _stmts.clear();
  _db.close();
}

/** Run fn inside a single SQLite transaction (nested calls join the outer one). */
export function transaction<T>(fn: () => T): T {
  if (_txDepth > 0) return fn();
  _db.exec('BEGIN');
  _txDepth++;
  try {
    const out = fn();
    _txDepth--;
    _db.exec('COMMIT');
    return out;
  } catch (err) {
    _txDepth--;
    try { _db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

// ── Schema ─────────────────────────────────────────────────────────────────

function tableExists(table: string): boolean {
  return !!get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
}

function hasColumn(table: string, column: string): boolean {
  return Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM pragma_table_info('${table}') WHERE name = ?`, [column])?.c ?? 0) > 0;
}

function addColumn(table: string, column: string, type: string): void {
  if (tableExists(table) && !hasColumn(table, column)) _db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function createSchema() {
  // Very old databases predate tool_use_id; monitoring data is ephemeral, so rebuild them.
  if (tableExists('events') && !hasColumn('events', 'tool_use_id')) {
    console.log('[db] schema migration: rebuilding tables with new columns');
    _db.exec('DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS agents; DROP TABLE IF EXISTS sessions;');
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id               TEXT PRIMARY KEY,
      source           TEXT NOT NULL,
      agent_key        TEXT,
      project_path     TEXT,
      title            TEXT,
      model            TEXT,
      transcript_path  TEXT,
      user             TEXT,
      endpoint         TEXT,
      autonomy_level   INTEGER,
      started_at       TEXT,
      last_activity_at TEXT,
      ended_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      parent_agent_id TEXT,
      agent_type      TEXT,
      started_at      TEXT,
      ended_at        TEXT,
      status          TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id              TEXT NOT NULL,
      agent_id                TEXT NOT NULL,
      parent_event_id         INTEGER,
      event_type              TEXT NOT NULL,
      raw_event_name          TEXT,
      tool_name               TEXT,
      tool_use_id             TEXT,
      external_id             TEXT,
      status                  TEXT,
      duration_ms             INTEGER,
      input_tokens            INTEGER,
      output_tokens           INTEGER,
      cache_read_input_tokens INTEGER,
      error_text              TEXT,
      model                   TEXT,
      payload                 TEXT,
      created_at              TEXT NOT NULL,
      capture_channel         TEXT,
      category                TEXT,
      mcp_server              TEXT,
      risk_level              TEXT,
      correlated_event_id     INTEGER,
      analysis_version        INTEGER,
      redaction               TEXT
    );

    CREATE TABLE IF NOT EXISTS poller_state (
      collector_id  TEXT NOT NULL,
      key           TEXT NOT NULL,
      value         TEXT NOT NULL,
      PRIMARY KEY (collector_id, key)
    );

    CREATE TABLE IF NOT EXISTS findings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      INTEGER NOT NULL,
      session_id    TEXT NOT NULL,
      kind          TEXT NOT NULL,
      key           TEXT NOT NULL,
      label         TEXT,
      severity      TEXT,
      masked_sample TEXT,
      created_at    TEXT NOT NULL
    );
  `);

  // Additive migrations for databases created by earlier versions.
  for (const [col, type] of [['agent_key', 'TEXT'], ['user', 'TEXT'], ['endpoint', 'TEXT'], ['last_activity_at', 'TEXT'],
    ['autonomy_level', 'INTEGER'], ['transcript_path', 'TEXT']] as const) addColumn('sessions', col, type);
  for (const [col, type] of [['external_id', 'TEXT'], ['capture_channel', 'TEXT'], ['category', 'TEXT'], ['mcp_server', 'TEXT'],
    ['risk_level', 'TEXT'], ['correlated_event_id', 'INTEGER'], ['analysis_version', 'INTEGER'], ['redaction', 'TEXT']] as const) addColumn('events', col, type);

  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_session       ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_agent         ON events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_events_created       ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_tool_use      ON events(tool_use_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events(external_id) WHERE external_id IS NOT NULL;
    DROP INDEX IF EXISTS idx_events_session_type;
    CREATE INDEX IF NOT EXISTS idx_events_session_type_time ON events(session_id, event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_analysis      ON events(analysis_version);
    CREATE INDEX IF NOT EXISTS idx_events_redaction     ON events(redaction);
    CREATE INDEX IF NOT EXISTS idx_findings_session     ON findings(session_id);
    CREATE INDEX IF NOT EXISTS idx_findings_kind        ON findings(kind, key);
    CREATE INDEX IF NOT EXISTS idx_findings_created     ON findings(created_at);
    CREATE INDEX IF NOT EXISTS idx_findings_event       ON findings(event_id);
  `);

  _db.exec(`UPDATE sessions SET agent_key = source WHERE agent_key IS NULL`);
  // Refresh planner statistics so hot-path lookups keep using the selective indexes as tables grow.
  _db.exec('PRAGMA optimize=0x10002');
  _db.exec(`UPDATE sessions SET last_activity_at = COALESCE(
      (SELECT MAX(created_at) FROM events WHERE events.session_id = sessions.id), started_at)
    WHERE last_activity_at IS NULL`);
}

// ── Query helpers (synchronous) ────────────────────────────────────────────

/** Execute one or more statements without parameters (schema DDL for feature modules). */
export function exec(sql: string): void {
  _db.exec(sql);
}

export function run(sql: string, params: Param[] = []): void {
  stmtFor(sql).run(...bindable(params));
}

export function get<T = Record<string, unknown>>(sql: string, params: Param[] = []): T | undefined {
  return stmtFor(sql).get(...bindable(params)) as T | undefined;
}

export function all<T = Record<string, unknown>>(sql: string, params: Param[] = []): T[] {
  // Dynamic IN (...) lists would thrash the cache, so long ad-hoc queries are prepared once.
  const s = sql.length < 4000 ? stmtFor(sql) : _db.prepare(sql);
  return s.all(...bindable(params)) as T[];
}

/** Run INSERT and return the auto-generated rowid. */
export function insert(sql: string, params: Param[] = []): number {
  return Number(stmtFor(sql).run(...bindable(params)).lastInsertRowid);
}

/** Read a persisted poller state value, or return the default. */
export function getPollerState(collectorId: string, key: string, defaultValue: string): string {
  const row = get<{ value: string }>(
    'SELECT value FROM poller_state WHERE collector_id = ? AND key = ?',
    [collectorId, key],
  );
  return row?.value ?? defaultValue;
}

/** Persist a poller state value (upsert). */
export function setPollerState(collectorId: string, key: string, value: string): void {
  run(
    'INSERT INTO poller_state (collector_id, key, value) VALUES (?, ?, ?) ON CONFLICT(collector_id, key) DO UPDATE SET value = excluded.value',
    [collectorId, key, value],
  );
}
