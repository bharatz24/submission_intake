// Email display helpers: sender parsing and splitting a plain-text body into readable parts.
import { WRAP_COL, WRAP_MIN } from '../constants';

/** "Jane Smith <jane@x.com>" → { name: 'Jane Smith', address: 'jane@x.com' }; a bare address has no name. */
export function parseAddress(raw: string): { name: string | null; address: string } {
  const m = raw.trim().match(/^"?(.*?)"?\s*<([^>]+)>$/);
  if (m?.[2]) return { name: m[1]?.trim() || null, address: m[2].trim() };
  return { name: null, address: raw.trim() };
}

export function initials(nameOrAddress: string): string {
  const words = (nameOrAddress.split('@')[0] ?? '').split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

// Where the quoted reply history starts: "On … wrote:", Outlook's "-----Original Message-----",
// a "From: …" header block, or a run of ">"-quoted lines.
const ON_WROTE = /^On .+wrote:\s*$/i;
const QUOTE_START = [
  ON_WROTE,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^From:\s.+/i,
  /^>/,
];

export type EmailBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[]; start?: number } // `start` set → ordered list
  | { type: 'fields'; items: { label: string; value: string }[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' };

export interface EmailBody {
  blocks: EmailBlock[];
  quoted: string | null;
}

/** Normalizes whitespace, structures the reply into blocks, and separates the quoted history. */
export function splitEmailBody(body: string): EmailBody {
  const lines = body
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  // Gmail wraps a long attribution as "On Tue, … <a@b.com>" / "wrote:", so also test each line joined with the next.
  const cut = lines.findIndex((l, i) => {
    const t = l.trim();
    return (
      i > 0 &&
      (QUOTE_START.some((re) => re.test(t)) || (/^On\s/.test(t) && ON_WROTE.test(`${t} ${lines[i + 1]?.trim() ?? ''}`)))
    );
  });
  const main = cut === -1 ? lines : lines.slice(0, cut);
  const quoted = cut === -1 ? null : lines.slice(cut).join('\n').trim() || null;
  return { blocks: toBlocks(main), quoted };
}

// Plain-text copies of HTML/Markdown mail are hard-wrapped near 76 columns. A line at least WRAP_MIN long
// was probably wrapped when the next line starts lowercase or its first word would have overflowed WRAP_COL.
const BULLET_MARKER = /^[-*•–▪●◦]$/;
const BULLET_ITEM = /^(?:[-*+•–▪●◦]|o(?=\s{2}))\s+(.+)$/;
// Gmail renders an HTML <ol> item as a lone "1." with the text on a later line.
const ORDERED_MARKER = /^\(?(\d{1,2})[.)]$/;
const ORDERED_ITEM = /^\(?(\d{1,2})[.)]\s+(.+)$/;
// "1. **Billing:** … 2. **Credentialing:** …" — numbered items run together on one line.
const ORDERED_RUN_SPLIT = /\s+(?=\d{1,2}[.)]\s+\*\*)/;
// "1. Personal and Professional Information": short numbered title without sentence punctuation.
const NUMBERED_HEADING = /^\d{1,2}[.)]\s+[A-Z][^.!?:]{2,70}$/;
// Markdown that AI-drafted emails often carry as literal text.
const MD_HEADING = /^#{1,6}\s+(.+?)\s*#*$/;
const BOLD_HEADING = /^(?:\*\*|__)([^*_]{2,80}?)(?:\*\*|__):?$/;
const CAPS_HEADING = /^(?=.*[A-Z]{2})[A-Z0-9][A-Z0-9 &/,()'’-]*\s[A-Z0-9 &/,()'’-]+:?$/;
const RULE = /^([-*_=])(\s*\1){2,}$/;
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

const stripBold = (s: string) => s.replace(/^(\*\*|__)(.+)\1$/, '$2');
const firstWord = (s: string) => s.split(/\s/, 1)[0] ?? '';
const isTableSep = (s: string) => s.includes('|') && TABLE_SEP.test(s);

/** A line that opens its own block (list item, heading, rule, table, "Label: value") is never a wrapped tail. */
function startsBlock(t: string): boolean {
  return (
    BULLET_ITEM.test(t) ||
    BULLET_MARKER.test(t) ||
    ORDERED_ITEM.test(t) ||
    ORDERED_MARKER.test(t) ||
    MD_HEADING.test(t) ||
    RULE.test(t) ||
    t.startsWith('|') ||
    splitLabel(t) !== null
  );
}

/** True when `next` most likely continues `prev`, which the sender's mail client hard-wrapped. */
function continues(prev: string, next: string): boolean {
  if (prev.length < WRAP_MIN || startsBlock(next)) return false;
  return /^[a-z(`'"“]/.test(next) || prev.length + 1 + firstWord(next).length > WRAP_COL;
}

/** Splits a table row into cells; "\|" is an escaped pipe inside a cell. */
function tableCells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * Reads a Markdown pipe table starting at line `i`: "| a | b |" rows, or "a | b" rows under a
 * "--- | ---" separator. Rows the mail client hard-wrapped onto several lines are stitched back together.
 */
function readPipeTable(lines: string[], i: number): { block: EmailBlock; end: number } | null {
  const first = (lines[i] ?? '').trim();
  const piped = first.startsWith('|');
  if (!piped && !(first.includes('|') && isTableSep(lines[i + 1]?.trim() ?? ''))) return null;

  const rows: string[][] = [];
  let cols = 0;
  let headerRows = -1;
  let cur = '';
  const complete = (r: string) =>
    (!piped || (r.endsWith('|') && !r.endsWith('\\|'))) && (!cols || tableCells(r).length >= cols);
  const push = (r: string) => {
    const cells = tableCells(r);
    while (cols && cells.length < cols) cells.push('');
    rows.push(cells);
  };

  let j = i;
  for (; j < lines.length; j++) {
    const l = (lines[j] ?? '').trim();
    if (cur) {
      // A wrapped row continues on lines that don't open a new row, or that do but only fill its missing cells.
      const joined = `${cur} ${l}`;
      if (
        l &&
        !isTableSep(l) &&
        (!l.startsWith('|') || (cols && tableCells(cur).length < cols && tableCells(joined).length <= cols))
      ) {
        cur = joined;
        if (complete(cur)) {
          push(cur);
          cur = '';
        }
        continue;
      }
      push(cur);
      cur = '';
    }
    if (!l) break;
    if (isTableSep(l)) {
      if (headerRows === -1) {
        headerRows = rows.length;
        cols = rows[0]?.length ?? 0;
      }
      continue;
    }
    if (piped ? !l.startsWith('|') : !l.includes('|')) break;
    if (complete(l)) push(l);
    else cur = l;
  }
  if (cur) push(cur);
  if (headerRows === -1 && rows.length < 2) return null;

  const header = headerRows === 1 ? rows.shift()! : [];
  return { block: { type: 'table', header, rows }, end: j - 1 };
}

/** Two or more consecutive lines with the same number (≥2) of tab-separated cells, e.g. pasted from a spreadsheet. */
function readTabTable(lines: string[], i: number): { block: EmailBlock; end: number } | null {
  const cells = (l: string) =>
    l
      .trim()
      .split(/\t+/)
      .map((c) => c.trim());
  const line = (k: number) => lines[k] ?? '';
  const n = cells(line(i)).length;
  if (!line(i).includes('\t') || n < 2) return null;
  let j = i;
  while (j < lines.length && line(j).includes('\t') && cells(line(j)).length === n) j++;
  if (j - i < 2) return null;
  const [header = [], ...rows] = lines.slice(i, j).map(cells);
  return { block: { type: 'table', header, rows }, end: j - 1 };
}

/**
 * Rebuilds structure lost in plain-text emails: bullets and numbers that Gmail renders as a lone "-"/"1."
 * followed by the item on a later line, numbered section titles, hard-wrapped lines, runs of
 * "Label: value" lines, and literal Markdown (headings, tables, rules).
 */
function toBlocks(lines: string[]): EmailBlock[] {
  const blocks: EmailBlock[] = [];
  let para: string[] = [];
  let pending: { start?: number } | null = null; // a bare "-" or "1." waiting for its item text
  let lastItemLine: string | null = null; // raw last line of the current list item, for wrapped continuations

  const flush = () => {
    if (!para.length) return;
    const logical: string[] = [];
    para.forEach((l, i) => {
      if (i > 0 && logical.length && continues(para[i - 1] ?? '', l))
        logical[logical.length - 1] = `${logical[logical.length - 1]} ${l}`;
      else logical.push(l);
    });
    // Two or more consecutive "Label: value" lines read best as a field list; the rest stays prose.
    let text: string[] = [];
    const pushText = () => {
      if (text.length) blocks.push({ type: 'paragraph', text: text.join('\n') });
      text = [];
    };
    for (let j = 0; j < logical.length; ) {
      let k = j;
      while (k < logical.length && splitLabel(logical[k] ?? '')) k++;
      if (k - j >= 2) {
        pushText();
        blocks.push({ type: 'fields', items: logical.slice(j, k).map((l) => splitLabel(l)!) });
        j = k;
      } else {
        text.push(...logical.slice(j, Math.max(k, j + 1)));
        j = Math.max(k, j + 1);
      }
    }
    pushText();
    para = [];
  };
  const reset = () => {
    flush();
    pending = null;
    lastItemLine = null;
  };
  const addItem = (text: string, start: number | undefined, raw: string) => {
    flush();
    const last = blocks[blocks.length - 1];
    if (last?.type === 'list' && (last.start === undefined) === (start === undefined)) last.items.push(text);
    else blocks.push(start === undefined ? { type: 'list', items: [text] } : { type: 'list', items: [text], start });
    lastItemLine = raw;
  };
  /** True when "n." continues the ordered list just above rather than starting a numbered section. */
  const continuesOrdered = (n: number) => {
    const last = blocks[blocks.length - 1];
    return last?.type === 'list' && last.start !== undefined && n === last.start + last.items.length;
  };

  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (!t) {
      if (!pending) flush();
      lastItemLine = null;
      continue;
    }

    const table = t.includes('|') ? readPipeTable(lines, i) : t.includes('\t') ? readTabTable(lines, i) : null;
    if (table) {
      reset();
      blocks.push(table.block);
      i = table.end;
      continue;
    }

    if (RULE.test(t)) {
      // Setext heading: a single short line directly underlined with "===" or "---".
      const only = para.length === 1 ? para[0] : undefined;
      if (only !== undefined && lines[i - 1]?.trim() && only.length <= 80 && !pending) {
        const text = only;
        para = [];
        blocks.push({ type: 'heading', text: stripBold(text) });
      } else {
        reset();
        blocks.push({ type: 'rule' });
      }
      continue;
    }
    const md = t.match(MD_HEADING) ?? t.match(BOLD_HEADING);
    if (md?.[1]) {
      reset();
      blocks.push({ type: 'heading', text: stripBold(md[1]) });
      continue;
    }

    if (BULLET_MARKER.test(t)) {
      flush();
      pending = {};
      lastItemLine = null;
      continue;
    }
    const om = t.match(ORDERED_MARKER);
    if (om) {
      flush();
      pending = { start: Number(om[1]) };
      lastItemLine = null;
      continue;
    }
    const item = t.match(BULLET_ITEM);
    if (item?.[1]) {
      pending = null;
      addItem(item[1], undefined, t);
      continue;
    }
    if (pending) {
      const p = pending;
      pending = null;
      addItem(t, p.start, t);
      continue;
    }

    const oi = t.match(ORDERED_ITEM);
    if (oi && (!NUMBERED_HEADING.test(t) || continuesOrdered(Number(oi[1])))) {
      for (const part of t.split(ORDERED_RUN_SPLIT)) {
        const m = part.match(ORDERED_ITEM);
        if (m?.[2]) addItem(m[2], Number(m[1]), t);
      }
      continue;
    }
    if (lastItemLine && continues(lastItemLine, t)) {
      const list = blocks[blocks.length - 1] as { type: 'list'; items: string[] };
      list.items[list.items.length - 1] = `${list.items[list.items.length - 1] ?? ''} ${t}`;
      lastItemLine = t;
      continue;
    }
    lastItemLine = null;
    if (NUMBERED_HEADING.test(t) || (CAPS_HEADING.test(t) && t.length <= 60 && !para.length)) {
      flush();
      blocks.push({ type: 'heading', text: t.replace(/:$/, '') });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}

/**
 * "Policy Type: Claims-Made" → { label: 'Policy Type', value: 'Claims-Made' }, for bolding the label.
 * Also accepts Markdown-emphasised labels: "**Label:** value", "*Label:* value", "**Label**: value".
 */
export function splitLabel(text: string): { label: string; value: string } | null {
  const m = text.match(/^(\*\*?)?([A-Z][A-Za-z0-9 ()/&'’-]{1,48}?)(?::\1|\1:)\s+(\S.*)$/s);
  return m?.[2] && m[3] !== undefined ? { label: m[2], value: m[3] } : null;
}

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

// [text](https://…) (only https: and mailto:, like the shared Markdown urlTransform), **bold** / __bold__ (may span a wrapped line), `code`, and *italic*
// (the asterisk must hug the text so "5 * 3 * 2" stays literal).
const INLINE =
  /\[([^\]\n]+)\]\((https:\/\/[^\s)]+|mailto:[^\s)]+)\)|\*\*[^*]+?\*\*|__[^_]+?__|`[^`\n]+`|(?<![\w*])\*[^*\s](?:[^*\n]*[^*\s])?\*(?![\w*])/g;

/** Splits text into styled runs for the Markdown that AI-drafted emails carry as literal text. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const s = m[0];
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1]) runs.push({ text: m[1], href: m[2] });
    else if (s.startsWith('**') || s.startsWith('__'))
      runs.push({ text: s.slice(2, -2).replace(/\s*\n\s*/g, ' '), bold: true });
    else if (s.startsWith('`')) runs.push({ text: s.slice(1, -1), code: true });
    else runs.push({ text: s.slice(1, -1), italic: true });
    last = m.index + s.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** Plain-text length of the blocks, used to decide whether to collapse a long email. */
export function blocksLength(blocks: EmailBlock[]): number {
  return blocks.reduce((n, b) => {
    switch (b.type) {
      case 'list':
        return n + b.items.join(' ').length;
      case 'fields':
        return n + b.items.reduce((m, f) => m + f.label.length + f.value.length + 2, 0);
      case 'table':
        return n + [b.header, ...b.rows].flat().join(' ').length;
      case 'rule':
        return n;
      default:
        return n + b.text.length;
    }
  }, 0);
}

// ---- Reply, reply all, forward (EmailComposeDialog). Change compose defaults only here. ----

export type ComposeMode = 'REPLY' | 'REPLY_ALL' | 'FORWARD';

export interface ComposeDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  documentIds: string[];
}

export interface ComposeSource {
  fromAddress: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
  /** Original Cc, comma-separated; absent on older API responses. */
  ccAddress?: string | null;
}

// Mirrors the server check (backend services/mime.ts): no spaces, angle brackets or separators, a dot in the domain.
const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** "Jane <jane@x.com>" or "jane@x.com" is valid; the bare address must be well-formed. */
export function isValidEmail(raw: string): boolean {
  return ADDRESS.test(parseAddress(raw).address);
}

/** Splits a header-style list on commas/semicolons, keeping quoted names ("Smith, Jane" <j@x.com>) whole. */
export function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const same = (a: string, b: string) => parseAddress(a).address.toLowerCase() === parseAddress(b).address.toLowerCase();

/** "Re: …" once; an existing Re:/RE: prefix is kept, never doubled. */
export const replySubject = (s: string) => (/^\s*re:/i.test(s) ? s.trim() : `Re: ${s.trim() || '(no subject)'}`);
/** "Fwd: …" once; existing Fwd:/Fw: prefixes are kept. */
export const forwardSubject = (s: string) =>
  /^\s*(fwd?|fw):/i.test(s) ? s.trim() : `Fwd: ${s.trim() || '(no subject)'}`;

function quote(src: ComposeSource, formatDate: (iso: string) => string): string {
  const lines = src.bodyText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'));
  return `On ${formatDate(src.receivedAt)}, ${src.fromAddress} wrote:\n${lines.join('\n')}`;
}

function forwarded(src: ComposeSource, formatDate: (iso: string) => string): string {
  return [
    '---------- Forwarded message ---------',
    `From: ${src.fromAddress}`,
    `Date: ${formatDate(src.receivedAt)}`,
    `Subject: ${src.subject}`,
    `To: ${src.toAddress}`,
    '',
    src.bodyText,
  ].join('\n');
}

/**
 * Starting fields for each mode. Reply goes to the sender; Reply all copies the original To and Cc minus the
 * sender, the monitored mailbox and repeats; Forward starts empty with every document selected.
 */
export function composeDefaults(
  mode: ComposeMode,
  src: ComposeSource,
  opts: { mailbox?: string | null; documentIds?: string[]; formatDate?: (iso: string) => string } = {},
): ComposeDraft {
  const formatDate = opts.formatDate ?? ((iso: string) => new Date(iso).toLocaleString('en-US'));
  if (mode === 'FORWARD') {
    return {
      to: [],
      cc: [],
      bcc: [],
      subject: forwardSubject(src.subject),
      body: `\n\n${forwarded(src, formatDate)}`,
      documentIds: opts.documentIds ?? [],
    };
  }
  const sender = src.fromAddress.trim();
  const cc: string[] = [];
  if (mode === 'REPLY_ALL') {
    for (const a of [...splitAddressList(src.toAddress), ...splitAddressList(src.ccAddress ?? '')]) {
      if (same(a, sender) || (opts.mailbox && same(a, opts.mailbox)) || cc.some((c) => same(c, a))) continue;
      cc.push(a);
    }
  }
  return {
    to: sender ? [sender] : [],
    cc,
    bcc: [],
    subject: replySubject(src.subject),
    body: `\n\n${quote(src, formatDate)}`,
    documentIds: [],
  };
}

export interface ComposeCheck {
  ok: boolean;
  errors: string[];
  invalid: string[];
}

/**
 * Client-side checks; the server repeats them. `maxAttachmentBytes` is the server's limit (outboundAttachmentLimit);
 * null while it is not loaded, when size is left to the server.
 */
export function validateCompose(
  d: ComposeDraft,
  attachmentBytes: number,
  gmailConnected: boolean,
  maxAttachmentBytes: number | null,
): ComposeCheck {
  const errors: string[] = [];
  const invalid = [...d.to, ...d.cc, ...d.bcc].filter((a) => !isValidEmail(a));
  if (!gmailConnected) errors.push('Gmail is not connected.');
  if (!d.to.length) errors.push('Add at least one recipient.');
  if (invalid.length)
    errors.push(`Fix ${invalid.length === 1 ? 'the invalid address' : `${invalid.length} invalid addresses`}.`);
  if (!d.subject.trim()) errors.push('Add a subject.');
  if (maxAttachmentBytes != null && attachmentBytes > maxAttachmentBytes) {
    errors.push(`Attachments are over the ${Math.round(maxAttachmentBytes / (1024 * 1024))} MB limit.`);
  }
  return { ok: errors.length === 0, errors, invalid };
}
