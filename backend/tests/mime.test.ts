import { describe, expect, it } from 'vitest';

import { parseSendResult } from '../src/services/gmailMcp.js';
import { addressOf, buildMime, encodeHeader, isValidAddress } from '../src/services/mime.js';

const decodeBase64Part = (mime: string, after: string) => {
  const start = mime.indexOf(after) + after.length;
  const block = mime
    .slice(start)
    .split(/\r\n\r\n/)[1]!
    .split(/\r\n--/)[0]!;
  return Buffer.from(block.replace(/\r\n/g, ''), 'base64');
};

describe('MIME builder', () => {
  it('validates and extracts addresses', () => {
    expect(addressOf('Jane Smith <jane@acme.com>')).toBe('jane@acme.com');
    expect(addressOf(' broker@agency.co ')).toBe('broker@agency.co');
    expect(addressOf('not-an-address')).toBeNull();
    expect(addressOf('a@b')).toBeNull();
    expect(isValidAddress('x@y.com\r\nBcc: evil@z.com')).toBe(false);
  });

  it('encodes non-ASCII headers and leaves ASCII alone', () => {
    expect(encodeHeader('Re: Quote')).toBe('Re: Quote');
    expect(encodeHeader('Re: Café')).toBe(`=?UTF-8?B?${Buffer.from('Re: Café').toString('base64')}?=`);
  });

  it('builds a threaded plain-text reply with no header injection', () => {
    const mime = buildMime({
      from: 'uw@insurer.com',
      to: ['Jane Smith <jane@acme.com>'],
      cc: ['b@agency.com'],
      bcc: ['audit@insurer.com'],
      subject: 'Re: Quote\r\nBcc: evil@x.com',
      body: 'Thanks — received.',
      inReplyTo: '<abc@mail.gmail.com>',
    });
    const [head] = mime.split('\r\n\r\n');
    expect(head).toContain('To: "Jane Smith" <jane@acme.com>');
    expect(head).toContain('Cc: b@agency.com');
    expect(head).toContain('Bcc: audit@insurer.com');
    expect(head).toContain('In-Reply-To: <abc@mail.gmail.com>');
    expect(head).toContain('References: <abc@mail.gmail.com>');
    expect(head).toContain('Subject: Re: Quote Bcc: evil@x.com');
    expect(head!.split('\r\n').filter((l) => l.startsWith('Bcc:'))).toHaveLength(1);
    expect(decodeBase64Part(mime, 'Content-Transfer-Encoding: base64').toString('utf8')).toBe('Thanks — received.');
  });

  it('attaches files as multipart/mixed with safe filenames', () => {
    const data = Buffer.alloc(200, 7);
    const mime = buildMime(
      {
        to: ['x@y.com'],
        subject: 'Fwd: Docs',
        body: 'See attached',
        attachments: [
          { filename: 'loss "runs".pdf', mimeType: 'application/pdf', data },
          { filename: 'résumé.pdf', mimeType: 'application/pdf', data },
        ],
      },
      'BOUNDARY',
    );
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY"');
    expect(mime).toContain('Content-Disposition: attachment; filename="loss _runs_.pdf"');
    expect(mime).toContain(`filename*=UTF-8''${encodeURIComponent('résumé.pdf')}`);
    expect(mime.trimEnd().endsWith('--BOUNDARY--')).toBe(true);
    expect(mime.split('\r\n').every((l) => l.length <= 998)).toBe(true);
    expect(decodeBase64Part(mime, 'filename="loss _runs_.pdf"')).toEqual(data);
  });
});

describe('Gmail MCP send result', () => {
  it('reads the message and thread IDs from structured or text results', () => {
    expect(parseSendResult({ id: 'm1', threadId: 't1' }, '')).toEqual({ messageId: 'm1', threadId: 't1' });
    expect(parseSendResult(undefined, 'Email sent successfully with ID: 18c2f')).toEqual({
      messageId: '18c2f',
      threadId: null,
    });
    expect(parseSendResult(undefined, 'Thread ID: t9\nMessage ID: m9')).toEqual({ messageId: 'm9', threadId: 't9' });
  });
});
