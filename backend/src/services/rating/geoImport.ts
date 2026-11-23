import fs from 'node:fs';
import zlib from 'node:zlib';

import { CENSUS_URL, GEO_DOWNLOAD_TIMEOUT_MS, GEO_MAX_UNZIPPED_BYTES, GEONAMES_URL } from '../../constants.js';
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { q } from './db.js';
import { MILITARY_STATES, militaryState, US_STATES } from './geo.js';
export { CENSUS_URL, GEONAMES_URL } from '../../constants.js';

const STATE_FIPS: Record<string, string> = {
  '01': 'AL',
  '02': 'AK',
  '04': 'AZ',
  '05': 'AR',
  '06': 'CA',
  '08': 'CO',
  '09': 'CT',
  '10': 'DE',
  '11': 'DC',
  '12': 'FL',
  '13': 'GA',
  '15': 'HI',
  '16': 'ID',
  '17': 'IL',
  '18': 'IN',
  '19': 'IA',
  '20': 'KS',
  '21': 'KY',
  '22': 'LA',
  '23': 'ME',
  '24': 'MD',
  '25': 'MA',
  '26': 'MI',
  '27': 'MN',
  '28': 'MS',
  '29': 'MO',
  '30': 'MT',
  '31': 'NE',
  '32': 'NV',
  '33': 'NH',
  '34': 'NJ',
  '35': 'NM',
  '36': 'NY',
  '37': 'NC',
  '38': 'ND',
  '39': 'OH',
  '40': 'OK',
  '41': 'OR',
  '42': 'PA',
  '44': 'RI',
  '45': 'SC',
  '46': 'SD',
  '47': 'TN',
  '48': 'TX',
  '49': 'UT',
  '50': 'VT',
  '51': 'VA',
  '53': 'WA',
  '54': 'WV',
  '55': 'WI',
  '56': 'WY',
  '60': 'AS',
  '66': 'GU',
  '69': 'MP',
  '72': 'PR',
  '78': 'VI',
};

/** "Travis County" → "Travis"; keeps "Baltimore city" the way Census writes it. */
const countyName = (namelsad: string) =>
  namelsad.replace(/\s+(County|Parish|Borough|Census Area|Municipality|City and Borough)$/i, '').trim();

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(GEO_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ZIP reader (central directory + deflate) — enough for the GeoNames archive. */
function unzipEntry(zip: Buffer, name: string): Buffer {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a zip file');
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const data = zip.subarray(dataStart, dataStart + size);
      // Capped: US.txt is ~6 MB; a corrupt or hostile archive must not inflate into gigabytes in memory.
      return method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: GEO_MAX_UNZIPPED_BYTES }) : data;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} not found in zip`);
}

export interface GeoImportResult {
  zips: number;
  zipCounties: number;
  multiCountyZips: number;
}

/**
 * Loads ZIP → city, county, state into us_location_master (one row per ZIP and county, largest county first).
 * Pass local file paths to skip the downloads.
 */
export async function importGeo(opts: { censusPath?: string; geonamesPath?: string } = {}): Promise<GeoImportResult> {
  const censusText = opts.censusPath
    ? fs.readFileSync(opts.censusPath, 'utf8')
    : (await download(CENSUS_URL)).toString('utf8');
  const geonamesText = opts.geonamesPath
    ? opts.geonamesPath.toLowerCase().endsWith('.zip')
      ? unzipEntry(fs.readFileSync(opts.geonamesPath), 'US.txt').toString('utf8')
      : fs.readFileSync(opts.geonamesPath, 'utf8')
    : unzipEntry(await download(GEONAMES_URL), 'US.txt').toString('utf8');

  // ZIP → counties (Census)
  const census = new Map<string, { county: string; state: string; land: number }[]>();
  const lines = censusText.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split('|');
  const col = (n: string) => header.indexOf(n);
  const [iZip, iCountyId, iCountyName, iLand] = [
    col('GEOID_ZCTA5_20'),
    col('GEOID_COUNTY_20'),
    col('NAMELSAD_COUNTY_20'),
    col('AREALAND_PART'),
  ];
  if ([iZip, iCountyId, iCountyName, iLand].includes(-1))
    throw new Error('Unexpected Census relationship file columns');
  for (const line of lines.slice(1)) {
    const f = line.split('|');
    const state = STATE_FIPS[(f[iCountyId] ?? '').slice(0, 2)];
    const zipCode = f[iZip];
    if (!zipCode || !state) continue;
    const list = census.get(zipCode) ?? [];
    list.push({ county: countyName(f[iCountyName] ?? ''), state, land: Number(f[iLand]) || 0 });
    census.set(zipCode, list);
  }

  // ZIP → city/state/county (GeoNames, tab separated)
  const geonames = new Map<string, { city: string; state: string; county: string }>();
  for (const line of geonamesText.split(/\r?\n/)) {
    const f = line.split('\t');
    const [, zipCode, city, , state, county] = f;
    if (zipCode && /^\d{5}$/.test(zipCode) && city !== undefined && state !== undefined && county !== undefined) {
      geonames.set(zipCode, { city, state, county });
    }
  }

  // One us_location_master row per ZIP and county, largest land area first: the lowest id is the main county.
  const rows: { zip: string; city: string; county: string | null; state: string }[] = [];
  let zips = 0;
  let multiCountyZips = 0;
  for (const zip of new Set([...census.keys(), ...geonames.keys()])) {
    const g = geonames.get(zip);
    const parts = census.get(zip);
    const city = g?.city ?? '';
    let state: string | undefined;
    let counties: string[] = [];
    if (parts?.length) {
      const total = parts.reduce((s, p) => s + p.land, 0);
      const byState = new Map<string, number>();
      for (const p of parts) byState.set(p.state, (byState.get(p.state) ?? 0) + p.land);
      state = [...byState.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      counties = parts
        .map((p) => ({ county: p.county, share: total > 0 ? p.land / total : 1 / parts.length }))
        .filter((p) => p.share >= 0.005 || parts.length === 1) // slivers
        .sort((a, b) => b.share - a.share || a.county.localeCompare(b.county))
        .map((p) => p.county)
        .filter((c, i, all) => all.indexOf(c) === i);
    } else if (g) {
      state = g.state || militaryState(g.city);
      if (g.county) counties = [g.county];
    }
    if (!state || !(US_STATES[state] ?? MILITARY_STATES[state])) continue;
    zips++;
    if (counties.length > 1) multiCountyZips++;
    for (const county of counties.length ? counties : [null]) rows.push({ zip, city, county, state });
  }

  await withTransaction(async (client) => {
    await client.query('TRUNCATE us_location_master RESTART IDENTITY');
    for (let i = 0; i < rows.length; i += 10000) {
      const chunk = rows.slice(i, i + 10000);
      await client.query(
        `INSERT INTO us_location_master (zip_code, city, county, state_code, state_name)
         SELECT z, c, co, s, n FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS t(z, c, co, s, n, ord) ORDER BY ord`,
        [
          chunk.map((r) => r.zip),
          chunk.map((r) => r.city),
          chunk.map((r) => r.county),
          chunk.map((r) => r.state),
          chunk.map((r) => US_STATES[r.state] ?? MILITARY_STATES[r.state]),
        ],
      );
    }
  });

  return { zips, zipCounties: rows.filter((r) => r.county).length, multiCountyZips };
}

/** Loads ZIP data in the background on first start (downloads ~7 MB once). */
export async function ensureGeoImported(): Promise<void> {
  const [row] = await q<{ count: number }>('SELECT COUNT(*)::int AS count FROM us_location_master');
  if (row!.count > 0) return;
  logger.info('ZIP tables empty: downloading Census and GeoNames ZIP data');
  const r = await importGeo();
  logger.info(r, 'ZIP tables imported');
}
