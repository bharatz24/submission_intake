/**
 * Namespaces for two-key advisory locks: `pg_advisory_lock(namespace, hashtext(name))` (DB-20).
 * Postgres keeps one-key (bigint) and two-key (int, int) advisory locks in separate key spaces, so a hashed name in
 * one of these namespaces can never collide with the fixed single-key locks (the migrator's MIGRATION_LOCK, the
 * duplicate check's DUPLICATE_LOCK, the rate import's RATE_IMPORT_LOCK), nor with a name hashed in another namespace.
 * Values are fixed for good: instances running different releases must agree on them.
 */
export const LOCK_NAMESPACE = {
  /** One pipeline run per submission (services/pipeline.ts processSubmission); name = submission id. */
  processSubmission: 0x49_4d_50_01,
  /** One holder per named background task across instances (services/pgListen.ts withAdvisoryLock). */
  singleton: 0x49_4d_50_02,
} as const;
