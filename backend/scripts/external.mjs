#!/usr/bin/env node
// Process submissions without an API key: classification + field extraction are done outside the portal.
//
//   node backend/scripts/external.mjs export <ids.txt> <outDir>     # local text extraction → <outDir>/<id>.json
//   node backend/scripts/external.mjs apply <results.json> [...]    # push [{ id, classification, confidence, reasons, fields }]
//   node backend/scripts/external.mjs report-export <SYNTHESIS|ANALYSIS> <ids.txt> <outDir>  # skill + prompt → <outDir>/<id>.json
//   node backend/scripts/external.mjs report-apply <SYNTHESIS|ANALYSIS> <reports.json> [...]  # push [{ id, content }]
//
// Env: PORTAL_EMAIL, PORTAL_PASSWORD (required), PORTAL_API (default http://localhost:3002/api).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = (process.env.PORTAL_API ?? 'http://localhost:3002/api').replace(/\/$/, '');
const { PORTAL_EMAIL, PORTAL_PASSWORD } = process.env;
const [cmd, ...args] = process.argv.slice(2);
if (
  !['export', 'apply', 'report-export', 'report-apply'].includes(cmd) ||
  !args.length ||
  !PORTAL_EMAIL ||
  !PORTAL_PASSWORD
) {
  console.error(
    'Usage: PORTAL_EMAIL=... PORTAL_PASSWORD=... node backend/scripts/external.mjs export <ids.txt> <outDir> | apply <results.json>...' +
      ' | report-export <KIND> <ids.txt> <outDir> | report-apply <KIND> <reports.json>...',
  );
  process.exit(2);
}

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
const post = (path, body) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const get = (path) => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });

// Document reading and processing run in the background (the API answers 202): poll until they finish.
const POLL_MS = 3000;
const WAIT_MS = Number(process.env.PORTAL_WAIT_MS ?? 15 * 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `path` while it answers 202 (documents still being read); the last response. */
async function whileAccepted(first, path) {
  let res = first;
  for (const deadline = Date.now() + WAIT_MS; res.status === 202 && Date.now() < deadline; ) {
    await sleep(Number(res.headers.get('retry-after')) * 1000 || POLL_MS);
    res = await get(path);
  }
  return res;
}
/** Polls the submission until its run finishes (status no longer NEW or PROCESSING); the last detail read. */
async function untilProcessed(id, detail) {
  for (
    const deadline = Date.now() + WAIT_MS;
    ['NEW', 'PROCESSING'].includes(detail?.status) && Date.now() < deadline;

  ) {
    await sleep(POLL_MS);
    const res = await get(`/submissions/${id}`);
    if (!res.ok) break;
    detail = await res.json();
  }
  return detail;
}

// Submission ids go into URL paths and output file names: accept only UUIDs, so a stray "../x" or "a?b" entry in
// an input file can neither reach another endpoint nor write outside <outDir>.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (id) => typeof id === 'string' && UUID.test(id);
const invalid = (id) => ({ id: id ?? null, result: 'ERROR invalid id (expected a submission UUID)' });
const readIds = (file) => readFileSync(file, 'utf8').split(/\s+/).filter(Boolean);
const REPORT_KINDS = ['SYNTHESIS', 'ANALYSIS'];
if (cmd.startsWith('report-') && !REPORT_KINDS.includes(args[0])) {
  console.error(`Report kind must be one of ${REPORT_KINDS.join(', ')}`);
  process.exit(2);
}

const results = [];
if (cmd === 'export') {
  const [idsFile, outDir] = args;
  mkdirSync(outDir, { recursive: true });
  for (const id of readIds(idsFile)) {
    if (!validId(id)) {
      results.push(invalid(id));
      continue;
    }
    const res = await whileAccepted(await post(`/submissions/${id}/extract-text`), `/submissions/${id}/extract-text`);
    const out = await res.json().catch(() => ({}));
    if (res.status === 202) {
      results.push({ id, result: `ERROR still reading ${out.pendingDocuments} document(s) after ${WAIT_MS / 1000} s` });
      continue;
    }
    if (res.ok) writeFileSync(join(outDir, `${id}.json`), JSON.stringify(out, null, 2));
    results.push({
      id,
      result: res.ok ? 'EXPORTED' : `ERROR ${res.status}: ${out?.error?.message ?? ''}`,
      documents: (out.documents ?? []).map((d) => `${d.filename} [${d.status}, ${d.text.length} chars]`),
    });
  }
} else if (cmd === 'report-export') {
  const [kind, idsFile, outDir] = args;
  mkdirSync(outDir, { recursive: true });
  for (const id of readIds(idsFile)) {
    if (!validId(id)) {
      results.push(invalid(id));
      continue;
    }
    const res = await fetch(`${API}/submissions/${id}/report-input?kind=${encodeURIComponent(kind)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok) writeFileSync(join(outDir, `${id}.json`), JSON.stringify({ id, kind, ...out }, null, 2));
    results.push({
      id,
      result: res.ok ? 'EXPORTED' : `ERROR ${res.status}: ${out?.error?.message ?? ''}`,
      promptChars: out.prompt?.length ?? 0,
    });
  }
} else if (cmd === 'report-apply') {
  const [kind, ...files] = args;
  for (const file of files) {
    for (const r of JSON.parse(readFileSync(file, 'utf8'))) {
      if (!validId(r?.id)) {
        results.push(invalid(r?.id));
        continue;
      }
      const res = await post(`/submissions/${r.id}/external-report`, {
        kind,
        content: r.content,
        basedOnReportId: r.basedOnReportId,
      });
      const out = await res.json().catch(() => ({}));
      results.push({
        id: r.id,
        result: res.ok ? `CREATED v${out.version}` : `ERROR ${res.status}: ${out?.error?.message ?? ''}`,
        reportId: out.id ?? null,
      });
    }
  }
} else {
  for (const file of args) {
    for (const r of JSON.parse(readFileSync(file, 'utf8'))) {
      const { id, ...body } = r;
      if (!validId(id)) {
        results.push(invalid(id));
        continue;
      }
      const res = await post(`/submissions/${id}/external-results`, body);
      const out = res.ok ? await untilProcessed(id, await res.json()) : await res.json().catch(() => ({}));
      results.push({
        id,
        result: res.ok ? out.status : `ERROR ${res.status}: ${out?.error?.message ?? ''}`,
        classification: out.classification ?? null,
        fields: out.extractedFields?.length ?? 0,
        processingError: out.processingError ?? null,
      });
    }
  }
}
console.log(JSON.stringify(results, null, 2));
