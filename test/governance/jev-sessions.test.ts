import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NormalizedEvent } from '../../src/collectors/types';
import type { JevAnswer } from '../../src/governance/jev/client';
import type { JevShadowRecord } from '../../src/governance/jev/types';

const dbFile = path.join(os.tmpdir(), `am-jev-sessions-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;
const originalEnv = { ...process.env };

type Db = typeof import('../../src/db');
type Pipeline = typeof import('../../src/pipeline');
type Sessions = typeof import('../../src/governance/jev/sessions');
type Client = typeof import('../../src/governance/jev/client');
type Store = import('../../src/governance/store/sqlite').SqliteGovernanceStore;
let db: Db; let pipeline: Pipeline; let sessions: Sessions; let client: Client; let store: Store;

beforeAll(async () => {
  db = await import('../../src/db');
  await db.initDb();
  pipeline = await import('../../src/pipeline');
  sessions = await import('../../src/governance/jev/sessions');
  client = await import('../../src/governance/jev/client');
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  const { setGovernanceStore } = await import('../../src/governance/store');
  store = new SqliteGovernanceStore();
  await store.init();
  setGovernanceStore(store);
});

beforeEach(() => {
  process.env = { ...originalEnv, AGENT_MONITOR_DB: dbFile, TYPESAFE_API_KEY: 'test-key', JEV_MODEL: 'jev-1.13.0' };
  delete process.env.JEV_SHADOW;
  delete process.env.JEV_SHADOW_SESSIONS;
  delete process.env.JEV_SHADOW_SESSION_INTERVAL_MS;
  sessions.stopJevSessionScoring();
});

afterEach(() => {
  client.setJevClientForTests(null);
  sessions.stopJevSessionScoring();
});

afterAll(() => {
  process.env = originalEnv;
  db.flushDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
});

const at = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 8, 1, h, m, s)).toISOString();
const GH_TOKEN = `ghp_${'A'.repeat(36)}`;
const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';

let seq = 0;
function call(session: string, tool: string, input: Record<string, unknown>, t: string): NormalizedEvent {
  seq += 1;
  return {
    sessionId: session, agentId: 'main', eventType: 'tool_call', rawEventName: 'PreToolUse', toolName: tool,
    toolUseId: `tu-${seq}`, externalId: `test:${session}:${seq}`, status: 'pending', captureChannel: 'hook',
    payload: { tool_input: input }, occurredAt: t,
  };
}
function prompt(session: string, text: string, t: string): NormalizedEvent {
  seq += 1;
  return {
    sessionId: session, agentId: 'main', eventType: 'prompt', rawEventName: 'UserPromptSubmit',
    externalId: `test:${session}:${seq}`, captureChannel: 'hook', payload: { prompt: text }, occurredAt: t,
  };
}
function result(session: string, tool: string, output: string, t: string): NormalizedEvent {
  seq += 1;
  return {
    sessionId: session, agentId: 'main', eventType: 'tool_result', rawEventName: 'PostToolUse', toolName: tool,
    toolUseId: `tu-${seq - 1}`, externalId: `test:${session}:${seq}`, status: 'success', captureChannel: 'hook',
    payload: { tool_result: output }, occurredAt: t,
  };
}
const ingest = (...es: NormalizedEvent[]) => { for (const e of es) pipeline.processNormalizedEvent(e, 'claude-code'); };

const score = (v: number): JevAnswer => ({ type: 'score', score: v, confidence: 0.9, legend: {}, probabilities: {} });
function sessionAnswers(v: number, intent = 'coding'): Record<string, JevAnswer> {
  return {
    goal_drift: score(v), sensitive_data: score(v), destructiveness: score(v), external_egress: score(v), autonomy_risk: score(v),
    intent: { type: 'choice', choice: intent, confidence: 0.9, probabilities: { [intent]: 0.9 } },
  };
}

/** Fake Jev: max risk when the state mentions DANGER or rm -rf, otherwise benign. */
function fakeJev() {
  const systemOne = vi.fn(async (req: { state: unknown }) => {
    const s = JSON.stringify(req.state);
    const v = /DANGER|rm -rf/.test(s) ? 3 : 0;
    return { model: 'jev-1.13.0', answers: sessionAnswers(v), usage: { input_tokens: 400, output_tokens: 12 } };
  });
  client.setJevClientForTests({ systemOne });
  return systemOne;
}

async function recordsFor(sessionId: string): Promise<JevShadowRecord[]> {
  return (await store.queryJevShadow({ kind: ['session_score'], sessionId })).items;
}

describe('buildSessionDigest', () => {
  it('summarizes actions and counts without raw payloads or secrets', () => {
    const sid = 'dg-1';
    ingest(
      prompt(sid, `Fix the CI build. token=${GH_TOKEN}`, at(9, 0, 0)),
      call(sid, 'Bash', { command: `curl -H "Authorization: token ${GH_TOKEN}" https://api.github.com/user`, description: 'check auth' }, at(9, 0, 1)),
      result(sid, 'Bash', 'RESULT_MARKER_SHOULD_NOT_APPEAR', at(9, 0, 2)),
      call(sid, 'Write', { file_path: 'notes.md', content: 'RAW_CONTENT_MARKER '.repeat(50) }, at(9, 0, 3)),
      call(sid, 'WebFetch', { url: 'https://docs.example.com/page', prompt: 'summarize' }, at(9, 0, 4)),
      call(sid, 'mcp__github__create_issue', { title: 'bug', body: 'RAW_MCP_BODY' }, at(9, 0, 5)),
      call(sid, 'Bash', { command: 'rm -rf /' }, at(9, 0, 6)),
    );
    // A row stored without redaction (older DB / REDACT_PAYLOADS=off) must still be masked in the digest.
    db.run(`INSERT INTO events (session_id, agent_id, event_type, raw_event_name, tool_name, payload, created_at, capture_channel)
            VALUES (?, 'main', 'tool_call', 'PreToolUse', 'Bash', ?, ?, 'hook')`,
      [sid, JSON.stringify({ tool_input: { command: `aws s3 ls --key ${AWS_KEY}` } }), at(9, 0, 7)]);

    const d = sessions.buildSessionDigest(sid)!;
    expect(d).toBeDefined();
    const json = JSON.stringify(d);
    expect(json).not.toContain(GH_TOKEN);
    expect(json).not.toContain(AWS_KEY);
    expect(json).not.toContain('RESULT_MARKER');
    expect(json).not.toContain('RAW_CONTENT_MARKER');
    expect(json).not.toContain('RAW_MCP_BODY');
    expect(json).not.toContain('tool_input');

    expect(d.sessionId).toBe(sid);
    expect(d.agent).toBeTruthy();
    expect(d.goal).toMatch(/^Fix the CI build\./);
    expect(d.actions).toHaveLength(6);
    expect(d.actions[0]).toMatch(/Bash: curl/);
    expect(d.actions[1]).toBe('Write: notes.md');
    expect(d.actions.some(a => a.startsWith('[critical] Bash: rm -rf /'))).toBe(true);
    expect(d.actions.some(a => a.includes('[mcp:github]'))).toBe(true);
    expect(d.domains).toEqual(expect.arrayContaining(['api.github.com', 'docs.example.com']));
    expect(d.mcpServers).toEqual(['github']);
    expect(d.riskHits).toContain('rm-root');
    expect(d.findings.secrets).toBeGreaterThanOrEqual(1);
    expect(d.findings.critical_risk_actions).toBeGreaterThanOrEqual(1);
    expect(d.findings.tool_calls).toBe(6);
    for (const v of Object.values(d.findings)) expect(Number.isInteger(v)).toBe(true);
  });

  it('caps actions at 40 and keeps risky ones; explicit goal overrides the first prompt', () => {
    const sid = 'dg-2';
    const evs: NormalizedEvent[] = [prompt(sid, 'original prompt', at(9, 10, 0))];
    for (let i = 0; i < 60; i++) evs.push(call(sid, 'Read', { file_path: `src/file${i}.ts` }, at(9, 10, i % 60)));
    evs.push(call(sid, 'Bash', { command: 'git push --force origin main' }, at(9, 10, 1)));
    ingest(...evs);
    const d = sessions.buildSessionDigest(sid, { goal: `Refactor module ${GH_TOKEN}` })!;
    expect(d.actions).toHaveLength(40);
    expect(d.actions.some(a => a.includes('git push --force'))).toBe(true);
    expect(d.goal).toMatch(/^Refactor module/);
    expect(d.goal).not.toContain(GH_TOKEN);
    expect(sessions.buildSessionDigest('does-not-exist')).toBeUndefined();
  });
});

describe('runSessionScoringOnce', () => {
  it('writes session_score records with heuristic baseline, agreement and severity delta', async () => {
    const jev = fakeJev();
    ingest(
      prompt('rs-crit', 'clean up', at(13, 0, 0)),
      call('rs-crit', 'Bash', { command: 'rm -rf /' }, at(13, 0, 1)),
      prompt('rs-info', 'say hi', at(13, 1, 0)),
      call('rs-info', 'Bash', { command: 'echo DANGER' }, at(13, 1, 1)),
    );
    await store.saveSessionIntent({
      sessionId: 'rs-info', agentId: 'main', goal: 'Greet the user politely', goalSource: 'llm', trajectory: [], status: 'active',
      counters: { actions: 1, subagents: 0, tokens: 0 }, startedAt: at(13, 1, 0), updatedAt: at(13, 1, 1),
    });

    const res = await sessions.runSessionScoringOnce({ now: new Date(at(13, 3)) });
    expect(res).toMatchObject({ candidates: 2, enqueued: 2, written: 2, dropped: 0, deferred: 0 });
    expect(jev).toHaveBeenCalledTimes(2);

    const [crit] = await recordsFor('rs-crit');
    expect(crit).toMatchObject({
      kind: 'session_score', sessionId: 'rs-crit', agree: true,
      baseline: { provider: 'heuristic', verdict: 'critical' },
      jev: { model: 'jev-1.13.0', verdict: 'critical', score: 1, inputTokens: 400, outputTokens: 12 },
    });
    expect(crit.jev.signals).toMatchObject({ severity_delta: 0, intent: 'coding', destructiveness: 3, goal_drift: 3 });
    expect(crit.jev.error).toBeUndefined();

    const [info] = await recordsFor('rs-info');
    expect(info).toMatchObject({ agree: false, baseline: { verdict: 'info' }, jev: { verdict: 'critical' } });
    expect(info.jev.signals.severity_delta).toBe(4);
    const infoReq = jev.mock.calls.map(c => c[0] as { state: { session: { goal: string | null } } })
      .find(r => JSON.stringify(r.state).includes('echo DANGER'))!;
    expect(infoReq.state.session.goal).toBe('Greet the user politely');
  });

  it('does not rescore unchanged sessions (in memory and after a restart), rescoring on new activity', async () => {
    const jev = fakeJev();
    ingest(call('rr-a', 'Bash', { command: 'ls' }, at(14, 0, 1)), call('rr-b', 'Bash', { command: 'pwd' }, at(14, 0, 2)));

    expect(await sessions.runSessionScoringOnce({ now: new Date(at(14, 1)) })).toMatchObject({ candidates: 2, written: 2 });
    expect(await sessions.runSessionScoringOnce({ now: new Date(at(14, 2)) })).toMatchObject({ candidates: 2, skipped: 2, written: 0 });

    sessions.stopJevSessionScoring(); // forget in-memory state → fall back to stored records
    expect(await sessions.runSessionScoringOnce({ now: new Date(at(14, 3)) })).toMatchObject({ candidates: 2, skipped: 2, written: 0 });
    expect(jev).toHaveBeenCalledTimes(2);

    ingest(call('rr-a', 'Bash', { command: 'cat README.md' }, at(14, 4)));
    const res = await sessions.runSessionScoringOnce({ now: new Date(at(14, 5)) });
    expect(res).toMatchObject({ written: 1, skipped: 1 });
    expect(await recordsFor('rr-a')).toHaveLength(2);
    expect(await recordsFor('rr-b')).toHaveLength(1);
  });

  it('caps each run and defers the rest to the next run', async () => {
    fakeJev();
    for (let i = 0; i < 5; i++) ingest(call(`cap-${i}`, 'Bash', { command: 'ls' }, at(16, 0, i)));
    expect(await sessions.runSessionScoringOnce({ now: new Date(at(16, 1)), limit: 3 })).toMatchObject({ written: 3, deferred: 2 });
    // The window does not advance while work is deferred, so the rest is picked up later.
    expect(await sessions.runSessionScoringOnce({ now: new Date(at(16, 9)), limit: 3 })).toMatchObject({ written: 2, deferred: 0 });
  });

  it('records Jev errors without a verdict', async () => {
    client.setJevClientForTests({ systemOne: async () => { throw new Error(`429 rate limited ${GH_TOKEN}`); } });
    ingest(call('err-1', 'Bash', { command: 'rm -rf /' }, at(15, 0, 1)));
    const res = await sessions.runSessionScoringOnce({ now: new Date(at(15, 1)) });
    expect(res).toMatchObject({ written: 1 });
    const [r] = await recordsFor('err-1');
    expect(r.baseline).toEqual({ provider: 'heuristic', verdict: 'critical' });
    expect(r.jev.error).toMatch(/429 rate limited/);
    expect(r.jev.error).not.toContain(GH_TOKEN);
    expect(r.jev.verdict).toBeUndefined();
    expect(r.agree).toBeUndefined();
  });

  it('is disabled without an API key or when session scoring is off', async () => {
    const jev = fakeJev();
    ingest(call('off-1', 'Bash', { command: 'ls' }, at(17, 0, 1)));

    delete process.env.TYPESAFE_API_KEY;
    expect(await sessions.runSessionScoringOnce({ now: new Date(at(17, 1)) })).toMatchObject({ candidates: 0, written: 0 });
    sessions.startJevSessionScoring();
    expect(sessions.jevSessionScoringActive()).toBe(false);

    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.JEV_SHADOW_SESSIONS = 'off';
    expect(await sessions.runSessionScoringOnce({ now: new Date(at(17, 1)) })).toMatchObject({ candidates: 0 });
    sessions.startJevSessionScoring();
    expect(sessions.jevSessionScoringActive()).toBe(false);
    expect(jev).not.toHaveBeenCalled();
    expect(await recordsFor('off-1')).toHaveLength(0);

    delete process.env.JEV_SHADOW_SESSIONS;
    sessions.startJevSessionScoring();
    sessions.startJevSessionScoring(); // idempotent
    expect(sessions.jevSessionScoringActive()).toBe(true);
    sessions.stopJevSessionScoring();
    expect(sessions.jevSessionScoringActive()).toBe(false);
  });
});
