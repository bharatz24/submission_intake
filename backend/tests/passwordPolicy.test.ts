import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_BYTES, PasswordSchema } from '../src/services/passwordPolicy.js';

const message = (password: string) => PasswordSchema.safeParse(password).error?.issues[0]?.message;

describe('PasswordSchema', () => {
  it('accepts an ordinary passphrase', () => {
    expect(PasswordSchema.safeParse('correct-horse-battery').success).toBe(true);
  });

  it('requires 10 characters', () => {
    expect(message('short-pw')).toMatch(/at least 10/);
  });

  it('refuses more than 72 bytes, counting multi-byte characters', () => {
    const varied = (n: number) => 'abcdefgh'.repeat(10).slice(0, n);
    expect(PasswordSchema.safeParse(varied(PASSWORD_MAX_BYTES)).success).toBe(true);
    expect(message(varied(PASSWORD_MAX_BYTES + 1))).toMatch(/at most 72 bytes/);
    // 30 characters but 90 bytes: bcrypt would silently drop the last 6 characters.
    expect(message('€'.repeat(30))).toMatch(/at most 72 bytes/);
  });

  it('refuses well-known passwords whatever the case', () => {
    for (const p of ['Password123', 'QWERTYUIOP', '1234567890', 'zzzzzzzzzzzz', '12345678901234567890']) {
      expect(message(p), p).toMatch(/too common/);
    }
  });
});
