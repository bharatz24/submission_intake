import { q } from './db.js';

export interface ZipInfo {
  zip: string;
  city: string | null;
  state: string;
  /** Counties the ZIP overlaps, largest land area first (us_location_master rows in id order). */
  counties: { name: string }[];
}

/** State and territory names by USPS code: us_location_master.state_name. */
export const US_STATES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
  GU: 'Guam',
  VI: 'U.S. Virgin Islands',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
  MH: 'Marshall Islands',
  FM: 'Federated States of Micronesia',
  PW: 'Palau',
};
/** Military mail (APO/FPO/DPO): the ZIP data has no state, the city ends in the USPS code ("APO AE"). */
export const MILITARY_STATES: Record<string, string> = {
  AA: 'Armed Forces Americas',
  AE: 'Armed Forces Europe',
  AP: 'Armed Forces Pacific',
};
export const militaryState = (city: string | null | undefined): string | undefined =>
  /\b(AA|AE|AP)$/.exec(city?.trim() ?? '')?.[1];

const STATE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);
const STATE_CODES = new Set(Object.keys(US_STATES));

export function toStateCode(raw: string | undefined): string | undefined {
  const t = raw?.trim().replace(/\.$/, '');
  if (!t) return undefined;
  if (t.length === 2 && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase();
  return STATE_NAMES[t.toLowerCase().replace(/\s+/g, ' ')];
}

export const extractZip = (raw: string | undefined | null): string | null =>
  /\b(\d{5})(?:-\d{4})?\b/.exec(raw ?? '')?.[1] ?? null;

export async function lookupZip(raw: string | undefined | null): Promise<ZipInfo | null> {
  const zip = extractZip(raw);
  if (!zip) return null;
  const rows = await q<{ city: string; state_code: string; county: string | null }>(
    `SELECT city, state_code, county FROM us_location_master WHERE zip_code = $1 AND is_active ORDER BY id`,
    [zip],
  );
  const first = rows[0];
  if (!first) return null;
  return {
    zip,
    city: first.city || null,
    state: first.state_code,
    counties: rows.filter((r) => r.county).map((r) => ({ name: r.county! })),
  };
}

/** City + state → ZIPs and their main county (used when an email has a city but no ZIP). */
export async function lookupCity(
  city: string,
  state: string,
): Promise<{ zips: string[]; counties: { name: string; zipCount: number }[] }> {
  const rows = await q<{ zip: string; county: string | null }>(
    `SELECT DISTINCT ON (zip_code) zip_code AS zip, county FROM us_location_master
     WHERE state_code = $1 AND lower(city) = lower($2) AND is_active ORDER BY zip_code, id`,
    [state.toUpperCase(), city.trim()],
  );
  const counts = new Map<string, number>();
  for (const r of rows) if (r.county) counts.set(r.county, (counts.get(r.county) ?? 0) + 1);
  return {
    zips: rows.map((r) => r.zip),
    counties: [...counts.entries()]
      .map(([name, zipCount]) => ({ name, zipCount }))
      .sort((a, b) => b.zipCount - a.zipCount),
  };
}

/** ZIP codes loaded, and rows (one per ZIP and county). */
export async function geoStats(): Promise<{ zips: number; zipCounties: number }> {
  const [r] = await q<{ zips: number; zip_counties: number }>(
    'SELECT COUNT(DISTINCT zip_code)::int AS zips, COUNT(*)::int AS zip_counties FROM us_location_master WHERE is_active',
  );
  return { zips: r?.zips ?? 0, zipCounties: r?.zip_counties ?? 0 };
}
