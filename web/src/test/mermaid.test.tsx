import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { MemoryRouter } from 'react-router-dom';
import { buildTheme } from '../theme/theme';
import { Markdown } from '../components/Markdown';

const renderMock = vi.fn(async (_id: string, src: string) => {
  if (src.includes('broken')) throw new Error('Parse error on line 1');
  return { svg: `<svg data-testid="mermaid-svg"><text>${src.split('\n')[0]}</text></svg>` };
});
const initializeMock = vi.fn();
vi.mock('mermaid', () => ({ default: { initialize: initializeMock, render: renderMock } }));

const md = (text: string) => render(
  <ThemeProvider theme={buildTheme('dark')}><MemoryRouter><Markdown>{text}</Markdown></MemoryRouter></ThemeProvider>,
);

describe('Markdown mermaid blocks', () => {
  it('renders ```mermaid fences as diagrams instead of code', async () => {
    const { container } = md('Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```ts\nconst x = 1;\n```');
    await waitFor(() => expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument());
    expect(renderMock).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-diagram-\d+$/), 'flowchart LR\n  A --> B');
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark', securityLevel: 'strict' }));
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(container.querySelector('pre')?.textContent).toContain('const x = 1;');
  });

  it('falls back to the source when the diagram fails to parse', async () => {
    md('```mermaid\nbroken diagram\n```');
    expect(await screen.findByText(/Diagram could not be rendered: Parse error on line 1/)).toBeInTheDocument();
    expect(screen.getByText('broken diagram')).toBeInTheDocument();
  });

  it('opens the diagram full size in a dialog', async () => {
    md('```mermaid\nflowchart TB\n  X --> Y\n```');
    fireEvent.click(await screen.findByRole('button', { name: 'Expand diagram' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('mermaid-svg')).toBeInTheDocument();
  });

  it('keeps SVG geometry out of reduced-motion transitions (mermaid measures with getBBox)', () => {
    const overrides = buildTheme('dark').components?.MuiCssBaseline?.styleOverrides as Record<string, Record<string, unknown>>;
    expect(overrides['@media (prefers-reduced-motion: reduce)']['svg *']).toEqual({ transitionProperty: 'none !important' });
  });
});
