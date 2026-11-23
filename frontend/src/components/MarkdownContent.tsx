// The markdown renderer (react-markdown + remark-gfm, ~159 KB). Loaded on demand through <Markdown> in common.tsx
// (FE-05), so the sign-in page and the app shell never download it; only screens that show generated text do.
import { Box, Typography } from '@mui/material';
import type { Ref } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';

import { remarkLinkify } from '../lib/links';
import { ExternalAnchor, safeMarkdownUrl } from './ExternalAnchor';

export interface MarkdownProps {
  children: string;
  plugins?: PluggableList;
  innerRef?: Ref<HTMLDivElement>;
}

export function MarkdownContent({ children, plugins = [], innerRef }: MarkdownProps) {
  return (
    <Box
      ref={innerRef}
      sx={{
        '& mark': { bgcolor: 'surface.highlight', px: 0.25, borderRadius: 0.5 },
        fontSize: '0.875rem',
        lineHeight: 1.6,
        '& h1': { fontSize: '1.3rem', mt: 2, mb: 1 },
        '& h2': { fontSize: '1.1rem', mt: 2, mb: 1, color: 'primary.main' },
        '& h3': { fontSize: '0.95rem', mt: 1.5, mb: 0.5 },
        '& p': { my: 0.75 },
        '& ul, & ol': { pl: 3, my: 0.5 },
        '& code': {
          fontFamily: 'ui-monospace, Consolas, monospace',
          fontSize: '0.8rem',
          bgcolor: 'surface.muted',
          px: 0.5,
          borderRadius: 0.5,
        },
        '& pre': { bgcolor: 'surface.muted', p: 1.5, borderRadius: 1, overflowX: 'auto' },
        '& pre code': { bgcolor: 'transparent', p: 0 },
        '& table': { borderCollapse: 'collapse', width: '100%', my: 1, display: 'block', overflowX: 'auto' },
        '& th, & td': {
          border: '1px solid',
          borderColor: 'divider',
          px: 1,
          py: 0.5,
          textAlign: 'left',
          verticalAlign: 'top',
        },
        '& th': { bgcolor: 'surface.subtle' },
        '& blockquote': { borderLeft: '3px solid', borderColor: 'divider', m: 0, pl: 1.5, color: 'text.secondary' },
        '& a': { color: 'primary.main' },
        '& > *:first-of-type': { mt: 0 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkLinkify, ...plugins]}
        urlTransform={safeMarkdownUrl}
        skipHtml
        components={{ a: ExternalAnchor, img: BlockedImage }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

/** Images are shown as their alt text and address, never fetched. */
function BlockedImage({ alt, src }: { alt?: string; src?: string }) {
  return (
    <Typography
      component="span"
      variant="caption"
      color="text.secondary"
      title="Images in generated text are not loaded"
    >
      [image{alt ? `: ${alt}` : ''}
      {src ? ` (${src})` : ''}]
    </Typography>
  );
}
