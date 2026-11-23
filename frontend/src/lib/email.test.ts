import { describe, expect, it } from 'vitest';

import {
  composeDefaults,
  forwardSubject,
  initials,
  isValidEmail,
  parseAddress,
  parseInline,
  replySubject,
  splitAddressList,
  splitEmailBody,
  splitLabel,
  validateCompose,
} from './email';

describe('email helpers', () => {
  it('parses display names out of addresses', () => {
    expect(parseAddress('Jane Smith <jane@agency.com>')).toEqual({ name: 'Jane Smith', address: 'jane@agency.com' });
    expect(parseAddress('"Smith, Jane" <jane@agency.com>')).toEqual({
      name: 'Smith, Jane',
      address: 'jane@agency.com',
    });
    expect(parseAddress('jane@agency.com')).toEqual({ name: null, address: 'jane@agency.com' });
  });

  it('builds avatar initials', () => {
    expect(initials('Jane Smith')).toBe('JS');
    expect(initials('vishal.haripara@gmail.com')).toBe('VH');
    expect(initials('broker@agency.com')).toBe('B');
  });

  it('splits paragraphs and collapses extra blank lines', () => {
    expect(splitEmailBody('Hi team,\r\n\r\n\r\n\r\nPlease quote.   \nThanks\n\n')).toEqual({
      blocks: [
        { type: 'paragraph', text: 'Hi team,' },
        { type: 'paragraph', text: 'Please quote.\nThanks' },
      ],
      quoted: null,
    });
  });

  it("rebuilds Gmail's plain-text rendering of an HTML email", () => {
    const body = [
      'I am writing to request a quote for medical professional liability',
      'insurance for my practice. Please find my application details below.',
      '1. Personal and Professional Information',
      '',
      '-',
      '',
      'Full Name: Anna A. Dunn, PA',
      '   -',
      '',
      'National Provider Identifier (NPI): 1467550004',
      '',
      '2. Requested Insurance Coverage',
      '',
      '- Policy Type: Claims-Made',
      '',
      'Kind regards,',
      'Anna',
    ].join('\n');
    expect(splitEmailBody(body).blocks).toEqual([
      {
        type: 'paragraph',
        text: 'I am writing to request a quote for medical professional liability insurance for my practice. Please find my application details below.',
      },
      { type: 'heading', text: '1. Personal and Professional Information' },
      { type: 'list', items: ['Full Name: Anna A. Dunn, PA', 'National Provider Identifier (NPI): 1467550004'] },
      { type: 'heading', text: '2. Requested Insurance Coverage' },
      { type: 'list', items: ['Policy Type: Claims-Made'] },
      { type: 'paragraph', text: 'Kind regards,\nAnna' },
    ]);
  });

  it('joins hard-wrapped bullet items', () => {
    const body =
      '-\n\nPrior Acts Coverage: Please advise on availability and requirements for\nthis policy.\n-\n\nNext';
    expect(splitEmailBody(body).blocks).toEqual([
      {
        type: 'list',
        items: ['Prior Acts Coverage: Please advise on availability and requirements for this policy.', 'Next'],
      },
    ]);
  });

  it('splits "Label: value" for bolding', () => {
    expect(splitLabel('Each Claim Limit: $1,000,000')).toEqual({ label: 'Each Claim Limit', value: '$1,000,000' });
    expect(splitLabel('Completed professional liability insurance application')).toBeNull();
  });

  it('renders literal Markdown: headings, rules, tables, emphasised labels, run-together numbered items', () => {
    const body = [
      'The taxonomy breakdown is set out below.',
      '',
      '---',
      '',
      '## Detailed Taxonomy Breakdown',
      '',
      '| Field | Registry Value | Explanation |',
      '| --- | --- | --- |',
      '| **Taxonomy Code** | `1835P0018X` | NUCC code. |',
      '| **Primary Specialty Status** | **Yes** | Primary taxonomy. |',
      '',
      '**Expanded Clinical Scope:** Possesses advanced clinical training to work directly in patient care settings.',
      '**Therapeutic Management:** Performs patient assessments and manages chronic drug therapies.',
      '',
      '1. **Insurance Claims:** Payers require the exact code on claims. 2. **Credentialing:** Hospitals use this code.',
    ].join('\n');
    expect(splitEmailBody(body).blocks).toEqual([
      { type: 'paragraph', text: 'The taxonomy breakdown is set out below.' },
      { type: 'rule' },
      { type: 'heading', text: 'Detailed Taxonomy Breakdown' },
      {
        type: 'table',
        header: ['Field', 'Registry Value', 'Explanation'],
        rows: [
          ['**Taxonomy Code**', '`1835P0018X`', 'NUCC code.'],
          ['**Primary Specialty Status**', '**Yes**', 'Primary taxonomy.'],
        ],
      },
      {
        type: 'fields',
        items: [
          {
            label: 'Expanded Clinical Scope',
            value: 'Possesses advanced clinical training to work directly in patient care settings.',
          },
          {
            label: 'Therapeutic Management',
            value: 'Performs patient assessments and manages chronic drug therapies.',
          },
        ],
      },
      {
        type: 'list',
        start: 1,
        items: [
          '**Insurance Claims:** Payers require the exact code on claims.',
          '**Credentialing:** Hospitals use this code.',
        ],
      },
    ]);
  });

  it('groups label lines into fields and rebuilds split numbered lists', () => {
    const body = [
      '6. Claims and Loss History',
      '*Malpractice Claims in the Past 5 Years:* None reported',
      '*Pending Claims or Lawsuits:* None reported',
      '*These declarations are illustrative and must be verified.*',
      '',
      '7. Changes Since Previous Policy',
      'Change in Medical Specialty: No',
      'Change in Practice Location: No',
      '8. Supporting Documents',
      'Documents available upon request:',
      '',
      '1.',
      '',
      'Current insurance declarations page',
      '2.',
      '',
      'Five-year malpractice loss runs',
    ].join('\n');
    expect(splitEmailBody(body).blocks).toEqual([
      { type: 'heading', text: '6. Claims and Loss History' },
      {
        type: 'fields',
        items: [
          { label: 'Malpractice Claims in the Past 5 Years', value: 'None reported' },
          { label: 'Pending Claims or Lawsuits', value: 'None reported' },
        ],
      },
      { type: 'paragraph', text: '*These declarations are illustrative and must be verified.*' },
      { type: 'heading', text: '7. Changes Since Previous Policy' },
      {
        type: 'fields',
        items: [
          { label: 'Change in Medical Specialty', value: 'No' },
          { label: 'Change in Practice Location', value: 'No' },
        ],
      },
      { type: 'heading', text: '8. Supporting Documents' },
      { type: 'paragraph', text: 'Documents available upon request:' },
      { type: 'list', start: 1, items: ['Current insurance declarations page', 'Five-year malpractice loss runs'] },
    ]);
  });

  it('stitches table rows, list items, and bold text that Gmail hard-wrapped at ~76 columns', () => {
    // Verbatim shape of a stored Gmail plain-text body.
    const body = [
      'The taxonomy breakdown and credentialing significance for **Smitha',
      'Abraham** are set out below.',
      '',
      '| Field | Registry Value | Explanation |',
      '| --- | --- | --- |',
      '| **Taxonomy Code** | `1835P0018X` | Specific NUCC classification code',
      'assigned to clinical pharmacy specialists. |',
      '| **Specialty Classification** | **Pharmacist Clinician (PhC) / Clinical',
      'Pharmacy Specialist** | Denotes advanced clinical training beyond standard',
      'retail/dispensing pharmacy duties. |',
      '| **Associated State License** | `TX43384` | Texas State Board of Pharmacy',
      'license tied to this clinical classification. |',
      '',
      '* **Collaborative Practice Agreements (CPA):** Authorized under state law',
      'to initiate, adjust, monitor, or manage drug therapy protocols in',
      'collaboration with supervising physicians.',
      '* **Therapeutic Management:** Performs patient assessments, orders relevant',
      'lab work for medication monitoring, and manages chronic drug therapies',
      '(e.g., anticoagulation, diabetes, hypertension).',
      '',
      '1. **Insurance Claims & Billing:** Payers require the exact taxonomy code',
      '(`1835P0018X`) on CMS-1500 or 837P claims.',
      '2. **Credentialing & Privilege Checks:** Hospitals, medical groups, and',
      'pharmacy benefit managers (PBMs) use this code.',
    ].join('\n');
    expect(splitEmailBody(body).blocks).toEqual([
      {
        type: 'paragraph',
        text: 'The taxonomy breakdown and credentialing significance for **Smitha Abraham** are set out below.',
      },
      {
        type: 'table',
        header: ['Field', 'Registry Value', 'Explanation'],
        rows: [
          [
            '**Taxonomy Code**',
            '`1835P0018X`',
            'Specific NUCC classification code assigned to clinical pharmacy specialists.',
          ],
          [
            '**Specialty Classification**',
            '**Pharmacist Clinician (PhC) / Clinical Pharmacy Specialist**',
            'Denotes advanced clinical training beyond standard retail/dispensing pharmacy duties.',
          ],
          [
            '**Associated State License**',
            '`TX43384`',
            'Texas State Board of Pharmacy license tied to this clinical classification.',
          ],
        ],
      },
      {
        type: 'list',
        items: [
          '**Collaborative Practice Agreements (CPA):** Authorized under state law to initiate, adjust, monitor, or manage drug therapy protocols in collaboration with supervising physicians.',
          '**Therapeutic Management:** Performs patient assessments, orders relevant lab work for medication monitoring, and manages chronic drug therapies (e.g., anticoagulation, diabetes, hypertension).',
        ],
      },
      {
        type: 'list',
        start: 1,
        items: [
          '**Insurance Claims & Billing:** Payers require the exact taxonomy code (`1835P0018X`) on CMS-1500 or 837P claims.',
          '**Credentialing & Privilege Checks:** Hospitals, medical groups, and pharmacy benefit managers (PBMs) use this code.',
        ],
      },
    ]);
  });

  it('reads other table shapes: no outer pipes, a row wrapped just before a pipe, tab-separated', () => {
    expect(splitEmailBody('Limit | Amount\n--- | ---\nEach Claim | $1M\nAggregate | $3M').blocks).toEqual([
      {
        type: 'table',
        header: ['Limit', 'Amount'],
        rows: [
          ['Each Claim', '$1M'],
          ['Aggregate', '$3M'],
        ],
      },
    ]);
    expect(splitEmailBody('| A | B | C |\n|---|---|---|\n| 1 | 2\n| 3 |\n| 4 | 5 | 6 |').blocks).toEqual([
      {
        type: 'table',
        header: ['A', 'B', 'C'],
        rows: [
          ['1', '2', '3'],
          ['4', '5', '6'],
        ],
      },
    ]);
    expect(splitEmailBody('Year\tClaims\n2024\t0\n2025\t1').blocks).toEqual([
      {
        type: 'table',
        header: ['Year', 'Claims'],
        rows: [
          ['2024', '0'],
          ['2025', '1'],
        ],
      },
    ]);
  });

  it('recognises bold, setext, and all-caps headings and leaves short lines alone', () => {
    expect(
      splitEmailBody(
        '**Coverage Requested**\nClaims-made policy.\n\nLoss Runs\n=========\nNone.\n\nCLAIMS HISTORY\nNone reported.',
      ).blocks,
    ).toEqual([
      { type: 'heading', text: 'Coverage Requested' },
      { type: 'paragraph', text: 'Claims-made policy.' },
      { type: 'heading', text: 'Loss Runs' },
      { type: 'paragraph', text: 'None.' },
      { type: 'heading', text: 'CLAIMS HISTORY' },
      { type: 'paragraph', text: 'None reported.' },
    ]);
  });

  it('parses inline Markdown emphasis', () => {
    expect(parseInline('See [the app](https://x.com/a) now')).toEqual([
      { text: 'See ' },
      { text: 'the app', href: 'https://x.com/a' },
      { text: ' now' },
    ]);
    expect(parseInline('Code `1835P0018X` is **primary** and *verified*; 5 * 3 stays.')).toEqual([
      { text: 'Code ' },
      { text: '1835P0018X', code: true },
      { text: ' is ' },
      { text: 'primary', bold: true },
      { text: ' and ' },
      { text: 'verified', italic: true },
      { text: '; 5 * 3 stays.' },
    ]);
    expect(splitLabel('**Label**: value')).toEqual({ label: 'Label', value: 'value' });
  });

  it('links only https: and mailto: Markdown targets', () => {
    expect(parseInline('[mail](mailto:a@b.com)')).toEqual([{ text: 'mail', href: 'mailto:a@b.com' }]);
    expect(parseInline('[bank](http://evil.test)')).toEqual([{ text: '[bank](http://evil.test)' }]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ text: '[x](javascript:alert(1))' }]);
  });

  it('separates quoted reply history', () => {
    const r = splitEmailBody(
      'Updated app attached.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> Please send the app',
    );
    expect(r.blocks).toEqual([{ type: 'paragraph', text: 'Updated app attached.' }]);
    expect(r.quoted).toBe('On Mon, Oct 26, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> Please send the app');
    expect(splitEmailBody('See below\n-----Original Message-----\nFrom: a@b.com').quoted).toMatch(/^-----Original/);
    const wrapped = splitEmailBody(
      'Kind regards,\n\nOn Tue, 27 Oct 2026 at 12:50, MPL Underwriting <uw@x.com>\nwrote:\n\n> Please send',
    );
    expect(wrapped.blocks).toEqual([{ type: 'paragraph', text: 'Kind regards,' }]);
    expect(wrapped.quoted).toMatch(/^On Tue/);
  });

  it('handles empty bodies', () => {
    expect(splitEmailBody('  \n ')).toEqual({ blocks: [], quoted: null });
  });
});

describe('compose defaults', () => {
  const src = {
    fromAddress: 'Pat Broker <pat@brokerage.test>',
    toAddress: 'Underwriting <uw@insurer.com>, "Lee, Sam" <sam@brokerage.test>; pat@brokerage.test, ops@brokerage.test',
    subject: 'Quote request: Dr. Lee',
    bodyText: 'Please quote.\n\nThanks',
    receivedAt: '2026-10-30T10:00:00.000Z',
  };
  const formatDate = () => 'Oct 30, 2026';

  it('adds Re: and Fwd: once', () => {
    expect(replySubject('Quote')).toBe('Re: Quote');
    expect(replySubject('RE: Quote')).toBe('RE: Quote');
    expect(forwardSubject('Quote')).toBe('Fwd: Quote');
    expect(forwardSubject('Fw: Quote')).toBe('Fw: Quote');
    expect(replySubject('')).toBe('Re: (no subject)');
  });

  it('replies to the sender with the original quoted', () => {
    const d = composeDefaults('REPLY', src, { formatDate });
    expect(d).toMatchObject({
      to: ['Pat Broker <pat@brokerage.test>'],
      cc: [],
      bcc: [],
      subject: 'Re: Quote request: Dr. Lee',
      documentIds: [],
    });
    expect(d.body).toBe('\n\nOn Oct 30, 2026, Pat Broker <pat@brokerage.test> wrote:\n> Please quote.\n>\n> Thanks');
  });

  it('reply all copies the original recipients minus the sender and the mailbox', () => {
    const d = composeDefaults('REPLY_ALL', src, { mailbox: 'UW@insurer.com', formatDate });
    expect(d.to).toEqual(['Pat Broker <pat@brokerage.test>']);
    expect(d.cc).toEqual(['"Lee, Sam" <sam@brokerage.test>', 'ops@brokerage.test']);
    expect(splitAddressList('a@x.com;; "B, C" <b@x.com> ,')).toEqual(['a@x.com', '"B, C" <b@x.com>']);
  });

  it('reply all also copies the original Cc, minus the sender, the mailbox and repeats', () => {
    const d = composeDefaults(
      'REPLY_ALL',
      {
        ...src,
        ccAddress: 'uw@insurer.com, cc1@brokerage.test, OPS@brokerage.test, Pat <pat@brokerage.test>',
      },
      { mailbox: 'UW@insurer.com', formatDate },
    );
    expect(d.cc).toEqual(['"Lee, Sam" <sam@brokerage.test>', 'ops@brokerage.test', 'cc1@brokerage.test']);
    expect(
      composeDefaults('REPLY_ALL', { ...src, ccAddress: null }, { mailbox: 'UW@insurer.com', formatDate }).cc,
    ).toEqual(['"Lee, Sam" <sam@brokerage.test>', 'ops@brokerage.test']);
  });

  it('forwards to nobody yet, with the original and every document selected', () => {
    const d = composeDefaults('FORWARD', src, { documentIds: ['d1', 'd2'], formatDate });
    expect(d).toMatchObject({ to: [], cc: [], subject: 'Fwd: Quote request: Dr. Lee', documentIds: ['d1', 'd2'] });
    expect(d.body).toContain(
      '---------- Forwarded message ---------\nFrom: Pat Broker <pat@brokerage.test>\nDate: Oct 30, 2026',
    );
    expect(d.body).toContain('Please quote.\n\nThanks');
  });

  it('validates recipients, subject, size and the Gmail connection', () => {
    const ok = { to: ['a@b.com'], cc: [], bcc: [], subject: 'Re: x', body: '', documentIds: [] };
    const max = 18 * 1024 * 1024;
    expect(validateCompose(ok, 0, true, max)).toEqual({ ok: true, errors: [], invalid: [] });
    expect(isValidEmail('Jane <jane@x.com>')).toBe(true);
    expect(isValidEmail('jane@x')).toBe(false);
    const bad = validateCompose({ ...ok, to: [], cc: ['nope'], subject: ' ' }, max + 1, false, max);
    expect(bad.ok).toBe(false);
    expect(bad.invalid).toEqual(['nope']);
    expect(bad.errors).toHaveLength(5);
    expect(bad.errors).toContain('Attachments are over the 18 MB limit.');
    expect(validateCompose(ok, max, true, max).ok).toBe(true);
    // Limit not loaded yet: size is left to the server.
    expect(validateCompose(ok, max * 2, true, null).ok).toBe(true);
  });
});
