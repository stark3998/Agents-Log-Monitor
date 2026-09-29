import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  Alert, Box, Chip, Dialog, DialogContent, DialogTitle, IconButton, LinearProgress, Stack, Tab, Tabs, Tooltip, Typography, useTheme,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import RadioButtonUncheckedRoundedIcon from '@mui/icons-material/RadioButtonUncheckedRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import { useSettings, useSources } from '../api/client';
import type { RiskRuleInfo, Settings } from '../api/types';
import { AgentAvatar } from './AgentAvatar';
import { ChannelBadge, ToneChip } from './Chips';
import { CopyButton } from './Common';
import { LiveDot, RelativeTime } from './Primitives';
import { fmtNum } from '../lib/format';

export type SettingsTab = 'sources' | 'rules' | 'privacy';

const Ctx = createContext<(tab?: SettingsTab) => void>(() => {});
/** Open the settings dialog on a given tab from anywhere (e.g. a severity tooltip). */
export const useOpenSettings = () => useContext(Ctx);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const open = useCallback((t: SettingsTab = 'sources') => setTab(t), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      <SettingsDialog tab={tab} onTab={setTab} onClose={() => setTab(null)} />
    </Ctx.Provider>
  );
}

// ── Sources ─────────────────────────────────────────────────────────────

function SourcesPanel() {
  const { data } = useSources(true);
  const t = useTheme().tokens;
  return (
    <Stack spacing={1.25}>
      {(data ?? []).map((s, i) => {
        const recent = s.lastEventAt && Date.now() - Date.parse(s.lastEventAt) < 10 * 60_000;
        return (
          <Box key={s.id} sx={{ p: 1.75, border: '1px solid', borderColor: 'divider', borderRadius: 2.5, animation: `am-fade-up 300ms ${i * 40}ms both` }}>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
              <AgentAvatar agentKey={s.agentKey} size={30} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography variant="subtitle2">{s.name}</Typography>
                  <ChannelBadge channel={s.channel} />
                  {s.backlog && <ToneChip tone={t.severity.low} label="importing…" sx={{ height: 18, fontSize: 10.5 }} />}
                </Stack>
                <Typography variant="caption">
                  {s.events ? <>{fmtNum(s.events)} events · last <RelativeTime iso={s.lastEventAt} /></> : 'No events yet'}
                </Typography>
              </Box>
              {s.lastError ? (
                <Tooltip title={s.lastError}><ErrorOutlineRoundedIcon color="error" fontSize="small" /></Tooltip>
              ) : recent ? (
                <Chip size="small" icon={<Box sx={{ pl: 1, display: 'flex' }}><LiveDot /></Box>} label="Active" variant="outlined" />
              ) : s.configured || s.enabled ? (
                <Tooltip title="Configured"><CheckCircleRoundedIcon sx={{ fontSize: 18, color: 'success.main' }} /></Tooltip>
              ) : (
                <Tooltip title="Not configured"><RadioButtonUncheckedRoundedIcon sx={{ fontSize: 18, color: 'text.disabled' }} /></Tooltip>
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, pl: 5.25 }}>{s.setup}</Typography>
          </Box>
        );
      })}
    </Stack>
  );
}

// ── Rules ───────────────────────────────────────────────────────────────

function LevelChip({ level }: { level: RiskRuleInfo['level'] }) {
  const t = useTheme().tokens;
  if (level === 'off') return <Chip size="small" variant="outlined" label="off" sx={{ color: 'text.disabled' }} />;
  return <ToneChip tone={t.severity[level]} label={level} sx={{ textTransform: 'capitalize', minWidth: 64 }} />;
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">{title}</Typography>
      {hint && <Typography variant="caption" component="div" sx={{ mb: 1 }}>{hint}</Typography>}
      {children}
    </Box>
  );
}

const THRESHOLD_TEXT: Record<keyof Settings['rules']['severity'], (n: number) => string> = {
  criticalHighActionsWithSecrets: n => `Critical — secrets detected and ≥ ${n} high-risk actions (or any critical-risk action)`,
  highSecretDetections: n => `High — ≥ ${n} secret detections (or any high-risk action)`,
  mediumRiskActions: n => `Medium — ≥ ${n} medium-risk actions (or any secret / denial)`,
};

function RulesPanel({ s }: { s: Settings }) {
  const r = s.rules;
  const rows = useMemo(() => [...r.risk].sort((a, b) => (a.source === b.source ? 0 : a.source === 'custom' ? -1 : 1)), [r.risk]);
  return (
    <Stack spacing={2.5}>
      <Alert severity="info" variant="outlined" sx={{ borderColor: 'divider' }}>
        Severity, risk and detections are <b>advisory heuristics</b>. Tune them in <code>agent-monitor.rules.json</code> — changes are picked up
        automatically and stored events are re-analyzed in the background.
      </Alert>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.path}</Typography>
        <Chip size="small" variant="outlined" label={r.exists ? 'loaded' : 'not created — using defaults'} color={r.exists ? 'success' : 'default'} />
        <CopyButton text={r.path} label="Copy path" />
      </Stack>
      {r.error && <Alert severity="warning" variant="outlined">{r.error}</Alert>}
      {s.maintenance.running && (
        <Box>
          <Typography variant="caption">Re-analyzing stored events… {fmtNum(s.maintenance.processed)} done</Typography>
          <LinearProgress sx={{ mt: 0.5, borderRadius: 1 }} />
        </Box>
      )}

      <Section title="Risk rules" hint={<>Override a level with <code>{'"risk": { "overrides": { "git-push": "low" } }'}</code>, or add patterns under <code>risk.custom</code>.</>}>
        <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
          {rows.map((x, i) => (
            <Stack key={x.rule} direction="row" spacing={1.25} sx={{ alignItems: 'center', px: 1.5, py: 0.85, borderTop: i ? '1px solid' : 'none', borderColor: 'divider' }}>
              <LevelChip level={x.level} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{x.label}</Typography>
                <Typography variant="caption" noWrap component="div">
                  <Box component="span" sx={{ fontFamily: 'var(--am-mono)' }}>{x.rule}</Box> · {x.appliesTo}
                  {x.pattern && <> · <Box component="span" sx={{ fontFamily: 'var(--am-mono)' }}>/{x.pattern}/</Box></>}
                </Typography>
              </Box>
              {x.source === 'custom' && <Chip size="small" label="custom" variant="outlined" />}
              {x.defaultLevel && x.level !== x.defaultLevel && (
                <Tooltip title={`Default: ${x.defaultLevel}`}><Chip size="small" label="overridden" variant="outlined" color="warning" /></Tooltip>
              )}
            </Stack>
          ))}
        </Box>
      </Section>

      <Section title="Sensitive-data detectors" hint={<>Disable with <code>{'"detectors": { "disabled": ["email"] }'}</code>.</>}>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
          {r.detectors.map(d => (
            <Chip key={d.key} size="small" variant="outlined" label={d.label}
              sx={{ opacity: d.enabled ? 1 : 0.45, textDecoration: d.enabled ? 'none' : 'line-through' }} />
          ))}
        </Stack>
      </Section>

      <Section title="Session severity" hint={<>Adjust with <code>{'"severity": { "highSecretDetections": 10 }'}</code>. Applied instantly.</>}>
        <Stack spacing={0.5}>
          {(Object.keys(THRESHOLD_TEXT) as (keyof Settings['rules']['severity'])[]).map(k => (
            <Typography key={k} variant="body2" color="text.secondary">
              {THRESHOLD_TEXT[k](r.severity[k])}
              {r.severity[k] !== r.severityDefaults[k] && <Chip size="small" label={`default ${r.severityDefaults[k]}`} variant="outlined" sx={{ ml: 1, height: 18 }} />}
            </Typography>
          ))}
        </Stack>
      </Section>

      <Section title="Ignored domains" hint={<>Hosts excluded from the connections heatmap: <code>{'"domains": { "ignore": ["*.corp.example.com"] }'}</code>.</>}>
        {r.domainsIgnored.length
          ? <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>{r.domainsIgnored.map(d => <Chip key={d} size="small" label={d} variant="outlined" />)}</Stack>
          : <Typography variant="body2" color="text.disabled">None</Typography>}
      </Section>
    </Stack>
  );
}

// ── Privacy & storage ───────────────────────────────────────────────────

const REDACTION_TEXT: Record<Settings['redaction']['mode'], string> = {
  off: 'Payloads are stored exactly as received. Findings still store masked samples only.',
  secrets: 'Secrets (keys, tokens, passwords, connection strings, private keys) are masked before payloads are stored. Personal data such as emails is kept.',
  all: 'Secrets and personal data (emails) are masked before payloads are stored.',
};

function PrivacyPanel({ s }: { s: Settings }) {
  const t = useTheme().tokens;
  const tone = s.redaction.mode === 'off' ? t.severity.high : t.channel.hook;
  return (
    <Stack spacing={2.5}>
      <Section title="Payload redaction">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <ToneChip tone={tone} label={s.redaction.mode} sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }} />
          <Typography variant="body2" color="text.secondary">{REDACTION_TEXT[s.redaction.mode]}</Typography>
        </Stack>
        <Typography variant="caption" component="div">
          Set <code>{s.redaction.env}=off|secrets|all</code> and restart. Raising the level also redacts events stored earlier; lowering it cannot restore masked values.
        </Typography>
      </Section>
      <Section title="Storage">
        <Stack spacing={0.5}>
          <Typography variant="body2" color="text.secondary">Engine: {s.database.engine}</Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.database.path}</Typography>
            <CopyButton text={s.database.path} label="Copy path" />
          </Stack>
        </Stack>
      </Section>
    </Stack>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────

function SettingsDialog({ tab, onTab, onClose }: { tab: SettingsTab | null; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  const open = tab != null;
  const settings = useSettings(open && tab !== 'sources');
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth slotProps={{ paper: { sx: { height: 'min(760px, calc(100vh - 64px))' } } }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', pr: 1.5, pb: 0 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6">Settings</Typography>
          <Typography variant="body2" color="text.secondary">Sources, detection rules, privacy and storage</Typography>
        </Box>
        <IconButton aria-label="Close" onClick={onClose}><CloseRoundedIcon /></IconButton>
      </DialogTitle>
      <Box sx={{ px: 3, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Tabs value={tab ?? 'sources'} onChange={(_, v) => onTab(v)}>
          <Tab value="sources" label="Sources" />
          <Tab value="rules" label="Detection rules" />
          <Tab value="privacy" label="Privacy & storage" />
        </Tabs>
      </Box>
      <DialogContent sx={{ pt: 2.5 }}>
        <Box key={tab} sx={{ animation: 'am-fade-in 200ms both' }}>
          {tab === 'sources' && <SourcesPanel />}
          {tab !== 'sources' && !settings.data && <LinearProgress sx={{ borderRadius: 1 }} />}
          {tab === 'rules' && settings.data && <RulesPanel s={settings.data} />}
          {tab === 'privacy' && settings.data && <PrivacyPanel s={settings.data} />}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
