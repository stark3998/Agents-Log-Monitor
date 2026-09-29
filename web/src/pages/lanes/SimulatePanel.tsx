import { useState } from 'react';
import {
  Alert, Box, Button, FormControl, InputLabel, Link as MuiLink, MenuItem, Select, Stack, Table, TableBody, TableCell, TableHead, TableRow,
  Typography, useTheme,
} from '@mui/material';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { Link as RouterLink } from 'react-router-dom';
import { errorMessage, simulateLane, useGovAgents, type SimulationResult } from '../../api/governance';
import { ToneChip } from '../../components/Chips';
import { successTone } from '../../components/gov/GovChips';
import { Ellipsis } from '../../components/Primitives';
import { RANGES, rangeBounds } from '../../lib/range';
import { fmtNum } from '../../lib/format';

function SampleVerdict({ verdict }: { verdict: string }) {
  const t = useTheme().tokens;
  const v = verdict.toLowerCase();
  const tone = v.includes('deny') ? t.severity.critical : v.includes('approv') || v.includes('escalat') ? t.severity.high : v.includes('judge') ? t.severity.medium : successTone(t);
  return <ToneChip tone={tone} label={verdict} sx={{ height: 20, fontSize: 11 }} />;
}

/** Counts + sample table for a lane replay. */
export function SimulationResults({ result }: { result: SimulationResult }) {
  const t = useTheme().tokens;
  const tiles: { label: string; value: number; color?: string }[] = [
    { label: 'Evaluated', value: result.evaluated },
    { label: 'Would allow', value: result.wouldAllow, color: t.success },
    { label: 'Would deny', value: result.wouldDeny, color: t.severity.critical.fg },
    { label: 'Would go to judge', value: result.wouldJudge, color: t.severity.medium.fg },
    { label: 'Would need approval', value: result.wouldApprove, color: t.severity.high.fg },
  ];
  return (
    <Stack spacing={1.5} data-testid="simulation-results">
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {tiles.map(x => (
          <Box key={x.label} sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 2 }} role="group" aria-label={`${x.label}: ${x.value}`}>
            <Typography variant="caption" component="div">{x.label}</Typography>
            <Typography sx={{ fontSize: 22, fontWeight: 600, color: x.color, fontVariantNumeric: 'tabular-nums' }}>{fmtNum(x.value)}</Typography>
          </Box>
        ))}
      </Box>
      {result.samples.length > 0 ? (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Simulation samples">
            <TableHead><TableRow><TableCell>Verdict</TableCell><TableCell>Tool</TableCell><TableCell>Action</TableCell><TableCell>Rules</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>
              {result.samples.map(s => (
                <TableRow key={`${s.eventId}`}>
                  <TableCell><SampleVerdict verdict={s.verdict} /></TableCell>
                  <TableCell sx={{ fontFamily: 'var(--am-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{s.tool}</TableCell>
                  <TableCell sx={{ maxWidth: 360 }}><Ellipsis text={s.summary} sx={{ display: 'block' }} /></TableCell>
                  <TableCell sx={{ fontFamily: 'var(--am-mono)', fontSize: 11.5 }}>{s.ruleIds.join(', ') || '—'}</TableCell>
                  <TableCell><MuiLink component={RouterLink} to={`/conversations?c=${encodeURIComponent(s.sessionId)}`} sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>Session</MuiLink></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ) : <Typography variant="body2" color="text.secondary">No sample actions.</Typography>}
    </Stack>
  );
}

/** "Simulate against history": replays recorded actions through the edited lane (POST /api/gov/lanes/simulate). */
export function SimulatePanel({ yaml, disabled, initial }: { yaml: string; disabled?: boolean; initial?: SimulationResult }) {
  const [range, setRange] = useState('7d');
  const [agentId, setAgentId] = useState('');
  const agents = useGovAgents();
  const [result, setResult] = useState<SimulationResult | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { from, to } = rangeBounds(range);
      setResult(await simulateLane({ yaml, from, to, agentId: agentId || undefined, limit: 50 }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel id="sim-range">History</InputLabel>
          <Select labelId="sim-range" label="History" value={range} onChange={e => setRange(e.target.value)}>
            {RANGES.map(r => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="sim-agent">Agent</InputLabel>
          <Select labelId="sim-agent" label="Agent" value={agentId} onChange={e => setAgentId(e.target.value)}>
            <MenuItem value="">All agents in scope</MenuItem>
            {(agents.data ?? []).map(a => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
          </Select>
        </FormControl>
        <Button variant="outlined" size="small" startIcon={<ScienceOutlinedIcon />} disabled={disabled || busy} onClick={() => void run()}>
          {busy ? 'Simulating…' : 'Simulate against history'}
        </Button>
      </Stack>
      {disabled && <Typography variant="caption">Fix validation errors to simulate.</Typography>}
      {error && <Alert severity="error" role="alert">{error}</Alert>}
      {result && <SimulationResults result={result} />}
    </Stack>
  );
}
