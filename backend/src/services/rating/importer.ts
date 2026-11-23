import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';

import ExcelJS from 'exceljs';
import type { PoolClient } from 'pg';

import { config } from '../../config.js';
import { OOXML_MAX_ENTRIES } from '../../constants.js';
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { zipBombCheck } from '../textExtraction.js';
import { q } from './db.js';
import { SURGERY_TYPES } from './tables.js';

/** A sheet row keyed by its header; __row is the 1-based spreadsheet row, for error messages. */
type Row = Record<string, unknown> & { __row?: number };

const str = (v: unknown): string => (v == null ? '' : String(v).trim());
/** A cell as a number: null when blank, NaN when it is not a number ("abc", "#N/A"). */
const parseNum = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  const t = str(v).replace(/[$,%\s]/g, '');
  return t === '' ? null : Number(t);
};
const bool = (v: unknown): boolean => v === true || /^(true|yes|y|1)$/i.test(str(v));
const stateCode = (v: unknown) => (str(v).toUpperCase() === 'ALL' ? 'All' : str(v).toUpperCase());

/** "12-20" -> 20, "0-12" -> 12, "20+" -> null (no upper bound). */
function maxHours(title: string): number | null {
  if (/\+\s*$/.test(title)) return null;
  const nums = title.match(/\d+(?:\.\d+)?/g);
  return nums ? Number(nums.at(-1)) : null;
}

/** Newest workbook per table prefix (file names carry the export timestamp). */
function latestFiles(dir: string): Map<string, string> {
  const byPrefix = new Map<string, string>();
  for (const f of fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xlsx'))
    .sort()) {
    byPrefix.set(f.replace(/_\d{4}-\d{2}-\d{2}.*$/, ''), f);
  }
  return byPrefix;
}

/** A cell as a plain value: formulas give their result, rich text and hyperlinks their text. */
function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return v;
  if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
  if ('richText' in v) return v.richText.map((r) => r.text).join('');
  if ('text' in v) return cellValue(v.text as ExcelJS.CellValue);
  if ('error' in v) return null;
  return String(v);
}

/** Rows of a sheet as objects keyed by the header row; blank rows are skipped. */
function sheetRows(ws: ExcelJS.Worksheet): Row[] {
  const header: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    header[col] = str(cellValue(cell.value));
  });
  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const out: Row = { __row: n };
    let any = false;
    header.forEach((h, col) => {
      if (!h || h === '__row') return;
      const v = cellValue(row.getCell(col).value);
      out[h] = v === '' ? null : v;
      if (out[h] !== null) any = true;
    });
    if (any) rows.push(out);
  });
  return rows;
}

/** Inserts an array of plain objects with one statement (jsonb_to_recordset). */
async function insertRows(
  client: PoolClient,
  table: string,
  columns: Record<string, string>,
  rows: Row[],
): Promise<void> {
  if (rows.length === 0) return;
  const names = Object.keys(columns);
  await client.query(
    `INSERT INTO ${table} (${names.join(', ')})
     SELECT ${names.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(${names.map((n) => `${n} ${columns[n]}`).join(', ')})`,
    [JSON.stringify(rows)],
  );
}

/** A workbook that cannot be imported as-is: every problem found, with sheet and row, so it can be fixed in one pass. */
export class RateImportError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Rate workbooks not imported (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.slice(0, 50).join('\n') +
        (problems.length > 50 ? `\n… and ${problems.length - 50} more` : ''),
    );
  }
}

/**
 * Validated cell readers for one sheet. A base rate or factor that is blank, not a number or not positive used to
 * become 0 and could price a $0 quote; now each one is an import problem naming the sheet and row.
 */
function checker(problems: string[], where: string) {
  const at = (r: Row) => `${where} row ${r.__row ?? '?'}`;
  const number = (r: Row, col: string, rule: 'positive' | 'nonNegative' | 'any', optional = false): number => {
    const n = parseNum(r[col]);
    if (n === null) {
      if (!optional) problems.push(`${at(r)}: "${col}" is blank`);
      return 0;
    }
    const ok = Number.isFinite(n) && (rule === 'any' || (rule === 'positive' ? n > 0 : n >= 0));
    if (!ok)
      problems.push(
        `${at(r)}: "${col}" is ${JSON.stringify(r[col])}, expected ${rule === 'any' ? 'a number' : rule === 'positive' ? 'a number above 0' : 'a number, 0 or more'}`,
      );
    return ok ? n : 0;
  };
  const text = (r: Row, col: string): string => {
    const v = str(r[col]);
    if (!v) problems.push(`${at(r)}: "${col}" is blank`);
    return v;
  };
  /** Each key once per sheet: rating looks rows up by key, so a repeat would make the choice arbitrary. */
  const seen = new Map<string, number | undefined>();
  const unique = (r: Row, label: string, value: string) => {
    if (!value) return;
    if (seen.has(value)) problems.push(`${at(r)}: ${label} "${value}" repeats row ${seen.get(value) ?? '?'}`);
    else seen.set(value, r.__row);
  };
  return { where, at, number, text, unique };
}

/**
 * The rate workbooks, each exported as "<prefix>_<timestamp>.xlsx", and the tables each one fills. A workbook can be
 * imported on its own (importRateWorkbook); the other tables are then copied from the active rate group.
 * `pricing: false` workbooks are reference lookups: stored and versioned with the group, but no quote reads them yet,
 * and the full folder import does not require them.
 */
export const RATE_WORKBOOKS = [
  {
    prefix: 'State_Lookup',
    label: 'States and step-up factors',
    pricing: true,
    tables: ['lookup_rate_states', 'lookup_rate_step_ups'],
  },
  { prefix: 'Territory_Lookup', label: 'Territories', pricing: true, tables: ['lookup_rate_territories'] },
  {
    prefix: 'ILFDLF_Factor_Datatable_Lookup',
    label: 'Limits (ILF/DLF factors)',
    pricing: true,
    tables: ['lookup_rate_limits'],
  },
  {
    prefix: 'Speciality_Lookup',
    label: 'Speciality factors',
    pricing: true,
    tables: ['lookup_rate_speciality_factors'],
  },
  { prefix: 'Hours_Worked_Factor_Lookup', label: 'Hours worked factors', pricing: true, tables: ['lookup_rate_hours'] },
  {
    prefix: 'Scheduled_Credit_Debit_Lookup',
    label: 'Scheduled credits and debits',
    pricing: true,
    tables: ['lookup_rate_credits'],
  },
  { prefix: 'Rating_Fees_Lookup', label: 'Rating fees', pricing: true, tables: ['lookup_rate_fees'] },
  { prefix: 'Policy_Fees_Lookup', label: 'Policy fees', pricing: true, tables: ['lookup_rate_policy_fees'] },
  {
    prefix: 'Endorsement_Lookup',
    label: 'Endorsements and endorsement rules',
    pricing: false,
    tables: ['lookup_rate_endorsements', 'lookup_rate_endorsement_rules'],
  },
  {
    prefix: 'Endorsement_Content_Lookup',
    label: 'Endorsement contents',
    pricing: false,
    tables: ['lookup_rate_endorsement_contents'],
  },
  {
    prefix: 'Policy_Enhancements_Lookup',
    label: 'Policy enhancements',
    pricing: false,
    tables: ['lookup_rate_policy_enhancements'],
  },
  {
    prefix: 'Rating_Deductible_Lookup',
    label: 'Rating deductibles',
    pricing: false,
    tables: ['lookup_rate_deductibles'],
  },
  { prefix: 'RequiredItem_Lookup', label: 'Required items', pricing: false, tables: ['lookup_rate_required_items'] },
] as const;

export type RateWorkbook = (typeof RATE_WORKBOOKS)[number]['prefix'];
export const RATE_WORKBOOK_PREFIXES = RATE_WORKBOOKS.map((w) => w.prefix) as [RateWorkbook, ...RateWorkbook[]];

/** Columns of each rate table (besides rate_group), with the type jsonb_to_recordset reads them as. */
const TABLE_COLUMNS: Record<string, Record<string, string>> = {
  lookup_rate_states: {
    state: 'text',
    base_rate: 'float8',
    domicile_tax_rate: 'float8',
    state_tax_rate: 'float8',
    defense: 'text',
    key: 'text',
  },
  lookup_rate_step_ups: { state: 'text', year: 'int', factor: 'float8' },
  lookup_rate_territories: {
    state: 'text',
    territory: 'int',
    factor: 'float8',
    counties: 'text[]',
    is_remainder: 'boolean',
    key: 'text',
  },
  lookup_rate_limits: {
    state: 'text',
    factor: 'float8',
    incident_limit: 'float8',
    aggregate_limit: 'float8',
    is_default: 'boolean',
    key: 'text',
  },
  lookup_rate_speciality_factors: {
    code: 'text',
    title: 'text',
    state: 'text',
    surgery_type: 'text',
    factor: 'float8',
    abbreviation: 'text',
  },
  lookup_rate_hours: {
    title: 'text',
    factor: 'float8',
    type: 'text',
    is_default: 'boolean',
    max_hours: 'float8',
    key: 'text',
  },
  lookup_rate_credits: { title: 'text', percent: 'float8', type: 'text', deductible_label: 'text', key: 'text' },
  lookup_rate_fees: {
    title: 'text',
    calculate: 'boolean',
    allow_edit: 'boolean',
    amount_or_percent: 'float8',
    state: 'text',
    earn_percent: 'float8',
    required: 'boolean',
    key: 'text',
  },
  lookup_rate_policy_fees: {
    title: 'text',
    amount: 'float8',
    earn_percent: 'float8',
    required: 'boolean',
    key: 'text',
  },
  lookup_rate_endorsements: {
    sort_order: 'int',
    number: 'int',
    name: 'text',
    revision_date: 'text',
    allow_edit: 'boolean',
    additional_insured: 'boolean',
    additional_location: 'boolean',
    erp: 'boolean',
    exclusions_type: 'boolean',
    show_rates: 'boolean',
    required: 'boolean',
    key: 'text',
    contents: 'text',
  },
  lookup_rate_endorsement_rules: {
    sort_order: 'int',
    endorsement_number: 'int',
    title: 'text',
    rule_group: 'text',
    rule: 'text',
    subrule: 'text',
    condition: 'text',
    value: 'text',
  },
  lookup_rate_endorsement_contents: { sort_order: 'int', title: 'text', description: 'text', key: 'text' },
  lookup_rate_policy_enhancements: {
    sort_order: 'int',
    title: 'text',
    description: 'text',
    required: 'boolean',
    key: 'text',
  },
  lookup_rate_deductibles: { sort_order: 'int', title: 'text', amount: 'float8', key: 'text' },
  lookup_rate_required_items: {
    sort_order: 'int',
    title: 'text',
    description: 'text',
    required: 'boolean',
    key: 'text',
  },
};

/** Short names used in rowCounts, per table. */
const COUNT_NAMES: Record<string, string> = {
  lookup_rate_states: 'states',
  lookup_rate_step_ups: 'step_ups',
  lookup_rate_territories: 'territories',
  lookup_rate_limits: 'limits',
  lookup_rate_speciality_factors: 'speciality_factors',
  lookup_rate_hours: 'hours',
  lookup_rate_credits: 'credits',
  lookup_rate_fees: 'rating_fees',
  lookup_rate_policy_fees: 'policy_fees',
  lookup_rate_endorsements: 'endorsements',
  lookup_rate_endorsement_rules: 'endorsement_rules',
  lookup_rate_endorsement_contents: 'endorsement_contents',
  lookup_rate_policy_enhancements: 'policy_enhancements',
  lookup_rate_deductibles: 'deductibles',
  lookup_rate_required_items: 'required_items',
};

export interface ImportResult {
  rateGroup: string;
  replaced: boolean;
  files: string[];
  rowCounts: Record<string, number>;
  /** Rows imported as-is that rating will not price (a quote using one is INCOMPLETE): fix them in the workbook. */
  warnings: string[];
}

type TableRows = Record<string, unknown>[];
type TerritoryRow = {
  state: string;
  territory: number;
  factor: number;
  counties: string[];
  is_remainder: boolean;
  key: string;
};

/** Rows read from the workbooks, keyed by table name (without rate_group: that is added when inserting). */
type TableData = Partial<Record<string, TableRows>>;

/** Every typed table read and checked from the workbooks, ready to insert. Nothing touches the database. */
export interface ParsedRates {
  rateGroup: string;
  files: string[];
  states: TableRows;
  stepUps: TableRows;
  territories: TerritoryRow[];
  limits: TableRows;
  specialityCount: number;
  factors: TableRows;
  hours: TableRows;
  credits: TableRows;
  fees: TableRows;
  policyFees: TableRows;
  /** Every table read, by table name (reference lookups missing from the folder are left out). */
  tables: TableData;
  warnings: string[];
}

/** One workbook's tables, plus the speciality list size (not stored, only reported). */
type Parsed = { tables: TableData; specialityCount?: number };

/** One uploaded workbook's tables, with the rows imported as-is that rating will not price. */
export type ParsedWorkbook = Parsed & { warnings: string[] };

/** Rows grouped by a key, e.g. limit rows by state, for checks across rows. */
function groupRows<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

type SheetReader = (name?: string) => { rows: Row[]; check: ReturnType<typeof checker> };

function sheetReader(wb: ExcelJS.Workbook, file: string, problems: string[]): SheetReader {
  return (name) => {
    const ws = name ? wb.getWorksheet(name) : wb.worksheets[0];
    if (!ws) throw new RateImportError([`${file}: sheet "${name ?? '(first sheet)'}" not found`]);
    return { rows: sheetRows(ws), check: checker(problems, `${file} sheet "${ws.name}"`) };
  };
}

/**
 * One parser per workbook: reads and checks its sheets, pushing every bad cell onto `problems` and every row kept
 * as-is that rating will not price onto `warnings`.
 */
const PARSERS: Record<RateWorkbook, (sheet: SheetReader, problems: string[], warnings: string[]) => Parsed> = {
  State_Lookup: (sheet, problems) => {
    const st = sheet('State Lookup');
    const states = st.rows
      .filter((r) => str(r['State']))
      .map((r) => {
        const state = str(r['State']).toUpperCase();
        st.check.unique(r, 'State', state);
        return {
          state,
          base_rate: st.check.number(r, 'Base Rate', 'positive'),
          domicile_tax_rate: st.check.number(r, 'Domicile State Tax Rate', 'nonNegative'),
          state_tax_rate: st.check.number(r, 'State Tax Rate', 'nonNegative'),
          defense: str(r['Defense']),
          key: str(r['Unique Key']),
        };
      });
    const su = sheet('State Factors');
    const stepUps = su.rows
      .filter((r) => str(r['State']))
      .map((r) => {
        const year = su.check.number(r, 'Year', 'positive');
        if (year && !Number.isInteger(year)) problems.push(`${su.check.at(r)}: "Year" ${year} is not a whole number`);
        const state = str(r['State']).toUpperCase();
        su.check.unique(r, 'State + Year', `${state} ${year}`);
        return { state, year, factor: su.check.number(r, 'Factor', 'positive') };
      });
    return { tables: { lookup_rate_states: states, lookup_rate_step_ups: stepUps } };
  },

  Territory_Lookup: (sheet, problems) => {
    const te = sheet();
    const read = te.rows.map((r) => {
      const counties = str(r['Counties'])
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const key = str(r['Unique Key']);
      te.check.unique(r, 'Unique Key', key);
      // counties: the county names only; the "Remainder of State" marker becomes is_remainder.
      return {
        row: r.__row,
        territory: {
          state: te.check.text(r, 'State').toUpperCase(),
          territory: te.check.number(r, 'Territory', 'nonNegative'),
          factor: te.check.number(r, 'Factor', 'positive'),
          counties: counties.filter((c) => !/remainder of state/i.test(c)).sort((a, b) => a.localeCompare(b)),
          is_remainder: counties.some((c) => /remainder of state/i.test(c)),
          key,
        } as TerritoryRow,
      };
    });
    // Rating takes the first territory a county is in, else the "Remainder of State" one: each must be unambiguous.
    for (const [state, rows] of groupRows(read, (t) => t.territory.state)) {
      if (!state) continue;
      const remainders = rows.filter((t) => t.territory.is_remainder);
      if (remainders.length !== 1) {
        problems.push(
          `${te.check.where}: ${state} has ${remainders.length} "Remainder of State" territories${remainders.length ? ` (rows ${remainders.map((t) => t.row).join(', ')})` : ''}, expected exactly 1`,
        );
      }
      const seen = new Map<string, (typeof rows)[number]>();
      for (const t of rows) {
        for (const county of t.territory.counties) {
          const other = seen.get(county.toLowerCase());
          if (other && other.territory.territory !== t.territory.territory) {
            problems.push(
              `${te.check.where} row ${t.row}: ${state} county "${county}" is also in territory ${other.territory.territory} (row ${other.row})`,
            );
          } else if (!other) seen.set(county.toLowerCase(), t);
        }
      }
    }
    return { tables: { lookup_rate_territories: read.map((t) => t.territory) } };
  },

  ILFDLF_Factor_Datatable_Lookup: (sheet, problems, warnings) => {
    const li = sheet();
    const limits = li.rows.map((r) => {
      const key = li.check.text(r, 'Unique Key');
      li.check.unique(r, 'Unique Key', key);
      const row = {
        state: li.check.text(r, 'State').toUpperCase(),
        factor: li.check.number(r, 'Factor', 'positive'),
        incident_limit: li.check.number(r, 'Incident Limit', 'positive'),
        aggregate_limit: li.check.number(r, 'Aggregate Limit', 'positive'),
        is_default: bool(r['Default']),
        key,
      };
      // Limits are offered at incident:aggregate 1:3. An aggregate a tenth of that ($500K/$150K in the shipped export)
      // is a dropped zero: store it in that format and say so. Any other aggregate below the incident limit is kept
      // as a warning, not a problem, so the export still imports; rating holds a quote on it INCOMPLETE (quote.ts).
      if (row.aggregate_limit < row.incident_limit && row.aggregate_limit * 10 === row.incident_limit * 3) {
        warnings.push(
          `${li.check.at(r)}: ${row.state} ${key} "Aggregate Limit" ${row.aggregate_limit} corrected to ${row.aggregate_limit * 10} (1:3 with "Incident Limit" ${row.incident_limit})`,
        );
        row.aggregate_limit *= 10;
      } else if (row.incident_limit > 0 && row.aggregate_limit > 0 && row.aggregate_limit < row.incident_limit) {
        warnings.push(
          `${li.check.at(r)}: ${row.state} ${key} "Aggregate Limit" ${row.aggregate_limit} is below "Incident Limit" ${row.incident_limit} — quotes on this limit stay INCOMPLETE until it is fixed`,
        );
      }
      return row;
    });
    // A stated limit falls back to nothing, an unstated one to the state's default row: exactly one per state.
    for (const [state, rows] of groupRows(limits, (l) => l.state)) {
      const defaults = rows.filter((l) => l.is_default);
      if (state && defaults.length !== 1) {
        problems.push(
          `${li.check.where}: ${state} has ${defaults.length} default limit rows${defaults.length ? ` (${defaults.map((l) => l.key).join(', ')})` : ''}, expected exactly 1`,
        );
      }
    }
    return { tables: { lookup_rate_limits: limits } };
  },

  Speciality_Lookup: (sheet, problems) => {
    // The speciality list only adds an abbreviation ("IM", "OBG") per code, kept on each factor row.
    const abbreviations = new Map<string, string>();
    const specialityRows = sheet('Specialities Lookup').rows;
    for (const r of specialityRows) {
      const code = str(r['Speciality Code']);
      if (code && !abbreviations.has(code) && str(r['Abbreviation'])) abbreviations.set(code, str(r['Abbreviation']));
    }
    const sf = sheet('Speciality Factor');
    const factors = sf.rows
      .filter((r) => {
        if (!str(r['Speciality Code'])) return false;
        if ((SURGERY_TYPES as readonly string[]).includes(str(r['Factor Type']))) return true;
        problems.push(
          `${sf.check.at(r)}: "Factor Type" is ${JSON.stringify(str(r['Factor Type']))}, expected one of ${SURGERY_TYPES.join(', ')}`,
        );
        return false;
      })
      .map((r) => {
        const code = str(r['Speciality Code']);
        const state = stateCode(r['State']);
        sf.check.unique(r, 'Speciality Code + State + Factor Type', `${code} ${state} ${str(r['Factor Type'])}`);
        return {
          code,
          title: str(r['Title']),
          state,
          surgery_type: str(r['Factor Type']),
          factor: sf.check.number(r, 'Factor', 'positive'),
          abbreviation: abbreviations.get(code) ?? null,
        };
      });
    return { tables: { lookup_rate_speciality_factors: factors }, specialityCount: specialityRows.length };
  },

  Hours_Worked_Factor_Lookup: (sheet, problems) => {
    const ho = sheet();
    const hours = ho.rows.map((r) => {
      const key = ho.check.text(r, 'Unique Key');
      ho.check.unique(r, 'Unique Key', key);
      return {
        title: str(r['Title']),
        factor: ho.check.number(r, 'Factor', 'positive'),
        type: str(r['Type']),
        is_default: bool(r['Default']),
        max_hours: maxHours(str(r['Title'])),
        key,
      };
    });
    const hourDefaults = hours.filter((h) => h.is_default);
    if (hours.length && hourDefaults.length !== 1) {
      problems.push(
        `${ho.check.where}: ${hourDefaults.length} default hours rows${hourDefaults.length ? ` (${hourDefaults.map((h) => h.key).join(', ')})` : ''}, expected exactly 1`,
      );
    }
    return { tables: { lookup_rate_hours: hours } };
  },

  Scheduled_Credit_Debit_Lookup: (sheet) => {
    const cr = sheet();
    return {
      tables: {
        lookup_rate_credits: cr.rows.map((r) => {
          const key = cr.check.text(r, 'Unique Key');
          cr.check.unique(r, 'Unique Key', key);
          return {
            title: str(r['Title']),
            // A credit is negative, a debit positive; either is fine, but it must be a number.
            percent: cr.check.number(r, 'Credit/Debit %', 'any'),
            type: str(r['Type']),
            deductible_label: str(r['Deductible Label']),
            key,
          };
        }),
      },
    };
  },

  Rating_Fees_Lookup: (sheet) => {
    const fe = sheet();
    return {
      tables: {
        lookup_rate_fees: fe.rows.map((r) => {
          const key = fe.check.text(r, 'Unique Key');
          fe.check.unique(r, 'Unique Key', key);
          return {
            title: str(r['Title']),
            calculate: bool(r['Calculate']),
            allow_edit: bool(r['Allow edit']),
            amount_or_percent: fe.check.number(r, 'Amount/% Of Premium', 'nonNegative'),
            state: stateCode(r['State']),
            earn_percent: fe.check.number(r, '% Of Earn', 'nonNegative', true),
            required: bool(r['Required']),
            key,
          };
        }),
      },
    };
  },

  Endorsement_Lookup: (sheet, problems) => {
    const en = sheet('Endorsement Lookup');
    const numbers = new Set<number>();
    const endorsements = en.rows.map((r, i) => {
      const key = en.check.text(r, 'Unique Key');
      en.check.unique(r, 'Unique Key', key);
      const number = en.check.number(r, 'Number', 'positive');
      if (number && !Number.isInteger(number))
        problems.push(`${en.check.at(r)}: "Number" ${number} is not a whole number`);
      else if (number && numbers.has(number))
        problems.push(`${en.check.at(r)}: Number ${number} repeats an earlier row`);
      numbers.add(number);
      return {
        sort_order: i + 1,
        number,
        name: en.check.text(r, 'Name'),
        revision_date: str(r['Revision Date']) || null,
        allow_edit: bool(r['Allow Edit']),
        additional_insured: bool(r['Additional Insured']),
        additional_location: bool(r['Additional Location']),
        erp: bool(r['ERP']),
        exclusions_type: bool(r['Exclusions Type']),
        show_rates: bool(r['Show Rates']),
        required: bool(r['Required']),
        key,
        contents: str(r['Contents']) || null,
      };
    });
    const ru = sheet('Endorsement Rule Lookup');
    const rules = ru.rows.map((r, i) => {
      const n = ru.check.number(r, 'Endorsement Number', 'positive');
      if (n && !numbers.has(n))
        problems.push(`${ru.check.at(r)}: "Endorsement Number" ${n} is not on the Endorsement Lookup sheet`);
      return {
        sort_order: i + 1,
        endorsement_number: n,
        title: str(r['Title']) || null,
        rule_group: str(r['Rule Group']) || null,
        rule: str(r['Rule']) || null,
        subrule: str(r['Subrule']) || null,
        condition: str(r['Condition']) || null,
        value: str(r['Value']) || null,
      };
    });
    return { tables: { lookup_rate_endorsements: endorsements, lookup_rate_endorsement_rules: rules } };
  },

  Endorsement_Content_Lookup: (sheet) => {
    const ec = sheet();
    return {
      tables: {
        lookup_rate_endorsement_contents: ec.rows.map((r, i) => {
          const key = ec.check.text(r, 'Unique Key');
          ec.check.unique(r, 'Unique Key', key);
          return {
            sort_order: i + 1,
            title: ec.check.text(r, 'Title'),
            description: str(r['Description']) || null,
            key,
          };
        }),
      },
    };
  },

  Policy_Enhancements_Lookup: (sheet) => {
    const pe = sheet();
    return {
      tables: {
        lookup_rate_policy_enhancements: pe.rows.map((r, i) => {
          const key = pe.check.text(r, 'Unique Key');
          pe.check.unique(r, 'Unique Key', key);
          return {
            sort_order: i + 1,
            title: pe.check.text(r, 'Title'),
            description: str(r['Description']) || null,
            required: bool(r['Required']),
            key,
          };
        }),
      },
    };
  },

  Rating_Deductible_Lookup: (sheet) => {
    const de = sheet();
    return {
      tables: {
        lookup_rate_deductibles: de.rows.map((r, i) => {
          const key = de.check.text(r, 'Unique Key');
          de.check.unique(r, 'Unique Key', key);
          return {
            sort_order: i + 1,
            title: de.check.text(r, 'Title'),
            amount: de.check.number(r, 'Amount', 'nonNegative'),
            key,
          };
        }),
      },
    };
  },

  RequiredItem_Lookup: (sheet) => {
    const ri = sheet();
    return {
      tables: {
        lookup_rate_required_items: ri.rows.map((r, i) => {
          const key = ri.check.text(r, 'Unique Key');
          ri.check.unique(r, 'Unique Key', key);
          return {
            sort_order: i + 1,
            title: ri.check.text(r, 'Title'),
            description: str(r['Description']) || null,
            required: bool(r['Required']),
            key,
          };
        }),
      },
    };
  },

  Policy_Fees_Lookup: (sheet) => {
    const pf = sheet();
    return {
      tables: {
        lookup_rate_policy_fees: pf.rows.map((r) => {
          const key = pf.check.text(r, 'Unique Key');
          pf.check.unique(r, 'Unique Key', key);
          return {
            title: str(r['Title']),
            amount: pf.check.number(r, 'Amount', 'nonNegative'),
            earn_percent: pf.check.number(r, '% Of Earn', 'nonNegative', true),
            required: bool(r['Required']),
            key,
          };
        }),
      },
    };
  },
};

/** Reads and validates the workbooks in `dir`; throws RateImportError listing every bad cell and repeated key. */
export async function readRateWorkbooks(dir: string): Promise<ParsedRates> {
  const files = latestFiles(dir);
  const problems: string[] = [];
  const warnings: string[] = [];
  const data: TableData = {};
  let specialityCount = 0;
  for (const { prefix, pricing } of RATE_WORKBOOKS) {
    const file = files.get(prefix);
    if (!file && !pricing) continue;
    if (!file) throw new Error(`Rate workbook "${prefix}_*.xlsx" not found in ${dir}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, file));
    const { tables, specialityCount: n } = PARSERS[prefix](sheetReader(wb, file, problems), problems, warnings);
    Object.assign(data, tables);
    if (n !== undefined) specialityCount = n;
  }
  if (problems.length) throw new RateImportError(problems);

  // The name carries a hash of the tables rated from (their values, not the file bytes, which change with every
  // save): a changed export is a new group, so the group a saved quote names keeps the rates it was priced with.
  // Re-importing the same values replaces the group with the same rows.
  const hash = createHash('sha256');
  for (const w of RATE_WORKBOOKS.filter((w) => w.pricing)) {
    for (const table of w.tables) hash.update(JSON.stringify([table, data[table] ?? []]));
  }
  const stamp = /(\d{4}-\d{2}-\d{2})/.exec(files.get('State_Lookup')!)?.[1] ?? new Date().toISOString().slice(0, 10);
  return {
    rateGroup: `${config.RATE_GROUP || `rates-${stamp}`}-${hash.digest('hex').slice(0, 8)}`,
    files: RATE_WORKBOOKS.flatMap((w) => files.get(w.prefix) ?? []),
    states: data.lookup_rate_states!,
    stepUps: data.lookup_rate_step_ups!,
    territories: data.lookup_rate_territories as TerritoryRow[],
    limits: data.lookup_rate_limits!,
    specialityCount,
    factors: data.lookup_rate_speciality_factors!,
    hours: data.lookup_rate_hours!,
    credits: data.lookup_rate_credits!,
    fees: data.lookup_rate_fees!,
    policyFees: data.lookup_rate_policy_fees!,
    tables: data,
    warnings,
  };
}

/** Reads and validates one uploaded workbook; throws RateImportError for an unreadable file, missing sheet or bad cell. */
export async function readRateWorkbook(prefix: RateWorkbook, fileName: string, data: Buffer): Promise<ParsedWorkbook> {
  // A file exported for another table (by its name) is almost certainly the wrong upload.
  const named = RATE_WORKBOOKS.find(
    (w) =>
      fileName.toLowerCase().startsWith(`${w.prefix.toLowerCase()}_`) ||
      fileName.toLowerCase() === `${w.prefix.toLowerCase()}.xlsx`,
  );
  if (named && named.prefix !== prefix) {
    throw new RateImportError([
      `${fileName} looks like the "${named.label}" workbook (${named.prefix}), not "${RATE_WORKBOOKS.find((w) => w.prefix === prefix)!.label}" (${prefix})`,
    ]);
  }
  // SEC-05: an .xlsx is a zip. Refuse one that inflates past the extraction limits (a zip bomb) before ExcelJS
  // expands all of it in memory; the same check the pipeline runs on attachments (textExtraction.ts).
  let bomb: Awaited<ReturnType<typeof zipBombCheck>>;
  try {
    bomb = await zipBombCheck(data, OOXML_MAX_ENTRIES);
  } catch {
    throw new RateImportError([`${fileName} is not a readable .xlsx workbook`]);
  }
  if (bomb) throw new RateImportError([`${fileName}: ${bomb.error ?? 'File not read'}`]);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new RateImportError([`${fileName} is not a readable .xlsx workbook`]);
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  const parsed = PARSERS[prefix](sheetReader(wb, fileName, problems), problems, warnings);
  if (problems.length) throw new RateImportError(problems);
  const empty = Object.entries(parsed.tables)
    .filter(([, v]) => !v?.length)
    .map(([k]) => k);
  if (empty.length)
    throw new RateImportError([`${fileName}: no rows found for ${empty.map((t) => COUNT_NAMES[t]).join(', ')}`]);
  return { ...parsed, warnings };
}

/** Inserts one table's rows for `rateGroup` with one statement (jsonb_to_recordset); territories row by row (text[]). */
async function insertTable(client: PoolClient, table: string, rateGroup: string, rows: TableRows): Promise<void> {
  if (rows.length === 0) return;
  if (table === 'lookup_rate_territories') {
    for (const r of rows as TerritoryRow[]) {
      await client.query(
        `INSERT INTO lookup_rate_territories (rate_group, state, territory, factor, counties, is_remainder, key) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rateGroup, r.state, r.territory, r.factor, r.counties, r.is_remainder, r.key],
      );
    }
    return;
  }
  await insertRows(
    client,
    table,
    { rate_group: 'text', ...TABLE_COLUMNS[table] },
    rows.map((r) => ({ ...r, rate_group: rateGroup })),
  );
}

/** Serialises rate imports across processes (Settings button, CLI, first-start import). */
const RATE_IMPORT_LOCK = 0x52415445; // 'RATE'

/**
 * Imports every workbook in the rates folder as one rate group and makes it active. Re-importing identical
 * workbooks (same group name, which carries their hash) replaces that group with the same rows; changed workbooks
 * are a new group, and older groups stay for the saved quotes that name them.
 */
export async function importRates(dir = config.RATES_DIR): Promise<ImportResult> {
  const t = await readRateWorkbooks(dir);
  const rateGroup = t.rateGroup;
  const tables = t.tables as Record<string, TableRows>;

  const replaced = await withTransaction(async (client) => {
    // A second import waits for the first and then replaces the same group, instead of interleaving with it.
    await client.query('SELECT pg_advisory_xact_lock($1)', [RATE_IMPORT_LOCK]);
    const existed = (await client.query('DELETE FROM lookup_rate_groups WHERE name = $1', [rateGroup])).rowCount! > 0;
    await client.query('INSERT INTO lookup_rate_groups (name) VALUES ($1)', [rateGroup]);
    for (const [table, rows] of Object.entries(tables)) await insertTable(client, table, rateGroup, rows);
    // The newest import becomes the active rate group for brand-new quotes.
    await client.query('UPDATE lookup_rate_groups SET is_active = (name = $1)', [rateGroup]);
    return existed;
  });

  const rowCounts: Record<string, number> = { specialities: t.specialityCount };
  for (const [table, rows] of Object.entries(tables)) rowCounts[COUNT_NAMES[table]!] = rows.length;
  return { rateGroup, replaced, files: t.files, rowCounts, warnings: t.warnings };
}

export interface WorkbookImportResult {
  rateGroup: string;
  /** The rate group the other tables were copied from; null when no rates were loaded yet (they stay empty). */
  basedOn: string | null;
  workbook: RateWorkbook;
  file: string;
  rowCounts: Record<string, number>;
  /** Rows imported as-is that rating will not price (a quote using one is INCOMPLETE): fix them in the workbook. */
  warnings: string[];
}

/** "Hours_Worked_Factor_Lookup" -> "hours-worked-factor". */
const slug = (prefix: string) =>
  prefix
    .replace(/_(Lookup|Datatable_Lookup)$/i, '')
    .replace(/_/g, '-')
    .toLowerCase();

/**
 * Imports one workbook as a new rate group: its tables come from the upload, every other table is copied from the
 * active group. The active group is left as it was, so quotes already priced with it keep their rates; the new group
 * becomes active for new quotes. With no rates loaded yet the other tables start empty: upload each workbook in turn.
 */
export async function importRateWorkbook(
  prefix: RateWorkbook,
  fileName: string,
  data: Buffer,
  /** How the workbook is parsed: in this thread by default; the API passes the worker (workbookParser.ts). */
  parse: typeof readRateWorkbook = readRateWorkbook,
): Promise<WorkbookImportResult> {
  const parsed = await parse(prefix, fileName, data);
  const own = new Set<string>(RATE_WORKBOOKS.find((w) => w.prefix === prefix)!.tables);

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [RATE_IMPORT_LOCK]);
    const {
      rows: [active],
    } = await client.query<{ name: string }>(
      'SELECT name FROM lookup_rate_groups WHERE is_active ORDER BY imported_at DESC LIMIT 1',
    );

    const base = `rates-${new Date().toISOString().slice(0, 10)}-${slug(prefix)}`;
    const { rows: taken } = await client.query<{ name: string }>(
      'SELECT name FROM lookup_rate_groups WHERE name = $1 OR name LIKE $2',
      [base, `${base}-%`],
    );
    const names = new Set(taken.map((r) => r.name));
    let rateGroup = base;
    for (let n = 2; names.has(rateGroup); n++) rateGroup = `${base}-${n}`;
    await client.query('INSERT INTO lookup_rate_groups (name) VALUES ($1)', [rateGroup]);

    const rowCounts: Record<string, number> = {};
    for (const table of Object.keys(TABLE_COLUMNS)) {
      if (own.has(table)) {
        const rows = parsed.tables[table] ?? [];
        await insertTable(client, table, rateGroup, rows);
        rowCounts[COUNT_NAMES[table]!] = rows.length;
      } else if (active) {
        const cols = Object.keys(TABLE_COLUMNS[table]!).join(', ');
        await client.query(
          `INSERT INTO ${table} (rate_group, ${cols}) SELECT $1, ${cols} FROM ${table} WHERE rate_group = $2`,
          [rateGroup, active.name],
        );
      }
    }
    if (parsed.specialityCount !== undefined) rowCounts.specialities = parsed.specialityCount;

    await client.query('UPDATE lookup_rate_groups SET is_active = (name = $1)', [rateGroup]);
    return {
      rateGroup,
      basedOn: active?.name ?? null,
      workbook: prefix,
      file: fileName,
      rowCounts,
      warnings: parsed.warnings,
    };
  });
}

/** Rows each workbook holds in a rate group, for the Settings page. */
export async function rateWorkbookCounts(rateGroup: string | undefined) {
  const counts = new Map<string, number>();
  if (rateGroup) {
    const sql = Object.keys(TABLE_COLUMNS)
      .map((t) => `SELECT '${t}' AS t, COUNT(*)::int AS n FROM ${t} WHERE rate_group = $1`)
      .join(' UNION ALL ');
    for (const r of await q<{ t: string; n: number }>(sql, [rateGroup])) counts.set(r.t, r.n);
  }
  return RATE_WORKBOOKS.map((w) => ({
    workbook: w.prefix,
    label: w.label,
    pricing: w.pricing,
    rows: Object.fromEntries(w.tables.map((t) => [COUNT_NAMES[t]!, counts.get(t) ?? 0])),
  }));
}

type ExportSheet = {
  name: string;
  sql: string;
  columns: [header: string, value: (r: Record<string, any>) => unknown][];
};

const yesNo = (v: unknown) => (v ? 'Yes' : 'No');

/**
 * What each workbook exports: the same sheet names and headers the importer reads, so an exported file can be edited
 * and uploaded again. Each query reads one rate group ($1).
 */
const EXPORTS: Record<RateWorkbook, ExportSheet[]> = {
  State_Lookup: [
    {
      name: 'State Lookup',
      sql: 'SELECT * FROM lookup_rate_states WHERE rate_group = $1 ORDER BY state',
      columns: [
        ['State', (r) => r.state],
        ['Base Rate', (r) => r.base_rate],
        ['Domicile State Tax Rate', (r) => r.domicile_tax_rate],
        ['State Tax Rate', (r) => r.state_tax_rate],
        ['Defense', (r) => r.defense],
        ['Unique Key', (r) => r.key],
      ],
    },
    {
      name: 'State Factors',
      sql: 'SELECT * FROM lookup_rate_step_ups WHERE rate_group = $1 ORDER BY state, year',
      columns: [
        ['State', (r) => r.state],
        ['Year', (r) => r.year],
        ['Factor', (r) => r.factor],
      ],
    },
  ],
  Territory_Lookup: [
    {
      name: 'Territory Lookup',
      sql: 'SELECT * FROM lookup_rate_territories WHERE rate_group = $1 ORDER BY state, territory, id',
      columns: [
        ['State', (r) => r.state],
        ['Territory', (r) => r.territory],
        ['Factor', (r) => r.factor],
        ['Counties', (r) => [...r.counties, ...(r.is_remainder ? ['Remainder of State'] : [])].join(', ')],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  ILFDLF_Factor_Datatable_Lookup: [
    {
      name: 'ILFDLF Factor',
      sql: 'SELECT * FROM lookup_rate_limits WHERE rate_group = $1 ORDER BY state, incident_limit, aggregate_limit',
      columns: [
        ['State', (r) => r.state],
        ['Factor', (r) => r.factor],
        ['Incident Limit', (r) => r.incident_limit],
        ['Aggregate Limit', (r) => r.aggregate_limit],
        ['Default', (r) => yesNo(r.is_default)],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  Speciality_Lookup: [
    {
      name: 'Specialities Lookup',
      sql: `SELECT DISTINCT ON (code) code, title, abbreviation FROM lookup_rate_speciality_factors
        WHERE rate_group = $1 ORDER BY code, state`,
      columns: [
        ['Speciality Code', (r) => r.code],
        ['Title', (r) => r.title],
        ['Abbreviation', (r) => r.abbreviation],
      ],
    },
    {
      name: 'Speciality Factor',
      sql: 'SELECT * FROM lookup_rate_speciality_factors WHERE rate_group = $1 ORDER BY code, state, surgery_type',
      columns: [
        ['Speciality Code', (r) => r.code],
        ['Title', (r) => r.title],
        ['State', (r) => r.state],
        ['Factor Type', (r) => r.surgery_type],
        ['Factor', (r) => r.factor],
      ],
    },
  ],
  Hours_Worked_Factor_Lookup: [
    {
      name: 'Hours Worked Factor',
      sql: 'SELECT * FROM lookup_rate_hours WHERE rate_group = $1 ORDER BY max_hours NULLS LAST, key',
      columns: [
        ['Title', (r) => r.title],
        ['Factor', (r) => r.factor],
        ['Type', (r) => r.type],
        ['Default', (r) => yesNo(r.is_default)],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  Scheduled_Credit_Debit_Lookup: [
    {
      name: 'Scheduled Credit Debit',
      sql: 'SELECT * FROM lookup_rate_credits WHERE rate_group = $1 ORDER BY key',
      columns: [
        ['Title', (r) => r.title],
        ['Credit/Debit %', (r) => r.percent],
        ['Type', (r) => r.type],
        ['Deductible Label', (r) => r.deductible_label],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  Rating_Fees_Lookup: [
    {
      name: 'Rating Fees',
      sql: 'SELECT * FROM lookup_rate_fees WHERE rate_group = $1 ORDER BY key',
      columns: [
        ['Title', (r) => r.title],
        ['Calculate', (r) => yesNo(r.calculate)],
        ['Allow edit', (r) => yesNo(r.allow_edit)],
        ['Amount/% Of Premium', (r) => r.amount_or_percent],
        ['State', (r) => r.state],
        ['% Of Earn', (r) => r.earn_percent],
        ['Required', (r) => yesNo(r.required)],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  Endorsement_Lookup: [
    {
      name: 'Endorsement Lookup',
      sql: 'SELECT * FROM lookup_rate_endorsements WHERE rate_group = $1 ORDER BY sort_order',
      columns: [
        ['Number', (r) => r.number],
        ['Name', (r) => r.name],
        ['Revision Date', (r) => r.revision_date],
        ['Allow Edit', (r) => r.allow_edit],
        ['Additional Insured', (r) => r.additional_insured],
        ['Additional Location', (r) => r.additional_location],
        ['ERP', (r) => r.erp],
        ['Exclusions Type', (r) => r.exclusions_type],
        ['Show Rates', (r) => r.show_rates],
        ['Required', (r) => r.required],
        ['Unique Key', (r) => r.key],
        ['Contents', (r) => r.contents],
      ],
    },
    {
      name: 'Endorsement Rule Lookup',
      sql: 'SELECT * FROM lookup_rate_endorsement_rules WHERE rate_group = $1 ORDER BY sort_order',
      columns: [
        ['Endorsement Number', (r) => r.endorsement_number],
        ['Title', (r) => r.title],
        ['Rule Group', (r) => r.rule_group],
        ['Rule', (r) => r.rule],
        ['Subrule', (r) => r.subrule],
        ['Condition', (r) => r.condition],
        ['Value', (r) => r.value],
      ],
    },
  ],
  Endorsement_Content_Lookup: [
    {
      name: 'Endorsement Contents Lookup',
      sql: 'SELECT * FROM lookup_rate_endorsement_contents WHERE rate_group = $1 ORDER BY sort_order',
      columns: [
        ['Title', (r) => r.title],
        ['Unique Key', (r) => r.key],
        ['Description', (r) => r.description],
      ],
    },
  ],
  Policy_Enhancements_Lookup: [
    {
      name: 'Policy Enhancements Lookup',
      sql: 'SELECT * FROM lookup_rate_policy_enhancements WHERE rate_group = $1 ORDER BY sort_order',
      columns: [
        ['Title', (r) => r.title],
        ['Description', (r) => r.description],
        ['Required', (r) => r.required],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  Rating_Deductible_Lookup: [
    {
      name: 'Rating Deductible Lookup',
      sql: 'SELECT * FROM lookup_rate_deductibles WHERE rate_group = $1 ORDER BY sort_order',
      columns: [
        ['Title', (r) => r.title],
        // numeric (032_schema_constraints.sql) arrives as a string; the workbook keeps a number cell.
        ['Amount', (r) => (r.amount === null ? null : Number(r.amount))],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  RequiredItem_Lookup: [
    {
      name: 'Required Item Lookup',
      sql: 'SELECT * FROM lookup_rate_required_items WHERE rate_group = $1 ORDER BY sort_order',
      columns: [
        ['Title', (r) => r.title],
        ['Description', (r) => r.description],
        ['Required', (r) => r.required],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
  Policy_Fees_Lookup: [
    {
      name: 'Policy Fees',
      sql: 'SELECT * FROM lookup_rate_policy_fees WHERE rate_group = $1 ORDER BY key',
      columns: [
        ['Title', (r) => r.title],
        ['Amount', (r) => r.amount],
        ['% Of Earn', (r) => r.earn_percent],
        ['Required', (r) => yesNo(r.required)],
        ['Unique Key', (r) => r.key],
      ],
    },
  ],
};

/** "<prefix>_YYYY-MM-DD HH_mm_ss.xlsx", the naming the rate exports use (and the upload checks). */
export const exportFileName = (prefix: string, at = new Date()) =>
  `${prefix}_${at.toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '_')}.xlsx`;

/** Writes header + rows as one sheet; header bold and frozen. */
export function addSheet(wb: ExcelJS.Workbook, name: string, headers: string[], rows: unknown[][]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(headers).font = { bold: true };
  for (const r of rows) ws.addRow(r.map((v) => (v === undefined ? null : v)));
  headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = Math.min(Math.max(h.length + 2, 12), 40);
  });
  return ws;
}

/** One workbook of a rate group as .xlsx, in the format the upload reads. */
export async function exportRateWorkbook(prefix: RateWorkbook, rateGroup: string, read: typeof q = q): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of EXPORTS[prefix]) {
    const rows = await read(sheet.sql, [rateGroup]);
    addSheet(
      wb,
      sheet.name,
      sheet.columns.map(([h]) => h),
      rows.map((r) => sheet.columns.map(([, v]) => v(r))),
    );
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * One workbook of a rate group written as .xlsx straight to `out` (PERF-02): ExcelJS's streaming writer commits each
 * row as it goes and zips into the stream, instead of building the whole workbook and its zip in memory. The rows
 * are read first, so a database error fails before the first byte (the caller can still answer with an error).
 */
export async function streamRateWorkbook(
  prefix: RateWorkbook,
  rateGroup: string,
  out: Writable,
  read: typeof q = q,
): Promise<void> {
  const sheets: { name: string; headers: string[]; rows: unknown[][] }[] = [];
  for (const sheet of EXPORTS[prefix]) {
    const rows = await read(sheet.sql, [rateGroup]);
    sheets.push({
      name: sheet.name,
      headers: sheet.columns.map(([h]) => h),
      rows: rows.map((r) => sheet.columns.map(([, v]) => v(r))),
    });
  }
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true });
  for (const { name, headers, rows } of sheets) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = headers.map((h) => ({ width: Math.min(Math.max(h.length + 2, 12), 40) }));
    const head = ws.addRow(headers);
    head.font = { bold: true };
    head.commit();
    for (const r of rows) ws.addRow(r.map((v) => (v === undefined ? null : v))).commit();
    ws.commit();
  }
  await wb.commit();
}

/** Imports the rates folder on first start so a fresh database can quote immediately. */
export async function ensureRatesImported(): Promise<void> {
  const [row] = await q<{ count: number }>('SELECT COUNT(*)::int AS count FROM lookup_rate_groups');
  if (row!.count > 0) return;
  if (!fs.existsSync(config.RATES_DIR)) {
    logger.warn({ dir: config.RATES_DIR }, 'rates folder not found: quoting is disabled until rates are imported');
    return;
  }
  const r = await importRates();
  logger.info({ rateGroup: r.rateGroup, rowCounts: r.rowCounts }, 'rate tables imported');
  if (r.warnings.length)
    logger.warn(
      { rateGroup: r.rateGroup, warnings: r.warnings },
      'rate tables imported with rows rating will not price',
    );
}
