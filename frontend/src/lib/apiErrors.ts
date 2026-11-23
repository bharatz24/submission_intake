// Readable lines from an ApiError's `details`, so a 400 shows *what* was invalid rather than just
// "Some of the values sent are not valid". Handles the shapes the API sends: zod's flattenError
// ({ formErrors, fieldErrors }), { problems: string[] } and { invalid: string[] }.
import { MAX_ERROR_LINES } from '../constants';
import { ApiError, errorMessage } from '../services/api';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Human-readable detail lines for an error (empty when it carries none). */
export function errorDetails(err: unknown): string[] {
  if (!(err instanceof ApiError) || !err.details || typeof err.details !== 'object') return [];
  const d = err.details as Record<string, unknown>;
  const lines: string[] = [...strings(d.formErrors)];
  if (d.fieldErrors && typeof d.fieldErrors === 'object') {
    for (const [field, msgs] of Object.entries(d.fieldErrors as Record<string, unknown>)) {
      for (const m of strings(msgs)) lines.push(`${field}: ${m}`);
    }
  }
  lines.push(...strings(d.problems));
  const invalid = strings(d.invalid);
  if (invalid.length) lines.push(`Invalid: ${invalid.join(', ')}`);
  // Never repeat what the message already says (e.g. the rate importer lists its problems in the message too).
  const message = err.message;
  const unique = [...new Set(lines)].filter((l) => !message.includes(l));
  return unique.length > MAX_ERROR_LINES
    ? [...unique.slice(0, MAX_ERROR_LINES), `… and ${unique.length - MAX_ERROR_LINES} more`]
    : unique;
}

/** The error message followed by its detail lines, one per line (render with `white-space: pre-line`). */
export function errorWithDetails(err: unknown): string {
  return [errorMessage(err), ...errorDetails(err)].join('\n');
}
