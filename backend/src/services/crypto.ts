import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';

/**
 * Secrets at rest (Gmail refresh token, Anthropic API key): AES-256-GCM.
 *
 * Stored as `v1:<keyId>:base64(iv | tag | ciphertext)`. keyId names the key that encrypted it, so ENCRYPTION_KEY can be
 * rotated: put the old value in ENCRYPTION_KEYS_PREVIOUS, and every secret still under it is decrypted with it and
 * re-encrypted under the new key the next time it is read (decryptSecret → `stale`). Values written before this format
 * (bare base64, no prefix) are read the same way.
 *
 * A key is either `base64:<32 random bytes>` (used as is; `openssl rand -base64 32`) or a passphrase of at least
 * 32 characters (hashed with SHA-256, the original scheme). Production requires the base64 form for ENCRYPTION_KEY
 * (config.ts); a passphrase is still accepted in ENCRYPTION_KEYS_PREVIOUS, so values under it can be rotated away.
 */

const FORMAT = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const RAW_KEY_PREFIX = 'base64:';
const KEY_ID_HEX = 8;

interface Key {
  id: string;
  bytes: Buffer;
}

export function keyFromSetting(setting: string): Key {
  const bytes = setting.startsWith(RAW_KEY_PREFIX)
    ? Buffer.from(setting.slice(RAW_KEY_PREFIX.length), 'base64')
    : createHash('sha256').update(setting).digest();
  if (bytes.length !== 32) throw new Error('An encryption key given as base64: must decode to exactly 32 bytes');
  // A fingerprint of the key, not the key: 32 bits of its SHA-256 identify it among a handful of keys.
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, KEY_ID_HEX), bytes };
}

const previousSettings = (config.ENCRYPTION_KEYS_PREVIOUS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const current = keyFromSetting(config.ENCRYPTION_KEY);
const keys: Key[] = [current, ...previousSettings.map(keyFromSetting)];

function seal(plain: string, key: Key): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${FORMAT}:${key.id}:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

function open(body: string, key: Key): string {
  const buf = Buffer.from(body, 'base64');
  // Without a full IV and tag the payload is damaged or forged; GCM would otherwise accept a truncated tag.
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('Encrypted value is too short to be valid');
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, buf.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** Encrypt under the current ENCRYPTION_KEY. */
export function encrypt(plain: string): string {
  return seal(plain, current);
}

export interface Decrypted {
  value: string;
  /** Not under the current key or format: store `encrypt(value)` in its place. */
  stale: boolean;
}

/** Decrypt with whichever configured key wrote it. Throws when none can (the key was changed without being kept). */
export function decryptSecret(payload: string): Decrypted {
  const m = /^v1:([0-9a-f]+):(.+)$/s.exec(payload);
  if (m) {
    const key = keys.find((k) => k.id === m[1]);
    if (!key)
      throw new Error(`Encrypted with key ${m[1]}, which is neither ENCRYPTION_KEY nor in ENCRYPTION_KEYS_PREVIOUS`);
    return { value: open(m[2]!, key), stale: key !== current };
  }
  // Written before versioning: try each key; GCM's tag rejects the wrong ones.
  for (const key of keys) {
    try {
      return { value: open(payload, key), stale: true };
    } catch {
      /* next key */
    }
  }
  throw new Error('No configured encryption key can decrypt this value (ENCRYPTION_KEY changed?)');
}

export function decrypt(payload: string): string {
  return decryptSecret(payload).value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Constant-time string comparison that also hides the length (both sides are hashed to the same size first). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** A key for one purpose, derived from a master secret, so a token signed for one use never verifies for another. */
export function deriveKey(secret: string, purpose: string): string {
  return createHmac('sha256', secret).update(purpose).digest('base64url');
}
