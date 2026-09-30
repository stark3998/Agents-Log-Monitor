import { alpha, createTheme, type Theme } from '@mui/material/styles';
import type {} from '@mui/x-data-grid/themeAugmentation';
import { darkTokens, lightTokens, motion, type Mode, type Tokens } from './tokens';

declare module '@mui/material/styles' {
  interface Theme { tokens: Tokens }
  interface ThemeOptions { tokens?: Tokens }
}

export function buildTheme(mode: Mode): Theme {
  const t = mode === 'dark' ? darkTokens : lightTokens;
  return createTheme({
    tokens: t,
    palette: {
      mode,
      primary: { main: t.accent, contrastText: '#fff' },
      secondary: { main: mode === 'dark' ? '#A78BFA' : '#7C3AED' },
      error: { main: t.danger },
      success: { main: t.success },
      background: { default: t.bg, paper: t.surface },
      text: { primary: t.text, secondary: t.textSecondary, disabled: t.textTertiary },
      divider: t.outline,
      action: {
        hover: alpha(t.text, mode === 'dark' ? 0.05 : 0.04),
        selected: alpha(t.accent, mode === 'dark' ? 0.12 : 0.08),
        focus: alpha(t.accent, 0.16),
      },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: 13,
      h4: { fontSize: 22, fontWeight: 650, letterSpacing: '-0.01em' },
      h5: { fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' },
      h6: { fontSize: 15, fontWeight: 600 },
      subtitle1: { fontSize: 14, fontWeight: 600 },
      subtitle2: { fontSize: 13, fontWeight: 600 },
      body1: { fontSize: 13.5, lineHeight: 1.6 },
      body2: { fontSize: 12.5, lineHeight: 1.5 },
      caption: { fontSize: 11.5, color: t.textTertiary },
      overline: { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em' },
      button: { textTransform: 'none', fontWeight: 500 },
    },
    transitions: {
      easing: { easeInOut: motion.emphasized, easeOut: motion.decelerate, easeIn: motion.accelerate, sharp: motion.emphasized },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: { colorScheme: mode },
          ':root': { '--am-mono': t.mono },
          body: {
            backgroundColor: t.bg,
            transition: `background-color ${motion.medium}ms ${motion.emphasized}, color ${motion.medium}ms ${motion.emphasized}`,
            WebkitFontSmoothing: 'antialiased',
          },
          '*::-webkit-scrollbar': { width: 10, height: 10 },
          '*::-webkit-scrollbar-thumb': { background: t.outlineStrong, borderRadius: 8, border: `2px solid ${t.bg}` },
          '*::-webkit-scrollbar-track': { background: 'transparent' },
          '::selection': { background: alpha(t.accent, 0.3) },
          mark: { background: alpha(t.accent, 0.35), color: 'inherit', borderRadius: 3, padding: '0 1px' },
          'mark.current': { background: t.accent, color: '#fff' },
          code: { fontFamily: t.mono },
          '@keyframes am-fade-up': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
          '@keyframes am-fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
          '@keyframes am-scale-in': { from: { opacity: 0, transform: 'scale(0.92)' }, to: { opacity: 1, transform: 'none' } },
          '@keyframes am-pulse': {
            '0%': { boxShadow: `0 0 0 0 ${alpha(t.success, 0.55)}` },
            '70%': { boxShadow: `0 0 0 6px ${alpha(t.success, 0)}` },
            '100%': { boxShadow: `0 0 0 0 ${alpha(t.success, 0)}` },
          },
          '@keyframes am-row-flash': { from: { backgroundColor: alpha(t.accent, 0.14) }, to: { backgroundColor: 'transparent' } },
          '@keyframes am-match': { '0%': { boxShadow: `0 0 0 0 ${alpha(t.accent, 0.6)}` }, '100%': { boxShadow: `0 0 0 8px ${alpha(t.accent, 0)}` } },
          '@media (prefers-reduced-motion: reduce)': {
            '*, *::before, *::after': { animationDuration: '0.01ms !important', animationIterationCount: '1 !important', transitionDuration: '0.01ms !important', scrollBehavior: 'auto !important' },
                        // A non-zero duration with the default `transition-property: all` makes SVG geometry
                        // (e.g. foreignObject width) lag behind attribute changes, which breaks mermaid's getBBox layout.
                        'svg *': { transitionProperty: 'none !important' },
                      },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiCard: {
        defaultProps: { variant: 'outlined' },
        styleOverrides: { root: { borderRadius: 12, borderColor: t.outline, backgroundColor: t.surface } },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 8, fontWeight: 500, paddingInline: 12 },
          outlined: { borderColor: t.outline, color: t.text, '&:hover': { borderColor: t.outlineStrong, backgroundColor: alpha(t.text, 0.04) } },
          sizeSmall: { fontSize: 12.5, paddingBlock: 4 },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: { borderRadius: 8, color: t.textSecondary, transition: `background-color ${motion.short}ms, color ${motion.short}ms, transform ${motion.medium}ms ${motion.emphasized}`, '&:hover': { color: t.text } },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 6, fontWeight: 500 },
          sizeSmall: { height: 22, fontSize: 11.5, '& .MuiChip-label': { paddingInline: 7 } },
          outlined: { borderColor: t.outline },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: { height: 2, borderRadius: 2, backgroundColor: t.text, transition: `all ${motion.medium}ms ${motion.emphasized}` },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 40, minWidth: 0, padding: '0 2px', marginRight: 20, fontSize: 13.5, fontWeight: 500,
            color: t.textSecondary, transition: `color ${motion.short}ms`,
            '&.Mui-selected': { color: t.text },
            '&:hover': { color: t.text },
          },
        },
      },
      MuiTooltip: {
        defaultProps: { arrow: false, enterDelay: 300 },
        styleOverrides: {
          tooltip: { backgroundColor: t.containerHigh, color: t.text, border: `1px solid ${t.outline}`, fontSize: 12, fontWeight: 400, padding: '6px 10px', boxShadow: '0 8px 24px rgba(0,0,0,.25)', maxWidth: 360 },
        },
      },
      MuiMenu: {
        styleOverrides: { paper: { border: `1px solid ${t.outline}`, backgroundColor: t.container, boxShadow: '0 12px 32px rgba(0,0,0,.28)' } },
      },
      MuiPopover: {
        styleOverrides: { paper: { border: `1px solid ${t.outline}`, backgroundColor: t.container, boxShadow: '0 12px 32px rgba(0,0,0,.28)' } },
      },
      MuiMenuItem: { styleOverrides: { root: { fontSize: 13, minHeight: 34, borderRadius: 6, marginInline: 4 } } },
      MuiDialog: { styleOverrides: { paper: { border: `1px solid ${t.outline}`, backgroundColor: t.surface, borderRadius: 14 } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 8, backgroundColor: t.surface, fontSize: 13,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: t.outline, transition: `border-color ${motion.short}ms` },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: t.outlineStrong },
            '& .MuiInputBase-inputSizeSmall': { paddingBlock: 7 },
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: { textTransform: 'none', fontSize: 12.5, paddingBlock: 4, paddingInline: 10, borderColor: t.outline, color: t.textSecondary, '&.Mui-selected': { color: t.text, backgroundColor: t.containerHigh } },
        },
      },
      MuiSkeleton: { styleOverrides: { root: { backgroundColor: alpha(t.text, 0.07) } } },
      MuiDataGrid: {
        styleOverrides: {
          root: {
            border: 'none', fontSize: 12.5, '--DataGrid-rowBorderColor': t.outline,
            '--DataGrid-containerBackground': t.container, '--DataGrid-t-color-background-base': t.surface,
            '& .MuiDataGrid-columnHeaders': { borderBottom: `1px solid ${t.outline}` },
            '& .MuiDataGrid-columnHeader': { backgroundColor: t.container },
            '& .MuiDataGrid-columnHeaderTitle': { fontWeight: 500, color: t.textSecondary, fontSize: 12 },
            '& .MuiDataGrid-columnSeparator': { color: t.outline },
            '& .MuiDataGrid-cell': { borderColor: t.outline, display: 'flex', alignItems: 'center' },
            '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within, & .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
            '& .MuiDataGrid-row': { cursor: 'pointer', transition: `background-color ${motion.short}ms` },
            '& .MuiDataGrid-row:hover': { backgroundColor: alpha(t.text, mode === 'dark' ? 0.035 : 0.03) },
            '& .MuiDataGrid-row.Mui-selected, & .MuiDataGrid-row.Mui-selected:hover': { backgroundColor: alpha(t.accent, 0.1) },
            '& .MuiDataGrid-row.am-flash': { animation: `am-row-flash 1.4s ${motion.decelerate}` },
            '& .MuiDataGrid-footerContainer': { borderColor: t.outline, minHeight: 40 },
            '& .MuiDataGrid-overlay': { backgroundColor: 'transparent' },
          },
        },
      },
    },
  });
}
