import { Router } from 'express';
import { docHref, getDoc, listDocs, searchDocChunks, searchDocs } from './catalog';

/**
 * Documentation API for the Docs tab:
 *   GET /api/docs                     — sections with every doc's metadata (title, description, headings)
 *   GET /api/docs/page?id=fleet       — one doc: Markdown content, links, backlinks, prev/next (id or repo path)
 *   GET /api/docs/search?q=…&limit=20 — ranked heading-level hits with snippets (`&text=1` adds section Markdown)
 */
const router = Router();

router.get('/', (_req, res) => {
  res.json(listDocs());
});

router.get('/page', (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : typeof req.query.path === 'string' ? req.query.path : '';
  const doc = id ? getDoc(id) : null;
  if (!doc) { res.status(404).json({ error: `document not found: ${id || '(none)'}` }); return; }
  res.json(doc);
});

router.get('/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const n = Number(req.query.limit);
  const opts = { limit: Number.isFinite(n) && n > 0 ? n : 20 };
  if (!q.trim()) { res.json({ query: q, hits: [] }); return; }
  // `text=1` adds each hit's section Markdown and in-app link (used by the intelligence service for grounding).
  if (req.query.text === '1' || req.query.text === 'true') {
    res.json({ query: q, hits: searchDocChunks(q, { ...opts, perDoc: 2 }).map(h => ({ ...h, link: docHref(h.id, h.anchor), text: h.text.slice(0, 2500) })) });
    return;
  }
  res.json({ query: q, hits: searchDocs(q, opts) });
});

export default router;
