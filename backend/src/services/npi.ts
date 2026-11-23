import { z } from 'zod';

import { config } from '../config.js';
import {
  NPI_API_VERSION,
  NPI_CACHE_TTL_MS,
  NPI_NOT_FOUND_CACHE_TTL_MS,
  NPI_RETRY_ATTEMPTS,
  NPI_RETRY_BASE_MS,
  NPI_RETRY_MAX_DELAY_MS,
  NPI_SEARCH_LIMIT,
} from '../constants.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { fetchWithRetry } from './httpRetry.js';
import { limits } from './limitsSettings.js';
export { NPI_API_VERSION } from '../constants.js';

export type NpiStatus = 'MATCH' | 'PARTIAL_MATCH' | 'MISMATCH' | 'NOT_FOUND' | 'NOT_VERIFIED' | 'ERROR';

export interface NpiClaim {
  npi: string;
  name?: string | null;
  state?: string | null;
  specialty?: string | null;
}

export interface NpiResult {
  status: NpiStatus;
  registryName: string | null;
  registryTaxonomy: string | null;
  registryState: string | null;
  registryStatus: string | null;
  mismatches: string[];
  registryData: unknown;
}

/** Luhn check per CMS NPI spec: prefix 80840 to the 10-digit NPI. */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi}`.split('').map(Number);
  let sum = 0;
  for (let i = digits.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let d = digits[i]!;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function findNpis(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\bNPI\D{0,20}(\d{10})\b/gi)) found.add(m[1]!);
  for (const m of text.matchAll(/\b(\d{10})\b/g)) if (isValidNpi(m[1]!)) found.add(m[1]!);
  return [...found].filter(isValidNpi);
}

// ---- Registry responses: only the fields this app reads are checked; the rest is kept as is. ----

const NpiAddressSchema = z.looseObject({
  address_purpose: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  postal_code: z.union([z.string(), z.number()]).nullish(),
});
const NpiTaxonomySchema = z.looseObject({
  desc: z.string().nullish(),
  primary: z.boolean().nullish(),
  state: z.string().nullish(),
});
export const NpiRecordSchema = z.looseObject({
  number: z.coerce.string().regex(/^\d{10}$/),
  enumeration_type: z.string().nullish(),
  basic: z.looseObject({}).nullish(),
  addresses: z.array(NpiAddressSchema).nullish(),
  taxonomies: z.array(NpiTaxonomySchema).nullish(),
});
export const NpiResponseSchema = z.looseObject({
  results: z.array(NpiRecordSchema).nullish(),
  Errors: z.array(z.looseObject({ description: z.string().nullish() })).nullish(),
});
export type NpiRecord = z.infer<typeof NpiRecordSchema>;
export interface NpiLookup {
  found: boolean;
  result: NpiRecord | null;
}

/** Reused registry answers by NPI number; the default is the npi_registry_cache table. */
export interface NpiCache {
  get(npi: string): Promise<NpiLookup | null>;
  set(npi: string, lookup: NpiLookup): Promise<void>;
}

/** Cache errors never fail a lookup: it just goes to CMS. */
export const dbNpiCache: NpiCache = {
  async get(npi) {
    const {
      rows: [row],
    } = await pool
      .query(
        `SELECT record FROM npi_registry_cache
        WHERE npi=$1 AND fetched_at > now() - (CASE WHEN record IS NULL THEN $3::bigint ELSE $2::bigint END) * interval '1 millisecond'`,
        [npi, NPI_CACHE_TTL_MS, NPI_NOT_FOUND_CACHE_TTL_MS],
      )
      .catch((err) => {
        logger.warn({ err }, 'NPI cache read failed');
        return { rows: [] };
      });
    if (!row) return null;
    const record = row.record === null ? null : NpiRecordSchema.safeParse(row.record);
    if (record && !record.success) return null; // written by an older shape: refetch
    return { found: Boolean(record), result: record ? record.data : null };
  },
  async set(npi, lookup) {
    await pool
      .query(
        `INSERT INTO npi_registry_cache (npi, record, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (npi) DO UPDATE SET record = EXCLUDED.record, fetched_at = EXCLUDED.fetched_at`,
        [npi, lookup.result === null ? null : JSON.stringify(lookup.result)],
      )
      .catch((err) => logger.warn({ err }, 'NPI cache write failed'));
  },
};

export interface NpiDeps {
  fetchImpl?: typeof fetch;
  /** null: no cache (searches, tests). */
  cache?: NpiCache | null;
  sleep?: (ms: number) => Promise<void>;
}

/** One registry GET: retried when transient, the body checked against the schema, registry errors thrown. */
async function queryRegistry(params: Record<string, string>, deps: NpiDeps): Promise<NpiRecord[]> {
  const url = new URL(config.NPI_API_BASE);
  url.searchParams.set('version', NPI_API_VERSION);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchWithRetry(url, deps.fetchImpl ?? fetch, {
    attempts: NPI_RETRY_ATTEMPTS,
    baseDelayMs: NPI_RETRY_BASE_MS,
    maxDelayMs: NPI_RETRY_MAX_DELAY_MS,
    timeoutMs: limits().npiTimeoutSeconds * 1000,
    sleep: deps.sleep,
    integration: 'npi',
  });
  if (!res.ok) throw new Error(`NPI registry HTTP ${res.status}`);
  // A body that is not JSON is rejected below like any unexpected shape; the parse error itself is logged here.
  const body: unknown = await res.json().catch((err: unknown) => {
    logger.warn({ err }, 'NPI registry response is not JSON');
    return undefined;
  });
  const parsed = NpiResponseSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), code: i.code })) },
      'NPI registry response rejected',
    );
    throw new Error('NPI registry returned an unexpected response');
  }
  const errors = parsed.data.Errors ?? [];
  if (errors.length) throw new Error(`NPI registry: ${errors.map((e) => e.description ?? 'error').join('; ')}`);
  return parsed.data.results ?? [];
}

/** Registry record for an NPI number, from the cache when fresh (24 h; 1 h for "not found"). */
export async function lookupNpi(npi: string, deps: NpiDeps = {}): Promise<NpiLookup> {
  const cache = deps.cache === undefined ? dbNpiCache : deps.cache;
  const cached = await cache?.get(npi);
  if (cached) return cached;
  const [result = null] = await queryRegistry({ number: npi }, deps);
  const lookup = { found: result !== null, result };
  await cache?.set(npi, lookup);
  return lookup;
}

export interface NpiSearchClaim {
  name: string | null;
  zip?: string | null;
  state?: string | null;
  specialty?: string | null;
}

export interface NpiSearchOutcome {
  /** The single registry record the claim resolves to, or null when it cannot be verified. */
  match: any | null;
  candidates: any[];
  query: Record<string, string>;
  reason: string;
  /** Set when the record was only found by a search wider than name + ZIP. */
  widened: string | null;
}

// "PA" is left out on purpose: it is also the physician-assistant credential.
const ORG_WORDS =
  /\b(llc|l\.l\.c|pllc|inc|corp|corporation|p\.c|group|associates|clinic|center|centre|health|medical|hospital|practice|services|partners|ltd|company)\b/i;
const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'prof']);
const CREDENTIALS = new Set([
  'md',
  'do',
  'np',
  'pa',
  'pa-c',
  'phd',
  'psy',
  'psyd',
  'dds',
  'dmd',
  'dpm',
  'dc',
  'crnp',
  'cnm',
  'crna',
  'caa',
  'aprn',
  'fnp',
  'bc',
  'rn',
  'facs',
  'faap',
  'facog',
  'facp',
  'jd',
  'jr',
  'sr',
  'ii',
  'iii',
  'iv',
  'mph',
  'mba',
]);

/** Drops parentheticals and any "dba ..." trade name: "Calla Slim Spa LLC dba Calla Slimspa" → "Calla Slim Spa LLC". */
const legalName = (name: string) =>
  name
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+(?:dba|d\/b\/a)\s+/i)[0]!
    .replace(/\s+/g, ' ')
    .trim();

/** "Dr. Jane Q. Smith, MD" → { first: "Jane", last: "Smith" }; organizations → { org }. */
export function parseProviderName(name: string): { first?: string; last?: string; org?: string } {
  const raw = legalName(name);
  if (ORG_WORDS.test(raw)) {
    return {
      org: raw
        .replace(/,?\s*\b(llc|l\.l\.c|pllc|inc|corp|p\.?c|p\.?a|ltd)\b\.?/gi, '')
        .replace(/[;,]+$/g, '')
        .trim(),
    };
  }
  // Titles only at the front, credentials only at the end, so surnames like "Do" survive ("Anh Do, MD").
  const tokens = raw
    .replace(/[^A-Za-z' -]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 2 && TITLES.has(tokens[0]!.toLowerCase())) tokens.shift();
  // "M.D." / "D.O." split into single letters, so trailing one-letter tokens go too.
  while (
    tokens.length > 2 &&
    (CREDENTIALS.has(tokens[tokens.length - 1]!.toLowerCase()) || tokens[tokens.length - 1]!.length === 1)
  )
    tokens.pop();
  const names = tokens.filter((t, i) => t.length > 1 || i === 0);
  if (names.length < 2) return { last: names[0] };
  return { first: names[0], last: names[names.length - 1] };
}

/** Mirrors the *_type CHECK constraints in db/migrations/001_schema.sql. */
export type NameType = 'INDIVIDUAL' | 'ORGANIZATION';

/** A name split by type: individuals have first/last names, organizations an entity name. */
export interface StructuredName {
  type: NameType | null;
  firstName: string | null;
  lastName: string | null;
  entityName: string | null;
}

export const NO_NAME: StructuredName = { type: null, firstName: null, lastName: null, entityName: null };

/**
 * Split a submission's provider name the same way the registry search reads it. Organizations keep their
 * legal name with the entity suffix ("KEM Health, LLC"); only a "dba" trade name and parentheticals are dropped.
 */
export function structureName(name: string | null | undefined): StructuredName {
  if (!name?.trim()) return NO_NAME;
  const p = parseProviderName(name);
  if (p.org !== undefined) {
    return {
      type: 'ORGANIZATION',
      firstName: null,
      lastName: null,
      entityName:
        legalName(name)
          .replace(/[;,]+$/g, '')
          .trim() || null,
    };
  }
  if (!p.last) return NO_NAME;
  return { type: 'INDIVIDUAL', firstName: p.first ?? null, lastName: p.last, entityName: null };
}

/** The registry record's own split: NPI-1 is an individual, NPI-2 an organization. */
export function registryStructuredName(r: any): StructuredName {
  if (!r) return NO_NAME;
  const b = r.basic ?? {};
  if (r.enumeration_type === 'NPI-2')
    return { type: 'ORGANIZATION', firstName: null, lastName: null, entityName: b.organization_name ?? null };
  if (r.enumeration_type === 'NPI-1')
    return { type: 'INDIVIDUAL', firstName: b.first_name ?? null, lastName: b.last_name ?? null, entityName: null };
  return NO_NAME;
}

export const zip5 = (s: string | null | undefined): string | null => s?.match(/\b(\d{5})(?:-?\d{4})?\b/)?.[1] ?? null;

/** True when any of the record's taxonomies shares a significant word with the claimed specialty. */
export function specialtyMatches(record: any, specialty: string): boolean {
  const words = normalize(specialty)
    .split(' ')
    .filter((w) => w.length > 3);
  if (!words.length) return false;
  return (record.taxonomies ?? []).some((t: any) => {
    const tax = normalize(t.desc ?? '');
    return words.some((w) => tax.includes(w.slice(0, 6)));
  });
}

/** Pick the single record a name/ZIP search resolves to: unique hit, else the unique specialty match. */
export function resolveCandidates(
  candidates: any[],
  specialty: string | null | undefined,
): { match: any | null; reason: string } {
  if (!candidates.length) return { match: null, reason: 'No registry record matches the name and location' };
  if (candidates.length === 1)
    return { match: candidates[0], reason: 'Single registry record matches the name and location' };
  if (!specialty)
    return {
      match: null,
      reason: `${candidates.length} registry records match and no specialty is stated to tell them apart`,
    };
  const bySpecialty = candidates.filter((c) => specialtyMatches(c, specialty));
  if (bySpecialty.length === 1)
    return {
      match: bySpecialty[0],
      reason: `${candidates.length} registry records match; one matches specialty "${specialty}"`,
    };
  return {
    match: null,
    reason: bySpecialty.length
      ? `${bySpecialty.length} registry records match the name, location and specialty "${specialty}"`
      : `${candidates.length} registry records match but none has specialty "${specialty}"`,
  };
}

/**
 * Search the registry by provider name + ZIP. When that finds nobody, widen to name + state, then name alone;
 * `widened` names the wider search so callers never report such a hit as a clean match.
 */
export async function searchNpi(claim: NpiSearchClaim, deps: NpiDeps = {}): Promise<NpiSearchOutcome> {
  const parsed = claim.name ? parseProviderName(claim.name) : {};
  const nameQuery: Record<string, string> = {};
  if (parsed.org) nameQuery.organization_name = `${parsed.org}*`;
  else {
    if (parsed.first) nameQuery.first_name = parsed.first;
    if (parsed.last) nameQuery.last_name = parsed.last;
  }
  if (!nameQuery.organization_name && !nameQuery.last_name) {
    return {
      match: null,
      candidates: [],
      query: nameQuery,
      reason: 'No provider name on the submission',
      widened: null,
    };
  }
  const zip = zip5(claim.zip);
  const state = claim.state && /^[A-Z]{2}$/i.test(claim.state.trim()) ? claim.state.trim().toUpperCase() : null;
  const tiers: { label: string; extra: Record<string, string> }[] = [
    ...(zip ? [{ label: 'name + ZIP', extra: { postal_code: zip } }] : []),
    ...(state ? [{ label: 'name + state', extra: { state } }] : []),
    { label: 'name only', extra: {} },
  ];

  for (const [i, tier] of tiers.entries()) {
    const query = { ...nameQuery, ...tier.extra };
    const candidates: any[] = await queryRegistry({ limit: String(NPI_SEARCH_LIMIT), ...query }, deps);
    if (!candidates.length) continue;
    // A full page means the result set may be truncated: too broad to pick one record from.
    if (candidates.length >= NPI_SEARCH_LIMIT) {
      return {
        match: null,
        candidates,
        query,
        reason: `Too many registry records match by ${tier.label} to identify the provider`,
        widened: null,
      };
    }
    const { match, reason } = resolveCandidates(candidates, claim.specialty);
    const widened = i === 0 && zip ? null : tier.label;
    return { match, candidates, query, reason: `${reason} (searched by ${tier.label})`, widened };
  }
  return {
    match: null,
    candidates: [],
    query: nameQuery,
    reason: `No registry record matches the name (searched by ${tiers.map((t) => t.label).join(', ')})`,
    widened: null,
  };
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(dr|md|do|np|pa|phd|dds|jr|sr|ii|iii|mr|mrs|ms)\b\.?/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function registryName(r: any): string | null {
  if (!r) return null;
  const b = r.basic ?? {};
  if (r.enumeration_type === 'NPI-2') return b.organization_name ?? null;
  return [b.first_name, b.middle_name, b.last_name].filter(Boolean).join(' ') || null;
}

/** The providers a submission names: every distinct name, state and specialty stated, best first. */
export interface ProviderClaims {
  names: string[];
  states: string[];
  specialties: string[];
}

const STATUS_RANK: Record<NpiStatus, number> = {
  MATCH: 0,
  PARTIAL_MATCH: 1,
  MISMATCH: 2,
  NOT_FOUND: 3,
  NOT_VERIFIED: 4,
  ERROR: 5,
};

/**
 * Compare an NPI on a group submission with the listed provider it belongs to. The extracted fields do not say which
 * NPI is whose, so every stated name × state × specialty is tried and the closest one wins: best status, then fewest
 * differences, then the order given (best first). An NPI that belongs to none of the listed providers stays a MISMATCH.
 */
export function compareNpiToProviders(
  npi: string,
  providers: ProviderClaims,
  lookup: Parameters<typeof compareNpi>[1],
): { claim: NpiClaim; result: NpiResult } {
  const options = (values: string[]): (string | null)[] => (values.length ? values : [null]);
  const claims: NpiClaim[] = options(providers.names).flatMap((name) =>
    options(providers.states).flatMap((state) =>
      options(providers.specialties).map((specialty) => ({ npi, name, state, specialty })),
    ),
  );
  return claims
    .map((claim) => ({ claim, result: compareNpi(claim, lookup) }))
    .reduce((best, c) =>
      STATUS_RANK[c.result.status] < STATUS_RANK[best.result.status] ||
      (c.result.status === best.result.status && c.result.mismatches.length < best.result.mismatches.length)
        ? c
        : best,
    );
}

/** Compare a submission's claimed provider details against the registry record. */
export function compareNpi(claim: NpiClaim, lookup: { found: boolean; result: any }): NpiResult {
  if (!lookup.found) {
    return {
      status: 'NOT_FOUND',
      registryName: null,
      registryTaxonomy: null,
      registryState: null,
      registryStatus: null,
      mismatches: [
        isValidNpi(claim.npi)
          ? 'NPI not found in CMS registry'
          : 'Not a valid NPI: it fails the NPI check digit (a typo, an OCR slip or a placeholder number)',
      ],
      registryData: null,
    };
  }
  const r = lookup.result;
  const primaryTax = (r.taxonomies ?? []).find((t: any) => t.primary) ?? r.taxonomies?.[0];
  const loc = (r.addresses ?? []).find((a: any) => a.address_purpose === 'LOCATION') ?? r.addresses?.[0];
  const regName = registryName(r);
  const regState: string | null = primaryTax?.state ?? loc?.state ?? null;
  const regTax: string | null = primaryTax?.desc ?? null;
  const regStatus: string | null = r.basic?.status ?? null;

  const mismatches: string[] = [];
  let nameMismatch = false;
  if (claim.name && regName) {
    const a = normalize(claim.name).split(' ');
    const b = normalize(regName).split(' ');
    const lastA = a[a.length - 1];
    const lastB = b[b.length - 1];
    const overlap = a.filter((t) => t.length > 1 && b.includes(t)).length;
    if (lastA !== lastB && overlap === 0) {
      nameMismatch = true;
      mismatches.push(`Name: submission "${claim.name}" vs registry "${regName}"`);
    } else if (lastA !== lastB || overlap < Math.min(2, a.length)) {
      mismatches.push(`Name partially matches: submission "${claim.name}" vs registry "${regName}"`);
    }
  }
  if (claim.state && regState && claim.state.trim().toUpperCase() !== regState.toUpperCase()) {
    mismatches.push(`State: submission ${claim.state} vs registry ${regState}`);
  }
  if (claim.specialty && regTax) {
    const words = normalize(claim.specialty)
      .split(' ')
      .filter((w) => w.length > 3);
    const tax = normalize(regTax);
    if (words.length && !words.some((w) => tax.includes(w.slice(0, 6)))) {
      mismatches.push(`Specialty: submission "${claim.specialty}" vs registry taxonomy "${regTax}"`);
    }
  }
  if (regStatus && regStatus !== 'A') mismatches.push(`Registry status is "${regStatus}" (not active)`);

  const status: NpiStatus = nameMismatch ? 'MISMATCH' : mismatches.length ? 'PARTIAL_MATCH' : 'MATCH';
  return {
    status,
    registryName: regName,
    registryTaxonomy: regTax,
    registryState: regState,
    registryStatus: regStatus,
    mismatches,
    registryData: r,
  };
}
