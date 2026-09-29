import { useState } from 'react';
import { Box, Button, Skeleton, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import type { Connections, Matrix } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { fmtNum, fmtRelative } from '../../lib/format';

const VISIBLE = 5;

function MatrixGrid({ title, matrix, agents, kind, rangeParam }: {
  title: string; matrix: Matrix; agents: Connections['agents']; kind: 'mcp' | 'domain'; rangeParam: string;
}) {
  const theme = useTheme();
  const t = theme.tokens;
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const cols = expanded ? matrix.columns : matrix.columns.slice(0, VISIBLE);
  const rows = agents.filter(a => matrix.cells[a.agentKey]);
  const max = Math.max(1, ...rows.flatMap(a => Object.values(matrix.cells[a.agentKey] ?? {}).map(c => c.count)));

  if (!cols.length) {
    return (
      <Box sx={{ mb: 2.5 }}>
        <Typography variant="overline" color="text.secondary">{title}</Typography>
        <Typography variant="body2" color="text.disabled" sx={{ py: 1.5 }}>
          {kind === 'mcp' ? 'No MCP server calls in this period.' : 'No external domains contacted in this period.'}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 2.5 }}>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>{title}</Typography>
        {matrix.totalColumns > VISIBLE && (
          <Button size="small" onClick={() => setExpanded(e => !e)} sx={{ color: 'text.secondary' }}>
            {expanded ? 'Show top 5' : `Show all ${matrix.totalColumns}`}
          </Button>
        )}
      </Stack>
      <Box sx={{ overflowX: 'auto', pb: 0.5 }}>
        <Box
          role="table"
          aria-label={title}
          sx={{
            display: 'grid', gap: 0.75, alignItems: 'center',
            gridTemplateColumns: `minmax(150px, 180px) repeat(${cols.length}, minmax(${expanded ? 140 : 120}px, 1fr))`,
            minWidth: expanded ? 180 + cols.length * 146 : undefined,
          }}
        >
          <Box role="columnheader" />
          {cols.map(c => (
            <Tooltip key={c.key} title={`${c.key} · ${fmtNum(c.total)} total`}>
              <Typography role="columnheader" variant="subtitle2" noWrap sx={{ textAlign: 'center', px: 0.5, fontSize: 12.5 }}>{c.key}</Typography>
            </Tooltip>
          ))}
          {rows.map(a => (
            <Box key={a.agentKey} role="row" sx={{ display: 'contents' }}>
              <Stack role="rowheader" direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                <AgentAvatar agentKey={a.agentKey} size={20} />
                <Typography variant="body2" noWrap>{a.agentName}</Typography>
              </Stack>
              {cols.map((c, ci) => {
                const cell = matrix.cells[a.agentKey]?.[c.key];
                const count = cell?.count ?? 0;
                const intensity = count ? Math.log1p(count) / Math.log1p(max) : 0;
                const bg = count ? `rgba(${t.accentRgb}, ${(0.14 + intensity * 0.7).toFixed(3)})` : theme.palette.action.hover;
                const strong = intensity > 0.55;
                const go = () => navigate(`/conversations?${rangeParam}agent=${a.agentKey}&connect=${encodeURIComponent(c.key)}`);
                const box = (
                  <Box
                    role="cell"
                    tabIndex={count ? 0 : -1}
                    onClick={count ? go : undefined}
                    onKeyDown={e => { if (count && e.key === 'Enter') go(); }}
                    sx={{
                      height: 34, borderRadius: 1.5, display: 'grid', placeItems: 'center', bgcolor: bg,
                      fontSize: 12.5, fontWeight: count ? 600 : 400, fontVariantNumeric: 'tabular-nums',
                      color: count ? (strong ? t.heatText : 'text.primary') : 'text.disabled',
                      cursor: count ? 'pointer' : 'default',
                      animation: `am-scale-in 380ms ${120 + ci * 35}ms both cubic-bezier(0.05, 0.7, 0.1, 1)`,
                      transition: 'transform 200ms cubic-bezier(0.2,0,0,1), box-shadow 200ms',
                      '&:hover': count ? { transform: 'translateY(-2px)', boxShadow: `0 6px 16px rgba(${t.accentRgb}, 0.25)` } : undefined,
                      '&:focus-visible': { outline: `2px solid ${t.accent}`, outlineOffset: 2 },
                    }}
                  >
                    {count ? fmtNum(count) : '—'}
                  </Box>
                );
                return count ? (
                  <Tooltip key={c.key} title={<><b>{a.agentName}</b> → {c.key}<br />{fmtNum(count)} {kind === 'mcp' ? 'tool calls' : 'requests'} · last {fmtRelative(cell!.last)}</>}>
                    {box}
                  </Tooltip>
                ) : <Box key={c.key}>{box}</Box>;
              })}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

export function ConnectionsHeatmap({ data, rangeParam }: { data?: Connections; rangeParam: string }) {
  if (!data) {
    return (
      <Stack spacing={1}>
        {[0, 1, 2].map(i => <Skeleton key={i} variant="rounded" height={34} />)}
      </Stack>
    );
  }
  return (
    <>
      <MatrixGrid title="MCP servers" matrix={data.mcp} agents={data.agents} kind="mcp" rangeParam={rangeParam} />
      <MatrixGrid title="External domains" matrix={data.domains} agents={data.agents} kind="domain" rangeParam={rangeParam} />
    </>
  );
}
