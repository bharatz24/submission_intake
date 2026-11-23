import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { applyRules, messageSignals, ruleConfidence } from '../src/services/classificationRules.js';
import { decrypt, encrypt } from '../src/services/crypto.js';
import { withUniqueLabels } from '../src/services/fieldExtraction.js';
import * as fileCache from '../src/services/fileCache.js';
import { htmlToText, walkParts } from '../src/services/gmail.js';
import {
  listedAttachments,
  McpMessageNotFound,
  parseMessageResult,
  parseSearchResult,
} from '../src/services/gmailMcp.js';
import { callStatus } from '../src/services/llmUsage.js';
import {
  compareNpi,
  compareNpiToProviders,
  findNpis,
  isValidNpi,
  parseProviderName,
  registryStructuredName,
  resolveCandidates,
  structureName,
  zip5,
} from '../src/services/npi.js';
import { prepareAttachments } from '../src/services/pipeline.js';
import {
  AnalysisSchema,
  renderAnalysisMarkdown,
  renderSynthesisMarkdown,
  SynthesisSchema,
} from '../src/services/reportSchemas.js';
import { listSkills, loadSkill } from '../src/services/skills.js';
import { previewMimeType } from '../src/services/storage.js';
import { detectKind, extractText } from '../src/services/textExtraction.js';

describe('NPI', () => {
  it('validates Luhn check digit', () => {
    expect(isValidNpi('1234567893')).toBe(true);
    expect(isValidNpi('1234567890')).toBe(false);
    expect(isValidNpi('123')).toBe(false);
  });

  it('finds NPIs in free text', () => {
    expect(findNpis('Provider NPI: 1234567893, phone 5551234567')).toEqual(['1234567893']);
  });

  const registry = {
    found: true,
    result: {
      enumeration_type: 'NPI-1',
      basic: { first_name: 'JANE', last_name: 'SMITH', status: 'A' },
      taxonomies: [{ primary: true, desc: 'Obstetrics & Gynecology', state: 'TX' }],
      addresses: [{ address_purpose: 'LOCATION', state: 'TX' }],
    },
  };

  it('matches name/state/specialty', () => {
    const r = compareNpi(
      { npi: '1234567893', name: 'Dr. Jane Smith, MD', state: 'TX', specialty: 'Obstetrics' },
      registry,
    );
    expect(r.status).toBe('MATCH');
    expect(r.registryName).toBe('JANE SMITH');
  });

  it('flags state and specialty differences as partial', () => {
    const r = compareNpi({ npi: '1234567893', name: 'Jane Smith', state: 'CA', specialty: 'Neurosurgery' }, registry);
    expect(r.status).toBe('PARTIAL_MATCH');
    expect(r.mismatches).toHaveLength(2);
  });

  it('flags a different person as mismatch', () => {
    expect(compareNpi({ npi: '1234567893', name: 'Robert Jones' }, registry).status).toBe('MISMATCH');
  });

  it('reports not found', () => {
    expect(compareNpi({ npi: '1234567893' }, { found: false, result: null }).status).toBe('NOT_FOUND');
  });

  it('says why a number failing the check digit cannot be found', () => {
    const r = compareNpi({ npi: '1234567894' }, { found: false, result: null });
    expect(r.status).toBe('NOT_FOUND');
    expect(r.mismatches[0]).toMatch(/check digit/i);
  });

  // A group submission names several providers; the fields do not say which NPI is whose (F-01).
  const providers = {
    names: ['Dr. Michael Anderson', 'Dr. Jane Smith'],
    states: ['CA', 'TX'],
    specialties: ['Internal Medicine', 'Obstetrics'],
  };

  it('compares a group NPI with the listed provider it belongs to', () => {
    const { claim, result } = compareNpiToProviders('1234567893', providers, registry);
    expect(result.status).toBe('MATCH');
    expect(claim).toEqual({ npi: '1234567893', name: 'Dr. Jane Smith', state: 'TX', specialty: 'Obstetrics' });
  });

  it('still flags a group NPI that belongs to none of the listed providers', () => {
    const { result } = compareNpiToProviders(
      '1234567893',
      { names: ['Dr. Michael Anderson', 'Dr. Robert Jones'], states: ['CA'], specialties: ['Internal Medicine'] },
      registry,
    );
    expect(result.status).toBe('MISMATCH');
  });
});

describe('NPI name + ZIP search', () => {
  it('parses provider names', () => {
    expect(parseProviderName('Dr. Jane Q. Smith, M.D.')).toEqual({ first: 'Jane', last: 'Smith' });
    expect(parseProviderName('Travis White, Psy.D.')).toEqual({ first: 'Travis', last: 'White' });
    expect(parseProviderName('Timothy Johnson, PA')).toEqual({ first: 'Timothy', last: 'Johnson' });
    expect(parseProviderName('Anh Do, MD')).toEqual({ first: 'Anh', last: 'Do' });
    expect(parseProviderName('Roisin Allaeddini (Esthetician, additional insured)')).toEqual({
      first: 'Roisin',
      last: 'Allaeddini',
    });
    expect(parseProviderName('KEM Health, LLC')).toEqual({ org: 'KEM Health' });
    expect(parseProviderName('Calla Slim Spa LLC dba Calla Slimspa Medical Weight Loss Center')).toEqual({
      org: 'Calla Slim Spa',
    });
  });

  it('splits names by type', () => {
    expect(structureName('Dr. Jane Q. Smith, M.D.')).toEqual({
      type: 'INDIVIDUAL',
      firstName: 'Jane',
      lastName: 'Smith',
      entityName: null,
    });
    expect(structureName('Anh Do, MD')).toEqual({
      type: 'INDIVIDUAL',
      firstName: 'Anh',
      lastName: 'Do',
      entityName: null,
    });
    expect(structureName('KEM Health, LLC')).toEqual({
      type: 'ORGANIZATION',
      firstName: null,
      lastName: null,
      entityName: 'KEM Health, LLC',
    });
    expect(structureName('Calla Slim Spa LLC dba Calla Slimspa Medical Weight Loss Center')).toEqual({
      type: 'ORGANIZATION',
      firstName: null,
      lastName: null,
      entityName: 'Calla Slim Spa LLC',
    });
    expect(structureName('Smith')).toEqual({
      type: 'INDIVIDUAL',
      firstName: null,
      lastName: 'Smith',
      entityName: null,
    });
    expect(structureName('  ')).toEqual({ type: null, firstName: null, lastName: null, entityName: null });
    expect(structureName(null).type).toBeNull();
  });

  it('splits registry names by enumeration type', () => {
    expect(
      registryStructuredName({ enumeration_type: 'NPI-1', basic: { first_name: 'JANE', last_name: 'SMITH' } }),
    ).toEqual({ type: 'INDIVIDUAL', firstName: 'JANE', lastName: 'SMITH', entityName: null });
    expect(
      registryStructuredName({ enumeration_type: 'NPI-2', basic: { organization_name: 'KEM HEALTH LLC' } }),
    ).toEqual({ type: 'ORGANIZATION', firstName: null, lastName: null, entityName: 'KEM HEALTH LLC' });
    expect(registryStructuredName(null).type).toBeNull();
  });

  it('reads 5-digit ZIPs', () => {
    expect(zip5('123 Main St, Tampa, FL 33602-1234')).toBe('33602');
    expect(zip5('no zip here')).toBeNull();
  });

  const cand = (number: string, desc: string) => ({
    number,
    basic: { first_name: 'JOHN', last_name: 'SMITH' },
    taxonomies: [{ primary: true, desc }],
  });

  it('verifies a single hit', () => {
    expect(resolveCandidates([cand('1', 'Family Medicine')], 'Cardiology').match?.number).toBe('1');
  });

  it('uses specialty to pick between several hits', () => {
    const r = resolveCandidates(
      [cand('1', 'Family Medicine'), cand('2', 'Cardiovascular Disease')],
      'Cardiovascular surgery',
    );
    expect(r.match?.number).toBe('2');
  });

  it('is not verified when nothing or several still match', () => {
    expect(resolveCandidates([], 'Pediatrics').match).toBeNull();
    expect(resolveCandidates([cand('1', 'Pediatrics'), cand('2', 'Pediatrics')], 'Pediatrics').match).toBeNull();
    expect(resolveCandidates([cand('1', 'Pediatrics'), cand('2', 'Pediatrics')], null).match).toBeNull();
    expect(resolveCandidates([cand('1', 'Pediatrics'), cand('2', 'Dermatology')], 'Neurology').match).toBeNull();
  });
});

describe('classification rules', () => {
  it('is decisive for a clear submission', () => {
    const r = applyRules({
      fromAddress: 'broker@agency.com',
      subject: 'New submission - Dr. Smith OB/GYN professional liability',
      bodyText: 'Attached application and loss runs. NPI 1234567893. Effective date 2026-01-01, limits 1M/3M.',
      attachmentNames: ['application.pdf', 'loss_runs.xlsx'],
    });
    expect(r.decisive).toBe('SUBMISSION');
  });

  it('is decisive for an auto-reply', () => {
    const r = applyRules({
      fromAddress: 'mailer-daemon@x.com',
      subject: 'Automatic reply: out of office',
      bodyText: 'I am out of office',
      attachmentNames: [],
    });
    expect(r.decisive).toBe('NOT_SUBMISSION');
  });

  it('scales rules-only confidence with how far the score clears its threshold', () => {
    expect(ruleConfidence('NOT_SUBMISSION', -4)).toBe(0.85);
    expect(ruleConfidence('NOT_SUBMISSION', -8)).toBe(0.93);
    expect(ruleConfidence('NOT_SUBMISSION', -30)).toBe(0.99);
    expect(ruleConfidence('SUBMISSION', 9)).toBe(0.9);
    expect(ruleConfidence('SUBMISSION', 14)).toBe(0.95);
    expect(ruleConfidence('SUBMISSION', 40)).toBe(0.99);
  });

  it('leaves ambiguous mail to the LLM', () => {
    const r = applyRules({
      fromAddress: 'a@b.com',
      subject: 'Question',
      bodyText: 'Can you call me about the practice?',
      attachmentNames: [],
    });
    expect(r.decisive).toBeNull();
  });

  describe('ignores on structural evidence, and says which', () => {
    const base = { fromAddress: 'someone@agency.com', bodyText: 'See you then.', attachmentNames: [] as string[] };
    const ignored = (input: Partial<Parameters<typeof applyRules>[0]> & { subject: string }) => {
      const r = applyRules({ ...base, ...input });
      expect(r.decisive).toBe('NOT_SUBMISSION');
      return r.reasons;
    };
    it('calendar responses and read receipts, even when they repeat a submission subject', () => {
      expect(ignored({ subject: 'Accepted: Renewal call' })).toContain(
        '-8: calendar response: subject starts "Accepted:"',
      );
      expect(ignored({ subject: 'Read: Quote for Dr. Smith' })).toContain('-8: read receipt: subject starts "Read:"');
      ignored({ subject: 'Call', attachmentNames: ['invite.ics'] });
    });
    it('auto-replies and bounces, by subject or by header', () => {
      ignored({ subject: 'Automatic reply: Renewal - Dr. Smith' });
      ignored({ subject: 'Undeliverable: New submission' });
      expect(ignored({ subject: 'Re: quote', signals: { autoSubmitted: 'auto-replied' } })).toContain(
        '-8: automatic message: header Auto-Submitted "auto-replied"',
      );
      ignored({ subject: 'Delivery report', signals: { reportType: 'delivery-status' } });
      ignored({ subject: 'Your quote', signals: { reportType: 'disposition-notification' } });
    });
    it('bulk mail: mailing-list headers plus marketing words', () => {
      expect(
        ignored({
          subject: 'Monthly webinar',
          bodyText: 'Join our webinar. Unsubscribe here.',
          signals: { listUnsubscribe: true },
        }),
      ).toContain('-3: contains an unsubscribe link ("Unsubscribe")');
    });
    it('security alerts, automated senders and bare acknowledgements', () => {
      ignored({ subject: 'Security alert for your account' });
      ignored({ fromAddress: 'noreply@vendor.com', subject: 'Your statement' });
      expect(
        ignored({
          subject: 'Re: hello',
          bodyText: 'Thanks, received!\n\nSent from my iPhone\n\nOn Mon Bob wrote:\n> talk soon',
        }),
      ).toContain('-4: acknowledgement only ("thanks received"), no attachments');
    });
  });

  describe('underwriting relevance is for Claude to judge', () => {
    const rule = (subject: string, bodyText: string) =>
      applyRules({ fromAddress: 'someone@gmail.com', subject, bodyText, attachmentNames: [] });

    it.each([
      ['Test', 'testing'],
      ['Submission', 'Test'],
      ['Submission', ''],
      ['Hello', 'Hi'],
      ['Lunch', 'Can we meet tomorrow?'],
      ['Quote for Dr. Lee', 'test'],
    ])('the rules do not decide %j / %j', (subject, body) => {
      expect(rule(subject, body).decisive).toBeNull();
    });
  });

  describe('never ignores on weak evidence', () => {
    it('keywords alone go to Claude: a broker who mentions an invoice and a promotion', () => {
      const r = applyRules({
        fromAddress: 'broker@agency.com',
        subject: 'Invoice and promotion',
        bodyText: 'Our invoice is attached; also a promotion on renewals.',
        attachmentNames: [],
      });
      expect(r.score).toBeLessThanOrEqual(-4);
      expect(r.decisive).toBeNull();
    });
    it("Gmail's Promotions category alone: it is Google's guess, not a fact about the message", () => {
      const r = applyRules({
        fromAddress: 'broker@agency.com',
        subject: 'Dr. Lee',
        bodyText: 'See you then.',
        attachmentNames: [],
        signals: { gmailCategory: 'PROMOTIONS' },
      });
      expect(r.score).toBeLessThanOrEqual(-4);
      expect(r.decisive).toBeNull();
    });
    it('an Outlook forward without a note: the forwarded text is its content', () => {
      const body =
        'From: Jane Client <jane@hospital.org>\nSent: Monday, October 26, 2026 9:00 AM\nTo: Bob Broker\nSubject: Dr. Jones\n\n' +
        'Hi Bob, can you get cover for our new doctor starting next month? Thanks Jane';
      const r = applyRules({
        fromAddress: 'bob@broker.com',
        subject: 'FW: Dr. Jones',
        bodyText: body,
        attachmentNames: [],
      });
      expect(r.reasons.join(' ')).not.toContain('no text of its own');
      expect(r.decisive).toBeNull();
    });
    it('a broker writing "out of office" in their own message', () => {
      const r = applyRules({
        fromAddress: 'broker@agency.com',
        subject: 'Dr. Lee',
        bodyText: 'I will be out of office next week, please send the quote by Friday.',
        attachmentNames: [],
      });
      expect(r.reasons.join(' ')).not.toContain('auto-reply');
      expect(r.decisive).toBeNull();
    });
    it('submission documents, even from a bulk mailer', () => {
      const r = applyRules({
        fromAddress: 'noreply@portal.com',
        subject: 'Your upload',
        bodyText: 'Unsubscribe',
        attachmentNames: ['Application.pdf'],
        signals: { listUnsubscribe: true },
      });
      expect(r.submissionEvidence).toBe(true);
      expect(r.decisive).toBeNull();
    });
    it('a reply in a submission thread', () => {
      const r = applyRules({
        fromAddress: 'broker@agency.com',
        subject: 'Re: New submission - Dr. Smith',
        bodyText: 'Thanks, received',
        attachmentNames: [],
        threadSubmissionSubject: 'New submission - Dr. Smith',
      });
      expect(r.decisive).toBeNull();
      expect(r.reasons).toContain('+4: reply in the thread of submission "New submission - Dr. Smith"');
    });
  });

  it('reads machine-set signals from headers and Gmail labels', () => {
    expect(
      messageSignals(
        {
          'auto-submitted': 'auto-replied',
          'list-unsubscribe': '<mailto:x>',
          precedence: 'Bulk',
          'content-type': 'multipart/report; report-type=delivery-status; boundary="x"',
        },
        ['INBOX', 'CATEGORY_PROMOTIONS'],
      ),
    ).toEqual({
      autoSubmitted: 'auto-replied',
      listUnsubscribe: true,
      precedence: 'bulk',
      reportType: 'delivery-status',
      gmailCategory: 'PROMOTIONS',
    });
    expect(
      messageSignals({ 'auto-submitted': 'no', 'content-type': 'text/plain' }, ['INBOX', 'CATEGORY_PERSONAL']),
    ).toEqual({});
  });
});

describe('skills', () => {
  it('loads the bundled skills with content-hash versions', () => {
    const names = listSkills()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual([
      'auto-quote',
      'email-classification',
      'email-draft',
      'field-extraction',
      'report-comparison',
      'synthesis',
      'underwriting-analysis',
      'workspace-chat',
    ]);
    const syn = loadSkill('synthesis');
    expect(syn.files[0]).toBe('SKILL.md');
    expect(syn.files).toContain('references/npi-verification.md');
    expect(syn.version).toMatch(/^2\.3\.1\+[0-9a-f]{10}$/);
    expect(syn.systemPrompt).not.toMatch(/^---/);
    expect(syn.effort).toBe('high');
  });

  it('changes version when a file changes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skills-'));
    mkdirSync(path.join(root, 'demo'));
    writeFileSync(path.join(root, 'demo', 'SKILL.md'), '---\nversion: 2.0.0\n---\nHello');
    const v1 = loadSkill('demo', root).version;
    writeFileSync(path.join(root, 'demo', 'extra.md'), 'More');
    const v2 = loadSkill('demo', root).version;
    expect(v1).not.toBe(v2);
    expect(v2.startsWith('2.0.0+')).toBe(true);
  });

  it('reads model and effort from frontmatter, ignoring comments', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skills-'));
    mkdirSync(path.join(root, 'demo'));
    writeFileSync(path.join(root, 'demo', 'SKILL.md'), '---\nversion: 1.0.0\neffort: low\n# model: ignored\n---\nHi');
    expect(loadSkill('demo', root)).toMatchObject({ effort: 'low', model: undefined });
    writeFileSync(path.join(root, 'demo', 'SKILL.md'), '---\nmodel: claude-haiku-5-5\n---\nHi');
    expect(loadSkill('demo', root)).toMatchObject({ effort: undefined, model: 'claude-haiku-5-5' });
    writeFileSync(
      path.join(root, 'demo', 'SKILL.md'),
      '---\nname: demo\nmetadata:\n  version: 3.0.0\n  effort: max\n  model: claude-sonnet-5-5\n---\nHi',
    );
    expect(loadSkill('demo', root)).toMatchObject({ effort: 'max', model: 'claude-sonnet-5-5' });
    expect(loadSkill('demo', root).version.startsWith('3.0.0+')).toBe(true);
    writeFileSync(path.join(root, 'demo', 'SKILL.md'), '---\neffort: turbo\n---\nHi');
    expect(() => loadSkill('demo', root)).toThrow(/invalid effort/);
  });

  it('rejects path traversal names', () => {
    expect(() => loadSkill('../etc')).toThrow();
  });
});

describe('crypto', () => {
  it('round-trips encryption', () => {
    const c = encrypt('refresh-token-123');
    expect(c).not.toContain('refresh');
    expect(decrypt(c)).toBe('refresh-token-123');
  });
});

describe('gmail parsing', () => {
  it('walks MIME parts', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const r = walkParts({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Hello plain') } },
            { mimeType: 'text/html', body: { data: b64('<p>Hello</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'app.pdf', body: { attachmentId: 'att1', size: 100 } },
        { mimeType: 'text/csv', filename: 'roster.csv', body: { data: b64('a,b'), size: 3 } },
      ],
    });
    expect(r.text).toBe('Hello plain');
    expect(r.attachments).toEqual([
      { filename: 'app.pdf', mimeType: 'application/pdf', attachmentId: 'att1', data: null, size: 100 },
      { filename: 'roster.csv', mimeType: 'text/csv', attachmentId: null, data: b64('a,b'), size: 3 },
    ]);
  });

  it('converts html to text', () => {
    expect(htmlToText('<style>x</style><p>A&amp;B</p><br>C')).toBe('A&B\n\nC');
  });
});

describe('gmail mcp parsing', () => {
  it('parses search results from JSON and text', () => {
    expect(parseSearchResult({ messages: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }, '')).toEqual(['a', 'b']);
    expect(parseSearchResult(undefined, 'ID: m1\nSubject: Hi\n\nID: m2\nSubject: Yo')).toEqual(['m1', 'm2']);
    expect(parseSearchResult(undefined, 'No messages found')).toEqual([]);
  });

  it('parses a text message', () => {
    const m = parseMessageResult(
      'm1',
      undefined,
      'Thread ID: t1\nSubject: New app\nFrom: a@x.com\nTo: b@y.com\nDate: Mon, 26 Oct 2026 10:00:00 +0000\n\nHello\n\nBody\n\nAttachments (1):\n- app.pdf (application/pdf, 10 KB, ID: z)',
    );
    expect(m).toMatchObject({
      gmailMessageId: 'm1',
      threadId: 't1',
      subject: 'New app',
      fromAddress: 'a@x.com',
      toAddress: 'b@y.com',
      bodyText: 'Hello\n\nBody',
      attachments: [],
    });
    expect(m.receivedAt.toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });

  it('parses a JSON message with attachments', () => {
    const m = parseMessageResult(
      'm1',
      {
        id: 'm1',
        from: 'a@x.com',
        to: ['b@y.com'],
        subject: 'S',
        body: 'B',
        attachments: [{ filename: 'f.txt', mimeType: 'text/plain', data: Buffer.from('hi').toString('base64') }],
      },
      '',
    );
    expect(m.toAddress).toBe('b@y.com');
    expect(m.attachments[0]!.data.toString()).toBe('hi');
  });

  it('keeps the Cc header, and never takes a non-email reply for an email', () => {
    expect(parseMessageResult('m1', undefined, 'From: a@x.com\nCc: c@x.com, d@x.com\nSubject: S\n\nB').ccAddress).toBe(
      'c@x.com, d@x.com',
    );
    expect(parseMessageResult('m1', { from: 'a@x.com', cc: ['c@x.com'], subject: 'S' }, '').ccAddress).toBe('c@x.com');
    expect(() => parseMessageResult('m1', undefined, 'Message not found')).toThrow(McpMessageNotFound);
    expect(() => parseMessageResult('m1', { error: 'Requested entity was not found.' }, '')).toThrow(
      McpMessageNotFound,
    );
    const odd = () => parseMessageResult('m1', undefined, 'Rate limit exceeded, try later');
    expect(odd).toThrow(/not an email/);
    expect(odd).not.toThrow(McpMessageNotFound);
  });
});

describe('field extraction sources', () => {
  it('tells attachments with the same filename apart', () => {
    const src = (documentId: string | null, label: string) => ({ documentId, label, text: '', ocrUsed: false });
    expect(
      withUniqueLabels([src(null, 'email body'), src('d1', 'app.pdf'), src('d2', 'app.pdf'), src('d3', 'app.pdf')]).map(
        (s) => [s.documentId, s.label],
      ),
    ).toEqual([
      [null, 'email body'],
      ['d1', 'app.pdf'],
      ['d2', 'app.pdf (2)'],
      ['d3', 'app.pdf (3)'],
    ]);
  });
});

describe('text extraction', () => {
  it('detects kinds', () => {
    expect(detectKind('a.PDF', '')).toBe('pdf');
    expect(detectKind('a.docx', '')).toBe('docx');
    expect(detectKind('scan.jpg', 'image/jpeg')).toBe('image');
    expect(detectKind('a.zip', '')).toBe('zip');
    expect(detectKind('upload', 'application/zip')).toBe('zip');
    expect(detectKind('upload', 'application/x-zip-compressed')).toBe('zip');
    // Some mailers label Office files as zip; the extension must still win.
    expect(detectKind('a.docx', 'application/zip')).toBe('docx');
    expect(detectKind('a.rar', 'application/vnd.rar')).toBe('other');
  });

  it('extracts plain text and flags unsupported', async () => {
    const t = await extractText(Buffer.from('Applicant: Jane Smith, NPI 1234567893'), 'notes.txt', 'text/plain');
    expect(t.status).toBe('EXTRACTED');
    expect((await extractText(Buffer.from('x'), 'a.rar', 'application/vnd.rar')).status).toBe('UNSUPPORTED');
    expect((await extractText(Buffer.from('   '), 'empty.txt', 'text/plain')).status).toBe('UNREADABLE');
  });

  it('extracts xlsx via exceljs', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Loss Runs');
    ws.addRow(['Claim', 'Date', 'Paid']);
    ws.addRow(['C-1', new Date('2021-03-04'), 175000]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const t = await extractText(buf, 'loss_runs.xlsx', '');
    expect(t.status).toBe('EXTRACTED');
    expect(t.text).toContain('C-1 | 2021-03-04 | 175000');
  }, 180_000); // exceljs is a heavy first import on cold disks
});

describe('zip extraction', () => {
  const MB = 1024 * 1024;
  const READABLE = 'Applicant Jane Smith holds NPI 1234567893 in Texas';

  async function makeZip(files: Record<string, string | Buffer>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  /** Walks the central directory, handing each record's offset to `patch`. */
  function patchCentralDirectory(zip: Buffer, patch: (offset: number) => void) {
    for (let i = 0; i < zip.length - 4; i++) {
      if (zip.readUInt32LE(i) === 0x02014b50) patch(i);
    }
  }

  it('reads every inner file and labels its text with the inner filename', async () => {
    const t = await extractText(
      await makeZip({
        'forms/application.txt': READABLE,
        'loss_runs.csv': 'claim,paid\nC-100,175000\nC-200,25000',
      }),
      'docs.zip',
      'application/zip',
    );
    expect(t.status).toBe('EXTRACTED');
    expect(t.ocrUsed).toBe(false);
    expect(t.text).toContain(`--- forms/application.txt ---\n${READABLE}`);
    expect(t.text).toContain('C-100,175000');
  });

  it('reads an xlsx inside a zip through the normal xlsx route', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Loss Runs');
    ws.addRow(['Claim', 'Paid']);
    ws.addRow(['C-100', 175000]);
    const t = await extractText(
      await makeZip({ 'loss_runs.xlsx': Buffer.from(await wb.xlsx.writeBuffer()) }),
      'docs.zip',
      '',
    );
    expect(t.status).toBe('EXTRACTED');
    expect(t.text).toContain('C-100 | 175000');
  }, 180_000); // exceljs is a heavy first import on cold disks

  it('stays within what field extraction reads, keeping a small file behind a huge one', async () => {
    const t = await extractText(
      await makeZip({
        'application.txt': 'A'.repeat(200_000),
        'loss_runs.txt': 'Loss run: claim C-100 paid 175000 in 2021',
      }),
      'docs.zip',
      '',
    );
    expect(t.text.length).toBeLessThanOrEqual(60_000); // EXTRACTION_PER_SOURCE_CHARS in fieldExtraction.ts
    expect(t.text).toContain('Loss run: claim C-100 paid 175000 in 2021');
  });

  it('splits the allowance evenly between large files and flags the cuts up front', async () => {
    const t = await extractText(
      await makeZip({
        'first.txt': 'F'.repeat(100_000),
        'second.txt': 'S'.repeat(100_000),
      }),
      'docs.zip',
      '',
    );
    const count = (ch: string) => t.text.split(ch).length - 1;
    expect(count('F')).toBeGreaterThan(20_000);
    expect(count('S')).toBeGreaterThan(20_000);
    expect(Math.abs(count('F') - count('S'))).toBeLessThan(50);
    const contents = t.text.slice(0, t.text.indexOf('--- first.txt ---'));
    expect(contents).toMatch(/first\.txt: read, cut to \d+ of 100000 characters/);
    expect(contents).toMatch(/second\.txt: read, cut to \d+ of 100000 characters/);
  });

  it('does not flag a file that fits as cut', async () => {
    const t = await extractText(await makeZip({ 'application.txt': READABLE }), 'docs.zip', '');
    expect(t.text).toMatch(/application\.txt: read\n/);
    expect(t.text).not.toContain('cut to');
  });

  it('lists an unreadable inner type and still reports the readable ones', async () => {
    const t = await extractText(
      await makeZip({ 'application.txt': READABLE, 'tool.exe': 'MZ binary' }),
      'docs.zip',
      '',
    );
    expect(t.status).toBe('EXTRACTED');
    expect(t.text).toMatch(/tool\.exe: not read/);
    expect(t.text).not.toContain('MZ binary');
  });

  it('is UNSUPPORTED when nothing inside is a readable type', async () => {
    const t = await extractText(await makeZip({ 'tool.exe': 'MZ binary' }), 'docs.zip', '');
    expect(t.status).toBe('UNSUPPORTED');
  });

  it('does not open a zip inside a zip', async () => {
    const inner = await makeZip({ 'deep.txt': READABLE });
    const t = await extractText(await makeZip({ 'nested.zip': inner }), 'docs.zip', '');
    expect(t.status).toBe('UNSUPPORTED');
    expect(t.text).toMatch(/nested\.zip: not read/);
    expect(t.text).not.toContain(READABLE);
  });

  it('skips an inner file that inflates past the size limit and reads the rest', async () => {
    const t = await extractText(
      await makeZip({
        'bomb.txt': Buffer.alloc(26 * MB, 'a'),
        'application.txt': READABLE,
      }),
      'docs.zip',
      '',
    );
    expect(t.status).toBe('EXTRACTED');
    expect(t.text).toMatch(/bomb\.txt: not read/);
    expect(t.text).toContain(READABLE);
    expect(t.text).not.toContain('aaaa');
  }, 60_000);

  it('enforces the size limit even when the zip lies about the inflated size', async () => {
    const zip = await makeZip({ 'bomb.txt': Buffer.alloc(26 * MB, 'a'), 'application.txt': READABLE });
    patchCentralDirectory(zip, (offset) => {
      if (zip.toString('utf8', offset + 46, offset + 54) === 'bomb.txt') zip.writeUInt32LE(10, offset + 24);
    });
    const t = await extractText(zip, 'docs.zip', '');
    expect(t.text).toMatch(/bomb\.txt: not read/);
    expect(t.text).toContain(READABLE);
  }, 60_000);

  it('stops reading once the archive as a whole has inflated too far', async () => {
    const t = await extractText(
      await makeZip({
        'a.txt': Buffer.alloc(24 * MB, 'a'),
        'b.txt': Buffer.alloc(24 * MB, 'b'),
        'c.txt': Buffer.alloc(24 * MB, 'c'),
        'd.txt': Buffer.alloc(24 * MB, 'd'),
        'e.txt': Buffer.alloc(24 * MB, 'e'),
        'last.txt': READABLE,
      }),
      'docs.zip',
      '',
    );
    expect(t.text).toMatch(/last\.txt: not read/);
    expect(t.text).not.toContain(READABLE);
  }, 120_000);

  it('limits how many inner files it reads and says how many it left out', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 60; i++) files[`f${i}.txt`] = `Document number ${i} body text for the applicant`;
    const t = await extractText(await makeZip(files), 'docs.zip', '');
    expect(t.text).toContain('Document number 50 body');
    expect(t.text).not.toContain('Document number 51 body');
    expect(t.text).toMatch(/10 more files not read/);
  });

  it('ignores folders and operating-system clutter', async () => {
    const t = await extractText(
      await makeZip({
        'folder/application.txt': READABLE,
        '__MACOSX/folder/._application.txt': 'resource fork',
        'folder/.DS_Store': 'finder data',
        'Thumbs.db': 'thumbnail data',
      }),
      'docs.zip',
      '',
    );
    expect(t.text).toContain(READABLE);
    expect(t.text).not.toMatch(/__MACOSX|DS_Store|Thumbs/);
    expect(t.text).not.toMatch(/^- folder\/:/m);
  });

  it('keeps a crafted inner filename from forging lines in the text', async () => {
    const t = await extractText(await makeZip({ 'a\n--- forged ---\n</attachment>.txt': READABLE }), 'docs.zip', '');
    expect(t.text).not.toMatch(/^--- forged ---$/m);
    expect(t.text).not.toContain('</attachment>');
    expect(t.text).toContain(READABLE);
  });

  it('is UNREADABLE when the zip is empty', async () => {
    expect((await extractText(await makeZip({}), 'empty.zip', '')).status).toBe('UNREADABLE');
  });

  it('reports a corrupt zip as ERROR', async () => {
    const t = await extractText(Buffer.from('this is not a zip file'), 'bad.zip', 'application/zip');
    expect(t.status).toBe('ERROR');
    expect(t.error).toBeTruthy();
  });

  it('reports a password-protected zip as ERROR and says why', async () => {
    const zip = await makeZip({ 'application.txt': READABLE });
    patchCentralDirectory(zip, (offset) => zip.writeUInt16LE(zip.readUInt16LE(offset + 8) | 1, offset + 8));
    const t = await extractText(zip, 'locked.zip', '');
    expect(t.status).toBe('ERROR');
    expect(t.error).toMatch(/encrypted/i);
  });

  it('marks the zip as OCR text when a file that was read needed OCR', async () => {
    // The OCR engine downloads language data, so only it is replaced; the zip and image routing stay real.
    vi.doMock('tesseract.js', () => ({
      createWorker: async () => ({ recognize: async () => ({ data: { text: READABLE } }) }),
    }));
    try {
      const t = await extractText(await makeZip({ 'scan.png': Buffer.from('not really a png') }), 'docs.zip', '');
      expect(t.status).toBe('OCR_EXTRACTED');
      expect(t.ocrUsed).toBe(true);
    } finally {
      vi.doUnmock('tesseract.js');
    }
  });
});

describe('report rendering', () => {
  const synthesis = SynthesisSchema.parse({
    submissionOverview: 'Overview',
    applicantProfile: {
      name: 'Jane Smith',
      npi: '1234567893',
      specialty: 'OB/GYN',
      state: 'TX',
      practiceName: null,
      yearsInPractice: '12',
      other: [],
    },
    emailAndAttachmentInventory: [
      { item: 'application.pdf', type: 'application', status: 'EXTRACTED', notes: 'signed' },
    ],
    extractedFacts: [{ text: '2 claims', source: 'loss_runs.xlsx', confidence: 'HIGH' }],
    npiVerificationSummary: 'Match',
    conflicts: [],
    missingInformation: [{ item: 'CV', importance: 'IMPORTANT', reason: 'not attached' }],
    dataConfidence: { overall: 'HIGH', notes: 'ok' },
    consolidatedContextForLlm: 'brief',
  });

  it('renders every synthesis section', () => {
    const md = renderSynthesisMarkdown(synthesis, {
      version: 2,
      skillVersion: '1.0.0+abc',
      model: 'm',
      contextVersion: 3,
    });
    for (let i = 1; i <= 9; i++) expect(md).toContain(`## ${i}.`);
    expect(md).toContain('Synthesis Report v2');
    expect(md).toContain('| Name | Jane Smith |');
  });

  it('shows first/last name for individuals and entity name for organizations', () => {
    const meta = { version: 1, skillVersion: 'x', model: 'm', contextVersion: 1 };
    const person = renderSynthesisMarkdown(synthesis, {
      ...meta,
      applicant: { type: 'INDIVIDUAL', firstName: 'Jane', lastName: 'Smith', entityName: null },
    });
    expect(person).toContain('| First name | Jane |');
    expect(person).toContain('| Last name | Smith |');
    expect(person).not.toContain('| Name |');
    const org = renderSynthesisMarkdown(synthesis, {
      ...meta,
      applicant: { type: 'ORGANIZATION', firstName: null, lastName: null, entityName: 'Acme Clinic' },
    });
    expect(org).toContain('| Entity name | Acme Clinic |');
    expect(org).not.toContain('| First name |');
  });

  it('renders analysis with severity matrix', () => {
    const analysis = AnalysisSchema.parse({
      executiveSummary: 'Sum',
      overallRisk: 'ELEVATED',
      recommendation: 'REFER',
      riskIndicators: [{ title: 'Claims', detail: 'd', severity: 'HIGH', confidence: 'HIGH', evidence: ['loss runs'] }],
      applicationCompleteness: { score: 80, summary: 's', gaps: [] },
      inconsistencies: [],
      potentialConcerns: [],
      missingInformation: [],
      followUpQuestions: [],
      recommendedNextSteps: ['Ask'],
      limitationsAndUncertainties: [],
    });
    const md = renderAnalysisMarkdown(analysis, {
      version: 1,
      skillVersion: 'x',
      model: 'm',
      contextVersion: 1,
      synthesisVersion: 2,
    });
    expect(md).toContain('| HIGH | 1 | 0 | 0 |');
    expect(md).toContain('Recommendation: REFER');
    expect(md).not.toContain('**Applicant type:**');
    const named = renderAnalysisMarkdown(analysis, {
      version: 1,
      skillVersion: 'x',
      model: 'm',
      contextVersion: 1,
      synthesisVersion: 2,
      applicant: { type: 'INDIVIDUAL', firstName: 'Jane', lastName: 'Smith', entityName: null },
    });
    expect(named).toContain('**Applicant type:** Individual · **First name:** Jane · **Last name:** Smith');
  });
});

describe('previewMimeType', () => {
  it('serves renderable types inline, falling back to the extension for generic MIME types', () => {
    expect(previewMimeType('app.pdf', 'application/pdf')).toBe('application/pdf');
    expect(previewMimeType('app.pdf', 'application/octet-stream')).toBe('application/pdf');
    expect(previewMimeType('scan.JPG', '')).toBe('image/jpeg');
    expect(previewMimeType('notes.txt', 'text/plain; charset=us-ascii')).toBe('text/plain; charset=utf-8');
  });

  it('refuses types that could run script or that browsers cannot render', () => {
    expect(previewMimeType('page.html', 'text/html')).toBeNull();
    expect(previewMimeType('logo.svg', 'image/svg+xml')).toBeNull();
    expect(previewMimeType('evil.pdf', 'text/html')).toBeNull();
    expect(previewMimeType('page.html', 'application/octet-stream')).toBeNull();
    expect(
      previewMimeType('app.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBeNull();
  });
});

describe('llm call status', () => {
  it('maps the API stop reason and parse result to a usage status', () => {
    expect(callStatus({ stop_reason: 'end_turn', parsed_output: {} }, true)).toBe('SUCCESS');
    expect(callStatus({ stop_reason: 'end_turn' }, false)).toBe('SUCCESS');
    expect(callStatus({ stop_reason: 'end_turn', parsed_output: null }, true)).toBe('INVALID_OUTPUT');
    expect(callStatus({ stop_reason: 'refusal' }, true)).toBe('REFUSED');
    expect(callStatus({ stop_reason: 'max_tokens' }, false)).toBe('TRUNCATED');
  });
});

describe('Attachment gaps', () => {
  it('records Drive/Docs links in the body as LINKED_FILE gaps, once each', () => {
    const { files, gaps } = prepareAttachments({
      attachments: [{ filename: 'app.pdf', mimeType: 'application/pdf', data: Buffer.from('x') }],
      bodyText:
        'Loss runs: https://drive.google.com/file/d/abc123/view?usp=sharing. Also https://docs.google.com/spreadsheets/d/xyz ' +
        'and again https://drive.google.com/file/d/abc123/view?usp=sharing',
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(gaps.map((g) => [g.reason, g.detail])).toEqual([
      ['LINKED_FILE', 'https://drive.google.com/file/d/abc123/view?usp=sharing'],
      ['LINKED_FILE', 'https://docs.google.com/spreadsheets/d/xyz'],
    ]);
  });

  it('keeps gaps reported by the mail source', () => {
    const gap = {
      filename: 'big.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 30_000_000,
      reason: 'TOO_LARGE' as const,
      detail: null,
    };
    expect(prepareAttachments({ attachments: [], bodyText: '', gaps: [gap] }).gaps).toEqual([gap]);
  });

  it('turns MCP attachments without content into NO_CONTENT gaps', () => {
    const structured = parseMessageResult(
      'm1',
      {
        id: 'm1',
        subject: 's',
        attachments: [
          { filename: 'a.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf').toString('base64') },
          { filename: 'b.xlsx', mimeType: 'application/vnd.ms-excel', size: 1234 },
        ],
      },
      '',
    );
    expect(structured.attachments.map((a) => a.filename)).toEqual(['a.pdf']);
    expect(structured.gaps).toMatchObject([{ filename: 'b.xlsx', reason: 'NO_CONTENT', sizeBytes: 1234 }]);

    const text = parseMessageResult(
      'm2',
      undefined,
      'From: a@b.com\nSubject: Hi\n\nPlease see attached.\n\nAttachments (2):\n- application.pdf (application/pdf, 120 KB)\n- loss runs.xlsx',
    );
    expect(text.bodyText).toBe('Please see attached.');
    expect(text.gaps?.map((g) => [g.filename, g.reason])).toEqual([
      ['application.pdf', 'NO_CONTENT'],
      ['loss runs.xlsx', 'NO_CONTENT'],
    ]);
    expect(listedAttachments('no list here')).toEqual([]);
  });
});

describe('fileCache', () => {
  it('returns cached bytes and evicts the least recently used past the size limit', () => {
    fileCache.clear();
    const mb = Buffer.alloc(1024 * 1024);
    fileCache.put('a', mb);
    expect(fileCache.get('a')).toBe(mb);
    // Default limit is 200 MB: 201 more entries push out the oldest ones.
    for (let i = 0; i < 201; i++) fileCache.put(`n${i}`, mb);
    expect(fileCache.get('a')).toBeNull();
    expect(fileCache.stats().bytes).toBeLessThanOrEqual(200 * 1024 * 1024);
    fileCache.clear();
    expect(fileCache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
