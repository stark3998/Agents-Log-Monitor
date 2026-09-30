import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Chip, Popover, Stack, Typography, useTheme } from '@mui/material';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import { Link as RouterLink } from 'react-router-dom';
import { useSessionDecisions, type Decision } from '../../api/governance';
import type { TimelineItem, ToolItem } from '../../api/types';
import { matchDecisions } from '../../lib/decisionMatch';
import { decisionLabel, STAGE_LABEL, verdictTone } from '../../components/gov/GovChips';
import { JevShadowForDecision, judgeUsageLabel } from '../../components/gov/JevCommon';
import { fmtDuration } from '../../lib/format';

const Ctx = createContext<ReadonlyMap<number, Decision>>(new Map());

/** Decision matched to a timeline tool call (by requestId ≈ tool_use_id, else tool name + time). */
export const useToolDecision = (toolId: number): Decision | undefined => useContext(Ctx).get(toolId);
export const useDecisionMap = () => useContext(Ctx);

/** Fetches /api/gov/decisions?sessionId= for the open conversation and matches decisions to tool calls. */
export function DecisionMatchProvider({ sessionId, timeline, children }: { sessionId: string; timeline: readonly TimelineItem[] | undefined; children: ReactNode }) {
  const { data } = useSessionDecisions(sessionId);
  const map = useMemo(() => {
    if (!data?.length || !timeline) return new Map<number, Decision>();
    return matchDecisions(timeline.filter((i): i is ToolItem => i.kind === 'tool'), data);
  }, [data, timeline]);
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}

/** Small verdict badge with a "why" popover. */
export function DecisionBadge({ decision: d }: { decision: Decision }) {
  const t = useTheme().tokens;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tone = verdictTone(t, d.verdict, d.wouldDeny);
  const label = decisionLabel(d);
  const judge = d.judge?.[d.judge.length - 1];
  const judgeUsage = judge ? judgeUsageLabel(judge) : null;
  return (
    <>
      <Chip
        size="small"
        icon={<ShieldOutlinedIcon sx={{ fontSize: '13px !important', color: `${tone.fg} !important` }} />}
        label={label}
        onClick={e => { e.stopPropagation(); setAnchor(e.currentTarget); }}
        aria-label={`Governance: ${label} — why?`}
        aria-haspopup="dialog"
        sx={{ height: 20, fontSize: 11, fontWeight: 600, color: tone.fg, bgcolor: tone.bg, border: '1px solid', borderColor: tone.border, '&:hover': { bgcolor: tone.bg, filter: 'brightness(1.1)' } }}
      />
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 360, p: 2 }, role: 'dialog', 'aria-label': 'Why this decision' } as object }}
      >
        <Stack spacing={1}>
          <Typography variant="subtitle2">Why “{label}”?</Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{d.reason || 'No reason recorded.'}</Typography>
          <Typography variant="caption" component="div">
            {STAGE_LABEL[d.stage] ?? d.stage} · lane <b>{d.laneId}@v{d.laneVersion}</b> ({d.mode}) · {fmtDuration(d.latencyMs)}
          </Typography>
          {d.ruleIds.length > 0 && <Typography variant="caption" component="div" sx={{ fontFamily: 'var(--am-mono)' }}>Rules: {d.ruleIds.join(', ')}</Typography>}
          {judge && (
            <Box sx={{ pl: 1.25, borderLeft: '3px solid', borderColor: 'divider' }}>
              <Typography variant="caption" component="div">Judge ({judge.tier}, {Math.round(judge.confidence * 100)}% confident)</Typography>
              {judgeUsage && <Typography variant="caption" component="div" data-testid="judge-usage">{judgeUsage}</Typography>}
              <Typography variant="body2" sx={{ fontSize: 12.5 }}>{judge.rationale}</Typography>
            </Box>
          )}
          {d.tainted && <Typography variant="caption" sx={{ color: t.severity.high.fg }}>Session tainted by untrusted content</Typography>}
          <JevShadowForDecision decision={d} />
          <Button size="small" component={RouterLink} to={`/enforcements?d=${encodeURIComponent(d.id)}`} sx={{ alignSelf: 'flex-start' }}>
            Open decision
          </Button>
        </Stack>
      </Popover>
    </>
  );
}
