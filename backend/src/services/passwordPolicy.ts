import { z } from 'zod';

/** bcrypt only hashes the first 72 bytes; anything longer would be silently ignored, so it is refused instead. */
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 10;

// Common passwords of at least PASSWORD_MIN_LENGTH characters (lowercased), from public breach top lists.
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0123456789',
  '0987654321',
  '1111111111',
  '1234512345',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'qwertyuiop',
  'qwerty1234',
  'qwerty12345',
  'qwerty123456',
  'asdfghjkl1',
  'zxcvbnm123',
  'password12',
  'password123',
  'password1234',
  'password!1',
  'passw0rd123',
  'p@ssw0rd123',
  'p@ssword123',
  'iloveyou12',
  'iloveyou123',
  'abcdefghij',
  'abcd123456',
  'abc1234567',
  'a123456789',
  'welcome123',
  'welcome1234',
  'letmein123',
  'football12',
  'football123',
  'baseball12',
  'baseball123',
  'basketball',
  'sunshine12',
  'princess12',
  'superman12',
  'starwars12',
  'michael123',
  'jennifer12',
  'charlie123',
  'trustno1234',
  'changeme123',
  'administrator',
  'admin12345',
  'admin123456',
  'adminadmin',
  'computer12',
  'internet12',
  'whatever12',
  'freedom123',
  'monkey1234',
  'dragon1234',
  'master1234',
  'shadow1234',
  'qazwsxedc123',
  'q1w2e3r4t5',
  'q1w2e3r4t5y6',
  '1q2w3e4r5t6y',
  'zaq12wsxcde3',
  'underwriter',
  'underwriter1',
  'insurance1',
  'insurance123',
  'submission1',
  'submission123',
]);

function isTooCommon(password: string): boolean {
  const p = password.toLowerCase();
  if (COMMON_PASSWORDS.has(p)) return true;
  if (/^(.)\1+$/.test(p)) return true; // one repeated character
  return /^(?:0123456789|1234567890|abcdefghijklmnopqrstuvwxyz|qwertyuiop)+$/.test(p); // a pure keyboard run
}

/** Rules for every new password: length, bcrypt's 72-byte limit, and not a well-known password. */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine(
    (p) => Buffer.byteLength(p, 'utf8') <= PASSWORD_MAX_BYTES,
    `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  )
  .refine((p) => !isTooCommon(p), 'This password is too common. Choose a less predictable one.');
