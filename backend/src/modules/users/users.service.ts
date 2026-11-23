import bcrypt from 'bcryptjs';

import { withTransaction } from '../../db/pool.js';
import type { UserRow } from '../../db/rows.js';
import type { AppDeps } from '../../deps.js';
import { AppError, invalidateUserAuth, notFound, type Role } from '../../http.js';
import { audit } from '../../services/audit.js';
import { mapUser } from '../../services/queries.js';
import { BCRYPT_ROUNDS } from '../auth/auth.service.js';
import * as repo from './users.repository.js';

const mapManagedUser = (r: UserRow) => ({
  ...mapUser(r),
  disabledAt: r.disabled_at ? new Date(r.disabled_at).toISOString() : null,
  passwordChangedAt: r.password_changed_at ? new Date(r.password_changed_at).toISOString() : null,
});

/** Its role and status are fixed and only it changes its password. */
function refuseDefaultAdmin(id: string, defaultId: string | null) {
  if (id === defaultId)
    throw new AppError('DEFAULT_ADMIN_PROTECTED', 403, 'The default administrator cannot be modified');
}

/** Admins manage accounts (role, disabled, password); everyone else sees who work can be assigned to. */
export function createUsersService({ db }: Pick<AppDeps, 'db'>) {
  return {
    async listManaged() {
      const [rows, defaultId] = await Promise.all([repo.listAll(db), repo.defaultAdminId(db)]);
      return rows.map((r) => ({ ...mapManagedUser(r), isDefaultAdmin: r.id === defaultId }));
    },

    listAssignable: () => repo.listAssignable(db),

    /** Change a role and/or disable or enable the account. Revokes their tokens on role change or disable. */
    async changeAccess(id: string, change: { role?: Role; disabled?: boolean }, actorId: string) {
      if (change.disabled === true && id === actorId)
        throw new AppError('CANNOT_DISABLE_SELF', 400, 'You cannot disable your own account');
      const updated = await withTransaction(async (tx) => {
        await repo.lockAdmins(tx);
        const user = await repo.lockUser(tx, id);
        if (!user) throw notFound('User');
        refuseDefaultAdmin(id, await repo.defaultAdminId(tx));
        const role = change.role ?? user.role;
        const disabled = change.disabled ?? user.disabled_at !== null;
        const wasActiveAdmin = user.role === 'ADMIN' && user.disabled_at === null;
        if (wasActiveAdmin && (role !== 'ADMIN' || disabled) && (await repo.otherActiveAdmins(tx, id)) === 0) {
          throw new AppError('LAST_ADMIN', 409, 'At least one active administrator must remain');
        }
        const roleChanged = role !== user.role;
        const disabling = disabled && user.disabled_at === null;
        const enabling = !disabled && user.disabled_at !== null;
        if (!roleChanged && !disabling && !enabling) return user;
        const row = await repo.updateAccess(tx, id, role, disabled, roleChanged || disabling);
        if (roleChanged)
          await audit(
            {
              action: 'USER_ROLE_CHANGED',
              entityType: 'user',
              entityId: id,
              actorId,
              details: { email: user.email, from: user.role, to: role },
            },
            tx,
          );
        if (disabling)
          await audit(
            { action: 'USER_DISABLED', entityType: 'user', entityId: id, actorId, details: { email: user.email } },
            tx,
          );
        if (enabling)
          await audit(
            { action: 'USER_ENABLED', entityType: 'user', entityId: id, actorId, details: { email: user.email } },
            tx,
          );
        return row;
      });
      invalidateUserAuth(id);
      return mapManagedUser(updated);
    },

    /** Admin sets a new password for a user; every token they hold is revoked. */
    async resetPassword(id: string, password: string, actorId: string) {
      refuseDefaultAdmin(id, await repo.defaultAdminId(db));
      const row = await repo.setPassword(db, id, await bcrypt.hash(password, BCRYPT_ROUNDS));
      if (!row) throw notFound('User');
      invalidateUserAuth(id);
      await audit({
        action: 'USER_PASSWORD_RESET',
        entityType: 'user',
        entityId: id,
        actorId,
        details: { email: row.email },
      });
      return mapManagedUser(row);
    },
  };
}
