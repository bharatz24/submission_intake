import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

const OLD_PASSPHRASE = 'old-passphrase-old-passphrase-old-passphrase';
const NEW_RAW = `base64:${randomBytes(32).toString('base64')}`;

/** crypto.ts reads its keys when loaded: load a fresh copy under the given settings. */
async function cryptoWith(env: { ENCRYPTION_KEY: string; ENCRYPTION_KEYS_PREVIOUS?: string }) {
  vi.resetModules();
  vi.stubEnv('ENCRYPTION_KEY', env.ENCRYPTION_KEY);
  vi.stubEnv('ENCRYPTION_KEYS_PREVIOUS', env.ENCRYPTION_KEYS_PREVIOUS ?? '');
  return import('../src/services/crypto.js');
}

/** A value as stored before versioning: bare base64(iv | tag | ciphertext) under SHA-256(passphrase). */
function legacyEncrypt(plain: string, passphrase: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(passphrase).digest(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('secret encryption', () => {
  it('round-trips under the current key, with a version and key id', async () => {
    const c = await cryptoWith({ ENCRYPTION_KEY: NEW_RAW });
    const sealed = c.encrypt('sk-ant-secret');
    expect(sealed).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(c.decryptSecret(sealed)).toEqual({ value: 'sk-ant-secret', stale: false });
  });

  it('reads values from before versioning and flags them for re-encryption', async () => {
    const c = await cryptoWith({ ENCRYPTION_KEY: OLD_PASSPHRASE });
    expect(c.decryptSecret(legacyEncrypt('refresh-token', OLD_PASSPHRASE))).toEqual({
      value: 'refresh-token',
      stale: true,
    });
  });

  it('rotates: the previous key still decrypts, and the result is re-encrypted under the new one', async () => {
    const before = await cryptoWith({ ENCRYPTION_KEY: OLD_PASSPHRASE });
    const underOld = before.encrypt('refresh-token');
    const legacy = legacyEncrypt('api-key', OLD_PASSPHRASE);

    const after = await cryptoWith({ ENCRYPTION_KEY: NEW_RAW, ENCRYPTION_KEYS_PREVIOUS: OLD_PASSPHRASE });
    const read = after.decryptSecret(underOld);
    expect(read).toEqual({ value: 'refresh-token', stale: true });
    expect(after.decryptSecret(legacy)).toEqual({ value: 'api-key', stale: true });
    expect(after.decryptSecret(after.encrypt(read.value)).stale).toBe(false);

    // Once the old key is dropped, only what was re-encrypted can be read.
    const dropped = await cryptoWith({ ENCRYPTION_KEY: NEW_RAW });
    expect(() => dropped.decryptSecret(underOld)).toThrow(/neither ENCRYPTION_KEY nor in ENCRYPTION_KEYS_PREVIOUS/);
    expect(() => dropped.decryptSecret(legacy)).toThrow(/No configured encryption key/);
  });

  it('refuses a truncated authentication tag and a payload shorter than IV + tag', async () => {
    const c = await cryptoWith({ ENCRYPTION_KEY: NEW_RAW });
    const sealed = c.encrypt('');
    const [, keyId, body] = sealed.split(':');
    const raw = Buffer.from(body!, 'base64');
    expect(raw.length).toBe(28); // 12-byte IV + 16-byte tag, empty ciphertext
    // A valid 12-byte prefix of the real tag: GCM accepts it unless the tag length is pinned to 16.
    const shortTag = `v1:${keyId}:${raw.subarray(0, 24).toString('base64')}`;
    expect(() => c.decryptSecret(shortTag)).toThrow(/too short/);
    expect(() => c.decryptSecret(`v1:${keyId}:${Buffer.alloc(5).toString('base64')}`)).toThrow(/too short/);
    expect(() => c.decryptSecret(raw.subarray(0, 24).toString('base64'))).toThrow(/No configured encryption key/);
    expect(c.decryptSecret(sealed).value).toBe('');
  });

  it('refuses a base64: key that is not 32 bytes', async () => {
    const { keyFromSetting } = await cryptoWith({ ENCRYPTION_KEY: NEW_RAW });
    expect(() => keyFromSetting(`base64:${randomBytes(16).toString('base64')}`)).toThrow(/32 bytes/);
  });
});
