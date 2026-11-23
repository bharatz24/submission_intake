// Links in text that came from outside (model output built from untrusted email text, email bodies). Light on purpose:
// the email card uses ExternalAnchor without loading the markdown renderer (components/MarkdownContent.tsx).
import { Typography } from '@mui/material';
import type { ReactNode } from 'react';

/** Props for a link that opens in a new tab without giving the new page a handle on this one. */
export const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' };

// Markdown here is model output built from untrusted email text (P2-12): only https: and mailto: links are kept, every
// link shows where it goes, and images are never loaded (no tracking pixels, no data exfiltration through image URLs).
const SAFE_URL = /^(https:\/\/|mailto:)/i;

/** react-markdown urlTransform: anything but https:/mailto: (javascript:, data:, http:, relative paths) becomes ''. */
export function safeMarkdownUrl(url: string): string {
  return SAFE_URL.test(url.trim()) ? url.trim() : '';
}

const textOf = (node: ReactNode): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : '';

export function ExternalAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <>{children}</>;
  const destination = href.replace(/^mailto:/i, '');
  const label = textOf(children).trim();
  // Text that differs from its target shows the real destination next to it, so a link cannot pose as another site.
  const showTarget = label !== href && label !== destination;
  return (
    <>
      <a href={href} title={href} {...(/^https:/i.test(href) ? NEW_TAB : {})}>
        {children}
      </a>
      {showTarget && (
        <Typography component="span" variant="caption" color="text.secondary">
          {' '}
          ({destination})
        </Typography>
      )}
    </>
  );
}
