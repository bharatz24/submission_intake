import { NPI_REGISTRY_CONFIDENCE } from '../constants.js';
import { pool, type Queryable } from '../db/pool.js';
import type { Field } from './fieldExtraction.js';
import { distinctValues, effectiveFields } from './fields.js';

/** Source label of a contact detail read from the CMS NPI registry, not stated in the email or a document. */
export const NPI_REGISTRY_SOURCE = 'NPI registry (CMS NPPES)';

/** "331352402" → "33135-2402"; a 5-digit ZIP stays as it is. */
function formatZip(raw: unknown): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 5)}-${d.slice(5)}` : d.slice(0, 5);
}

function formatAddress(a: any): string {
  const street = [a.address_1, a.address_2].filter(Boolean).join(', ');
  return [street, a.city, [a.state, formatZip(a.postal_code)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/**
 * The contact details a registry record gives that the submission's own sources often leave out: the practice
 * location's phone (the provider's contact phone) and the mailing address. Years in practice and board certification
 * are not in the registry (an NPI enumeration date is not a start-of-practice date), so they are never filled.
 */
export function registryContactFields(npi: string, record: any): Field[] {
  const addresses: any[] = record?.addresses ?? [];
  const location = addresses.find((a) => a.address_purpose === 'LOCATION');
  const mailing = addresses.find((a) => a.address_purpose === 'MAILING');
  const out: Field[] = [];
  const add = (fieldName: string, value: string, what: string) =>
    out.push({
      fieldName,
      value,
      confidence: NPI_REGISTRY_CONFIDENCE,
      evidenceQuote: `NPI ${npi} ${what}: ${value}`,
      sourceLabel: NPI_REGISTRY_SOURCE,
      documentId: null,
    });
  if (location?.telephone_number) add('contact_phone', String(location.telephone_number), 'practice location phone');
  if (mailing?.address_1) add('mailing_address', formatAddress(mailing), 'mailing address');
  return out;
}

const nameKey = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * On a group submission an extracted NPI can match another listed provider (compareNpiToProviders), not the applicant:
 * that provider's registry phone and address are not the submission's contact details, so those checks are left out.
 */
async function withoutOtherProviders<R extends { source: string; claimed_name: string | null }>(
  submissionId: string,
  matched: R[],
  db: Queryable,
): Promise<R[]> {
  const [applicant, ...others] = distinctValues(await effectiveFields(submissionId, db), 'applicant_name');
  if (!applicant || !others.length) return matched;
  const otherProviders = new Set(others.map(nameKey).filter((k) => k !== nameKey(applicant)));
  return matched.filter((m) => m.source !== 'EXTRACTED' || !otherProviders.has(nameKey(m.claimed_name)));
}

/**
 * Fills the contact fields no email, document or person gave from each NPI check that matches the applicant (by the
 * registry or by an underwriter's decision). It rewrites its own rows on the latest extracted version each time, so a
 * re-check, a removed NPI or an undone match decision leaves no stale value behind, and it never outranks a stated one.
 */
export async function syncNpiRegistryFields(submissionId: string, db: Queryable = pool): Promise<void> {
  const {
    rows: [latest],
  } = await db.query('SELECT max(context_version) AS version FROM extracted_fields WHERE submission_id=$1', [
    submissionId,
  ]);
  if (latest?.version == null) return;
  const version = latest.version as number;
  await db.query('DELETE FROM extracted_fields WHERE submission_id=$1 AND context_version=$2 AND source_label=$3', [
    submissionId,
    version,
    NPI_REGISTRY_SOURCE,
  ]);

  const { rows: allMatched } = await db.query(
    `SELECT npi, registry_data, source, claimed_name FROM npi_verifications WHERE submission_id=$1 AND status='MATCH' AND registry_data IS NOT NULL ORDER BY npi`,
    [submissionId],
  );
  const matched = allMatched.length > 1 ? await withoutOtherProviders(submissionId, allMatched, db) : allMatched;
  if (!matched.length) return;
  const { rows: present } = await db.query(
    `SELECT field_name FROM extracted_fields WHERE submission_id=$1 AND context_version=$2
     UNION SELECT field_name FROM manual_fields WHERE submission_id=$1`,
    [submissionId, version],
  );
  const stated = new Set(present.map((r) => r.field_name as string));

  for (const m of matched) {
    for (const f of registryContactFields(m.npi, m.registry_data)) {
      if (stated.has(f.fieldName)) continue;
      await db.query(
        `INSERT INTO extracted_fields (submission_id, document_id, field_name, value, confidence, evidence_quote, source_label, context_version)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7)`,
        [submissionId, f.fieldName, f.value, f.confidence, f.evidenceQuote, f.sourceLabel, version],
      );
    }
  }
}
