import type { ReactNode } from 'react';
import { Box, Link as MuiLink } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { Link as RouterLink } from 'react-router-dom';

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

/** Sanitised GitHub-flavoured markdown; in-app links (`/…`) navigate with the router. */
export function Markdown({ children, sx }: { children: string; sx?: object }) {
  return (
    <Box sx={{ ...markdownSx, ...sx }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children: c }: { href?: string; children?: ReactNode }) => (href && href.startsWith('/')
            ? <MuiLink component={RouterLink} to={href}>{c}</MuiLink>
            : <MuiLink href={href} target="_blank" rel="noopener noreferrer">{c}</MuiLink>),
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}
