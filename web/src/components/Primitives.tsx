import { useEffect, useRef, useState } from 'react';
import { Box, Tooltip } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { fmtDateTime, fmtNum, fmtRelative } from '../lib/format';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Animated number that eases from its previous value to the new one. */
export function CountUp({ value, duration = 650, format = fmtNum }: { value: number; duration?: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const from = useRef(shown);
  useEffect(() => {
    if (reducedMotion()) { setShown(value); return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(a + (value - a) * eased);
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value, duration]);
  return <>{format(shown)}</>;
}

/** Relative time that re-renders every 30s. */
export function RelativeTime({ iso }: { iso: string | null | undefined }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force(x => x + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <Tooltip title={fmtDateTime(iso)}>
      <Box component="span" sx={{ whiteSpace: 'nowrap' }}>{fmtRelative(iso)}</Box>
    </Tooltip>
  );
}

export function InfoTip({ title }: { title: string }) {
  return (
    <Tooltip title={title}>
      <InfoOutlinedIcon aria-label={title} sx={{ fontSize: 13, color: 'text.disabled', ml: 0.5, verticalAlign: '-2px', cursor: 'help' }} />
    </Tooltip>
  );
}

export function LiveDot({ on = true, size = 7 }: { on?: boolean; size?: number }) {
  return (
    <Box
      component="span"
      sx={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
        bgcolor: on ? 'success.main' : 'text.disabled',
        animation: on ? 'am-pulse 1.8s ease-out infinite' : 'none',
      }}
    />
  );
}

/** Text that truncates with an ellipsis and shows the full value in a tooltip. */
export function Ellipsis({ text, mono, sx }: { text: string | null | undefined; mono?: boolean; sx?: object }) {
  if (!text) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>;
  return (
    <Tooltip title={text} enterDelay={500}>
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontFamily: mono ? 'var(--am-mono)' : undefined, ...sx }}>
        {text}
      </Box>
    </Tooltip>
  );
}
