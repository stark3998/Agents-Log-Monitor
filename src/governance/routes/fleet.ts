import { Router } from 'express';
import { requireRole } from '../auth';
import { govBus } from '../events';
import { govStore } from '../store';
import type { FleetAlert, FleetAlertQuery } from '../types';

/**
 * Monitoring-fleet (fleet/) ingestion and query API.
 *   POST /api/gov/fleet/alerts   {alerts: FleetAlert[]}   role Agent | PolicyAdmin (the fleet's identity)
 *   GET  /api/gov/fleet/alerts   ?severity=&type=&platform=&agent=&session=&incident=&since=&limit=
 *   GET  /api/gov/fleet/alerts/:id
 *   GET  /api/gov/fleet/summary  ?since=   counts by type / severity / platform / agent
 */
const router = Router();
const SEVERITIES = new Set(['informational', 'low', 'medium', 'high', 'critical']);
const MAX_BATCH = 500;

function arr(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  return (Array.isArray(v) ? v : String(v).split(',')).map(String).filter(Boolean);
}

function validAlert(a: unknown): a is FleetAlert {
  const x = a as Partial<FleetAlert>;
  return !!x && typeof x.alert_id === 'string' && x.alert_id.length <= 100 && typeof x.alert_type === 'string'
    && typeof x.severity === 'string' && SEVERITIES.has(x.severity) && typeof x.score === 'number'
    && typeof x.title === 'string' && typeof x.summary === 'string' && typeof x.platform === 'string'
    && typeof x.created_at === 'string' && !Number.isNaN(Date.parse(x.created_at));
}

router.post('/fleet/alerts', requireRole('Agent', 'PolicyAdmin'), async (req, res) => {
  const alerts = (req.body?.alerts ?? []) as unknown[];
  if (!Array.isArray(alerts) || alerts.length > MAX_BATCH) {
    res.status(400).json({ error: `alerts must be an array of at most ${MAX_BATCH}` });
    return;
  }
  const valid = alerts.filter(validAlert);
  if (valid.length !== alerts.length) {
    res.status(400).json({ error: 'invalid alert(s)', rejected: alerts.length - valid.length });
    return;
  }
  const at = new Date().toISOString();
  const stamped = valid.map(a => ({ ...a, summary: a.summary.slice(0, 4000), received_at: at }));
  const n = await govStore().upsertFleetAlerts(stamped);
  govBus.emit('fleet.alerts', stamped);
  res.status(202).json({ accepted: n });
});

router.get('/fleet/alerts', requireRole('Viewer'), async (req, res) => {
  const q: FleetAlertQuery = {
    severity: arr(req.query.severity) as FleetAlertQuery['severity'], alertType: arr(req.query.type),
    platform: arr(req.query.platform), agent: req.query.agent as string | undefined,
    sessionId: req.query.session as string | undefined, incidentId: req.query.incident as string | undefined,
    since: req.query.since as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined,
  };
  res.json(await govStore().listFleetAlerts(q));
});

router.get('/fleet/alerts/:id', requireRole('Viewer'), async (req, res) => {
  const a = await govStore().getFleetAlert(req.params.id);
  if (!a) { res.status(404).json({ error: 'not found' }); return; }
  res.json(a);
});

router.get('/fleet/summary', requireRole('Viewer'), async (req, res) => {
  const since = (req.query.since as string | undefined) ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const alerts = await govStore().listFleetAlerts({ since, limit: 2000 });
  const count = (key: (a: FleetAlert) => string | null | undefined) => {
    const m: Record<string, number> = {};
    for (const a of alerts) { const k = key(a) || 'unknown'; m[k] = (m[k] ?? 0) + 1; }
    return m;
  };
  res.json({
    since, total: alerts.length,
    bySeverity: count(a => a.severity), byType: count(a => a.alert_type), byPlatform: count(a => a.platform),
    byAgent: count(a => a.agent_name ?? a.agent_id), byOwaspAgentic: count(a => (a.owasp_agentic ?? [])[0]),
  });
});

export default router;
