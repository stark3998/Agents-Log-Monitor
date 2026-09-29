import crypto from 'crypto';
import { all, exec, get, run, transaction } from '../../db';
import { GENESIS_HASH, hashDecision, verifyChain } from '../audit';
import type {
  Approval, Decision, Incident, LaneRecord, LaneStatus, RegisteredAgent, SessionIntent,
} from '../types';
import type {
  ApprovalQuery, AuditVerifyResult, DecisionQuery, GovernanceStore, IncidentQuery, Page,
} from './repository';

/**
 * Local governance store on the monitor's node:sqlite database. Documents are stored as JSON with
 * a few indexed columns for filtering. `initDb()` must have run first.
 */
export class SqliteGovernanceStore implements GovernanceStore {
  readonly kind = 'sqlite' as const;

  async init(): Promise<void> {
    exec(`
      CREATE TABLE IF NOT EXISTS gov_lanes (
        id         TEXT NOT NULL,
        version    INTEGER NOT NULL,
        status     TEXT NOT NULL,
        doc        TEXT NOT NULL,
        yaml       TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS gov_agents (
        id          TEXT PRIMARY KEY,
        surface     TEXT NOT NULL,
        external_id TEXT,
        status      TEXT NOT NULL,
        doc         TEXT NOT NULL,
        last_seen   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gov_agents_ext ON gov_agents(surface, external_id);
      CREATE TABLE IF NOT EXISTS gov_session_intent (
        session_id TEXT PRIMARY KEY,
        doc        TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gov_decisions (
        seq          INTEGER PRIMARY KEY,
        id           TEXT NOT NULL UNIQUE,
        request_id   TEXT,
        session_id   TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        lane_id      TEXT,
        verdict      TEXT NOT NULL,
        would_deny   INTEGER NOT NULL,
        tool_name    TEXT,
        created_at   TEXT NOT NULL,
        prev_hash    TEXT NOT NULL,
        hash         TEXT NOT NULL,
        doc          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gov_dec_session ON gov_decisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_gov_dec_agent   ON gov_decisions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_gov_dec_created ON gov_decisions(created_at);
      CREATE INDEX IF NOT EXISTS idx_gov_dec_request ON gov_decisions(request_id);
      CREATE TABLE IF NOT EXISTS gov_approvals (
        id          TEXT PRIMARY KEY,
        state       TEXT NOT NULL,
        session_id  TEXT,
        agent_id    TEXT,
        requested_at TEXT NOT NULL,
        doc         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gov_appr_state ON gov_approvals(state);
      CREATE TABLE IF NOT EXISTS gov_incidents (
        id         TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        doc        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gov_outbox (
        id         TEXT PRIMARY KEY,
        box        TEXT NOT NULL,
        item       TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gov_outbox_box ON gov_outbox(box, claimed_at);
    `);
  }

  // ── Lanes ────────────────────────────────────────────────────────────────

  private laneRow(r: { doc: string; status: string; yaml: string | null; updated_at: string; updated_by: string | null }): LaneRecord {
    return { lane: JSON.parse(r.doc), status: r.status as LaneStatus, yaml: r.yaml ?? undefined, updatedAt: r.updated_at, updatedBy: r.updated_by ?? undefined };
  }

  async listLanes(status?: LaneStatus[]): Promise<LaneRecord[]> {
    // Latest version per lane id. When status is provided, choose the latest version among
    // matching statuses instead of choosing the absolute latest and filtering it afterwards.
    const statusFilter = status?.length ? `WHERE status IN (${status.map(() => '?').join(',')})` : '';
    const rows = all<{ doc: string; status: string; yaml: string | null; updated_at: string; updated_by: string | null }>(
      `SELECT l.* FROM gov_lanes l
       JOIN (SELECT id, MAX(version) AS v FROM gov_lanes ${statusFilter} GROUP BY id) m ON m.id = l.id AND m.v = l.version
       ORDER BY l.id`, status ?? []);
    return rows.map(r => this.laneRow(r));
  }

  async getLane(id: string, version?: number): Promise<LaneRecord | undefined> {
    const r = version != null
      ? get<{ doc: string; status: string; yaml: string | null; updated_at: string; updated_by: string | null }>(
        'SELECT * FROM gov_lanes WHERE id = ? AND version = ?', [id, version])
      : get<{ doc: string; status: string; yaml: string | null; updated_at: string; updated_by: string | null }>(
        `SELECT * FROM gov_lanes WHERE id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`, [id]);
    return r ? this.laneRow(r) : undefined;
  }

  async listLaneVersions(id: string): Promise<LaneRecord[]> {
    return all<{ doc: string; status: string; yaml: string | null; updated_at: string; updated_by: string | null }>(
      'SELECT * FROM gov_lanes WHERE id = ? ORDER BY version DESC', [id]).map(r => this.laneRow(r));
  }

  async saveLane(rec: LaneRecord): Promise<LaneRecord> {
    return transaction(() => {
      if (rec.status === 'active') {
        run(`UPDATE gov_lanes SET status = 'archived' WHERE id = ? AND status = 'active' AND version <> ?`, [rec.lane.id, rec.lane.version]);
      }
      run(
        `INSERT INTO gov_lanes (id, version, status, doc, yaml, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, version) DO UPDATE SET status = excluded.status, doc = excluded.doc, yaml = excluded.yaml,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [rec.lane.id, rec.lane.version, rec.status, JSON.stringify(rec.lane), rec.yaml ?? null, rec.updatedAt, rec.updatedBy ?? null],
      );
      return rec;
    });
  }

  async setLaneStatus(id: string, version: number, status: LaneStatus, by?: string): Promise<void> {
    transaction(() => {
      if (status === 'active') run(`UPDATE gov_lanes SET status = 'archived' WHERE id = ? AND status = 'active'`, [id]);
      run('UPDATE gov_lanes SET status = ?, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?',
        [status, new Date().toISOString(), by ?? null, id, version]);
    });
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  async listAgents(): Promise<RegisteredAgent[]> {
    return all<{ doc: string }>('SELECT doc FROM gov_agents ORDER BY last_seen DESC').map(r => JSON.parse(r.doc));
  }

  async getAgent(id: string): Promise<RegisteredAgent | undefined> {
    const r = get<{ doc: string }>('SELECT doc FROM gov_agents WHERE id = ?', [id]);
    return r ? JSON.parse(r.doc) : undefined;
  }

  async findAgentByExternalId(surface: string, externalId: string): Promise<RegisteredAgent | undefined> {
    const r = get<{ doc: string }>('SELECT doc FROM gov_agents WHERE surface = ? AND external_id = ?', [surface, externalId]);
    return r ? JSON.parse(r.doc) : undefined;
  }

  async upsertAgent(a: RegisteredAgent): Promise<RegisteredAgent> {
    run(
      `INSERT INTO gov_agents (id, surface, external_id, status, doc, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET surface = excluded.surface, external_id = excluded.external_id,
         status = excluded.status, doc = excluded.doc, last_seen = excluded.last_seen`,
      [a.id, a.surface, a.externalId ?? null, a.status, JSON.stringify(a), a.lastSeenAt],
    );
    return a;
  }

  // ── Session intent ───────────────────────────────────────────────────────

  async getSessionIntent(sessionId: string): Promise<SessionIntent | undefined> {
    const r = get<{ doc: string }>('SELECT doc FROM gov_session_intent WHERE session_id = ?', [sessionId]);
    return r ? JSON.parse(r.doc) : undefined;
  }

  async saveSessionIntent(s: SessionIntent): Promise<void> {
    run(
      `INSERT INTO gov_session_intent (session_id, doc, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
      [s.sessionId, JSON.stringify(s), s.updatedAt],
    );
  }

  // ── Decisions (hash chain) ───────────────────────────────────────────────

  async appendDecision(d: Decision): Promise<Decision> {
    return transaction(() => {
      const head = get<{ seq: number; hash: string }>('SELECT seq, hash FROM gov_decisions ORDER BY seq DESC LIMIT 1');
      const seq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS_HASH;
      const hash = hashDecision(prevHash, seq, d);
      const out: Decision = { ...d, seq, prevHash, hash };
      run(
        `INSERT INTO gov_decisions (seq, id, request_id, session_id, agent_id, lane_id, verdict, would_deny, tool_name, created_at, prev_hash, hash, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [seq, d.id, d.requestId, d.sessionId, d.agentId, d.laneId, d.effectiveVerdict, d.wouldDeny ? 1 : 0, d.toolName ?? null,
          d.createdAt, prevHash, hash, JSON.stringify(out)],
      );
      return out;
    });
  }

  async getDecision(id: string): Promise<Decision | undefined> {
    const r = get<{ doc: string }>('SELECT doc FROM gov_decisions WHERE id = ?', [id]);
    return r ? JSON.parse(r.doc) : undefined;
  }

  async queryDecisions(q: DecisionQuery): Promise<Page<Decision>> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.sessionId) { where.push('session_id = ?'); params.push(q.sessionId); }
    if (q.agentId) { where.push('agent_id = ?'); params.push(q.agentId); }
    if (q.laneId) { where.push('lane_id = ?'); params.push(q.laneId); }
    if (q.toolName) { where.push('tool_name = ?'); params.push(q.toolName); }
    if (q.verdict?.length) { where.push(`verdict IN (${q.verdict.map(() => '?').join(',')})`); params.push(...q.verdict); }
    if (q.wouldDeny != null) { where.push('would_deny = ?'); params.push(q.wouldDeny ? 1 : 0); }
    if (q.since) { where.push('created_at >= ?'); params.push(q.since); }
    if (q.until) { where.push('created_at < ?'); params.push(q.until); }
    if (q.text) { where.push('doc LIKE ?'); params.push(`%${q.text}%`); }
    if (q.cursor) { where.push('seq < ?'); params.push(Number(q.cursor)); }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const rows = all<{ seq: number; doc: string }>(
      `SELECT seq, doc FROM gov_decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const items = rows.slice(0, limit).map(r => JSON.parse(r.doc) as Decision);
    return { items, cursor: rows.length > limit ? String(rows[limit - 1].seq) : undefined };
  }

  async verifyAuditChain(fromSeq = 1, limit = 100_000): Promise<AuditVerifyResult> {
    const prev = fromSeq > 1 ? get<{ hash: string }>('SELECT hash FROM gov_decisions WHERE seq = ?', [fromSeq - 1])?.hash : GENESIS_HASH;
    if (prev == null) return { ok: false, checked: 0, brokenAt: fromSeq - 1 };
    const rows = all<{ doc: string }>('SELECT doc FROM gov_decisions WHERE seq >= ? ORDER BY seq LIMIT ?', [fromSeq, limit]);
    const items = rows.map(r => JSON.parse(r.doc) as Decision);
    // Row gaps are tampering too: seq must be contiguous.
    for (let i = 0; i < items.length; i++) {
      if (items[i].seq !== fromSeq + i) return { ok: false, checked: i, brokenAt: fromSeq + i };
    }
    const v = verifyChain(items, prev);
    return { ok: v.ok, checked: items.length, brokenAt: v.brokenAt, headHash: v.headHash };
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  async createApproval(a: Approval): Promise<Approval> {
    run('INSERT INTO gov_approvals (id, state, session_id, agent_id, requested_at, doc) VALUES (?, ?, ?, ?, ?, ?)',
      [a.id, a.state, a.sessionId, a.agentId, a.requestedAt, JSON.stringify(a)]);
    return a;
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const r = get<{ doc: string }>('SELECT doc FROM gov_approvals WHERE id = ?', [id]);
    return r ? JSON.parse(r.doc) : undefined;
  }

  async updateApproval(id: string, patch: Partial<Approval>): Promise<Approval | undefined> {
    return transaction(() => {
      const r = get<{ doc: string }>('SELECT doc FROM gov_approvals WHERE id = ?', [id]);
      if (!r) return undefined;
      const current = JSON.parse(r.doc) as Approval;
      if (patch.state && current.state !== 'pending' && patch.state !== current.state) return current;
      const next: Approval = { ...current, ...patch, id };
      if (patch.state && current.state === 'pending') {
        run('UPDATE gov_approvals SET state = ?, doc = ? WHERE id = ? AND state = ?',
          [next.state, JSON.stringify(next), id, 'pending']);
        return JSON.parse(get<{ doc: string }>('SELECT doc FROM gov_approvals WHERE id = ?', [id])!.doc) as Approval;
      }
      run('UPDATE gov_approvals SET state = ?, doc = ? WHERE id = ?', [next.state, JSON.stringify(next), id]);
      return next;
    });
  }

  async listApprovals(q: ApprovalQuery = {}): Promise<Approval[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.state?.length) { where.push(`state IN (${q.state.map(() => '?').join(',')})`); params.push(...q.state); }
    if (q.sessionId) { where.push('session_id = ?'); params.push(q.sessionId); }
    if (q.agentId) { where.push('agent_id = ?'); params.push(q.agentId); }
    return all<{ doc: string }>(
      `SELECT doc FROM gov_approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY requested_at DESC LIMIT ?`,
      [...params, Math.min(q.limit ?? 100, 1000)],
    ).map(r => JSON.parse(r.doc));
  }

  // ── Incidents ────────────────────────────────────────────────────────────

  async createIncident(i: Incident): Promise<Incident> {
    run('INSERT INTO gov_incidents (id, state, created_at, updated_at, doc) VALUES (?, ?, ?, ?, ?)',
      [i.id, i.state, i.createdAt, i.updatedAt, JSON.stringify(i)]);
    return i;
  }

  async getIncident(id: string): Promise<Incident | undefined> {
    const r = get<{ doc: string }>('SELECT doc FROM gov_incidents WHERE id = ?', [id]);
    return r ? JSON.parse(r.doc) : undefined;
  }

  async updateIncident(id: string, patch: Partial<Incident>): Promise<Incident | undefined> {
    return transaction(() => {
      const r = get<{ doc: string }>('SELECT doc FROM gov_incidents WHERE id = ?', [id]);
      if (!r) return undefined;
      const next: Incident = { ...JSON.parse(r.doc), ...patch, id, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      run('UPDATE gov_incidents SET state = ?, updated_at = ?, doc = ? WHERE id = ?', [next.state, next.updatedAt, JSON.stringify(next), id]);
      return next;
    });
  }

  async listIncidents(q: IncidentQuery = {}): Promise<Incident[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.state?.length) { where.push(`state IN (${q.state.map(() => '?').join(',')})`); params.push(...q.state); }
    if (q.since) { where.push('created_at >= ?'); params.push(q.since); }
    let items = all<{ doc: string }>(
      `SELECT doc FROM gov_incidents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`,
      [...params, Math.min(q.limit ?? 100, 1000)],
    ).map(r => JSON.parse(r.doc) as Incident);
    if (q.agentId) items = items.filter(i => i.agentIds.includes(q.agentId!));
    return items;
  }

  // ── Outboxes ─────────────────────────────────────────────────────────────

  async enqueue(box: 'alerts' | 'sync', item: unknown): Promise<void> {
    run('INSERT INTO gov_outbox (id, box, item, created_at) VALUES (?, ?, ?, ?)',
      [crypto.randomUUID(), box, JSON.stringify(item), new Date().toISOString()]);
  }

  async dequeue(box: 'alerts' | 'sync', limit: number): Promise<{ id: string; item: unknown; attempts: number }[]> {
    return transaction(() => {
      // Claims older than 5 minutes are considered abandoned and re-offered.
      const stale = new Date(Date.now() - 5 * 60_000).toISOString();
      const rows = all<{ id: string; item: string; attempts: number }>(
        `SELECT id, item, attempts FROM gov_outbox WHERE box = ? AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY created_at LIMIT ?`,
        [box, stale, limit],
      );
      const now = new Date().toISOString();
      for (const r of rows) run('UPDATE gov_outbox SET claimed_at = ?, attempts = attempts + 1 WHERE id = ?', [now, r.id]);
      return rows.map(r => ({ id: r.id, item: JSON.parse(r.item), attempts: r.attempts + 1 }));
    });
  }

  async ack(_box: 'alerts' | 'sync', ids: string[]): Promise<void> {
    if (!ids.length) return;
    run(`DELETE FROM gov_outbox WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  }

  async nack(_box: 'alerts' | 'sync', ids: string[]): Promise<void> {
    if (!ids.length) return;
    run(`UPDATE gov_outbox SET claimed_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  }
}
