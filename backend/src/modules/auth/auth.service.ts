import { createHash } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { config } from '../../config.js';
import { withTransaction } from '../../db/pool.js';
import type { UserRow } from '../../db/rows.js';
import type { AppDeps } from '../../deps.js';
import { AppError, type AuthUser, invalidateUserAuth, type Role } from '../../http.js';
import { logger } from '../../logger.js';
import { hasPermission } from '../../permissions.js';
import { audit } from '../../services/audit.js';
import { safeEqual } from '../../services/crypto.js';
import * as repo from './auth.repository.js';

export const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so a miss costs the same bcrypt time as a wrong password.
const DUMMY_HASH = '$2b$12$0WTI036PMD9ncvuvm3V9ZOXfxok8NJtSQ4BASTJDmnNCLzm9BeWaK';

/** Short, stable fingerprint of a login email for the audit trail (the attempted address itself isn't stored). */
const emailFingerprint = (email: string) => createHash('sha256').update(email).digest('hex').slice(0, 16);

/** How the first (bootstrap) account is guarded: in production it must present SETUP_TOKEN (SEC-08). */
export interface BootstrapGuard {
  requireToken: boolean;
  setupToken: string | undefined;
}
const defaultBootstrapGuard = (): BootstrapGuard => ({
  requireToken: config.NODE_ENV === 'production',
  setupToken: config.SETUP_TOKEN,
});

/**
 * Throws unless the first account may be created with `given`. Outside production anyone may (local setup); in
 * production only someone holding SETUP_TOKEN, and with none configured nobody, so an exposed fresh deployment
 * cannot be claimed by whoever reaches it first.
 */
export function checkSetupToken(given: string | undefined, guard: BootstrapGuard): void {
  if (!guard.requireToken) return;
  if (!guard.setupToken)
    throw new AppError(
      'SETUP_TOKEN_NOT_CONFIGURED',
      503,
      'First-user setup is locked. The server operator must set SETUP_TOKEN in the server environment and restart, then enter it here.',
    );
  if (!given || !safeEqual(given, guard.setupToken))
    throw new AppError('SETUP_TOKEN_INVALID', 403, 'The setup token is missing or incorrect.');
}

/** Accounts and passwords; the session cookie and token are the routes' (they set headers). */
export function createAuthService(
  { db }: Pick<AppDeps, 'db'>,
  bootstrapGuard: BootstrapGuard = defaultBootstrapGuard(),
) {
  return {
    needsSetup: async () => (await repo.countUsers(db)) === 0,

    /** Whether creating the first account asks for SETUP_TOKEN (the setup screen shows the field). */
    setupTokenRequired: bootstrapGuard.requireToken,

    /**
     * Admin-created accounts need an admin `actor`; with none, this is only allowed while no user exists, and that
     * first account administers the platform (`bootstrap`). In production the first account also needs `setupToken`.
     */
    async register(
      body: { email: string; password: string; name: string; role?: Role },
      actor: AuthUser | null,
      setupToken?: string,
    ) {
      const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
      return withTransaction(async (tx) => {
        await repo.lockBootstrap(tx);
        const first = (await repo.countUsers(tx)) === 0;
        if (first) checkSetupToken(setupToken, bootstrapGuard);
        if (!first && !hasPermission(actor?.role, 'user:manage'))
          throw new AppError('FORBIDDEN', 403, 'Only administrators can create users');
        const role = first ? 'ADMIN' : (body.role ?? 'UNDERWRITER');
        const row = await repo.insertUser(tx, { email: body.email, name: body.name, passwordHash, role });
        if (!row) throw new AppError('EMAIL_TAKEN', 409, 'A user with this email already exists');
        await audit(
          {
            action: 'USER_CREATED',
            entityType: 'user',
            entityId: row.id,
            actorId: first ? row.id : actor!.id,
            details: { email: row.email, role },
          },
          tx,
        );
        return { user: row, bootstrap: first };
      });
    },

    /** The account for a right email and password; every attempt is audited (a failure by email fingerprint only). */
    async login(email: string, password: string, ip: string | undefined): Promise<UserRow> {
      const user = await repo.findByEmail(db, email);
      const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok) {
        await audit({
          action: 'USER_LOGIN_FAILED',
          entityType: 'user',
          entityId: user?.id ?? null,
          details: { emailHash: emailFingerprint(email), ip, reason: user ? 'WRONG_PASSWORD' : 'UNKNOWN_EMAIL' },
        }).catch((err) => logger.warn({ err }, 'failed-login audit not written'));
        throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password');
      }
      // Only reported after the right password, so it says nothing to someone guessing.
      if (user.disabled_at)
        throw new AppError('ACCOUNT_DISABLED', 403, 'This account is disabled. Contact an administrator.');
      await audit({ action: 'USER_LOGIN', entityType: 'user', entityId: user.id, actorId: user.id });
      return user;
    },

    /** Revokes every token this user holds (other browsers and scripts included). */
    async logout(userId: string) {
      await repo.bumpTokenVersion(db, userId);
      invalidateUserAuth(userId);
      await audit({ action: 'USER_LOGOUT', entityType: 'user', entityId: userId, actorId: userId });
    },

    async me(userId: string) {
      const user = await repo.findById(db, userId);
      if (!user) throw new AppError('UNAUTHENTICATED', 401, 'User no longer exists');
      return user;
    },

    /** Your own password. Other sessions are revoked; the caller issues this one a fresh token. */
    async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<UserRow> {
      const user = await repo.findById(db, userId);
      if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
        throw new AppError('WRONG_PASSWORD', 400, 'The current password is incorrect');
      }
      const updated = await repo.setPassword(db, user.id, await bcrypt.hash(newPassword, BCRYPT_ROUNDS));
      invalidateUserAuth(user.id);
      await audit({ action: 'USER_PASSWORD_CHANGED', entityType: 'user', entityId: user.id, actorId: user.id });
      return updated;
    },
  };
}
