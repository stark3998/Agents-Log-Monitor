import { Box, Card, CardActionArea, Skeleton, Stack, Typography, useTheme } from '@mui/material';
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded';
import TrendingDownRoundedIcon from '@mui/icons-material/TrendingDownRounded';
import TrendingFlatRoundedIcon from '@mui/icons-material/TrendingFlatRounded';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import type { Kpi } from '../../api/types';
import { CountUp, InfoTip } from '../../components/Primitives';
import { fmtDelta } from '../../lib/format';

export interface KpiDef {
  key: string;
  label: string;
  info?: string;
  /** For risk metrics an increase is bad (warm color); for activity metrics it's neutral. */
  risk?: boolean;
  onClick?: () => void;
}

export function KpiCard({ def, kpi, index }: { def: KpiDef; kpi?: Kpi; index: number }) {
  const t = useTheme().tokens;
  const delta = kpi ? fmtDelta(kpi.value, kpi.previous) : null;
  const deltaColor = !delta || delta.dir === 'flat' || !def.risk
    ? t.textSecondary
    : delta.dir === 'up' ? t.severity.high.fg : t.success;
  const Icon = delta?.dir === 'down' ? TrendingDownRoundedIcon : delta?.dir === 'flat' ? TrendingFlatRoundedIcon : TrendingUpRoundedIcon;
  const sparkColor = def.risk && kpi && kpi.value > 0 ? t.accent : t.textTertiary;

  return (
    <Card sx={{
      animation: `am-fade-up 420ms ${index * 45}ms both cubic-bezier(0.05, 0.7, 0.1, 1)`,
      transition: 'border-color 150ms, transform 250ms cubic-bezier(0.2,0,0,1)',
      '&:hover': def.onClick ? { borderColor: 'divider', transform: 'translateY(-1px)' } : undefined,
      '&:hover .kpi-spark': { opacity: 1 },
    }}>
      <CardActionArea onClick={def.onClick} disabled={!def.onClick} sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start' }}>
        <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center' }}>
          {def.label}{def.info && <InfoTip title={def.info} />}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end', mt: 1, width: '100%' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
              {kpi ? <CountUp value={kpi.value} /> : <Skeleton width={60} />}
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 1, minHeight: 18 }}>
              {delta ? (
                <>
                  <Icon sx={{ fontSize: 15, color: deltaColor }} />
                  <Typography variant="caption" sx={{ color: deltaColor, fontWeight: 600 }}>{delta.label}</Typography>
                  <Typography variant="caption" noWrap>past period</Typography>
                </>
              ) : <Skeleton width={120} />}
            </Stack>
          </Box>
          {kpi && kpi.series.length > 1 && (
            <Box className="kpi-spark" sx={{ width: 72, height: 32, flexShrink: 0, opacity: 0.75, transition: 'opacity 200ms' }} aria-hidden>
              <SparkLineChart data={kpi.series} height={32} width={72} curve="natural" area color={sparkColor} />
            </Box>
          )}
        </Stack>
      </CardActionArea>
    </Card>
  );
}
