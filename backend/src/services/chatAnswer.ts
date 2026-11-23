/**
 * Clean-up applied to a workspace-chat answer before it is stored.
 *
 * When an underwriter asks an out-of-scope arithmetic question ("1 + 1"), the model sometimes answers it and then
 * gives the scope reply anyway: "2. I can only help with this submission's file …". Only that leading result is
 * removed; the scope reply itself, and every other answer (numbered lists included), is left exactly as written.
 */

/** Start of the out-of-scope reply the workspace-chat skill gives. */
const SCOPE_REPLY = String.raw`I\s+can\s+only\s+help\b`;

/** Optional markdown emphasis the model may wrap the result in ("**4.**"). */
const EMPHASIS = String.raw`(?:\*{1,2}|_{1,2})?`;

/**
 * An optional echoed expression ("1 + 1 =") followed by a number ("2", "-3", "1,000", "2.5"), its trailing
 * punctuation ("." ":" ")" or a dash), optional emphasis markers and whitespace, directly before the scope reply.
 */
const ARITHMETIC_PREFIX = new RegExp(
  String.raw`^\s*${EMPHASIS}\s*(?:[\d\s.,+\-*/×÷^()]*=\s*)?[-+]?\d[\d,]*(?:\.\d+)?${EMPHASIS}\s*[.:)\-–—]?\s*${EMPHASIS}\s*(?=${SCOPE_REPLY})`,
  'i',
);

export function stripArithmeticPrefix(answer: string): string {
  return answer.replace(ARITHMETIC_PREFIX, '');
}
