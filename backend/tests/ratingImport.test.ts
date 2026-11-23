/**
 * Rate workbook validation (importer.ts readRateWorkbooks) without a database: workbooks are written to a temp folder
 * with the same sheet and column names as data/rates.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import {
  exportFileName,
  exportRateWorkbook,
  RATE_WORKBOOKS,
  RateImportError,
  readRateWorkbook,
  readRateWorkbooks,
} from '../src/services/rating/importer.js';

type Sheet = { name: string; rows: Record<string, unknown>[] };

async function book(dir: string, prefix: string, sheets: Sheet[]) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    const cols = [...new Set(s.rows.flatMap((r) => Object.keys(r)))];
    ws.addRow(cols);
    for (const r of s.rows) ws.addRow(cols.map((c) => r[c] ?? null));
  }
  await wb.xlsx.writeFile(path.join(dir, `${prefix}_2026-01-02 00_00_00.xlsx`));
}

/** A minimal valid rate set; `over` replaces one sheet's rows. */
async function rates(
  over: Record<string, Record<string, unknown>[]> & { withoutReference?: true } = {},
): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ims-rates-'));
  const rows = (name: string, dflt: Record<string, unknown>[]) =>
    (over as Record<string, Record<string, unknown>[]>)[name] ?? dflt;
  await book(dir, 'State_Lookup', [
    {
      name: 'State Lookup',
      rows: rows('State Lookup', [
        {
          State: 'TX',
          'Base Rate': 10000,
          'Domicile State Tax Rate': 1,
          'State Tax Rate': 2.5,
          Defense: 'Inside',
          'Unique Key': 'S1',
        },
      ]),
    },
    { name: 'State Factors', rows: rows('State Factors', [{ State: 'TX', Year: 1, Factor: 0.5 }]) },
  ]);
  await book(dir, 'Territory_Lookup', [
    {
      name: 'Territories',
      rows: rows('Territories', [
        { State: 'TX', Territory: 1, Factor: 1.1, Counties: 'Travis, Remainder of State', 'Unique Key': 'T1' },
      ]),
    },
  ]);
  await book(dir, 'ILFDLF_Factor_Datatable_Lookup', [
    {
      name: 'Limits',
      rows: rows('Limits', [
        { State: 'TX', Factor: 1, 'Incident Limit': 1e6, 'Aggregate Limit': 3e6, Default: 'Yes', 'Unique Key': 'L1' },
      ]),
    },
  ]);
  await book(dir, 'Speciality_Lookup', [
    { name: 'Specialities Lookup', rows: [{ 'Speciality Code': '80268', Abbreviation: 'IM' }] },
    {
      name: 'Speciality Factor',
      rows: rows('Speciality Factor', [
        {
          'Speciality Code': '80268',
          Title: 'Internal Medicine',
          State: 'TX',
          'Factor Type': 'No Surgery',
          Factor: 1.2,
        },
      ]),
    },
  ]);
  await book(dir, 'Hours_Worked_Factor_Lookup', [
    {
      name: 'Hours',
      rows: rows('Hours', [{ Title: '0-40', Factor: 1, Type: 'FT', Default: 'Yes', 'Unique Key': 'H1' }]),
    },
  ]);
  await book(dir, 'Scheduled_Credit_Debit_Lookup', [
    {
      name: 'Credits',
      rows: rows('Credits', [{ Title: 'CME', 'Credit/Debit %': -5, Type: 'Credit', 'Unique Key': 'C1' }]),
    },
  ]);
  await book(dir, 'Rating_Fees_Lookup', [
    {
      name: 'Fees',
      rows: rows('Fees', [
        {
          Title: 'Fee',
          Calculate: 'No',
          'Allow edit': 'No',
          'Amount/% Of Premium': 25,
          State: 'All',
          '% Of Earn': '',
          Required: 'Yes',
          'Unique Key': 'F1',
        },
      ]),
    },
  ]);
  await book(dir, 'Policy_Fees_Lookup', [
    {
      name: 'Policy Fees',
      rows: rows('Policy Fees', [
        { Title: 'Policy fee', Amount: 150, '% Of Earn': 100, Required: 'Yes', 'Unique Key': 'P1' },
      ]),
    },
  ]);
  if (!over.withoutReference) {
    await book(dir, 'Endorsement_Lookup', [
      {
        name: 'Endorsement Lookup',
        rows: rows('Endorsement Lookup', [
          {
            Number: 1,
            Name: 'Administrative Proceeding',
            'Allow Edit': false,
            'Additional Insured': false,
            'Additional Location': false,
            ERP: false,
            'Exclusions Type': false,
            'Show Rates': false,
            Required: true,
            'Unique Key': 'EL-1',
            Contents: '<p>Text</p>',
          },
          {
            Number: 3,
            Name: 'No Major Surgery',
            'Allow Edit': true,
            'Additional Insured': false,
            'Additional Location': false,
            ERP: false,
            'Exclusions Type': true,
            'Show Rates': false,
            Required: false,
            'Unique Key': 'EL-3',
            Contents: '<p>Other</p>',
          },
        ]),
      },
      {
        name: 'Endorsement Rule Lookup',
        rows: rows('Endorsement Rule Lookup', [
          {
            'Endorsement Number': 3,
            Title: 'No Major Surgery',
            'Rule Group': 'Policy Module',
            Rule: 'Rating',
            Subrule: 'Speciality Type',
            Condition: 'Not Equals',
            Value: 'Major Surgery',
          },
        ]),
      },
    ]);
    await book(dir, 'Endorsement_Content_Lookup', [
      {
        name: 'Endorsement Contents Lookup',
        rows: rows('Endorsement Contents Lookup', [
          { Title: 'Claim Incident', 'Unique Key': 'ECL-2', Description: '<p>Coverage</p>' },
        ]),
      },
    ]);
    await book(dir, 'Policy_Enhancements_Lookup', [
      {
        name: 'Policy Enhancements Lookup',
        rows: rows('Policy Enhancements Lookup', [
          { Title: 'E1', Description: 'Administrative Proceedings', Required: true, 'Unique Key': 'ENHL-59' },
        ]),
      },
    ]);
    await book(dir, 'Rating_Deductible_Lookup', [
      {
        name: 'Rating Deductible Lookup',
        rows: rows('Rating Deductible Lookup', [{ Title: 'LTC Deductible', Amount: 5000, 'Unique Key': 'RDL-1' }]),
      },
    ]);
    await book(dir, 'RequiredItem_Lookup', [
      {
        name: 'Required Item Lookup',
        rows: rows('Required Item Lookup', [
          { Title: 'Medical License', Description: 'Medical License', Required: false, 'Unique Key': 'RIL-1' },
        ]),
      },
    ]);
  }
  return dir;
}

async function problems(dir: string): Promise<string[]> {
  try {
    await readRateWorkbooks(dir);
  } catch (err) {
    if (err instanceof RateImportError) return err.problems;
    throw err;
  }
  return [];
}

describe('rate workbook validation', () => {
  it('reads a valid rate set', async () => {
    const t = await readRateWorkbooks(await rates());
    expect(t.rateGroup).toMatch(/^rates-2026-01-02-[0-9a-f]{8}$/);
    expect(t.warnings).toEqual([]);
    expect(t.states[0]).toMatchObject({ state: 'TX', base_rate: 10000 });
    expect(t.territories[0]).toMatchObject({ counties: ['Travis'], is_remainder: true });
    expect(t.fees[0]).toMatchObject({ earn_percent: 0 });
  });

  it('rejects blank, non-numeric and non-positive base rates and factors, naming sheet and row', async () => {
    const found = await problems(
      await rates({
        'State Lookup': [
          { State: 'TX', 'Base Rate': 'abc', 'Domicile State Tax Rate': 1, 'State Tax Rate': 2.5, 'Unique Key': 'S1' },
          { State: 'NC', 'Base Rate': 0, 'Domicile State Tax Rate': 1, 'State Tax Rate': 2.5, 'Unique Key': 'S2' },
          { State: 'FL', 'Domicile State Tax Rate': 1, 'State Tax Rate': -1, 'Unique Key': 'S3' },
        ],
        Territories: [{ State: 'TX', Territory: 1, Factor: -1.1, Counties: 'Travis', 'Unique Key': 'T1' }],
        'Speciality Factor': [
          { 'Speciality Code': '80268', Title: 'IM', State: 'TX', 'Factor Type': 'No Surgery', Factor: 0 },
        ],
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /State_Lookup.*sheet "State Lookup" row 2: "Base Rate" is "abc", expected a number above 0/,
        ),
        expect.stringMatching(/sheet "State Lookup" row 3: "Base Rate" is 0/),
        expect.stringMatching(/sheet "State Lookup" row 4: "Base Rate" is blank/),
        expect.stringMatching(/sheet "State Lookup" row 4: "State Tax Rate" is -1, expected a number, 0 or more/),
        expect.stringMatching(/sheet "Territories" row 2: "Factor" is -1.1/),
        expect.stringMatching(/sheet "Speciality Factor" row 2: "Factor" is 0/),
      ]),
    );
  });

  it('rejects blank and repeated keys', async () => {
    const found = await problems(
      await rates({
        Limits: [
          { State: 'TX', Factor: 1, 'Incident Limit': 1e6, 'Aggregate Limit': 3e6, Default: 'Yes', 'Unique Key': 'L1' },
          { State: 'TX', Factor: 1.2, 'Incident Limit': 2e6, 'Aggregate Limit': 4e6, 'Unique Key': 'L1' },
          { State: 'TX', Factor: 1.3, 'Incident Limit': 3e6, 'Aggregate Limit': 5e6 },
        ],
        'State Factors': [
          { State: 'TX', Year: 1, Factor: 0.5 },
          { State: 'TX', Year: 1, Factor: 0.6 },
        ],
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sheet "Limits" row 3: Unique Key "L1" repeats row 2/),
        expect.stringMatching(/sheet "Limits" row 4: "Unique Key" is blank/),
        expect.stringMatching(/sheet "State Factors" row 3: State \+ Year "TX 1" repeats row 2/),
      ]),
    );
  });

  it('names the rate group after the workbook contents, so a changed export never replaces a group in use', async () => {
    const a = (await readRateWorkbooks(await rates())).rateGroup;
    expect((await readRateWorkbooks(await rates())).rateGroup).toBe(a);
    const changed = await readRateWorkbooks(
      await rates({
        'State Lookup': [
          {
            State: 'TX',
            'Base Rate': 10001,
            'Domicile State Tax Rate': 1,
            'State Tax Rate': 2.5,
            Defense: 'Inside',
            'Unique Key': 'S1',
          },
        ],
      }),
    );
    expect(changed.rateGroup).not.toBe(a);
    expect(changed.rateGroup).toMatch(/^rates-2026-01-02-/);
  });

  it('corrects a dropped-zero aggregate to the 1:3 format, with a warning naming it', async () => {
    const t = await readRateWorkbooks(
      await rates({
        Limits: [
          { State: 'TX', Factor: 1, 'Incident Limit': 1e6, 'Aggregate Limit': 3e6, Default: 'Yes', 'Unique Key': 'L1' },
          { State: 'TX', Factor: 0.75, 'Incident Limit': 5e5, 'Aggregate Limit': 1.5e5, 'Unique Key': 'L2' },
        ],
      }),
    );
    expect(t.limits.find((l) => l.key === 'L2')).toMatchObject({ incident_limit: 5e5, aggregate_limit: 1.5e6 });
    expect(t.warnings).toEqual([
      expect.stringMatching(/sheet "Limits" row 3: TX L2 "Aggregate Limit" 150000 corrected to 1500000/),
    ]);
  });

  it('imports any other aggregate below its per-incident limit as is, with a warning naming it', async () => {
    const t = await readRateWorkbooks(
      await rates({
        Limits: [
          { State: 'TX', Factor: 1, 'Incident Limit': 1e6, 'Aggregate Limit': 3e6, Default: 'Yes', 'Unique Key': 'L1' },
          { State: 'TX', Factor: 0.75, 'Incident Limit': 5e5, 'Aggregate Limit': 2e5, 'Unique Key': 'L2' },
        ],
      }),
    );
    expect(t.limits.find((l) => l.key === 'L2')).toMatchObject({ aggregate_limit: 2e5 });
    expect(t.warnings).toEqual([
      expect.stringMatching(/sheet "Limits" row 3: TX L2 "Aggregate Limit" 200000 is below "Incident Limit" 500000/),
    ]);
  });

  it('rejects ambiguous defaults, territories and unknown surgery types', async () => {
    const found = await problems(
      await rates({
        Limits: [
          { State: 'TX', Factor: 1, 'Incident Limit': 1e6, 'Aggregate Limit': 3e6, Default: 'Yes', 'Unique Key': 'L1' },
          {
            State: 'TX',
            Factor: 1.2,
            'Incident Limit': 2e6,
            'Aggregate Limit': 4e6,
            Default: 'Yes',
            'Unique Key': 'L2',
          },
          { State: 'NC', Factor: 1, 'Incident Limit': 1e6, 'Aggregate Limit': 3e6, 'Unique Key': 'L3' },
        ],
        Hours: [
          { Title: '0-20', Factor: 0.6, Type: 'PT', 'Unique Key': 'H1' },
          { Title: '20+', Factor: 1, Type: 'FT', 'Unique Key': 'H2' },
        ],
        Territories: [
          { State: 'TX', Territory: 1, Factor: 1.1, Counties: 'Travis, Remainder of State', 'Unique Key': 'T1' },
          {
            State: 'TX',
            Territory: 2,
            Factor: 1.3,
            Counties: 'Harris, travis, Remainder of State',
            'Unique Key': 'T2',
          },
          { State: 'NC', Territory: 1, Factor: 1, Counties: 'Wake', 'Unique Key': 'T3' },
        ],
        'Speciality Factor': [
          {
            'Speciality Code': '80268',
            Title: 'Internal Medicine',
            State: 'TX',
            'Factor Type': 'No Surgery',
            Factor: 1.2,
          },
          {
            'Speciality Code': '80268',
            Title: 'Internal Medicine',
            State: 'TX',
            'Factor Type': 'Surgery',
            Factor: 1.5,
          },
        ],
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sheet "Limits": TX has 2 default limit rows \(L1, L2\), expected exactly 1/),
        expect.stringMatching(/sheet "Limits": NC has 0 default limit rows, expected exactly 1/),
        expect.stringMatching(/sheet "Hours": 0 default hours rows, expected exactly 1/),
        expect.stringMatching(/sheet "Territories": TX has 2 "Remainder of State" territories \(rows 2, 3\)/),
        expect.stringMatching(/sheet "Territories": NC has 0 "Remainder of State" territories/),
        expect.stringMatching(/sheet "Territories" row 3: TX county "travis" is also in territory 1 \(row 2\)/),
        expect.stringMatching(
          /sheet "Speciality Factor" row 3: "Factor Type" is "Surgery", expected one of No Surgery, Minor Surgery, Major Surgery/,
        ),
      ]),
    );
  });

  it('accepts the rate workbooks shipped in data/rates', async () => {
    const t = await readRateWorkbooks('data/rates');
    expect(t.states.length).toBeGreaterThan(0);
    expect(t.factors.length).toBeGreaterThan(0);
    // The shipped export is clean: every limit is 1:3, so nothing is corrected or reported.
    expect(t.warnings).toEqual([]);
    expect(t.limits.filter((l) => l.aggregate_limit < l.incident_limit)).toEqual([]);
  }, 180_000);

  it('reads a valid rate set without rate_group on the rows (added when inserting)', async () => {
    const t = await readRateWorkbooks(await rates());
    expect(t.hours[0]).not.toHaveProperty('rate_group');
    expect(t.files).toHaveLength(13);
    expect(t.tables.lookup_rate_endorsements).toEqual([
      expect.objectContaining({
        sort_order: 1,
        number: 1,
        name: 'Administrative Proceeding',
        required: true,
        exclusions_type: false,
        revision_date: null,
        key: 'EL-1',
      }),
      expect.objectContaining({ sort_order: 2, number: 3, allow_edit: true, exclusions_type: true, key: 'EL-3' }),
    ]);
    expect(t.tables.lookup_rate_endorsement_rules).toEqual([
      expect.objectContaining({ endorsement_number: 3, condition: 'Not Equals', value: 'Major Surgery' }),
    ]);
    expect(t.tables.lookup_rate_deductibles).toEqual([
      { sort_order: 1, title: 'LTC Deductible', amount: 5000, key: 'RDL-1' },
    ]);
  });

  it('imports the folder without the reference lookups (they are optional there)', async () => {
    const t = await readRateWorkbooks(await rates({ withoutReference: true }));
    expect(t.files).toHaveLength(8);
    expect(t.tables.lookup_rate_endorsements).toBeUndefined();
  });

  it('rejects endorsement rules for unknown endorsements and repeated numbers', async () => {
    const found = await problems(
      await rates({
        'Endorsement Lookup': [
          { Number: 1, Name: 'A', 'Unique Key': 'EL-1' },
          { Number: 1, Name: 'B', 'Unique Key': 'EL-2' },
          { Number: 2, 'Unique Key': 'EL-3' },
        ],
        'Endorsement Rule Lookup': [{ 'Endorsement Number': 9, Title: 'X' }],
        'Rating Deductible Lookup': [{ Title: 'LTC', Amount: -1, 'Unique Key': 'RDL-1' }],
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sheet "Endorsement Lookup" row 3: Number 1 repeats an earlier row/),
        expect.stringMatching(/sheet "Endorsement Lookup" row 4: "Name" is blank/),
        expect.stringMatching(
          /sheet "Endorsement Rule Lookup" row 2: "Endorsement Number" 9 is not on the Endorsement Lookup sheet/,
        ),
        expect.stringMatching(/sheet "Rating Deductible Lookup" row 2: "Amount" is -1/),
      ]),
    );
  });
});

describe('single rate workbook validation', () => {
  const file = (dir: string, prefix: string) => {
    const name = readdirSync(dir).find((f) => f.startsWith(`${prefix}_`))!;
    return { name, data: readFileSync(path.join(dir, name)) };
  };

  it('reads one valid workbook', async () => {
    const { name, data } = file(await rates(), 'Hours_Worked_Factor_Lookup');
    const t = await readRateWorkbook('Hours_Worked_Factor_Lookup', name, data);
    expect(t.tables.lookup_rate_hours).toEqual([
      expect.objectContaining({ title: '0-40', factor: 1, key: 'H1', max_hours: 40 }),
    ]);
  });

  it('reports the speciality list size and both State_Lookup sheets', async () => {
    const dir = await rates();
    const sp = file(dir, 'Speciality_Lookup');
    expect((await readRateWorkbook('Speciality_Lookup', sp.name, sp.data)).specialityCount).toBe(1);
    const st = file(dir, 'State_Lookup');
    const t = await readRateWorkbook('State_Lookup', st.name, st.data);
    expect(Object.keys(t.tables)).toEqual(['lookup_rate_states', 'lookup_rate_step_ups']);
  });

  it('rejects a workbook named for another table', async () => {
    const { name, data } = file(await rates(), 'Policy_Fees_Lookup');
    await expect(readRateWorkbook('Hours_Worked_Factor_Lookup', name, data)).rejects.toThrow(
      /looks like the "Policy fees" workbook/,
    );
  });

  it('refuses a zip bomb before ExcelJS expands it (SEC-05)', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    // 24 MB of zeros deflates to a few KB: far past the expansion ratio only a zip bomb has.
    zip.file('xl/worksheets/sheet1.xml', Buffer.alloc(24 * 1024 * 1024));
    const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(data.length).toBeLessThan(1024 * 1024);
    await expect(readRateWorkbook('Hours_Worked_Factor_Lookup', 'hours.xlsx', data)).rejects.toThrow(
      /hours\.xlsx: File not read: (it expands more than \d+ times its size|a part expands past)/,
    );
  });

  it('rejects a file that is not a workbook, a missing sheet, and bad cells', async () => {
    await expect(
      readRateWorkbook('Hours_Worked_Factor_Lookup', 'hours.xlsx', Buffer.from('not a zip')),
    ).rejects.toThrow(/not a readable \.xlsx workbook/);
    const hours = file(await rates(), 'Hours_Worked_Factor_Lookup');
    await expect(readRateWorkbook('State_Lookup', 'states.xlsx', hours.data)).rejects.toThrow(
      /sheet "State Lookup" not found/,
    );
    const bad = file(
      await rates({ Hours: [{ Title: '0-40', Factor: 'abc', Type: 'FT', Default: 'Yes', 'Unique Key': 'H1' }] }),
      'Hours_Worked_Factor_Lookup',
    );
    const err = await readRateWorkbook('Hours_Worked_Factor_Lookup', bad.name, bad.data).catch((e) => e);
    expect(err).toBeInstanceOf(RateImportError);
    expect(err.problems).toEqual([expect.stringMatching(/sheet "Hours" row 2: "Factor" is "abc"/)]);
  });

  it('rejects a workbook with no rows', async () => {
    const { name, data } = file(await rates({ Hours: [] }), 'Hours_Worked_Factor_Lookup');
    await expect(readRateWorkbook('Hours_Worked_Factor_Lookup', name, data)).rejects.toThrow(/no rows found for hours/);
  });
});

describe('rate workbook export', () => {
  /** Serves the rows a full parse found, as the database would for one rate group. */
  const reader = (t: Awaited<ReturnType<typeof readRateWorkbooks>>) => {
    return async (sql: string) => (t.tables[/FROM (lookup_rate_\w+)/.exec(sql)![1]!] ?? []) as never[];
  };

  it('exports every workbook in a format the upload reads back unchanged', async () => {
    const t = await readRateWorkbooks(await rates());
    for (const { prefix } of RATE_WORKBOOKS) {
      const data = await exportRateWorkbook(prefix, 'g', reader(t));
      const back = await readRateWorkbook(prefix, exportFileName(prefix), data);
      for (const [table, rows] of Object.entries(back.tables))
        expect(rows, `${prefix} ${table}`).toEqual(t.tables[table]);
    }
  });

  it('round-trips the rate workbooks shipped in data/rates', async () => {
    const t = await readRateWorkbooks('data/rates');
    for (const { prefix } of RATE_WORKBOOKS) {
      const back = await readRateWorkbook(
        prefix,
        exportFileName(prefix),
        await exportRateWorkbook(prefix, 'g', reader(t)),
      );
      const n = Object.values(back.tables).reduce((sum, rows) => sum + rows!.length, 0);
      expect(n, prefix).toBeGreaterThan(0);
    }
    const hours = await readRateWorkbook(
      'Hours_Worked_Factor_Lookup',
      'h.xlsx',
      await exportRateWorkbook('Hours_Worked_Factor_Lookup', 'g', reader(t)),
    );
    expect(hours.tables.lookup_rate_hours).toEqual(t.hours);
    const terr = await readRateWorkbook(
      'Territory_Lookup',
      't.xlsx',
      await exportRateWorkbook('Territory_Lookup', 'g', reader(t)),
    );
    expect(terr.tables.lookup_rate_territories).toEqual(t.territories);
    const fees = await readRateWorkbook(
      'Rating_Fees_Lookup',
      'f.xlsx',
      await exportRateWorkbook('Rating_Fees_Lookup', 'g', reader(t)),
    );
    expect(fees.tables.lookup_rate_fees).toEqual(t.fees);
    // Every reference lookup comes back exactly as read, HTML contents and all.
    for (const { prefix, pricing, tables } of RATE_WORKBOOKS) {
      if (pricing) continue;
      const back = await readRateWorkbook(prefix, 'x.xlsx', await exportRateWorkbook(prefix, 'g', reader(t)));
      for (const table of tables) {
        expect(t.tables[table]!.length, table).toBeGreaterThan(0);
        expect(back.tables[table], table).toEqual(t.tables[table]);
      }
    }
  }, 180_000);

  it('names exports so they upload against the same workbook', () => {
    expect(exportFileName('Hours_Worked_Factor_Lookup', new Date('2026-11-04T09:05:07Z'))).toBe(
      'Hours_Worked_Factor_Lookup_2026-11-04 09_05_07.xlsx',
    );
  });
});
