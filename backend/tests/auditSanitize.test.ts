/** DB-01 / CQ-03: what audit() stores of the details it is given (no database). */
import { describe, expect, it } from 'vitest';

import { auditErrorText, sanitizeAuditDetails } from '../src/services/audit.js';
import { auditBasis } from '../src/services/duplicates.js';
import { manualFieldRef } from '../src/services/fields.js';

describe('sanitizeAuditDetails', () => {
  it('drops keys that carry applicant content, at any depth, counting lists', () => {
    expect(
      sanitizeAuditDetails({
        fieldName: 'applicant_name',
        value: 'Jane Roe',
        filename: 'Jane_Roe.pdf',
        subject: 'Jane Roe application',
        originalSubject: 'Jane Roe',
        claimedName: 'Jane Roe',
        previousBasis: {
          rule: 'R5',
          sharedAttachments: ['a.pdf', 'b.pdf'],
          explanation: 'Jane Roe',
          addedWords: ['jane'],
        },
        attachments: ['Jane_Roe.pdf'],
      }),
    ).toEqual({
      fieldName: 'applicant_name',
      previousBasis: { rule: 'R5', sharedAttachmentsCount: 2, addedWordsCount: 1 },
      attachmentsCount: 1,
    });
  });

  it('keeps a numeric attachments count', () => {
    expect(sanitizeAuditDetails({ attachments: 3 })).toEqual({ attachments: 3 });
  });

  it('cuts an NPI to its last four digits and scrubs PII patterns from other strings', () => {
    const out = sanitizeAuditDetails({
      npi: '1234567893',
      reason: 'Called jane@clinic.com on (512) 555-0100 about NPI 1234567893, SSN 123-45-6789',
      nested: [{ from: 'jane@clinic.com' }],
    });
    expect(out.npiLast4).toBe('7893');
    expect(out).not.toHaveProperty('npi');
    const text = JSON.stringify(out);
    for (const v of ['jane@clinic.com', '555-0100', '1234567893', '123-45-6789']) expect(text).not.toContain(v);
  });

  it('keeps staff emails under `email` and non-string values as they are', () => {
    expect(sanitizeAuditDetails({ email: 'uw@acme.com', count: 2, ok: true, none: null })).toEqual({
      email: 'uw@acme.com',
      count: 2,
      ok: true,
      none: null,
    });
  });
});

describe('audit references', () => {
  it('auditErrorText keeps the message only, scrubbed', () => {
    const err = new Error('Could not read jane@clinic.com attachment');
    const text = auditErrorText(err);
    expect(text).not.toContain('jane@clinic.com');
    expect(text).not.toContain('at '); // no stack
  });

  it('manualFieldRef records lengths and presence, never the value or note', () => {
    expect(manualFieldRef('applicant_name', 'Jane Roe', 'from the cover letter', 'd1')).toEqual({
      fieldName: 'applicant_name',
      valueLength: 8,
      hasNote: true,
      documentId: 'd1',
    });
  });

  it('auditBasis keeps the rule and counts, not the evidence', () => {
    const ref = auditBasis({
      rule: 'R5',
      strength: 'HIGH',
      similarity: 0.9,
      sharedAttachments: ['Jane.pdf'],
      daysSinceOriginal: 2,
      originalId: 'o1',
      method: 'AUTO',
      explanation: 'Jane',
      addedWords: ['a', 'b'],
      removedWords: [],
    });
    expect(ref).toEqual({
      rule: 'R5',
      strength: 'HIGH',
      similarity: 0.9,
      method: 'AUTO',
      originalId: 'o1',
      daysSinceOriginal: 2,
      differentSender: null,
      sharedAttachmentCount: 1,
      addedWordCount: 2,
      removedWordCount: 0,
    });
    expect(JSON.stringify(ref)).not.toContain('Jane');
  });
});
