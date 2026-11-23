import { describe, expect, it } from 'vitest';

import {
  NPI_REGISTRY_SOURCE,
  registryContactFields,
  syncNpiRegistryFields,
} from '../src/services/npiRegistryFields.js';

const record = {
  addresses: [
    {
      address_purpose: 'LOCATION',
      address_1: '1200 SW 1ST ST',
      city: 'MIAMI',
      state: 'FL',
      postal_code: '331352402',
      telephone_number: '305-324-2000',
    },
    {
      address_purpose: 'MAILING',
      address_1: 'PO BOX 450',
      address_2: 'STE 2',
      city: 'MIAMI',
      state: 'FL',
      postal_code: '33135',
      telephone_number: '305-000-0000',
    },
  ],
};

describe('registryContactFields', () => {
  it('takes the practice location phone and the mailing address, labelled as the registry', () => {
    const out = registryContactFields('1477796001', record);
    expect(out.map((f) => [f.fieldName, f.value])).toEqual([
      ['contact_phone', '305-324-2000'],
      ['mailing_address', 'PO BOX 450, STE 2, MIAMI, FL 33135'],
    ]);
    expect(out.every((f) => f.sourceLabel === NPI_REGISTRY_SOURCE && f.documentId === null && f.confidence < 0.9)).toBe(
      true,
    );
    expect(out[0]!.evidenceQuote).toContain('NPI 1477796001');
  });

  it('formats a ZIP+4 and gives nothing for a record without addresses', () => {
    const out = registryContactFields('1', {
      addresses: [
        { address_purpose: 'MAILING', address_1: '1 Main', city: 'Austin', state: 'TX', postal_code: '787011923' },
      ],
    });
    expect(out[0]!.value).toBe('1 Main, Austin, TX 78701-1923');
    expect(registryContactFields('1', null)).toEqual([]);
  });
});

/** A database stand-in answering the queries syncNpiRegistryFields makes. */
function fakeDb(opts: {
  version: number | null;
  matched: { npi: string; registry_data: unknown }[];
  present: string[];
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    inserted: () => calls.filter((c) => c.sql.includes('INSERT')).map((c) => [c.params[1], c.params[2]]),
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('max(context_version)')) return { rows: [{ version: opts.version }] };
      if (sql.includes('FROM npi_verifications')) return { rows: opts.matched };
      if (sql.includes('UNION SELECT field_name')) return { rows: opts.present.map((field_name) => ({ field_name })) };
      return { rows: [] };
    },
  };
}

describe('syncNpiRegistryFields', () => {
  it('fills only the contact fields no source stated, and clears its earlier rows first', async () => {
    const db = fakeDb({
      version: 3,
      matched: [{ npi: '1477796001', registry_data: record }],
      present: ['mailing_address'],
    });
    await syncNpiRegistryFields('s1', db as never);
    expect(
      db.calls.some((c) => c.sql.startsWith('DELETE') && c.params[1] === 3 && c.params[2] === NPI_REGISTRY_SOURCE),
    ).toBe(true);
    expect(db.inserted()).toEqual([['contact_phone', '305-324-2000']]);
  });

  it('adds nothing without a matched NPI or before any extraction', async () => {
    const none = fakeDb({ version: 3, matched: [], present: [] });
    await syncNpiRegistryFields('s1', none as never);
    expect(none.inserted()).toEqual([]);
    const early = fakeDb({ version: null, matched: [{ npi: '1', registry_data: record }], present: [] });
    await syncNpiRegistryFields('s1', early as never);
    expect(early.calls).toHaveLength(1);
  });
});
