import type { Field, SourceDoc } from './fieldExtraction.js';

/**
 * Grounding check for LLM-extracted fields (llm-integration skill): an evidence quote must actually appear in the text
 * Claude was given. A field whose quote is not found anywhere is kept, but marked unverified and its confidence capped,
 * so underwriters, reports and the quote calculator never treat a made-up quote as grounded.
 */

/** Highest confidence an unverified field keeps (below the UI's "low confidence" threshold). */
export const UNVERIFIED_CONFIDENCE_CAP = 0.4;
/** Quote fragments shorter than this (after normalising) must match a whole word ("TX" in "State: TX", not "TEXT"). */
const SHORT_FRAGMENT = 4;

/**
 * Text as compared: NFKC (no-break spaces become spaces, "…" becomes "..."), prompt escaping undone, typographic
 * quotes and dashes made plain, lower case, whitespace collapsed.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/&lt;/g, '<')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether `quote` appears in `source`. Claude may elide with "..." or "…", and the prompt had PII replaced by
 * [REDACTED-*] placeholders: each remaining fragment must appear, in order.
 */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const fragments = normalizeForMatch(quote)
    .split(/\s*(?:\.{3,}|\[redacted-[a-z]+\])\s*/)
    .map((f) => f.replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter(Boolean);
  if (!fragments.length) return false;
  const haystack = normalizeForMatch(source);
  let from = 0;
  for (const fragment of fragments) {
    const at = findFragment(haystack, fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Position of `fragment` in `haystack` at or after `from`; a short fragment only counts as a whole word. */
function findFragment(haystack: string, fragment: string, from: number): number {
  for (let at = haystack.indexOf(fragment, from); at >= 0; at = haystack.indexOf(fragment, at + 1)) {
    if (fragment.length >= SHORT_FRAGMENT) return at;
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + fragment.length])) return at;
  }
  return -1;
}

export interface VerifiedField extends Field {
  /** true: the quote was found in a source; false: not found (confidence capped); null: no quote to check. */
  evidenceVerified: boolean | null;
}

/**
 * Checks each field's quote against its cited source first, then any other source (a mis-cited label is re-attributed
 * to the source that really contains the quote).
 */
export function verifyEvidence(fields: Field[], sources: SourceDoc[]): VerifiedField[] {
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  return fields.map((f) => {
    if (!f.evidenceQuote?.trim()) return { ...f, evidenceVerified: null };
    const cited = byLabel.get(f.sourceLabel);
    if (cited && quoteAppearsIn(f.evidenceQuote, cited.text)) return { ...f, evidenceVerified: true };
    const actual = sources.find((s) => s !== cited && quoteAppearsIn(f.evidenceQuote!, s.text));
    if (actual) return { ...f, sourceLabel: actual.label, documentId: actual.documentId, evidenceVerified: true };
    return { ...f, confidence: Math.min(f.confidence, UNVERIFIED_CONFIDENCE_CAP), evidenceVerified: false };
  });
}
