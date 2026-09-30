import type { ReactNode } from 'react';
import {
  Autocomplete, Box, Button, Checkbox, FormControl, FormControlLabel, FormGroup, FormLabel, IconButton, InputLabel, MenuItem, OutlinedInput, Select,
  Stack, Switch, TextField, Tooltip, Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import { usePolicies } from '../../api/policies';
import type {
  AlertChannel, ApprovalChannel, DataPolicy, FailMode, GovSeverity, Lane, LaneMode, Surface, ToolCategory,
} from '../../api/governance';

const SURFACES: (Surface | '*')[] = ['*', 'claude-code', 'copilot-cli', 'copilot-cloud-agent', 'vscode', 'mcp-gateway', 'sdk', 'foundry', 'copilot-studio', 'monitor'];
const CATEGORIES: ToolCategory[] = ['READ', 'WRITE', 'EXEC', 'NETWORK', 'MCP', 'AGENT', 'OTHER'];
const APPROVAL_CHANNELS: ApprovalChannel[] = ['native', 'dashboard', 'teams'];
const ALERT_CHANNELS: AlertChannel[] = ['teams', 'webhook', 'email'];
const SEVERITIES: GovSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Box component="fieldset" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2, m: 0, minWidth: 0 }}>
      <Typography component="legend" variant="subtitle2" sx={{ px: 0.5 }}>{title}</Typography>
      {hint && <Typography variant="caption" component="p" sx={{ mt: -0.5, mb: 1.5 }}>{hint}</Typography>}
      <Stack spacing={2}>{children}</Stack>
    </Box>
  );
}

/** Editable list of strings (dos / never / approvers / agents). */
export function StringList({ label, values, onChange, placeholder, readOnly }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string; readOnly?: boolean;
}) {
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>{label}</Typography>
      <Stack spacing={0.75}>
        {values.map((v, i) => (
          <Stack key={i} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <TextField
              size="small"
              fullWidth
              value={v}
              placeholder={placeholder}
              onChange={e => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
              slotProps={{ htmlInput: { 'aria-label': `${label} ${i + 1}`, readOnly } }}
            />
            {!readOnly && (
              <Tooltip title="Remove">
                <IconButton size="small" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(values.filter((_, j) => j !== i))}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
          </Stack>
        ))}
        {!readOnly && (
          <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => onChange([...values, ''])} sx={{ alignSelf: 'flex-start' }} aria-label={`Add ${label}`}>Add</Button>
        )}
      </Stack>
    </Box>
  );
}

function NumField({ label, value, onChange, step, min, max, readOnly, helper }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; step?: number; min?: number; max?: number; readOnly?: boolean; helper?: string;
}) {
  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={value ?? ''}
      helperText={helper}
      onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      slotProps={{ htmlInput: { step, min, max, readOnly } }}
      sx={{ minWidth: 160, flex: 1 }}
    />
  );
}

function SelectField<T extends string>({ label, value, options, onChange, readOnly, labels }: {
  label: string; value: T | undefined; options: readonly T[]; onChange: (v: T) => void; readOnly?: boolean; labels?: Partial<Record<T, string>>;
}) {
  const id = `lane-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <FormControl size="small" sx={{ minWidth: 180, flex: 1 }}>
      <InputLabel id={id}>{label}</InputLabel>
      <Select labelId={id} label={label} value={value ?? ''} onChange={e => onChange(e.target.value as T)} readOnly={readOnly}>
        {options.map(o => <MenuItem key={o} value={o}>{labels?.[o] ?? o}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

function MultiSelect<T extends string>({ label, value, options, onChange, readOnly }: {
  label: string; value: T[]; options: readonly T[]; onChange: (v: T[]) => void; readOnly?: boolean;
}) {
  const id = `lane-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <FormControl size="small" sx={{ minWidth: 220, flex: 1 }}>
      <InputLabel id={id}>{label}</InputLabel>
      <Select
        labelId={id}
        multiple
        value={value}
        readOnly={readOnly}
        onChange={e => onChange((typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value) as T[])}
        input={<OutlinedInput label={label} />}
        renderValue={v => (v as T[]).join(', ')}
      >
        {options.map(o => (
          <MenuItem key={o} value={o}><Checkbox size="small" checked={value.includes(o)} sx={{ p: 0.5, mr: 1 }} />{o}</MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function CheckGroup<T extends string>({ label, value, options, onChange, readOnly }: {
  label: string; value: T[]; options: readonly T[]; onChange: (v: T[]) => void; readOnly?: boolean;
}) {
  return (
    <FormControl component="fieldset" sx={{ minWidth: 0 }}>
      <FormLabel component="legend" sx={{ fontSize: 12.5 }}>{label}</FormLabel>
      <FormGroup row>
        {options.map(o => (
          <FormControlLabel
            key={o}
            label={<Typography variant="body2">{o}</Typography>}
            control={<Checkbox size="small" checked={value.includes(o)} disabled={readOnly} onChange={e => onChange(e.target.checked ? [...value, o] : value.filter(x => x !== o))} />}
          />
        ))}
      </FormGroup>
    </FormControl>
  );
}

/** Structured lane editor. Deterministic rules are edited in the YAML tab. */
export function LaneForm({ lane, onChange, readOnly, isNew }: { lane: Lane; onChange: (l: Lane) => void; readOnly?: boolean; isNew?: boolean }) {
  const set = <K extends keyof Lane>(k: K, v: Lane[K]) => onChange({ ...lane, [k]: v });
  const rules = lane.rules ?? {};
  const policies = usePolicies('active');
  const activePolicies = policies.data ?? [];
  const attachablePolicies = activePolicies.filter(r => !r.policy.global);
  const globalPolicies = activePolicies.filter(r => r.policy.global);
  const ruleCount = (['deny', 'allow', 'judge', 'approve'] as const).map(k => `${rules[k]?.length ?? 0} ${k}`).join(' · ');
  const limits = lane.limits ?? {};
  const setLimit = (k: keyof NonNullable<Lane['limits']>) => (v: number | undefined) => set('limits', { ...limits, [k]: v });
  const shields = lane.promptShields ?? {};
  const alerts = lane.alerts ?? {};

  return (
    <Stack spacing={2}>
      <Section title="Identity & scope">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField size="small" label="Lane id" value={lane.id} onChange={e => set('id', e.target.value)} required slotProps={{ htmlInput: { readOnly: readOnly || !isNew } }} sx={{ flex: 1 }} helperText={isNew ? 'Lowercase, unique (e.g. support-bot)' : undefined} />
          <TextField size="small" label="Name" value={lane.name ?? ''} onChange={e => set('name', e.target.value || undefined)} slotProps={{ htmlInput: { readOnly } }} sx={{ flex: 2 }} />
          <NumField label="Priority" value={lane.priority} onChange={v => set('priority', v)} readOnly={readOnly} />
        </Stack>
        <MultiSelect label="Applies to surfaces" value={lane.appliesTo?.surfaces ?? []} options={SURFACES} readOnly={readOnly} onChange={v => set('appliesTo', { ...lane.appliesTo, surfaces: v })} />
        <StringList label="Applies to agents" values={lane.appliesTo?.agents ?? []} placeholder="agent id, external id or name glob" readOnly={readOnly} onChange={v => set('appliesTo', { ...lane.appliesTo, agents: v })} />
        <Autocomplete
          multiple
          options={attachablePolicies.map(r => r.policy.id)}
          value={lane.policies ?? []}
          disabled={readOnly}
          onChange={(_, v) => set('policies', v)}
          getOptionLabel={id => activePolicies.find(r => r.policy.id === id)?.policy.name || id}
          renderInput={params => <TextField {...params} size="small" label="Attached policies" helperText={globalPolicies.length ? `Also applies: ${globalPolicies.map(r => r.policy.name || r.policy.id).join(', ')}` : 'Attach active, non-global policies to this lane'} />}
        />
      </Section>

      <Section title="Purpose" hint="What the agent is for. The LLM judge measures every gated action against this.">
        <TextField label="Purpose" value={lane.purpose} onChange={e => set('purpose', e.target.value)} multiline minRows={3} fullWidth slotProps={{ htmlInput: { readOnly } }} />
        <StringList label="Dos" values={lane.dos ?? []} placeholder="e.g. Read and summarise support tickets" readOnly={readOnly} onChange={v => set('dos', v)} />
        <StringList label="Never" values={lane.never ?? []} placeholder="e.g. Never issue refunds above $500" readOnly={readOnly} onChange={v => set('never', v)} />
      </Section>

      <Section title="Enforcement">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <SelectField<LaneMode> label="Mode" value={lane.mode} options={['observe', 'enforce', 'enforce+approval']} readOnly={readOnly} onChange={v => set('mode', v)}
            labels={{ observe: 'Observe (log would-deny only)', enforce: 'Enforce', 'enforce+approval': 'Enforce + human approval' }} />
          <SelectField<'allow' | 'deny' | 'judge'> label="Default verdict" value={lane.defaultVerdict ?? 'allow'} options={['allow', 'deny', 'judge']} readOnly={readOnly} onChange={v => set('defaultVerdict', v)} />
          <SelectField<FailMode> label="Fail mode" value={lane.failMode?.default} options={['open', 'closed']} readOnly={readOnly} onChange={v => set('failMode', { ...lane.failMode, default: v })}
            labels={{ open: 'Open (allow on error/timeout)', closed: 'Closed (deny on error/timeout)' }} />
        </Stack>
        <Typography variant="caption">Deterministic rules: {ruleCount}. Edit rule conditions in the YAML tab.</Typography>
      </Section>

      <Section title="Human approvals">
        <CheckGroup label="Channels" value={lane.approval?.channels ?? []} options={APPROVAL_CHANNELS} readOnly={readOnly} onChange={v => set('approval', { ...lane.approval, channels: v })} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <NumField label="Timeout (seconds)" value={lane.approval?.timeoutSec} min={5} readOnly={readOnly} onChange={v => set('approval', { ...lane.approval, timeoutSec: v ?? 0 })} />
        </Stack>
        <StringList label="Approvers" values={lane.approval?.approvers ?? []} placeholder="UPN or group" readOnly={readOnly} onChange={v => set('approval', { ...lane.approval, approvers: v })} />
      </Section>

      <Section title="LLM judge" hint="Runs only on gated actions. Deterministic never-rules can’t be overridden by the judge.">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField size="small" label="Model" value={lane.judge?.model ?? ''} placeholder="fast | escalation | deployment" onChange={e => set('judge', { ...lane.judge, model: e.target.value || undefined })} slotProps={{ htmlInput: { readOnly } }} sx={{ flex: 1 }} />
          <SelectField<DataPolicy> label="Data sent to judge" value={lane.judge?.dataPolicy} options={['redacted', 'metadata-only', 'full']} readOnly={readOnly} onChange={v => set('judge', { ...lane.judge, dataPolicy: v })} />
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <NumField label="Escalate below confidence" value={lane.judge?.escalateBelow} step={0.05} min={0} max={1} readOnly={readOnly} onChange={v => set('judge', { ...lane.judge, escalateBelow: v ?? 0 })} helper="0–1: use the stronger model below this" />
          <NumField label="Human below confidence" value={lane.judge?.humanBelow} step={0.05} min={0} max={1} readOnly={readOnly} onChange={v => set('judge', { ...lane.judge, humanBelow: v })} helper="0–1: ask a human below this" />
          <NumField label="Judge timeout (ms)" value={lane.judge?.timeoutMs} step={100} min={0} readOnly={readOnly} onChange={v => set('judge', { ...lane.judge, timeoutMs: v })} />
        </Stack>
      </Section>

      <Section title="Runaway limits">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
          <NumField label="Actions / minute" value={limits.actionsPerMin} min={0} readOnly={readOnly} onChange={setLimit('actionsPerMin')} />
          <NumField label="Max subagents" value={limits.maxSubagents} min={0} readOnly={readOnly} onChange={setLimit('maxSubagents')} />
          <NumField label="Max depth" value={limits.maxDepth} min={0} readOnly={readOnly} onChange={setLimit('maxDepth')} />
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
          <NumField label="Token budget" value={limits.tokenBudget} min={0} readOnly={readOnly} onChange={setLimit('tokenBudget')} />
          <NumField label="Loop threshold" value={limits.loopThreshold} min={0} readOnly={readOnly} onChange={setLimit('loopThreshold')} />
          <NumField label="Max session minutes" value={limits.maxSessionMinutes} min={0} readOnly={readOnly} onChange={setLimit('maxSessionMinutes')} />
        </Stack>
      </Section>

      <Section title="Prompt shields" hint="Scan tool results for prompt injection and taint the session when found.">
        <FormControlLabel control={<Switch checked={!!shields.enabled} disabled={readOnly} onChange={e => set('promptShields', { ...shields, enabled: e.target.checked })} />} label="Enabled" />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <MultiSelect label="Scan results of" value={shields.scan ?? []} options={CATEGORIES} readOnly={readOnly} onChange={v => set('promptShields', { ...shields, scan: v })} />
          <NumField label="Taint lasts (actions)" value={shields.taintTtlActions} min={0} readOnly={readOnly} onChange={v => set('promptShields', { ...shields, taintTtlActions: v })} />
        </Stack>
      </Section>

      <Section title="Alerts" hint="Where to send alerts for each severity.">
        {SEVERITIES.map(s => (
          <CheckGroup key={s} label={s[0].toUpperCase() + s.slice(1)} value={alerts[s] ?? []} options={ALERT_CHANNELS} readOnly={readOnly}
            onChange={v => set('alerts', { ...alerts, [s]: v.length ? v : undefined })} />
        ))}
      </Section>
    </Stack>
  );
}
