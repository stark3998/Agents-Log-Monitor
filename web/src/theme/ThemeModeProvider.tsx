import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { buildTheme } from './theme';
import type { Mode } from './tokens';

interface ThemeModeCtx { mode: Mode; toggle: () => void }
const Ctx = createContext<ThemeModeCtx>({ mode: 'dark', toggle: () => {} });

function initialMode(): Mode {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('am-theme') : null;
  if (stored === 'light' || stored === 'dark') return stored;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const theme = useMemo(() => buildTheme(mode), [mode]);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.background = theme.tokens.bg;
  }, [mode, theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return;
    const onChange = () => { if (!localStorage.getItem('am-theme')) setMode(mq.matches ? 'light' : 'dark'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    setMode(m => {
      const next = m === 'dark' ? 'light' : 'dark';
      localStorage.setItem('am-theme', next);
      return next;
    });
  }, []);

  return (
    <Ctx.Provider value={{ mode, toggle }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </Ctx.Provider>
  );
}

export const useThemeMode = () => useContext(Ctx);
