import { MULTI_COUNTY_CONFIDENCE, SINGLE_COUNTY_CONFIDENCE } from '../constants.js';
import type { Field } from './fieldExtraction.js';
import { extractZip, lookupZip, toStateCode, type ZipInfo } from './rating/geo.js';

/** Source label of a county looked up from a practice ZIP, not stated in any document. */
export const ZIP_LOOKUP_SOURCE = 'ZIP lookup (Census / GeoNames)';

const countyKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/\s+(county|parish|borough)$/, '')
    .replace(/[^a-z0-9]/g, '');

/** "Travis" → "Travis County"; Louisiana parishes, Alaska boroughs and independent cities keep their own form. */
function countyLabel(name: string, state: string): string {
  if (/\b(city|county|parish|borough|area|municipality)$/i.test(name)) return name;
  if (state === 'LA') return `${name} Parish`;
  if (state === 'AK') return name;
  return `${name} County`;
}

/**
 * Adds a `practice_county` for every practice ZIP whose county the submission does not state, from the ZIP-to-county
 * tables (us_location_master). Practice ZIPs come from `practice_zip` and from the ZIP in each `practice_location`; the
 * mailing address is never used. The main county (largest land area) is the value; a ZIP spanning several counties
 * names the others in the evidence and gets a lower confidence. A ZIP in a different state from the stated practice
 * state is skipped, since one of the two is wrong. A stated county always outranks a looked-up one, and one that
 * disagrees with its ZIP stays visible as a second entry.
 */
export async function addZipCounties<F extends Field>(
  fields: F[],
  lookup: (zip: string) => Promise<ZipInfo | null> = lookupZip,
): Promise<(F | Field)[]> {
  const stated = new Set(fields.filter((f) => f.fieldName === 'practice_county').map((f) => countyKey(f.value)));
  const states = new Set(
    fields
      .filter((f) => f.fieldName === 'practice_state')
      .map((f) => toStateCode(f.value))
      .filter(Boolean),
  );

  // Distinct 5-digit ZIPs, each with the field it came from (practice_zip first, the highest confidence first).
  const zips = new Map<string, Field>();
  const candidates = fields
    .filter((f) => f.fieldName === 'practice_zip' || f.fieldName === 'practice_location')
    .sort(
      (a, b) =>
        Number(b.fieldName === 'practice_zip') - Number(a.fieldName === 'practice_zip') || b.confidence - a.confidence,
    );
  for (const f of candidates) {
    const zip = extractZip(f.value);
    if (zip && !zips.has(zip)) zips.set(zip, f);
  }

  const added: Field[] = [];
  for (const [zip, from] of zips) {
    const info = await lookup(zip);
    if (!info?.counties.length) continue;
    if (states.size && !states.has(info.state)) continue;
    const [main, ...others] = info.counties.map((c) => c.name);
    if (!main) continue;
    if (stated.has(countyKey(main))) continue;
    stated.add(countyKey(main));
    const value = countyLabel(main, info.state);
    added.push({
      fieldName: 'practice_county',
      value,
      confidence: Math.min(from.confidence, others.length ? MULTI_COUNTY_CONFIDENCE : SINGLE_COUNTY_CONFIDENCE),
      evidenceQuote:
        `ZIP ${zip} (${from.fieldName}, ${from.sourceLabel}) → ${value}, ${info.state}` +
        (others.length ? `; ZIP also spans ${others.join(', ')}` : ''),
      sourceLabel: ZIP_LOOKUP_SOURCE,
      documentId: null,
    });
  }
  return added.length ? [...fields, ...added] : fields;
}
