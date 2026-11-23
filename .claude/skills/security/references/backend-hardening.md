# Backend hardening reference

Read this when wiring middleware, handling uploads/archives, encrypting credentials, or reviewing a route
against OWASP Top 10. SKILL.md has the rules; this file has the working code shapes.

## Contents
1. Middleware order
2. Upload limits (multer)
3. Archive (ZIP/DOCX/XLSX) safety
4. Content-type sniffing
5. AES-256-GCM for stored credentials
6. Safe downloads
7. Append-only audit table
8. OWASP Top 10 quick map

## 1. Middleware order

```ts
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);              // number of hops or a subnet list, never `true`
app.use(helmet({ contentSecurityPolicy: false }));       // API serves JSON; the SPA's CSP is set where it's served
app.use(pinoHttp(/* request ids, see logging-monitoring */));
app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true, exposedHeaders: ['Content-Disposition'] })); // exact origin(s), never '*' with credentials; expose the header so downloads keep their filename
app.use(express.json({ limit: '1mb' }));                  // uploads use multer, not the JSON parser
// Cookies: the app reads its single session cookie itself; add cookie-parser only if more are needed.
app.use('/api', apiRateLimit);                            // per-IP baseline
app.use('/api', csrfHeaderCheck);                         // cookie-auth unsafe methods need X-Requested-With
app.use('/api', routes);
app.use(notFoundHandler);
app.use(errorHandler);                                    // last
```

## 2. Upload limits (multer)

```ts
export const upload = multer({
  storage: multer.memoryStorage(), // or disk in a temp dir for large files; never the web root
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS, fields: 20, parts: MAX_ATTACHMENTS + 20 },
});
// multer throws LIMIT_FILE_SIZE etc. → map to 413 PAYLOAD_TOO_LARGE in the error handler
```

## 3. Archive safety

```ts
const MAX_ENTRIES = 500;
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
const MAX_RATIO = 100;

export async function inspectZip(buffer: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new AppError('ARCHIVE_TOO_LARGE', 422, 'The archive has too many files');
  let total = 0;
  for (const entry of entries) {
    // Check path segments ('loss..runs.pdf' is fine, '../x' is not), plus absolute and drive-letter paths
    if (entry.name.split(/[\\/]/).includes('..') || /^([\\/]|[a-zA-Z]:)/.test(entry.name)) throw new AppError('ARCHIVE_INVALID', 422, 'The archive contains unsafe paths');
    if (entry.dir) continue;
    // Declared sizes can lie: stream each entry and count real bytes, stopping as soon as a cap is passed.
    total = await countEntryBytes(entry, total, Math.min(MAX_TOTAL_UNCOMPRESSED, buffer.byteLength * MAX_RATIO));
  }
}

function countEntryBytes(entry: JSZip.JSZipObject, start: number, cap: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let total = start;
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        stream.pause();
        reject(new AppError('ARCHIVE_TOO_LARGE', 422, 'The archive expands beyond the allowed size'));
      }
    });
    stream.on('end', () => resolve(total));
    stream.on('error', reject);
  });
}
```

Apply the same caps to DOCX/XLSX before handing them to mammoth/exceljs (they are ZIPs). Don't recurse into
nested archives beyond depth 1.

## 4. Content-type sniffing

Check magic bytes: PDF `%PDF-`, ZIP/DOCX/XLSX `PK\x03\x04`, PNG `\x89PNG`, JPEG `\xFF\xD8\xFF`. Reject
anything not on the allow-list even if the extension looks right. Store the detected type, not the
client-declared one.

## 5. AES-256-GCM for stored credentials

```ts
const KEY = Buffer.from(config.encryptionKey, 'base64'); // 32 bytes
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
```

The version prefix lets you rotate keys: add `v2` with a new key, decrypt either, and re-encrypt on read.
Use the same mechanism when changing how the key is derived (for example from `sha256(passphrase)` to a
raw base64 key): switching in place makes every stored credential undecryptable.

## 6. Safe downloads

```ts
res.setHeader('Content-Type', file.detectedType);
res.attachment(file.originalName);                    // Express encodes the filename safely (RFC 6266)
res.setHeader('X-Content-Type-Options', 'nosniff');
res.setHeader('Cache-Control', 'private, no-store');
stream.pipe(res);
```

Inline preview (PDF viewer) is allowed only for PDFs and images, still with `nosniff` and a CSP
`sandbox` header on the response.

## 7. Append-only audit table

```sql
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,             -- 'email.sent', 'decision.updated', 'skill.edited'
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events  -- row triggers don't fire on TRUNCATE
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
```

## 8. OWASP Top 10 quick map

| Risk | Where it bites here | Control |
|---|---|---|
| Broken access control | write routes reachable by VIEWER; other users' drafts | `requirePermission` + object checks in services |
| Cryptographic failures | OAuth tokens, cookies over HTTP | AES-GCM at rest, `Secure` cookies, TLS |
| Injection | SQL sort/filter params, prompt injection | parameterised SQL + allow-lists; see `llm-integration` |
| Insecure design | AI output treated as a decision | human decision step, audit, evidence links |
| Misconfiguration | `trust proxy: true`, permissive CORS | config validation, helmet, allow-lists |
| Vulnerable components | parsers (pdf, xlsx, zip) | `npm audit`, updates, sandboxed parsing |
| Auth failures | brute force, stale sessions | rate limits, token version, short expiry |
| Integrity failures | unsigned push notifications | treat push as a trigger only; fetch from source |
| Logging failures | PII in logs; no audit | redaction config; append-only audit |
| SSRF | URLs in email bodies | never fetch user-supplied URLs |
