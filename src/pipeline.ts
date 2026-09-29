import { NormalizedEvent } from './collectors/types';
import {
  upsertSession, upsertAgent, insertEvent, insertFindings, correlateChannels, isDuplicate, eventCwd, sessionCwdCached, reconcileDenials,
} from './store';
import { broadcast } from './broadcast';
import { analyzeEvent, ANALYSIS_VERSION } from './analytics/analyze';
import { detectorClass, type Detection } from './analytics/detectors';
import { REDACTION_MODE, redactDeep, redactString, weakerRedactionSql } from './analytics/redact';
import { rules } from './analytics/rules';
import { all, get, getPollerState, maybeTruncateWal, run, setPollerState, transaction } from './db';
import { buildLiveUpdate, EventRow, FindingRow } from './timeline';

const LIVE_WINDOW_MS = 10 * 60_000;

export function processNormalizedEvent(e: NormalizedEvent, collectorId: string): void {
  try {
    if (isDuplicate(e)) return;
    if (!e.captureChannel) {
      e.captureChannel = collectorId === 'copilot-cli' ? 'log'
        : (collectorId === 'claude-code' || collectorId === 'copilot-cli-hooks') ? 'hook' : 'poll';
    }
    upsertSession(e, collectorId);
    upsertAgent(e);
    // Analyze the full, unredacted content first; only the redacted form is stored.
    const analysis = analyzeEvent({
      eventType: e.eventType, rawEventName: e.rawEventName, toolName: e.toolName,
      status: e.status, errorText: e.errorText, payload: e.payload, scanText: e.scanText,
      cwd: eventCwd(e) ?? sessionCwdCached(e.sessionId),
      policy: e.policy,
    });
    e.payload = redactDeep(e.payload);
    if (e.errorText) e.errorText = redactString(e.errorText);
    const id = insertEvent(e, analysis, true);
    if (!id) return;
    const findings = reconcileDenials(id, e.sessionId, e.eventType, e.toolUseId, e.payload, analysis.findings);
    insertFindings(id, e.sessionId, e.occurredAt, findings);
    correlateChannels(id, e);
    notifyInserted(id, e.sessionId, e.occurredAt);
  } catch (err) {
    console.error(`[pipeline] store error for ${collectorId}:`, err);
  }
}

// ── Live notifications ────────────────────────────────────────────────────

const pendingSessions = new Set<string>();
let sessionTimer: ReturnType<typeof setTimeout> | null = null;

/** Broadcast a timeline update (recent events only) and a throttled session/stats change signal. */
export function notifyInserted(id: number, sessionId: string, occurredAt: string): void {
  if (Date.now() - new Date(occurredAt).getTime() < LIVE_WINDOW_MS) {
    const row = get<EventRow>('SELECT * FROM events WHERE id = ?', [id]);
    if (row) {
      const findings = all<FindingRow>('SELECT * FROM findings WHERE event_id = ?', [id]);
      const update = buildLiveUpdate(row, findings);
      if (update) broadcast({ type: 'timeline', sessionId, update });
    }
  }
  pendingSessions.add(sessionId);
  if (!sessionTimer) {
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      const ids = [...pendingSessions];
      pendingSessions.clear();
      broadcast({ type: 'sessions.updated', sessionIds: ids.slice(0, 200) });
    }, 1000);
  }
}

// ── Background maintenance: re-analysis and payload redaction of stored events ──

export const maintenance = { running: false, processed: 0, startedAt: null as string | null };

function analysisFingerprint(): string {
  return `${ANALYSIS_VERSION}:${rules().fingerprint}`;
}

/** Mark all stored events for re-analysis when the analysis version or rules file changed. */
function invalidateIfRulesChanged(): void {
  const fp = analysisFingerprint();
  if (getPollerState('analytics', 'fingerprint', '') !== fp) {
    run('UPDATE events SET analysis_version = NULL WHERE analysis_version IS NOT NULL');
    setPollerState('analytics', 'fingerprint', fp);
  }
}

type MaintRow = EventRow & { project_path: string | null; redaction: string | null; analysis_version: number | null; needs_redaction: number };

function processStoredRow(r: MaintRow): void {
  let payload: unknown = {};
  try { payload = r.payload ? JSON.parse(r.payload) : {}; } catch { /* keep {} */ }
  const needsAnalysis = r.analysis_version == null || r.analysis_version < ANALYSIS_VERSION;

  if (needsAnalysis) {
    // Redacted rows can no longer be scanned, so keep the detections recorded at ingest.
    let knownDetections: Detection[] | undefined;
    if (r.redaction && r.redaction !== 'off') {
      knownDetections = all<{ key: string; label: string; masked_sample: string | null }>(
        `SELECT key, label, masked_sample FROM findings WHERE event_id = ? AND kind = 'detector'`, [r.id],
      ).map(f => ({ key: f.key, label: f.label, cls: detectorClass(f.key), maskedSample: f.masked_sample ?? '' }));
    }
    const a = analyzeEvent({
      eventType: r.event_type, rawEventName: r.raw_event_name, toolName: r.tool_name,
      status: r.status, errorText: r.error_text, payload, cwd: r.project_path, knownDetections,
    });
    run('DELETE FROM findings WHERE event_id = ?', [r.id]);
    run(
      `UPDATE events SET category = ?, mcp_server = ?, risk_level = ?, analysis_version = ?,
         capture_channel = COALESCE(capture_channel, 'hook') WHERE id = ?`,
      [a.category, a.mcpServer, a.riskLevel, ANALYSIS_VERSION, r.id],
    );
    insertFindings(r.id, r.session_id, r.created_at, reconcileDenials(r.id, r.session_id, r.event_type, r.tool_use_id, payload, a.findings));
  }

  if (r.needs_redaction === 1) {
    if (REDACTION_MODE === 'off') {
      run(`UPDATE events SET redaction = 'off' WHERE id = ?`, [r.id]);
    } else {
      const red = redactDeep(payload);
      const err = r.error_text ? redactString(r.error_text) : r.error_text;
      run('UPDATE events SET payload = ?, error_text = ?, redaction = ? WHERE id = ?', [JSON.stringify(red), err, REDACTION_MODE, r.id]);
    }
  }
}

function redactSessionTitles(): void {
  if (REDACTION_MODE === 'off') return;
  for (const s of all<{ id: string; title: string }>('SELECT id, title FROM sessions WHERE title IS NOT NULL')) {
    const t = redactString(s.title);
    if (t !== s.title) run('UPDATE sessions SET title = ? WHERE id = ?', [t, s.id]);
  }
}

/** Start the background pass (re-analysis + redaction of stored events); safe to call repeatedly. */
export function startAnalysisBackfill(): void {
  invalidateIfRulesChanged();
  if (maintenance.running) return;
  maintenance.running = true;
  maintenance.processed = 0;
  maintenance.startedAt = new Date().toISOString();
  const redactWhere = weakerRedactionSql().replace(/redaction/g, 'e.redaction');

  const batch = () => {
    let done = 0;
    try {
      transaction(() => {
        const rows = all<MaintRow>(
          `SELECT e.*, s.project_path, (CASE WHEN ${redactWhere} THEN 1 ELSE 0 END) AS needs_redaction
           FROM events e LEFT JOIN sessions s ON s.id = e.session_id
           WHERE e.analysis_version IS NULL OR e.analysis_version < ? OR ${redactWhere}
           ORDER BY e.id LIMIT 500`,
          [ANALYSIS_VERSION],
        );
        for (const r of rows) processStoredRow(r);
        done = rows.length;
      });
      maybeTruncateWal();
    } catch (err) {
      console.error('[maintenance] backfill error:', err);
      maintenance.running = false;
      return;
    }
    maintenance.processed += done;
    if (done > 0) {
      setImmediate(batch);
      return;
    }
    try { redactSessionTitles(); } catch (err) { console.error('[maintenance] title redaction error:', err); }
    maintenance.running = false;
    if (maintenance.processed) console.log(`[maintenance] re-analyzed/redacted ${maintenance.processed} stored events`);
    broadcast({ type: 'sessions.updated', sessionIds: [] });
  };
  setImmediate(batch);
}
