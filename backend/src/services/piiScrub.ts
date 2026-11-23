import { redactPii } from './promptSafety.js';

/**
 * Free text that must be logged or kept as an error message (client error reports, error messages and stacks, system
 * errors) loses the personal data it may carry from submissions: what redactPii removes from prompts (SSNs, labelled
 * dates of birth, bank/routing numbers), plus email addresses, 10-digit NPIs and US phone numbers. DB-free so it is
 * unit tested directly (tests/piiScrub.test.ts).
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phones first: a phone written as ten bare digits is indistinguishable from an NPI and is caught by NPI below.
// (512) 555-0100, 512-555-0100, 512.555.0100, 512 555 0100, with an optional +1 / 1- prefix.
const PHONE = /(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g;
const NPI = /\b\d{10}\b/g;

export function scrubText(s: string): string {
  return redactPii(s)
    .replace(EMAIL, '[REDACTED-EMAIL]')
    .replace(PHONE, '[REDACTED-PHONE]')
    .replace(NPI, '[REDACTED-NPI]');
}
