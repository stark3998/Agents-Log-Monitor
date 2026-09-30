import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, Collapse, FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, OutlinedInput, Select, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import type { Classifier, Operation, Policy, PolicyAction, PolicyRule, PresetCatalog, PresetEntry } from '../../api/policies';
import { StringList } from '../lanes/LaneForm';
import { ActionChip } from './PolicyChips';

const SURFACES = ['claude-code', 'copilot-cli', 'copilot-cloud-agent', 'vscode', 'mcp-gateway', 'sdk', 'foundry', 'copilot-studio', 'monitor', 'unknown'];
const ACTIONS: PolicyAction[] = ['deny', 'approve', 'judge', 'allow', 'alert'];
const OPERATIONS: Operation[] = ['read', 'write', 'delete', 'execute'];
const PRESET_KEYS = ['filesystem', 'network', 'credential', 'capability', 'mcpCategory'] as const;

type PresetKey = typeof PRESET_KEYS[number];
function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) { return <Box component="fieldset" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2, m: 0, minWidth: 0 }}><Typography component="legend" variant="subtitle2" sx={{ px: 0.5 }}>{title}</Typography>{hint && <Typography variant="caption" component="p" sx={{ mb: 1 }}>{hint}</Typography>}<Stack spacing={2}>{children}</Stack></Box>; }
function MultiSelect({ label, value, options, onChange, readOnly }: { label: string; value: string[]; options: string[]; onChange: (v: string[]) => void; readOnly?: boolean }) { const id = `policy-${label.replace(/\W+/g, '-').toLowerCase()}`; return <FormControl size="small" sx={{ minWidth: 220, flex: 1 }}><InputLabel id={id}>{label}</InputLabel><Select labelId={id} multiple label={label} value={value} readOnly={readOnly} input={<OutlinedInput label={label} />} renderValue={v => (v as string[]).join(', ')} onChange={e => onChange(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}>{options.map(o => <MenuItem key={o} value={o}><Checkbox size="small" checked={value.includes(o)} sx={{ p: 0.5, mr: 1 }} />{o}</MenuItem>)}</Select></FormControl>; }
const cleanList = (v: string[]) => v.map(x => x.trim()).filter(Boolean);
const hasConditions = (r: PolicyRule) => ['category','tool','mcpServer','risk','path','domain','command','detector','filesystem','network','credential','capability','mcpCategory','classifier','operation'].some(k => { const v = (r as unknown as Record<string, unknown>)[k]; return Array.isArray(v) ? v.length > 0 : !!v; }) || r.tainted != null;
function optionMap(entries: PresetEntry[]) { return new Map(entries.map(e => [e.id, e])); }
function PresetPicker({ label, kind, value, entries, onChange, readOnly }: { label: string; kind: PresetKey; value: string[]; entries: PresetEntry[]; onChange: (v: string[]) => void; readOnly?: boolean }) {
  const map = useMemo(() => optionMap(entries), [entries]);
  const ids = entries.map(e => e.id);
  return <Autocomplete multiple freeSolo={kind !== 'capability'} options={ids} value={value} disabled={readOnly} groupBy={id => map.get(id)?.group ?? 'Custom'} getOptionLabel={id => map.get(id)?.label ? `${map.get(id)!.label} (${id})` : id} onChange={(_, v) => onChange(v as string[])} renderInput={params => <TextField {...params} size="small" label={label} />} renderOption={(props, id) => { const e = map.get(id); return <li {...props} key={id}><Stack spacing={0}><Typography variant="body2">{e?.label ?? id} <Box component="span" sx={{ fontFamily: 'var(--am-mono)', color: 'text.secondary' }}>{id}</Box></Typography>{e?.description && <Typography variant="caption" color="text.secondary">{e.description}</Typography>}</Stack></li>; }} />;
}
function ClassifierPicker({ value, classifiers, onChange, readOnly }: { value: string[]; classifiers: Classifier[]; onChange: (v: string[]) => void; readOnly?: boolean }) {
  const enforceable = classifiers.filter(c => c.enforceable);
  const map = new Map(enforceable.map(c => [c.code, c]));
  return <Stack spacing={0.5}><Autocomplete multiple options={enforceable.map(c => c.code)} value={value} disabled={readOnly} groupBy={code => map.get(code)?.category ?? 'Other'} getOptionLabel={code => map.get(code)?.label ? `${map.get(code)!.label} (${code})` : code} onChange={(_, v) => onChange(v)} renderInput={params => <TextField {...params} size="small" label="Classifiers" />} /><Typography variant="caption" color="text.secondary" data-testid="enforceable-classifiers">Enforceable classifiers: {enforceable.map(c => c.label).join(', ') || 'none'}</Typography></Stack>;
}
function RuleCard({ rule, onChange, onDelete, presets, classifiers, readOnly }: { rule: PolicyRule; onChange: (r: PolicyRule) => void; onDelete: () => void; presets?: PresetCatalog; classifiers: Classifier[]; readOnly?: boolean }) {
  const [advanced, setAdvanced] = useState(false);
  const set = <K extends keyof PolicyRule>(k: K, v: PolicyRule[K]) => onChange({ ...rule, [k]: v });
  const setList = (k: keyof PolicyRule) => (v: string[]) => onChange({ ...rule, [k]: cleanList(v) });
  return <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5 }}>
    <Stack spacing={1.5}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
        <TextField size="small" label="Rule id" value={rule.id} onChange={e => set('id', e.target.value)} slotProps={{ htmlInput: { readOnly } }} sx={{ flex: 1 }} />
        <FormControl size="small" sx={{ minWidth: 140 }}><InputLabel id={`${rule.id}-action`}>Action</InputLabel><Select labelId={`${rule.id}-action`} label="Action" value={rule.action} readOnly={readOnly} onChange={e => set('action', e.target.value as PolicyAction)}>{ACTIONS.map(a => <MenuItem key={a} value={a}><Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><ActionChip action={a} /><span>{a}</span></Stack></MenuItem>)}</Select></FormControl>
        {!readOnly && <Tooltip title="Delete rule"><IconButton aria-label={`Delete rule ${rule.id || 'new'}`} onClick={onDelete}><DeleteOutlineRoundedIcon /></IconButton></Tooltip>}
      </Stack>
      <TextField size="small" label="Description" value={rule.description ?? ''} onChange={e => set('description', e.target.value || undefined)} slotProps={{ htmlInput: { readOnly } }} fullWidth />
      {!hasConditions(rule) && <Alert severity="warning">This rule has no conditions and may match every action.</Alert>}
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
        {PRESET_KEYS.map(k => <PresetPicker key={k} kind={k} label={k === 'mcpCategory' ? 'MCP categories' : k[0].toUpperCase() + k.slice(1)} entries={presets?.[k] ?? []} value={(rule[k] as string[] | undefined) ?? []} onChange={setList(k)} readOnly={readOnly} />)}
        <ClassifierPicker value={rule.classifier ?? []} classifiers={classifiers} onChange={v => set('classifier', v)} readOnly={readOnly} />
        <MultiSelect label="Operations" value={rule.operation ?? []} options={OPERATIONS} onChange={v => set('operation', v as Operation[])} readOnly={readOnly} />
      </Box>
      <Button size="small" variant="text" endIcon={<ExpandMoreRoundedIcon sx={{ transform: advanced ? 'rotate(180deg)' : undefined }} />} onClick={() => setAdvanced(v => !v)} sx={{ alignSelf: 'flex-start' }}>Advanced</Button>
      <Collapse in={advanced}><Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>{(['category','tool','mcpServer','risk','path','domain','command','detector'] as const).map(k => <TextField key={k} size="small" label={k} value={(rule[k] as string | undefined) ?? ''} onChange={e => set(k, e.target.value || undefined)} slotProps={{ htmlInput: { readOnly } }} />)}<FormControlLabel control={<Switch checked={!!rule.tainted} disabled={readOnly} onChange={e => set('tainted', e.target.checked ? true : undefined)} />} label="Tainted" /></Box></Collapse>
    </Stack>
  </Box>;
}
export function PolicyForm({ policy, onChange, readOnly, isNew, presets, classifiers }: { policy: Policy; onChange: (p: Policy) => void; readOnly?: boolean; isNew?: boolean; presets?: PresetCatalog; classifiers: Classifier[] }) {
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => onChange({ ...policy, [k]: v });
  const setScope = (k: keyof NonNullable<Policy['scope']>) => (v: string[]) => set('scope', { ...policy.scope, [k]: v });
  const rules = policy.rules ?? [];
  return <Stack spacing={2}>
    <Section title="Identity & scope">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}><TextField size="small" required label="Policy id" value={policy.id} onChange={e => set('id', e.target.value)} slotProps={{ htmlInput: { readOnly: readOnly || !isNew } }} sx={{ flex: 1 }} /><TextField size="small" label="Name" value={policy.name ?? ''} onChange={e => set('name', e.target.value || undefined)} slotProps={{ htmlInput: { readOnly } }} sx={{ flex: 2 }} /></Stack>
      <TextField label="Description" value={policy.description ?? ''} onChange={e => set('description', e.target.value || undefined)} slotProps={{ htmlInput: { readOnly } }} multiline minRows={2} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}><FormControlLabel control={<Switch checked={policy.enabled} disabled={readOnly} onChange={e => set('enabled', e.target.checked)} />} label="Enabled" /><FormControlLabel control={<Switch checked={policy.global} disabled={readOnly} onChange={e => set('global', e.target.checked)} />} label="Global" /></Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}><FormControl size="small" sx={{ minWidth: 180 }}><InputLabel id="policy-mode">Mode</InputLabel><Select labelId="policy-mode" label="Mode" value={policy.mode ?? 'inherit'} readOnly={readOnly} onChange={e => set('mode', e.target.value as Policy['mode'])}><MenuItem value="inherit">Inherit lane mode</MenuItem><MenuItem value="observe">Observe</MenuItem><MenuItem value="enforce">Enforce</MenuItem></Select></FormControl><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="policy-severity">Severity</InputLabel><Select labelId="policy-severity" label="Severity" value={policy.severity ?? 'medium'} readOnly={readOnly} onChange={e => set('severity', e.target.value as Policy['severity'])}>{['info','low','medium','high','critical'].map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}</Select></FormControl></Stack>
      <Typography variant="caption" color="text.secondary">Observe records would-deny/would-alert previews; enforce applies the action.</Typography>
      <TextField size="small" label="Tags" value={(policy.tags ?? []).join(', ')} onChange={e => set('tags', e.target.value.split(',').map(x => x.trim()).filter(Boolean))} helperText="Comma separated" slotProps={{ htmlInput: { readOnly } }} />
      <MultiSelect label="Surfaces" value={policy.scope?.surfaces ?? []} options={SURFACES} onChange={setScope('surfaces')} readOnly={readOnly} />
      <StringList label="Agents" values={policy.scope?.agents ?? []} onChange={setScope('agents')} readOnly={readOnly} />
      <StringList label="Repos" values={policy.scope?.repos ?? []} onChange={setScope('repos')} readOnly={readOnly} />
      <StringList label="Users" values={policy.scope?.users ?? []} onChange={setScope('users')} readOnly={readOnly} />
    </Section>
    <Section title="Rules" hint="Rules use presets, classifiers and optional raw fields to match recorded actions.">
      {rules.map((r, i) => <RuleCard key={`${r.id}-${i}`} rule={r} presets={presets} classifiers={classifiers} readOnly={readOnly} onChange={nr => set('rules', rules.map((x, j) => j === i ? nr : x))} onDelete={() => set('rules', rules.filter((_, j) => j !== i))} />)}
      {!readOnly && <Button startIcon={<AddRoundedIcon />} size="small" variant="outlined" sx={{ alignSelf: 'flex-start' }} onClick={() => set('rules', [...rules, { id: `rule-${rules.length + 1}`, action: 'deny' }])}>Add rule</Button>}
    </Section>
  </Stack>;
}
