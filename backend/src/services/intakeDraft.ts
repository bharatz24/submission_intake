import { z } from 'zod';

import { config } from '../config.js';
import { pool, type Queryable } from '../db/pool.js';
import { logger } from '../logger.js';
import { type EffectiveField, effectiveFields, pickBest } from './fields.js';
import type { FieldSource, LookupQuery } from './ims2.js';
import { lookupZip } from './rating/geo.js';
import { toIsoDate } from './rating/inputs.js';
import { loadQuotes, type SavedQuote } from './rating/store.js';

/**
 * The prefill for an IMS 2 intake, built from what triage knows about a submission. draftDefaults() is reshaped into
 * the queue form by intakeQueuePayload.ts, which also builds the payload. Field sources compare the reviewed value with
 * the prefill: unchanged and taken from extraction = extracted, a manual entry over an extracted value or a reviewer
 * change to one = edited, anything with no extracted value behind it = manual. Email bodies and attachments stay here.
 */

export const BUSINESS_TYPES = ['new', 'renewal'] as const;
/** Endorsements (END*) are created only inside IMS 2. */
export const RECORD_TYPES = ['POL', 'POL-TL', 'POL-SL'] as const;

const opt = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((v) => (v ? v : null));
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const locationSchema = z.object({
  title: z.string().trim().min(3, 'Location title needs at least 3 characters').max(255),
  address1: opt,
  address2: opt,
  city: opt,
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Use the 2-letter state')
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v ? v.toUpperCase() : null)),
  zipcode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'Use a 5-digit ZIP code'),
});
const contactSchema = z.object({
  firstname: z.string().trim().min(1, 'First name is required').max(200),
  lastname: z.string().trim().min(1, 'Last name is required').max(200),
  contactnumber: z
    .string()
    .trim()
    .refine((v) => {
      const d = v.replace(/\D/g, '').length;
      return d >= 10 && d <= 14;
    }, 'Use 10 to 14 digits'),
  email: z.email('Invalid email address'),
  title: opt,
});

/** What the reviewer confirms in the hand-off card. */
export const handoffFormSchema = z.object({
  brokerId: z.number().int().positive('Choose the IMS 2 broker'),
  insured: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('link'), insuredId: z.string().regex(/^insured-\d+$/, 'Choose an IMS 2 insured') }),
    z.object({
      mode: z.literal('create'),
      create: z.object({
        insuredType: z.enum(['person', 'entity']),
        canonicalName: z.string().trim().min(1, 'Name is required').max(500),
        firstname: opt,
        lastname: opt,
        companyname: opt,
        npi: z
          .string()
          .trim()
          .regex(/^\d{10}$/, 'NPI is 10 digits')
          .nullish()
          .or(z.literal(''))
          .transform((v) => v || null),
        email: z
          .email('Invalid email address')
          .nullish()
          .or(z.literal(''))
          .transform((v) => v || null),
      }),
      location: locationSchema.nullable(),
      contact: contactSchema.nullable(),
    }),
  ]),
  policy: z.object({
    effectiveDate: isoDate,
    expiredDate: isoDate
      .nullish()
      .or(z.literal(''))
      .transform((v) => v || null),
    businessType: z.enum(BUSINESS_TYPES),
    recordType: z.enum(RECORD_TYPES),
    premium: z.number().nonnegative().nullable(),
    state: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Use the 2-letter state')
      .nullish()
      .or(z.literal(''))
      .transform((v) => (v ? v.toUpperCase() : null)),
    city: opt,
    specialty: opt,
    dateReceived: isoDate
      .nullish()
      .or(z.literal(''))
      .transform((v) => v || null),
  }),
});
export type HandoffForm = z.infer<typeof handoffFormSchema>;
type PolicyKey = keyof HandoffForm['policy'];

/** A prefilled value and where it came from (null source: nothing in triage supplies it). */
interface Prefill<T> {
  value: T;
  source: FieldSource | null;
  from: string | null;
}

export interface DraftDefaults {
  form: {
    brokerId: null;
    insured: Extract<HandoffForm['insured'], { mode: 'create' }>;
    policy: { [K in PolicyKey]: HandoffForm['policy'][K] | null };
  };
  /** Per policy field: the prefilled value's source and the triage field it came from. */
  sources: Partial<Record<PolicyKey, { source: FieldSource; from: string }>>;
  lookup: LookupQuery;
  /** Broker names to look up, best first (brokerCandidates); lookup.brokerName is the first. */
  brokerNames: string[];
  ratingIndication: Record<string, unknown> | null;
  setupProposal: Record<string, unknown> | null;
}

interface Context {
  submissionId: string;
  fields: EffectiveField[];
  /** Field names that have an extracted value, so a manual entry over one counts as an edit. */
  extracted: Set<string>;
  quote: SavedQuote | null;
  sub: {
    applicant_name: string | null;
    applicant_type: string | null;
    applicant_first_name: string | null;
    applicant_last_name: string | null;
    applicant_entity_name: string | null;
    from_address: string;
    received_at: string;
  };
  verifiedNpi: string | null;
  /** Email domains of this app's users: a sender there is a colleague forwarding, not the broker. */
  internalDomains: Set<string>;
}

async function loadContext(submissionId: string, db: Queryable): Promise<Context> {
  const [
    {
      rows: [sub],
    },
    fields,
    { rows: ext },
    { rows: npis },
    quotes,
    { rows: domains },
  ] = await Promise.all([
    db.query(
      `SELECT s.applicant_name, s.applicant_type, s.applicant_first_name, s.applicant_last_name, s.applicant_entity_name,
              s.primary_rating_id, e.from_address, e.received_at::text AS received_at
       FROM submissions s JOIN emails e ON e.id = s.email_id WHERE s.id = $1`,
      [submissionId],
    ),
    effectiveFields(submissionId, db),
    db.query(
      `SELECT DISTINCT field_name FROM extracted_fields
       WHERE submission_id=$1 AND context_version=(SELECT max(context_version) FROM extracted_fields WHERE submission_id=$1)`,
      [submissionId],
    ),
    db.query(`SELECT npi FROM npi_verifications WHERE submission_id=$1 AND status='MATCH' ORDER BY verified_at`, [
      submissionId,
    ]),
    loadQuotes({ submissionId }, db),
    db.query(`SELECT DISTINCT lower(split_part(email, '@', 2)) AS domain FROM users`),
  ]);
  const quote = quotes.find((q) => q.isPrimary && q.status === 'QUOTED') ?? null;
  return {
    submissionId,
    fields,
    quote,
    sub,
    extracted: new Set(ext.map((r) => r.field_name as string)),
    verifiedNpi: npis[0]?.npi ?? null,
    internalDomains: new Set(domains.map((r) => r.domain as string)),
  };
}

/** The best value of a triage field, tagged extracted / edited (manual over extracted) / manual. */
function fromField<T>(
  ctx: Context,
  name: string,
  map: (v: string) => T | null | undefined = (v) => v as T,
): Prefill<T | null> {
  const best = ctx.fields.filter((f) => f.fieldName === name).sort((a, b) => b.confidence - a.confidence)[0];
  const value = best ? (map(best.value) ?? null) : null;
  if (value === null || !best) return { value: null, source: null, from: null };
  const source: FieldSource = !best.manual ? 'extracted' : ctx.extracted.has(name) ? 'edited' : 'manual';
  return { value, source, from: name };
}

const firstOf = <T>(...p: Prefill<T | null>[]): Prefill<T | null> =>
  p.find((x) => x.value !== null) ?? { value: null, source: null, from: null };
const fromQuote = <T>(value: T | null | undefined, what: string): Prefill<T | null> =>
  value === null || value === undefined || value === ''
    ? { value: null, source: null, from: null }
    : { value, source: 'manual', from: what };

/** "Internal Medicine (60%)" → "Internal Medicine". */
const cleanSpecialty = (v: string) =>
  v
    .replace(/\(\s*\d+(\.\d+)?\s*%\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
const state2 = (v: string) => {
  const m = /\b([A-Za-z]{2})\b/.exec(v.trim());
  return m ? m[1]!.toUpperCase() : null;
};
const zip5 = (v: string) => /\b(\d{5})(?:-\d{4})?\b/.exec(v)?.[1] ?? null;

/** transaction_type as the field-extraction skill states it: New business, Renewal, ERP / tail, Add provider, ... */
function businessType(v: string): 'new' | 'renewal' | null {
  const t = v.toLowerCase();
  if (/renew/.test(t)) return 'renewal';
  if (/\bnew\b/.test(t)) return 'new';
  return null;
}

/** application_form: a DPLRRG renewal application is a renewal; any other application (ours or a competitor's) is new. */
const businessTypeFromForm = (v: string): 'new' | 'renewal' => (/renew/i.test(v) ? 'renewal' : 'new');

/** An extended reporting period (tail) is its own record type; everything else is a policy. */
const recordTypeOf = (v: string): 'POL-TL' | null => (/\berp\b|\btail\b|extended reporting/i.test(v) ? 'POL-TL' : null);

/** "1 Main St, Houston, TX 77002" → { city: Houston, state: TX }. */
function addressParts(v: string | null): { city: string | null; state: string | null } {
  const m = v ? /,\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+\d{5}(?:-\d{4})?\s*$/.exec(v.trim()) : null;
  return m ? { city: m[1]!.trim(), state: m[2]!.toUpperCase() } : { city: null, state: null };
}

function splitName(full: string | null): { first: string | null; last: string | null } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

const emailOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

/** Mail providers whose domain says nothing about the agency. */
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'live.com',
  'msn.com',
  'me.com',
]);

/**
 * Names to find the IMS 2 broker by, best first. IMS 2's brokers are agencies, while broker_name is usually
 * "person, agency" ("Debbie Gass, CRC Specialty"): the agency parts come first, then the whole name, then the email
 * domain's label ("crcgroup"). Our own domain (users' emails) and personal mail domains name no agency.
 */
export function brokerCandidates(name: string | null, email: string | null, internalDomains: Set<string>): string[] {
  const out: string[] = [];
  const add = (v: string | null | undefined) => {
    const t = v
      ?.replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t && t.length >= 2 && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  if (name) {
    const parts = name.split(/\s*[,;|]\s*|\s+[-–—]\s+/).filter(Boolean);
    for (const p of parts.slice(1)) add(p);
    add(name);
  }
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  if (domain && !internalDomains.has(domain) && !PERSONAL_DOMAINS.has(domain)) add(domain.split('.')[0]);
  return out.slice(0, 4);
}

/** 1000000 → "1mil", 250000 → "250k": the Policy Log's coverage limit notation. */
function limitLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}mil`;
  if (n >= 1000) return `${+(n / 1000).toFixed(2)}k`;
  return String(n);
}

export async function draftDefaults(submissionId: string, db: Queryable = pool): Promise<DraftDefaults> {
  const ctx = await loadContext(submissionId, db);
  const q = ctx.quote;
  const f = q?.factors;

  const individual = ctx.sub.applicant_type !== 'ORGANIZATION';
  const name = ctx.sub.applicant_name ?? pickBest(ctx.fields, 'applicant_name');
  const npi = ctx.verifiedNpi ?? fromField(ctx, 'npi', (v) => /\d{10}/.exec(v)?.[0]).value;
  const practiceLocation = pickBest(ctx.fields, 'practice_location');
  const address = addressParts(practiceLocation);
  const zip =
    fromField(ctx, 'practice_zip', zip5).value ??
    (practiceLocation ? zip5(practiceLocation) : null) ??
    f?.location?.zip ??
    null;
  // The ZIP's city and state (us_location_master) when the address does not say them.
  // A failed lookup only loses the city/state prefill: logged, and the draft is built without it.
  const zipInfo = zip
    ? await lookupZip(zip).catch((err: unknown) => {
        logger.warn({ err }, 'ZIP lookup failed; intake draft built without city/state from the ZIP');
        return null;
      })
    : null;
  // Per the extraction skill, contact_* are the applicant's own details, not the broker's.
  const contactEmail = pickBest(ctx.fields, 'contact_email');
  const contactPhone = pickBest(ctx.fields, 'contact_phone');
  const contactName = pickBest(ctx.fields, 'contact_name')
    ? splitName(pickBest(ctx.fields, 'contact_name'))
    : individual
      ? { first: ctx.sub.applicant_first_name, last: ctx.sub.applicant_last_name }
      : { first: null, last: null };
  const derived = <T>(value: T | null | undefined, from: string): Prefill<T | null> =>
    value === null || value === undefined || value === ''
      ? { value: null, source: null, from: null }
      : { value, source: 'extracted', from };

  const policy: Record<PolicyKey, Prefill<unknown>> = {
    effectiveDate: firstOf(fromField(ctx, 'effective_date', toIsoDate), fromQuote(f?.dates?.effectiveDate, 'quote')),
    // Left blank, IMS 2 sets effective date + 1 year.
    expiredDate: firstOf(fromField(ctx, 'expiration_date', toIsoDate), fromQuote(f?.dates?.expirationDate, 'quote')),
    businessType: firstOf(
      fromField(ctx, 'transaction_type', businessType),
      fromField(ctx, 'application_form', businessTypeFromForm),
    ),
    recordType: firstOf(fromField(ctx, 'transaction_type', recordTypeOf), { value: 'POL', source: null, from: null }),
    // The rating is a suggestion (ratingIndication); the record's premium is only what the reviewer types here.
    premium: { value: null, source: null, from: null },
    state: firstOf(
      fromField(ctx, 'practice_state', state2),
      derived(address.state, 'practice_location'),
      fromQuote(f?.location?.state, 'quote'),
      derived(zipInfo?.state, 'ZIP lookup'),
    ),
    city: firstOf(
      fromQuote(f?.location?.city, 'quote'),
      derived(address.city, 'practice_location'),
      derived(zipInfo?.city, 'ZIP lookup'),
    ),
    specialty: fromField(ctx, 'specialty', cleanSpecialty),
    dateReceived: { value: ctx.sub.received_at.slice(0, 10), source: 'extracted', from: 'email' },
  };

  const brokers = brokerCandidates(
    pickBest(ctx.fields, 'broker_name'),
    pickBest(ctx.fields, 'broker_email') ?? emailOf(ctx.sub.from_address),
    ctx.internalDomains,
  );

  const ratingIndication = q
    ? {
        premium: q.premium,
        total: q.total,
        rateGroup: q.rateGroup,
        quoteVersion: q.version,
        basis: `triage rating v${q.version}${q.label ? ` (${q.label})` : ''}`,
      }
    : null;
  const setup: Record<string, unknown> = {};
  if (f?.limits) setup.coverageLimit = `${limitLabel(f.limits.incidentLimit)}/${limitLabel(f.limits.aggregateLimit)}`;
  if (f?.deductible !== undefined) setup.deductible = f.deductible ?? '0';
  if (f?.specialities?.[0]?.code) setup.classCode = f.specialities[0].code;
  if (f?.dates?.retroDate) setup.retroDate = f.dates.retroDate;

  return {
    form: {
      brokerId: null,
      insured: {
        mode: 'create',
        create: {
          insuredType: individual ? 'person' : 'entity',
          canonicalName: name ?? '',
          firstname: individual ? ctx.sub.applicant_first_name : null,
          lastname: individual ? ctx.sub.applicant_last_name : null,
          companyname: individual ? null : (ctx.sub.applicant_entity_name ?? name),
          npi,
          email: contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim()) ? contactEmail.trim() : null,
        },
        location: zip
          ? {
              title: pickBest(ctx.fields, 'practice_name') ?? 'Main office',
              address1: practiceLocation?.split(',')[0]?.trim() || null,
              address2: null,
              city: (policy.city.value as string | null) ?? null,
              state: (policy.state.value as string | null) ?? null,
              zipcode: zip,
            }
          : null,
        contact:
          contactName.first && contactName.last && contactEmail && contactPhone
            ? {
                firstname: contactName.first,
                lastname: contactName.last,
                contactnumber: contactPhone,
                email: contactEmail,
                title: null,
              }
            : null,
      },
      policy: Object.fromEntries(
        Object.entries(policy).map(([k, p]) => [k, p.value]),
      ) as DraftDefaults['form']['policy'],
    },
    sources: Object.fromEntries(
      Object.entries(policy)
        .filter(([, p]) => p.source && p.from)
        .map(([k, p]) => [k, { source: p.source!, from: p.from! }]),
    ),
    lookup: {
      npi,
      email: contactEmail,
      name: individual ? (name ?? null) : (ctx.sub.applicant_entity_name ?? name ?? null),
      brokerName: brokers[0] ?? null,
    },
    brokerNames: brokers,
    ratingIndication,
    setupProposal: Object.keys(setup).length ? setup : null,
  };
}

/** Each policy field the reviewer sent, tagged against its prefill. */
export function fieldSourcesFor(defaults: DraftDefaults, policy: HandoffForm['policy']): Record<string, FieldSource> {
  const out: Record<string, FieldSource> = {};
  for (const [key, value] of Object.entries(policy) as [PolicyKey, unknown][]) {
    // recordType is a classification the reviewer picks, not evidence about the risk.
    if (value === null || value === undefined || value === '' || key === 'recordType') continue;
    const prefill = defaults.form.policy[key];
    const known = defaults.sources[key];
    if (!known) out[key] = 'manual';
    else if (String(prefill) === String(value)) out[key] = known.source;
    else out[key] = known.source === 'manual' ? 'manual' : 'edited';
  }
  return out;
}

export const triageUrl = (submissionId: string) =>
  `${config.FRONTEND_ORIGIN.replace(/\/$/, '')}/submissions/${submissionId}`;
