import { Router, Request, Response } from 'express';
import { getCollector } from '../collectors/registry';
import { processNormalizedEvent } from '../pipeline';

const router = Router();

// POST /ingest/:collectorId  — Claude Code calls this directly as HTTP hook
// POST /ingest/event?source= — forwarder scripts call this (Copilot, future sources)
router.post('/:collectorId', (req: Request, res: Response) => {
  // Ack immediately; process on next tick so hooks never wait on us.
  res.status(200).json({ ok: true });

  setImmediate(() => {
    const collectorId = req.params.collectorId === 'event'
      ? (req.query.source as string) ?? 'unknown'
      : req.params.collectorId;

    const collector = getCollector(collectorId);
    if (!collector) {
      console.warn(`[ingest] unknown collector: ${collectorId}`);
      return;
    }

    let events;
    try {
      events = collector.normalize(req.body);
    } catch (err) {
      console.error(`[ingest] normalize error for ${collectorId}:`, err);
      return;
    }

    for (const e of events) processNormalizedEvent(e, collectorId);
  });
});

export default router;
