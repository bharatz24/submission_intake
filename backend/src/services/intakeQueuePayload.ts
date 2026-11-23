import { createHash } from 'node:crypto';

import { z } from 'zod';

import { IMS2_REVIEW_BUDGET_BYTES } from '../constants.js';
import { pool, type Queryable } from '../db/pool.js';
import { buildCoverage, type CoverageSummary, type CoverageValue } from './coverage.js';
import { effectiveFields } from './fields.js';
import { type IntakePushV1, MAX_PREMIUM, QUEUE_CONTRACT_VERSION } from './ims2IntakeQueue.js';
import {
  BUSINESS_TYPES,
  type DraftDefaults,
  draftDefaults,
  fieldSourcesFor,
  type HandoffForm,
  RECORD_TYPES,
  triageUrl,
} from './intakeDraft.js';
import { loadQuotes } from './rating/store.js';
export { IMS2_REVIEW_BUDGET_BYTES } from '../constants.js';

/**
 * The intake for IMS 2's Submission Intake queue, built from the triage prefill (intakeDraft.ts). The queue contract is looser: the broker may go by name only, and location and contact are optional
 * field by field and go with an existing insured too, so the form has its own schema. Someone in IMS 2 completes it.
 */

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
const state2 = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use the 2-letter state')
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v.toUpperCase() : null));
const blankable = <T extends z.ZodTypeAny>(s: T) =>
  s
    .nullish()
    .or(z.literal(''))
    .transform((v) => (v || null) as z.infer<T> | null);

/** What the reviewer confirms in the queue card. */
export const queueFormSchema = z.object({
  broker: z.object({
    brokerId: z.number().int().positive().nullable(),
    brokerName: z.string().trim().min(1, 'Name the broker').max(500),
  }),
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
        npi: blankable(
          z
            .string()
            .trim()
            .regex(/^\d{10}$/, 'NPI is 10 digits'),
        ),
        email: blankable(z.email('Invalid email address')),
        licenseNumber: opt,
      }),
    }),
  ]),
  location: z
    .object({
      address1: opt,
      address2: opt,
      city: opt,
      state: state2,
      zipcode: blankable(
        z
          .string()
          .trim()
          .regex(/^\d{5}(-\d{4})?$/, 'Use a 5-digit ZIP code'),
      ),
    })
    .nullable(),
  contact: z
    .object({
      name: opt,
      email: blankable(z.email('Invalid email address')),
      phone: blankable(
        z
          .string()
          .trim()
          .refine((v) => {
            const d = v.replace(/\D/g, '').length;
            return d >= 10 && d <= 14;
          }, 'Use 10 to 14 digits'),
      ),
    })
    .nullable(),
  policy: z.object({
    effectiveDate: isoDate,
    expiredDate: blankable(isoDate),
    businessType: z.enum(BUSINESS_TYPES),
    recordType: z.enum(RECORD_TYPES),
    // NUMERIC(14,2) in IMS 2: rounded here so float noise is not a content change.
    premium: z
      .number()
      .nonnegative()
      .max(MAX_PREMIUM, 'Premium is too large')
      .nullable()
      .transform((v) => (v === null ? null : Math.round(v * 100) / 100)),
    state: state2,
    city: opt,
    specialty: opt,
    dateReceived: blankable(isoDate),
    agent: opt,
    underwriter: opt,
  }),
});
export type QueueForm = z.infer<typeof queueFormSchema>;

export interface QueueDefaults {
  form: Omit<QueueForm, 'insured' | 'policy'> & {
    insured: Extract<QueueForm['insured'], { mode: 'create' }>;
    policy: { [K in keyof QueueForm['policy']]: QueueForm['policy'][K] | null };
  };
  sources: DraftDefaults['sources'];
  lookup: DraftDefaults['lookup'];
  brokerNames: string[];
  ratingIndication: Record<string, unknown> | null;
  setupProposal: Record<string, unknown> | null;
  /** When the email arrived, as ISO 8601 with offset (IMS 2 refuses Postgres' text form). */
  receivedAt: string | null;
}

/** The triage prefill reshaped for the queue: location without its title, contact as one name. */
export async function queueDefaults(
  submissionId: string,
  db: Queryable = pool,
): Promise<{ queue: QueueDefaults; draft: DraftDefaults }> {
  const [
    draft,
    {
      rows: [e],
    },
  ] = await Promise.all([
    draftDefaults(submissionId, db),
    db.query('SELECT e.received_at FROM submissions s JOIN emails e ON e.id = s.email_id WHERE s.id=$1', [
      submissionId,
    ]),
  ]);
  const { insured, policy } = draft.form;
  const loc = insured.location;
  const contact = insured.contact;
  return {
    draft,
    queue: {
      form: {
        broker: { brokerId: null, brokerName: draft.brokerNames[0] ?? '' },
        insured: { mode: 'create', create: { ...insured.create, licenseNumber: null } },
        location: loc
          ? { address1: loc.address1, address2: loc.address2, city: loc.city, state: loc.state, zipcode: loc.zipcode }
          : null,
        contact: contact
          ? {
              name: `${contact.firstname} ${contact.lastname}`.trim(),
              email: contact.email,
              phone: contact.contactnumber,
            }
          : null,
        policy: { ...policy, agent: null, underwriter: null },
      },
      sources: draft.sources,
      lookup: draft.lookup,
      brokerNames: draft.brokerNames,
      ratingIndication: draft.ratingIndication,
      setupProposal: draft.setupProposal,
      receivedAt: e?.received_at ? new Date(e.received_at).toISOString() : null,
    },
  };
}

/** Drops null / blank values; undefined when nothing is left. */
function compact(o: Record<string, unknown> | null): Record<string, string> | undefined {
  if (!o) return undefined;
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  return Object.keys(out).length ? (out as Record<string, string>) : undefined;
}

type SlimValue = Pick<CoverageValue, 'value' | 'confidence' | 'sourceLabel'>;

/** What the reviewer saw, for IMS 2's read-only intake page. Each part is null when this submission has none. */
export interface IntakeReview {
  quote: {
    quoteId: string;
    version: number;
    label: string | null;
    status: string;
    rateGroup: string;
    premium: number | null;
    total: number | null;
    factors: unknown;
    pricing: unknown;
    flags: string[];
    missing: string[];
    createdAt: string;
  } | null;
  analysisReport: {
    reportId: string;
    version: number;
    createdAt: string;
    model: string | null;
    content: unknown;
  } | null;
  coverage: {
    values: Record<string, SlimValue | null>;
    lists: Record<string, SlimValue[]>;
    derived: CoverageSummary['derived'];
  } | null;
}

// Evidence quotes and conflicts stay here: they are long and IMS 2 only shows the values.
const slim = (v: CoverageValue): SlimValue => ({
  value: v.value,
  confidence: v.confidence,
  sourceLabel: v.sourceLabel,
});

export async function intakeReview(submissionId: string, db: Queryable = pool): Promise<IntakeReview> {
  const [
    quotes,
    {
      rows: [report],
    },
    fields,
  ] = await Promise.all([
    loadQuotes({ submissionId }, db),
    db.query(
      `SELECT id, version, created_at, model, content_json FROM reports
       WHERE submission_id=$1 AND kind='ANALYSIS' AND status='COMPLETED' ORDER BY version DESC LIMIT 1`,
      [submissionId],
    ),
    effectiveFields(submissionId, db),
  ]);
  // The same quote ratingIndication comes from (intakeDraft.ts loadContext).
  const q = quotes.find((x) => x.isPrimary && x.status === 'QUOTED') ?? null;
  const c = fields.length ? buildCoverage(fields) : null;
  return {
    quote: q
      ? {
          quoteId: q.id,
          version: q.version,
          label: q.label,
          status: q.status,
          rateGroup: q.rateGroup,
          premium: q.premium,
          total: q.total,
          factors: q.factors,
          pricing: q.pricing,
          flags: q.flags,
          missing: q.missing,
          createdAt: q.createdAt,
        }
      : null,
    analysisReport: report?.content_json
      ? {
          reportId: report.id,
          version: report.version,
          createdAt: new Date(report.created_at).toISOString(),
          model: report.model ?? null,
          content: report.content_json,
        }
      : null,
    coverage: c
      ? {
          values: Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, v ? slim(v) : null])),
          lists: Object.fromEntries(Object.entries(c.lists).map(([k, v]) => [k, v.map(slim)])),
          derived: c.derived,
        }
      : null,
  };
}

/** Contract v1 from the reviewed form. Optional fields left blank are left out, so IMS 2 sees only what we know. */
export function buildPush(input: {
  form: QueueForm;
  draft: DraftDefaults;
  queue: QueueDefaults;
  intakeId: string;
  version: number;
  sentBy: string;
  submissionId: string;
  review?: IntakeReview;
}): IntakePushV1 {
  const review = input.review;
  const { form } = input;
  const policy = Object.fromEntries(
    Object.entries(form.policy).filter(([, v]) => v !== null && v !== ''),
  ) as IntakePushV1['policy'];
  let insured: IntakePushV1['insured'];
  if (form.insured.mode === 'link') insured = { mode: 'existing', insuredId: form.insured.insuredId };
  else {
    const c = form.insured.create;
    insured = {
      mode: 'new',
      insuredType: c.insuredType === 'person' ? 'individual' : 'entity',
      canonicalName: c.canonicalName,
      ...compact({
        firstName: c.firstname,
        lastName: c.lastname,
        companyName: c.companyname,
        npi: c.npi,
        email: c.email,
        licenseNumber: c.licenseNumber,
      }),
    };
  }
  const location = compact(form.location);
  const contact = compact(form.contact);
  const sourceUrl = triageUrl(input.submissionId);
  const fieldSources = fieldSourcesFor(input.draft, form.policy as unknown as HandoffForm['policy']);
  const push: IntakePushV1 = {
    contractVersion: QUEUE_CONTRACT_VERSION,
    intakeId: input.intakeId,
    version: input.version,
    ...(/^https?:\/\//i.test(sourceUrl) ? { sourceUrl } : {}),
    sentBy: input.sentBy,
    ...(input.queue.receivedAt ? { receivedAt: input.queue.receivedAt } : {}),
    insured,
    broker: { ...(form.broker.brokerId ? { brokerId: form.broker.brokerId } : {}), brokerName: form.broker.brokerName },
    policy,
    ...(location ? { location } : {}),
    ...(contact ? { contact } : {}),
    ...(input.queue.ratingIndication ? { ratingIndication: input.queue.ratingIndication } : {}),
    ...(input.queue.setupProposal ? { setupProposal: input.queue.setupProposal } : {}),
    ...(Object.keys(fieldSources).length ? { fieldSources } : {}),
  };
  return withReview(push, review);
}

// The review parts are extras: drop them from the end (analysis report first) until the push fits, so a big report never blocks the hand-off.
function withReview(push: IntakePushV1, review: IntakeReview | undefined): IntakePushV1 {
  const parts = [
    ['quote', review?.quote],
    ['coverage', review?.coverage],
    ['analysisReport', review?.analysisReport],
  ].filter(([, v]) => v) as [keyof IntakeReview, unknown][];
  for (let n = parts.length; n > 0; n--) {
    const out = { ...push, ...Object.fromEntries(parts.slice(0, n)) };
    if (Buffer.byteLength(JSON.stringify(out)) <= IMS2_REVIEW_BUDGET_BYTES) return out;
  }
  return push;
}

/** The payload's hash without its version: equal hashes resend the same version, so IMS 2 replays. */
export const payloadHash = (body: IntakePushV1) =>
  createHash('sha256')
    .update(JSON.stringify({ ...body, version: undefined }))
    .digest('hex');
