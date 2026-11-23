import { z } from 'zod';

import type {
  Classification,
  Comparison,
  EmailDraft,
  EmailDrafts,
  EmailDraftState,
  InboxView,
  LlmTranscript,
  Report,
  Role,
  SubmissionDetail,
  SubmissionPage,
  SubmissionStatus,
  SubmissionSummary,
  User,
} from '../types';
import type { ManagedUser } from './api';

/**
 * Response schemas, checked at the API boundary (services/api.ts request()), so a changed server shape fails with a
 * clear error instead of rendering half a screen. Only the fields the UI relies on are checked; the rest of the
 * payload passes through untouched (loose objects).
 *
 * `shapeOf<T>()` ties a check to the app type it guards, without casts (FE-04): every field it names must parse to
 * T's type for that field (a compile error otherwise), and the result is a `z.ZodType<T>`. Fields it leaves out are
 * T's on trust, as before; nested values it does not model get a structural check named with `checkedAs<X>()`.
 */
type Shape = Record<string, z.ZodType>;
type Agrees<T, S extends Shape> = [Exclude<keyof S, keyof T>] extends [never]
  ? [{ [K in keyof S]: z.output<S[K]> }] extends [Pick<T, keyof S & keyof T>]
    ? S
    : never
  : never;

/**
 * Names the app type a structural check stands for. The only type assertion in this file: the check has run (for
 * shapeOf, Agrees<T, S> has proven at compile time that every field it checks parses to T's type), and the fields it
 * does not model are the server's word, as for any unchecked response.
 */
function checkedAs<X>(schema: z.ZodType): z.ZodType<X> {
  return schema as z.ZodType<X>;
}

export function shapeOf<T>() {
  return <S extends Shape>(shape: S & Agrees<T, S>): z.ZodType<T> => checkedAs<T>(z.looseObject(shape));
}

const objectOf = <X>() => checkedAs<X>(z.looseObject({}));
const arrayOf = <X>(item: z.ZodType = z.looseObject({})) => checkedAs<X[]>(z.array(item));

const Actor = z.object({ id: z.string(), name: z.string() }).nullable();
const Usage = z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable();
const ReportKindSchema = z.enum(['SYNTHESIS', 'ANALYSIS']);
const ReportStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED']);
// Generated JSON stays open (each report view reads it defensively): only "an object or null" is checked.
const openContent = <X>() => checkedAs<X>(z.record(z.string(), z.unknown()).nullable());

export const ReportSchema = shapeOf<Report>()({
  id: z.string(),
  kind: ReportKindSchema,
  version: z.number().int(),
  status: ReportStatusSchema,
  contextVersion: z.number().int(),
  createdBy: Actor,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  content: openContent<Report['content']>(),
  markdown: z.string().nullable(),
  usage: Usage,
  // Added with the grounding check: absent from an older server, null when a version was not graded.
  grounding: checkedAs<Report['grounding']>(
    z
      .object({
        checked: z.number(),
        verified: z.number(),
        unverified: z.number(),
        items: z.array(z.looseObject({ path: z.string(), text: z.string(), missing: z.array(z.string()) })),
      })
      .nullable()
      .optional()
      .transform((g) => g ?? null),
  ),
});

export const ComparisonSchema = shapeOf<Comparison>()({
  id: z.string(),
  kind: ReportKindSchema,
  status: ReportStatusSchema,
  baseReportId: z.string(),
  targetReportId: z.string(),
  fieldDiff: arrayOf<Comparison['fieldDiff'][number]>(z.unknown()),
  content: openContent<Comparison['content']>(),
  markdown: z.string().nullable(),
  usage: Usage,
});

export const EmailDraftsSchema = shapeOf<EmailDrafts>()({
  id: z.string(),
  audience: z.enum(['broker', 'insured', 'quote']),
  createdAt: z.string(),
  draft: shapeOf<EmailDraft>()({ to: z.string().nullable(), subject: z.string(), body: z.string() }),
  analysisReportId: z.string(),
  stale: z.boolean(),
});

export const EmailDraftStateSchema = shapeOf<EmailDraftState>()({
  draft: EmailDraftsSchema.nullable(),
  run: z
    .object({
      id: z.string(),
      status: z.enum(['PENDING', 'FAILED']),
      error: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
});

/** A Claude call's transcript (Monitoring): prompt and output are null when only their hashes were stored. */
export const LlmTranscriptSchema = shapeOf<LlmTranscript>()({
  callId: z.string(),
  task: z.string(),
  model: z.string(),
  createdAt: z.string(),
  systemSha256: z.string(),
  promptSha256: z.string(),
  prompt: z.string().nullable(),
  output: z.string().nullable(),
});

// ---- The busiest reads: the signed-in user, the users list, an inbox page and a submission ----

const RoleSchema = z.enum(['ADMIN', 'UNDERWRITER', 'VIEWER']) satisfies z.ZodType<Role>;
const StatusSchema = z.enum([
  'NEW',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'COMPLETED',
  'NOT_SUBMISSION',
  'DUPLICATE',
  'ERROR',
]) satisfies z.ZodType<SubmissionStatus>;
const ClassificationSchema = z
  .enum(['SUBMISSION', 'NOT_SUBMISSION', 'REVIEW_REQUIRED'])
  .nullable() satisfies z.ZodType<Classification | null>;

/** GET /auth/me: who is signed in; `role` decides every permission check in the UI. */
export const UserSchema = shapeOf<User>()({
  id: z.string(),
  name: z.string(),
  role: RoleSchema,
});
/** GET /users: admins get full accounts, everyone else id, name and role (no email). */
export const UserListSchema = z.array(UserSchema);
/** GET /users as an admin (the Users screen): the account state its role/disable controls read. */
export const ManagedUserListSchema = z.array(
  shapeOf<ManagedUser>()({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: RoleSchema,
    disabledAt: z.string().nullable(),
    isDefaultAdmin: z.boolean(),
  }),
);

/** The inbox row fields the table, cards and bulk actions read. */
const summaryShape = {
  id: z.string(),
  subject: z.string(),
  fromAddress: z.string(),
  receivedAt: z.string(),
  status: StatusSchema,
  classification: ClassificationSchema,
  documentCount: z.number(),
  isRead: z.boolean(),
};
export const SubmissionSummarySchema = shapeOf<SubmissionSummary>()(summaryShape);

/** GET /submissions: one page of a tab, with the per-tab counts the tab badges show. */
export const SubmissionPageSchema = shapeOf<SubmissionPage>()({
  items: z.array(SubmissionSummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  // Older servers and some tabs send only the views they count; missing ones read as 0.
  counts: checkedAs<Record<InboxView, number>>(z.record(z.string(), z.number())),
});

/** GET /submissions/:id: the workspace. The lists every tab maps over must be arrays. */
export const SubmissionDetailSchema = shapeOf<SubmissionDetail>()({
  ...summaryShape,
  email: objectOf<SubmissionDetail['email']>(),
  documents: arrayOf<SubmissionDetail['documents'][number]>(),
  extractedFields: arrayOf<SubmissionDetail['extractedFields'][number]>(),
  npiVerifications: arrayOf<SubmissionDetail['npiVerifications'][number]>(),
  latestSynthesis: objectOf<NonNullable<SubmissionDetail['latestSynthesis']>>().nullable(),
  latestAnalysis: objectOf<NonNullable<SubmissionDetail['latestAnalysis']>>().nullable(),
});

/** Schemas whose parsed output is the app's type (they check its required fields; the rest passes through). */
export const responseSchemas = {
  report: ReportSchema,
  comparison: ComparisonSchema,
  emailDrafts: EmailDraftsSchema,
  emailDraftState: EmailDraftStateSchema,
  llmTranscript: LlmTranscriptSchema,
  user: UserSchema,
  users: UserListSchema,
  managedUsers: ManagedUserListSchema,
  submissionPage: SubmissionPageSchema,
  submissionDetail: SubmissionDetailSchema,
};
