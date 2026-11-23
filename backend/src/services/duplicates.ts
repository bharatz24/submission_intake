import { createHash } from 'node:crypto';

import { config } from '../config.js';
import type { Queryable } from '../db/pool.js';

/**
 * Content duplicate detection. Deterministic code, no LLM: it runs at ingest, before classification,
 * so a repeated email costs no tokens. See docs/inbox-ignore-duplicate-plan.md section 4.1 and section 12.
 *
 * A match needs concrete evidence (same Message-ID, same attachment bytes, same or contained text), and every
 * match carries a plain-language explanation of that evidence. Anything that only *resembles* an earlier email
 * (changed words, different text with the same documents, a different sender) is held as POSSIBLE for a person
 * to check. New information is never a duplicate: a new attachment, or text that is not the earlier text.
 */

export type DuplicateRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R7' | 'R8';
export type DuplicateStrength = 'CERTAIN' | 'HIGH' | 'POSSIBLE';

const RULE_STRENGTH: Record<DuplicateRule, DuplicateStrength> = {
  R1: 'CERTAIN',
  R2: 'CERTAIN',
  R3: 'HIGH',
  R7: 'HIGH',
  R8: 'HIGH',
  R4: 'POSSIBLE',
  R5: 'POSSIBLE',
};
const STRENGTH_RANK: Record<DuplicateStrength, number> = { CERTAIN: 0, HIGH: 1, POSSIBLE: 2 };
const RULE_ORDER: DuplicateRule[] = ['R1', 'R2', 'R3', 'R7', 'R8', 'R4', 'R5'];

export interface DuplicateBasis {
  rule: DuplicateRule | 'MANUAL';
  strength: DuplicateStrength;
  similarity: number | null;
  sharedAttachments: string[];
  daysSinceOriginal: number;
  originalId: string;
  method: 'AUTO' | 'MANUAL';
  /** The evidence in one or two sentences, shown to underwriters. */
  explanation?: string;
  differentSender?: boolean;
  addedWords?: string[];
  removedWords?: string[];
  by?: string;
  reason?: string;
}

/**
 * What the audit trail keeps of a duplicate basis (DB-01): the rule, strength and counts, never the evidence itself
 * (shared attachment names, added/removed words, the explanation quoting the subject, a person's free-text reason).
 * The full basis stays on submissions.duplicate_basis, which the retention purge scrubs.
 */
export function auditBasis(basis: Partial<DuplicateBasis> | null | undefined): Record<string, unknown> | null {
  if (!basis) return null;
  return {
    rule: basis.rule ?? null,
    strength: basis.strength ?? null,
    similarity: basis.similarity ?? null,
    method: basis.method ?? null,
    originalId: basis.originalId ?? null,
    daysSinceOriginal: basis.daysSinceOriginal ?? null,
    differentSender: basis.differentSender ?? null,
    sharedAttachmentCount: basis.sharedAttachments?.length ?? 0,
    addedWordCount: basis.addedWords?.length ?? 0,
    removedWordCount: basis.removedWords?.length ?? 0,
  };
}

export interface DocRef {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/** Below this many words a body says nothing of its own ("see attached", "resending"). */
const TRIVIAL_BODY_WORDS = 15;
/** A forward or re-send may add a cover note of up to this many words and still be the same email. */
const MAX_NOTE_WORDS = 40;
const TAIL_WORDS = 30;
const SHINGLE_SIZE = 5;
const SIGNATURE_IMAGE_BYTES = 50 * 1024;

const SUBJECT_PREFIX =
  /^\s*(?:(?:re|fwd?|aw|wg|sv|tr|antw)\s*(?:\[\d+\])?\s*:|\[[^\]]*\]|\((?:external|ext)\)|(?:external|ext)\s*:)\s*/i;

/** Lowercase, strip reply/forward prefixes and leading [tags], collapse whitespace. */
export function normalizeSubject(subject: string): string {
  let s = subject.replace(/\s+/g, ' ').trim();
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(SUBJECT_PREFIX, '');
  }
  return s.toLowerCase().trim();
}

/** "Fwd: …", "FW: …", "[EXTERNAL] WG: …": the text below the forward header is the forwarded email's content. */
export function isForwardSubject(subject: string): boolean {
  return /^\s*(?:\[[^\]]*\]\s*)*(?:fwd?|wg|tr)\s*:/i.test(subject);
}

const FORWARD_MARKER = /^\s*(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:?)\s*$/i;
const ORIGINAL_MARKER = /^\s*-{2,}\s*original message\s*-{2,}\s*$/i;
const HEADER_LINE = /^\s*(?:from|sent|to|cc|bcc|date|subject|reply-to|importance)\s*:/i;
const WROTE_LINE = /^\s*on\b.*\bwrote:\s*$/i;
const SIGNATURE_RULE = /^\s*(?:--|__+|-{5,}|_{5,})\s*$/;
const DISCLAIMER =
  /^\s*(?:confidentiality notice|this (?:e-?mail|message)(?: and any attachments?)? (?:is|are|may be) (?:confidential|intended))/i;
const MOBILE_SIGNATURE =
  /^\s*(?:sent from my \w+|sent from (?:mail|outlook) for \w+|get outlook for \w+|sent via \w+)\b/i;
// A line that is only a closing ("Thanks!", "Best regards,"): what follows is the sender's name and signature.
const SIGN_OFF =
  /^\s*(?:many thanks|thanks? (?:again|so much|very much)|thank you(?: (?:again|so much|very much))?|thanks?|thx|(?:best|kind|kindest|warm|warmest|with) regards|regards|best(?: wishes)?|sincerely(?: yours)?|yours (?:truly|sincerely)|cheers|respectfully|all the best)\s*[,.!]*\s*$/i;

/** Outlook writes "From: …" then "Sent: …"/"Date: …" within a few lines at the top of a quoted or forwarded email. */
function isOutlookHeader(lines: string[], i: number): boolean {
  if (!/^\s*from\s*:/i.test(lines[i]!)) return false;
  return lines.slice(i + 1, i + 4).some((l) => /^\s*(?:sent|date)\s*:/i.test(l));
}

/**
 * The email's own text reduced to its words. Quoted history is dropped: everything after a reply attribution
 * ("On … wrote:") or a reply's Outlook header block, and ">" lines. A forward keeps the forwarded text (that is
 * its content) without the forward's header lines. Signature rules, mobile signatures, disclaimers, URLs and
 * tracking tokens are dropped too. With `dropSignOff`, a closing line ("Thanks!", "Best regards,") and the
 * signature below it are dropped as well, up to the next forwarded email: what is left is what the email says.
 */
export function normalizeBody(body: string, opts: { forward?: boolean; dropSignOff?: boolean } = {}): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let inHeaderBlock = false;
  let inSignOff = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Gmail's explicit marker always introduces forwarded content, whatever the subject says.
    if (FORWARD_MARKER.test(line) || (opts.forward && ORIGINAL_MARKER.test(line))) {
      inHeaderBlock = true;
      inSignOff = false;
      continue;
    }
    if (!inHeaderBlock && isOutlookHeader(lines, i)) {
      if (!opts.forward) break; // a reply: the rest is quoted history
      inHeaderBlock = true; // a forward: skip the header lines below, keep the forwarded text
      inSignOff = false;
    }
    if (ORIGINAL_MARKER.test(line) || WROTE_LINE.test(line)) break;
    // Gmail wraps long "On <date> <name> <address>" attributions onto a second "wrote:" line.
    if (/^\s*on\b/i.test(line) && /^\s*.*\bwrote:\s*$/i.test(lines[i + 1] ?? '') && line.length < 200) break;
    if (inHeaderBlock) {
      if (HEADER_LINE.test(line) || !line.trim()) continue;
      inHeaderBlock = false;
    }
    if (opts.dropSignOff && SIGN_OFF.test(line)) inSignOff = true;
    if (inSignOff) continue;
    if (/^\s*>/.test(line) || SIGNATURE_RULE.test(line) || DISCLAIMER.test(line) || MOBILE_SIGNATURE.test(line))
      continue;
    kept.push(line);
  }
  return (
    kept
      .join('\n')
      .toLowerCase()
      .replace(/\b(?:https?:\/\/|www\.)\S+/g, ' ')
      .replace(/<[^>\s]+@[^>\s]+>/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      // Long alphanumeric runs with digits are tracking ids, message ids and the like.
      .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{20,}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Lowercased address from "Name <addr@x>" or a bare address. */
export function senderAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from);
  return (m?.[1] ?? from).trim().toLowerCase();
}

/** Logos and inline images in signatures: every email from a broker shares them, so they never count as content. */
export function isSignatureImage(doc: Pick<DocRef, 'filename' | 'mimeType' | 'sizeBytes'>): boolean {
  if (/^(?:image\d{3}|outlook-[\w-]*)\.(?:png|jpe?g|gif|bmp)$/i.test(doc.filename)) return true;
  return doc.mimeType.toLowerCase().startsWith('image/') && doc.sizeBytes < SIGNATURE_IMAGE_BYTES;
}

/** Sorted, distinct sha256 of the attachments that carry content. */
export function attachmentSet(docs: DocRef[]): string[] {
  return [...new Set(docs.filter((d) => !isSignatureImage(d)).map((d) => d.sha256))].sort();
}

const words = (text: string) => text.split(' ').filter(Boolean);

function shingles(text: string): Set<string> {
  const w = words(text);
  if (w.length <= SHINGLE_SIZE) return new Set(w.length ? [w.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= w.length; i++) out.add(w.slice(i, i + SHINGLE_SIZE).join(' '));
  return out;
}

/** Jaccard index of 5-word shingles of two normalized bodies, 0..1. Two empty bodies are identical. */
export function shingleSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (!sa.size && !sb.size) return 1;
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / (sa.size + sb.size - shared);
}

/** Distinct words one text has that the other lacks (first occurrences, in order), to show what changed. */
export function wordDiff(newer: string, older: string): { added: string[]; removed: string[] } {
  const a = new Set(words(newer));
  const b = new Set(words(older));
  return { added: [...a].filter((w) => !b.has(w)), removed: [...b].filter((w) => !a.has(w)) };
}

/** R4: at most this share of the distinct words may differ for "nearly the same text". */
const NEAR_SAME_CHANGED_WORDS = 0.05;

function nearlySame(newer: string, older: string): boolean {
  const { added, removed } = wordDiff(newer, older);
  const distinct = new Set([...words(newer), ...words(older)]).size;
  return added.length + removed.length <= Math.max(2, Math.floor(distinct * NEAR_SAME_CHANGED_WORDS));
}

/** The words a newer text adds around an older text it contains in full, or null when it does not contain it. */
export function addedAround(newer: string, older: string): string[] | null {
  if (!older) return null;
  const at = ` ${newer} `.indexOf(` ${older} `);
  if (at < 0) return null;
  return words(`${newer.slice(0, at)} ${newer.slice(at + older.length)}`);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Bump when normalization or the fingerprints change: stored fingerprints are then recomputed once at the next
 * migrate (db/backfills.ts), so candidate lookup keeps finding older rows.
 */
export const FINGERPRINT_VERSION = 4;

export interface Fingerprints {
  normalizedSubject: string;
  normalizedBody: string;
  /**
   * Words the email itself says: the normalized body without its sign-off and signature. Signatures repeat in
   * every email from a sender, so "Thanks! <signature>" is as empty as "Thanks!" when deciding what is trivial.
   */
  contentWords: number;
  /** "Fwd:"/"FW:" subject. */
  forward: boolean;
  attachments: string[];
  sender: string;
  contentFingerprint: string;
  attachmentFingerprint: string | null;
  /**
   * The email's own text alone (normalized body without sign-off and signature, see `contentWords`): the same text
   * re-sent under another subject or with another closing. Null when it is too short to identify an email.
   */
  bodyFingerprint: string | null;
  /** Last words of the body: finds the earlier email when a note was added on top and the subject changed. */
  bodyTailFingerprint: string | null;
}

export function fingerprints(
  email: { subject: string; bodyText: string; fromAddress?: string },
  docs: DocRef[],
): Fingerprints {
  const normalizedSubject = normalizeSubject(email.subject);
  const forward = isForwardSubject(email.subject);
  const normalizedBody = normalizeBody(email.bodyText, { forward });
  const content = normalizeBody(email.bodyText, { forward, dropSignOff: true });
  const contentWords = words(content).length;
  const attachments = attachmentSet(docs);
  const w = words(normalizedBody);
  return {
    normalizedSubject,
    normalizedBody,
    contentWords,
    forward,
    attachments,
    sender: senderAddress(email.fromAddress ?? ''),
    contentFingerprint: sha256(`${normalizedSubject}\n${normalizedBody}\n${attachments.join(',')}`),
    attachmentFingerprint: attachments.length ? sha256(attachments.join(',')) : null,
    bodyFingerprint: contentWords < TRIVIAL_BODY_WORDS ? null : sha256(content),
    bodyTailFingerprint: w.length >= TAIL_WORDS ? sha256(w.slice(-TAIL_WORDS).join(' ')) : null,
  };
}

/** What each text has after the beginning they share: for two emails with the same own text, their closings. */
function differingEnds(newer: string, older: string): { added: string[]; removed: string[] } {
  const a = words(newer);
  const b = words(older);
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return { added: a.slice(n), removed: b.slice(n) };
}

/** The words of `newer` before the ending it shares with `older` (the same sign-off and signature). */
function wordsBeforeSharedEnding(newer: string, older: string): string[] {
  const a = words(newer);
  const b = words(older);
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return a.slice(0, a.length - n);
}

/**
 * R3's "see attached": the email says almost nothing of its own. Both measures must agree, because a sign-off line
 * can also open an email ("Thanks!" then a correction): its words before the sign-off, and its words before the
 * signature it shares with the earlier email.
 */
function trivialNote(fp: Fingerprints, cf: Fingerprints): boolean {
  return (
    fp.contentWords < TRIVIAL_BODY_WORDS &&
    wordsBeforeSharedEnding(fp.normalizedBody, cf.normalizedBody).length < TRIVIAL_BODY_WORDS
  );
}

export interface DuplicateCandidate {
  id: string;
  rfcMessageId: string | null;
  receivedAt: Date;
  fingerprints: Fingerprints;
}

export interface DuplicateMatch<C extends DuplicateCandidate = DuplicateCandidate> {
  candidate: C;
  rule: DuplicateRule;
  strength: DuplicateStrength;
  similarity: number;
  sharedHashes: string[];
  differentSender: boolean;
  /** R8: the note added around the earlier text. R4: words added; R4/R5: words removed. R7: each closing. */
  addedWords: string[];
  removedWords: string[];
  wordCount: number;
  sameSubject: boolean;
}

/**
 * Compares the new email with each candidate and keeps the strongest match (then the rule order, then the
 * earliest candidate). See the rule table in docs/inbox-ignore-duplicate-plan.md section 12.
 */
export function matchDuplicate<C extends DuplicateCandidate>(
  email: { rfcMessageId: string | null; fingerprints: Fingerprints },
  candidates: C[],
  bodySimilarity = config.DUPLICATE_BODY_SIMILARITY,
): DuplicateMatch<C> | null {
  const fp = email.fingerprints;
  const trivialBody = fp.contentWords < TRIVIAL_BODY_WORDS;
  const hasAttachments = fp.attachments.length > 0;
  let best: DuplicateMatch<C> | null = null;

  for (const c of [...candidates].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())) {
    const cf = c.fingerprints;
    const sim = shingleSimilarity(fp.normalizedBody, cf.normalizedBody);
    const sameSet =
      cf.attachments.length === fp.attachments.length && fp.attachments.every((h) => cf.attachments.includes(h));
    const noNewAttachment = fp.attachments.every((h) => cf.attachments.includes(h));
    const added = addedAround(fp.normalizedBody, cf.normalizedBody);
    const noteOnly = added !== null && added.length <= MAX_NOTE_WORDS;
    const neitherHasAttachments = !hasAttachments && !cf.attachments.length;
    let rule: DuplicateRule | null = null;
    let addedWords: string[] = [];
    let removedWords: string[] = [];

    if (email.rfcMessageId && c.rfcMessageId === email.rfcMessageId) rule = 'R1';
    // Without attachments a trivial body ("thanks", "see below") is too generic to call two emails the same.
    else if (cf.contentFingerprint === fp.contentFingerprint && (hasAttachments || !trivialBody)) rule = 'R2';
    else if (hasAttachments && sameSet && (trivialNote(fp, cf) || noteOnly || sim >= bodySimilarity)) {
      rule = 'R3';
      // Quote the note: the words around the earlier text, or the few words before the shared signature.
      addedWords = added ?? (trivialNote(fp, cf) ? wordsBeforeSharedEnding(fp.normalizedBody, cf.normalizedBody) : []);
    } else if (neitherHasAttachments && fp.bodyFingerprint !== null && fp.bodyFingerprint === cf.bodyFingerprint) {
      // The same own text; any difference is after it: one closing "Thank you", the other a full signature.
      rule = 'R7';
      ({ added: addedWords, removed: removedWords } = differingEnds(fp.normalizedBody, cf.normalizedBody));
    }
    // The earlier email must say something of its own: one that is only "Thanks!" and a signature is contained
    // in every later email from that sender.
    else if (neitherHasAttachments && cf.contentWords >= TRIVIAL_BODY_WORDS && added !== null) {
      rule = 'R8';
      addedWords = added;
    } else if (
      neitherHasAttachments &&
      !trivialBody &&
      cf.normalizedSubject === fp.normalizedSubject &&
      nearlySame(fp.normalizedBody, cf.normalizedBody)
    ) {
      // A broker's template filled in for another provider looks like this too: never more than POSSIBLE.
      rule = 'R4';
      ({ added: addedWords, removed: removedWords } = wordDiff(fp.normalizedBody, cf.normalizedBody));
    } else if (hasAttachments && noNewAttachment) {
      rule = 'R5';
      const diff = wordDiff(fp.normalizedBody, cf.normalizedBody);
      addedWords = diff.added.slice(0, 12); // a sample of what the new text says, not all of it
    }
    if (!rule) continue;

    let strength = RULE_STRENGTH[rule];
    // A long note on a forward may carry new information.
    if (rule === 'R8' && addedWords.length > MAX_NOTE_WORDS) strength = 'POSSIBLE';
    // More than a closing differs after the shared text (details written below the sign-off): a person checks.
    if (rule === 'R7' && Math.max(addedWords.length, removedWords.length) > MAX_NOTE_WORDS) strength = 'POSSIBLE';
    // A note on top of the earlier text is a forward or a re-send only when it says so (Fwd: or the same subject).
    if (rule === 'R8' && !fp.forward && fp.normalizedSubject !== cf.normalizedSubject) strength = 'POSSIBLE';
    // Same content from another address: a second broker for the same risk, or a colleague's forward. A person decides.
    const differentSender = Boolean(fp.sender && cf.sender && fp.sender !== cf.sender);
    if (differentSender && rule !== 'R1') strength = 'POSSIBLE';

    const m: DuplicateMatch<C> = {
      candidate: c,
      rule,
      strength,
      similarity: Math.round(sim * 100) / 100,
      sharedHashes: fp.attachments.filter((h) => cf.attachments.includes(h)),
      differentSender,
      addedWords,
      removedWords,
      wordCount: words(cf.normalizedBody).length,
      sameSubject: fp.normalizedSubject === cf.normalizedSubject,
    };
    if (
      !best ||
      STRENGTH_RANK[m.strength] < STRENGTH_RANK[best.strength] ||
      (STRENGTH_RANK[m.strength] === STRENGTH_RANK[best.strength] &&
        RULE_ORDER.indexOf(m.rule) < RULE_ORDER.indexOf(best.rule))
    ) {
      best = m;
    }
  }
  return best;
}

function ago(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  const when = ms >= 0 ? 'earlier' : 'later';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ${when}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ${when}`;
  return `${Math.round(h / 24)} days ${when}`;
}

const quote = (ws: string[], max = 12) => `"${ws.slice(0, max).join(' ')}${ws.length > max ? ' …' : ''}"`;
const files = (names: string[]) => `${names.length} attachment${names.length === 1 ? '' : 's'} (${names.join(', ')})`;

/** The evidence for a match in plain language, as underwriters see it on the Duplicates tab. */
export function explainDuplicate(
  m: Pick<
    DuplicateMatch,
    'rule' | 'strength' | 'similarity' | 'differentSender' | 'addedWords' | 'removedWords' | 'wordCount'
  > &
    Partial<Pick<DuplicateMatch, 'sameSubject'>>,
  ctx: {
    originalSubject: string;
    msBetween: number;
    sharedAttachments: string[];
    sender: string;
    originalSender: string;
    originalStatus: string;
  },
): string {
  const of = `"${ctx.originalSubject || '(no subject)'}", received ${ago(ctx.msBetween)}`;
  let text: string;
  switch (m.rule) {
    case 'R1':
      text = `The same email (identical Message-ID) as ${of}: it reached the mailbox twice.`;
      break;
    case 'R2':
      text = ctx.sharedAttachments.length
        ? `Same subject, same text and the same ${files(ctx.sharedAttachments)} as ${of}.`
        : `Same subject and the same text (${m.wordCount} words) as ${of}.`;
      break;
    case 'R3':
      text =
        `The same ${files(ctx.sharedAttachments)} as ${of}; ` +
        (m.addedWords.length
          ? `the text adds only a short note: ${quote(m.addedWords)}.`
          : m.similarity >= 1
            ? 'the text is identical.'
            : `the text is ${Math.round(m.similarity * 100)}% the same.`);
      break;
    case 'R7': {
      const closing = [
        m.removedWords.length && `${quote(m.removedWords)} there`,
        m.addedWords.length && `${quote(m.addedWords)} here`,
      ].filter(Boolean);
      text =
        `The same text (${m.wordCount} words) as ${of}${m.sameSubject ? '' : ', under a different subject'}` +
        `${closing.length ? `; only the closing differs (${closing.join(', ')})` : ''}. Neither has attachments.` +
        (m.strength === 'POSSIBLE' && !m.differentSender
          ? ' More than a closing follows the shared text: check what it adds.'
          : '');
      break;
    }
    case 'R8':
      text =
        `Contains the full text of ${of} (${m.wordCount} words), with ${m.addedWords.length} word${m.addedWords.length === 1 ? '' : 's'} added: ${quote(m.addedWords)}.` +
        (m.strength !== 'POSSIBLE' || m.differentSender
          ? ''
          : m.addedWords.length > MAX_NOTE_WORDS
            ? ' The added note is long: check whether it brings new information.'
            : ' It is not a forward and the subject is different: check whether it is a new request.');
      break;
    case 'R4': {
      const changes = [
        m.removedWords.length && `removed ${quote(m.removedWords)}`,
        m.addedWords.length && `added ${quote(m.addedWords)}`,
      ].filter(Boolean);
      text =
        `Same subject and nearly the same text as ${of}; only ${m.removedWords.length + m.addedWords.length} words differ` +
        `${changes.length ? ` (${changes.join(', ')})` : ''}. Check whether it is another provider or a correction.`;
      break;
    }
    case 'R5':
      text =
        `Every attachment (${ctx.sharedAttachments.join(', ')}) was already received with ${of}, but the text is different` +
        `${m.addedWords.length ? ` (new words: ${quote(m.addedWords)})` : ''}. Check whether it adds information.`;
      break;
  }
  if (m.differentSender) {
    text += ` It comes from a different address (${ctx.sender}; the original came from ${ctx.originalSender}): possibly a second broker for the same risk, or a colleague's forward.`;
  }
  if (ctx.originalStatus === 'ERROR') text += ' The original failed processing: reprocess the original.';
  return text;
}

/** Follow duplicate_of to the original non-duplicate submission. */
export async function rootOf(db: Queryable, id: string): Promise<string> {
  const {
    rows: [r],
  } = await db.query<{ duplicate_of: string | null }>('SELECT duplicate_of FROM submissions WHERE id=$1', [id]);
  return r?.duplicate_of ?? id;
}

interface CandidateRow extends DuplicateCandidate {
  subject: string;
  fromAddress: string;
  docs: DocRef[];
}

const DOCS_JSON = `COALESCE((SELECT json_agg(json_build_object('filename', d.filename, 'mimeType', d.mime_type, 'sizeBytes', d.size_bytes, 'sha256', d.sha256))
                     FROM documents d WHERE d.submission_id=s.id), '[]')`;

/**
 * Compare a just-ingested submission with recent ones. Candidates share its Message-ID, or within the lookback
 * window its content, attachment, body or body-tail fingerprint, normalized subject, or any content attachment.
 * A candidate received later still counts: the first one ingested is the original (identical uploads are stamped
 * before they take the ingest lock, so their received times need not follow commit order). Exact matches are
 * fetched first, so loose ones (a common subject, a shared signature) cannot push them out of the candidate limit.
 */
export async function findDuplicate(
  db: Queryable,
  email: {
    submissionId: string;
    rfcMessageId: string | null;
    receivedAt: Date;
    fingerprints: Fingerprints;
    docs: DocRef[];
  },
): Promise<{ match: null } | { original: { id: string; status: string; subject: string }; basis: DuplicateBasis }> {
  const fp = email.fingerprints;
  // DB-11: each way of matching is its own UNION arm, so each uses its index (emails_rfc_message_id_idx, the
  // submissions_*_fp_idx / norm_subject indexes, documents_sha256_idx) instead of one OR across a join scanning every
  // submission. The full condition is then applied to that small set exactly as before, the 50 best are kept, and
  // only those 50 have their bodies and documents read.
  const { rows } = await db.query(
    `WITH arms AS (
        SELECT s.id FROM emails e JOIN submissions s ON s.email_id=e.id WHERE $2::text IS NOT NULL AND e.rfc_message_id = $2
        UNION SELECT id FROM submissions WHERE content_fingerprint = $5
        UNION SELECT id FROM submissions WHERE attachment_fingerprint = $6
        UNION SELECT id FROM submissions WHERE normalized_subject = $7
        UNION SELECT id FROM submissions WHERE body_fingerprint = $9
        UNION SELECT id FROM submissions WHERE body_tail_fingerprint = $10
        UNION SELECT submission_id FROM documents WHERE sha256 = ANY($8::text[])
      ), finalists AS (
        SELECT s.id, e.received_at,
               COALESCE(($2::text IS NOT NULL AND e.rfc_message_id = $2) OR s.content_fingerprint = $5
                 OR s.attachment_fingerprint = $6 OR s.body_fingerprint = $9, false) AS exact
          FROM arms JOIN submissions s ON s.id=arms.id JOIN emails e ON e.id=s.email_id
         WHERE s.id <> $1
           -- A deleted submission is gone for good; a deleted ignored email still marks its repeats.
           AND (s.deleted_at IS NULL OR s.status = 'NOT_SUBMISSION') AND (
           ($2::text IS NOT NULL AND e.rfc_message_id = $2)
           OR (e.received_at >= $3::timestamptz - make_interval(days => $4::int) AND (
             s.content_fingerprint = $5 OR s.attachment_fingerprint = $6 OR s.normalized_subject = $7
             OR s.body_fingerprint = $9 OR s.body_tail_fingerprint = $10
             OR EXISTS (SELECT 1 FROM documents d WHERE d.submission_id=s.id AND d.sha256 = ANY($8::text[])))))
         ORDER BY exact DESC, e.received_at DESC
         LIMIT 50
      )
     SELECT s.id, e.rfc_message_id, e.received_at, e.subject, e.body_text, e.from_address, ${DOCS_JSON} AS docs
       FROM finalists f JOIN submissions s ON s.id=f.id JOIN emails e ON e.id=s.email_id
      ORDER BY f.exact DESC, f.received_at DESC`,
    [
      email.submissionId,
      email.rfcMessageId,
      email.receivedAt,
      config.DUPLICATE_LOOKBACK_DAYS,
      fp.contentFingerprint,
      fp.attachmentFingerprint,
      fp.normalizedSubject,
      fp.attachments,
      fp.bodyFingerprint,
      fp.bodyTailFingerprint,
    ],
  );
  const candidates: CandidateRow[] = rows.map((r) => ({
    id: r.id,
    rfcMessageId: r.rfc_message_id,
    receivedAt: new Date(r.received_at),
    subject: r.subject,
    fromAddress: r.from_address,
    docs: r.docs,
    fingerprints: fingerprints({ subject: r.subject, bodyText: r.body_text, fromAddress: r.from_address }, r.docs),
  }));
  const m = matchDuplicate({ rfcMessageId: email.rfcMessageId, fingerprints: fp }, candidates);
  if (!m) return { match: null };

  const rootId = await rootOf(db, m.candidate.id);
  const {
    rows: [root],
  } = await db.query<{ id: string; status: string; subject: string; received_at: Date }>(
    'SELECT s.id, s.status, e.subject, e.received_at FROM submissions s JOIN emails e ON e.id=s.email_id WHERE s.id=$1',
    [rootId],
  );
  const names = new Map(email.docs.map((d) => [d.sha256, d.filename]));
  const sharedAttachments = m.sharedHashes.map((h) => names.get(h) ?? h);
  const msBetween = email.receivedAt.getTime() - m.candidate.receivedAt.getTime();
  return {
    original: { id: root!.id, status: root!.status, subject: root!.subject },
    basis: {
      rule: m.rule,
      strength: m.strength,
      similarity: m.similarity,
      sharedAttachments,
      daysSinceOriginal: Math.round(
        Math.abs(email.receivedAt.getTime() - new Date(root!.received_at).getTime()) / 86_400_000,
      ),
      originalId: root!.id,
      method: 'AUTO',
      differentSender: m.differentSender,
      addedWords: m.addedWords,
      removedWords: m.removedWords,
      // The evidence is about the email it matched, which is the original unless that one was itself a copy.
      explanation: explainDuplicate(m, {
        originalSubject: m.candidate.subject,
        msBetween,
        sharedAttachments,
        sender: fp.sender,
        originalSender: m.candidate.fingerprints.sender,
        originalStatus: root!.status,
      }),
    },
  };
}
