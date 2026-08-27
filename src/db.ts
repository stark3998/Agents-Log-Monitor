import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'agent-monitor.db');
let _db: Database;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Persistence ────────────────────────────────────────────────────────────

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 500);
}

// ── Schema ─────────────────────────────────────────────────────────────────

function createSchema() {
  // Migration guard 1: if events table is missing tool_use_id, schema is outdated.
  // Drop all tables and rebuild. Data is ephemeral monitoring, so this is safe.
  const result = _db.exec(
    `SELECT COUNT(*) FROM pragma_table_info('events') WHERE name='tool_use_id'`,
  );
  const hasToolUseId = Number(result?.[0]?.values?.[0]?.[0] ?? 0);
  if (!hasToolUseId) {
    console.log('[db] schema migration: rebuilding tables with new columns');
    _db.run('DROP TABLE IF EXISTS events');
    _db.run('DROP TABLE IF EXISTS agents');
    _db.run('DROP TABLE IF EXISTS sessions');
  }

  // Migration guard 2: add transcript_path to sessions without rebuilding.
  const hasTp = _db.exec(
    `SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='transcript_path'`,
  );
  if (!Number(hasTp?.[0]?.values?.[0]?.[0] ?? 0)) {
    try { _db.run(`ALTER TABLE sessions ADD COLUMN transcript_path TEXT`); } catch { /* column may not exist yet */ }
  }

  // Migration guard 3: add external_id to events for cross-restart deduplication.
  const hasExtId = _db.exec(
    `SELECT COUNT(*) FROM pragma_table_info('events') WHERE name='external_id'`,
  );
  if (!Number(hasExtId?.[0]?.values?.[0]?.[0] ?? 0)) {
    try { _db.run(`ALTER TABLE events ADD COLUMN external_id TEXT`); } catch { /* ignore */ }
  }

  _db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      project_path    TEXT,
      title           TEXT,
      model           TEXT,
      transcript_path TEXT,
      started_at      TEXT,
      ended_at        TEXT
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
      status                  TEXT,
      duration_ms             INTEGER,
      input_tokens            INTEGER,
      output_tokens           INTEGER,
      cache_read_input_tokens INTEGER,
      error_text              TEXT,
      model                   TEXT,
      payload                 TEXT,
      created_at              TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_session    ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_agent      ON events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_events_created    ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_tool_use   ON events(tool_use_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events(external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS poller_state (
      collector_id  TEXT NOT NULL,
      key           TEXT NOT NULL,
      value         TEXT NOT NULL,
      PRIMARY KEY (collector_id, key)
    );
  `);
  scheduleSave();
}

// ── Initialization (call once at startup) ──────────────────────────────────

export async function initDb(): Promise<void> {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(buf);
  } else {
    _db = new SQL.Database();
  }
  createSchema();
}

// ── Query helpers (synchronous, matching better-sqlite3's surface API) ─────

type Param = string | number | null | undefined;

export function run(sql: string, params: Param[] = []): void {
  _db.run(sql, params as (string | number | null)[]);
  scheduleSave();
}

export function get<T = Record<string, unknown>>(sql: string, params: Param[] = []): T | undefined {
  const stmt = _db.prepare(sql);
  stmt.bind(params as (string | number | null)[]);
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as T;
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function all<T = Record<string, unknown>>(sql: string, params: Param[] = []): T[] {
  const stmt = _db.prepare(sql);
  stmt.bind(params as (string | number | null)[]);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as T);
  }
  stmt.free();
  return rows;
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

/** Run INSERT and return the auto-generated rowid. */
export function insert(sql: string, params: Param[] = []): number {
  _db.run(sql, params as (string | number | null)[]);
  const row = _db.exec('SELECT last_insert_rowid()');
  scheduleSave();
  return Number(row[0]?.values[0]?.[0] ?? 0);
}
