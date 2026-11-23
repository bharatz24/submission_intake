---
name: security
description: Use for any security-relevant change in either app — rendering untrusted email HTML or LLM/markdown output (XSS, DOMPurify, sandboxed iframes), user/API-supplied URLs and open redirects, CSRF and CORS, helmet/CSP headers, rate limiting, file uploads and attachments (size/type limits, zip bombs, content sniffing, safe downloads), SQL injection, SSRF, secrets and encryption at rest (OAuth refresh tokens), PII/PHI handling and retention, the append-only audit trail, dependency audits, or OWASP Top 10 review. When in doubt whether something is security-relevant, use it.
---

# Security

Threat model in one paragraph: **every email, attachment and sender is untrusted** (anyone can mail the
intake inbox), **LLM output is untrusted** (it can be steered by document content), and the data is
sensitive (physician identities, NPI, claims history). Users are authenticated staff with different roles.
Defend at each boundary; never rely on the UI to enforce anything.

Related: `authentication`, `llm-integration` (prompt injection), `node-api`, `logging-monitoring`,
`environment-config`. Backend hardening details: `references/backend-hardening.md`.

## Frontend rules

- **Render untrusted text through JSX** (escaped). Never `dangerouslySetInnerHTML`, `innerHTML`, or
  `document.write` with unsanitised data.
- **Email HTML is hostile.** Show the plain-text part by default; when HTML is needed, sanitise with
  DOMPurify (add `dompurify` when this is first built; no `style`, `form`, `iframe`, `script`, event handlers), block remote images by default
  (tracking pixels), and render inside a sandboxed `<iframe sandbox="" srcdoc=…>` with no
  `allow-scripts`.
- **Markdown (reports, LLM output, skills) renders without raw HTML** (`react-markdown` without
  `rehype-raw`), and links go through `safeHref`.
- **URLs from data** (email links, LLM output, DB) pass `safeHref()`: only `http:`, `https:`, `mailto:`.
  External links get `target="_blank" rel="noopener noreferrer"`.
- **Redirect targets** (`returnTo`) pass `safeReturnTo()`: same-origin relative paths only.
- **No tokens, PII, or submission data in localStorage, URLs, or logs.** Ids in URLs are fine.
- **Keep the CSP strict:** no inline scripts, `eval`, or `new Function` (Emotion injects `<style>` tags,
  so `style-src` needs a nonce passed to Emotion's cache or `'unsafe-inline'` for styles only); `connect-src` limited to the API
  origin; `frame-src`/`object-src` limited to what the document viewer needs (blob: for local previews).
  The SPA's policy is the `<meta>` tag in `frontend/index.html` (stripped on the dev server). A meta CSP
  can't set `frame-ancestors`, so clickjacking protection must be an HTTP header from whatever serves the
  SPA (`Content-Security-Policy: frame-ancestors 'none'` or `X-Frame-Options: DENY`).
- **`postMessage` listeners check `event.origin`** against an allow-list and validate data with Zod.

## Backend rules

- **Validate every input with Zod** (body, params, query, headers you rely on) and **parameterise every
  SQL query** (`$1`), including `ORDER BY` columns, which come from an allow-list map, never interpolated.
- **Authorization on every route** (`requireAuth` + `requirePermission`) and object-level checks in
  services. A VIEWER must not be able to call a write endpoint just because the button is hidden.
- **Security headers via `helmet`**, CORS restricted to configured origins with `credentials: true`, and
  the CSRF header check for cookie-authenticated unsafe methods (see `authentication`).
- **Rate-limit** login, password reset, any endpoint that sends email or calls the LLM, and the global API,
  keyed on a correctly configured `trust proxy` (never `true`).
- **Uploads and attachments:**
  - Enforce max file size, count, and total size *while streaming* (multer limits), not after buffering.
  - Detect type from content (magic bytes), not the extension or the client's `Content-Type`; allow-list
    PDF, DOCX, XLSX, images, ZIP, EML.
  - ZIP/DOCX/XLSX are archives: cap entry count, total uncompressed size, compression ratio, and nesting
    depth (zip bombs), and reject path traversal in entry names.
  - Parse documents (pdf-parse, mammoth, exceljs, OCR) with time and memory limits, ideally in a worker.
  - Store with a generated name, record a SHA-256 hash, and serve downloads with
    `Content-Disposition: attachment`, the stored content type, and `X-Content-Type-Options: nosniff`.
- **SSRF:** the server never fetches URLs found in emails or documents. Outbound calls go only to
  configured hosts (Google, CMS NPPES, Anthropic, IMS).
- **Secrets at rest:** OAuth refresh tokens and similar credentials are encrypted with AES-256-GCM (random
  96-bit IV per value, auth tag stored, key from env), and never returned by any API.
- **Audit trail is append-only**, enforced in the database (trigger or revoked UPDATE/DELETE grants), and
  records actor, action, target, and before/after for decisions, outbound email, skill edits, settings,
  and user/role changes.
- **Data minimisation:** return only fields the screen needs; define retention for raw emails, extracted
  text and LLM transcripts; deleting a submission deletes or schedules deletion of its stored files.
- **Errors don't leak internals** (see `error-handling`).

## Supply chain

- Commit lockfiles; install with `npm ci`; `npm audit --audit-level=high` in CI; Dependabot/Renovate on.
- Review new dependencies (maintenance, downloads, license, install scripts, size). Pin exact versions
  for the frontend; keep the `overrides` block justified with a comment or ticket.

## Patterns

```ts
// frontend/src/lib/sanitize.ts
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
export function safeHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { return SAFE_PROTOCOLS.has(new URL(value, window.location.origin).protocol) ? value : undefined; }
  catch { return undefined; }
}
export function sanitizeEmailHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'img'], FORBID_ATTR: ['style'] });
}
// <iframe title="Email body" sandbox="" srcDoc={sanitizeEmailHtml(body)} />
```

```ts
// frontend/src/lib/safe-redirect.ts
export function safeReturnTo(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch { return fallback; }
}
```

## Review checklist

- [ ] Untrusted HTML/markdown is sanitised (email HTML sandboxed); URLs pass `safeHref`
- [ ] Every new route validates input, checks permissions, and uses parameterised SQL
- [ ] Uploads are size/type-checked from content, archive-bomb-safe, and served as attachments
- [ ] No server-side fetching of user/document-supplied URLs
- [ ] Secrets encrypted at rest and absent from responses/logs
- [ ] Sensitive actions are rate-limited and audited
- [ ] `npm audit` clean at high; new dependencies reviewed
