import type { Queryable } from '../../db/pool.js';
import type { UserRow } from '../../db/rows.js';

/** SQL for user accounts as admins manage them (sign-in itself is modules/auth). */

export async function listAll(db: Queryable): Promise<UserRow[]> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users ORDER BY name');
  return rows;
}

/** Who work can be assigned to: active accounts only, names and roles. */
export async function listAssignable(db: Queryable) {
  const { rows } = await db.query<{ id: string; name: string; role: string }>(
    'SELECT id, name, role FROM users WHERE disabled_at IS NULL ORDER BY name',
  );
  return rows;
}

/** The default admin is the bootstrap account (the first user created). */
export async function defaultAdminId(db: Queryable): Promise<string | null> {
  const {
    rows: [row],
  } = await db.query<{ id: string }>('SELECT id FROM users ORDER BY created_at, id LIMIT 1');
  return row?.id ?? null;
}

// Every role change and disable runs under this lock, so two admins cannot each remove "the other" last admin.
const ADMIN_LOCK = 'ims-users-admins';

export async function lockAdmins(db: Queryable): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADMIN_LOCK]);
}

export async function lockUser(db: Queryable, id: string): Promise<UserRow | null> {
  const {
    rows: [user],
  } = await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]);
  return user ?? null;
}

export async function otherActiveAdmins(db: Queryable, exceptId: string): Promise<number> {
  const {
    rows: [r],
  } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE role='ADMIN' AND disabled_at IS NULL AND id<>$1",
    [exceptId],
  );
  return r?.n ?? 0;
}

/** Sets role and disabled state; `revoke` bumps the token version, which signs the user out everywhere. */
export async function updateAccess(
  db: Queryable,
  id: string,
  role: string,
  disabled: boolean,
  revoke: boolean,
): Promise<UserRow> {
  const {
    rows: [row],
  } = await db.query<UserRow>(
    `UPDATE users SET role=$2,
       disabled_at = CASE WHEN $3::boolean THEN coalesce(disabled_at, now()) ELSE NULL END,
       token_version = token_version + CASE WHEN $4::boolean THEN 1 ELSE 0 END
     WHERE id=$1 RETURNING *`,
    [id, role, disabled, revoke],
  );
  return row!;
}

/** A new password; every token the user holds is revoked. */
export async function setPassword(db: Queryable, id: string, hash: string): Promise<UserRow | null> {
  const {
    rows: [row],
  } = await db.query<UserRow>(
    'UPDATE users SET password_hash=$2, password_changed_at=now(), token_version = token_version + 1 WHERE id=$1 RETURNING *',
    [id, hash],
  );
  return row ?? null;
}
