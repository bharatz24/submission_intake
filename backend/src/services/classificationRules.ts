import { isForwardSubject, normalizeBody } from './duplicates.js';

export type Classification = 'SUBMISSION' | 'NOT_SUBMISSION' | 'REVIEW_REQUIRED';

/** Facts set by mail software rather than written by a person (gmail.ts `messageSignals`). */
export interface MessageSignals {
  /** Auto-Submitted (RFC 3834) or X-Autoreply/X-Autorespond value: auto-replied, auto-generated, … */
  autoSubmitted?: string;
  /** List-Unsubscribe or List-Id header: sent through a mailing list or bulk mailer. */
  listUnsubscribe?: boolean;
  /** Precedence header: bulk, list or junk. */
  precedence?: string;
  /** multipart/report type: delivery-status (bounce) or disposition-notification (read receipt). */
  reportType?: string;
  /** Gmail's own inbox category: PROMOTIONS, SOCIAL, UPDATES or FORUMS (absent for Primary). */
  gmailCategory?: string;
}

/** Machine-set facts from message headers (keys lowercase) and Gmail label ids. */
export function messageSignals(headers: Record<string, string>, labelIds: string[] = []): MessageSignals {
  const s: MessageSignals = {};
  const auto = headers['auto-submitted']?.trim().toLowerCase();
  if (auto && auto !== 'no') s.autoSubmitted = auto;
  else if (headers['x-autoreply'] || headers['x-autorespond']) s.autoSubmitted = 'auto-replied';
  if (headers['list-unsubscribe'] || headers['list-id']) s.listUnsubscribe = true;
  const precedence = headers.precedence?.trim().toLowerCase();
  if (precedence && ['bulk', 'list', 'junk'].includes(precedence)) s.precedence = precedence;
  const report = /multipart\/report[^]*?report-type\s*=\s*"?([\w-]+)/i.exec(headers['content-type'] ?? '');
  if (report) s.reportType = report[1]!.toLowerCase();
  const category = labelIds.find((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l));
  if (category) s.gmailCategory = category.replace('CATEGORY_', '');
  return s;
}

/** The same facts read back from an emails row (one column each). */
export function emailSignals(r: {
  auto_submitted: string | null;
  list_unsubscribe: boolean;
  precedence: string | null;
  report_type: string | null;
  gmail_category: string | null;
}): MessageSignals {
  const s: MessageSignals = {};
  if (r.auto_submitted) s.autoSubmitted = r.auto_submitted;
  if (r.list_unsubscribe) s.listUnsubscribe = true;
  if (r.precedence) s.precedence = r.precedence;
  if (r.report_type) s.reportType = r.report_type;
  if (r.gmail_category) s.gmailCategory = r.gmail_category;
  return s;
}

export interface RuleInput {
  fromAddress: string;
  subject: string;
  bodyText: string;
  attachmentNames: string[];
  signals?: MessageSignals;
  /** Subject of an earlier SUBMISSION in the same Gmail thread: a reply there is almost always a follow-up. */
  threadSubmissionSubject?: string | null;
}

export interface RuleResult {
  score: number; // positive => submission, negative => not
  reasons: string[];
  decisive: Classification | null; // set when rules alone are conclusive
  /** Submission evidence the LLM must not overrule with a low-confidence Ignore (classification.ts). */
  submissionEvidence: boolean;
}

// A decisive rule score at the threshold, and how much each point past it adds to the confidence.
const SUBMISSION_SCORE = 9;
const NOT_SUBMISSION_SCORE = -4;

/**
 * Confidence of a rules-only verdict, from how far the score clears its threshold: 90% at +9 and 1 point per extra
 * point for a submission, 85% at -4 and 2 points per extra point for an ignore, both capped at 99%.
 */
export function ruleConfidence(decisive: Classification, score: number): number {
  const c =
    decisive === 'SUBMISSION' ? 0.9 + 0.01 * (score - SUBMISSION_SCORE) : 0.85 + 0.02 * (NOT_SUBMISSION_SCORE - score);
  return Math.round(Math.min(0.99, Math.max(0, c)) * 100) / 100;
}

// [pattern, weight, label]. Each reason quotes the text that matched, so a reviewer can check it.
const POSITIVE: [RegExp, number, string][] = [
  [/\b(?:new|renewal)?\s*submission\b/i, 3, 'mentions a submission'],
  [/\bapplication\b/i, 2, 'mentions an application'],
  [/\b(?:malpractice|professional liability|med\s*mal|MPL)\b/i, 3, 'mentions malpractice / professional liability'],
  [/\bloss\s*runs?\b/i, 3, 'mentions loss runs'],
  [/\b(?:quote|quotation|indication)\b/i, 2, 'asks for a quote / indication'],
  [/\bNPI\b/, 2, 'contains an NPI reference'],
  [/\b(?:effective date|eff\.? date|retro(?:active)? date)\b/i, 2, 'mentions an effective / retro date'],
  [/\b(?:limits?|1M\/3M|\$?1,?000,?000\s*\/\s*\$?3,?000,?000)\b/i, 1, 'mentions coverage limits'],
  [
    /\b(?:physician|surgeon|M\.?D\.?|D\.?O\.?|nurse practitioner|CRNA|clinic|practice)\b/,
    1,
    'healthcare provider terms',
  ],
];

// Words alone: they lower the score but never decide Ignore on their own (see STRUCTURAL below).
// "Out of office" or "sale" inside a person's message are deliberately absent: brokers write them too.
const NEGATIVE_WORDS: [RegExp, number, string][] = [
  [/\bunsubscribe\b/i, -3, 'contains an unsubscribe link'],
  [/\b(?:webinar|newsletter|promotion|% off)\b/i, -2, 'marketing language'],
  [/\b(?:invoice|receipt|payment confirmation|statement of account)\b/i, -2, 'billing language'],
];

// Subject lines that mail software writes for automatic messages. They repeat the original subject
// ("Read: Quote for Dr. Smith"), so they outweigh the submission words that subject may carry.
const AUTOMATIC_SUBJECT: [RegExp, number, string][] = [
  [
    /^\s*(?:accepted|declined|tentative(?:ly accepted)?|canceled|cancelled|updated invitation|invitation)\s*:/i,
    -8,
    'calendar response',
  ],
  [/^\s*read\s*:/i, -8, 'read receipt'],
  [/^\s*(?:automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office|autoreply)\b/i, -8, 'auto-reply'],
  [
    /^\s*(?:undeliverable|undelivered mail|delivery status notification|mail delivery (?:failed|failure))\b/i,
    -8,
    'bounce',
  ],
  [
    /\b(?:security alert|sign-?in attempt|new sign-?in|password (?:reset|changed)|verify your (?:email|account))\b/i,
    -5,
    'account or security alert',
  ],
];

// An acknowledgement and nothing else, after normalizeBody (lowercase, no punctuation, no quoted history).
const ACK_ONLY =
  /^(?:thanks?(?: you)?(?: (?:very|so) much)?|thx|ty|received|got it|noted|ok(?:ay)?|will do|great)(?: (?:received|thanks?(?: you)?|got it|noted))*$/;

const SUBMISSION_FILES =
  /(app(lication)?|acord|loss[\s_-]*runs?|supplement|questionnaire|dec(laration)?s?[\s_-]*page|cv|resume|license)/i;

const GMAIL_CATEGORY_WEIGHT: Record<string, number> = { PROMOTIONS: -4, SOCIAL: -4, FORUMS: -2, UPDATES: -1 };

const cite = (m: RegExpMatchArray) => `"${m[0].trim().slice(0, 60)}"`;

export function applyRules(input: RuleInput): RuleResult {
  const text = `${input.subject}\n${input.bodyText}`;
  const reasons: string[] = [];
  let score = 0;
  // Structural evidence: set by mail software, or the shape of the message, not just its wording.
  let structural = false;
  const add = (w: number, why: string, isStructural = false) => {
    score += w;
    reasons.push(`${w > 0 ? '+' : ''}${w}: ${why}`);
    if (isStructural) structural = true;
  };

  for (const [re, w, why] of [...POSITIVE, ...NEGATIVE_WORDS]) {
    const m = text.match(re);
    if (m) add(w, `${why} (${cite(m)})`);
  }
  const docHits = input.attachmentNames.filter((n) => SUBMISSION_FILES.test(n));
  if (docHits.length) add(Math.min(4, docHits.length * 2), `submission-like attachments (${docHits.join(', ')})`);

  for (const [re, w, why] of AUTOMATIC_SUBJECT) {
    const m = input.subject.match(re);
    if (m) add(w, `${why}: subject starts ${cite(m)}`, true);
  }
  const s = input.signals ?? {};
  if (s.autoSubmitted) add(-8, `automatic message: header Auto-Submitted "${s.autoSubmitted}"`, true);
  if (s.reportType === 'delivery-status') add(-8, 'bounce: delivery-status report', true);
  if (s.reportType === 'disposition-notification') add(-8, 'read receipt: disposition-notification report', true);
  if (s.listUnsubscribe) add(-3, 'sent by a mailing list or bulk mailer (List-Unsubscribe / List-Id header)', true);
  if (s.precedence) add(-3, `bulk mail: header Precedence "${s.precedence}"`, true);
  // Gmail's category is Google's own guess, not a fact about the message: it lowers the score but never decides.
  if (s.gmailCategory && GMAIL_CATEGORY_WEIGHT[s.gmailCategory]) {
    add(
      GMAIL_CATEGORY_WEIGHT[s.gmailCategory]!,
      `Gmail filed it under ${s.gmailCategory.charAt(0)}${s.gmailCategory.slice(1).toLowerCase()}`,
    );
  }

  if (input.attachmentNames.length && input.attachmentNames.every((n) => /\.ics$/i.test(n))) {
    add(-4, `only a calendar invite attached (${input.attachmentNames.join(', ')})`, true);
  }
  if (/no-?reply|do-?not-?reply|mailer-daemon|postmaster/i.test(input.fromAddress)) {
    add(
      input.attachmentNames.length ? -4 : -6,
      `automated sender address "${input.fromAddress}"${input.attachmentNames.length ? '' : ', no attachments'}`,
      true,
    );
  }
  // A forward's own text includes what it forwards; only a reply's quoted history is cut.
  const own = normalizeBody(input.bodyText, { forward: isForwardSubject(input.subject) });
  if (!input.attachmentNames.length && (!own || ACK_ONLY.test(own))) {
    add(-4, own ? `acknowledgement only ("${own}"), no attachments` : 'no text of its own and no attachments', true);
  }
  if (input.threadSubmissionSubject) add(4, `reply in the thread of submission "${input.threadSubmissionSubject}"`);

  const submissionEvidence = docHits.length > 0 || Boolean(input.threadSubmissionSubject);
  let decisive: Classification | null = null;
  if (score >= SUBMISSION_SCORE) decisive = 'SUBMISSION';
  // Ignore without asking Claude only on structural evidence, and never over submission documents or a submission thread.
  else if (score <= NOT_SUBMISSION_SCORE && structural && !submissionEvidence) decisive = 'NOT_SUBMISSION';
  return { score, reasons, decisive, submissionEvidence };
}
