import type pg from 'pg';

import { logger } from '../logger.js';
import { FINGERPRINT_VERSION, fingerprints } from '../services/duplicates.js';
import { structureName } from '../services/npi.js';
import { insertRatingChildren, ratingColumns, type StoredResult } from '../services/rating/store.js';
import {
  AnalysisSchema,
  completenessScore,
  renderAnalysisMarkdown,
  renderSynthesisMarkdown,
  SynthesisSchema,
} from '../services/reportSchemas.js';

/**
 * Data backfills that need application code. Each runs once, after every SQL migration,
 * in its own transaction, and is recorded in schema_migrations under its name.
 */
export const BACKFILLS: { name: string; run: (db: pg.PoolClient) => Promise<void> }[] = [
  { name: '004_structured_names.backfill', run: backfillStructuredNames },
  { name: '005_report_markdown_names.backfill', run: rerenderReportMarkdown },
  // Named after FINGERPRINT_VERSION: bumping it recomputes every row once, after the migrations that add the columns.
  { name: `duplicate_fingerprints_v${FINGERPRINT_VERSION}.backfill`, run: backfillFingerprints },
  { name: 'legacy_quotes.backfill', run: backfillLegacyQuotes },
  { name: 'completeness_score_v2.backfill', run: backfillCompletenessScores },
];

/** Recompute stored analyses' completeness scores with completenessScore(), then re-render their markdown. */
async function backfillCompletenessScores(db: pg.PoolClient): Promise<void> {
  const { rows } = await db.query(
    `SELECT id, content_json->'applicationCompleteness'->'gaps' AS gaps FROM reports
      WHERE kind='ANALYSIS' AND status='COMPLETED' AND jsonb_typeof(content_json->'applicationCompleteness'->'gaps') = 'array'`,
  );
  for (const r of rows) {
    await db.query(
      `UPDATE reports SET content_json = jsonb_set(content_json, '{applicationCompleteness,score}', to_jsonb($2::int)) WHERE id=$1`,
      [r.id, completenessScore(jsonList(r.gaps))],
    );
  }
  if (rows.length) await rerenderReportMarkdown(db);
}

/**
 * Fingerprint existing submissions so new mail can be matched against them (see 007, 008 and 009 migrations).
 * Existing rows are never marked as duplicates: underwriters have already seen them. Recomputing is idempotent.
 */
async function backfillFingerprints(db: pg.PoolClient): Promise<void> {
  // In id order, a page at a time: never the whole mailbox (bodies included) in memory at once.
  for (let after = '00000000-0000-0000-0000-000000000000'; ; ) {
    const { rows } = await db.query(
      `SELECT s.id, e.subject, e.body_text, e.from_address,
              COALESCE((SELECT json_agg(json_build_object('filename', d.filename, 'mimeType', d.mime_type, 'sizeBytes', d.size_bytes, 'sha256', d.sha256))
                          FROM documents d WHERE d.submission_id=s.id), '[]') AS docs
         FROM submissions s JOIN emails e ON e.id=s.email_id
        WHERE s.id > $1 ORDER BY s.id LIMIT 200`,
      [after],
    );
    if (!rows.length) return;
    for (const r of rows) {
      const fp = fingerprints({ subject: r.subject, bodyText: r.body_text, fromAddress: r.from_address }, r.docs);
      await db.query(
        `UPDATE submissions SET content_fingerprint=$2, attachment_fingerprint=$3, normalized_subject=$4, body_fingerprint=$5,
           body_tail_fingerprint=$6 WHERE id=$1`,
        [
          r.id,
          fp.contentFingerprint,
          fp.attachmentFingerprint,
          fp.normalizedSubject,
          fp.bodyFingerprint,
          fp.bodyTailFingerprint,
        ],
      );
    }
    after = rows[rows.length - 1].id;
  }
}

const jsonList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/**
 * HEAD's `quotes` rows (kept in legacy_pre_squash by migrate.ts convergeLegacy) as single_rating versions with their
 * child rows, keeping id, version, context_version, created_by and created_at. Lossy, by design of the new structure:
 * `sources` (where each input came from) has no column and is not carried over; HEAD stored unrounded pricing, which
 * the numeric(14,2) columns round to cents (the old rounded premium/total match). A row that cannot be stored (say a
 * QUOTED row without pricing) is skipped and logged; the legacy table keeps it either way.
 */
async function backfillLegacyQuotes(db: pg.PoolClient): Promise<void> {
  const {
    rows: [t],
  } = await db.query(`SELECT to_regclass('legacy_pre_squash.quotes') AS t`);
  if (!t.t) return;
  const { rows } = await db.query(
    `SELECT q.* FROM legacy_pre_squash.quotes q WHERE EXISTS (SELECT 1 FROM submissions s WHERE s.id = q.submission_id)
     ORDER BY q.submission_id, q.version`,
  );
  const skipped: { id: string; reason: string }[] = [];
  let migrated = 0;
  for (const q of rows) {
    const { rowCount: present } = await db.query(
      'SELECT 1 FROM single_rating WHERE id=$1 OR (submission_id=$2 AND version=$3)',
      [q.id, q.submission_id, q.version],
    );
    if (present) {
      skipped.push({ id: q.id, reason: 'a rating with this id or version already exists' });
      continue;
    }
    const result: StoredResult = {
      status: q.status,
      rateGroup: q.rate_group,
      inputs: q.inputs ?? {},
      factors: q.factors ?? {},
      pricing: q.pricing ?? null,
      flags: jsonList(q.flags),
      missing: jsonList(q.missing),
    };
    await db.query('SAVEPOINT legacy_quote');
    try {
      const cols = ratingColumns(result, q.label, q.created_by);
      const names = Object.keys(cols);
      await db.query(
        `INSERT INTO single_rating (id, submission_id, version, context_version, created_at, ${names.join(', ')})
         VALUES ($1, $2, $3, $4, $5, ${names.map((_, i) => `$${i + 6}`).join(', ')})`,
        [q.id, q.submission_id, q.version, q.context_version, q.created_at, ...Object.values(cols)],
      );
      await insertRatingChildren(db, q.id, result);
      await db.query('RELEASE SAVEPOINT legacy_quote');
      migrated++;
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT legacy_quote');
      skipped.push({ id: q.id, reason: (err as Error).message });
    }
  }
  // HEAD had no primary rating: the first priced version (else the first) becomes primary, as saveRating would have.
  await db.query(
    `UPDATE submissions s SET primary_rating_id = (
       SELECT r.id FROM single_rating r WHERE r.submission_id = s.id ORDER BY (r.status = 'QUOTED') DESC, r.version LIMIT 1)
     WHERE s.primary_rating_id IS NULL AND EXISTS (SELECT 1 FROM single_rating r WHERE r.submission_id = s.id)`,
  );
  // Coverage_fees: the submission's current set is its latest rating's.
  await db.query(
    `INSERT INTO coverage_fees (submission_id, key, title, amount, percentageofearn)
     SELECT r.submission_id, f.key, f.title, f.amount, f.percentageofearn
     FROM single_rating r JOIN single_rating_policy_fees f ON f.rating_id = r.id
     WHERE r.version = (SELECT max(version) FROM single_rating x WHERE x.submission_id = r.submission_id)
       AND NOT EXISTS (SELECT 1 FROM coverage_fees c WHERE c.submission_id = r.submission_id)
     ORDER BY r.submission_id, f.sort_order`,
  );
  if (skipped.length) {
    logger.warn(
      { skipped: skipped.slice(0, 50), count: skipped.length },
      'legacy quotes not converted to single_rating; they remain in legacy_pre_squash.quotes',
    );
  }
  logger.info({ migrated, skipped: skipped.length }, 'legacy quotes converted to single_rating');
}

/** Re-render completed reports' markdown so it shows the typed applicant name (first/last or entity). */
async function rerenderReportMarkdown(db: pg.PoolClient): Promise<void> {
  const { rows } = await db.query(
    `SELECT r.id, r.kind, r.version, r.skill_version, r.model, r.context_version, r.content_json, syn.version AS synthesis_version,
            s.applicant_type, s.applicant_first_name, s.applicant_last_name, s.applicant_entity_name
       FROM reports r JOIN submissions s ON s.id = r.submission_id
       LEFT JOIN reports syn ON syn.id = r.based_on_report_id
      WHERE r.status='COMPLETED' AND r.content_json IS NOT NULL`,
  );
  for (const r of rows) {
    const meta = {
      version: r.version,
      skillVersion: r.skill_version,
      model: r.model,
      contextVersion: r.context_version,
      applicant: {
        type: r.applicant_type,
        firstName: r.applicant_first_name,
        lastName: r.applicant_last_name,
        entityName: r.applicant_entity_name,
      },
    };
    let markdown: string;
    if (r.kind === 'SYNTHESIS') {
      const parsed = SynthesisSchema.safeParse(r.content_json);
      if (!parsed.success) continue;
      markdown = renderSynthesisMarkdown(parsed.data, meta);
    } else {
      const parsed = AnalysisSchema.safeParse(r.content_json);
      if (!parsed.success || r.synthesis_version == null) continue;
      markdown = renderAnalysisMarkdown(parsed.data, { ...meta, synthesisVersion: r.synthesis_version });
    }
    await db.query('UPDATE reports SET content_markdown=$2 WHERE id=$1', [r.id, markdown]);
  }
}

/** Split existing applicant and claimed names by type (name types: see 001_schema.sql). */
async function backfillStructuredNames(db: pg.PoolClient): Promise<void> {
  const { rows: subs } = await db.query<{ id: string; applicant_name: string }>(
    'SELECT id, applicant_name FROM submissions WHERE applicant_name IS NOT NULL AND applicant_type IS NULL',
  );
  for (const s of subs) {
    const n = structureName(s.applicant_name);
    await db.query(
      'UPDATE submissions SET applicant_type=$2, applicant_first_name=$3, applicant_last_name=$4, applicant_entity_name=$5 WHERE id=$1',
      [s.id, n.type, n.firstName, n.lastName, n.entityName],
    );
  }
  const { rows: npis } = await db.query<{ id: string; claimed_name: string }>(
    'SELECT id, claimed_name FROM npi_verifications WHERE claimed_name IS NOT NULL AND claimed_type IS NULL',
  );
  for (const v of npis) {
    const n = structureName(v.claimed_name);
    await db.query(
      'UPDATE npi_verifications SET claimed_type=$2, claimed_first_name=$3, claimed_last_name=$4, claimed_entity_name=$5 WHERE id=$1',
      [v.id, n.type, n.firstName, n.lastName, n.entityName],
    );
  }
}
