import crypto from 'crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { redactDeep, redactString } from '../../analytics/redact';
import { govConfig } from '../config';
import { govBus } from '../events';
import { govStore } from '../store';
import type { AlertChannel, Approval, Decision, Incident, Lane, Severity } from '../types';

type AlertKind = 'decision' | 'approval' | 'incident';

interface AlertPayload {
  kind: AlertKind;
  severity: Severity;
  title: string;
  channels: AlertChannel[];
  data: Record<string, unknown>;
  dedupeKey: string;
  count: number;
  createdAt: string;
}

interface AlertOutboxItem {
  channel: AlertChannel;
  payload: AlertPayload;
}

const DEFAULT_ALERTS: Partial<Record<Severity, AlertChannel[]>> = {
  critical: ['teams', 'email', 'webhook'],
  high: ['teams', 'webhook'],
  medium: ['webhook'],
  low: ['webhook'],
};
const DEDUPE_WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;
const credential = new DefaultAzureCredential();
let started = false;
let worker: NodeJS.Timeout | undefined;
const throttle = new Map<string, { until: number; count: number }>();
const handlers = {
  decision: (d: Decision) => { void onDecision(d).catch(err => console.error('[alerts] decision alert failed:', err)); },
  approval: (a: Approval) => { void onApproval(a).catch(err => console.error('[alerts] approval alert failed:', err)); },
  incidentCreated: (i: Incident) => { void onIncident(i).catch(err => console.error('[alerts] incident alert failed:', err)); },
  incidentUpdated: (i: Incident) => {
    if (i.state === 'contained') void onIncident(i).catch(err => console.error('[alerts] incident alert failed:', err));
  },
};

function nowIso(): string { return new Date().toISOString(); }

function rank(s: Severity): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[s];
}

function configured(channel: AlertChannel): boolean {
  if (channel === 'teams') return !!govConfig.alerts.teamsWebhookUrl;
  if (channel === 'webhook') return govConfig.alerts.webhookUrls.length > 0 && !!govConfig.alerts.webhookSecret;
  return !!govConfig.alerts.acsConnectionEndpoint && !!govConfig.alerts.emailFrom && govConfig.alerts.emailTo.length > 0;
}

function dashboardUrl(path: string): string {
  const base = (govConfig.alerts.dashboardUrl || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${path}`;
}

function decisionSeverity(d: Decision): Severity {
  if (d.wouldDeny) return 'low';
  if (d.riskLevel === 'critical' || d.stage === 'kill_switch' || d.stage === 'limits') return 'critical';
  if (d.effectiveVerdict === 'deny' && d.riskLevel === 'high') return 'high';
  return 'medium';
}

async function channelsFor(laneId: string | undefined, severity: Severity): Promise<AlertChannel[]> {
  let lane: Lane | undefined;
  if (laneId) lane = (await govStore().getLane(laneId).catch(() => undefined))?.lane;
  const wanted = lane?.alerts?.[severity] ?? DEFAULT_ALERTS[severity] ?? [];
  return [...new Set(wanted)].filter(configured);
}

async function enqueue(payload: AlertPayload): Promise<void> {
  const key = payload.dedupeKey;
  const cur = throttle.get(key);
  if (cur && cur.until > Date.now()) {
    cur.count++;
    return;
  }
  throttle.set(key, { until: Date.now() + DEDUPE_WINDOW_MS, count: 1 });
  for (const channel of payload.channels) {
    await govStore().enqueue('alerts', { channel, payload } satisfies AlertOutboxItem);
  }
}

function safeText(v: unknown): string {
  const s = redactString(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  return s.replace(/((?:api[_-]?key|access[_-]?key|client[_-]?secret|secret|token|password|passwd|pwd)\s*[:=]\s*)([^,\s;"']+)/gi, '$1[REDACTED]');
}

function sanitizeDeep(v: unknown): unknown {
  if (typeof v === 'string') return safeText(v);
  if (Array.isArray(v)) return v.map(sanitizeDeep);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, sanitizeDeep(val)]));
}

async function onDecision(d: Decision): Promise<void> {
  if (d.effectiveVerdict !== 'deny' && !d.wouldDeny) return;
  const severity = decisionSeverity(d);
  const channels = await channelsFor(d.laneId, severity);
  if (!channels.length) return;
  const rule = d.ruleIds[0] ?? d.stage;
  await enqueue({
    kind: 'decision',
    severity,
    title: d.wouldDeny ? 'Governance would deny action' : 'Governance denied action',
    channels,
    dedupeKey: `decision:${d.agentId}:${rule}`,
    count: 1,
    createdAt: nowIso(),
    data: redactDeep({
      decisionId: d.id,
      agentId: d.agentId,
      laneId: d.laneId,
      sessionId: d.sessionId,
      toolName: d.toolName,
      reason: d.reason,
      riskLevel: d.riskLevel,
      ruleIds: d.ruleIds,
      stage: d.stage,
      sessionUrl: dashboardUrl(`/conversations?c=${encodeURIComponent(d.sessionId)}`),
    }),
  });
}

async function onApproval(a: Approval): Promise<void> {
  const channels = await channelsFor(a.laneId, 'high');
  if (!channels.length) return;
  await enqueue({
    kind: 'approval',
    severity: 'high',
    title: 'Approval requested',
    channels,
    dedupeKey: `approval:${a.id}`,
    count: 1,
    createdAt: nowIso(),
    data: redactDeep({
      approvalId: a.id,
      agentId: a.agentId,
      laneId: a.laneId,
      sessionId: a.sessionId,
      toolName: a.toolName,
      summary: a.summary,
      reason: a.reason,
      approveUrl: dashboardUrl(`/approvals?id=${encodeURIComponent(a.id)}&action=approve`),
      denyUrl: dashboardUrl(`/approvals?id=${encodeURIComponent(a.id)}&action=deny`),
      sessionUrl: dashboardUrl(`/conversations?c=${encodeURIComponent(a.sessionId)}`),
    }),
  });
}

async function onIncident(i: Incident): Promise<void> {
  const laneId = 'default';
  const channels = await channelsFor(laneId, i.severity);
  if (!channels.length) return;
  await enqueue({
    kind: 'incident',
    severity: i.severity,
    title: `Incident: ${safeText(i.title)}`,
    channels,
    dedupeKey: `incident:${i.id}:${i.state}`,
    count: 1,
    createdAt: nowIso(),
    data: redactDeep({
      incidentId: i.id,
      title: i.title,
      state: i.state,
      trigger: i.trigger,
      agentIds: i.agentIds,
      sessionIds: i.sessionIds,
      decisionIds: i.decisionIds,
      summary: i.summary,
      url: dashboardUrl(`/incidents?id=${encodeURIComponent(i.id)}`),
    }),
  });
}

function fact(title: string, value: unknown): { title: string; value: string } {
  return { title, value: safeText(value) };
}

function adaptiveCard(payload: AlertPayload): Record<string, unknown> {
  const data = payload.data;
  const facts = [
    fact('Severity', payload.severity),
    fact('Agent', data.agentId ?? (Array.isArray(data.agentIds) ? data.agentIds.join(', ') : '')),
    fact('Lane', data.laneId ?? ''),
    fact('Tool', data.toolName ?? ''),
    fact('Reason', data.reason ?? data.summary ?? ''),
    fact('Risk', data.riskLevel ?? ''),
    fact('Session', data.sessionUrl ?? ''),
  ].filter(f => f.value);
  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: payload.title, weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: `Severity: ${payload.severity}${payload.count > 1 ? ` (${payload.count} similar)` : ''}`, wrap: true },
  ];
  if (facts.length) body.push({ type: 'FactSet', facts });
  const actions: Record<string, unknown>[] = [];
  if (payload.kind === 'approval') {
    actions.push(
      { type: 'Action.OpenUrl', title: 'Approve', url: data.approveUrl },
      { type: 'Action.OpenUrl', title: 'Deny', url: data.denyUrl },
    );
  } else if (typeof data.sessionUrl === 'string') {
    actions.push({ type: 'Action.OpenUrl', title: 'Open session', url: data.sessionUrl });
  } else if (typeof data.url === 'string') {
    actions.push({ type: 'Action.OpenUrl', title: 'Open incident', url: data.url });
  }
  return {
    type: 'AdaptiveCard',
    $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body,
    actions,
  };
}

async function sendTeams(payload: AlertPayload): Promise<void> {
  const res = await fetch(govConfig.alerts.teamsWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: adaptiveCard(payload) }],
    }),
  });
  if (!res.ok) throw new Error(`Teams webhook failed: ${res.status} ${await res.text().catch(() => '')}`);
}

async function sendWebhook(payload: AlertPayload): Promise<void> {
  for (const url of govConfig.alerts.webhookUrls) {
    const body = JSON.stringify({ type: payload.kind, severity: payload.severity, data: sanitizeDeep(redactDeep(payload.data)) });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', govConfig.alerts.webhookSecret).update(body).digest('hex');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-AgentGov-Signature': `sha256=${sig}`,
        'X-AgentGov-Timestamp': timestamp,
      },
      body,
    });
    if (!res.ok) throw new Error(`Webhook ${url} failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
}

async function sendEmail(payload: AlertPayload): Promise<void> {
  const token = await credential.getToken('https://communication.azure.com/.default');
  if (!token?.token) throw new Error('Azure Communication Services token unavailable');
  const endpoint = govConfig.alerts.acsConnectionEndpoint.replace(/\/$/, '');
  const lines = [
    payload.title,
    `Severity: ${payload.severity}`,
    ...Object.entries(payload.data).map(([k, v]) => `${k}: ${safeText(v)}`),
  ];
  const body = {
    senderAddress: govConfig.alerts.emailFrom,
    recipients: { to: govConfig.alerts.emailTo.map(address => ({ address })) },
    content: {
      subject: `[AgentGov ${payload.severity}] ${payload.title}`,
      plainText: lines.join('\n'),
      html: `<h2>${safeText(payload.title)}</h2><ul>${lines.slice(1).map(l => `<li>${safeText(l)}</li>`).join('')}</ul>`,
    },
  };
  const res = await fetch(`${endpoint}/emails:send?api-version=2023-03-31`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ACS Email failed: ${res.status} ${await res.text().catch(() => '')}`);
}

async function deliver(item: AlertOutboxItem): Promise<void> {
  if (!configured(item.channel)) return;
  if (item.channel === 'teams') await sendTeams(item.payload);
  else if (item.channel === 'webhook') await sendWebhook(item.payload);
  else await sendEmail(item.payload);
}

function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

async function processAlertsBatch(): Promise<void> {
  const rows = await govStore().dequeue('alerts', BATCH_SIZE);
  const ack: string[] = [];
  for (const row of rows) {
    try {
      await deliver(row.item as AlertOutboxItem);
      ack.push(row.id);
    } catch (err) {
      if (row.attempts >= MAX_ATTEMPTS) {
        console.error('[alerts] dropping alert after retries:', (err as Error).message);
        ack.push(row.id);
      } else {
        const t = setTimeout(() => {
          void govStore().nack('alerts', [row.id]).catch(e => console.error('[alerts] retry nack failed:', e));
        }, retryDelayMs(row.attempts));
        t.unref?.();
      }
    }
  }
  if (ack.length) await govStore().ack('alerts', ack);
}

export function startAlerts(): void {
  if (started) return;
  started = true;
  govBus.on('decision', handlers.decision);
  govBus.on('approval.requested', handlers.approval);
  govBus.on('incident.created', handlers.incidentCreated);
  govBus.on('incident.updated', handlers.incidentUpdated);
  worker = setInterval(() => { void processAlertsBatch().catch(err => console.error('[alerts] worker failed:', err)); }, 1000);
  worker.unref?.();
  void processAlertsBatch().catch(err => console.error('[alerts] worker failed:', err));
}

export async function __runAlertWorkerForTests(): Promise<void> {
  await processAlertsBatch();
}

export function __resetAlertsForTests(): void {
  if (worker) clearInterval(worker);
  worker = undefined;
  if (started) {
    govBus.off('decision', handlers.decision);
    govBus.off('approval.requested', handlers.approval);
    govBus.off('incident.created', handlers.incidentCreated);
    govBus.off('incident.updated', handlers.incidentUpdated);
  }
  started = false;
  throttle.clear();
}

export const __private = { adaptiveCard, decisionSeverity, rank };
