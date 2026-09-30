import { useTheme } from '@mui/material';
import { ToneChip } from '../../components/Chips';
import { successTone } from '../../components/gov/GovChips';
import type { PolicyAction, PolicyMode, PolicySeverity, PolicyStatus } from '../../api/policies';

export function SeverityToneChip({ severity }: { severity?: PolicySeverity }) { const t = useTheme().tokens; const s = severity ?? 'info'; return <ToneChip tone={t.severity[s]} label={s[0].toUpperCase() + s.slice(1)} aria-label={`Severity ${s}`} />; }
export function PolicyStatusChip({ status }: { status: PolicyStatus }) { const t = useTheme().tokens; const tone = status === 'active' ? successTone(t) : status === 'proposed' ? t.severity.medium : status === 'archived' ? t.severity.info : t.severity.low; return <ToneChip tone={tone} label={status[0].toUpperCase() + status.slice(1)} aria-label={`Status ${status}`} />; }
export function PolicyModeChip({ mode }: { mode?: PolicyMode }) { const t = useTheme().tokens; const m = mode ?? 'inherit'; const tone = m === 'enforce' ? t.severity.high : m === 'observe' ? t.severity.info : t.severity.low; return <ToneChip tone={tone} label={m[0].toUpperCase() + m.slice(1)} aria-label={`Mode ${m}`} />; }
export function ActionChip({ action }: { action: PolicyAction }) { const t = useTheme().tokens; const tone = action === 'deny' ? t.severity.critical : action === 'alert' ? t.severity.high : action === 'judge' || action === 'approve' ? t.severity.medium : successTone(t); return <ToneChip tone={tone} label={action} sx={{ height: 20, fontSize: 11 }} />; }
