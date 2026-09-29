import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NormalizedEvent } from '../src/collectors/types';

const dbFile = path.join(os.tmpdir(), `am-pipeline-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;

type Db = typeof import('../src/db');
type Pipeline = typeof import('../src/pipeline');
type Queries = typeof import('../src/queries');
type Timeline = typeof import('../src/timeline');
let db: Db; let pipeline: Pipeline; let queries: Queries; let timeline: Timeline;

beforeAll(async () => {
  db = await import('../src/db');
  pipeline = await import('../src/pipeline');
  queries = await import('../src/queries');
  timeline = await import('../src/timeline');
  await db.initDb();
});

afterAll(() => {
  db.flushDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
});

const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, s)).toISOString();

function logCall(session: string, id: string, command: string, s: number): NormalizedEvent {
  return {
    sessionId: session, agentId: 'main', eventType: 'tool_call', rawEventName: 'PreToolUse', toolName: 'powershell',
    toolUseId: id, externalId: `copilot-cli:${session}:${id}`, status: 'pending', captureChannel: 'log',
    payload: { tool_input: { command, description: 'x' } }, occurredAt: at(s),
  };
}

function hookCall(session: string, command: string, s: number): NormalizedEvent {
  return {
    sessionId: session, agentId: 'main', eventType: 'tool_call', rawEventName: 'PreToolUse', toolName: 'Bash',
    status: 'pending', captureChannel: 'hook', payload: { tool_input: { command } }, occurredAt: at(s),
  };
}

describe('ingest pipeline', () => {
  it('links a hook event to its log twin and hides the duplicate', () => {
    pipeline.processNormalizedEvent(logCall('s1', 'c1', 'git status', 0), 'copilot-cli');
    pipeline.processNormalizedEvent(logCall('s1', 'c2', 'npm test', 1), 'copilot-cli');
    pipeline.processNormalizedEvent(hookCall('s1', 'npm test', 1), 'copilot-cli-hooks');

    const rows = db.all<{ id: number; capture_channel: string; correlated_event_id: number | null }>(
      'SELECT id, capture_channel, correlated_event_id FROM events WHERE session_id = ? ORDER BY id', ['s1']);
    const [first, second, hook] = rows;
    expect(hook.capture_channel).toBe('hook');
    expect(hook.correlated_event_id).toBe(second.id);   // matched by command, not just by time
    expect(first.correlated_event_id).toBeNull();

    const events = db.all<import('../src/timeline').EventRow>('SELECT * FROM events WHERE session_id = ? ORDER BY created_at, id', ['s1']);
    const items = timeline.buildTimeline(events, []);
    expect(items).toHaveLength(2);
    expect(items.find(i => i.id === second.id)).toMatchObject({ kind: 'tool', hook: true });

    const conv = queries.listConversations(null, { ids: ['s1'] })[0];
    expect(conv.actions).toBe(2);
    expect(conv.channels).toEqual(['log']);
    expect(conv.agentName).toBe('Copilot CLI');
  });

  it('keeps unmatched hook events visible as hook-only', () => {
    pipeline.processNormalizedEvent(logCall('s2', 'c3', 'ls', 0), 'copilot-cli');
    pipeline.processNormalizedEvent(hookCall('s2', 'rm -rf /', 2), 'copilot-cli-hooks');
    const conv = queries.listConversations(null, { ids: ['s2'] })[0];
    expect(conv.channels.sort()).toEqual(['hook', 'log']);
    expect(conv.severity).toBe('critical');
    expect(conv.riskyActions).toBe(1);
  });

  it('dedupes events by external id and records findings', () => {
    const e: NormalizedEvent = {
      sessionId: 's3', agentId: 'main', eventType: 'prompt', rawEventName: 'UserPromptSubmit', externalId: 'x:1', captureChannel: 'log',
      payload: { prompt: 'deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, occurredAt: at(0),
    };
    pipeline.processNormalizedEvent(e, 'copilot-cli');
    pipeline.processNormalizedEvent(e, 'copilot-cli');
    expect(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events WHERE session_id = ?', ['s3'])?.c).toBe(1);
    const conv = queries.listConversations(null, { ids: ['s3'] })[0];
    expect(conv.title).toContain('deploy with');
    expect(conv.detectors.map(d => d.key)).toContain('github_token');
    const samples = db.all<{ masked_sample: string }>('SELECT masked_sample FROM findings WHERE session_id = ?', ['s3']);
    expect(samples.every(s => !s.masked_sample?.includes('abcdefghijklmnop'))).toBe(true);
  });

  it('redacts secrets in stored payloads and titles by default', () => {
    const row = db.get<{ payload: string; redaction: string }>('SELECT payload, redaction FROM events WHERE session_id = ?', ['s3'])!;
    expect(row.redaction).toBe('secrets');
    expect(row.payload).not.toContain('abcdefghijklmnop');
    expect(row.payload).toContain('ghp_****6789');
    const conv = queries.listConversations(null, { ids: ['s3'] })[0];
    expect(conv.title).not.toContain('abcdefghijklmnop');
  });

  const permissionDenied = (session: string, s: number): NormalizedEvent => {
    const policy = { outcome: 'denied' as const, label: 'Denied by user: read · C:\\secret.txt' };
    return {
      sessionId: session, agentId: 'main', eventType: 'lifecycle', rawEventName: 'PermissionResult', captureChannel: 'log',
      externalId: `perm:${session}`, policy, payload: { _policy: policy, toolCallId: 'call-9' }, occurredAt: at(s),
    };
  };
  const failedResult = (session: string, s: number): NormalizedEvent => ({
    sessionId: session, agentId: 'main', eventType: 'tool_result', rawEventName: 'PostToolUse', toolName: 'view', toolUseId: 'call-9',
    externalId: `res:${session}`, status: 'error', errorText: 'The user denied permission to read this file.', captureChannel: 'log',
    payload: { tool_result: '' }, occurredAt: at(s),
  });
  const denials = (session: string) =>
    db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM findings WHERE session_id = ? AND kind = 'policy' AND key = 'denied'`, [session])?.c;

  it('counts a permission denial once when the tool error arrives after the permission event', () => {
    pipeline.processNormalizedEvent(permissionDenied('d1', 0), 'copilot-cli');
    pipeline.processNormalizedEvent(failedResult('d1', 1), 'copilot-cli');
    expect(denials('d1')).toBe(1);
    expect(queries.listConversations(null, { ids: ['d1'] })[0].enforcement.denied).toBe(1);
  });

  it('counts a permission denial once when the tool error arrives first', () => {
    pipeline.processNormalizedEvent(failedResult('d2', 0), 'copilot-cli');
    expect(denials('d2')).toBe(1);
    pipeline.processNormalizedEvent(permissionDenied('d2', 1), 'copilot-cli');
    expect(denials('d2')).toBe(1);
    const label = db.get<{ label: string }>(`SELECT label FROM findings WHERE session_id = ? AND kind = 'policy'`, ['d2'])?.label;
    expect(label).toContain('Denied by user');
  });

  it('still records an inferred denial when the agent reports no permission event', () => {
    pipeline.processNormalizedEvent(failedResult('d3', 0), 'claude-code');
    expect(denials('d3')).toBe(1);
  });

  it('redacts and re-analyzes rows stored by older versions in the background pass', async () => {
    db.run(`INSERT INTO sessions (id, source, agent_key, started_at, last_activity_at, title) VALUES ('old', 'claude-code', 'claude-code', ?, ?, ?)`,
      [at(0), at(0), 'use key AKIAABCDEFGHIJKLMNOP now']);
    db.run(`INSERT INTO events (session_id, agent_id, event_type, raw_event_name, payload, created_at)
            VALUES ('old', 'main', 'prompt', 'UserPromptSubmit', ?, ?)`, [JSON.stringify({ prompt: 'use key AKIAABCDEFGHIJKLMNOP now' }), at(0)]);
    pipeline.startAnalysisBackfill();
    for (let i = 0; i < 50 && pipeline.maintenance.running; i++) await new Promise(r => setTimeout(r, 20));
    const row = db.get<{ payload: string; redaction: string; analysis_version: number }>(`SELECT payload, redaction, analysis_version FROM events WHERE session_id = 'old'`)!;
    expect(row.redaction).toBe('secrets');
    expect(row.analysis_version).not.toBeNull();
    expect(row.payload).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(db.get<{ key: string }>(`SELECT key FROM findings WHERE session_id = 'old' AND kind = 'detector'`)?.key).toBe('aws_key');
    expect(db.get<{ title: string }>(`SELECT title FROM sessions WHERE id = 'old'`)?.title).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});
