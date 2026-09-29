import { CosmosClient, type Container, type Database } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { NormalizedEvent } from '../../collectors/types';
import { govConfig } from '../config';
import { setTelemetryReader, type ActionRecord, type ActionSearch, type SessionSummary, type TelemetryReader } from '../telemetry';
import type { RiskLevel, ToolCategory } from '../types';

export interface MirroredEvent extends Omit<NormalizedEvent, 'scanText'> {
  id?: string | number;
  /** Local SQLite event id from the enforcer, retained for dedupe/cross-reference. */
  sourceEventId?: number | string;
  category?: ToolCategory | string | null;
  riskLevel?: RiskLevel | string | null;
  mcpServer?: string | null;
  findings?: { kind: string; key: string; label: string; severity?: string | null }[];
  redaction?: string | null;
}

type CosmosLikeContainer = Pick<Container, 'items' | 'item'>;
export interface CosmosTelemetryOptions {
  endpoint?: string;
  databaseId?: string;
  events?: CosmosLikeContainer;
  sessions?: CosmosLikeContainer;
  database?: Database;
  client?: { databases: { createIfNotExists(args: { id: string }): Promise<{ database: Database }> } };
}

function limit(n: number | undefined, d = 100, max = 1000): number { return Math.min(Math.max(n ?? d, 1), max); }
function isNotFound(err: unknown): boolean {
  const code = Number((err as { code?: number; statusCode?: number })?.code ?? (err as { statusCode?: number })?.statusCode);
  return code === 404;
}
function eventDocId(e: MirroredEvent): string {
  if (e.id != null) return String(e.id);
  if (e.sourceEventId != null) return String(e.sourceEventId);
  if (e.externalId) return e.externalId;
  return `${e.sessionId}:${e.occurredAt}:${e.toolUseId ?? e.rawEventName}:${e.eventType}`;
}
function strip<T>(doc: T): T {
  const copy = { ...(doc as Record<string, unknown>) };
  delete copy._etag;
  return copy as unknown as T;
}

class CosmosTelemetryBase {
  protected events?: CosmosLikeContainer;
  protected sessions?: CosmosLikeContainer;
  protected database?: Database;
  protected client?: CosmosTelemetryOptions['client'] | CosmosClient;
  protected readonly databaseId: string;

  constructor(opts: CosmosTelemetryOptions = {}) {
    this.events = opts.events;
    this.sessions = opts.sessions;
    this.database = opts.database;
    this.client = opts.client;
    this.databaseId = opts.databaseId ?? govConfig.cloud.cosmosDatabase;
    if (!this.client && !this.database && (!this.events || !this.sessions)) {
      const endpoint = opts.endpoint ?? govConfig.cloud.cosmosEndpoint;
      if (!endpoint) throw new Error('Cosmos telemetry requires COSMOS_ENDPOINT');
      const key = process.env.COSMOS_KEY;
      this.client = new CosmosClient(key
        ? { endpoint, key }
        : ({ endpoint, aadCredentials: new DefaultAzureCredential() } as unknown as ConstructorParameters<typeof CosmosClient>[0]));
    }
  }

  async init(): Promise<void> {
    if (!this.database && this.client) this.database = (await this.client.databases.createIfNotExists({ id: this.databaseId })).database;
    if (!this.events) {
      if (!this.database) throw new Error('missing Cosmos events container');
      this.events = (await this.database.containers.createIfNotExists({
        id: 'events',
        partitionKey: { paths: ['/sessionId'] },
        indexingPolicy: {
          automatic: true,
          indexingMode: 'consistent',
          includedPaths: [{ path: '/*' }],
          excludedPaths: [{ path: '/payload/*' }, { path: '/input/*' }, { path: '/result/?' }, { path: '/_etag/?' }],
          compositeIndexes: [
            [{ path: '/agentId', order: 'ascending' }, { path: '/occurredAt', order: 'descending' }],
            [{ path: '/category', order: 'ascending' }, { path: '/occurredAt', order: 'descending' }],
            [{ path: '/sessionId', order: 'ascending' }, { path: '/occurredAt', order: 'ascending' }],
          ],
        },
      })).container;
    }
    if (!this.sessions) {
      if (!this.database) throw new Error('missing Cosmos sessions container');
      this.sessions = (await this.database.containers.createIfNotExists({ id: 'sessions', partitionKey: { paths: ['/sessionId'] } })).container;
    }
  }

  protected async fetchAll<T>(container: CosmosLikeContainer, query: unknown, options: Record<string, unknown> = {}): Promise<T[]> {
    const r = await container.items.query(query as never, { enableCrossPartitionQuery: true, ...options } as never).fetchAll();
    return ((r as { resources?: T[] }).resources ?? []) as T[];
  }
}

export class CosmosTelemetryReader extends CosmosTelemetryBase implements TelemetryReader {
  async listSessions(q: { since?: string; until?: string; agent?: string; limit?: number }): Promise<SessionSummary[]> {
    await this.init();
    const where = ['c.kind = "summary"'];
    const parameters: { name: string; value: unknown }[] = [];
    if (q.since) { where.push('c.lastActivityAt >= @since'); parameters.push({ name: '@since', value: q.since }); }
    if (q.until) { where.push('c.startedAt < @until'); parameters.push({ name: '@until', value: q.until }); }
    if (q.agent) { where.push('(c.agent = @agent OR c.id = @agent)'); parameters.push({ name: '@agent', value: q.agent }); }
    const rows = await this.fetchAll<SessionSummary & { sessionId: string; kind: string }>(this.sessions!, { query: `SELECT * FROM c WHERE ${where.join(' AND ')} ORDER BY c.lastActivityAt DESC OFFSET 0 LIMIT @limit`, parameters: [...parameters, { name: '@limit', value: limit(q.limit) }] });
    return rows.map(r => strip(r));
  }

  async getSessionTimeline(sessionId: string, opts: { limit?: number; includeResults?: boolean } = {}): Promise<ActionRecord[]> {
    await this.init();
    const rows = await this.fetchAll<MirroredEvent & { sourceEventId?: number | string }>(this.events!, { query: 'SELECT * FROM c WHERE c.sessionId = @sessionId ORDER BY c.occurredAt ASC OFFSET 0 LIMIT @limit', parameters: [{ name: '@sessionId', value: sessionId }, { name: '@limit', value: limit(opts.limit, 200) }] });
    return rows.map(e => toActionRecord(e, opts.includeResults));
  }

  async searchActions(q: ActionSearch): Promise<ActionRecord[]> {
    await this.init();
    const where: string[] = [];
    const parameters: { name: string; value: unknown }[] = [];
    if (q.sessionId) { where.push('c.sessionId = @sessionId'); parameters.push({ name: '@sessionId', value: q.sessionId }); }
    if (q.agent) { where.push('c.agentId = @agent'); parameters.push({ name: '@agent', value: q.agent }); }
    if (q.toolName) { where.push('c.toolName = @toolName'); parameters.push({ name: '@toolName', value: q.toolName }); }
    if (q.category) { where.push('c.category = @category'); parameters.push({ name: '@category', value: q.category }); }
    if (q.since) { where.push('c.occurredAt >= @since'); parameters.push({ name: '@since', value: q.since }); }
    if (q.until) { where.push('c.occurredAt < @until'); parameters.push({ name: '@until', value: q.until }); }
    if (q.text) { where.push('(CONTAINS(c.toolName, @text, true) OR CONTAINS(c.rawEventName, @text, true) OR CONTAINS(c.errorText, @text, true))'); parameters.push({ name: '@text', value: q.text }); }
    const rows = await this.fetchAll<MirroredEvent>(this.events!, { query: `SELECT * FROM c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.occurredAt DESC OFFSET 0 LIMIT @limit`, parameters: [...parameters, { name: '@limit', value: limit(q.limit) }] });
    const minRank = q.riskAtLeast ? riskRank(q.riskAtLeast) : -1;
    return rows.filter(e => minRank < 0 || riskRank(e.riskLevel as string | undefined) >= minRank).map(e => toActionRecord(e, true));
  }
}

export class CosmosTelemetrySink extends CosmosTelemetryBase {
  async writeEvents(events: MirroredEvent[]): Promise<void> {
    await this.init();
    for (const e of events) {
      const doc = { ...e, id: eventDocId(e), sourceEventId: e.sourceEventId ?? e.id, kind: 'event' };
      await this.events!.items.upsert(doc as never);
      await this.upsertSessionSummary(e);
    }
  }

  private async upsertSessionSummary(e: MirroredEvent): Promise<void> {
    const id = `summary:${e.sessionId}`;
    let existing: (SessionSummary & { id: string; kind: string; sessionId: string; _etag?: string }) | undefined;
    try { existing = (await this.sessions!.item(id, e.sessionId).read() as { resource?: typeof existing }).resource; } catch (err) { if (!isNotFound(err)) throw err; }
    const risky = ['high', 'critical'].includes(String(e.riskLevel ?? '').toLowerCase()) ? 1 : 0;
    const tool = e.eventType === 'tool_call' ? 1 : 0;
    const summary = {
      ...(existing ?? {}),
      id,
      kind: 'summary',
      sessionId: e.sessionId,
      agent: existing?.agent ?? e.agentId,
      surface: existing?.surface ?? (e.captureChannel ?? 'unknown'),
      projectPath: existing?.projectPath ?? e.cwd ?? null,
      startedAt: minIso(existing?.startedAt, e.occurredAt),
      lastActivityAt: maxIso(existing?.lastActivityAt, e.occurredAt),
      severity: maxSeverity(existing?.severity, e.riskLevel as string | undefined),
      riskyActions: (existing?.riskyActions ?? 0) + risky,
      toolCalls: (existing?.toolCalls ?? 0) + tool,
    };
    await this.sessions!.items.upsert(summary as never);
  }
}

function toActionRecord(e: MirroredEvent, includeResults = true): ActionRecord {
  return {
    eventId: e.sourceEventId ?? e.id ?? eventDocId(e),
    sessionId: e.sessionId,
    agentId: e.agentId,
    surface: e.captureChannel ?? 'unknown',
    occurredAt: e.occurredAt,
    eventType: e.eventType,
    toolName: e.toolName ?? null,
    category: e.category ?? null,
    mcpServer: e.mcpServer ?? null,
    riskLevel: e.riskLevel ?? null,
    status: e.status ?? null,
    input: (e as { input?: unknown }).input ?? e.payload,
    result: includeResults ? (e.errorText ?? ((e as { result?: string | null }).result ?? null)) : null,
    findings: e.findings,
  };
}
function riskRank(v?: string | null): number { return ['low', 'medium', 'high', 'critical'].indexOf(String(v ?? '').toLowerCase()); }
function minIso(a: string | null | undefined, b: string): string { return !a || b < a ? b : a; }
function maxIso(a: string | null | undefined, b: string): string { return !a || b > a ? b : a; }
function maxSeverity(a?: string | null, b?: string | null): string | null { return riskRank(b) > riskRank(a) ? b! : (a ?? b ?? null); }

export async function initCosmosTelemetry(opts: CosmosTelemetryOptions = {}): Promise<CosmosTelemetryReader> {
  const reader = new CosmosTelemetryReader(opts);
  await reader.init();
  setTelemetryReader(reader);
  return reader;
}
