import { Box, Tooltip } from '@mui/material';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import type { ReactNode } from 'react';

interface AgentStyle { bg: string; fg: string; icon: (size: number) => ReactNode }

const ClaudeMark = (size: number) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      {[0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map(a => (
        <line key={a} x1="12" y1="3.5" x2="12" y2="20.5" transform={`rotate(${a} 12 12)`} />
      ))}
    </g>
  </svg>
);

const CopilotMark = (size: number) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
    <path d="M4 13.5c0-2.2.6-3.4 1.6-4.3C6.2 6.4 8.4 5 12 5s5.8 1.4 6.4 4.2c1 .9 1.6 2.1 1.6 4.3 0 3.3-3.4 5.5-8 5.5s-8-2.2-8-5.5Z" />
    <rect x="7" y="11.2" width="3.6" height="3.4" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="13.4" y="11.2" width="3.6" height="3.4" rx="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const STYLES: Record<string, AgentStyle> = {
  'claude-code': { bg: 'rgba(217, 119, 87, 0.16)', fg: '#E0825F', icon: ClaudeMark },
  'copilot-cli': { bg: 'rgba(139, 92, 246, 0.18)', fg: '#A78BFA', icon: CopilotMark },
  'foundry': { bg: 'rgba(59, 130, 246, 0.16)', fg: '#60A5FA', icon: s => <HubOutlinedIcon sx={{ fontSize: s }} /> },
  'copilot-studio': { bg: 'rgba(20, 184, 166, 0.16)', fg: '#2DD4BF', icon: s => <ForumOutlinedIcon sx={{ fontSize: s }} /> },
};

export function agentStyle(key: string): AgentStyle {
  return STYLES[key] ?? { bg: 'rgba(161,161,170,.14)', fg: '#A1A1AA', icon: s => <SmartToyOutlinedIcon sx={{ fontSize: s }} /> };
}

export function AgentAvatar({ agentKey, size = 28, title }: { agentKey: string; size?: number; title?: string }) {
  const st = agentStyle(agentKey);
  const box = (
    <Box
      component="span"
      sx={{
        width: size, height: size, borderRadius: size > 22 ? '8px' : '6px', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        bgcolor: st.bg, color: st.fg, border: '1px solid', borderColor: 'divider',
      }}
    >
      {st.icon(Math.round(size * 0.62))}
    </Box>
  );
  return title ? <Tooltip title={title}>{box}</Tooltip> : box;
}
