import { Router, Request, Response } from 'express';
import { all, get } from '../db';
import { replayTranscript } from '../transcript-watcher';

const router = Router();

// GET /api/sessions
router.get('/sessions', (_req: Request, res: Response) => {
  const rows = all(`
    SELECT s.id, s.source, s.project_path, s.title, s.started_at, s.ended_at,
           COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 100
  `);
  res.json(rows);
});

// GET /api/sessions/:id/tree
router.get('/sessions/:id/tree', (req: Request, res: Response) => {
  const { id } = req.params;
  const session = get<Record<string, unknown>>('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  // Import thinking/assistant_text events after responding — non-blocking
  if (typeof session.transcript_path === 'string' && session.transcript_path) {
    const tp = session.transcript_path;
    setImmediate(() => replayTranscript(id, tp));
  }
  const agents = all('SELECT * FROM agents WHERE session_id = ? ORDER BY started_at', [id]);
  const events = all('SELECT * FROM events WHERE session_id = ? ORDER BY created_at', [id]);
  res.json({ session, agents, events });
});

// GET /api/events?session=&agent=&tool=&since=&limit=
router.get('/events', (req: Request, res: Response) => {
  const { session, agent, tool, since } = req.query;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);

  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (session) { conditions.push('session_id = ?'); params.push(session as string); }
  if (agent)   { conditions.push('agent_id = ?');   params.push(agent as string); }
  if (tool)    { conditions.push('tool_name = ?');   params.push(tool as string); }
  if (since)   { conditions.push('created_at > ?');  params.push(since as string); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all(
    `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit],
  );

  res.json(rows);
});

export default router;
