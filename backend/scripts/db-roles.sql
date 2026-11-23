-- Least-privilege database roles (DB-05). Idempotent: safe to run on every release, before and after the migrations.
--
--   ims_migrator  owns the database, its schemas and every object the migrations create. Runs the migrations
--                 (MIGRATOR_DB_PASSWORD). As the owner of audit_events it can still alter it, or disable its
--                 immutability triggers inside a migration, when a migration genuinely needs to.
--   ims_app       the API's runtime role (APP_DB_PASSWORD): DML only (SELECT/INSERT/UPDATE/DELETE), no DDL, no TRUNCATE,
--                 and no UPDATE/DELETE on the append-only audit_events table (the triggers stop it too; the grant is the
--                 second wall). Read-only on schema_migrations.
--
-- Run as the bootstrap superuser (POSTGRES_USER) against the application database. docker-compose.prod.yml does this
-- in the `db-roles` (before migrate) and `db-grants` (after migrate) services; elsewhere:
--
--   psql "postgres://ims:<superuser password>@<host>:5432/ims" \
--     -v migrator_password="$MIGRATOR_DB_PASSWORD" -v app_password="$APP_DB_PASSWORD" -f backend/scripts/db-roles.sql
--
-- The second run (after migrate) matters on a fresh database: audit_events only exists once the migrations ran.
-- Passwords end up in a connection URL: use URL-safe values (`openssl rand -hex 24`).

\set ON_ERROR_STOP on

-- 1. Roles (created once; flags and passwords re-asserted on every run, so rotating a password is a re-run).
SELECT format('CREATE ROLE ims_migrator LOGIN PASSWORD %L', :'migrator_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ims_migrator') \gexec
SELECT format('CREATE ROLE ims_app LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ims_app') \gexec
SELECT format('ALTER ROLE ims_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'migrator_password') \gexec
SELECT format('ALTER ROLE ims_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'app_password') \gexec

-- 2. The database: owned by the migrator (it creates schemas and trusted extensions); nobody else connects by default.
SELECT format('ALTER DATABASE %I OWNER TO ims_migrator', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ims_app', current_database()) \gexec

-- 3. Ownership of what the migrations created so far (an existing deployment migrated as the superuser). Owned
--    sequences follow their table, and extension members stay with the extension.
SELECT format('ALTER SCHEMA %I OWNER TO ims_migrator', n.nspname)
  FROM pg_namespace n
 WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
   AND pg_get_userbyid(n.nspowner) <> 'ims_migrator'
   AND NOT EXISTS (SELECT FROM pg_depend d
                    WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e') \gexec

SELECT format('ALTER %s %I.%I OWNER TO ims_migrator',
              CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE'
                             WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
              n.nspname, c.relname)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
   AND NOT c.relispartition
   AND pg_get_userbyid(c.relowner) <> 'ims_migrator'
   AND NOT EXISTS (SELECT FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e')) \gexec

SELECT format('ALTER %s %s OWNER TO ims_migrator',
              CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
              p.oid::regprocedure)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
   AND pg_get_userbyid(p.proowner) <> 'ims_migrator'
   AND NOT EXISTS (SELECT FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') \gexec

SELECT format('ALTER TYPE %s OWNER TO ims_migrator', t.oid::regtype)
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
   AND (t.typtype IN ('e', 'd')
        OR (t.typtype = 'c' AND EXISTS (SELECT FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
   AND pg_get_userbyid(t.typowner) <> 'ims_migrator'
   AND NOT EXISTS (SELECT FROM pg_depend d
                    WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e') \gexec

-- 4. The runtime role: DML on the application schema, now and for every object the migrator creates later.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ims_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ims_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ims_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ims_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ims_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ims_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ims_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ims_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ims_app;

-- 5. Append-only audit trail and the migration ledger (skipped until the migrations created them).
SELECT 'REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_events FROM ims_app'
 WHERE to_regclass('public.audit_events') IS NOT NULL \gexec
SELECT 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.schema_migrations FROM ims_app'
 WHERE to_regclass('public.schema_migrations') IS NOT NULL \gexec
