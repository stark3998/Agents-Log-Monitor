import { Router } from 'express';
import { hasRole, requireRole } from '../auth';
import { govStore } from '../store';
import type { Decision } from '../types';
import { CosmosTelemetrySink, type MirroredEvent } from '../store/cosmos-telemetry';
import { ingestPostureReport, PostureOwnershipError } from '../posture';
import { parsePostureReport } from '../posture/schema';
import type { PostureReport } from '../../posture/types';

interface SyncIngestBody {
  deviceId?: string;
  items?: ({ kind: 'decision'; decision: Decision } | { kind: 'event'; event: MirroredEvent } | { kind: 'posture'; report: PostureReport })[];
  decisions?: Decision[];
  events?: MirroredEvent[];
}

const router = Router();
let sink: CosmosTelemetrySink | undefined;

async function telemetrySink(): Promise<CosmosTelemetrySink> {
  if (!sink) {
    sink = new CosmosTelemetrySink();
    await sink.init();
  }
  return sink;
}

function safeId(v: unknown): string {
  return String(v ?? '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 256) || 'unknown';
}

function reportedDecision(d: Decision, deviceId: string, receivedAt: string): Decision & { origin: unknown; receivedAt: string } {
  const {
    seq: originalSeq,
    prevHash: _prevHash,
    hash: originalHash,
    approver: _approver,
    approvalId: _approvalId,
    id,
    requestId,
    createdAt,
    ...rest
  } = d;
  const originalId = safeId(id);
  const originalRequestId = safeId(requestId);
  return {
    ...rest,
    id: `${deviceId}:${originalId}`,
    requestId: `${deviceId}:${originalRequestId}`,
    agentId: d.agentId,
    laneId: d.laneId,
    createdAt: receivedAt,
    receivedAt,
    origin: { deviceId, reported: true, originalHash, originalSeq, createdAt, id, requestId },
  } as Decision & { origin: unknown; receivedAt: string };
}

router.post('/sync/ingest', async (req, res, next) => {
  try {
    const principal = req.principal;
    if (!principal || (principal.kind !== 'device' && !hasRole(principal, 'Agent'))) {
      res.status(403).json({ error: 'requires device principal or Agent role' });
      return;
    }
    const body = req.body as SyncIngestBody;
    const deviceId = safeId(principal.id);
    const decisions: Decision[] = [...(body.decisions ?? [])];
    const events: MirroredEvent[] = [...(body.events ?? [])];
    const reports: PostureReport[] = [];
    for (const item of body.items ?? []) {
      if (item.kind === 'decision') decisions.push(item.decision);
      else if (item.kind === 'event') events.push(item.event);
      else if (item.kind === 'posture') {
        const { report } = parsePostureReport(item.report);
        if (report) reports.push(report);
      }
    }

    const appended: Decision[] = [];
    for (const d of decisions) {
      appended.push(await govStore().appendDecision(reportedDecision(d, deviceId, new Date().toISOString())));
    }
    if (events.length) await (await telemetrySink()).writeEvents(events.map(e => ({ ...e, originDeviceId: deviceId } as MirroredEvent & { originDeviceId: string })));
    let posture = 0;
    for (const r of reports.slice(0, 5)) {
      try { await ingestPostureReport(r, 'device', deviceId); posture++; }
      catch (err) { if (!(err instanceof PostureOwnershipError)) throw err; console.warn(`[sync] ${err.message}`); }
    }
    res.json({ ok: true, decisions: appended.length, events: events.length, posture });
  } catch (err) { next(err); }
});

router.get('/sync/lanes', requireRole('Agent'), async (_req, res, next) => {
  try { res.json(await govStore().listLanes(['active'])); } catch (err) { next(err); }
});

export default router;
export { router as ingestRouter };
