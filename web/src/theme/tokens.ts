export type Mode = 'light' | 'dark';

export interface SeverityTone { fg: string; bg: string; border: string }

export interface Tokens {
  bg: string;
  surface: string;
  container: string;
  containerHigh: string;
  outline: string;
  outlineStrong: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentRgb: string;
  success: string;
  danger: string;
  mono: string;
  severity: Record<'critical' | 'high' | 'medium' | 'low' | 'info', SeverityTone>;
  channel: Record<'log' | 'hook' | 'poll', SeverityTone>;
  category: Record<string, string>;
  heatText: string;
}

const MONO = '"JetBrains Mono", "SF Mono", Consolas, monospace';

export const darkTokens: Tokens = {
  bg: '#0B0B0D',
  surface: '#131316',
  container: '#18181B',
  containerHigh: '#1F1F23',
  outline: '#26262B',
  outlineStrong: '#3A3A41',
  text: '#EDEDEF',
  textSecondary: '#A1A1AA',
  textTertiary: '#71717A',
  accent: '#F97316',
  accentRgb: '249, 115, 22',
  success: '#4ADE80',
  danger: '#F87171',
  mono: MONO,
  severity: {
    critical: { fg: '#FCA5A5', bg: 'rgba(239, 68, 68, 0.16)', border: 'rgba(239, 68, 68, 0.38)' },
    high:     { fg: '#FDBA74', bg: 'rgba(249, 115, 22, 0.16)', border: 'rgba(249, 115, 22, 0.38)' },
    medium:   { fg: '#FDE047', bg: 'rgba(234, 179, 8, 0.13)',  border: 'rgba(234, 179, 8, 0.32)' },
    low:      { fg: '#93C5FD', bg: 'rgba(59, 130, 246, 0.16)', border: 'rgba(59, 130, 246, 0.38)' },
    info:     { fg: '#A1A1AA', bg: 'rgba(161, 161, 170, 0.10)', border: 'rgba(161, 161, 170, 0.24)' },
  },
  channel: {
    log:  { fg: '#C4B5FD', bg: 'rgba(139, 92, 246, 0.14)', border: 'rgba(139, 92, 246, 0.34)' },
    hook: { fg: '#67E8F9', bg: 'rgba(6, 182, 212, 0.13)',  border: 'rgba(6, 182, 212, 0.32)' },
    poll: { fg: '#A1A1AA', bg: 'rgba(161, 161, 170, 0.10)', border: 'rgba(161, 161, 170, 0.24)' },
  },
  category: { READ: '#93C5FD', WRITE: '#FDBA74', EXEC: '#F9A8D4', NETWORK: '#67E8F9', MCP: '#C4B5FD', AGENT: '#86EFAC', OTHER: '#A1A1AA' },
  heatText: '#FFF7ED',
};

export const lightTokens: Tokens = {
  bg: '#F7F7F8',
  surface: '#FFFFFF',
  container: '#F4F4F5',
  containerHigh: '#EDEDEF',
  outline: '#E4E4E7',
  outlineStrong: '#D4D4D8',
  text: '#18181B',
  textSecondary: '#52525B',
  textTertiary: '#71717A',
  accent: '#EA580C',
  accentRgb: '234, 88, 12',
  success: '#15803D',
  danger: '#B91C1C',
  mono: MONO,
  severity: {
    critical: { fg: '#B91C1C', bg: 'rgba(239, 68, 68, 0.10)', border: 'rgba(239, 68, 68, 0.30)' },
    high:     { fg: '#C2410C', bg: 'rgba(249, 115, 22, 0.10)', border: 'rgba(249, 115, 22, 0.30)' },
    medium:   { fg: '#A16207', bg: 'rgba(234, 179, 8, 0.12)',  border: 'rgba(202, 138, 4, 0.30)' },
    low:      { fg: '#1D4ED8', bg: 'rgba(59, 130, 246, 0.10)', border: 'rgba(59, 130, 246, 0.30)' },
    info:     { fg: '#52525B', bg: 'rgba(113, 113, 122, 0.08)', border: 'rgba(113, 113, 122, 0.22)' },
  },
  channel: {
    log:  { fg: '#6D28D9', bg: 'rgba(139, 92, 246, 0.10)', border: 'rgba(139, 92, 246, 0.28)' },
    hook: { fg: '#0E7490', bg: 'rgba(6, 182, 212, 0.10)',  border: 'rgba(6, 182, 212, 0.30)' },
    poll: { fg: '#52525B', bg: 'rgba(113, 113, 122, 0.08)', border: 'rgba(113, 113, 122, 0.22)' },
  },
  category: { READ: '#1D4ED8', WRITE: '#C2410C', EXEC: '#BE185D', NETWORK: '#0E7490', MCP: '#6D28D9', AGENT: '#15803D', OTHER: '#52525B' },
  heatText: '#FFFFFF',
};

/** MD3 motion tokens. */
export const motion = {
  emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
  decelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  accelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  short: 150,
  medium: 250,
  long: 400,
};
