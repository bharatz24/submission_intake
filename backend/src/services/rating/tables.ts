import { pool } from '../../db/pool.js';
import { q } from './db.js';

/** The class code of a specialty rated with an underwriter's factor (no rate class matched). */
export const MANUAL_CODE = 'MANUAL';

export const SURGERY_TYPES = ['No Surgery', 'Minor Surgery', 'Major Surgery'] as const;
export type SurgeryType = (typeof SURGERY_TYPES)[number];

export interface StateRow {
  state: string;
  baseRate: number;
  domicileTaxRate: number;
  stateTaxRate: number;
  defense: string;
  key: string;
}
export interface TerritoryRow {
  id: number;
  state: string;
  territory: number;
  factor: number;
  counties: string[];
  isRemainder: boolean;
  key: string;
}
export interface LimitRow {
  state: string;
  factor: number;
  incidentLimit: number;
  aggregateLimit: number;
  isDefault: boolean;
  key: string;
}
export interface SpecialityFactorRow {
  code: string;
  title: string;
  state: string; // two-letter state, or "All"
  surgeryType: SurgeryType;
  factor: number;
  abbreviation: string;
}
export interface HoursRow {
  title: string;
  factor: number;
  type: string;
  isDefault: boolean;
  key: string;
  /** Inclusive upper bound in weekly hours; Infinity for the open-ended band. */
  maxHours: number;
}
export interface CreditRow {
  title: string;
  percent: number;
  type: string;
  deductibleLabel: string;
  key: string;
}
export interface RatingFeeRow {
  title: string;
  calculate: boolean;
  allowEdit: boolean;
  amountOrPercent: number;
  state: string;
  earnPercent: number;
  required: boolean;
  key: string;
}
export interface PolicyFeeRow {
  title: string;
  amount: number;
  earnPercent?: number | null;
  required: boolean;
  key: string;
}

/** Everything needed to price one rating in one state — loaded with a handful of narrow queries. */
export interface RateContext {
  rateGroup: string;
  stateCode: string | null;
  state: StateRow | null;
  ratedStates: string[];
  stepUp: Map<number, number>;
  territories: TerritoryRow[];
  limits: LimitRow[];
  /** Classes for this state plus the generic "All" classes. */
  specialityFactors: SpecialityFactorRow[];
  hours: HoursRow[];
  credits: CreditRow[];
  /** Fees for this state plus "All". */
  ratingFees: RatingFeeRow[];
  policyFees: PolicyFeeRow[];
}

export class RatesNotLoadedError extends Error {
  constructor() {
    super('No rate tables imported: run "npm run rates:import" or import them in Settings');
  }
}

export async function activeRateGroup(): Promise<string> {
  const rows = await q<{ name: string }>(
    'SELECT name FROM lookup_rate_groups WHERE is_active ORDER BY imported_at DESC LIMIT 1',
  );
  if (!rows[0]) throw new RatesNotLoadedError();
  return rows[0].name;
}

export async function rateGroupExists(name: string): Promise<boolean> {
  return (await q('SELECT 1 FROM lookup_rate_groups WHERE name = $1', [name])).length > 0;
}

export async function listRateGroups() {
  return q('SELECT name, is_active, imported_at FROM lookup_rate_groups ORDER BY imported_at DESC');
}

/**
 * Reads every table in one REPEATABLE READ snapshot, so a rate import committing part-way through cannot mix two
 * versions of a rate group into one price.
 */
export async function loadRateContext(rateGroup: string, state: string | undefined): Promise<RateContext> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ctx = await readRateContext(
      <T>(sql: string, params: unknown[] = []) => client.query(sql, params).then((r) => r.rows as T[]),
      rateGroup,
      state,
    );
    await client.query('COMMIT');
    return ctx;
  } catch (err) {
    // A failed ROLLBACK means the connection is unusable: release it with the error so the pool destroys it.
    await client.query('ROLLBACK').catch((e: Error) => {
      broken = e;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

type Query = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

async function readRateContext(q: Query, rateGroup: string, state: string | undefined): Promise<RateContext> {
  const st = state?.toUpperCase() ?? null;
  // pg queues queries on one client, so these run in order inside the snapshot.
  const [states, stepUps, territories, limits, factors, hours, credits, fees, policyFees] = await Promise.all([
    q<{
      state: string;
      base_rate: number;
      domicile_tax_rate: number;
      state_tax_rate: number;
      defense: string;
      key: string;
    }>('SELECT * FROM lookup_rate_states WHERE rate_group = $1 ORDER BY state', [rateGroup]),
    st
      ? q<{ year: number; factor: number }>(
          'SELECT year, factor FROM lookup_rate_step_ups WHERE rate_group = $1 AND state = $2',
          [rateGroup, st],
        )
      : [],
    st
      ? q<{
          id: number;
          state: string;
          territory: number;
          factor: number;
          is_remainder: boolean;
          key: string;
          counties: string[] | null;
        }>(
          `SELECT id, state, territory, factor, is_remainder, key, counties
           FROM lookup_rate_territories WHERE rate_group = $1 AND state = $2 ORDER BY territory`,
          [rateGroup, st],
        )
      : [],
    st
      ? q<{
          state: string;
          factor: number;
          incident_limit: number;
          aggregate_limit: number;
          is_default: boolean;
          key: string;
        }>('SELECT * FROM lookup_rate_limits WHERE rate_group = $1 AND state = $2 ORDER BY incident_limit', [
          rateGroup,
          st,
        ])
      : [],
    st
      ? q<{
          code: string;
          title: string;
          state: string;
          surgery_type: SurgeryType;
          factor: number;
          abbreviation: string | null;
        }>(
          `SELECT code, title, state, surgery_type, factor, abbreviation
           FROM lookup_rate_speciality_factors WHERE rate_group = $1 AND state IN ($2, 'All')`,
          [rateGroup, st],
        )
      : [],
    q<{ title: string; factor: number; type: string; is_default: boolean; max_hours: number | null; key: string }>(
      'SELECT * FROM lookup_rate_hours WHERE rate_group = $1',
      [rateGroup],
    ),
    q<{ title: string; percent: number; type: string; deductible_label: string; key: string }>(
      'SELECT * FROM lookup_rate_credits WHERE rate_group = $1 ORDER BY key',
      [rateGroup],
    ),
    st
      ? q<{
          title: string;
          calculate: boolean;
          allow_edit: boolean;
          amount_or_percent: number;
          state: string;
          earn_percent: number;
          required: boolean;
          key: string;
        }>(`SELECT * FROM lookup_rate_fees WHERE rate_group = $1 AND state IN ($2, 'All') ORDER BY key`, [
          rateGroup,
          st,
        ])
      : [],
    q<{ title: string; amount: number; earn_percent: number | null; required: boolean; key: string }>(
      'SELECT * FROM lookup_rate_policy_fees WHERE rate_group = $1',
      [rateGroup],
    ),
  ]);

  const stateRow = st ? states.find((s) => s.state === st) : undefined;
  return {
    rateGroup,
    stateCode: st,
    state: stateRow
      ? {
          state: stateRow.state,
          baseRate: stateRow.base_rate,
          domicileTaxRate: stateRow.domicile_tax_rate,
          stateTaxRate: stateRow.state_tax_rate,
          defense: stateRow.defense,
          key: stateRow.key,
        }
      : null,
    ratedStates: states.map((s) => s.state),
    stepUp: new Map(stepUps.map((r) => [r.year, r.factor])),
    territories: territories.map((t) => ({
      id: t.id,
      state: t.state,
      territory: t.territory,
      factor: t.factor,
      counties: t.counties ?? [],
      isRemainder: t.is_remainder,
      key: t.key,
    })),
    limits: limits.map((l) => ({
      state: l.state,
      factor: l.factor,
      incidentLimit: l.incident_limit,
      aggregateLimit: l.aggregate_limit,
      isDefault: l.is_default,
      key: l.key,
    })),
    specialityFactors: factors.map((f) => ({
      code: f.code,
      title: f.title,
      state: f.state,
      surgeryType: f.surgery_type,
      factor: f.factor,
      abbreviation: f.abbreviation ?? '',
    })),
    hours: hours
      .map((h) => ({
        title: h.title,
        factor: h.factor,
        type: h.type,
        isDefault: h.is_default,
        key: h.key,
        maxHours: h.max_hours ?? Infinity,
      }))
      .sort((a, b) => a.maxHours - b.maxHours),
    credits: credits.map((c) => ({
      title: c.title,
      percent: c.percent,
      type: c.type,
      deductibleLabel: c.deductible_label ?? '',
      key: c.key,
    })),
    ratingFees: fees.map((f) => ({
      title: f.title,
      calculate: f.calculate,
      allowEdit: f.allow_edit,
      amountOrPercent: f.amount_or_percent,
      state: f.state,
      earnPercent: f.earn_percent,
      required: f.required,
      key: f.key,
    })),
    policyFees: policyFees.map((p) => ({
      title: p.title,
      amount: p.amount,
      earnPercent: p.earn_percent,
      required: p.required,
      key: p.key,
    })),
  };
}

/** Credit titles only — used to spot credits named in an email without loading a whole state. */
export async function creditTitles(rateGroup: string): Promise<{ key: string; title: string }[]> {
  return q('SELECT key, title FROM lookup_rate_credits WHERE rate_group = $1', [rateGroup]);
}
