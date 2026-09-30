import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, InputLabel, MenuItem, Select, Skeleton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../../api/governance';
import { simulatePolicy, useClassifiers, usePolicy, usePolicyVersionAction, usePolicyVersions, usePresets, useSavePolicy, validatePolicyYaml, type Policy, type PolicyRecord, type PolicyValidation } from '../../api/policies';
import { useAuth, useCan } from '../../auth/context';
import { SectionCard } from '../../components/Common';
import { QueryError, RoleButton } from '../../components/gov/GovCommon';
import { RelativeTime } from '../../components/Primitives';
import { LaneDiff } from '../lanes/LaneDiff';
import { YamlEditor } from '../lanes/YamlEditor';
import { PolicyForm } from './PolicyForm';
import { PolicyModeChip, PolicyStatusChip, SeverityToneChip } from './PolicyChips';
import { newPolicy, policyToYaml, recordYaml } from './policyUtils';
import { PolicySimulatePanel } from './PolicySimulatePanel';

const EDITING = '__editing__';

export function usePolicyValidation(yaml: string, enabled = true, delay = 400): { result: PolicyValidation | null; checking: boolean; error: string | null } {
  const [result, setResult] = useState<PolicyValidation | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    if (!yaml.trim()) { setResult({ ok: false, errors: ['Policy YAML is empty'] }); return; }
    const n = ++seq.current;
    setChecking(true);
    const id = setTimeout(() => {
      validatePolicyYaml(yaml)
        .then(r => { if (n === seq.current) { setResult({ ok: !!r.ok, errors: r.errors ?? [], policy: r.policy }); setError(null); } })
        .catch(e => { if (n === seq.current) setError(errorMessage(e)); })
        .finally(() => { if (n === seq.current) setChecking(false); });
    }, delay);
    return () => clearTimeout(id);
  }, [yaml, delay, enabled]);
  return { result, checking, error };
}

function ValidationBadge({ v }: { v: ReturnType<typeof usePolicyValidation> }) {
  if (v.error) return <Typography variant="caption" sx={{ color: 'warning.main' }}>Validation unavailable</Typography>;
  if (!v.result) return <Typography variant="caption">Validating?</Typography>;
  const ok = v.result.ok;
  return <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: ok ? 'success.main' : 'error.main' }}>{ok ? <CheckCircleOutlineRoundedIcon sx={{ fontSize: 17 }} /> : <ErrorOutlineRoundedIcon sx={{ fontSize: 17 }} />}<Typography variant="body2" sx={{ color: 'inherit', fontWeight: 500 }}>{v.checking ? 'Checking?' : ok ? 'Valid policy' : `${v.result.errors.length} error${v.result.errors.length === 1 ? '' : 's'}`}</Typography></Stack>;
}
function ValidationErrors({ v }: { v: ReturnType<typeof usePolicyValidation> }) {
  if (v.error) return <Alert severity="warning">Validation unavailable: {v.error}</Alert>;
  if (!v.result || v.result.ok) return null;
  return <Alert severity="error" role="alert" aria-label="Validation errors"><Typography variant="body2" sx={{ fontWeight: 600 }}>{v.result.errors.length} validation error{v.result.errors.length === 1 ? '' : 's'}</Typography><ul>{v.result.errors.map((e, i) => <li key={`${i}-${e}`}>{e}</li>)}</ul></Alert>;
}

function VersionHistory({ versions, current, editingYaml, onOpen }: { versions: PolicyRecord[]; current: PolicyRecord | null; editingYaml: string; onOpen: (r: PolicyRecord) => void }) {
  const sorted = useMemo(() => [...versions].sort((a, b) => b.policy.version - a.policy.version), [versions]);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState(EDITING);
  const active = sorted.find(r => r.status === 'active');
  const defaultLeft = String((active && active.policy.version !== current?.policy.version ? active : sorted.find(r => r.policy.version !== current?.policy.version) ?? sorted[0])?.policy.version ?? '');
  const l = left || defaultLeft;
  const yamlFor = (key: string) => key === EDITING ? editingYaml : recordYaml(sorted.find(x => String(x.policy.version) === key) ?? sorted[0]);
  const opts = [{ key: EDITING, label: 'Editor (unsaved)' }, ...sorted.map(r => ({ key: String(r.policy.version), label: `v${r.policy.version} ? ${r.status}` }))];
  return <Stack spacing={2}>{sorted.map(r => <Stack key={r.policy.version} direction="row" spacing={1} sx={{ alignItems: 'center', p: 1, borderRadius: 1.5, bgcolor: r.policy.version === current?.policy.version ? 'action.selected' : undefined }}><Typography variant="body2" sx={{ fontWeight: 600, width: 44 }}>v{r.policy.version}</Typography><PolicyStatusChip status={r.status} /><Typography variant="caption" sx={{ flex: 1 }} noWrap>{r.updatedBy ?? ''} ? <RelativeTime iso={r.updatedAt} /></Typography><Button size="small" onClick={() => onOpen(r)} disabled={r.policy.version === current?.policy.version}>Open</Button></Stack>)}{sorted.length > 0 && <><Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}><Typography variant="subtitle2">Compare</Typography><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="policy-diff-left">From</InputLabel><Select labelId="policy-diff-left" label="From" value={l} onChange={e => setLeft(e.target.value)}>{opts.map(o => <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>)}</Select></FormControl><FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="policy-diff-right">To</InputLabel><Select labelId="policy-diff-right" label="To" value={right} onChange={e => setRight(e.target.value)}>{opts.map(o => <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>)}</Select></FormControl></Stack><LaneDiff before={yamlFor(l)} after={yamlFor(right)} beforeLabel={l === EDITING ? 'Editor' : `v${l}`} afterLabel={right === EDITING ? 'Editor' : `v${right}`} /></>}</Stack>;
}

export function PolicyEditorPage() {
  const { id: rawId = 'new' } = useParams();
  const isNew = rawId === 'new';
  const [params] = useSearchParams();
  const version = params.get('version') ? Number(params.get('version')) : undefined;
  const navigate = useNavigate();
  const { principal } = useAuth();
  const isAdmin = useCan('PolicyAdmin');
  const policyQ = usePolicy(isNew ? null : rawId, version);
  const versions = usePolicyVersions(isNew ? null : rawId);
  const presets = usePresets();
  const classifiers = useClassifiers();
  const save = useSavePolicy();
  const versionAction = usePolicyVersionAction();
  const rec = policyQ.data ?? null;
  const [tab, setTab] = useState<'form' | 'yaml'>('form');
  const [yaml, setYaml] = useState('');
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [initialYaml, setInitialYaml] = useState('');
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [confirmActivate, setConfirmActivate] = useState(false);
  const key = isNew ? 'new' : rec ? `${rec.policy.id}@${rec.policy.version}` : null;
  useEffect(() => { if (!key || key === loadedKey) return; const base = isNew ? newPolicy() : rec!.policy; const y = isNew ? policyToYaml(base) : recordYaml(rec!); setPolicy(base); setYaml(y); setInitialYaml(y); setLoadedKey(key); setNotice(null); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const validation = usePolicyValidation(yaml, !!loadedKey);
  const valid = !!validation.result?.ok;
  useEffect(() => { if (tab === 'yaml' && validation.result?.ok && validation.result.policy) setPolicy(validation.result.policy); }, [validation.result, tab]);
  const onForm = (p: Policy) => { setPolicy(p); setYaml(policyToYaml(p)); };
  const dirty = yaml !== initialYaml;
  const busy = save.isPending || versionAction.isPending;
  const reviewable = !!rec && rec.status === 'proposed' && !dirty;
  const goTo = (r: PolicyRecord) => navigate(`/policies/${encodeURIComponent(r.policy.id)}?version=${r.policy.version}`, { replace: true });
  const doSave = async (status: 'draft' | 'proposed' | 'active') => { try { const r = await save.mutateAsync({ yaml, status }); setNotice({ severity: 'success', text: status === 'active' ? `Activated v${r.policy.version}.` : status === 'draft' ? `Saved draft v${r.policy.version}.` : `Proposed v${r.policy.version}.` }); setInitialYaml(yaml); setLoadedKey(`${r.policy.id}@${r.policy.version}`); goTo(r); } catch (e) { setNotice({ severity: 'error', text: errorMessage(e) }); } };
  const doActivate = async () => { setConfirmActivate(false); try { let target = rec; if (dirty || !rec) target = await save.mutateAsync({ yaml, status: 'draft' }); const r = await versionAction.mutateAsync({ id: target!.policy.id, version: target!.policy.version, action: 'activate' }); setNotice({ severity: 'success', text: `Activated v${target!.policy.version}.` }); setInitialYaml(yaml); goTo(r?.policy ? r : target!); } catch (e) { setNotice({ severity: 'error', text: errorMessage(e) }); } };
  const doArchive = async () => { if (!rec) return; try { await versionAction.mutateAsync({ id: rec.policy.id, version: rec.policy.version, action: 'archive' }); setNotice({ severity: 'success', text: `Archived v${rec.policy.version}.` }); } catch (e) { setNotice({ severity: 'error', text: errorMessage(e) }); } };
  if (!isNew && policyQ.isError) return <QueryError error={policyQ.error} onRetry={() => void policyQ.refetch()} title="Policy not found" />;
  if (!policy) return <Stack spacing={2}><Skeleton width={240} height={36} /><Skeleton variant="rounded" height={420} /></Stack>;
  return <Stack spacing={2}>
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}><Tooltip title="All policies"><Button size="small" component={RouterLink} to="/policies" startIcon={<ArrowBackRoundedIcon />}>Policies</Button></Tooltip><Typography variant="h5" component="h2" sx={{ minWidth: 0 }}>{isNew ? 'New policy' : policy.name || policy.id}</Typography>{rec && <Typography variant="body2" color="text.secondary">v{rec.policy.version}</Typography>}{rec && <PolicyStatusChip status={rec.status} />}<PolicyModeChip mode={policy.mode} /><SeverityToneChip severity={policy.severity} />{dirty && <Typography variant="caption" sx={{ color: 'warning.main' }}>Unsaved changes</Typography>}<Box sx={{ flex: 1 }} /><RoleButton roles={['PolicyAdmin']} size="small" variant="outlined" disabled={!valid || busy || (!dirty && !isNew)} onClick={() => void doSave('draft')}>Save as draft</RoleButton><Tooltip title={principal ? 'Submit for PolicyAdmin review' : 'Sign in to propose changes'}><span><Button size="small" variant="outlined" disabled={!principal || !valid || busy || (!dirty && !isNew)} onClick={() => void doSave('proposed')}>Propose</Button></span></Tooltip><RoleButton roles={['PolicyAdmin']} size="small" variant="contained" disabled={!valid || busy || (rec?.status === 'active' && !dirty && !isNew)} onClick={() => setConfirmActivate(true)}>Activate</RoleButton></Stack>
    {notice && <Alert severity={notice.severity} onClose={() => setNotice(null)} role={notice.severity === 'error' ? 'alert' : 'status'}>{notice.text}</Alert>}
    {reviewable && <Alert severity="warning" action={<Stack direction="row" spacing={1}><RoleButton roles={['PolicyAdmin']} size="small" color="inherit" disabled={busy} onClick={() => void doArchive()}>Archive</RoleButton><RoleButton roles={['PolicyAdmin']} size="small" variant="contained" disabled={busy || !valid} onClick={() => setConfirmActivate(true)}>Approve & activate</RoleButton></Stack>}>Proposal v{rec!.policy.version} is awaiting review.{!isAdmin && ' A PolicyAdmin must approve it.'}</Alert>}
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 3fr) minmax(360px, 2fr)' }, alignItems: 'start' }}><Box sx={{ minWidth: 0 }}><Stack direction="row" sx={{ alignItems: 'center', mb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}><Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label="Policy editor"><Tab value="form" label="Form" disabled={tab === 'yaml' && !valid} /><Tab value="yaml" label="YAML" /></Tabs><Box sx={{ flex: 1 }} /><ValidationBadge v={validation} /></Stack>{tab === 'yaml' && !valid && <Typography variant="caption" component="div" sx={{ mb: 1 }}>Fix YAML errors to switch back to the form.</Typography>}<Box sx={{ mb: 2, '&:empty': { display: 'none' } }}><ValidationErrors v={validation} /></Box>{tab === 'form' ? <><PolicyForm policy={policy} onChange={onForm} isNew={isNew} presets={presets.data} classifiers={classifiers.data?.items ?? []} /><Typography variant="caption" component="div" sx={{ mt: 1 }}>Editing in the form re-formats the YAML (comments are not preserved).</Typography></> : <YamlEditor value={yaml} onChange={setYaml} errors={validation.result?.ok ? [] : validation.result?.errors ?? []} />}</Box><Stack spacing={2} sx={{ minWidth: 0 }}><SectionCard title="Simulate against history" subtitle="Replay recorded actions through this policy before activating."><PolicySimulatePanel yaml={yaml} disabled={!valid} simulate={simulatePolicy} /></SectionCard>{!isNew && <SectionCard title="Version history">{versions.isLoading ? <Skeleton variant="rounded" height={120} /> : versions.isError ? <QueryError error={versions.error} onRetry={() => void versions.refetch()} /> : <VersionHistory versions={versions.data ?? []} current={rec} editingYaml={yaml} onOpen={r => navigate(`/policies/${encodeURIComponent(r.policy.id)}?version=${r.policy.version}`)} />}</SectionCard>}</Stack></Box>
    <Dialog open={confirmActivate} onClose={() => setConfirmActivate(false)}><DialogTitle>Activate policy?</DialogTitle><DialogContent><Typography variant="body2">Active policies may affect monitor enforcement. Continue?</Typography></DialogContent><DialogActions><Button onClick={() => setConfirmActivate(false)}>Cancel</Button><Button variant="contained" disabled={!valid || busy} onClick={() => void doActivate()}>Activate</Button></DialogActions></Dialog>
  </Stack>;
}
