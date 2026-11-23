#!/usr/bin/env node
// Push emails (read through the Gmail connector) into the portal's intake pipeline.
//
//   node backend/scripts/intake.mjs <emails.json>
//
// emails.json: [{ gmailMessageId, rfcMessageId?, threadId?, from, to?, subject, date?, body, attachments?: [{ filename, path? }] }]
// Attachments with a local `path` are uploaded; others are listed in the body for follow-up.
// Env: PORTAL_EMAIL, PORTAL_PASSWORD (required), PORTAL_API (default http://localhost:3002/api).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const API = (process.env.PORTAL_API ?? 'http://localhost:3002/api').replace(/\/$/, '');
const { PORTAL_EMAIL, PORTAL_PASSWORD } = process.env;
const file = process.argv[2];
if (!file || !PORTAL_EMAIL || !PORTAL_PASSWORD) {
  console.error('Usage: PORTAL_EMAIL=... PORTAL_PASSWORD=... node backend/scripts/intake.mjs <emails.json>');
  process.exit(2);
}

const emails = JSON.parse(readFileSync(file, 'utf8'));
const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Client': 'cli' }, // ask for the token in the body
  body: JSON.stringify({ email: PORTAL_EMAIL, password: PORTAL_PASSWORD }),
});
if (!login.ok) {
  console.error(`Login failed: HTTP ${login.status} ${await login.text()}`);
  process.exit(1);
}
const { token } = await login.json();

const results = [];
for (const e of Array.isArray(emails) ? emails : [emails]) {
  const pending = (e.attachments ?? []).filter((a) => !a.path).map((a) => a.filename);
  const body = pending.length
    ? `${e.body ?? ''}\n\n[Attachments in Gmail not transferred at intake: ${pending.join(', ')}]`
    : (e.body ?? '');
  const form = new FormData();
  form.set('subject', e.subject || '(no subject)');
  form.set('fromAddress', e.from || 'unknown');
  form.set('toAddress', e.to ?? '');
  form.set('bodyText', body);
  if (e.gmailMessageId) form.set('gmailMessageId', e.gmailMessageId);
  if (e.threadId) form.set('threadId', e.threadId);
  if (e.rfcMessageId) form.set('rfcMessageId', e.rfcMessageId);
  if (e.date) form.set('receivedAt', new Date(e.date).toISOString());
  for (const a of (e.attachments ?? []).filter((x) => x.path)) {
    form.append('files', new Blob([readFileSync(a.path)]), a.filename ?? basename(a.path));
  }
  const res = await fetch(`${API}/submissions/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const out = await res.json().catch(() => ({}));
  results.push({
    gmailMessageId: e.gmailMessageId,
    subject: e.subject,
    result:
      res.status === 201
        ? 'CREATED'
        : res.status === 200
          ? 'ALREADY_INGESTED'
          : `ERROR ${res.status}: ${out?.error?.message ?? ''}`,
    submissionId: out?.id ?? null,
    attachmentsPending: pending,
  });
}
console.log(JSON.stringify(results, null, 2));
