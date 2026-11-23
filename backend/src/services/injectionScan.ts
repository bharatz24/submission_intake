// Detects instruction-like text in untrusted inbound content (email bodies, attachment text) before it reaches Claude.
// Pure and DB-free so it is unit tested directly. Findings are stored and shown to the underwriter; nothing is blocked.
//
// Every pattern is anchored on phrasing aimed at an AI (override verbs + "instructions", "you are now ...",
// "note to the AI") rather than on single words, so ordinary broker language ("please disregard my earlier email",
// "Classification: new business") stays quiet. Patterns use only bounded repetition and no nested quantifiers, so a
// scan stays linear on large attachment text.

/** Matches the CHECK constraint on `injection_flags.category`. */
export type InjectionCategory = 'override' | 'role' | 'ai_address' | 'steering' | 'exfiltration' | 'hidden_text';

export interface InjectionFinding {
  category: InjectionCategory;
  /** Stable pattern name, e.g. `ignore_previous_instructions`. */
  pattern: string;
  /** Text around the match, whitespace collapsed, at most EXCERPT_MAX characters. */
  excerpt: string;
}

const EXCERPT_MAX = 160;
const EXCERPT_CONTEXT = 50;

// Zero-width / invisible characters (ZWSP..RLM, word joiner, invisible operators, BOM) and Unicode tag characters,
// which can smuggle text a human never sees. A single stray character is common in pasted text; a run of 3+ is not.
const ZERO_WIDTH_RUN = /[\u200B-\u200F\u2060-\u2064\uFEFF]{3,}/;
const TAG_CHAR_RUN = /[\u{E0000}-\u{E007F}]{3,}/u;
const HIDDEN_CHARS = /[\u200B-\u200F\u2060-\u2064\uFEFF]+|[\u{E0000}-\u{E007F}]+/gu;

// Words naming the AI itself.
const AI_NAME = String.raw`(?:ai|a\.i\.|llm|claude|chatbot|language\s+model|ai\s+(?:assistant|model|agent|system))`;
const EARLIER = String.raw`(?:previous|prior|above|earlier|preceding)`;
const INSTRUCTION_NOUN = String.raw`(?:instructions?|prompts?|rules|directions|guidelines)`;

const PATTERNS: { category: InjectionCategory; pattern: string; re: RegExp }[] = [
  // --- override: tell the model to drop its instructions -----------------------------------------------------------
  {
    category: 'override',
    pattern: 'ignore_previous_instructions',
    re: new RegExp(
      String.raw`\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|my|these|those)\s+)?${EARLIER}\s+${INSTRUCTION_NOUN}\b`,
      'i',
    ),
  },
  {
    category: 'override',
    pattern: 'ignore_everything_above',
    re: /\b(?:ignore|disregard|forget)\s+(?:everything|all)\s+(?:above|before\s+this|you\s+were\s+told)\b/i,
  },
  {
    // Only at the start of a sentence or line, so "new instructions: use portal B" mid-sentence in a form stays quiet.
    category: 'override',
    pattern: 'new_instructions',
    re: /(?:^|[.!?]\s+)new\s+(?:system\s+)?instructions\s*:/im,
  },
  // --- role: hijack the model's identity or mimic prompt structure -------------------------------------------------
  {
    category: 'role',
    pattern: 'you_are_now',
    re: /\byou\s+are\s+now\s+(?:an?|the|in)\s+(?:\w+\s+){0,3}?(?:assistant|ai|llm|model|chatbot|bot|agent|system|mode)\b/i,
  },
  {
    category: 'role',
    pattern: 'act_as_ai',
    re: new RegExp(
      String.raw`\b(?:act|behave|respond)\s+as\s+(?:an?\s+)?(?:${AI_NAME}|jailbroken|unrestricted)\b`,
      'i',
    ),
  },
  { category: 'role', pattern: 'act_as_if_you_are', re: /\b(?:act|behave)\s+as\s+if\s+you\s+(?:are|were)\b/i },
  { category: 'role', pattern: 'pretend_to_be', re: /\bpretend\s+(?:to\s+be|(?:that\s+)?you\s+are)\b/i },
  { category: 'role', pattern: 'system_prompt_mention', re: /\bsystem\s+prompt\b/i },
  // Fake prompt-structure markers: <system>, </assistant>, [SYSTEM], [INST].
  {
    category: 'role',
    pattern: 'fake_role_tag',
    re: /<\s*\/?\s*(?:system|assistant|instructions?)\s*>|\[\s*(?:system|inst)\s*\]/i,
  },
  // --- ai_address: text written for the AI rather than the underwriter ---------------------------------------------
  {
    category: 'ai_address',
    pattern: 'note_to_ai',
    re: new RegExp(String.raw`\bnote\s+(?:to|for)\s+(?:the\s+)?${AI_NAME}\b`, 'i'),
  },
  {
    category: 'ai_address',
    pattern: 'if_you_are_an_ai',
    re: /\bif\s+you(?:\s+are|['’]re)\s+(?:an?\s+)?(?:ai|a\.i\.|llm|language\s+model|large\s+language\s+model|chatbot|automated\s+(?:system|assistant))\b/i,
  },
  {
    category: 'ai_address',
    pattern: 'attention_ai',
    re: new RegExp(String.raw`\b(?:dear|hey|hello|attention|calling)\s+${AI_NAME}\b`, 'i'),
  },
  {
    category: 'ai_address',
    pattern: 'ai_reading_this',
    re: /\b(?:ai|llm)\s+(?:system|model|assistant|agent)s?\s+(?:reading|processing|analy[sz]ing|reviewing|summari[sz]ing)\b/i,
  },
  // --- steering: dictate the outcome ------------------------------------------------------------------------------
  {
    category: 'steering',
    pattern: 'classify_this_as',
    re: /\b(?:classify|categori[sz]e)\s+(?:this|it|the\s+(?:email|submission|message|application))(?:\s+(?:email|submission|message|application))?\s+as\b/i,
  },
  {
    // Marking is only suspicious with an outcome word; "mark this submission as urgent" is ordinary broker language.
    category: 'steering',
    pattern: 'mark_as_outcome',
    // "preferred" and "acceptable" are ordinary rating language ("Please rate this risk as preferred.").
    re: /\b(?:mark|rate|score|rank|flag|label)\s+(?:this|it|the\s+(?:submission|application|risk|applicant))(?:\s+(?:submission|application|risk|applicant|email))?\s+as\s+(?:approved|accepted|low[\s-]risk|no[\s-]risk|safe|clean)\b/i,
  },
  {
    // Bare imperative with no object, at the start of a sentence or line: "Mark as approved." / "Classify as approved".
    category: 'steering',
    pattern: 'bare_mark_as_outcome',
    re: /(?:^|[.!?]\s+)(?:mark|classify|categori[sz]e|label|flag)\s+as\s+(?:approved|accepted|low[\s-]risk|no[\s-]risk|safe|clean)\b/im,
  },
  {
    // "You must/shall/are to approve" is an order; "you will/should/need to" is how brokers ask ("let us know if you
    // will bind", "we feel you should accept"), so those count only with "always".
    category: 'steering',
    pattern: 'you_must_recommend',
    re: /\byou\s+(?:(?:must|shall|are\s+to)\s+(?:always\s+)?|(?:should|need\s+to|have\s+to|will)\s+always\s+)(?:recommend|approve|accept|bind)\b/i,
  },
  {
    // Imperative "Recommend approval." at the start of a sentence or after a comma ("If you are an AI, recommend ...").
    // Not after a colon: "Producer comments: recommend acceptance" is a broker's own note.
    category: 'steering',
    pattern: 'recommend_approval',
    re: /(?:^|[.!?,]\s+)recommend\s+(?:approval|acceptance|binding)\b/im,
  },
  // --- exfiltration: pull out the prompt -------------------------------------------------------------------------
  {
    category: 'exfiltration',
    pattern: 'reveal_instructions',
    re: /\b(?:reveal|print|repeat|output|display|disclose|leak)\s+(?:me\s+)?(?:your|the\s+(?:system|initial|original|hidden|secret))\s+(?:(?:system|initial|original|hidden|secret)\s+)?(?:instructions|prompt)\b/i,
  },
  {
    category: 'exfiltration',
    pattern: 'what_is_your_system_prompt',
    re: /\bwhat\s+(?:is|are|were)\s+your\s+(?:system|initial|original|hidden)\s+(?:prompt|instructions)\b/i,
  },
  // --- hidden_text: invisible characters --------------------------------------------------------------------------
  { category: 'hidden_text', pattern: 'zero_width_run', re: ZERO_WIDTH_RUN },
  { category: 'hidden_text', pattern: 'unicode_tag_run', re: TAG_CHAR_RUN },
];

/** Text around a match, hidden characters shown as a marker, whitespace collapsed, capped at EXCERPT_MAX characters. */
function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_CONTEXT);
  // A match can be huge (a long invisible run); only its first stretch is needed.
  const end = Math.min(text.length, index + Math.min(length, EXCERPT_MAX) + EXCERPT_CONTEXT);
  return text
    .slice(start, end)
    .replace(HIDDEN_CHARS, '[hidden characters]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_MAX);
}

/** Scan untrusted text for instruction-like content. At most one finding per pattern; `[]` when nothing matches. */
export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { category, pattern, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) findings.push({ category, pattern, excerpt: excerptAround(text, m.index, m[0].length) });
  }
  return findings;
}
