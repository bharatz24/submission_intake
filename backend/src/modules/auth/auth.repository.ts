import type { Queryable } from '../../db/pool.js';
import type { UserAuthRow, UserRow } from '../../db/rows.js';

/** SQL for sign-in, sign-up and a user's own password. */

export async function countUsers(db: Queryable): Promise<number> {
  const {
    rows: [r],
  } = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM users');
  return r?.count ?? 0;
}

// Serializes first-user creation so two concurrent registrations cannot both become the bootstrap admin.
const BOOTSTRAP_LOCK = 'ims-users-bootstrap';

export async function lockBootstrap(db: Queryable): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [BOOTSTRAP_LOCK]);
}

/** null when the email is taken. */
export async function insertUser(
  db: Queryable,
  user: { email: string; name: string; passwordHash: string; role: string },
): Promise<UserRow | null> {
  const {
    rows: [row],
  } = await db.query<UserRow>(
    'INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING *',
    [user.email, user.name, user.passwordHash, user.role],
  );
  return row ?? null;
}

export async function findByEmail(db: Queryable, email: string): Promise<UserAuthRow | null> {
  const {
    rows: [row],
  } = await db.query<UserAuthRow>('SELECT * FROM users WHERE email=$1', [email]);
  return row ?? null;
}

export async function findById(db: Queryable, id: string): Promise<UserAuthRow | null> {
  const {
    rows: [row],
  } = await db.query<UserAuthRow>('SELECT * FROM users WHERE id=$1', [id]);
  return row ?? null;
}

/** Revokes every token the user holds. */
export async function bumpTokenVersion(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [id]);
}

/** A new password; every token the user holds is revoked. */
export async function setPassword(db: Queryable, id: string, hash: string): Promise<UserRow> {
  const {
    rows: [row],
  } = await db.query<UserRow>(
    'UPDATE users SET password_hash=$2, password_changed_at=now(), token_version = token_version + 1 WHERE id=$1 RETURNING *',
    [id, hash],
  );
  return row!;
}
