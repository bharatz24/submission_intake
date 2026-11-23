// External link helpers: NPPES registry pages, Gmail messages, and auto-linking NPIs / emails in free text.
import { GMAIL_MESSAGE_URL, NPI_REGISTRY_URL } from '../constants';

export function npiRegistryUrl(npi: string): string {
  return `${NPI_REGISTRY_URL}${npi}`;
}

/** Opens the message in the reviewer's first signed-in Gmail account. */
export function gmailMessageUrl(gmailMessageId: string): string {
  return `${GMAIL_MESSAGE_URL}${gmailMessageId}`;
}

/** NPI check digit: Luhn over the 9-digit base prefixed with the 80840 health-industry issuer. */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  let sum = 24; // contribution of the doubled "80840" prefix
  for (let i = 0; i < 9; i++) {
    let d = Number(npi[8 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

export interface TextSegment {
  text: string;
  href?: string;
}

// Emails, or a standalone 10-digit run (not part of a longer number, phone, or ID with dashes).
const LINK_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(?<![\d-])(\d{10})(?![\d-])/g;

/**
 * Splits text into plain and linked segments. 10-digit numbers are linked only when they pass the
 * NPI check digit, so most phone numbers and account numbers stay plain.
 */
export function splitLinks(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const [match, email, npi] = m;
    const href = email ? `mailto:${email}` : npi && isValidNpi(npi) ? npiRegistryUrl(npi) : undefined;
    if (!href) continue;
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: match, href });
    last = start + match.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** remark plugin: links NPIs (and any emails GFM missed) in markdown text, leaving links and code alone. */
export function remarkLinkify() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text' || !child.value) {
        walk(child);
        return [child];
      }
      const parts = splitLinks(child.value);
      if (parts.length === 1 && !parts[0]?.href) return [child];
      return parts.map((p) =>
        p.href
          ? { type: 'link', url: p.href, children: [{ type: 'text', value: p.text }] }
          : { type: 'text', value: p.text },
      );
    });
  };
  return (tree: MdNode) => walk(tree);
}
