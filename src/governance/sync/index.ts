import { all, getPollerState, setPollerState } from '../../db';
import { govConfig } from '../config';
import { govBus } from '../events';
import { govStore } from '../store';
import type { Decision, LaneRecord, PolicyRecord, RegisteredAgent } from '../types';
import type { MirroredEvent } from '../store/cosmos-telemetry';
import { invalidatePolicyCache } from '../policies';
import { CLASSIFIER_SETTING_KEY, saveClassifierConfig } from '../classifiers';
import type { PostureReport } from '../../posture/types';

export type SyncOutboxItem =
  | { kind: 'decision'; decision: Decision }
  | { kind: 'event'; event: MirroredEvent }
  | { kind: 'posture'; report: PostureReport };
type OutboxClaim = { id: string; item: unknown; attempts: number };

const OUTBOX_MAX_ATTEMPTS = 10;
const OUTBOX_MAX_BATCH_BYTES = 1_000_000;

let started = false;
let laneTimer: NodeJS.Timeout | undefined;
let telemetryTimer: NodeJS.Timeout | undefined;
let drainTimer: NodeJS.Timeout | undefined;

export function startSync(): void {
  if (started) return;
  if (govConfig.mode === 'cloud' && govConfig.cloud.cosmosEndpoint) { started = true; startCloudMirror(); return; }
  if (govConfig.mode !== 'local' || !govConfig.cloud.controlPlaneUrl) return;
  started = true;
  govBus.on('decision', d => { void govStore().enqueue('sync', { kind: 'decision', decision: d } satisfies SyncOutboxItem); });
  const interval = Math.max(5_000, govConfig.cloud.syncIntervalMs);
  const run = () => { void runLocalSyncOnce().catch(err => console.warn('[gov-sync] sync failed', err)); };
  run();
  laneTimer = setInterval(run, interval);
  telemetryTimer = setInterval(() => { void pollLocalTelemetryOnce().catch(err => console.warn('[gov-sync] telemetry poll failed', err)); }, Math.max(10_000, interval));
  drainTimer = setInterval(() => { void drainSyncOutbox().catch(err => console.warn('[gov-sync] outbox drain failed', err)); }, Math.max(3_000, Math.floor(interval / 2)));
  laneTimer.unref?.(); telemetryTimer.unref?.(); drainTimer.unref?.();
}

export function stopSyncForTests(): void {
  if (laneTimer) clearInterval(laneTimer);
  if (telemetryTimer) clearInterval(telemetryTimer);
  if (drainTimer) clearInterval(drainTimer);
  laneTimer = telemetryTimer = drainTimer = undefined;
  started = false;
}

export async function runLocalSyncOnce(): Promise<void> {
  if (!govConfig.cloud.controlPlaneUrl) return;
  await Promise.allSettled([pullCloudLanes(), pullAgentStatuses(), pullCloudPolicies(), pullCloudClassifiers()]);
  await pollLocalTelemetryOnce();
  await drainSyncOutbox();
}

async function pullCloudPolicies(): Promise<void> {
  const policies = await cpFetch<PolicyRecord[]>('/api/gov/policies?status=active');
  const store = govStore();
  let changed = false;
  for (const rec of policies) {
    const current = await store.getPolicy(rec.policy.id, rec.policy.version);
    if (!current || JSON.stringify(current.policy) !== JSON.stringify(rec.policy) || current.status !== 'active') {
      await store.savePolicy({ ...rec, status: 'active', updatedBy: rec.updatedBy ?? 'cloud-sync' });
      changed = true;
    }
  }
  if (changed) invalidatePolicyCache();
}

async function pullCloudClassifiers(): Promise<void> {
  const remote = await cpFetch<{ config?: unknown }>('/api/gov/classifiers');
  if (!remote?.config) return;
  const local = await govStore().getSetting(CLASSIFIER_SETTING_KEY);
  if (JSON.stringify(local?.value) === JSON.stringify(remote.config)) return;
  const r = await saveClassifierConfig(remote.config, 'cloud-sync');
  if (!r.ok) console.warn(`[gov-sync] cloud classifier config rejected: ${r.errors.join('; ')}`);
}

async function pullCloudLanes(): Promise<void> {
  const lanes = await cpFetch<LaneRecord[]>('/api/gov/lanes?status=active');
  const store = govStore();
  for (const rec of lanes) {
    const current = await store.getLane(rec.lane.id, rec.lane.version);
    if (!current || JSON.stringify(current.lane) !== JSON.stringify(rec.lane) || current.status !== rec.status) {
      // Cloud is authoritative for colliding lane id+version. Local file lanes with different ids remain.
      await store.saveLane({ ...rec, status: 'active', updatedBy: rec.updatedBy ?? 'cloud-sync' });
    }
  }
}

async function pullAgentStatuses(): Promise<void> {
  const agents = await cpFetch<RegisteredAgent[]>('/api/gov/agents').catch(() => []);
  const store = govStore();
  for (const remote of agents) {
    const local = await store.getAgent(remote.id);
    if (!local || local.status !== remote.status || local.statusReason !== remote.statusReason) await store.upsertAgent({ ...local, ...remote });
  }
}

export async function pollLocalTelemetryOnce(batchSize = 100): Promise<void> {
  const last = Number(getPollerState('governance-sync', 'lastEventId', '0'));
  const rows = all<{
    id: number; session_id: string; agent_id: string; parent_event_id: number | null; event_type: MirroredEvent['eventType']; raw_event_name: string | null;
    tool_name: string | null; tool_use_id: string | null; external_id: string | null; status: MirroredEvent['status'] | null; duration_ms: number | null;
    input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; error_text: string | null; model: string | null;
    payload: string | null; created_at: string; capture_channel: MirroredEvent['captureChannel'] | null; category: string | null; mcp_server: string | null; risk_level: string | null; redaction: string | null;
  }>('SELECT id, session_id, agent_id, parent_event_id, event_type, raw_event_name, tool_name, tool_use_id, external_id, status, duration_ms, input_tokens, output_tokens, cache_read_input_tokens, error_text, model, payload, created_at, capture_channel, category, mcp_server, risk_level, redaction FROM events WHERE id > ? ORDER BY id ASC LIMIT ?', [last, batchSize]);
  const store = govStore();
  let maxId = last;
  for (const r of rows) {
    maxId = Math.max(maxId, r.id);
    const findings = all<{ kind: string; key: string; label: string | null; severity: string | null }>('SELECT kind, key, label, severity FROM findings WHERE event_id = ? ORDER BY id ASC', [r.id])
      .map(f => ({ kind: f.kind, key: f.key, label: f.label ?? '', severity: f.severity }));
    const event: MirroredEvent = {
      id: r.id,
      sourceEventId: r.id,
      sessionId: r.session_id,
      agentId: r.agent_id,
      eventType: r.event_type,
      rawEventName: r.raw_event_name ?? r.event_type,
      toolName: r.tool_name ?? undefined,
      toolUseId: r.tool_use_id ?? undefined,
      externalId: r.external_id ?? undefined,
      status: r.status ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      parentEventId: r.parent_event_id ?? undefined,
      inputTokens: r.input_tokens ?? undefined,
      outputTokens: r.output_tokens ?? undefined,
      cacheReadInputTokens: r.cache_read_input_tokens ?? undefined,
      errorText: r.error_text ?? undefined,
      model: r.model ?? undefined,
      payload: parsePayload(r.payload),
      occurredAt: r.created_at,
      captureChannel: r.capture_channel ?? undefined,
      category: r.category,
      mcpServer: r.mcp_server,
      riskLevel: r.risk_level,
      findings,
      redaction: r.redaction,
    };
    await store.enqueue('sync', { kind: 'event', event: await applyDataPolicy(event) } satisfies SyncOutboxItem);
  }
  if (maxId > last) setPollerState('governance-sync', 'lastEventId', String(maxId));
}

export async function drainSyncOutbox(batchSize = 50): Promise<void> {
  if (!govConfig.cloud.controlPlaneUrl) return;
  const store = govStore();
  const batch = await store.dequeue('sync', batchSize);
  if (!batch.length) return;
  const { selected, overflow } = selectOutboxBatch(batch, b => ({ deviceId: deviceId(), items: b.map(i => i.item) }));
  if (overflow.length) await store.nack('sync', overflow.map(b => b.id));
  await drainClaimedOutbox(selected, async part => {
    await cpFetch('/api/gov/sync/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId(), items: part.map(b => b.item) }),
    });
  });
}

async function applyDataPolicy(event: MirroredEvent): Promise<MirroredEvent> {
  const policy = await resolveDataPolicy(event.sessionId);
  if (policy !== 'metadata-only') return event;
  const { payload: _payload, errorText: _errorText, ...rest } = event;
  const cleaned = { ...rest } as MirroredEvent;
  delete (cleaned as { input?: unknown }).input;
  delete (cleaned as { result?: unknown }).result;
  return cleaned;
}

async function resolveDataPolicy(sessionId: string): Promise<'redacted' | 'full' | 'metadata-only'> {
  const store = govStore();
  const recent = await store.queryDecisions({ sessionId, limit: 1 }).catch(() => ({ items: [] as Decision[] }));
  const laneId = recent.items[0]?.laneId;
  if (laneId) {
    const lane = await store.getLane(laneId).catch(() => undefined);
    if (lane?.lane.sync?.dataPolicy) return lane.lane.sync.dataPolicy;
  }
  const lanes = await store.listLanes(['active']).catch(() => [] as LaneRecord[]);
  lanes.sort((a, b) => (b.lane.priority ?? 0) - (a.lane.priority ?? 0));
  return lanes[0]?.lane.sync?.dataPolicy ?? 'redacted';
}

function parsePayload(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// ── Cloud mode: mirror events ingested directly by this replica (e.g. cloud-agent hooks) ──
// The container's SQLite is ephemeral and per-replica, so events are copied into Cosmos telemetry.
// Local row ids restart with every container, hence the per-boot prefix on document ids.
const BOOT_ID = `${process.env.CONTAINER_APP_REPLICA_NAME ?? process.env.HOSTNAME ?? 'cp'}:${Date.now().toString(36)}`;

function startCloudMirror(): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollLocalTelemetryOnce(200);
      await drainCloudMirrorOnce(200);
    } catch (err) {
      console.warn('[gov-sync] cloud mirror failed', err);
    } finally {
      running = false;
    }
  };
  telemetryTimer = setInterval(() => { void tick(); }, 3_000);
  telemetryTimer.unref?.();
}

export async function drainCloudMirrorOnce(batchSize = 200): Promise<void> {
  const store = govStore();
  const batch = await store.dequeue('sync', batchSize);
  if (!batch.length) return;
  const { selected, overflow } = selectOutboxBatch(batch, b => b.map(i => i.item));
  if (overflow.length) await store.nack('sync', overflow.map(b => b.id));
  await drainClaimedOutbox(selected, async part => {
    const events = part
      .map(b => b.item as SyncOutboxItem)
      .filter((i): i is Extract<SyncOutboxItem, { kind: 'event' }> => i.kind === 'event')
      .map(i => ({ ...i.event, id: `${BOOT_ID}:${i.event.id ?? i.event.sourceEventId}` }));
    if (!events.length) return;
    const { CosmosTelemetrySink } = await import('../store/cosmos-telemetry');
    mirrorSink ??= new CosmosTelemetrySink();
    await mirrorSink.writeEvents(events);
  });
}
let mirrorSink: import('../store/cosmos-telemetry').CosmosTelemetrySink | undefined;

function deviceId(): string {
  if (process.env.GOVERNANCE_DEVICE_ID) return process.env.GOVERNANCE_DEVICE_ID;
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'local-device';
}

async function cpFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const base = govConfig.cloud.controlPlaneUrl.replace(/\/+$/, '');
  const headers = new Headers(init.headers);
  if (govConfig.cloud.deviceToken) headers.set('authorization', `Bearer ${govConfig.cloud.deviceToken}`);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) throw new ControlPlaneError(init.method ?? 'GET', path, res.status);
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

class ControlPlaneError extends Error {
  constructor(method: string, path: string, public readonly status: number) {
    super(`control-plane ${method} ${path} failed: ${status}`);
  }
}

function selectOutboxBatch<T>(batch: OutboxClaim[], body: (items: OutboxClaim[]) => T): { selected: OutboxClaim[]; overflow: OutboxClaim[] } {
  const selected: OutboxClaim[] = [];
  for (const item of batch) {
    const next = [...selected, item];
    if (selected.length && serializedBytes(body(next)) > OUTBOX_MAX_BATCH_BYTES) break;
    selected.push(item);
  }
  return { selected, overflow: batch.slice(selected.length) };
}

async function drainClaimedOutbox(batch: OutboxClaim[], send: (batch: OutboxClaim[]) => Promise<void>): Promise<void> {
  const store = govStore();
  const overLimit = batch.filter(b => b.attempts > OUTBOX_MAX_ATTEMPTS);
  if (overLimit.length) await deadLetterOutbox(store, overLimit, 'attempt cap exceeded');
  const pending = batch.filter(b => b.attempts <= OUTBOX_MAX_ATTEMPTS);
  if (!pending.length) return;
  try {
    await send(pending);
    await store.ack('sync', pending.map(b => b.id));
  } catch (err) {
    if (pending.length > 1) {
      const mid = Math.ceil(pending.length / 2);
      const results = await Promise.allSettled([
        drainClaimedOutbox(pending.slice(0, mid), send),
        drainClaimedOutbox(pending.slice(mid), send),
      ]);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejected) throw rejected.reason;
      return;
    }
    const [item] = pending;
    const status = httpStatus(err);
    if (item.attempts >= OUTBOX_MAX_ATTEMPTS || isPoisonStatus(status)) {
      await deadLetterOutbox(store, [item], isPoisonStatus(status) ? `poison status ${status}` : 'attempt cap reached');
      return;
    }
    await store.nack('sync', [item.id]);
    throw err;
  }
}

async function deadLetterOutbox(store: ReturnType<typeof govStore>, items: OutboxClaim[], reason: string): Promise<void> {
  await store.ack('sync', items.map(i => i.id));
  for (const item of items) console.warn('[gov-sync] dead-lettered outbox item', { id: item.id, kind: itemKind(item), reason });
}

function itemKind(item: OutboxClaim): string {
  const kind = (item.item as { kind?: unknown })?.kind;
  return typeof kind === 'string' ? kind : 'unknown';
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown; statusCode?: unknown; code?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode
    ?? (err as { code?: unknown })?.code;
  const n = Number(status);
  return Number.isFinite(n) ? n : undefined;
}

function isPoisonStatus(status: number | undefined): boolean {
  return status != null && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}
