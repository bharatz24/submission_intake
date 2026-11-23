// Admin-editable limits (Settings → Claude, Connections and Limits) and the upload pre-checks that use them.
// One table describes every key, so the three settings places and the upload screens agree on labels and units.
import { useQuery } from '@tanstack/react-query';

import { STALE_MS } from '../constants';
import { settingsKeys } from '../features/settings';
import { apiWith } from '../services/api';
import type { LimitsKey, LimitsSettings } from '../types';

export type LimitUnit = 'tokens' | 'MB' | 'files' | 'seconds' | 'minutes' | 'pages' | 'characters';

/** `hint` (optional) says what the limit covers; it leads the field's helper text. */
export const LIMIT_FIELDS: Record<LimitsKey, { label: string; unit: LimitUnit; hint?: string }> = {
  synthesisMaxTokens: { label: 'Synthesis report', unit: 'tokens' },
  analysisMaxTokens: { label: 'Analysis report', unit: 'tokens' },
  comparisonMaxTokens: { label: 'Report comparison', unit: 'tokens' },
  classificationMaxTokens: { label: 'Classification', unit: 'tokens' },
  extractionMaxTokens: { label: 'Field extraction', unit: 'tokens' },
  chatMaxTokens: { label: 'Chat answer', unit: 'tokens' },
  emailDraftMaxTokens: { label: 'Email draft', unit: 'tokens' },
  autoQuoteMaxTokens: { label: 'Automatic quote', unit: 'tokens' },
  uploadMaxFileMb: { label: 'Max size per file', unit: 'MB' },
  uploadMaxFiles: { label: 'Max files per upload', unit: 'files' },
  rateWorkbookMaxMb: { label: 'Rate workbook max size', unit: 'MB' },
  claudeResponseTimeoutMinutes: {
    label: 'Claude answer (overall)',
    unit: 'minutes',
    hint: 'The longest one Claude answer may take, start to finish',
  },
  npiTimeoutSeconds: { label: 'NPI registry', unit: 'seconds', hint: 'Lookups and status check' },
  driveTimeoutSeconds: { label: 'Google Drive', unit: 'seconds' },
  gmailTimeoutSeconds: { label: 'Gmail', unit: 'seconds' },
  connectionTestTimeoutSeconds: { label: 'Connection test', unit: 'seconds' },
  ocrMaxPages: { label: 'OCR pages per scanned PDF', unit: 'pages' },
  reportPerDocChars: { label: 'Text kept per document (reports)', unit: 'characters' },
  extractionPerDocChars: { label: 'Text kept per document (field extraction)', unit: 'characters' },
  classificationBodyChars: {
    label: 'Email text read for classification',
    unit: 'characters',
    hint: 'The start of the email body; attachments are not read there',
  },
};

export type LimitGroupKey = 'claudeOutput' | 'claudeTimeout' | 'timeouts' | 'uploads' | 'documentText';

export const LIMIT_GROUPS: Record<LimitGroupKey, { title: string; description: string; keys: LimitsKey[] }> = {
  claudeOutput: {
    title: 'Output limits',
    description: 'The most Claude may write for each task, its thinking included.',
    keys: [
      'synthesisMaxTokens',
      'analysisMaxTokens',
      'comparisonMaxTokens',
      'classificationMaxTokens',
      'extractionMaxTokens',
      'chatMaxTokens',
      'emailDraftMaxTokens',
      'autoQuoteMaxTokens',
    ],
  },
  claudeTimeout: {
    title: 'Timeout',
    description: 'How long the app waits for Claude to finish one answer before giving up on it.',
    keys: ['claudeResponseTimeoutMinutes'],
  },
  timeouts: {
    title: 'Timeouts',
    description: 'How long the app waits for a service to answer before giving up.',
    keys: ['npiTimeoutSeconds', 'driveTimeoutSeconds', 'gmailTimeoutSeconds', 'connectionTestTimeoutSeconds'],
  },
  uploads: {
    title: 'Uploads',
    description: 'The largest files and the most files one upload may carry.',
    keys: ['uploadMaxFileMb', 'uploadMaxFiles', 'rateWorkbookMaxMb'],
  },
  documentText: {
    title: 'Document text & OCR',
    description:
      'How much of each document is read, and how much of its text classification, field extraction and reports use.',
    keys: ['ocrMaxPages', 'reportPerDocChars', 'extractionPerDocChars', 'classificationBodyChars'],
  },
};

/** The current limits, shared by Settings and the upload screens. */
export function useLimits() {
  return useQuery({
    queryKey: settingsKeys.limits(),
    queryFn: ({ signal }) => apiWith(signal).limitsSettings(),
    staleTime: STALE_MS.limits,
  });
}

export const formatLimit = (n: number) => n.toLocaleString('en-US');

/** "Default 4,000 · allowed 1,000–8,000", after the field's hint when it has one. */
export function limitHelper(s: LimitsSettings, key: LimitsKey): string {
  const b = s.bounds[key];
  const hint = LIMIT_FIELDS[key].hint;
  return `${hint ? `${hint}. ` : ''}Default ${formatLimit(s.defaults[key])} · allowed ${formatLimit(b.min)}–${formatLimit(b.max)}`;
}

/** Field errors for the shown values of `keys`: whole numbers within bounds. `value` gives a key's shown number (NaN when not a whole number). */
export function limitErrors(
  s: LimitsSettings,
  keys: LimitsKey[],
  value: (k: LimitsKey) => number,
): Partial<Record<LimitsKey, string>> {
  const out: Partial<Record<LimitsKey, string>> = {};
  for (const k of keys) {
    const n = value(k);
    const b = s.bounds[k];
    if (!Number.isInteger(n)) out[k] = 'Enter a whole number';
    else if (n < b.min || n > b.max)
      out[k] = `Enter a whole number from ${formatLimit(b.min)} to ${formatLimit(b.max)}`;
  }
  return out;
}

// ---- Upload pre-checks. Limits not loaded yet: nothing is blocked, the server still enforces them.

const MB = 1024 * 1024;

export interface UploadLimit {
  maxFileMb: number;
  maxFiles?: number;
}

/** Submission documents: per-file size and files per upload. */
export const documentUploadLimit = (s: LimitsSettings | undefined): UploadLimit | null =>
  s ? { maxFileMb: s.values.uploadMaxFileMb, maxFiles: s.values.uploadMaxFiles } : null;

/** Attachments of one outgoing email (Gmail's limit, not a setting); null until the limits are loaded. */
export const outboundAttachmentLimit = (s: LimitsSettings | undefined): number | null =>
  s?.fixed.outboundAttachmentMaxBytes ?? null;

/** A rate workbook: size only, one file at a time. */
export const workbookUploadLimit = (s: LimitsSettings | undefined): UploadLimit | null =>
  s ? { maxFileMb: s.values.rateWorkbookMaxMb } : null;

/** "Up to 20 files, 25 MB each" */
export const uploadCaption = (l: UploadLimit): string =>
  l.maxFiles != null
    ? `Up to ${formatLimit(l.maxFiles)} files, ${formatLimit(l.maxFileMb)} MB each`
    : `Up to ${formatLimit(l.maxFileMb)} MB`;

/** Why these files cannot be uploaded, naming the files and the limit; null when they can (or limits are unknown). */
export function uploadProblem(files: File[], l: UploadLimit | null): string | null {
  if (!l) return null;
  const problems: string[] = [];
  if (l.maxFiles != null && files.length > l.maxFiles) {
    problems.push(`${files.length} files chosen; one upload can carry up to ${formatLimit(l.maxFiles)}.`);
  }
  const big = files.filter((f) => f.size > l.maxFileMb * MB);
  if (big.length) {
    const names = big.map((f) => `${f.name} (${(f.size / MB).toFixed(1)} MB)`).join(', ');
    problems.push(
      `${big.length === 1 ? 'This file is' : 'These files are'} over the ${formatLimit(l.maxFileMb)} MB limit: ${names}.`,
    );
  }
  return problems.length ? problems.join(' ') : null;
}
