import { useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, MenuItem, Stack, Switch, TextField, Tooltip, Typography,
} from '@mui/material';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded';
import {
  useCopilotHooks, useGovSimulation, useInstallCopilotHooks, useSetGovSimulation, useUninstallCopilotHooks,
  type HookFailMode, type HookTarget, type HookTargetStatus,
} from '../../api/governance';
import { Link as RouterLink } from 'react-router-dom';
import { useCan } from '../../auth/context';
import { SectionCard } from '../Common';
import { RelativeTime } from '../Primitives';
import { QueryError } from './GovCommon';

const TARGET_LABEL: Record<HookTarget, string> = { 'copilot-cli': 'GitHub Copilot CLI', vscode: 'VS Code agent mode' };
const TARGET_HINT: Record<HookTarget, string> = {
  'copilot-cli': 'Takes effect in new Copilot CLI sessions.',
  vscode: 'Needs chat.useHooks enabled and a trusted workspace; reload VS Code after installing.',
};
const FAIL_MODE_HINT: Record<HookFailMode, string> = {
  open: 'If the monitor is down or slow, the agent continues (recommended for testing).',
  closed: 'If the monitor is down or slow, governed tool calls are blocked.',
  auto: 'Open for low-risk tools, closed for risky ones.',
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function TargetRow({ t, canEdit, busy, onInstall, onUninstall }: {
  t: HookTargetStatus; canEdit: boolean; busy: boolean; onInstall: () => void; onUninstall: () => void;
}) {
  const state = !t.installed ? 'Not installed' : t.managed ? 'Installed' : 'Unrecognised file';
  const color = !t.installed ? 'default' : t.managed ? 'success' : 'warning';
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }} spacing={1.5} data-testid={`hook-row-${t.target}`}
      sx={{ alignItems: { md: 'center' }, py: 1.25, borderTop: '1px solid', borderColor: 'divider' }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
          <Typography variant="subtitle2" component="h4">{TARGET_LABEL[t.target]}</Typography>
          <Chip size="small" color={color} variant={t.installed ? 'filled' : 'outlined'} label={state} />
          {t.installed && t.failMode && <Chip size="small" variant="outlined" label={`fail ${t.failMode}`} />}
          {t.installed && t.port && <Chip size="small" variant="outlined" label={`port ${t.port}`} />}
        </Stack>
        <Typography variant="caption" component="div" color="text.secondary" sx={{ fontFamily: 'var(--am-mono)', wordBreak: 'break-all', mt: 0.25 }}>
          {t.path}
        </Typography>
        <Typography variant="caption" component="div" color="text.secondary">
          {t.installed && t.modifiedAt ? <>Written <RelativeTime iso={t.modifiedAt} />. </> : null}{TARGET_HINT[t.target]}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1}>
        <Button size="small" variant={t.installed ? 'outlined' : 'contained'} disabled={!canEdit || busy} onClick={onInstall}>
          {t.installed ? 'Reinstall' : 'Install'}
        </Button>
        <Button size="small" color="error" variant="outlined" disabled={!canEdit || busy || !t.installed} onClick={onUninstall}>
          Uninstall
        </Button>
      </Stack>
    </Stack>
  );
}

/** Header indicator: governance is in simulation mode (nothing is blocked). Renders nothing otherwise. */
export function SimulationHeaderChip() {
  const q = useGovSimulation();
  if (!q.data?.enabled) return null;
  return (
    <Tooltip title="Governance simulation mode is on: tool calls are evaluated and recorded but never blocked. Manage it under Governance.">
      <Chip
        size="small" color="warning" icon={<ScienceRoundedIcon />} label="Simulation"
        component={RouterLink} to="/governance#test-harness" clickable data-testid="simulation-header-chip"
      />
    </Tooltip>
  );
}

/**
 * Install / uninstall the Copilot governance hooks and switch simulation mode, so real agent traffic
 * reaches the policy check (and Jev's live shadow) without anything being blocked.
 */
export function TestHarnessCard({ delay = 0 }: { delay?: number }) {
  const q = useCopilotHooks();
  const setSim = useSetGovSimulation();
  const install = useInstallCopilotHooks();
  const uninstall = useUninstallCopilotHooks();
  const isAdmin = useCan('PolicyAdmin');
  const [failMode, setFailMode] = useState<HookFailMode>('open');
  const [simulateFirst, setSimulateFirst] = useState(true);
  const s = q.data;
  const busy = setSim.isPending || install.isPending || uninstall.isPending;
  const err = setSim.error ?? install.error ?? uninstall.error;
  const sim = s?.simulation.enabled ?? false;
  const canEdit = isAdmin && !!s?.available;
  const anyInstalled = !!s?.targets.some(t => t.installed);

  return (
    <SectionCard
      title="Governance test harness"
      subtitle="Send real Copilot agent tool calls through governance so Jev and the LLM judge have live decisions to compare"
      delay={delay}
      action={busy ? <CircularProgress size={18} aria-label="Working" /> : undefined}
    >
      {q.isError ? <QueryError error={q.error} onRetry={() => void q.refetch()} /> : !s ? (
        <Typography variant="body2" color="text.secondary">Loading…</Typography>
      ) : (
        <Stack spacing={1.5} data-testid="test-harness" id="test-harness">
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start', p: 1.5, borderRadius: 2, bgcolor: sim ? 'action.selected' : 'action.hover' }}>
            <Box sx={{ pt: 0.25, color: sim ? 'warning.main' : 'success.main' }}>{sim ? <ScienceRoundedIcon /> : <ShieldRoundedIcon />}</Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle2" component="h4">Simulation mode</Typography>
                <Chip size="small" color={sim ? 'warning' : 'success'} label={sim ? 'Simulating: nothing is blocked' : 'Enforcing'} data-testid="simulation-chip" />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {sim
                  ? 'Every agent tool call is still evaluated by lane rules, policies, the LLM judge, limits, kill switches and the self-protection guard. Denials are only recorded as "would deny", and no approvals are requested.'
                  : 'Decisions follow each lane\'s mode. Observe lanes never block, but enforcing lanes and the self-protection guard do.'}
                {' '}Admin actions are always enforced.
              </Typography>
              {s.simulation.updatedBy && (
                <Typography variant="caption" color="text.secondary">
                  Changed by {s.simulation.updatedBy}{s.simulation.updatedAt ? <> · <RelativeTime iso={s.simulation.updatedAt} /></> : null}
                </Typography>
              )}
            </Box>
            <Tooltip title={isAdmin ? '' : 'Requires PolicyAdmin (unlock admin)'}>
              <span>
                <Switch
                  checked={sim} disabled={!isAdmin || busy} onChange={e => setSim.mutate(e.target.checked)}
                  slotProps={{ input: { 'aria-label': 'Simulation mode' } }}
                />
              </span>
            </Tooltip>
          </Stack>

          {!s.available ? (
            <Alert severity="info" variant="outlined">
              This monitor runs in cloud mode. Install hooks on each endpoint with <code>install.ps1 -CopilotHooks</code> or <code>install.sh --copilot-hooks</code>.
            </Alert>
          ) : (
            <>
              {!s.forwarder.present && (
                <Alert severity="error">The hook forwarder script was not found at <code>{s.forwarder.powershell}</code>. Hooks would fail. Run the monitor from the repository checkout.</Alert>
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
                <TextField
                  select size="small" label="Fail mode" value={failMode} sx={{ minWidth: 160 }} disabled={!canEdit || busy}
                  onChange={e => setFailMode(e.target.value as HookFailMode)} helperText={FAIL_MODE_HINT[failMode]}
                >
                  <MenuItem value="open">Open</MenuItem>
                  <MenuItem value="auto">Auto</MenuItem>
                  <MenuItem value="closed">Closed</MenuItem>
                </TextField>
                {!sim && (
                  <FormControlLabel
                    control={<Checkbox checked={simulateFirst} onChange={e => setSimulateFirst(e.target.checked)} disabled={!canEdit || busy} />}
                    label="Turn on simulation when installing"
                  />
                )}
              </Stack>
              {!sim && !simulateFirst && (
                <Alert severity="warning" variant="outlined">
                  Without simulation, enforcing lanes and the self-protection guard will block real tool calls, including agents working on this repository.
                </Alert>
              )}
              <Box>
                {s.targets.map(t => (
                  <TargetRow
                    key={t.target} t={t} canEdit={canEdit} busy={busy}
                    onInstall={() => install.mutate({ targets: [t.target], failMode, simulate: sim ? undefined : simulateFirst || undefined })}
                    onUninstall={() => uninstall.mutate([t.target])}
                  />
                ))}
              </Box>
              {anyInstalled && (
                <Alert severity="success" variant="outlined" data-testid="hooks-next-step">
                  Hooks are installed. Start a new agent session: tool calls will appear under Enforcements, and Jev comparisons under Live shadow.
                  {sim ? ' Uninstall the hooks or turn simulation off when you are done testing.' : ''}
                </Alert>
              )}
            </>
          )}
          {!isAdmin && <Typography variant="caption" color="text.secondary">Unlock admin (header) to change these settings.</Typography>}
          {err && <Alert severity="error" onClose={() => { setSim.reset(); install.reset(); uninstall.reset(); }}>{errorText(err)}</Alert>}
        </Stack>
      )}
    </SectionCard>
  );
}
