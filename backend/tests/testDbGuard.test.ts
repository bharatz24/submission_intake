/** TEST-05: the global setup's guard against pointing the destructive DB suites at a non-test database. */
import { describe, expect, it } from 'vitest';

import { assertTestDatabaseUrl, databaseName } from './helpers/globalSetup.js';

describe('test database guard', () => {
  it.each([
    'postgres://ims:pw@localhost:5435/ims_test',
    'postgres://ims:pw@localhost:5435/ims_test_e',
    'postgres://ims:pw@db.internal:5432/app_test?sslmode=disable',
  ])('accepts %s', (url) => {
    expect(() => assertTestDatabaseUrl(url)).not.toThrow();
  });

  it.each([
    'postgres://ims:pw@localhost:5435/ims',
    'postgres://ims:pw@prod-db:5432/submissions',
    'postgres://ims:pw@localhost:5435/',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(/must name a test database/);
  });

  it('reads the database name from the URL path', () => {
    expect(databaseName('postgres://u:p@h:1/ims_test?x=1')).toBe('ims_test');
  });
});
