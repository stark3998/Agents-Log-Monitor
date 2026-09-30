import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControl, InputLabel, MenuItem, Select,
  Skeleton, Stack, Tab, Tabs, Tooltip, Typography,
} from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import { Link as RouterLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  errorMessage, useLane, useLaneVersionAction, useLaneVersions, useSaveLane, validateLaneYaml, type Lane, type LaneDraftResult, type LaneRecord,
  type LaneValidation,
} from '../../api/governance';
import { useEffectivePolicies } from '../../api/policies';
import { useAuth, useCan } from '../../auth/context';
import { SectionCard } from '../../components/Common';
import { Markdown } from '../../components/Markdown';
import { QueryError, RoleButton } from '../../components/gov/GovCommon';
import { LaneModeChip, LaneStatusChip } from '../../components/gov/GovChips';
import { RelativeTime } from '../../components/Primitives';
import { LaneForm } from './LaneForm';
import { YamlEditor } from './YamlEditor';
import { LaneDiff } from './LaneDiff';
import { SimulatePanel } from './SimulatePanel';
import { laneToYaml, newLane, recordYaml } from './laneUtils';

const EDITING = '__editing__';

/** Debounced server-side validation of the YAML text. */
export function useLaneValidation(yaml: string, enabled = true, delay = 400): { result: LaneValidation | null; checking: boolean; error: string | null } {
  const [result, setResult] = useState<LaneValidation | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    if (!yaml.trim()) { setResult({ ok: false, errors: ['Lane YAML is empty'] }); return; }
    const n = ++seq.current;
    setChecking(true);
    const id = setTimeout(() => {
      validateLaneYaml(yaml)
        .then(r => { if (n === seq.current) { setResult({ ok: !!r.ok, errors: r.errors ?? [], lane: r.lane }); setError(null); } })
        .catch(e => { if (n === seq.current) setError(errorMessage(e)); })
        .finally(() => { if (n === seq.current) setChecking(false); });
    }, delay);
    return () => clearTimeout(id);
  }, [yaml, delay, enabled]);
  return { result, checking, error };
}

function ValidationBadge({ v }: { v: ReturnType<typeof useLaneValidation> }) {
  if (v.error) return <Typography variant="caption" sx={{ color: 'warning.main' }}>Validation unavailable</Typography>;
  if (!v.result) return <Typography variant="caption">Validating…</Typography>;
  const ok = v.result.ok;
  const n = v.result.errors.length;
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: ok ? 'success.main' : 'error.main' }}>
      {ok ? <CheckCircleOutlineRoundedIcon sx={{ fontSize: 17 }} /> : <ErrorOutlineRoundedIcon sx={{ fontSize: 17 }} />}
      <Typography variant="body2" sx={{ color: 'inherit', fontWeight: 500 }}>{v.checking ? 'Checking…' : ok ? 'Valid lane' : `${n} error${n === 1 ? '' : 's'}`}</Typography>
    </Stack>
  );
}

function ValidationErrors({ v }: { v: ReturnType<typeof useLaneValidation> }) {
  if (v.error) return <Alert severity="warning">Validation unavailable: {v.error}</Alert>;
  if (!v.result || v.result.ok) return null;
  return (
    <Alert severity="error" icon={<ErrorOutlineRoundedIcon />} role="alert" aria-label="Validation errors" sx={{ '& ul': { m: 0, pl: 2 } }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{v.result.errors.length} validation error{v.result.errors.length === 1 ? '' : 's'}</Typography>
      <ul>{v.result.errors.map((e, i) => <li key={`${i}-${e}`}>{e}</li>)}</ul>
    </Alert>
  );
}


function EffectiveRulesPanel({ laneId }: { laneId: string | null }) {
  const q = useEffectivePolicies(laneId);
  const lane = q.data?.lane;
  const buckets = ['deny', 'approve', 'judge', 'allow', 'alert'] as const;
  if (!laneId) return <Typography variant="body2" color="text.secondary">Save the lane before viewing effective policy rules.</Typography>;
  if (q.isLoading) return <Skeleton variant="rounded" height={120} />;
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  return <Stack spacing={1.5}>{q.data?.missing?.length ? <Alert severity="warning">Missing policies: {q.data.missing.join(', ')}</Alert> : null}<Stack spacing={0.75}>{(q.data?.policies ?? []).map(p => <Typography key={`${p.id}@${p.version}`} variant="caption">{p.global ? 'Global' : 'Attached'} policy {p.id} v{p.version}{p.mode ? ` ? ${p.mode}` : ''}</Typography>)}</Stack>{buckets.map(b => <Box key={b}><Typography variant="subtitle2" sx={{ textTransform: 'capitalize' }}>{b}</Typography><Stack spacing={0.5}>{(lane?.rules?.[b] ?? []).map((r, i) => <Box key={`${b}-${i}`} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1.5 }}><Typography variant="body2" sx={{ fontFamily: 'var(--am-mono)' }}>{r.id ?? r.policyId ?? `${b}-${i + 1}`}</Typography><Typography variant="caption" color="text.secondary">{r.policyId ? `Policy ${r.policyId}${r.policyVersion ? ` v${r.policyVersion}` : ''}` : 'Lane rule'}{r.description ? ` ? ${r.description}` : ''}</Typography></Box>)}{!(lane?.rules?.[b] ?? []).length && <Typography variant="caption" color="text.secondary">No {b} rules.</Typography>}</Stack></Box>)}</Stack>;
}

function VersionHistory({ versions, current, editingYaml, onOpen }: { versions: LaneRecord[]; current: LaneRecord | null; editingYaml: string; onOpen: (r: LaneRecord) => void }) {
  const sorted = useMemo(() => [...versions].sort((a, b) => b.lane.version - a.lane.version), [versions]);
  const active = sorted.find(r => r.status === 'active');
  const [left, setLeft] = useState<string>('');
  const [right, setRight] = useState<string>(EDITING);
  const defaultLeft = String((active && active.lane.version !== current?.lane.version ? active : sorted.find(r => r.lane.version !== current?.lane.version) ?? sorted[0])?.lane.version ?? '');
  const l = left || defaultLeft;
  const yamlFor = (key: string) => (key === EDITING ? editingYaml : (() => { const r = sorted.find(x => String(x.lane.version) === key); return r ? recordYaml(r) : ''; })());
  const labelFor = (key: string) => (key === EDITING ? 'Editor (unsaved)' : `v${key}`);
  const opts = [{ key: EDITING, label: 'Editor (unsaved)' }, ...sorted.map(r => ({ key: String(r.lane.version), label: `v${r.lane.version} · ${r.status}` }))];
  return (
    <Stack spacing={2}>
      <Stack spacing={0.75}>
        {sorted.map(r => (
          <Stack key={r.lane.version} direction="row" spacing={1} sx={{ alignItems: 'center', p: 1, borderRadius: 1.5, bgcolor: r.lane.version === current?.lane.version ? 'action.selected' : undefined }}>
            <Typography variant="body2" sx={{ fontWeight: 600, width: 44 }}>v{r.lane.version}</Typography>
            <LaneStatusChip status={r.status} />
            <Typography variant="caption" sx={{ flex: 1, minWidth: 0 }} noWrap>{r.updatedBy ?? ''} · <RelativeTime iso={r.updatedAt} /></Typography>
            <Button size="small" onClick={() => onOpen(r)} disabled={r.lane.version === current?.lane.version}>Open</Button>
          </Stack>
        ))}
      </Stack>
      {sorted.length > 0 && (
        <>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography variant="subtitle2">Compare</Typography>
            <FormControl size="small" sx={{ minWidth: 170 }}>
              <InputLabel id="diff-left">From</InputLabel>
              <Select labelId="diff-left" label="From" value={l} onChange={e => setLeft(e.target.value)}>
                {opts.map(o => <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 170 }}>
              <InputLabel id="diff-right">To</InputLabel>
              <Select labelId="diff-right" label="To" value={right} onChange={e => setRight(e.target.value)}>
                {opts.map(o => <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>
          <LaneDiff before={yamlFor(l)} after={yamlFor(right)} beforeLabel={labelFor(l)} afterLabel={labelFor(right)} />
        </>
      )}
    </Stack>
  );
}

export function LaneEditorPage() {
  const { id: rawId = 'new' } = useParams();
  const isNew = rawId === 'new';
  const [params] = useSearchParams();
  const version = params.get('version') ? Number(params.get('version')) : undefined;
  const location = useLocation();
  const navigate = useNavigate();
  const draft = (location.state as { draft?: LaneDraftResult } | null)?.draft;
  const { principal } = useAuth();
  const isAdmin = useCan('PolicyAdmin');

  const laneQ = useLane(isNew || draft ? null : rawId, version);
  const versions = useLaneVersions(isNew ? null : rawId);
  const save = useSaveLane();
  const versionAction = useLaneVersionAction();

  const rec: LaneRecord | null = draft?.lane ?? laneQ.data ?? null;
  const [tab, setTab] = useState<'form' | 'yaml'>('form');
  const [yaml, setYaml] = useState('');
  const [lane, setLane] = useState<Lane | null>(null);
  const [initialYaml, setInitialYaml] = useState('');
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [confirmActivate, setConfirmActivate] = useState(false);

  // (Re)initialise the editor when the route's lane/version (or AI draft) changes.
  const key = isNew ? 'new' : rec ? `${rec.lane.id}@${rec.lane.version}${draft ? ':draft' : ''}` : null;
  useEffect(() => {
    if (!key || key === loadedKey) return;
    const base = isNew ? newLane() : rec!.lane;
    const y = isNew ? laneToYaml(base) : recordYaml(rec!);
    setLane(base);
    setYaml(y);
    setInitialYaml(y);
    setLoadedKey(key);
    setNotice(null);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const validation = useLaneValidation(yaml, !!loadedKey);
  const valid = !!validation.result?.ok;
  // Keep the form in sync with valid YAML typed in the YAML tab.
  useEffect(() => {
    if (tab === 'yaml' && validation.result?.ok && validation.result.lane) setLane(validation.result.lane);
  }, [validation.result, tab]);

  const dirty = yaml !== initialYaml;
  const isStored = !!rec && !draft ? true : !!draft && !!versions.data?.some(v => v.lane.version === rec?.lane.version);
  const reviewable = !!rec && isStored && rec.status === 'proposed' && !dirty;

  const onForm = (l: Lane) => { setLane(l); setYaml(laneToYaml(l)); };

  const goTo = (r: LaneRecord) => navigate(`/lanes/${encodeURIComponent(r.lane.id)}?version=${r.lane.version}`, { replace: true });

  const doSave = async (status: 'draft' | 'proposed') => {
    try {
      const r = await save.mutateAsync({ yaml, status });
      setNotice({ severity: 'success', text: status === 'draft' ? `Saved draft v${r.lane.version}.` : `Proposed v${r.lane.version} for review.` });
      setInitialYaml(yaml);
      setLoadedKey(`${r.lane.id}@${r.lane.version}`);
      goTo(r);
    } catch (e) {
      setNotice({ severity: 'error', text: errorMessage(e) });
    }
  };

  const doActivate = async () => {
    setConfirmActivate(false);
    try {
      let target = rec;
      if (dirty || !isStored || !rec) target = await save.mutateAsync({ yaml, status: 'draft' });
      const r = await versionAction.mutateAsync({ id: target!.lane.id, version: target!.lane.version, action: 'activate' });
      setNotice({ severity: 'success', text: `Activated v${target!.lane.version}.` });
      setInitialYaml(yaml);
      if (r?.lane) { setLoadedKey(`${r.lane.id}@${r.lane.version}`); goTo(r); } else goTo(target!);
    } catch (e) {
      setNotice({ severity: 'error', text: errorMessage(e) });
    }
  };

  const doReject = async () => {
    if (!rec) return;
    try {
      await versionAction.mutateAsync({ id: rec.lane.id, version: rec.lane.version, action: 'archive' });
      setNotice({ severity: 'success', text: `Rejected proposal v${rec.lane.version} (archived).` });
    } catch (e) {
      setNotice({ severity: 'error', text: errorMessage(e) });
    }
  };

  if (!isNew && !draft && laneQ.isError) {
    return <QueryError error={laneQ.error} onRetry={() => void laneQ.refetch()} title="Lane not found" />;
  }
  if (!lane) return <Stack spacing={2}><Skeleton width={240} height={36} /><Skeleton variant="rounded" height={420} /></Stack>;

  const busy = save.isPending || versionAction.isPending;
  const title = isNew ? 'New lane' : (lane.name || lane.id);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Tooltip title="All lanes"><Button size="small" component={RouterLink} to="/lanes" startIcon={<ArrowBackRoundedIcon />}>Lanes</Button></Tooltip>
        <Typography variant="h5" component="h2" sx={{ minWidth: 0 }}>{title}</Typography>
        {rec && !isNew && <Typography variant="body2" color="text.secondary">v{rec.lane.version}</Typography>}
        {rec && !isNew && <LaneStatusChip status={rec.status} />}
        <LaneModeChip mode={lane.mode} />
        {dirty && <Typography variant="caption" sx={{ color: 'warning.main' }}>Unsaved changes</Typography>}
        <Box sx={{ flex: 1 }} />
        <RoleButton roles={['PolicyAdmin']} size="small" variant="outlined" disabled={!valid || busy || (!dirty && !isNew && !draft)} onClick={() => void doSave('draft')}>Save as draft</RoleButton>
        <Tooltip title={principal ? 'Submit for PolicyAdmin review' : 'Sign in to propose changes'}>
          <span><Button size="small" variant="outlined" disabled={!principal || !valid || busy || (!dirty && !isNew && !draft)} onClick={() => void doSave('proposed')}>Propose</Button></span>
        </Tooltip>
        <RoleButton roles={['PolicyAdmin']} size="small" variant="contained" disabled={!valid || busy || (rec?.status === 'active' && !dirty && !isNew)} onClick={() => setConfirmActivate(true)}>Activate</RoleButton>
      </Stack>

      {notice && <Alert severity={notice.severity} onClose={() => setNotice(null)} role={notice.severity === 'error' ? 'alert' : 'status'}>{notice.text}</Alert>}

      {draft && (
        <Alert severity="info" icon={<AutoAwesomeOutlinedIcon />}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>AI-drafted lane proposal — review before activating.</Typography>
          {draft.rationale && <Markdown sx={{ fontSize: 12.5, mt: 0.5 }}>{draft.rationale}</Markdown>}
        </Alert>
      )}

      {reviewable && (
        <Alert
          severity="warning"
          action={(
            <Stack direction="row" spacing={1}>
              <RoleButton roles={['PolicyAdmin']} size="small" color="inherit" disabled={busy} onClick={() => void doReject()}>Reject</RoleButton>
              <RoleButton roles={['PolicyAdmin']} size="small" variant="contained" disabled={busy || !valid} onClick={() => setConfirmActivate(true)}>Approve &amp; activate</RoleButton>
            </Stack>
          )}
        >
          Proposal v{rec!.lane.version}{rec!.updatedBy ? ` by ${rec!.updatedBy}` : ''} is awaiting review.{!isAdmin && ' A PolicyAdmin must approve it.'}
        </Alert>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 3fr) minmax(360px, 2fr)' }, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" sx={{ alignItems: 'center', mb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label="Lane editor">
              <Tab value="form" label="Form" disabled={tab === 'yaml' && !valid} />
              <Tab value="yaml" label="YAML" />
            </Tabs>
            <Box sx={{ flex: 1 }} />
            <ValidationBadge v={validation} />
          </Stack>
          {tab === 'yaml' && !valid && <Typography variant="caption" component="div" sx={{ mb: 1 }}>Fix YAML errors to switch back to the form.</Typography>}
          <Box sx={{ mb: 2, '&:empty': { display: 'none' } }}><ValidationErrors v={validation} /></Box>
          {tab === 'form'
            ? (
              <>
                <LaneForm lane={lane} onChange={onForm} isNew={isNew} />
                <Typography variant="caption" component="div" sx={{ mt: 1 }}>Editing in the form re-formats the YAML (comments are not preserved).</Typography>
              </>
            )
            : <YamlEditor value={yaml} onChange={setYaml} errors={validation.result?.ok ? [] : validation.result?.errors ?? []} />}
        </Box>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          <SectionCard title="Simulate against history" subtitle="Replay recorded actions through this lane to preview its impact before activating.">
            <SimulatePanel yaml={yaml} disabled={!valid} initial={draft?.simulation} />
          </SectionCard>
          {!isNew && (
            <SectionCard title="Effective rules" subtitle="Merged lane and active policy rules by action bucket.">
              <EffectiveRulesPanel laneId={rec?.lane.id ?? rawId} />
            </SectionCard>
          )}
          {!isNew && (
            <SectionCard title="Version history">
              {versions.isLoading ? <Skeleton variant="rounded" height={120} />
                : versions.isError ? <QueryError error={versions.error} onRetry={() => void versions.refetch()} />
                : <VersionHistory versions={versions.data ?? []} current={rec} editingYaml={yaml} onOpen={r => navigate(`/lanes/${encodeURIComponent(r.lane.id)}?version=${r.lane.version}`)} />}
            </SectionCard>
          )}
        </Stack>
      </Box>

      <Dialog open={confirmActivate} onClose={() => setConfirmActivate(false)} aria-labelledby="activate-title">
        <DialogTitle id="activate-title">Activate {lane.id}?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13 }}>
            This version becomes the enforced lane for every agent in scope ({lane.mode} mode). The previous active version is archived and remains in history.
            {dirty && ' Your unsaved changes are saved as a new version first.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmActivate(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void doActivate()}>Activate</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
