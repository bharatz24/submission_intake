import { normalizeForMatch, quoteAppearsIn } from './evidence.js';
import type { Analysis, Synthesis } from './reportSchemas.js';

/**
 * Grounding check for LLM report and chat text (llm-integration skill). Evidence there is paraphrased with its source
 * ("Loss runs: 2021 closed, paid $175,000 (loss_runs.pdf)"), so instead of matching a quote we check that the cited
 * source exists and that every concrete value (amount, date, NPI, percent, quoted fragment) appears in the text Claude
 * was given. Grading is post-hoc and never fails a report.
 */

export type Verdict = 'verified' | 'unverified' | 'unchecked';
/** One piece of text Claude saw; label is a filename or a source name ('email body', 'derived coverage', 'synthesis'). */
export interface GroundingSource {
  label: string;
  text: string;
}
export interface GroundingItem {
  path: string;
  text: string;
  verdict: Verdict;
  missing: string[];
}
/** `items` holds the unverified items only. */
export interface Grounding {
  checked: number;
  verified: number;
  unverified: number;
  items: GroundingItem[];
}

/** Quoted fragments shorter than this are too generic to be worth checking. */
const MIN_QUOTED = 4;
/** Bare numbers need this many digits (or thousands separators) to count as a concrete value. */
const MIN_BARE_DIGITS = 5;
const NPI_DIGITS = 10;
const SOURCE_PREFIX = 'source: ';

const FILE_EXT = 'pdf|docx?|xlsx?|csv|txt|eml|msg|png|jpe?g|tiff?';
const FILENAME = new RegExp(`\\.(${FILE_EXT})$`, 'i');
const EMBEDDED_FILENAME = new RegExp(`[\\w\\-.]+\\.(?:${FILE_EXT})\\b`, 'gi');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAME = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DATE_PATTERNS: { re: RegExp; parts: (m: RegExpMatchArray) => [string, string, string] }[] = [
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, parts: (m) => [group(m, 1), group(m, 2), group(m, 3)] },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, parts: (m) => [group(m, 3), group(m, 1), group(m, 2)] },
  {
    re: new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'),
    parts: (m) => [group(m, 3), String(MONTHS.indexOf(group(m, 1).toLowerCase()) + 1), group(m, 2)],
  },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME},?\\s+(\\d{4})\\b`, 'gi'),
    parts: (m) => [group(m, 3), String(MONTHS.indexOf(group(m, 2).toLowerCase()) + 1), group(m, 1)],
  },
];
const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(mm|million|thousand|k|m)\b)?/gi;
const BARE_NUMBER = /(?<![\d.$,])(\d{1,3}(?:,\d{3})+|\d{5,})(?:\.\d+)?(?!\d|,\d)/g;
const PERCENT = /(?<![\d.])(\d+(?:\.\d+)?)\s?%/g;
const QUOTED = /["“]([^"”]+)["”]/g;

/** Capture group `i` of a match, empty when it did not participate. */
const group = (m: RegExpMatchArray, i: number): string => m[i] ?? '';
const pad2 = (n: string) => n.padStart(2, '0');

/** Every date in `text`, as YYYY-MM-DD; matched spans are blanked out of `rest` so their digits are not read as numbers. */
function extractDates(text: string): { dates: string[]; rest: string } {
  const dates: string[] = [];
  let rest = text;
  for (const { re, parts } of DATE_PATTERNS) {
    rest = rest.replace(re, (...args) => {
      const [y, m, d] = parts(args as unknown as RegExpMatchArray);
      dates.push(`${y}-${pad2(m)}-${pad2(d)}`);
      return ' ';
    });
  }
  return { dates, rest };
}

/** "175,000.50" → "175000.5" after expanding a K/M/MM/thousand/million suffix; trailing fractional zeros are dropped. */
function canonicalNumber(raw: string, suffix?: string): string {
  let n = Number(raw.replace(/,/g, ''));
  if (suffix) n *= /^(k|thousand)$/i.test(suffix) ? 1_000 : 1_000_000;
  return String(Math.round(n * 100) / 100);
}

/**
 * The values a claim commits to: money as plain digits ("$175K" → "175000"), dates as YYYY-MM-DD, 10-digit NPIs,
 * percents ("12.5%") and "double-quoted" fragments of 4+ characters. Order of first appearance, no duplicates.
 */
export function concreteTokens(text: string): string[] {
  const tokens = new Set<string>();
  const { dates, rest } = extractDates(text);
  dates.forEach((d) => tokens.add(d));
  for (const m of rest.matchAll(QUOTED)) {
    const quoted = group(m, 1).trim();
    if (quoted.length >= MIN_QUOTED) tokens.add(quoted);
  }
  for (const m of rest.matchAll(PERCENT)) tokens.add(`${canonicalNumber(group(m, 1))}%`);
  for (const m of rest.matchAll(MONEY)) tokens.add(canonicalNumber(group(m, 1), m[2]));
  // money spans are blanked so the engine cannot resume mid-number ("$1,000,000" would otherwise yield a stray "0")
  for (const m of rest.replace(MONEY, ' ').matchAll(BARE_NUMBER)) {
    const digits = group(m, 1).replace(/,/g, '');
    if (digits.length === NPI_DIGITS || digits.length >= MIN_BARE_DIGITS || group(m, 1).includes(',')) {
      tokens.add(canonicalNumber(m[0]));
    }
  }
  return [...tokens];
}

/** A source prepared for matching: normalised text, thousands separators removed, dates canonicalised. */
interface Prepared {
  label: string;
  text: string;
  plain: string;
  dates: Set<string>;
}

const prepare = (s: GroundingSource): Prepared => {
  const text = normalizeForMatch(s.text);
  const { dates, rest } = extractDates(text);
  return {
    label: s.label,
    text,
    plain: `${rest} ${dates.join(' ')}`
      .replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
      .replace(/\$/g, '')
      .replace(/(\d+)\.(\d+)(?!\d)/g, (_, whole: string, frac: string) => {
        const kept = frac.replace(/0+$/, '');
        return kept ? `${whole}.${kept}` : whole;
      }),
    dates: new Set(dates),
  };
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `token` appears in any of `sources`; numbers must not match inside a longer number (175000 vs 1750000). */
function tokenFound(token: string, sources: Prepared[]): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return sources.some((s) => s.dates.has(token));
  if (/^[\d.]+%?$/.test(token)) {
    const re = new RegExp(
      `(?<![\\d.])${escapeRe(token.replace(/%$/, ''))}${token.endsWith('%') ? '\\s?%' : '(?![\\d]|\\.\\d)'}`,
    );
    return sources.some((s) => re.test(s.plain));
  }
  return sources.some((s) => quoteAppearsIn(token, s.text));
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** `name` ends `label` at a path or word boundary ("Acme loss_runs.pdf" yes, "xloss_runs.pdf" no). */
const endsAtBoundary = (label: string, name: string) =>
  name.length > 0 &&
  label.endsWith(name) &&
  (label.length === name.length || /[\\/\s]/.test(label[label.length - name.length - 1] ?? ''));
const findSource = (label: string, corpus: Prepared[]) =>
  corpus.find((s) => same(s.label, label)) ??
  corpus.find((s) => endsAtBoundary(s.label.toLowerCase(), label.trim().toLowerCase()));

/** Citations to check: the cited string whole when it names a source, else split on `,`/`;`/"and"; else filenames in the text. */
function citedParts(citedSource: string | null, text: string, corpus: Prepared[]): string[] {
  const whole = citedSource?.trim();
  if (!whole) return text.match(EMBEDDED_FILENAME) ?? [];
  if (findSource(whole, corpus)) return [whole];
  return whole
    .split(/\s*(?:[,;]|\sand\s)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Grades one claim. A cited filename must be in the corpus and the values are checked in it; any other citation is
 * checked against the source of that name when there is one, else the whole corpus. With no citation, filenames named
 * in the text count as citations. No concrete values and nothing to look up: unchecked.
 */
export function gradeClaim(
  path: string,
  text: string,
  citedSource: string | null,
  corpus: GroundingSource[],
): GroundingItem {
  const prepared = corpus.map(prepare);
  const cited = citedParts(citedSource, text, prepared);
  const named = cited.filter((c) => FILENAME.test(c));
  const missingSources = named.filter((c) => !findSource(c, prepared));
  if (missingSources.length) {
    return { path, text, verdict: 'unverified', missing: missingSources.map((c) => `${SOURCE_PREFIX}${c}`) };
  }

  const scoped = cited.map((c) => findSource(c, prepared)).filter((s): s is Prepared => s !== undefined);
  const tokens = concreteTokens(text);
  if (!tokens.length) return { path, text, verdict: named.length ? 'verified' : 'unchecked', missing: [] };

  const missing = tokens.filter((t) => !tokenFound(t, scoped.length ? scoped : prepared));
  return { path, text, verdict: missing.length ? 'unverified' : 'verified', missing };
}

function summarise(items: GroundingItem[]): Grounding {
  const checked = items.filter((i) => i.verdict !== 'unchecked');
  const unverified = checked.filter((i) => i.verdict === 'unverified');
  return {
    checked: checked.length,
    verified: checked.length - unverified.length,
    unverified: unverified.length,
    items: unverified,
  };
}

/** Grades the Synthesis' profile extras, extracted facts and conflicts against what its prompt contained. */
export function gradeSynthesis(s: Synthesis, corpus: GroundingSource[]): Grounding {
  const items: GroundingItem[] = [];
  s.applicantProfile.other.forEach((o, i) =>
    items.push(gradeClaim(`applicantProfile.other[${i}]`, o.text, o.source, corpus)),
  );
  s.extractedFacts.forEach((f, i) => items.push(gradeClaim(`extractedFacts[${i}]`, f.text, f.source, corpus)));
  s.conflicts.forEach((c, i) =>
    items.push(gradeClaim(`conflicts[${i}].sources`, `${c.description} (${c.sources.join(', ')})`, null, corpus)),
  );
  return summarise(items);
}

/** Grades every Finding.evidence string; the corpus should include the Synthesis it was based on. */
export function gradeAnalysis(a: Analysis, corpus: GroundingSource[]): Grounding {
  const items: GroundingItem[] = [];
  for (const key of ['riskIndicators', 'inconsistencies', 'potentialConcerns'] as const) {
    a[key].forEach((finding, i) =>
      finding.evidence.forEach((e, j) => items.push(gradeClaim(`${key}[${i}].evidence[${j}]`, e, null, corpus))),
    );
  }
  return summarise(items);
}

/** Grades each sentence or list item of a chat answer; sentences without concrete values are not checked. */
export function gradeChatAnswer(answer: string, corpus: GroundingSource[]): Grounding {
  const sentences = answer
    .split(/\n+/)
    .flatMap((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“$])/))
    .map((s) => s.trim())
    .filter(Boolean);
  return summarise(sentences.map((text, i) => gradeClaim(`answer[${i}]`, text, null, corpus)));
}
