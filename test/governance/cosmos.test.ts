import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, hashDecision } from '../../src/governance/audit';
import { CosmosGovernanceStore } from '../../src/governance/store/cosmos';
import type { Approval, Decision, Incident, Lane, LaneRecord } from '../../src/governance/types';

type Doc = Record<string, any>;
class CosmosError extends Error { constructor(public code: number, msg: string) { super(msg); } }
class FakeItem {
  constructor(private c: FakeContainer, private id: string, private pk: string) {}
  async read() { const d = this.c.get(this.pk, this.id); if (!d) throw new CosmosError(404, 'not found'); return { resource: clone(d) }; }
  async replace(doc: Doc, opts?: any) {
    const current = this.c.get(this.pk, this.id);
    if (!current) throw new CosmosError(404, 'not found');
    const expected = opts?.accessCondition?.condition;
    if (expected && current._etag !== expected) throw new CosmosError(412, 'etag');
    this.c.maybeFailHeadReplace(this.id);
    const saved = this.c.put(this.pk, this.id, doc);
    return { resource: clone(saved) };
  }
  async delete() { this.c.delete(this.pk, this.id); return {}; }
}
class FakeContainer {
  public items: any;
  public failNextHeadReplace = false;
  public failNextHeadReplaceCode: number | undefined;
  private docs = new Map<string, Map<string, Doc>>();
  private etag = 0;
  constructor(public id: string) {
    this.items = {
      create: async (doc: Doc) => { const pk = this.pk(doc); const id = String(doc.id); if (this.get(pk, id)) throw new CosmosError(409, 'conflict'); return { resource: clone(this.put(pk, id, doc)) }; },
      upsert: async (doc: Doc) => ({ resource: clone(this.put(this.pk(doc), String(doc.id), doc)) }),
      query: (q: any, opts: any = {}) => new FakeQuery(this, q, opts),
      batch: async (ops: any[], pk: string) => {
        const backups = new Map<string, Doc | undefined>();
        try {
          const resources: Doc[] = [];
          for (const op of ops) {
            const id = String(op.id ?? op.resourceBody?.id);
            if (!backups.has(id)) {
              const current = this.get(pk, id);
              backups.set(id, current ? clone(current) : undefined);
            }
            if (op.operationType === 'Create') {
              if (this.get(pk, id)) throw new CosmosError(409, 'conflict');
              resources.push(this.put(pk, id, op.resourceBody));
            } else if (op.operationType === 'Replace') {
              const current = this.get(pk, id);
              if (!current) throw new CosmosError(404, 'not found');
              if (op.ifMatch && current._etag !== op.ifMatch) throw new CosmosError(412, 'etag');
              this.maybeFailHeadReplace(id);
              resources.push(this.put(pk, id, op.resourceBody));
            }
          }
          return { result: resources.map(clone) };
        } catch (err) {
          for (const [id, doc] of backups) {
            if (doc) this.docs.get(pk)?.set(id, doc);
            else this.docs.get(pk)?.delete(id);
          }
          throw err;
        }
      },
    };
  }
  item(id: string, pk: string) { return new FakeItem(this, id, pk); }
  allDocs() { return [...this.docs.values()].flatMap(m => [...m.values()]).map(clone); }
  get(pk: string, id: string) { return this.docs.get(pk)?.get(id); }
  put(pk: string, id: string, doc: Doc) { const m = this.docs.get(pk) ?? new Map<string, Doc>(); this.docs.set(pk, m); const saved = { ...clone(doc), id, _etag: `e${++this.etag}` }; m.set(id, saved); return saved; }
  delete(pk: string, id: string) { this.docs.get(pk)?.delete(id); }
  maybeFailHeadReplace(id: string) {
    if (id !== 'head') return;
    const code = this.failNextHeadReplaceCode ?? (this.failNextHeadReplace ? 412 : undefined);
    if (code) {
      this.failNextHeadReplace = false;
      this.failNextHeadReplaceCode = undefined;
      throw new CosmosError(code, 'injected');
    }
  }
  private pk(doc: Doc): string {
    if (this.id === 'outbox') return String(doc.box);
    if (this.id === 'jev_shadow') return String(doc.pk);
    if (this.id === 'decisions' || this.id === 'sessions' || this.id === 'events') return String(doc.sessionId);
    return String(doc.tenantId);
  }
}
class FakeQuery {
  constructor(private c: FakeContainer, private q: any, private opts: any) {}
  async fetchAll() { return { resources: this.result().resources }; }
  async fetchNext() { return this.result(); }
  private result() {
    const sql = String(this.q.query ?? '');
    const params = new Map<string, any>((this.q.parameters ?? []).map((p: any) => [p.name, p.value]));
    let rows = this.c.allDocs().filter(d => matches(d, sql, params));
    if (sql.includes('ORDER BY c.createdAt DESC')) rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    else if (sql.includes('ORDER BY c.created_at DESC')) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    else if (sql.includes('ORDER BY c.createdAt ASC')) rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    else if (sql.includes('ORDER BY c.requestedAt DESC')) rows.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
    else if (sql.includes('ORDER BY c.lane.version DESC')) rows.sort((a, b) => (b.lane?.version ?? 0) - (a.lane?.version ?? 0));
    else if (sql.includes('ORDER BY c.seq ASC')) rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    else if (sql.includes('ORDER BY c.createdAt ASC')) rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const max = this.opts.maxItemCount ?? params.get('@limit') ?? rows.length;
    const offset = Number(this.opts.continuationToken ?? 0);
    const resources = rows.slice(offset, offset + max);
    return { resources, continuationToken: offset + max < rows.length ? String(offset + max) : undefined };
  }
}
function matches(d: Doc, sql: string, p: Map<string, any>) {
  if (p.has('@tenantId') && d.tenantId !== p.get('@tenantId')) return false;
  if (sql.includes('c.kind = "lane"') && d.kind !== 'lane') return false;
  if (sql.includes('c.kind = "audit-decision"') && d.kind !== 'audit-decision') return false;
  if (sql.includes('c.lane.id = @id') && d.lane?.id !== p.get('@id')) return false;
  if (sql.includes('c.id = @id') && d.id !== p.get('@id')) return false;
  if (sql.includes('c.status = "active"') && d.status !== 'active') return false;
  if (sql.includes('ARRAY_CONTAINS(@status') && !p.get('@status').includes(d.status)) return false;
  if (sql.includes('c.surface = @surface') && d.surface !== p.get('@surface')) return false;
  if (sql.includes('c.externalId = @externalId') && d.externalId !== p.get('@externalId')) return false;
  if (sql.includes('c.sessionId = @sessionId') && d.sessionId !== p.get('@sessionId')) return false;
  if (sql.includes('c.agentId = @agentId') && d.agentId !== p.get('@agentId')) return false;
  if (sql.includes('c.laneId = @laneId') && d.laneId !== p.get('@laneId')) return false;
  if (sql.includes('c.toolName = @toolName') && d.toolName !== p.get('@toolName')) return false;
  if (sql.includes('ARRAY_CONTAINS(@verdict') && !p.get('@verdict').includes(d.effectiveVerdict)) return false;
  if (sql.includes('c.wouldDeny = @wouldDeny') && d.wouldDeny !== p.get('@wouldDeny')) return false;
  if (sql.includes('c.createdAt >= @since') && d.createdAt < p.get('@since')) return false;
  if (sql.includes('c.createdAt < @until') && d.createdAt >= p.get('@until')) return false;
  if (sql.includes('c.createdAt < @before') && d.createdAt >= p.get('@before')) return false;
  if (sql.includes('ARRAY_CONTAINS(@kind') && !p.get('@kind').includes(d.kind)) return false;
  if (sql.includes('c.agree = @agree') && d.agree !== p.get('@agree')) return false;
  if (sql.includes('c.seq >= @fromSeq') && d.seq < p.get('@fromSeq')) return false;
  if (sql.includes('ARRAY_CONTAINS(@state') && !p.get('@state').includes(d.state)) return false;
  if (sql.includes('ARRAY_CONTAINS(c.agentIds') && !d.agentIds?.includes(p.get('@agentId'))) return false;
  if (sql.includes("c.kind = 'fleet_alert'") && d.kind !== 'fleet_alert') return false;
  if (sql.includes('ARRAY_CONTAINS(@severity') && !p.get('@severity').includes(d.severity)) return false;
  if (sql.includes('ARRAY_CONTAINS(@types') && !p.get('@types').includes(d.alert_type)) return false;
  if (sql.includes('ARRAY_CONTAINS(@platform') && !p.get('@platform').includes(d.platform)) return false;
  if (sql.includes('c.session_id = @sid') && d.session_id !== p.get('@sid')) return false;
  if (sql.includes('c.created_at >= @since') && d.created_at < p.get('@since')) return false;
  if (sql.includes('c.box = @box')) {
    if (d.box !== p.get('@box')) return false;
    if (d.claimedAt && d.claimedAt >= p.get('@stale')) return false;
  }
  return true;
}
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }
function fakeStore(extra?: Partial<Record<string, FakeContainer>>) {
  const containers = Object.fromEntries(['lanes', 'agents', 'sessions', 'decisions', 'audit', 'approvals', 'incidents', 'outbox', 'posture', 'jev_shadow', 'fleet'].map(n => [n, new FakeContainer(n)])) as Record<string, FakeContainer>;
  Object.assign(containers, extra);
  return { store: new CosmosGovernanceStore({ tenantId: 't1', containers: containers as any, maxChainRetries: 5 }), containers };
}
const lane = (id = 'lane-a', version = 1): Lane => ({
  id, version, appliesTo: { surfaces: ['*'] }, purpose: 'test', dos: [], never: [], rules: {}, mode: 'observe', failMode: { default: 'open' }, approval: { channels: ['dashboard'], timeoutSec: 30 }, judge: { escalateBelow: 0.7, dataPolicy: 'redacted' }, sync: { dataPolicy: 'redacted' },
});
const decision = (id: string, sessionId = 's1', at = '2026-01-01T00:00:00.000Z'): Decision => ({
  id, requestId: `r-${id}`, sessionId, agentId: 'agent-1', laneId: 'lane-a', laneVersion: 1, mode: 'observe', checkpoint: 'pre_tool', toolName: 'Read', verdict: 'allow', effectiveVerdict: 'allow', wouldDeny: false, stage: 'rules_allow', reason: 'ok', ruleIds: [], tainted: false, latencyMs: 1, createdAt: at,
});

describe('CosmosGovernanceStore', () => {
  it('upserts fleet alerts idempotently and filters them', async () => {
    const { store } = fakeStore();
    await store.init();
    const base = { alert_type: 'GOAL_DRIFT', score: 70, title: 't', summary: 's', detector: 'intent', platform: 'foundry' };
    await store.upsertFleetAlerts([
      { ...base, alert_id: 'f1', severity: 'high', session_id: 'c1', created_at: '2026-09-30T10:00:00.000Z' },
      { ...base, alert_id: 'f2', severity: 'low', session_id: 'c2', created_at: '2026-09-30T11:00:00.000Z' },
    ]);
    await store.upsertFleetAlerts([{ ...base, alert_id: 'f1', severity: 'critical', session_id: 'c1', created_at: '2026-09-30T10:00:00.000Z' }]);
    const all = await store.listFleetAlerts();
    expect(all.map(a => a.alert_id)).toEqual(['f2', 'f1']);
    expect((await store.listFleetAlerts({ severity: ['critical'] })).map(a => a.alert_id)).toEqual(['f1']);
    expect((await store.listFleetAlerts({ sessionId: 'c2' }))[0].severity).toBe('low');
    expect((await store.getFleetAlert('f1'))?.severity).toBe('critical');
  });
  it('serializes concurrent audit appends and retries 412/head conflicts', async () => {
    const { store, containers } = fakeStore();
    await store.init();
    containers.audit.failNextHeadReplace = true;
    const out = await Promise.all([store.appendDecision(decision('d1')), store.appendDecision(decision('d2'))]);
    expect(out.map(d => d.seq).sort()).toEqual([1, 2]);
    const verify = await store.verifyAuditChain();
    expect(verify.ok).toBe(true);
    expect(verify.checked).toBe(2);
  });

  it('recovers an orphaned audit decision that is ahead of the head', async () => {
    const { store, containers } = fakeStore();
    await store.init();
    delete containers.audit.items.batch;
    const orphan: Decision = { ...decision('d-orphan'), seq: 1, prevHash: GENESIS_HASH };
    orphan.hash = hashDecision(GENESIS_HASH, 1, orphan);
    containers.decisions.put(orphan.sessionId, orphan.id, { ...orphan, tenantId: 't1' });
    containers.audit.put('t1', 'decision:1', {
      id: 'decision:1',
      tenantId: 't1',
      kind: 'audit-decision',
      seq: 1,
      decisionId: orphan.id,
      sessionId: orphan.sessionId,
      prevHash: orphan.prevHash,
      hash: orphan.hash,
      decision: orphan,
      createdAt: orphan.createdAt,
    });
    const out = await store.appendDecision(decision('d-after'));
    expect(out.seq).toBe(2);
    const verify = await store.verifyAuditChain();
    expect(verify.ok).toBe(true);
    expect(verify.checked).toBe(2);
  });

  it('pages decision queries with continuation cursors', async () => {
    const { store } = fakeStore();
    await store.init();
    await store.appendDecision(decision('d1', 's1', '2026-01-01T00:00:01.000Z'));
    await store.appendDecision(decision('d2', 's1', '2026-01-01T00:00:02.000Z'));
    await store.appendDecision(decision('d3', 's2', '2026-01-01T00:00:03.000Z'));
    const p1 = await store.queryDecisions({ limit: 2 });
    expect(p1.items.map(d => d.id)).toEqual(['d3', 'd2']);
    expect(p1.cursor).toBeTruthy();
    const p2 = await store.queryDecisions({ limit: 2, cursor: p1.cursor });
    expect(p2.items.map(d => d.id)).toEqual(['d1']);
  });

  it('supports approvals and incidents CRUD/listing', async () => {
    const { store } = fakeStore();
    await store.init();
    const approval: Approval = { id: 'a1', requestId: 'r1', sessionId: 's1', agentId: 'agent-1', laneId: 'lane-a', summary: 'sum', reason: 'why', channels: ['dashboard'], state: 'pending', requestedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:10:00Z' };
    await store.createApproval(approval);
    expect((await store.updateApproval('a1', { state: 'approved', resolvedBy: 'u' }))?.state).toBe('approved');
    expect(await store.listApprovals({ state: ['approved'] })).toHaveLength(1);
    const incident: Incident = { id: 'i1', title: 'inc', severity: 'high', state: 'open', trigger: 'test', agentIds: ['agent-1'], sessionIds: ['s1'], decisionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    await store.createIncident(incident);
    expect((await store.updateIncident('i1', { state: 'resolved' }))?.state).toBe('resolved');
    expect(await store.listIncidents({ agentId: 'agent-1', state: ['resolved'] })).toHaveLength(1);
  });

  it('claims, acks, and nacks outbox items', async () => {
    const { store } = fakeStore();
    await store.init();
    await store.enqueue('sync', { hello: 1 });
    const claimed = await store.dequeue('sync', 10);
    expect(claimed).toHaveLength(1);
    expect(await store.dequeue('sync', 10)).toHaveLength(0);
    await store.nack('sync', [claimed[0].id]);
    expect(await store.dequeue('sync', 10)).toHaveLength(1);
    await store.ack('sync', [claimed[0].id]);
    expect(await store.dequeue('sync', 10)).toHaveLength(0);
  });

  it('saves versioned lanes and cloud-active latest view', async () => {
    const { store } = fakeStore();
    await store.init();
    const rec1: LaneRecord = { lane: lane('lane-a', 1), status: 'active', updatedAt: '2026-01-01T00:00:00Z' };
    const rec2: LaneRecord = { lane: lane('lane-a', 2), status: 'active', updatedAt: '2026-01-01T00:01:00Z' };
    await store.saveLane(rec1); await store.saveLane(rec2);
    expect((await store.getLane('lane-a'))?.lane.version).toBe(2);
    expect(await store.listLaneVersions('lane-a')).toHaveLength(2);
  });

  it('stores, filters, pages and prunes Jev shadow records outside the audit chain', async () => {
    const { store, containers } = fakeStore();
    await store.init();
    const rec = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
      id, kind: 'judge' as const, createdAt: at, baseline: { provider: 'foundry' as const, verdict: 'allow' }, jev: { model: 'jev-1.13.0', verdict: 'allow', latencyMs: 5, signals: {} }, agree: true, ...extra,
    });
    await store.appendJevShadow(rec('j1', '2026-01-01T00:00:01.000Z', { sessionId: 's1' }));
    await store.appendJevShadow(rec('j2', '2026-01-01T00:00:02.000Z', { agree: false }));
    await store.appendJevShadow(rec('j3', '2026-01-01T00:00:03.000Z', { kind: 'injection', sessionId: 's2' }));
    // Insert-only: a second write with an existing id is a no-op (409 swallowed), never an overwrite.
    await store.appendJevShadow(rec('j1', '2026-01-01T00:00:09.000Z', { sessionId: 's1', agree: false, kind: 'injection' }));
    expect(containers.jev_shadow.allDocs().find(d => d.id === 'j1')).toMatchObject({ kind: 'judge', agree: true, createdAt: '2026-01-01T00:00:01.000Z' });
    const stored = containers.jev_shadow.allDocs();
    expect(stored.map(d => d.pk).sort()).toEqual(['s1', 's2', 'tenant:t1']);
    expect(stored.every(d => typeof d.ttl === 'number' && d.ttl > 0)).toBe(true);
    const p1 = await store.queryJevShadow({ limit: 2 });
    expect(p1.items.map(r => r.id)).toEqual(['j3', 'j2']);
    expect(p1.items[0]).not.toHaveProperty('pk');
    expect(p1.items[0]).not.toHaveProperty('tenantId');
    expect(p1.items[0].kind).toBe('injection');
    expect((await store.queryJevShadow({ limit: 2, cursor: p1.cursor })).items.map(r => r.id)).toEqual(['j1']);
    expect((await store.queryJevShadow({ kind: ['judge'], agree: false })).items.map(r => r.id)).toEqual(['j2']);
    expect(await store.pruneJevShadow('2026-01-01T00:00:02.500Z')).toBe(2);
    expect((await store.queryJevShadow({})).items.map(r => r.id)).toEqual(['j3']);
    expect(containers.audit.allDocs().filter(d => d.kind === 'audit-decision')).toHaveLength(0);
  });

  const maybeIt = process.env.COSMOS_ENDPOINT ? it : it.skip;
  maybeIt('runs a minimal Cosmos integration smoke test when COSMOS_ENDPOINT is set', async () => {
    const store = new CosmosGovernanceStore({ tenantId: `test-${Date.now()}`, databaseId: process.env.COSMOS_DATABASE ?? 'agentgov-tests' });
    await store.init();
    const out = await store.appendDecision(decision(`d-${Date.now()}`));
    expect(out.hash).toBeTruthy();
    expect((await store.verifyAuditChain()).ok).toBe(true);
  });
});
