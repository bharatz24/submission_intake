import { randomBytes } from 'node:crypto';

/** RFC 5322 message builder for replies and forwards sent through the Gmail API (raw, base64url). */

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MimeMessage {
  from?: string | null;
  to: string[];
  cc?: string[];
  /** Gmail delivers to Bcc recipients and removes the header before sending. */
  bcc?: string[];
  subject: string;
  body: string;
  /** RFC Message-ID of the email being answered; keeps the reply in the recipient's thread. */
  inReplyTo?: string | null;
  attachments?: MimeAttachment[];
}

// Deliberately simple: one @, no spaces or angle brackets, a dot in the domain. Rejects what would break a header.
const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** "Jane <jane@x.com>" or "jane@x.com" → "jane@x.com"; null when it is not a usable address. */
export function addressOf(raw: string): string | null {
  const t = raw.trim();
  const m = /<([^<>]+)>\s*$/.exec(t);
  const addr = (m ? m[1]! : t).trim();
  return ADDRESS.test(addr) ? addr : null;
}

export function isValidAddress(raw: string): boolean {
  return addressOf(raw) !== null && !/[\r\n]/.test(raw);
}

/** Header-safe text: CR/LF would let a value start a new header. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeader(text: string): string {
  const t = oneLine(text);

  if (/^[\x20-\x7e]*$/.test(t)) return t;
  return `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`;
}

function encodeAddress(raw: string): string {
  const t = oneLine(raw);
  const m = /^"?(.*?)"?\s*<([^<>]+)>$/.exec(t);
  if (!m || !m[1]) return t;
  const name = /^[\w .'-]*$/.test(m[1]) ? `"${m[1]}"` : encodeHeader(m[1]);
  return `${name} <${m[2]}>`;
}

/** Base64 in 76-character lines, as MIME requires. */
const base64Lines = (data: Buffer) => data.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');

/** filename="…" for ASCII names, plus RFC 2231 filename*= so non-ASCII names survive. */
function filenameParams(name: string): string {
  const safe = oneLine(name).replace(/["\\]/g, '_');

  if (/^[\x20-\x7e]*$/.test(safe)) return `filename="${safe}"`;
  return `filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function buildMime(msg: MimeMessage, boundary = `sr_${randomBytes(12).toString('hex')}`): string {
  const headers: string[] = [];
  if (msg.from) headers.push(`From: ${encodeAddress(msg.from)}`);
  headers.push(`To: ${msg.to.map(encodeAddress).join(', ')}`);
  if (msg.cc?.length) headers.push(`Cc: ${msg.cc.map(encodeAddress).join(', ')}`);
  if (msg.bcc?.length) headers.push(`Bcc: ${msg.bcc.map(encodeAddress).join(', ')}`);
  headers.push(`Subject: ${encodeHeader(msg.subject)}`);
  if (msg.inReplyTo) {
    const id = oneLine(msg.inReplyTo);
    headers.push(`In-Reply-To: ${id}`, `References: ${id}`);
  }
  headers.push('MIME-Version: 1.0');

  const text = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(msg.body, 'utf8')),
  ];
  const attachments = msg.attachments ?? [];
  if (!attachments.length) return [...headers, ...text, ''].join('\r\n');

  const parts = [
    text.join('\r\n'),
    ...attachments.map((a) =>
      [
        `Content-Type: ${oneLine(a.mimeType) || 'application/octet-stream'}; name="${oneLine(a.filename).replace(/["\\]/g, '_')}"`,
        `Content-Disposition: attachment; ${filenameParams(a.filename)}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(a.data),
      ].join('\r\n'),
    ),
  ];
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts.map((p) => `--${boundary}\r\n${p}`),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// RFC 7231 media type: type "/" subtype, optional `; name=value` parameters, tokens only (no CR/LF, spaces or quotes).
const MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/i;

/** A stored (sender-supplied) MIME type safe to send as Content-Type; anything malformed becomes application/octet-stream. */
export function safeContentType(mimeType: string | null | undefined): string {
  const v = (mimeType ?? '').trim();
  return MEDIA_TYPE.test(v) ? v : 'application/octet-stream';
}
