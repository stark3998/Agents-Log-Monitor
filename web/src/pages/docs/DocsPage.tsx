import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert, Box, Breadcrumbs, Button, Card, CardActionArea, CardContent, Chip, Divider, InputAdornment, LinearProgress, Link as MuiLink,
  List, ListItemButton, ListItemText, Skeleton, Stack, TextField, Tooltip, Typography, useMediaQuery, useTheme,
} from '@mui/material';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import MenuBookRoundedIcon from '@mui/icons-material/MenuBookRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import SearchOffRoundedIcon from '@mui/icons-material/SearchOffRounded';
import { Link as RouterLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Markdown } from '../../components/Markdown';
import { EmptyState } from '../../components/Common';
import { useAuth } from '../../auth/context';
import { useDoc, useDocSearch, useDocsIndex, type DocDetail, type DocSearchHit, type DocsIndex } from '../../api/docs';
import { docRoute, highlightParts, resolveDocLink } from '../../lib/docs';
import { PageHeader } from '../../components/PageHeader';
import { HEADER_HEIGHT } from '../../components/layout';

/** Offset below the sticky app header, for sticky side panels and anchor scrolling. */
const STICKY_TOP = HEADER_HEIGHT + 20;

const docSx = {
  fontSize: 14.5, lineHeight: 1.72,
  // Break long tokens only when they can't fit a line, so identifiers in table cells stay whole.
  wordBreak: 'normal', overflowWrap: 'break-word',
  '& h1, & h2, & h3, & h4, & h5, & h6': { scrollMarginTop: `${STICKY_TOP}px`, lineHeight: 1.3 },
  '& h1': { fontSize: 28, fontWeight: 700, mt: 0, mb: 2, letterSpacing: '-0.01em' },
  '& h2': { fontSize: 20, fontWeight: 650, mt: 4.5, mb: 1.5, pb: 0.75, borderBottom: '1px solid', borderColor: 'divider' },
  '& h3': { fontSize: 16.5, fontWeight: 600, mt: 3, mb: 1 },
  '& h4, & h5, & h6': { fontSize: 14.5, fontWeight: 600, mt: 2.5, mb: 1 },
  '& p': { my: 1.25 },
  '& li': { my: 0.4 },
  '& code': { fontSize: 12.5 },
  '& pre': { fontSize: 12.5, p: 2, my: 2 },
  '& table': { fontSize: 13, my: 2 },
  '& th': { bgcolor: 'action.hover', fontWeight: 600, textAlign: 'left' },
  '& th, & td': { px: 1.25, py: 0.75, verticalAlign: 'top' },
  '& blockquote': { my: 2, py: 0.5 },
  '& hr': { border: 0, borderTop: '1px solid', borderColor: 'divider', my: 3 },
};

const kbdSx = { fontSize: 11, px: 0.75, borderRadius: 1, border: '1px solid', borderColor: 'divider', color: 'text.secondary', fontFamily: 'var(--am-mono)' };

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.hit
        ? <Box key={i} component="mark" sx={{ bgcolor: 'rgba(250, 204, 21, 0.28)', color: 'inherit', borderRadius: 0.5, px: 0.2 }}>{p.text}</Box>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** Search box bound to `?q=` (debounced). `/` or Ctrl/⌘+K focuses it; Enter opens the top hit; Esc clears. */
function DocsSearchField({ q, onQuery, onSubmit }: { q: string; onQuery: (q: string) => void; onSubmit: () => void }) {
  const [input, setInput] = useState(q);
  const committed = useRef(q);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q !== committed.current) { committed.current = q; setInput(q); }
  }, [q]);

  useEffect(() => {
    if (input === committed.current) return;
    const t = setTimeout(() => { committed.current = input; onQuery(input); }, 180);
    return () => clearTimeout(t);
  }, [input, onQuery]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <TextField
      inputRef={ref}
      fullWidth
      size="small"
      placeholder="Search docs"
      value={input}
      onChange={e => setInput(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); committed.current = input; onQuery(input); onSubmit(); }
        if (e.key === 'Escape') { setInput(''); committed.current = ''; onQuery(''); }
      }}
      slotProps={{
        htmlInput: { 'aria-label': 'Search documentation' },
        input: {
          startAdornment: <InputAdornment position="start"><SearchRoundedIcon fontSize="small" /></InputAdornment>,
          endAdornment: input ? undefined : <InputAdornment position="end"><Box component="kbd" sx={kbdSx}>/</Box></InputAdornment>,
        },
      }}
    />
  );
}

function DocsNav({ index, currentId, home }: { index: DocsIndex; currentId: string | null; home: boolean }) {
  return (
    <Stack spacing={1.5} sx={{ mt: 1.5 }}>
      <ListItemButton component={RouterLink} to="/docs" selected={home} sx={{ borderRadius: 1.5, py: 0.5 }}>
        <MenuBookRoundedIcon sx={{ fontSize: 16, mr: 1, color: 'text.secondary' }} />
        <ListItemText primary="All documentation" slotProps={{ primary: { sx: { fontSize: 13, fontWeight: 600 } } }} />
      </ListItemButton>
      {index.sections.map(s => (
        <Box key={s.title}>
          <Typography variant="overline" component="h3" sx={{ display: 'block', px: 1.25, color: 'text.secondary', lineHeight: 1.8, fontSize: 10.5 }}>{s.title}</Typography>
          <List dense disablePadding>
            {s.docs.map(d => (
              <ListItemButton
                key={d.id}
                component={RouterLink}
                to={docRoute(d.id)}
                selected={d.id === currentId}
                aria-current={d.id === currentId ? 'page' : undefined}
                sx={{ borderRadius: 1.5, py: 0.25, pl: 1.25 }}
              >
                <ListItemText primary={d.title} slotProps={{ primary: { sx: { fontSize: 13 }, noWrap: true, title: d.title } }} />
              </ListItemButton>
            ))}
          </List>
        </Box>
      ))}
    </Stack>
  );
}

function DocsHome({ index }: { index: DocsIndex }) {
  return (
    <Stack spacing={3.5} sx={{ maxWidth: 1100 }}>
      <PageHeader
        title="Documentation"
        description={<>
          {index.count} documents in {index.sections.length} sections, covering architecture, installation, governance, the monitoring fleet and deployment.
          Search with <Box component="kbd" sx={kbdSx}>/</Box> or browse by section. Pages link to each other and list the pages that reference them.
        </>}
      />
      {index.sections.map(s => (
        <Box component="section" key={s.title} aria-label={s.title}>
          <Typography variant="h6" component="h3" sx={{ mb: 1.25, fontSize: 16 }}>{s.title}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 1.5 }}>
            {s.docs.map(d => (
              <Card key={d.id} variant="outlined" sx={{ height: '100%' }}>
                <CardActionArea component={RouterLink} to={docRoute(d.id)} sx={{ height: '100%', display: 'flex', alignItems: 'flex-start' }}>
                  <CardContent sx={{ width: '100%' }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{d.title}</Typography>
                    {d.description && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, fontSize: 12.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {d.description}
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1, fontFamily: 'var(--am-mono)', fontSize: 10.5 }}>{d.path}</Typography>
                  </CardContent>
                </CardActionArea>
              </Card>
            ))}
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

function DocsSearchResults({ q, hits, loading, canAsk }: { q: string; hits: DocSearchHit[] | undefined; loading: boolean; canAsk: boolean }) {
  const ask = canAsk ? (
    <Button size="small" variant="outlined" startIcon={<AutoAwesomeOutlinedIcon />} component={RouterLink} to={`/ask?q=${encodeURIComponent(q)}`}>
      Ask the assistant
    </Button>
  ) : undefined;
  return (
    <Stack spacing={1.5} sx={{ maxWidth: 900 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" component="h2">Search results</Typography>
          <Typography variant="body2" color="text.secondary" role="status">
            {hits ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for “${q}”` : `Searching for “${q}”…`}
          </Typography>
        </Box>
        {hits && hits.length > 0 && ask}
      </Stack>
      {loading && <LinearProgress aria-label="Searching" />}
      {hits && hits.length === 0 && (
        <EmptyState icon={<SearchOffRoundedIcon />} title="No matching documentation" body="Try fewer or different keywords." action={ask} />
      )}
      {hits && hits.length > 0 && (
        <List disablePadding aria-label="Search results">
          {hits.map(h => (
            <ListItemButton
              key={`${h.id}#${h.anchor ?? ''}`}
              component={RouterLink}
              to={docRoute(h.id, h.anchor)}
              sx={{ borderRadius: 2, alignItems: 'flex-start', py: 1.25, mb: 0.75, border: '1px solid', borderColor: 'divider' }}
            >
              <Stack spacing={0.4} sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary">{h.section} › {h.title}</Typography>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}><Highlight text={h.heading ?? h.title} terms={h.terms} /></Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12.5 }}><Highlight text={h.snippet} terms={h.terms} /></Typography>
              </Stack>
            </ListItemButton>
          ))}
        </List>
      )}
    </Stack>
  );
}

function RefChips({ label, refs }: { label: string; refs: { id: string; title: string }[] }) {
  if (!refs.length) return null;
  return (
    <Box>
      <Typography variant="overline" component="h3" color="text.secondary" sx={{ fontSize: 10.5 }}>{label}</Typography>
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75, mt: 0.5 }} aria-label={label}>
        {refs.map(r => <Chip key={r.id} size="small" variant="outlined" clickable component={RouterLink} to={docRoute(r.id)} label={r.title} />)}
      </Stack>
    </Box>
  );
}

function PagerLink({ to, title, dir }: { to: string; title: string; dir: 'prev' | 'next' }) {
  return (
    <Card variant="outlined" sx={{ flex: 1, maxWidth: 360, ml: dir === 'next' ? 'auto !important' : 0 }}>
      <CardActionArea component={RouterLink} to={to} sx={{ p: 1.5, textAlign: dir === 'next' ? 'right' : 'left' }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          {dir === 'prev' ? <><ArrowBackRoundedIcon sx={{ fontSize: 14 }} />Previous</> : <>Next<ArrowForwardRoundedIcon sx={{ fontSize: 14 }} /></>}
        </Typography>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{title}</Typography>
      </CardActionArea>
    </Card>
  );
}

/** "On this page": h2/h3 headings, highlighting the one currently in view. */
function Toc({ doc }: { doc: DocDetail }) {
  const items = useMemo(() => doc.headings.filter(h => h.depth === 2 || h.depth === 3), [doc]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const els = items.map(h => document.getElementById(h.slug)).filter((e): e is HTMLElement => !!e);
    const obs = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: `-${STICKY_TOP}px 0px -65% 0px` });
    els.forEach(e => obs.observe(e));
    return () => obs.disconnect();
  }, [items]);
  if (items.length < 2) return null;
  return (
    <Box component="nav" aria-label="On this page" sx={{ width: 230, flexShrink: 0, position: 'sticky', top: STICKY_TOP, maxHeight: `calc(100vh - ${STICKY_TOP + 24}px)`, overflowY: 'auto', display: { xs: 'none', lg: 'block' } }}>
      <Typography variant="overline" component="h3" color="text.secondary" sx={{ fontSize: 10.5 }}>On this page</Typography>
      <Stack spacing={0.25} sx={{ mt: 0.5, borderLeft: '1px solid', borderColor: 'divider' }}>
        {items.map(h => (
          <MuiLink
            key={h.slug}
            component={RouterLink}
            to={`#${h.slug}`}
            underline="none"
            sx={{
              fontSize: 12.5, py: 0.35, pl: h.depth === 3 ? 2.5 : 1.25, ml: '-1px', borderLeft: '2px solid',
              borderColor: active === h.slug ? 'primary.main' : 'transparent',
              color: active === h.slug ? 'text.primary' : 'text.secondary', '&:hover': { color: 'text.primary' },
            }}
          >
            {h.text}
          </MuiLink>
        ))}
      </Stack>
    </Box>
  );
}

function DocView({ id, idByPath }: { id: string; idByPath: Map<string, string> }) {
  const { data: doc, isLoading, error } = useDoc(id);
  const { hash } = useLocation();

  useEffect(() => {
    if (!doc) return;
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({ block: 'start' });
    else document.scrollingElement?.scrollTo?.({ top: 0 });
  }, [doc, hash]);

  const docPath = doc?.path ?? '';
  const resolveLink = useMemo(() => (href: string) => resolveDocLink(docPath, href, idByPath), [docPath, idByPath]);

  if (isLoading) {
    return <Stack spacing={2} aria-busy="true" aria-label="Loading document"><Skeleton width={320} height={40} /><Skeleton variant="rounded" height={420} /></Stack>;
  }
  if (error || !doc) {
    return (
      <EmptyState
        icon={<MenuBookRoundedIcon />}
        title="Document not found"
        body={(error as Error | null)?.message ?? `No document with id “${id}”.`}
        action={<Button component={RouterLink} to="/docs" size="small" variant="outlined">Browse all documentation</Button>}
      />
    );
  }
  const minutes = Math.max(1, Math.round(doc.words / 220));
  const dot = <Typography variant="caption" color="text.disabled">·</Typography>;
  return (
    <Stack direction="row" spacing={4} sx={{ alignItems: 'flex-start' }}>
      <Box component="article" sx={{ flex: 1, minWidth: 0, maxWidth: 900 }} aria-label={doc.title}>
        <Breadcrumbs sx={{ mb: 1.5, fontSize: 12.5 }} aria-label="Breadcrumb">
          <MuiLink component={RouterLink} to="/docs" underline="hover" color="text.secondary">Docs</MuiLink>
          <Typography color="text.secondary" sx={{ fontSize: 'inherit' }}>{doc.section}</Typography>
          <Typography color="text.primary" sx={{ fontSize: 'inherit' }}>{doc.title}</Typography>
        </Breadcrumbs>
        <Stack direction="row" spacing={1} sx={{ mb: 2.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}>
          <Tooltip title="Path in the repository"><Chip size="small" variant="outlined" label={doc.path} sx={{ fontFamily: 'var(--am-mono)', fontSize: 11 }} /></Tooltip>
          <Typography variant="caption" color="text.secondary">{minutes} min read</Typography>
          {dot}
          <Typography variant="caption" color="text.secondary">Updated {new Date(doc.updatedAt).toLocaleDateString()}</Typography>
          {doc.backlinks.length > 0 && <>{dot}<Typography variant="caption" color="text.secondary">Referenced by {doc.backlinks.length} {doc.backlinks.length === 1 ? 'page' : 'pages'}</Typography></>}
        </Stack>
        <Markdown headingIds resolveLink={resolveLink} sx={docSx}>{doc.content}</Markdown>
        {(doc.links.length > 0 || doc.backlinks.length > 0) && (
          <>
            <Divider sx={{ my: 4 }} />
            <Stack spacing={2}>
              <RefChips label="Referenced by" refs={doc.backlinks} />
              <RefChips label="Links to" refs={doc.links} />
            </Stack>
          </>
        )}
        <Stack direction="row" spacing={2} sx={{ mt: 4, mb: 2 }}>
          {doc.prev && <PagerLink dir="prev" to={docRoute(doc.prev.id)} title={doc.prev.title} />}
          {doc.next && <PagerLink dir="next" to={docRoute(doc.next.id)} title={doc.next.title} />}
        </Stack>
      </Box>
      <Toc doc={doc} />
    </Stack>
  );
}

/** Docs tab: every Markdown document in the repository by section, with search, cross-links and a table of contents. */
export function DocsPage() {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  const splat = useParams()['*'] ?? '';
  const id = splat.replace(/^\/+|\/+$/g, '') || null;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '';
  const searching = !!q.trim();
  const index = useDocsIndex();
  const search = useDocSearch(q);
  const { governance } = useAuth();

  const idByPath = useMemo(
    () => new Map((index.data?.sections ?? []).flatMap(s => s.docs.map(d => [d.path.toLowerCase(), d.id] as const))),
    [index.data],
  );

  const onQuery = useMemo(() => (next: string) => {
    setParams(p => {
      const out = new URLSearchParams(p);
      if (next.trim()) out.set('q', next); else out.delete('q');
      return out;
    }, { replace: true });
  }, [setParams]);

  const openTopHit = () => {
    const top = search.data?.query === q ? search.data.hits[0] : undefined;
    if (top) navigate(docRoute(top.id, top.anchor));
  };

  const searchField = <DocsSearchField q={q} onQuery={onQuery} onSubmit={openTopHit} />;
  const hits = searching && search.data?.query === q ? search.data.hits : undefined;

  let body: ReactNode;
  if (searching) body = <DocsSearchResults q={q} hits={hits} loading={search.isFetching} canAsk={governance} />;
  else if (id) body = <DocView id={id} idByPath={idByPath} />;
  else if (index.data) body = <DocsHome index={index.data} />;
  else if (index.error) body = <Alert severity="error">Couldn’t load the documentation index: {(index.error as Error).message}</Alert>;
  else body = <Stack spacing={2} aria-busy="true" aria-label="Loading documentation"><Skeleton width={260} height={40} /><Skeleton variant="rounded" height={320} /></Stack>;

  return (
    <Stack direction="row" spacing={3.5} sx={{ alignItems: 'flex-start', maxWidth: 1560, mx: 'auto' }}>
      {wide && (
        <Box component="aside" aria-label="Documentation navigation" sx={{ width: 268, flexShrink: 0, position: 'sticky', top: STICKY_TOP, maxHeight: `calc(100vh - ${STICKY_TOP + 16}px)`, overflowY: 'auto', pr: 1 }}>
          {searchField}
          {index.data && <DocsNav index={index.data} currentId={searching ? null : id} home={!searching && !id} />}
        </Box>
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {!wide && <Box sx={{ mb: 2 }}>{searchField}</Box>}
        {body}
      </Box>
    </Stack>
  );
}
