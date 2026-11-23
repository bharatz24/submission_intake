// FE-04: response schemas for the busiest reads, and shapeOf's compile-time agreement with the app types.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mockApi } from '../test/msw/api';
import type { Report, User } from '../types';
import { api, ApiError } from './api';
import { shapeOf, SubmissionDetailSchema, SubmissionPageSchema, UserSchema } from './schemas';

const row = {
  id: 's1',
  subject: 'New application',
  fromAddress: 'broker@example.test',
  receivedAt: '2026-11-05T10:00:00Z',
  status: 'NEW',
  classification: null,
  documentCount: 0,
  isRead: false,
  applicantName: 'Dr. Jane Roe', // not checked: passes through untouched
};

describe('shapeOf', () => {
  it('only accepts checks that parse to the app type', () => {
    // A field must parse to T's type for it: a role is one of three, not any string.
    // @ts-expect-error string is not Role
    shapeOf<User>()({ role: z.string() });
    // @ts-expect-error a field the type does not have
    shapeOf<User>()({ nickname: z.string() });
    // @ts-expect-error status is RUNNING | COMPLETED | FAILED
    shapeOf<Report>()({ status: z.enum(['RUNNING', 'DONE']) });
    expect(shapeOf<User>()({ role: z.enum(['ADMIN', 'UNDERWRITER', 'VIEWER']) })).toBeDefined();
  });
});

describe('response schemas', () => {
  it('keep fields they do not check', () => {
    const page = SubmissionPageSchema.parse({ items: [row], total: 1, page: 1, pageSize: 25, counts: {} });
    expect(page.items[0]?.applicantName).toBe('Dr. Jane Roe');
  });

  it('refuse a user without a known role', () => {
    expect(UserSchema.safeParse({ id: 'u1', name: 'A', role: 'ADMIN' }).success).toBe(true);
    expect(UserSchema.safeParse({ id: 'u1', name: 'A', role: 'ROOT' }).success).toBe(false);
  });

  it('refuse a submission whose tab lists are not lists', () => {
    const detail = {
      ...row,
      email: {},
      documents: [],
      extractedFields: [],
      npiVerifications: [],
      latestSynthesis: null,
      latestAnalysis: null,
    };
    expect(SubmissionDetailSchema.safeParse(detail).success).toBe(true);
    expect(SubmissionDetailSchema.safeParse({ ...detail, documents: null }).success).toBe(false);
    expect(SubmissionDetailSchema.safeParse({ ...detail, status: 'ARCHIVED' }).success).toBe(false);
  });

  it('turn a changed server shape into a clear INVALID_RESPONSE error at the API boundary', async () => {
    mockApi({ 'GET /submissions/:id': () => ({ ...row, documents: 'none' }) });
    const err = await api.getSubmission('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INVALID_RESPONSE');
  });
});
