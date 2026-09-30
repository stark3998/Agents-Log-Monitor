import crypto from 'crypto';
import { CosmosClient, type Container, type Database } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { GENESIS_HASH, hashDecision, verifyChain } from '../audit';
import { govConfig } from '../config';
import type {
  Approval, Decision, Incident, LaneRecord, LaneStatus, PolicyRecord, PostureEndpointRecord, PostureFindingRecord,
  RegisteredAgent, SessionIntent,
} from '../types';
import type {
  ApprovalQuery, AuditVerifyResult, DecisionQuery, GovernanceStore, IncidentQuery, Page, PostureFindingQuery, SettingDoc,
} from './repository';

type Box = 'alerts' | 'sync';
type CosmosLikeContainer = Pick<Container, 'id' | 'items' | 'item'> & { database?: { id: string } };
type ContainerName = 'lanes' | 'agents' | 'sessions' | 'decisions' | 'audit' | 'approvals' | 'incidents' | 'outbox' | 'posture';

export interface CosmosGovernanceStoreOptions {
  tenantId?: string;
  endpoint?: string;
  databaseId?: string;
  /** Injected by tests; when present no SDK client is created. */
  containers?: Partial<Record<ContainerName, CosmosLikeContainer>>;
  client?: { databases: { createIfNotExists(args: { id: string }): Promise<{ database: Database }> } };
  database?: Database;
  maxChainRetries?: number;
}

interface HeadDoc { id: 'head'; tenantId: string; kind: 'audit-head'; seq: number; hash: string; updatedAt: string; _etag?: string }
interface DecisionDoc extends Decision { tenantId: string; origin?: unknown }
interface AuditDecisionDoc { id: string; tenantId: string; kind: 'audit-decision'; seq: number; decisionId: string; sessionId: string; prevHash: string; hash: string; decision: Decision; origin?: unknown; createdAt: string; _etag?: string }
interface OutboxDoc { id: string; box: Box; item: unknown; attempts: number; claimedAt?: string | null; createdAt: string; _etag?: string }

const CONTAINER_DEFS: Record<ContainerName, { partitionKey: string; indexingPolicy?: unknown }> = {
  lanes: { partitionKey: '/tenantId', indexingPolicy: policy(['/yaml/?', '/lane/judge/*', '/lane/rules/*']) },
  agents: { partitionKey: '/tenantId' },
  sessions: { partitionKey: '/sessionId' },
  decisions: {
    partitionKey: '/sessionId',
    indexingPolicy: {
      automatic: true,
      indexingMode: 'consistent',
      includedPaths: [{ path: '/*' }],
      excludedPaths: [{ path: '/judge/*' }, { path: '/args/*' }, { path: '/_etag/?' }],
      // Query paths such as agent/time and lane/time order by createdAt descending across partitions.
      compositeIndexes: [
        [{ path: '/agentId', order: 'ascending' }, { path: '/createdAt', order: 'descending' }],
        [{ path: '/laneId', order: 'ascending' }, { path: '/createdAt', order: 'descending' }],
        [{ path: '/effectiveVerdict', order: 'ascending' }, { path: '/createdAt', order: 'descending' }],
        [{ path: '/sessionId', order: 'ascending' }, { path: '/createdAt', order: 'descending' }],
      ],
    },
  },
  audit: { partitionKey: '/tenantId' },
  approvals: { partitionKey: '/tenantId' },
  incidents: { partitionKey: '/tenantId', indexingPolicy: policy(['/report/?', '/recommendations/*']) },
  outbox: { partitionKey: '/box' },
  posture: { partitionKey: '/tenantId', indexingPolicy: policy(['/inventory/*', '/evidence/*']) },
};

function policy(excluded: string[]): unknown {
  return { automatic: true, indexingMode: 'consistent', includedPaths: [{ path: '/*' }], excludedPaths: excluded.map(path => ({ path })).concat({ path: '/_etag/?' }) };
}

function isConflictOrPrecondition(err: unknown): boolean {
  const code = Number((err as { code?: number; statusCode?: number })?.code ?? (err as { statusCode?: number })?.statusCode);
  return code === 409 || code === 412;
}
function isNotFound(err: unknown): boolean {
  const code = Number((err as { code?: number; statusCode?: number })?.code ?? (err as { statusCode?: number })?.statusCode);
  return code === 404;
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function jitter(attempt: number): number { return Math.min(500, 25 * 2 ** attempt) + Math.floor(Math.random() * 25); }
function limit(n: number | undefined, d = 100, max = 1000): number { return Math.min(Math.max(n ?? d, 1), max); }
function itemOptions(etag?: string): unknown { return etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined; }
function asDecision(doc: DecisionDoc): Decision {
  const { tenantId: _tenantId, origin: _origin, _etag: _etag, ...decision } = doc as DecisionDoc & { _etag?: string };
  return decision;
}
function queryText(v: string): string { return `%${v.replace(/[%_]/g, '')}%`; }

/**
 * Cosmos DB implementation of the governance repository.
 *
 * Decisions are partitioned by /sessionId for timeline reads, but the audit chain must be globally
 * ordered per tenant. We therefore keep the serialising head and per-seq chain records in the
 * tenant-partitioned `audit` container. Appends use optimistic concurrency on the head ETag: read
 * head -> compute next seq/hash -> create decision mirrors -> replace head with If-Match. If another
 * replica wins the race, we best-effort remove the tentative mirrors and retry with jitter. A future
 * improvement can move the audit create+head update into a transactional batch; the chosen approach
 * keeps the hot decision document in the /sessionId container for cheap timeline queries.
 */
export class CosmosGovernanceStore implements GovernanceStore {
  readonly kind = 'cosmos' as const;
  private readonly tenantId: string;
  private readonly databaseId: string;
  private readonly maxChainRetries: number;
  private client?: CosmosClient | CosmosGovernanceStoreOptions['client'];
  private database?: Database;
  private containers: Partial<Record<ContainerName, CosmosLikeContainer>>;

  constructor(opts: CosmosGovernanceStoreOptions = {}) {
    this.tenantId = opts.tenantId ?? govConfig.tenantId;
    this.databaseId = opts.databaseId ?? govConfig.cloud.cosmosDatabase;
    this.maxChainRetries = opts.maxChainRetries ?? 8;
    this.containers = opts.containers ?? {};
    this.database = opts.database;
    this.client = opts.client;
    if (!this.client && !this.database && Object.keys(this.containers).length === 0) {
      const endpoint = opts.endpoint ?? govConfig.cloud.cosmosEndpoint;
      if (!endpoint) throw new Error('CosmosGovernanceStore requires COSMOS_ENDPOINT');
      const key = process.env.COSMOS_KEY;
      this.client = new CosmosClient(key
        ? { endpoint, key }
        : ({ endpoint, aadCredentials: new DefaultAzureCredential() } as unknown as ConstructorParameters<typeof CosmosClient>[0]));
    }
  }

  async init(): Promise<void> {
    if (!this.database && this.client) {
      const created = await this.client.databases.createIfNotExists({ id: this.databaseId });
      this.database = created.database;
    }
    for (const [id, def] of Object.entries(CONTAINER_DEFS) as [ContainerName, typeof CONTAINER_DEFS[ContainerName]][]) {
      if (!this.containers[id]) {
        if (!this.database) throw new Error(`missing Cosmos container ${id}`);
        const created = await this.database.containers.createIfNotExists({
          id,
          partitionKey: { paths: [def.partitionKey] },
          indexingPolicy: def.indexingPolicy as never,
        });
        this.containers[id] = created.container as CosmosLikeContainer;
      }
    }
    await this.ensureHead();
  }

  private c(name: ContainerName): CosmosLikeContainer {
    const c = this.containers[name];
    if (!c) throw new Error(`Cosmos container ${name} not initialised`);
    return c;
  }

  private async fetchAll<T>(container: ContainerName, query: unknown, options: Record<string, unknown> = {}): Promise<T[]> {
    const r = await this.c(container).items.query(query as never, { enableCrossPartitionQuery: true, ...options } as never).fetchAll();
    return ((r as { resources?: T[] }).resources ?? []) as T[];
  }

  private async fetchPage<T>(container: ContainerName, query: unknown, maxItemCount: number, continuationToken?: string): Promise<{ resources: T[]; continuationToken?: string }> {
    const q = this.c(container).items.query(query as never, { enableCrossPartitionQuery: true, maxItemCount, continuationToken } as never);
    if (typeof (q as { fetchNext?: () => Promise<unknown> }).fetchNext === 'function') {
      const page = await (q as { fetchNext: () => Promise<{ resources?: T[]; continuationToken?: string }> }).fetchNext();
      return { resources: page.resources ?? [], continuationToken: page.continuationToken };
    }
    const all = await q.fetchAll() as { resources?: T[]; continuationToken?: string };
    return { resources: all.resources ?? [], continuationToken: all.continuationToken };
  }

  private async readItem<T>(container: ContainerName, id: string, pk: string): Promise<T | undefined> {
    try {
      const r = await this.c(container).item(id, pk).read();
      return (r as { resource?: T }).resource;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async replaceItem<T>(container: ContainerName, id: string, pk: string, doc: T, etag?: string): Promise<T> {
    const r = await this.c(container).item(id, pk).replace(doc as never, itemOptions(etag) as never);
    return (r as { resource?: T }).resource ?? doc;
  }

  private async deleteItem(container: ContainerName, id: string, pk: string): Promise<void> {
    try { await this.c(container).item(id, pk).delete(); } catch (err) { if (!isNotFound(err)) throw err; }
  }

  private async ensureHead(): Promise<HeadDoc> {
    const existing = await this.readItem<HeadDoc>('audit', 'head', this.tenantId);
    if (existing) return existing;
    const head: HeadDoc = { id: 'head', tenantId: this.tenantId, kind: 'audit-head', seq: 0, hash: GENESIS_HASH, updatedAt: new Date().toISOString() };
    try {
      const r = await this.c('audit').items.create(head as never);
      return (r as { resource?: HeadDoc }).resource ?? head;
    } catch (err) {
      if (isConflictOrPrecondition(err)) return (await this.readItem<HeadDoc>('audit', 'head', this.tenantId)) ?? head;
      throw err;
    }
  }

  // Lanes
  async listLanes(status?: LaneStatus[]): Promise<LaneRecord[]> {
    const params = [{ name: '@tenantId', value: this.tenantId }];
    let sql = 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "lane"';
    if (status?.length) { sql += ' AND ARRAY_CONTAINS(@status, c.status)'; params.push({ name: '@status', value: status } as never); }
    const rows = await this.fetchAll<LaneRecord & { tenantId: string; id: string; kind: string }>('lanes', { query: sql, parameters: params });
    const latest = new Map<string, LaneRecord>();
    for (const r of rows) {
      const rec = this.stripDoc(r) as LaneRecord;
      const prev = latest.get(rec.lane.id);
      if (!prev || rec.lane.version > prev.lane.version) latest.set(rec.lane.id, rec);
    }
    return [...latest.values()].sort((a, b) => a.lane.id.localeCompare(b.lane.id));
  }

  async getLane(id: string, version?: number): Promise<LaneRecord | undefined> {
    if (version != null) {
      const doc = await this.readItem<LaneRecord & { tenantId: string }>('lanes', `${id}:${version}`, this.tenantId);
      return doc ? this.stripDoc(doc) as LaneRecord : undefined;
    }
    const rows = await this.fetchAll<LaneRecord & { tenantId: string }>('lanes', {
      query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "lane" AND c.lane.id = @id AND c.status = "active" ORDER BY c.lane.version DESC',
      parameters: [{ name: '@tenantId', value: this.tenantId }, { name: '@id', value: id }],
    }, { maxItemCount: 1 });
    return rows[0] ? this.stripDoc(rows[0]) as LaneRecord : undefined;
  }

  async listLaneVersions(id: string): Promise<LaneRecord[]> {
    const rows = await this.fetchAll<LaneRecord & { tenantId: string }>('lanes', {
      query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "lane" AND c.lane.id = @id ORDER BY c.lane.version DESC',
      parameters: [{ name: '@tenantId', value: this.tenantId }, { name: '@id', value: id }],
    });
    return rows.map(r => this.stripDoc(r) as LaneRecord);
  }

  async saveLane(rec: LaneRecord): Promise<LaneRecord> {
    if (rec.lane.id.includes(':')) throw new Error('lane id must not contain ":"');
    if (rec.status === 'active') {
      const versions = await this.listLaneVersions(rec.lane.id);
      await Promise.all(versions.filter(v => v.status === 'active' && v.lane.version !== rec.lane.version)
        .map(v => this.setLaneStatus(v.lane.id, v.lane.version, 'archived', rec.updatedBy)));
    }
    await this.c('lanes').items.upsert({ ...rec, id: `${rec.lane.id}:${rec.lane.version}`, tenantId: this.tenantId, kind: 'lane' } as never);
    return rec;
  }

  async setLaneStatus(id: string, version: number, status: LaneStatus, by?: string): Promise<void> {
    if (status === 'active') {
      const versions = await this.listLaneVersions(id);
      await Promise.all(versions.filter(v => v.status === 'active').map(v => this.setLaneStatus(v.lane.id, v.lane.version, 'archived', by)));
    }
    const doc = await this.readItem<(LaneRecord & { id: string; tenantId: string; kind: string; _etag?: string })>('lanes', `${id}:${version}`, this.tenantId);
    if (!doc) return;
    doc.status = status; doc.updatedAt = new Date().toISOString(); doc.updatedBy = by;
    await this.replaceItem('lanes', doc.id, this.tenantId, doc, doc._etag);
  }

  // Policies share the tenant-partitioned `lanes` container (kind = "policy").
  async listPolicies(status?: LaneStatus[]): Promise<PolicyRecord[]> {
    const params = [{ name: '@tenantId', value: this.tenantId }];
    let sql = 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "policy"';
    if (status?.length) { sql += ' AND ARRAY_CONTAINS(@status, c.status)'; params.push({ name: '@status', value: status } as never); }
    const rows = await this.fetchAll<PolicyRecord & { tenantId: string }>('lanes', { query: sql, parameters: params });
    const latest = new Map<string, PolicyRecord>();
    for (const r of rows) {
      const rec = this.stripPolicy(r);
      const prev = latest.get(rec.policy.id);
      if (!prev || rec.policy.version > prev.policy.version) latest.set(rec.policy.id, rec);
    }
    return [...latest.values()].sort((a, b) => a.policy.id.localeCompare(b.policy.id));
  }

  async getPolicy(id: string, version?: number): Promise<PolicyRecord | undefined> {
    if (version != null) {
      const doc = await this.readItem<PolicyRecord & { tenantId: string }>('lanes', `policy:${id}:${version}`, this.tenantId);
      return doc ? this.stripPolicy(doc) : undefined;
    }
    const rows = await this.fetchAll<PolicyRecord & { tenantId: string }>('lanes', {
      query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "policy" AND c.policy.id = @id AND c.status = "active" ORDER BY c.policy.version DESC',
      parameters: [{ name: '@tenantId', value: this.tenantId }, { name: '@id', value: id }],
    }, { maxItemCount: 1 });
    return rows[0] ? this.stripPolicy(rows[0]) : undefined;
  }

  async listPolicyVersions(id: string): Promise<PolicyRecord[]> {
    const rows = await this.fetchAll<PolicyRecord & { tenantId: string }>('lanes', {
      query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "policy" AND c.policy.id = @id ORDER BY c.policy.version DESC',
      parameters: [{ name: '@tenantId', value: this.tenantId }, { name: '@id', value: id }],
    });
    return rows.map(r => this.stripPolicy(r));
  }

  async savePolicy(rec: PolicyRecord): Promise<PolicyRecord> {
    if (rec.status === 'active') {
      const versions = await this.listPolicyVersions(rec.policy.id);
      await Promise.all(versions.filter(v => v.status === 'active' && v.policy.version !== rec.policy.version)
        .map(v => this.setPolicyStatus(v.policy.id, v.policy.version, 'archived', rec.updatedBy)));
    }
    await this.c('lanes').items.upsert({ ...rec, id: `policy:${rec.policy.id}:${rec.policy.version}`, tenantId: this.tenantId, kind: 'policy' } as never);
    return rec;
  }

  async setPolicyStatus(id: string, version: number, status: LaneStatus, by?: string): Promise<void> {
    if (status === 'active') {
      const versions = await this.listPolicyVersions(id);
      await Promise.all(versions.filter(v => v.status === 'active').map(v => this.setPolicyStatus(v.policy.id, v.policy.version, 'archived', by)));
    }
    const doc = await this.readItem<(PolicyRecord & { id: string; tenantId: string; kind: string; _etag?: string })>('lanes', `policy:${id}:${version}`, this.tenantId);
    if (!doc) return;
    doc.status = status; doc.updatedAt = new Date().toISOString(); doc.updatedBy = by;
    await this.replaceItem('lanes', doc.id, this.tenantId, doc, doc._etag);
  }

  private stripPolicy(doc: PolicyRecord & { tenantId?: string; id?: string }): PolicyRecord {
    const { id: _id, ...rest } = this.stripDoc(doc) as PolicyRecord & { id?: string };
    return rest;
  }

  // Settings (kind = "setting" in the `lanes` container)
  async getSetting<T = unknown>(key: string): Promise<SettingDoc<T> | undefined> {
    const doc = await this.readItem<SettingDoc<T> & { id: string; tenantId: string; kind: string }>('lanes', `setting:${key}`, this.tenantId);
    if (!doc) return undefined;
    return { key: doc.key, value: doc.value, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
  }

  async putSetting<T = unknown>(key: string, value: T, by?: string): Promise<SettingDoc<T>> {
    const out: SettingDoc<T> = { key, value, updatedAt: new Date().toISOString(), updatedBy: by };
    await this.c('lanes').items.upsert({ ...out, id: `setting:${key}`, tenantId: this.tenantId, kind: 'setting' } as never);
    return out;
  }

  // Posture (tenant-partitioned `posture` container; kind = endpoint | finding)
  async upsertPostureEndpoint(e: PostureEndpointRecord): Promise<PostureEndpointRecord> {
    await this.c('posture').items.upsert({ ...e, id: `endpoint:${e.id}`, endpointId: e.id, tenantId: this.tenantId, kind: 'endpoint' } as never);
    return e;
  }

  async getPostureEndpoint(id: string): Promise<PostureEndpointRecord | undefined> {
    const doc = await this.readItem<PostureEndpointRecord & { endpointId: string }>('posture', `endpoint:${id}`, this.tenantId);
    return doc ? this.stripPostureEndpoint(doc) : undefined;
  }

  async listPostureEndpoints(): Promise<PostureEndpointRecord[]> {
    const rows = await this.fetchAll<PostureEndpointRecord & { endpointId: string }>('posture', {
      query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "endpoint" ORDER BY c.lastScanAt DESC',
      parameters: [{ name: '@tenantId', value: this.tenantId }],
    });
    return rows.map(r => this.stripPostureEndpoint(r));
  }

  async upsertPostureFinding(f: PostureFindingRecord): Promise<PostureFindingRecord> {
    await this.c('posture').items.upsert({ ...f, id: `finding:${f.id}`, findingId: f.id, tenantId: this.tenantId, kind: 'finding' } as never);
    return f;
  }

  async getPostureFinding(id: string): Promise<PostureFindingRecord | undefined> {
    const doc = await this.readItem<PostureFindingRecord & { findingId: string }>('posture', `finding:${id}`, this.tenantId);
    return doc ? this.stripPostureFinding(doc) : undefined;
  }

  async listPostureFindings(q: PostureFindingQuery = {}): Promise<PostureFindingRecord[]> {
    const where = ['c.tenantId = @tenantId', 'c.kind = "finding"'];
    const parameters: { name: string; value: unknown }[] = [{ name: '@tenantId', value: this.tenantId }];
    if (q.state?.length) { where.push('ARRAY_CONTAINS(@state, c.state)'); parameters.push({ name: '@state', value: q.state }); }
    if (q.severity?.length) { where.push('ARRAY_CONTAINS(@severity, c.severity)'); parameters.push({ name: '@severity', value: q.severity }); }
    if (q.endpointId) { where.push('c.endpointId = @endpointId'); parameters.push({ name: '@endpointId', value: q.endpointId }); }
    if (q.checkId) { where.push('c.checkId = @checkId'); parameters.push({ name: '@checkId', value: q.checkId }); }
    if (q.level) { where.push('c.level = @level'); parameters.push({ name: '@level', value: q.level }); }
    const rows = await this.fetchAll<PostureFindingRecord & { findingId: string }>('posture', {
      query: `SELECT TOP ${limit(q.limit, 5000, 20000)} * FROM c WHERE ${where.join(' AND ')} ORDER BY c.lastSeenAt DESC`, parameters,
    });
    return rows.map(r => this.stripPostureFinding(r));
  }

  private stripPostureEndpoint(doc: PostureEndpointRecord & { endpointId?: string }): PostureEndpointRecord {
    const { endpointId, ...rest } = this.stripDoc(doc) as PostureEndpointRecord & { endpointId?: string };
    return { ...rest, id: endpointId ?? rest.id };
  }

  private stripPostureFinding(doc: PostureFindingRecord & { findingId?: string }): PostureFindingRecord {
    const { findingId, ...rest } = this.stripDoc(doc) as PostureFindingRecord & { findingId?: string };
    return { ...rest, id: findingId ?? rest.id };
  }

  // Agents
  async listAgents(): Promise<RegisteredAgent[]> {
    const rows = await this.fetchAll<RegisteredAgent & { tenantId: string }>('agents', { query: 'SELECT * FROM c WHERE c.tenantId = @tenantId ORDER BY c.lastSeenAt DESC', parameters: [{ name: '@tenantId', value: this.tenantId }] });
    return rows.map(r => this.stripDoc(r) as RegisteredAgent);
  }
  async getAgent(id: string): Promise<RegisteredAgent | undefined> {
    const doc = await this.readItem<RegisteredAgent & { tenantId: string }>('agents', id, this.tenantId);
    return doc ? this.stripDoc(doc) as RegisteredAgent : undefined;
  }
  async findAgentByExternalId(surface: string, externalId: string): Promise<RegisteredAgent | undefined> {
    const rows = await this.fetchAll<RegisteredAgent & { tenantId: string }>('agents', { query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.surface = @surface AND c.externalId = @externalId', parameters: [{ name: '@tenantId', value: this.tenantId }, { name: '@surface', value: surface }, { name: '@externalId', value: externalId }] }, { maxItemCount: 1 });
    return rows[0] ? this.stripDoc(rows[0]) as RegisteredAgent : undefined;
  }
  async upsertAgent(a: RegisteredAgent): Promise<RegisteredAgent> {
    await this.c('agents').items.upsert({ ...a, tenantId: this.tenantId } as never);
    return a;
  }

  // Session intent
  async getSessionIntent(sessionId: string): Promise<SessionIntent | undefined> {
    const doc = await this.readItem<SessionIntent & { id: string; tenantId: string; kind: string }>('sessions', `intent:${sessionId}`, sessionId);
    return doc ? this.stripDoc(doc) as SessionIntent : undefined;
  }
  async saveSessionIntent(s: SessionIntent): Promise<void> {
    await this.c('sessions').items.upsert({ ...s, id: `intent:${s.sessionId}`, kind: 'intent', tenantId: this.tenantId } as never);
  }

  // Decisions
  async appendDecision(d: Decision): Promise<Decision> {
    const incoming = d as Decision & { origin?: unknown };
    const { origin, ...decisionOnly } = incoming;
    for (let attempt = 0; attempt < this.maxChainRetries; attempt++) {
      const head = await this.ensureHead();
      const seq = head.seq + 1;
      const prevHash = head.hash;
      const out: Decision = { ...decisionOnly, seq, prevHash, hash: hashDecision(prevHash, seq, decisionOnly) };
      const decisionDoc: DecisionDoc = { ...out, tenantId: this.tenantId, ...(origin !== undefined ? { origin } : {}) };
      const auditDoc: AuditDecisionDoc = { id: `decision:${seq}`, tenantId: this.tenantId, kind: 'audit-decision', seq, decisionId: out.id, sessionId: out.sessionId, prevHash, hash: out.hash!, decision: out, ...(origin !== undefined ? { origin } : {}), createdAt: out.createdAt };
      let createdDecision = false;
      let createdAudit = false;
      try {
        try {
          await this.c('decisions').items.create(decisionDoc as never);
          createdDecision = true;
        } catch (err) {
          if (Number((err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode) === 409) {
            const existing = await this.getDecision(out.id);
            if (existing) {
              if ((existing.seq ?? 0) > head.seq) {
                const recovered = await this.recoverAuditOrphan(head, existing.seq!);
                if (recovered) return existing;
                await this.deleteItem('decisions', existing.id, existing.sessionId).catch(() => undefined);
              } else {
                return existing;
              }
            }
          }
          throw err;
        }
        const nextHead: HeadDoc = { id: 'head', tenantId: this.tenantId, kind: 'audit-head', seq, hash: out.hash!, updatedAt: new Date().toISOString() };
        await this.commitAuditAppend(auditDoc, nextHead, head, () => { createdAudit = true; });
        return out;
      } catch (err) {
        if (createdAudit && !isConflictOrPrecondition(err)) {
          const recovered = await this.recoverAuditOrphan(head, seq).catch(() => undefined);
          if (recovered?.id === out.id) return recovered;
        }
        if (!isConflictOrPrecondition(err)) {
          if (createdDecision && !createdAudit) await this.deleteItem('decisions', out.id, out.sessionId).catch(() => undefined);
          throw err;
        }
        const cleanup: Promise<void>[] = [];
        if (createdDecision) cleanup.push(this.deleteItem('decisions', out.id, out.sessionId));
        if (createdAudit) cleanup.push(this.deleteItem('audit', `decision:${seq}`, this.tenantId));
        await Promise.allSettled(cleanup);
        await this.recoverAuditOrphan(head, seq).catch(() => undefined);
        await sleep(jitter(attempt));
      }
    }
    throw new Error('failed to append governance decision after Cosmos audit head retries');
  }

  private async commitAuditAppend(auditDoc: AuditDecisionDoc, nextHead: HeadDoc, head: HeadDoc, markAuditCreated: () => void): Promise<void> {
    const batch = (this.c('audit').items as { batch?: (operations: unknown[], partitionKey: string) => Promise<unknown> }).batch;
    if (typeof batch === 'function') {
      await batch.call(this.c('audit').items, [
        { operationType: 'Create', resourceBody: auditDoc },
        { operationType: 'Replace', id: 'head', resourceBody: nextHead, ifMatch: head._etag },
      ], this.tenantId);
      return;
    }
    await this.c('audit').items.create(auditDoc as never);
    markAuditCreated();
    await this.replaceItem('audit', 'head', this.tenantId, nextHead, head._etag);
  }

  private async recoverAuditOrphan(head: HeadDoc, seq: number): Promise<Decision | undefined> {
    if (seq !== head.seq + 1) return undefined;
    const orphan = await this.readItem<AuditDecisionDoc>('audit', `decision:${seq}`, this.tenantId);
    if (!orphan || orphan.kind !== 'audit-decision' || orphan.seq !== seq || orphan.prevHash !== head.hash) return undefined;
    const d = orphan.decision;
    if (!d || d.seq !== seq || d.prevHash !== head.hash || d.hash !== orphan.hash || orphan.hash !== hashDecision(head.hash, seq, d)) return undefined;
    const nextHead: HeadDoc = { id: 'head', tenantId: this.tenantId, kind: 'audit-head', seq, hash: orphan.hash, updatedAt: new Date().toISOString() };
    try {
      await this.replaceItem('audit', 'head', this.tenantId, nextHead, head._etag);
      return d;
    } catch (err) {
      if (isConflictOrPrecondition(err)) return undefined;
      throw err;
    }
  }

  async getDecision(id: string): Promise<Decision | undefined> {
    const rows = await this.fetchAll<DecisionDoc>('decisions', { query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.id = @id', parameters: [{ name: '@tenantId', value: this.tenantId }, { name: '@id', value: id }] }, { maxItemCount: 1 });
    return rows[0] ? asDecision(rows[0]) : undefined;
  }

  async queryDecisions(q: DecisionQuery): Promise<Page<Decision>> {
    const where = ['c.tenantId = @tenantId'];
    const parameters: { name: string; value: unknown }[] = [{ name: '@tenantId', value: this.tenantId }];
    if (q.sessionId) { where.push('c.sessionId = @sessionId'); parameters.push({ name: '@sessionId', value: q.sessionId }); }
    if (q.agentId) { where.push('c.agentId = @agentId'); parameters.push({ name: '@agentId', value: q.agentId }); }
    if (q.laneId) { where.push('c.laneId = @laneId'); parameters.push({ name: '@laneId', value: q.laneId }); }
    if (q.toolName) { where.push('c.toolName = @toolName'); parameters.push({ name: '@toolName', value: q.toolName }); }
    if (q.verdict?.length) { where.push('ARRAY_CONTAINS(@verdict, c.effectiveVerdict)'); parameters.push({ name: '@verdict', value: q.verdict }); }
    if (q.wouldDeny != null) { where.push('c.wouldDeny = @wouldDeny'); parameters.push({ name: '@wouldDeny', value: q.wouldDeny }); }
    if (q.since) { where.push('c.createdAt >= @since'); parameters.push({ name: '@since', value: q.since }); }
    if (q.until) { where.push('c.createdAt < @until'); parameters.push({ name: '@until', value: q.until }); }
    if (q.text) { where.push('(CONTAINS(c.reason, @text, true) OR CONTAINS(c.toolName, @text, true) OR CONTAINS(c.id, @text, true))'); parameters.push({ name: '@text', value: queryText(q.text).replace(/%/g, '') }); }
    const page = await this.fetchPage<DecisionDoc>('decisions', { query: `SELECT * FROM c WHERE ${where.join(' AND ')} ORDER BY c.createdAt DESC`, parameters }, limit(q.limit, 50, 500), q.cursor);
    return { items: page.resources.map(asDecision), cursor: page.continuationToken };
  }

  async verifyAuditChain(fromSeq = 1, lim = 100_000): Promise<AuditVerifyResult> {
    const prevHash = fromSeq > 1 ? (await this.readItem<{ hash: string }>('audit', `decision:${fromSeq - 1}`, this.tenantId))?.hash : GENESIS_HASH;
    if (prevHash == null) return { ok: false, checked: 0, brokenAt: fromSeq - 1 };
    const rows = await this.fetchAll<{ seq: number; decision: Decision }>('audit', { query: 'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.kind = "audit-decision" AND c.seq >= @fromSeq ORDER BY c.seq ASC OFFSET 0 LIMIT @limit', parameters: [{ name: '@tenantId', value: this.tenantId }, { name: '@fromSeq', value: fromSeq }, { name: '@limit', value: lim }] });
    const items = rows.map(r => r.decision);
    for (let i = 0; i < items.length; i++) if (items[i].seq !== fromSeq + i) return { ok: false, checked: i, brokenAt: fromSeq + i };
    const v = verifyChain(items, prevHash);
    return { ok: v.ok, checked: items.length, brokenAt: v.brokenAt, headHash: v.headHash };
  }

  // Approvals
  async createApproval(a: Approval): Promise<Approval> { await this.c('approvals').items.create({ ...a, tenantId: this.tenantId } as never); return a; }
  async getApproval(id: string): Promise<Approval | undefined> { const d = await this.readItem<Approval & { tenantId: string }>('approvals', id, this.tenantId); return d ? this.stripDoc(d) as Approval : undefined; }
  async updateApproval(id: string, patch: Partial<Approval>): Promise<Approval | undefined> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await this.readItem<(Approval & { tenantId: string; _etag?: string })>('approvals', id, this.tenantId);
      if (!doc) return undefined;
      if (patch.state && doc.state !== 'pending' && patch.state !== doc.state) return this.stripDoc(doc) as Approval;
      const next = { ...doc, ...patch, id, tenantId: this.tenantId };
      try {
        const saved = await this.replaceItem('approvals', id, this.tenantId, next, doc._etag);
        return this.stripDoc(saved) as Approval;
      } catch (err) {
        if (!isConflictOrPrecondition(err)) throw err;
        await sleep(jitter(attempt));
      }
    }
    return this.getApproval(id);
  }
  async listApprovals(q: ApprovalQuery = {}): Promise<Approval[]> {
    const where = ['c.tenantId = @tenantId']; const parameters: { name: string; value: unknown }[] = [{ name: '@tenantId', value: this.tenantId }];
    if (q.state?.length) { where.push('ARRAY_CONTAINS(@state, c.state)'); parameters.push({ name: '@state', value: q.state }); }
    if (q.sessionId) { where.push('c.sessionId = @sessionId'); parameters.push({ name: '@sessionId', value: q.sessionId }); }
    if (q.agentId) { where.push('c.agentId = @agentId'); parameters.push({ name: '@agentId', value: q.agentId }); }
    const rows = await this.fetchAll<Approval & { tenantId: string }>('approvals', { query: `SELECT * FROM c WHERE ${where.join(' AND ')} ORDER BY c.requestedAt DESC OFFSET 0 LIMIT @limit`, parameters: [...parameters, { name: '@limit', value: limit(q.limit) }] });
    return rows.map(r => this.stripDoc(r) as Approval);
  }

  // Incidents
  async createIncident(i: Incident): Promise<Incident> { await this.c('incidents').items.create({ ...i, tenantId: this.tenantId } as never); return i; }
  async getIncident(id: string): Promise<Incident | undefined> { const d = await this.readItem<Incident & { tenantId: string }>('incidents', id, this.tenantId); return d ? this.stripDoc(d) as Incident : undefined; }
  async updateIncident(id: string, patch: Partial<Incident>): Promise<Incident | undefined> {
    const doc = await this.readItem<(Incident & { tenantId: string; _etag?: string })>('incidents', id, this.tenantId);
    if (!doc) return undefined;
    const next = { ...doc, ...patch, id, tenantId: this.tenantId, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    const saved = await this.replaceItem('incidents', id, this.tenantId, next, doc._etag);
    return this.stripDoc(saved) as Incident;
  }
  async listIncidents(q: IncidentQuery = {}): Promise<Incident[]> {
    const where = ['c.tenantId = @tenantId']; const parameters: { name: string; value: unknown }[] = [{ name: '@tenantId', value: this.tenantId }];
    if (q.state?.length) { where.push('ARRAY_CONTAINS(@state, c.state)'); parameters.push({ name: '@state', value: q.state }); }
    if (q.since) { where.push('c.createdAt >= @since'); parameters.push({ name: '@since', value: q.since }); }
    if (q.agentId) { where.push('ARRAY_CONTAINS(c.agentIds, @agentId)'); parameters.push({ name: '@agentId', value: q.agentId }); }
    const rows = await this.fetchAll<Incident & { tenantId: string }>('incidents', { query: `SELECT * FROM c WHERE ${where.join(' AND ')} ORDER BY c.createdAt DESC OFFSET 0 LIMIT @limit`, parameters: [...parameters, { name: '@limit', value: limit(q.limit) }] });
    return rows.map(r => this.stripDoc(r) as Incident);
  }

  // Outbox
  async enqueue(box: Box, item: unknown): Promise<void> {
    const doc: OutboxDoc = { id: crypto.randomUUID(), box, item, attempts: 0, createdAt: new Date().toISOString(), claimedAt: null };
    await this.c('outbox').items.create(doc as never);
  }
  async dequeue(box: Box, n: number): Promise<{ id: string; item: unknown; attempts: number }[]> {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    const rows = await this.fetchAll<OutboxDoc>('outbox', { query: 'SELECT * FROM c WHERE c.box = @box AND (NOT IS_DEFINED(c.claimedAt) OR IS_NULL(c.claimedAt) OR c.claimedAt < @stale) ORDER BY c.createdAt ASC OFFSET 0 LIMIT @limit', parameters: [{ name: '@box', value: box }, { name: '@stale', value: stale }, { name: '@limit', value: limit(n, 25, 500) }] });
    const out: { id: string; item: unknown; attempts: number }[] = [];
    for (const row of rows) {
      try {
        const next: OutboxDoc = { ...row, attempts: (row.attempts ?? 0) + 1, claimedAt: new Date().toISOString() };
        const saved = await this.replaceItem('outbox', row.id, box, next, row._etag);
        out.push({ id: saved.id, item: saved.item, attempts: saved.attempts });
      } catch (err) { if (!isConflictOrPrecondition(err)) throw err; }
    }
    return out;
  }
  async ack(box: Box, ids: string[]): Promise<void> { await Promise.all(ids.map(id => this.deleteItem('outbox', id, box))); }
  async nack(box: Box, ids: string[]): Promise<void> {
    await Promise.all(ids.map(async id => {
      const doc = await this.readItem<OutboxDoc>('outbox', id, box);
      if (doc) await this.replaceItem('outbox', id, box, { ...doc, claimedAt: null }, doc._etag);
    }));
  }

  private stripDoc<T>(doc: T): T {
    const copy = { ...(doc as Record<string, unknown>) };
    delete copy.tenantId; delete copy.kind; delete copy._etag;
    return copy as unknown as T;
  }
}
