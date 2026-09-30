import crypto from 'crypto';
import { govConfig } from '../config';
import { govBus } from '../events';
import { govStore } from '../store';
import { globMatch } from '../lanes/glob';
import type {
  Incident, PostureCheckSetting, PostureConfig, PostureEndpointRecord, PostureFindingRecord, Severity,
} from '../types';
import type { PostureFindingDraft, PostureReport } from '../../posture/types';

export const POSTURE_SETTING_KEY = 'posture.config';
export const DEFAULT_POSTURE_CONFIG: PostureConfig = {
  checks: {},
  orgDomains: (process.env.POSTURE_ORG_DOMAINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  alertMinSeverity: 'high',
  incidentOnCritical: true,
};

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const SEVERITIES = new Set<Severity>(['info', 'low', 'medium', 'high', 'critical']);
const MAX_EVIDENCE_BYTES = 8 * 1024;
const MAX_FINDINGS_PER_REPORT = 500;

function nowIso(): string { return new Date().toISOString(); }

export function findingId(endpointId: string, checkId: string, subject: string): string {
  return crypto.createHash('sha1').update(`${endpointId}|${checkId}|${subject}`).digest('hex').slice(0, 24);
}

export async function getPostureConfig(): Promise<PostureConfig> {
  const doc = await govStore().getSetting<Partial<PostureConfig>>(POSTURE_SETTING_KEY);
  const v = doc?.value ?? {};
  return {
    ...DEFAULT_POSTURE_CONFIG,
    ...v,
    checks: { ...(v.checks ?? {}) },
    orgDomains: v.orgDomains?.length ? v.orgDomains : DEFAULT_POSTURE_CONFIG.orgDomains,
  };
}

export function validatePostureConfig(raw: unknown): { config?: PostureConfig; errors: string[] } {
  const errors: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const checks: Record<string, PostureCheckSetting> = {};
  for (const [id, v] of Object.entries((o.checks ?? {}) as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') { errors.push(`checks.${id}: expected object`); continue; }
    const s = v as Record<string, unknown>;
    const out: PostureCheckSetting = {};
    if (s.enabled != null) { if (typeof s.enabled === 'boolean') out.enabled = s.enabled; else errors.push(`checks.${id}.enabled: expected boolean`); }
    if (s.severity != null) { if (SEVERITIES.has(s.severity as Severity)) out.severity = s.severity as Severity; else errors.push(`checks.${id}.severity: invalid`); }
    if (s.scope != null) {
      const sc = s.scope as Record<string, unknown>;
      const list = (x: unknown) => Array.isArray(x) ? x.map(String).filter(Boolean) : undefined;
      out.scope = { endpoints: list(sc.endpoints), users: list(sc.users) };
    }
    checks[id] = out;
  }
  const domains = (x: unknown) => Array.isArray(x) ? x.map(d => String(d).trim().toLowerCase().replace(/^@/, '')).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) : [];
  const alertMin = (o.alertMinSeverity ?? 'high') as Severity;
  if (!SEVERITIES.has(alertMin)) errors.push('alertMinSeverity: invalid');
  if (errors.length) return { errors };
  return {
    errors,
    config: {
      checks,
      orgDomains: domains(o.orgDomains),
      corporateSaasDomains: domains(o.corporateSaasDomains),
      alertMinSeverity: alertMin,
      incidentOnCritical: o.incidentOnCritical !== false,
    },
  };
}

export async function savePostureConfig(raw: unknown, by?: string): Promise<{ ok: boolean; errors: string[]; config?: PostureConfig }> {
  const v = validatePostureConfig(raw);
  if (!v.config) return { ok: false, errors: v.errors };
  await govStore().putSetting(POSTURE_SETTING_KEY, v.config, by);
  return { ok: true, errors: [], config: v.config };
}

function checkApplies(setting: PostureCheckSetting | undefined, ep: { id: string; hostname: string; user: string }): boolean {
  if (setting?.enabled === false) return false;
  const eps = setting?.scope?.endpoints?.filter(Boolean);
  if (eps?.length && !eps.some(g => globMatch(g, ep.id) || globMatch(g, ep.hostname))) return false;
  const users = setting?.scope?.users?.filter(Boolean);
  if (users?.length && !users.some(g => globMatch(g, ep.user))) return false;
  return true;
}

function clampEvidence(e: unknown): Record<string, unknown> {
  if (!e || typeof e !== 'object') return {};
  const s = JSON.stringify(e);
  if (s.length <= MAX_EVIDENCE_BYTES) return e as Record<string, unknown>;
  return { truncated: true, preview: s.slice(0, MAX_EVIDENCE_BYTES) };
}

function sanitizeDraft(d: PostureFindingDraft): PostureFindingDraft | null {
  if (!d || typeof d.checkId !== 'string' || typeof d.subject !== 'string') return null;
  const sev = SEVERITIES.has(d.severity as Severity) ? d.severity : 'medium';
  return {
    checkId: d.checkId.slice(0, 100), severity: sev, category: String(d.category ?? '').slice(0, 60) as PostureFindingDraft['category'],
    title: String(d.title ?? d.checkId).slice(0, 200), subject: d.subject.slice(0, 500), summary: String(d.summary ?? '').slice(0, 1000),
    evidence: clampEvidence(d.evidence), fixable: !!d.fixable,
  };
}

interface Transition { finding: PostureFindingRecord; kind: 'new' | 'reopened' }

/**
 * Upsert one level (endpoint or fleet) of findings for an endpoint: new drafts open, resolved ones
 * reopen, expired suppressions reopen, and open findings no longer reported resolve.
 */
async function reconcile(endpoint: { id: string; hostname: string; user: string }, drafts: PostureFindingDraft[], level: 'endpoint' | 'fleet', cfg: PostureConfig): Promise<Transition[]> {
  const store = govStore();
  const now = nowIso();
  const existing = await store.listPostureFindings({ endpointId: endpoint.id, level, limit: 20000 });
  const byId = new Map(existing.map(f => [f.id, f]));
  const seen = new Set<string>();
  const transitions: Transition[] = [];
  for (const raw of drafts.slice(0, MAX_FINDINGS_PER_REPORT)) {
    const d = sanitizeDraft(raw);
    if (!d) continue;
    const setting = cfg.checks[d.checkId];
    if (!checkApplies(setting, endpoint)) continue;
    const id = findingId(endpoint.id, d.checkId, d.subject);
    if (seen.has(id)) continue;
    seen.add(id);
    const severity = (setting?.severity ?? d.severity) as Severity;
    const prev = byId.get(id);
    const base = { endpointId: endpoint.id, hostname: endpoint.hostname, checkId: d.checkId, level, title: d.title, severity, category: d.category, subject: d.subject, summary: d.summary, evidence: d.evidence, fixable: d.fixable, lastSeenAt: now };
    if (!prev) {
      const f: PostureFindingRecord = { id, ...base, state: 'open', firstSeenAt: now };
      await store.upsertPostureFinding(f);
      transitions.push({ finding: f, kind: 'new' });
      continue;
    }
    let state = prev.state;
    let suppression = prev.suppression;
    let kind: Transition['kind'] | null = null;
    if (state === 'resolved') { state = 'open'; kind = 'reopened'; }
    if (state === 'suppressed' && suppression?.until && suppression.until < now) { state = 'open'; suppression = undefined; kind = 'reopened'; }
    const f: PostureFindingRecord = { ...prev, ...base, state, suppression, resolvedAt: state === 'open' ? undefined : prev.resolvedAt };
    await store.upsertPostureFinding(f);
    if (kind) transitions.push({ finding: f, kind });
  }
  for (const f of existing) {
    if (seen.has(f.id) || f.state !== 'open') continue;
    await store.upsertPostureFinding({ ...f, state: 'resolved', resolvedAt: now });
  }
  return transitions;
}

async function notify(transitions: Transition[], cfg: PostureConfig): Promise<void> {
  if (!transitions.length) return;
  const { alertPostureFinding } = await import('../alerts');
  for (const t of transitions) {
    const f = t.finding;
    if (RANK[f.severity] >= RANK[cfg.alertMinSeverity]) {
      await alertPostureFinding({ id: f.id, checkId: f.checkId, title: f.title, severity: f.severity, endpointId: f.endpointId, hostname: f.hostname, subject: f.subject, summary: f.summary })
        .catch(err => console.warn('[posture] alert failed:', err));
    }
    if (cfg.incidentOnCritical && f.severity === 'critical' && !f.incidentId) {
      const at = nowIso();
      const incident: Incident = {
        id: `inc-posture-${f.id}-${Date.now()}`, title: `${f.title} on ${f.hostname}`, severity: 'critical', state: 'open',
        trigger: 'posture', agentIds: [], sessionIds: [], decisionIds: [], summary: `${f.summary} (finding ${f.id}, subject ${f.subject})`,
        createdAt: at, updatedAt: at,
      };
      const saved = await govStore().createIncident(incident);
      govBus.emit('incident.created', saved);
      await govStore().upsertPostureFinding({ ...f, incidentId: saved.id });
    }
  }
}

function counts(findings: PostureFindingRecord[]): Partial<Record<Severity, number>> {
  const out: Partial<Record<Severity, number>> = {};
  for (const f of findings) if (f.state === 'open') out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

async function refreshCounts(endpointId: string): Promise<void> {
  const ep = await govStore().getPostureEndpoint(endpointId);
  if (!ep) return;
  const findings = await govStore().listPostureFindings({ endpointId, state: ['open'], limit: 20000 });
  await govStore().upsertPostureEndpoint({ ...ep, findingCounts: counts(findings) });
}

/** Recompute fleet-level findings across all endpoints (version mismatch, non-corporate users). */
export async function evaluateFleetFindings(cfg?: PostureConfig): Promise<number> {
  const config = cfg ?? await getPostureConfig();
  const { evaluateFleet } = await import('../../posture');
  const endpoints = await govStore().listPostureEndpoints();
  const drafts = evaluateFleet(endpoints.map(e => ({
    endpoint: { endpointId: e.id, hostname: e.hostname, os: e.os as NodeJS.Platform, osRelease: e.osRelease ?? '', user: e.user },
    inventory: { mcpServers: [], extensions: [], scheduledTasks: [], errors: [], ...e.inventory, agents: e.inventory?.agents ?? [], accounts: e.inventory?.accounts ?? [] } as never,
  })), { orgDomains: config.orgDomains });
  let transitions: Transition[] = [];
  for (const ep of endpoints) {
    transitions = transitions.concat(await reconcile({ id: ep.id, hostname: ep.hostname, user: ep.user }, drafts.filter(d => d.endpointId === ep.id), 'fleet', config));
    await refreshCounts(ep.id);
  }
  await notify(transitions, config);
  return drafts.length;
}

export interface IngestResult { endpointId: string; open: number; new: number; reopened: number; resolved: number }

/** A report for an endpoint already bound to a different reporting principal. */
export class PostureOwnershipError extends Error {
  constructor(readonly endpointId: string) { super(`endpoint ${endpointId} is bound to a different reporting device`); }
}

/** Store a scanner report: endpoint + inventory, reconcile endpoint findings, then re-run fleet checks. */
export async function ingestPostureReport(report: PostureReport, source: PostureEndpointRecord['source'], deviceId?: string): Promise<IngestResult> {
  if (!report?.endpoint?.endpointId || !report.inventory) throw new Error('invalid posture report');
  const { sanitizeInventory, redactFreeText } = await import('../../posture');
  const inventory = sanitizeInventory(report.inventory);
  const redactDeepStrings = (v: unknown, depth = 0): unknown => {
    if (typeof v === 'string') return redactFreeText(v, 2000);
    if (depth > 6 || v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 200).map(x => redactDeepStrings(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 200).map(([k, x]) => [k, redactDeepStrings(x, depth + 1)]));
  };
  const findings = (Array.isArray(report.findings) ? report.findings : []).map(f => ({
    ...f, summary: redactFreeText(String(f?.summary ?? ''), 1000),
    evidence: redactDeepStrings(f?.evidence ?? {}) as Record<string, unknown>,
  }));
  const cfg = await getPostureConfig();
  const ep = report.endpoint;
  const endpoint: PostureEndpointRecord = {
    id: String(ep.endpointId).slice(0, 128), hostname: String(ep.hostname ?? '').slice(0, 256), user: String(ep.user ?? '').slice(0, 256),
    os: String(ep.os ?? ''), osRelease: ep.osRelease, lastScanAt: report.scannedAt ?? nowIso(), scannerVersion: report.scannerVersion,
    source, deviceId, inventory: inventory as unknown as PostureEndpointRecord['inventory'], findingCounts: {},
    errors: (inventory.errors ?? []).slice(0, 50),
  };
  const existing = await govStore().getPostureEndpoint(endpoint.id);
  if (existing?.deviceId && deviceId && existing.deviceId !== deviceId) throw new PostureOwnershipError(endpoint.id);
  if (!deviceId && existing?.deviceId) endpoint.deviceId = existing.deviceId;
  const before = await govStore().listPostureFindings({ endpointId: endpoint.id, level: 'endpoint', state: ['open'], limit: 20000 });
  await govStore().upsertPostureEndpoint(endpoint);
  const transitions = await reconcile(endpoint, findings, 'endpoint', cfg);
  const after = await govStore().listPostureFindings({ endpointId: endpoint.id, level: 'endpoint', state: ['open'], limit: 20000 });
  const afterIds = new Set(after.map(f => f.id));
  await refreshCounts(endpoint.id);
  await notify(transitions, cfg);
  await evaluateFleetFindings(cfg).catch(err => console.warn('[posture] fleet evaluation failed:', err));
  govBus.emit('posture.updated', { endpointId: endpoint.id });
  return {
    endpointId: endpoint.id, open: after.length,
    new: transitions.filter(t => t.kind === 'new' && t.finding.level === 'endpoint').length,
    reopened: transitions.filter(t => t.kind === 'reopened' && t.finding.level === 'endpoint').length,
    resolved: before.filter(f => !afterIds.has(f.id)).length,
  };
}

export async function suppressFinding(id: string, by: string, reason: string, until?: string): Promise<PostureFindingRecord | undefined> {
  const f = await govStore().getPostureFinding(id);
  if (!f) return undefined;
  const saved = await govStore().upsertPostureFinding({ ...f, state: 'suppressed', suppression: { reason: reason.slice(0, 500), by, at: nowIso(), until } });
  await refreshCounts(f.endpointId);
  govBus.emit('posture.updated', { endpointId: f.endpointId });
  return saved;
}

export async function unsuppressFinding(id: string): Promise<PostureFindingRecord | undefined> {
  const f = await govStore().getPostureFinding(id);
  if (!f) return undefined;
  const saved = await govStore().upsertPostureFinding({ ...f, state: 'open', suppression: undefined });
  await refreshCounts(f.endpointId);
  govBus.emit('posture.updated', { endpointId: f.endpointId });
  return saved;
}

// ── Local scanning ─────────────────────────────────────────────────────────

let scanning: Promise<IngestResult> | null = null;
let scanTimer: NodeJS.Timeout | undefined;

export async function localEndpointId(): Promise<string> {
  const { stableEndpointId, defaultScanContext } = await import('../../posture');
  const ctx = defaultScanContext();
  return ctx.env.AGENT_MONITOR_ENDPOINT_ID || stableEndpointId(ctx.hostname, ctx.user);
}

/** Scan this machine and ingest the report (single-flight). Local enforcers also forward it to the cloud. */
export async function runLocalScan(): Promise<IngestResult> {
  if (scanning) return scanning;
  scanning = (async () => {
    const cfg = await getPostureConfig();
    const { scanEndpoint } = await import('../../posture');
    const disabledChecks = Object.entries(cfg.checks).filter(([, s]) => s.enabled === false).map(([id]) => id);
    const report = await scanEndpoint({ orgDomains: cfg.orgDomains, corporateSaasDomains: cfg.corporateSaasDomains, disabledChecks });
    const result = await ingestPostureReport(report, 'local');
    if (govConfig.mode === 'local' && govConfig.cloud.controlPlaneUrl) await govStore().enqueue('sync', { kind: 'posture', report });
    return result;
  })();
  try { return await scanning; } finally { scanning = null; }
}

export function startPostureScheduler(): void {
  const minutes = Number(process.env.POSTURE_SCAN_INTERVAL_MIN ?? (govConfig.mode === 'cloud' ? 0 : 360));
  if (!Number.isFinite(minutes) || minutes <= 0 || scanTimer) return;
  const run = () => { void runLocalScan().catch(err => console.warn('[posture] scan failed:', err)); };
  const first = setTimeout(run, Number(process.env.POSTURE_FIRST_SCAN_DELAY_MS ?? 30_000));
  first.unref?.();
  scanTimer = setInterval(run, minutes * 60_000);
  scanTimer.unref?.();
}

export function stopPostureSchedulerForTests(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = undefined;
}

/**
 * Apply a finding's auto-fix. Only for this server's own endpoint (never remote execution). The
 * caller must already be authorised and the action recorded in the audit log.
 */
export async function fixFinding(id: string): Promise<{ status: number; body: unknown }> {
  const f = await govStore().getPostureFinding(id);
  if (!f) return { status: 404, body: { error: 'not found' } };
  if (!f.fixable) return { status: 400, body: { error: 'this finding has no automatic fix; follow the remediation snippet' } };
  if (govConfig.mode !== 'local' || f.endpointId !== await localEndpointId()) {
    return { status: 409, body: { error: 'automatic fixes only run on the endpoint that hosts this monitor; apply the remediation snippet on that device' } };
  }
  const { applyAutoFix } = await import('../../posture');
  const result = await applyAutoFix(f.checkId, f.subject);
  const scan = result.ok ? await runLocalScan().catch(() => null) : null;
  return { status: result.ok ? 200 : 422, body: { ...result, finding: await govStore().getPostureFinding(id), scan } };
}
