import type { ReactNode } from 'react';
import { Box, Link as MuiLink, Tooltip } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { Link as RouterLink } from 'react-router-dom';
import { rehypeHeadingIds, type ResolvedLink } from '../lib/docs';
import { MermaidDiagram } from './MermaidDiagram';

/** Typography for rendered markdown (shared by the conversation timeline, incidents and chat). */
export const markdownSx = {
  fontSize: 13.5, lineHeight: 1.65, wordBreak: 'break-word',
  '& > :first-of-type': { mt: 0 }, '& > :last-child': { mb: 0 },
  '& p': { my: 1 }, '& ul, & ol': { my: 1, pl: 3 }, '& li': { my: 0.25 },
  '& h1, & h2, & h3, & h4': { fontSize: 14.5, fontWeight: 600, mt: 2, mb: 1 },
  '& code': { fontSize: 12, px: 0.6, py: 0.15, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' },
  '& pre': { p: 1.5, borderRadius: 2, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider', overflow: 'auto', fontSize: 12 },
  '& pre code': { p: 0, border: 0, bgcolor: 'transparent' },
  '& table': { borderCollapse: 'collapse', fontSize: 12.5, my: 1, display: 'block', overflowX: 'auto' },
  '& th, & td': { border: '1px solid', borderColor: 'divider', px: 1, py: 0.5 },
  '& a': { color: 'primary.main' },
  '& blockquote': { m: 0, pl: 1.5, borderLeft: '3px solid', borderColor: 'divider', color: 'text.secondary' },
};

function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text') return n.value ?? '';
  return (n.children ?? []).map(hastText).join('');
}

function defaultResolve(href: string): ResolvedLink {
  return href.startsWith('/') || href.startsWith('#') ? { kind: 'internal', to: href } : { kind: 'external', href };
}

/**
 * Sanitised GitHub-flavoured markdown; in-app links (`/…`, `#…`) navigate with the router.
 * `resolveLink` rewrites links (e.g. relative links between docs); `headingIds` adds GitHub-style
 * heading ids so `#anchor` links work.
 */
export function Markdown({ children, sx, resolveLink, headingIds }: {
  children: string; sx?: object; resolveLink?: (href: string) => ResolvedLink; headingIds?: boolean;
}) {
  return (
    <Box sx={{ ...markdownSx, ...sx }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={headingIds ? [rehypeSanitize, rehypeHeadingIds] : [rehypeSanitize]}
        components={{
          pre: ({ node, children: c }) => {
            const code = node?.children[0];
            const cls = code?.type === 'element' && code.tagName === 'code' ? code.properties.className : undefined;
            if (Array.isArray(cls) && cls.includes('language-mermaid')) {
              return <MermaidDiagram source={hastText(code)} />;
            }
            return <pre>{c}</pre>;
          },
          a:  ({ href, children: c }: { href?: string; children?: ReactNode }) => {
            const r = href ? (resolveLink ?? defaultResolve)(href) : null;
            if (!r) return <>{c}</>;
            if (r.kind === 'internal') return <MuiLink component={RouterLink} to={r.to}>{c}</MuiLink>;
            if (r.kind === 'file') {
              return (
                <Tooltip title={`Repository file: ${r.path}`}>
                  <Box component="span" sx={{ borderBottom: '1px dotted', borderColor: 'text.disabled', cursor: 'help' }}>{c}</Box>
                </Tooltip>
              );
            }
            return <MuiLink href={r.href} target="_blank" rel="noopener noreferrer">{c}</MuiLink>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}
