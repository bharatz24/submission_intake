import { describe, expect, it } from 'vitest';

import {
  addedAround,
  attachmentSet,
  type DocRef,
  type DuplicateCandidate,
  explainDuplicate,
  fingerprints,
  isForwardSubject,
  isSignatureImage,
  matchDuplicate,
  normalizeBody,
  normalizeSubject,
  senderAddress,
  shingleSimilarity,
} from '../src/services/duplicates.js';

const doc = (sha256: string, filename = `${sha256}.pdf`, extra: Partial<DocRef> = {}): DocRef => ({
  filename,
  mimeType: 'application/pdf',
  sizeBytes: 200_000,
  sha256,
  ...extra,
});

const LONG =
  'Please find attached the new business application for Dr. Jane Smith, OB/GYN in Austin TX, ' +
  'with five years of loss runs and her current declarations page. We need a quote for 1M/3M limits ' +
  'effective January first. Let me know if anything else is needed for the indication.';
const BROKER = 'Acme Broker <broker@acme.com>';

let seq = 0;
const cand = (
  subject: string,
  body: string,
  docs: DocRef[],
  extra: Partial<DuplicateCandidate> & { from?: string } = {},
): DuplicateCandidate => ({
  id: `c${++seq}`,
  rfcMessageId: null,
  receivedAt: new Date(2026, 0, seq),
  fingerprints: fingerprints({ subject, bodyText: body, fromAddress: extra.from ?? BROKER }, docs),
  ...extra,
});
const incoming = (
  subject: string,
  body: string,
  docs: DocRef[],
  opts: { rfcMessageId?: string; from?: string } = {},
) => ({
  rfcMessageId: opts.rfcMessageId ?? null,
  fingerprints: fingerprints({ subject, bodyText: body, fromAddress: opts.from ?? BROKER }, docs),
});

const gmailForward = (note: string, body: string) =>
  [
    note,
    '',
    '---------- Forwarded message ---------',
    'From: Acme Broker <broker@acme.com>',
    'Date: Mon, Jan 5, 2026 at 9:00 AM',
    'Subject: New submission',
    'To: <uw@carrier.com>',
    '',
    body,
  ].join('\n');

describe('duplicate normalization', () => {
  it('normalizes subjects and recognises forwards', () => {
    expect(normalizeSubject('RE: Fwd: [EXTERNAL] FW:  New  Submission - Dr. Smith')).toBe('new submission - dr. smith');
    expect(normalizeSubject('Re[2]: AW: Quote')).toBe('quote');
    expect(normalizeSubject('Renewal: Dr. Smith')).toBe('renewal: dr. smith');
    expect(isForwardSubject('[EXTERNAL] FW: App')).toBe(true);
    expect(isForwardSubject('Re: Fwd: App')).toBe(false);
  });

  it('keeps forwarded text without the forward header (Gmail marker, any subject)', () => {
    expect(
      normalizeBody(gmailForward('FYI see below', 'Please quote this account. https://track.example.com/abc?id=1')),
    ).toBe('fyi see below please quote this account');
  });

  it('keeps forwarded text of an Outlook forward, and cuts the history of an Outlook reply', () => {
    const outlook =
      'Please review.\n\nFrom: Broker <b@acme.com>\nSent: Monday, January 5, 2026 9:00 AM\nTo: UW\nSubject: App\n\nOriginal application text here';
    expect(normalizeBody(outlook, { forward: true })).toBe('please review original application text here');
    expect(normalizeBody(outlook)).toBe('please review');
    expect(
      normalizeBody('Hello\r\n-----Original Message-----\r\nFrom: x\r\nSent: y\r\n\r\nBody text', { forward: true }),
    ).toBe('hello body text');
    expect(normalizeBody('Hello\n-----Original Message-----\nFrom: x\nSent: y\n\nBody text')).toBe('hello');
  });

  it('cuts reply history even without ">" quoting (HTML mail converted to text)', () => {
    expect(
      normalizeBody(`Any update on this?\n\nOn Mon, Jan 5, 2026 at 9:00 AM Broker <broker@acme.com>\nwrote:\n${LONG}`),
    ).toBe('any update on this');
    expect(normalizeBody('Ok.\nOn Monday Bob wrote:\n> hi')).toBe('ok');
    expect(normalizeBody('Thanks, received.\n\nSent from my iPhone')).toBe('thanks received');
  });

  it('drops a sign-off and the signature below it, but keeps a forwarded email after the sign-off', () => {
    expect(
      normalizeBody('Please quote Dr. Patel.\n\nBest regards,\nJohn Smith\nABC Insurance', { dropSignOff: true }),
    ).toBe('please quote dr patel');
    expect(normalizeBody('Thanks!\nJohn Smith\nABC Insurance', { dropSignOff: true })).toBe('');
    expect(
      normalizeBody(gmailForward('FYI.\nThanks,\nBob', 'Please quote this account.\nRegards,\nJane'), {
        dropSignOff: true,
      }),
    ).toBe('fyi please quote this account');
    // Without the option the signature stays: it is part of what is compared.
    expect(normalizeBody('Please quote.\nThanks,\nJohn')).toBe('please quote thanks john');
  });

  it('reads the sender address', () => {
    expect(senderAddress('Acme Broker <Broker@Acme.com>')).toBe('broker@acme.com');
    expect(senderAddress('broker@acme.com')).toBe('broker@acme.com');
  });

  it('drops signature and inline images from the attachment set', () => {
    expect(isSignatureImage({ filename: 'image001.png', mimeType: 'image/png', sizeBytes: 900_000 })).toBe(true);
    expect(isSignatureImage({ filename: 'Outlook-logo.png', mimeType: 'image/png', sizeBytes: 900_000 })).toBe(true);
    expect(isSignatureImage({ filename: 'logo.png', mimeType: 'image/png', sizeBytes: 8_000 })).toBe(true);
    expect(isSignatureImage({ filename: 'scan.jpg', mimeType: 'image/jpeg', sizeBytes: 900_000 })).toBe(false);
    const logo = doc('logo', 'image001.png', { mimeType: 'image/png', sizeBytes: 4000 });
    expect(attachmentSet([doc('b'), doc('a'), logo, doc('a')])).toEqual(['a', 'b']);
    expect(fingerprints({ subject: 's', bodyText: 'b' }, [logo]).attachmentFingerprint).toBeNull();
  });

  it('measures similarity and containment', () => {
    const a = normalizeBody(LONG);
    expect(shingleSimilarity(a, a)).toBe(1);
    expect(shingleSimilarity('', '')).toBe(1);
    expect(shingleSimilarity(a, '')).toBe(0);
    expect(addedAround(`fyi ${a} thanks`, a)).toEqual(['fyi', 'thanks']);
    expect(addedAround(a.replace('jane', 'john'), a)).toBeNull();
  });
});

describe('duplicate cases', () => {
  it('R1: the same message reached the mailbox twice (identical Message-ID)', () => {
    const c = cand('Something', 'body one', [], { rfcMessageId: '<abc@mail>' });
    expect(matchDuplicate(incoming('Other', 'body two', [], { rfcMessageId: '<abc@mail>' }), [c])).toMatchObject({
      rule: 'R1',
      strength: 'CERTAIN',
      candidate: { id: c.id },
    });
  });

  it('R2: identical re-send, and a forward of the identical package', () => {
    const c = cand('New submission', LONG, [doc('a'), doc('b')]);
    expect(matchDuplicate(incoming('New submission', LONG, [doc('b'), doc('a')]), [c])).toMatchObject({
      rule: 'R2',
      strength: 'CERTAIN',
    });
    expect(
      matchDuplicate(incoming('Fwd: New submission', gmailForward('', LONG), [doc('a'), doc('b')]), [c]),
    ).toMatchObject({ rule: 'R2', strength: 'CERTAIN' });
  });

  it('R3: same documents with "see attached", or with a short note above the original text', () => {
    const c = cand('New submission', LONG, [doc('a'), doc('b')]);
    expect(matchDuplicate(incoming('Resending', 'see attached', [doc('a'), doc('b')]), [c])).toMatchObject({
      rule: 'R3',
      strength: 'HIGH',
      sharedHashes: ['a', 'b'],
    });
    expect(
      matchDuplicate(incoming('Resending', `Resending, sorry for the delay. ${LONG}`, [doc('a'), doc('b')]), [c]),
    ).toMatchObject({ rule: 'R3', strength: 'HIGH', addedWords: ['resending', 'sorry', 'for', 'the', 'delay'] });
  });

  it('R3 with a signature: "see attached" above the same sign-off is HIGH; "Thanks!" above new text is not', () => {
    const sig =
      'Thanks,\nJohn Smith\nSenior Account Executive, ABC Insurance Brokers\n123 Main Street, Suite 400, Springfield IL 62701';
    const c = cand('New submission', `${LONG}\n\n${sig}`, [doc('a')]);
    expect(matchDuplicate(incoming('Resending', `See attached.\n\n${sig}`, [doc('a')]), [c])).toMatchObject({
      rule: 'R3',
      strength: 'HIGH',
      addedWords: ['see', 'attached'],
    });
    const correction =
      'Thanks!\nCorrection: the effective date is February first, not January. The limits change to 2M/4M as well.\nJohn';
    expect(matchDuplicate(incoming('Correction', correction, [doc('a')]), [c])).toMatchObject({
      rule: 'R5',
      strength: 'POSSIBLE',
    });
  });

  it('R7: the same text under an edited subject, no attachments (real case: renewal re-sent with a shorter subject)', () => {
    const c = cand('Medical Malpractice Insurance Renewal – Dr. Emily Carter, MD – Effective 01/01/2027', LONG, []);
    expect(matchDuplicate(incoming('Medical Malpractice Insurance Renewal', LONG, []), [c])).toMatchObject({
      rule: 'R7',
      strength: 'HIGH',
    });
  });

  it('R7: the same own text with another closing (real case: "Thank you" vs "Best regards" and a signature)', () => {
    const signed = `${LONG}\nThank you,\n\nBest regards,\nDr. Emily Carter, MD\nCarter Internal Medicine Associates\nAustin, Texas\n`;
    const c = cand('Medical Malpractice Insurance Renewal', signed, []);
    const m = matchDuplicate(incoming('Submission', `${LONG}\nThank you`, []), [c]);
    expect(m).toMatchObject({ rule: 'R7', strength: 'HIGH', sameSubject: false, addedWords: [] });
    expect(m!.removedWords.join(' ')).toBe(
      'best regards dr emily carter md carter internal medicine associates austin texas',
    );
    // Under the same subject too: R2 hashes the closing, R7 does not.
    expect(
      matchDuplicate(incoming('Medical Malpractice Insurance Renewal', `${LONG}\nThank you`, []), [c]),
    ).toMatchObject({ rule: 'R7', strength: 'HIGH', sameSubject: true });
    // More than a closing below the sign-off (details written after "Thanks"): a person checks.
    const details = Array.from({ length: 45 }, (_, i) => `detail${i}`).join(' ');
    expect(
      matchDuplicate(incoming('Other', `${LONG}\nThanks,\n${details}`, []), [
        cand('Renewal', `${LONG}\nThanks,\nJohn`, []),
      ]),
    ).toMatchObject({ rule: 'R7', strength: 'POSSIBLE' });
    // Different own text: not a duplicate, whatever the closing.
    expect(
      matchDuplicate(incoming('Submission', `${LONG.replace('Jane Smith', 'Raj Patel')}\nThank you`, []), [c]),
    ).toBeNull();
  });

  it('R8: a forward with a short note and a new subject; POSSIBLE when the note is long', () => {
    const c = cand('Renewal - Dr. Smith', LONG, []);
    expect(
      matchDuplicate(incoming('Fwd: please quote today', gmailForward('Team, please prioritise this one.', LONG), []), [
        c,
      ]),
    ).toMatchObject({ rule: 'R8', strength: 'HIGH', addedWords: ['team', 'please', 'prioritise', 'this', 'one'] });
    const longNote = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
    expect(matchDuplicate(incoming('Fwd: x', gmailForward(longNote, LONG), []), [c])).toMatchObject({
      rule: 'R8',
      strength: 'POSSIBLE',
    });
  });

  it('R8: a note on top under a new subject, not a forward, is only POSSIBLE', () => {
    const c = cand('Renewal - Dr. Smith', LONG, []);
    expect(matchDuplicate(incoming('Following up', `Following up on this one. ${LONG}`, []), [c])).toMatchObject({
      rule: 'R8',
      strength: 'POSSIBLE',
    });
    expect(matchDuplicate(incoming('Renewal - Dr. Smith', `Following up on this one. ${LONG}`, []), [c])).toMatchObject(
      { rule: 'R8', strength: 'HIGH' },
    );
  });

  it('R4: a template filled in for another provider is never more than POSSIBLE, and shows what changed', () => {
    const c = cand('Renewal request', LONG, []);
    const m = matchDuplicate(incoming('Renewal request', LONG.replace('Jane Smith', 'Jane Smyth'), []), [c]);
    expect(m).toMatchObject({ rule: 'R4', strength: 'POSSIBLE' });
    expect(m!.removedWords).toEqual(['smith']);
    expect(m!.addedWords).toEqual(['smyth']);
    // Several words changed (another provider, another state, other limits): a different email.
    const other = LONG.replace('Jane Smith', 'Raj Patel').replace('Austin TX', 'Denver CO').replace('1M/3M', '2M/4M');
    expect(matchDuplicate(incoming('Renewal request', other, []), [c])).toBeNull();
    // Under a different subject it is not even a candidate rule.
    expect(
      matchDuplicate(incoming('Renewal - Dr. Smyth', LONG.replace('Jane Smith', 'Jane Smyth'), []), [c]),
    ).toBeNull();
  });

  it('R5: documents already received but different text (a correction, or a partial re-send) is POSSIBLE', () => {
    const c = cand('New submission', LONG, [doc('a'), doc('b')]);
    const body =
      'Correction: the effective date is February first, not January. Everything else on the application stays as sent before.';
    const m = matchDuplicate(incoming('Correction', body, [doc('a')]), [c]);
    expect(m).toMatchObject({ rule: 'R5', strength: 'POSSIBLE' });
    expect(m!.addedWords).toContain('correction');
  });

  it('downgrades to POSSIBLE when the same content comes from another address (second broker, colleague forward)', () => {
    const c = cand('New submission', LONG, [doc('a')]);
    expect(
      matchDuplicate(incoming('New submission', LONG, [doc('a')], { from: 'Other Broker <x@other.com>' }), [c]),
    ).toMatchObject({ rule: 'R2', strength: 'POSSIBLE', differentSender: true });
  });

  describe('is not a duplicate', () => {
    const c = cand('New submission', LONG, [doc('a')]);
    it('a new attachment (the missing loss run)', () => {
      expect(
        matchDuplicate(incoming('RE: New submission', 'here is the missing loss run', [doc('a'), doc('lossrun')]), [c]),
      ).toBeNull();
    });
    it('a reply asking for an update, with the original quoted below', () => {
      const reply = `Any update on this one?\n\nOn Mon, Jan 5, 2026 at 9:00 AM Broker <broker@acme.com>\nwrote:\n${LONG}`;
      expect(
        matchDuplicate(incoming('Re: New submission', reply, []), [c, cand('New submission', LONG, [])]),
      ).toBeNull();
    });
    it('bare acknowledgements, even word for word', () => {
      expect(matchDuplicate(incoming('Re: quote', 'Thanks!', []), [cand('Re: quote', 'Thanks!', [])])).toBeNull();
    });
    // Signatures without a "--" separator: "Thanks! <signature>" says nothing, even when the signature is long.
    const SIG =
      'John Smith\nSenior Account Executive\nABC Insurance Brokers\n123 Main Street, Suite 400, Springfield IL 62701\n' +
      'Phone 555 123 4567 | Fax 555 123 4568\nLicensed in Illinois, Indiana and Wisconsin. Serving physicians since 1987.';
    it('a new request that ends with the same sign-off and signature as an earlier acknowledgement', () => {
      const ack = cand('Thanks', `Thanks!\n${SIG}`, []);
      expect(ack.fingerprints.bodyFingerprint).toBeNull();
      const request = `Hi, can you please quote Dr. Patel, a cardiologist in Chicago, starting Jan 1?\n\nThanks!\n${SIG}`;
      expect(matchDuplicate(incoming('Dr. Patel new request', request, []), [ack])).toBeNull();
    });
    it('two acknowledgements with the same signature in different threads', () => {
      expect(
        matchDuplicate(incoming('Re: Dr. Lee', `Thanks!\n${SIG}`, []), [cand('Re: Dr. Kim', `Thanks!\n${SIG}`, [])]),
      ).toBeNull();
    });
    it('the same text with different document bytes (a re-exported PDF may differ)', () => {
      expect(matchDuplicate(incoming('New submission', LONG, [doc('a2')]), [c])).toBeNull();
    });
    it('emails that only share a signature logo', () => {
      const logo = doc('logo', 'image001.png', { mimeType: 'image/png', sizeBytes: 4000 });
      expect(
        matchDuplicate(
          incoming('Other topic', 'A different message entirely about scheduling a call next week with the team', [
            logo,
          ]),
          [cand('New submission', LONG, [doc('a'), logo])],
        ),
      ).toBeNull();
    });
  });

  it('keeps the strongest match among candidates', () => {
    const partial = cand(
      'Other',
      'Different text that mentions the same documents but says something else entirely here',
      [doc('a'), doc('b'), doc('c')],
    );
    const exact = cand('New submission', LONG, [doc('a'), doc('b')]);
    expect(matchDuplicate(incoming('New submission', LONG, [doc('a'), doc('b')]), [partial, exact])).toMatchObject({
      rule: 'R2',
      candidate: { id: exact.id },
    });
  });
});

describe('duplicate explanations', () => {
  const ctx = {
    originalSubject: 'Renewal - Dr. Carter',
    msBetween: 3 * 60_000,
    sharedAttachments: [],
    sender: 'a@x.com',
    originalSender: 'a@x.com',
    originalStatus: 'READY_FOR_REVIEW',
  };
  const base = {
    strength: 'HIGH' as const,
    similarity: 1,
    differentSender: false,
    addedWords: [],
    removedWords: [],
    wordCount: 547,
  };

  it('states the evidence', () => {
    expect(explainDuplicate({ ...base, rule: 'R7' }, ctx)).toBe(
      'The same text (547 words) as "Renewal - Dr. Carter", received 3 minutes earlier, under a different subject. Neither has attachments.',
    );
    expect(
      explainDuplicate(
        { ...base, rule: 'R3', addedWords: ['see', 'attached'] },
        { ...ctx, sharedAttachments: ['App.pdf'] },
      ),
    ).toContain('The same 1 attachment (App.pdf)');
    expect(
      explainDuplicate(
        { ...base, rule: 'R4', strength: 'POSSIBLE', similarity: 0.97, removedWords: ['smith'], addedWords: ['smyth'] },
        ctx,
      ),
    ).toContain('only 2 words differ (removed "smith", added "smyth")');
  });

  it('says when the sender differs or the original failed', () => {
    const t = explainDuplicate(
      { ...base, rule: 'R2', strength: 'POSSIBLE', differentSender: true },
      { ...ctx, sender: 'x@other.com', originalStatus: 'ERROR' },
    );
    expect(t).toContain('different address (x@other.com; the original came from a@x.com)');
    expect(t).toContain('reprocess the original');
  });
});
