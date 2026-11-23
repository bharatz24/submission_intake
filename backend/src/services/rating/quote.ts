import { config } from '../../config.js';
import { pool, withTransaction } from '../../db/pool.js';
import { audit } from '../audit.js';
import { priceRating, type PricingResult, retroYears, round2, specialityFactor, stepUpFactor } from './calc.js';
import { normKey } from './db.js';
import { lookupCity, lookupZip } from './geo.js';
import {
  applyDateDefaults,
  DEFAULT_EFFECTIVE_SOURCE,
  DEFAULT_EXPIRATION_SOURCE,
  DEFAULT_RETRO_SOURCE,
  deriveRatingInputs,
  type RatingInputs,
} from './inputs.js';
import { loadQuotes, overwriteRating, saveRating, syncCoverageFees } from './store.js';
import {
  activeRateGroup,
  loadRateContext,
  MANUAL_CODE,
  type RateContext,
  rateGroupExists,
  RatesNotLoadedError,
  type SpecialityFactorRow,
  SURGERY_TYPES,
  type SurgeryType,
} from './tables.js';

export interface SpecialityCandidate {
  code: string;
  title: string;
  score: number;
  surgeryTypes: string[];
}

export interface QuoteFactors {
  location?: {
    zip: string | null;
    city: string | null;
    state: string | null;
    county: string | null;
    countySource: string | null;
    /** Largest first; only on a preview, not stored with a saved quote. */
    zipCounties?: { name: string; share?: number }[];
  };
  state?: { state: string; baseRate: number; domicileTaxRate: number; stateTaxRate: number; defense: string };
  /** stepUpYear: the step-up table year used (below retroYears = "Mature"). */
  dates?: { effectiveDate: string; expirationDate: string; retroDate: string; retroYears: number; stepUpYear?: number };
  stepUp?: number;
  specialities?: {
    requested: string;
    /** MANUAL for a specialty rated with an underwriter's factor (no rate class matched). */
    code: string;
    title: string;
    surgeryType: SurgeryType | 'Not stated';
    specialityClass: number;
    practicePercent: number;
    factorState: string;
    matchedFrom: string;
    /** Other close classes; only on a preview, not stored with a saved quote. */
    candidates?: SpecialityCandidate[];
    /** Set when an underwriter entered the factor: why. */
    manual?: { reason: string };
  }[];
  speciality?: number;
  territory?: { territory: number; factor: number; county: string | null; matched: 'county' | 'remainder' };
  limits?: { key: string; incidentLimit: number; aggregateLimit: number; factor: number };
  fte?: { key: string; title: string; factor: number };
  scheduledCredits?: { key: string; title: string; percent: number; type: string; deductibleLabel: string }[];
  deductible?: string | null;
  ratingFees?: {
    key: string;
    title: string;
    calculate: boolean;
    amount: number;
    required: boolean;
    state?: string;
    earnPercent?: number;
  }[];
  policyFees?: { key: string; title: string; amount: number; earnPercent?: number }[];
}

export interface QuoteResult {
  status: 'QUOTED' | 'INCOMPLETE';
  rateGroup: string;
  inputs: RatingInputs;
  factors: QuoteFactors;
  pricing: PricingResult | null;
  /** Rounded to cents for display / storage. */
  summary: {
    premium: number;
    ratingFees: number;
    taxes: number;
    policyFees: number;
    total: number;
    combineTotal: number;
  } | null;
  /** Assumptions made or things a reviewer should know. */
  flags: string[];
  /** Blocking: the rating cannot be priced until these are supplied. */
  missing: string[];
}

/** yyyy-mm-dd as a UTC date; anything else, or a day that does not exist (2027-02-30 would roll to March), is undefined. */
function parseDate(v?: string): Date | undefined {
  const m = v ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? d : undefined;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number) => `$${n.toLocaleString('en-US')}`;

// ---- Speciality matching --------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
// Crude stem so "practice" ~ "practitioners", "cardiologist" ~ "cardiology".
const STOP = new Set(['and', 'or', 'of', 'the', 'with', 'for', 'in']);
const words = (s: string) =>
  new Set(
    norm(s)
      .split(' ')
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map((w) => (w.length > 5 ? w.slice(0, 5) : w)),
  );
/** Some titles carry a long description after the first sentence; match on the name part only. */
const firstLine = (s: string) => (s.split(/\n|\.(?:\s|\.|$)/)[0] ?? '').trim();

/** Sørensen–Dice on character bigrams: tolerant of typos ("Cardiolgy", "Dermatolgy"). */
function dice(a: string, b: string): number {
  const grams = (s: string) => {
    const t = norm(s).replace(/ /g, '');
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const A = grams(a);
  const B = grams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  const total = [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return total ? (2 * overlap) / total : 0;
}

/** Common ways brokers write a speciality → titles used in the rate tables. */
const SYNONYMS: [RegExp, string[]][] = [
  [/\bcardiolog\w*|\bcardiac\b/i, ['Cardiology', 'Cardiovascular Disease']],
  [/\bob\s*[/-]?\s*gyn\w*|\bobstetric\w*/i, ['Obstetrics and Gynecology', 'OB-GYN', 'Obstetrics/Gynecology']],
  [/^\s*gyn(ecolog\w*)?\b/i, ['Gynecology']],
  [/\bent\b|\bear,? nose/i, ['Otolaryngology', 'Otorhinolaryngology']],
  [/\bgi\b|\bgastro\w*/i, ['Gastroenterology']],
  [/\bpeds?\b|\bp(a)?ediatric\w*/i, ['Pediatrics']],
  [/\bortho(p(a)?edic\w*|pedist)?\b/i, ['Orthopedic Surgery']],
  [/\bderm\w*/i, ['Dermatology']],
  [/\bpsych(iatr\w*)?\b/i, ['Psychiatry']],
  [/^\s*(er|ed)\s*$|\bemergency\b/i, ['Emergency Medicine']],
  [/\banesthes(ia|iolog\w*)\b/i, ['Anesthesiology']],
  [/\bcrna\b|\bnurse anesthetist/i, ['Certified Registered Nurse Anesthetist']],
  [/^\s*(a?np|fnp|aprn|arnp)\s*$|\bnurse practitioner/i, ['Nurse Practitioner']],
  [/^\s*pa(-c)?\s*$|\bphysician assistant/i, ['Physician Assistant']],
  [
    /^\s*(gp|fp|pcp)\s*$|\bgeneral practi\w*|\bfamily (practice|physician|doctor|medicine)|\bprimary care/i,
    ['Family Medicine', 'Family Practice', 'Family/General Practice', 'Family Medicine/General Practice', 'FP/GP'],
  ],
  [/^\s*im\s*$|\binternist\b/i, ['Internal Medicine']],
  [/\bneurosurg\w*/i, ['Neurological Surgery']],
  [/^\s*neuro\s*$|\bneurologist\b/i, ['Neurology']],
  [/^\s*rads?\s*$|\bradiologist\b/i, ['Diagnostic Radiology', 'Radiology Diagnostic']],
  [/\bophth?o\b|\bophthalmologist\b|\beye (doctor|surgeon)/i, ['Ophthalmology']],
  [/\burologist\b/i, ['Urology']],
  [/\bhem(atology)?\s*[/-]?\s*onc\w*/i, ['Hematology/Oncology']],
  [/\boncologist\b/i, ['Oncology']],
  [/\bgeneral surgeon\b/i, ['General Surgery']],
  [/\bplastic surgeon\b/i, ['Plastic Surgery']],
  [/\bmidwi\w*|\bcnm\b/i, ['Certified Nurse Midwife']],
  [/\bpain\b/i, ['Pain Management', 'Pain Medicine']],
  [/\bpodiatr\w*|\bdpm\b/i, ['Podiatry']],
  // Practice types brokers name that the tables rate under a related class — offered for selection.
  [/\burgent care\b|\bwalk-?in clinic/i, ['Emergency Medicine', 'Family/General Practice', 'General Practice']],
  [
    /\bmed(?:ical)?[\s-]*spa\b|\baesthetic\w*|\bcosmetic (?:medicine|injectables?)\b|\bbotox\b/i,
    ['Dermatology', 'Cosmetic', 'Plastic Surgery'],
  ],
  [/\bmedical director\w*|\bmedical directorship\b/i, ['Medical Director Only', 'Administrative Medicine']],
  [/\bphlebolog\w*|\bvein (?:care|clinic|center)\b|\bvenous\b/i, ['Vascular Surgery', 'General Surgery']],
  [
    /\bobesity\b|\bweight (?:loss|management)\b|\bbariatric medicine\b|\bmetabolic\b/i,
    ['Internal Medicine', 'Endocrinology', 'Family/General Practice'],
  ],
  [
    /\bhormone\b|\banti-?aging\b|\bwellness\b|\bfunctional medicine\b|\bintegrative\b/i,
    ['Internal Medicine', 'Family/General Practice', 'General Preventive Medicine'],
  ],
  [/\bmedical student\w*|\bnursing student\w*|\bstudent\b/i, ['Medical Students Only']],
  [/\boptometr\w*/i, ['Optometry', 'Ophthalmology']],
  [/\btele(?:medicine|health)\b/i, ['Telemedicine']],
];

interface QueryVariant {
  text: string;
  via: string | null;
  /** Highest score a match through this variant may get: only the text as written can be "exact". */
  cap: number;
}

/**
 * The text as written, NPPES-style comma parts ("Internal Medicine, Cardiovascular Disease" —
 * the specialization after the comma is preferred), and synonyms (also reached through typos).
 */
function queryVariants(title: string): QueryVariant[] {
  const out: QueryVariant[] = [{ text: title, via: null, cap: 100 }];
  const parts = title.split(/\s*[,;]\s*/).filter((p) => p && p !== title);
  parts.forEach((p, i) => out.push({ text: p, via: `part "${p}"`, cap: i === parts.length - 1 ? 90 : 85 }));
  for (const v of [...out]) {
    for (const [re, titles] of SYNONYMS) {
      const typo = !re.test(v.text) && titles.some((t) => dice(v.text, t) >= 0.7);
      if (!re.test(v.text) && !typo) continue;
      for (const t of titles) {
        out.push({
          text: t,
          via: `${typo ? 'typo' : 'synonym'} "${v.text}" → "${t}"`,
          cap: Math.min(v.cap, typo ? 75 : 90),
        });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((v) => !seen.has(norm(v.text)) && seen.add(norm(v.text)));
}

function scoreTitle(query: string, title: string): number {
  const q = norm(query);
  const t = norm(title);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q + ' ') || q.startsWith(t + ' ')) return 80;
  const qw = words(query);
  const tw = words(title);
  const overlap = [...qw].filter((w) => tw.has(w)).length;
  // Every query word is in the title — a strong match only if they make up much of the title
  // ("Pediatrics" vs "Allergy, including pediatric allergy" is not).
  if (qw.size && overlap === qw.size) return overlap / tw.size >= 0.5 ? 60 : 50;
  const jaccard = overlap / (qw.size + tw.size - overlap || 1);
  if (jaccard >= 0.5) return Math.round(jaccard * 70);
  // Typo tolerance: every query word is close to some title word ("Dermatolgy" ~ "Dermatology").
  const qWords = norm(query)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w));
  const tWords = norm(title).split(' ');
  if (qWords.length && qWords.every((w) => tWords.some((t) => dice(w, t) >= 0.7))) return 55;
  const d = dice(query, title);
  return d >= 0.75 ? Math.round(d * 60) : 0;
}

/**
 * Best-matching speciality class in the state. Ranking among good matches (score ≥ 60):
 * state-specific class before the generic "All" class, then the surgery type closest to the one
 * wanted (No Surgery when unstated), then match score, then the shortest (most general) title.
 */
function matchSpeciality(
  ctx: RateContext,
  spec: { code?: string; title?: string; surgeryType?: SurgeryType },
):
  | {
      code: string;
      rows: SpecialityFactorRow[];
      matchedFrom: string;
      exact: boolean;
      alternatives: string[];
      candidates: SpecialityCandidate[];
    }
  | { error: string } {
  const state = ctx.stateCode!;
  const rowsFor = (code: string) => {
    const own = ctx.specialityFactors.filter((r) => r.code === code && r.state === state);
    return own.length ? own : ctx.specialityFactors.filter((r) => r.code === code && r.state === 'All');
  };

  if (spec.code) {
    const rows = rowsFor(spec.code);
    return rows.length
      ? { code: spec.code, rows, matchedFrom: `code ${spec.code}`, exact: true, alternatives: [], candidates: [] }
      : { error: `Speciality code ${spec.code} has no factor for ${state}` };
  }
  if (!spec.title) return { error: 'Speciality title or code is required' };

  const { matched, cands, rank } = rankClasses(ctx, spec.title, spec.surgeryType);
  const short = (t: string) => (t.length > 70 ? t.slice(0, 67) + '…' : t);
  const toCandidate = ([code, c]: [string, Cand]): SpecialityCandidate => ({
    code,
    title: short(c.title),
    score: c.score,
    surgeryTypes: [...c.types],
  });

  if (matched.length === 0) {
    const closest = [...cands.entries()]
      .map(([code, c]) => [code, { ...c, score: Math.round(dice(spec.title!, c.title) * 100) }] as [string, Cand])
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5);
    return {
      error: `No ${state} speciality matches "${spec.title}" — closest: ${closest.map(([code, c]) => `${code} ${short(c.title)}`).join('; ')}. Pick a rate class, or enter a manual factor with a reason.`,
    };
  }

  const top = matched[0];
  if (!top) throw new Error('rankClasses returned no match after the empty case was handled');
  const [bestCode, best] = top;
  const key = (c: Cand) => rank(c).slice(0, 4).join();
  return {
    code: bestCode,
    rows: rowsFor(bestCode),
    matchedFrom: describeMatch(best),
    exact: best.score === 100,
    alternatives: matched
      .slice(1)
      .filter(([, c]) => key(c) === key(best))
      .map(([code, c]) => `${code} ${short(c.title)}`),
    candidates: matched.slice(1, 4).map(toCandidate),
  };
}

type Cand = { score: number; title: string; via: string | null; stateSpecific: boolean; types: Set<string> };

function describeMatch(c: Cand): string {
  const short = (t: string) => (t.length > 70 ? t.slice(0, 67) + '…' : t);
  const how =
    c.score === 100
      ? 'exact title'
      : c.via
        ? c.via
        : c.score >= 80
          ? 'title prefix'
          : c.score >= 60
            ? 'keyword match'
            : 'fuzzy match';
  const target = c.via?.endsWith(`"${c.title}"`) ? '' : ` → "${short(c.title)}"`;
  return `${how}${target} (score ${c.score})`;
}

/** Scores every class in the rate context against a speciality title; `matched` is ranked best first. */
function rankClasses(ctx: RateContext, title: string, surgeryType?: SurgeryType) {
  const state = ctx.stateCode!;
  const variants = queryVariants(title);
  const abbreviation = /^[A-Z]{2,5}$/.test(title.trim()) ? title.trim() : null;
  const cands = new Map<string, Cand>();
  for (const r of ctx.specialityFactors) {
    const name = firstLine(r.title);
    let best = 0;
    let via: string | null = null;
    for (const v of variants) {
      // Matches reached through a synonym or a comma part never count as "exact".
      const s = Math.min(scoreTitle(v.text, name), v.cap);
      if (s > best) [best, via] = [s, v.via];
    }
    if (abbreviation && r.abbreviation === abbreviation && best < 70)
      [best, via] = [70, `abbreviation ${abbreviation}`];
    const c = cands.get(r.code) ?? { score: 0, title: name, via: null, stateSpecific: false, types: new Set<string>() };
    if (best > c.score) [c.score, c.via] = [best, via];
    if (r.state === state) c.stateSpecific = true;
    c.types.add(r.surgeryType);
    cands.set(r.code, c);
  }

  const wantedIdx = SURGERY_TYPES.indexOf(surgeryType ?? 'No Surgery');
  const surgeryDistance = (types: Set<string>) =>
    Math.min(...[...types].map((t) => Math.abs(SURGERY_TYPES.indexOf(t as SurgeryType) - wantedIdx)));
  const rank = (c: Cand) => [
    c.stateSpecific && c.score >= 60 ? 1 : 0,
    c.score >= 60 ? 1 : 0,
    -surgeryDistance(c.types),
    c.score,
    -c.title.length,
  ];
  const matched = [...cands.entries()]
    .filter(([, c]) => c.score > 0)
    .sort((a, b) => {
      const ra = rank(a[1]);
      const rb = rank(b[1]);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return (rb[i] ?? 0) - (ra[i] ?? 0);
      return a[0].localeCompare(b[0]);
    });
  return { matched, cands, rank, state };
}

// ---- Location: ZIP / city → state, city, county -------------------------------------

interface LocationResult {
  inputs: RatingInputs;
  location: NonNullable<QuoteFactors['location']>;
  flags: string[];
}

async function resolveLocation(inputs: RatingInputs): Promise<LocationResult> {
  const out: RatingInputs = { ...inputs };
  const flags: string[] = [];
  let countySource: string | null = out.county ? 'stated' : null;
  let zipCounties: { name: string; share?: number }[] | undefined;

  const zip = out.zip ? await lookupZip(out.zip) : null;
  if (out.zip && !zip) flags.push(`ZIP ${out.zip} not found in the ZIP tables`);
  if (zip) {
    zipCounties = zip.counties;
    if (!out.state) {
      out.state = zip.state;
      flags.push(`State ${zip.state} taken from ZIP ${zip.zip}`);
    } else if (out.state.toUpperCase() !== zip.state) {
      flags.push(
        `ZIP ${zip.zip} is in ${zip.state} but the state given is ${out.state.toUpperCase()} — rated as ${out.state.toUpperCase()}; check the address`,
      );
    }
    if (!out.city && zip.city) out.city = zip.city;
    else if (out.city && zip.city && normKey(out.city) !== normKey(zip.city)) {
      flags.push(`City "${out.city}" differs from ZIP ${zip.zip}'s city "${zip.city}" (mailing names can differ)`);
    }
    const largest = zip.counties[0];
    if (!out.county && largest && zip.state === out.state?.toUpperCase()) {
      out.county = largest.name;
      countySource = `ZIP ${zip.zip}`;
      if (zip.counties.length > 1) {
        flags.push(
          `ZIP ${zip.zip} spans ${zip.counties.map((c) => c.name).join(', ')} — used ${largest.name} (largest area); confirm the street address`,
        );
      }
    } else if (
      out.county &&
      zip.counties.length &&
      !zip.counties.some((c) => normKey(c.name) === normKey(out.county!.replace(/\s+county$/i, '')))
    ) {
      flags.push(
        `County "${out.county}" is not one of ZIP ${zip.zip}'s counties (${zip.counties.map((c) => c.name).join(', ')})`,
      );
    }
  }

  if (!out.county && out.city && out.state) {
    const city = await lookupCity(out.city, out.state);
    const largestCity = city.counties[0];
    if (largestCity) {
      out.county = largestCity.name;
      countySource = `city ${out.city}, ${out.state.toUpperCase()}`;
      if (city.counties.length > 1) {
        flags.push(
          `${out.city}, ${out.state.toUpperCase()} spans counties ${city.counties.map((c) => `${c.name} (${c.zipCount} ZIPs)`).join(', ')} — used ${out.county}; a ZIP code would settle it`,
        );
      }
    }
  }

  return {
    inputs: out,
    location: {
      zip: zip?.zip ?? out.zip ?? null,
      city: out.city ?? null,
      state: out.state?.toUpperCase() ?? null,
      county: out.county ?? null,
      countySource,
      zipCounties,
    },
    flags,
  };
}

// ---- Pricing ----------------------------------------------------------------------------

/** Pure: prices inputs against an already-loaded rate context. */
export function calculateQuote(inputs: RatingInputs, ctx: RateContext): QuoteResult {
  const flags: string[] = [];
  const missing: string[] = [];
  const factors: QuoteFactors = {};
  const state = ctx.stateCode;
  // A base rate or factor of 0 / negative / NaN is bad rate data: treated as missing so it can never price a $0 QUOTED.
  const usable = (n: number | undefined | null): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const stateRow = ctx.state && usable(ctx.state.baseRate) ? ctx.state : null;

  if (!state) missing.push('State (risk state of the practice) — or a ZIP code');
  else if (ctx.state && !stateRow)
    missing.push(`Base rate for ${state} (rate table value ${ctx.state.baseRate} is not usable)`);
  else if (!stateRow) missing.push(`State ${state} is not in the rate tables (rated: ${ctx.ratedStates.join(', ')})`);
  else {
    factors.state = {
      state: stateRow.state,
      baseRate: stateRow.baseRate,
      domicileTaxRate: stateRow.domicileTaxRate,
      stateTaxRate: stateRow.stateTaxRate,
      defense: stateRow.defense,
    };
  }

  // Dates + step-up
  let effective = parseDate(inputs.effectiveDate);
  if (!effective) {
    const now = new Date();
    effective = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    flags.push(`Effective date not stated — assumed ${iso(effective)} (1st of next month)`);
  }
  // A blank retro date means no prior acts: priced as the effective date (step-up year 1) and flagged to confirm.
  let retro = parseDate(inputs.retroDate);
  if (!retro) {
    retro = effective;
    flags.push(RETRO_DEFAULT_FLAG);
  } else if (retro > effective) {
    flags.push(`Retro date ${iso(retro)} is after the effective date ${iso(effective)}`);
    missing.push(`Valid retro date — ${iso(retro)} is after the effective date ${iso(effective)}`);
  }
  // Expiration: as stated when after the effective date, else effective + 1 year.
  const oneYear = new Date(Date.UTC(effective.getUTCFullYear() + 1, effective.getUTCMonth(), effective.getUTCDate()));
  const statedExpiration = parseDate(inputs.expirationDate);
  let expiration = oneYear;
  if (!statedExpiration) {
    flags.push(`Expiration date not stated — 1 year after the effective date (${iso(oneYear)})`);
  } else if (statedExpiration <= effective) {
    flags.push(
      `Expiration date ${iso(statedExpiration)} is not after the effective date — used 1 year after the effective date (${iso(oneYear)})`,
    );
  } else {
    expiration = statedExpiration;
    if (iso(statedExpiration) !== iso(oneYear)) {
      flags.push(
        `Non-annual policy term (${iso(effective)} → ${iso(statedExpiration)}) — priced as an annual premium, not pro-rated; underwriter to review`,
      );
    }
  }
  const years = retroYears(retro, effective);
  factors.dates = {
    effectiveDate: iso(effective),
    expirationDate: iso(expiration),
    retroDate: iso(retro),
    retroYears: years,
  };
  if (stateRow) {
    factors.stepUp = stepUpFactor(ctx.stepUp, years);
    if (!usable(factors.stepUp)) missing.push(`Step-up table for ${state}`);
    else factors.dates.stepUpYear = ctx.stepUp.has(years) ? years : Math.max(...ctx.stepUp.keys());
  }

  // Specialities
  if (!inputs.specialities?.length) missing.push('Speciality');
  else if (stateRow) {
    const resolved: NonNullable<QuoteFactors['specialities']> = [];
    for (const spec of inputs.specialities) {
      // An underwriter's factor, for a specialty no rate class matches exactly. An exact match always takes the table.
      if (spec.manualFactor !== undefined) {
        const title = spec.title ?? '';
        const exact = matchSpeciality(ctx, { title, surgeryType: spec.surgeryType });
        if (!('error' in exact) && exact.exact) {
          missing.push(
            `Specialty "${title}" matches ${exact.code} ${firstLine(exact.rows[0]!.title)} exactly, so it takes the rate table's factor — remove the manual factor`,
          );
          continue;
        }
        const reason = spec.manualReason ?? '';
        flags.push(
          `Manual factor ${spec.manualFactor} for specialty "${title}" (not matched in the ${state} rate tables): ${reason}`,
        );
        resolved.push({
          requested: title,
          code: MANUAL_CODE,
          title,
          surgeryType: spec.surgeryType ?? 'Not stated',
          specialityClass: spec.manualFactor,
          practicePercent: spec.practicePercent ?? (inputs.specialities.length === 1 ? 100 : 0),
          factorState: 'Manual',
          matchedFrom: `manual factor: ${reason}`,
          manual: { reason },
        });
        continue;
      }
      const match = matchSpeciality(ctx, spec);
      if ('error' in match) {
        missing.push(match.error);
        continue;
      }
      if (!match.exact)
        flags.push(
          `Speciality "${spec.title ?? spec.code}" → ${match.code} by ${match.matchedFrom} — confirm the class`,
        );
      if (match.alternatives.length)
        flags.push(`Speciality "${spec.title}" also matches: ${match.alternatives.join('; ')}`);
      let row = spec.surgeryType ? match.rows.find((r) => r.surgeryType === spec.surgeryType) : undefined;
      if (spec.surgeryType && !row) {
        // A stated surgery type is never swapped for another (usually cheaper) class: the underwriter picks one.
        const available = match.rows.map((r) => r.surgeryType).join(', ');
        const classTitle = firstLine(match.rows[0]?.title ?? match.code);
        flags.push(`${classTitle} is not rated for ${spec.surgeryType} in ${state}; available: ${available}`);
        missing.push(
          `Surgery type ${spec.surgeryType} not rated for ${match.code} ${classTitle} in ${state} (available: ${available}) — choose a class`,
        );
      }
      if (!row) {
        row = SURGERY_TYPES.map((st) => match.rows.find((r) => r.surgeryType === st)).find(Boolean)!;
        if (!spec.surgeryType) {
          flags.push(
            row.surgeryType === 'No Surgery'
              ? `Surgery type not stated for ${firstLine(row.title)} — used No Surgery`
              : `Surgery type not stated and ${firstLine(row.title)} has no "No Surgery" class in ${state} — used ${row.surgeryType} (${row.factor}). Confirm with the broker.`,
          );
        }
      }
      if (row.state === 'All')
        flags.push(`${firstLine(row.title)}: no ${state}-specific class, used the "All" states class`);
      if (!usable(row.factor))
        missing.push(
          `Speciality class for ${row.code} ${row.surgeryType} (rate table value ${row.factor} is not usable)`,
        );
      resolved.push({
        requested: spec.title ?? spec.code ?? '',
        code: row.code,
        title: row.title,
        surgeryType: row.surgeryType,
        specialityClass: row.factor,
        practicePercent: spec.practicePercent ?? (inputs.specialities.length === 1 ? 100 : 0),
        factorState: row.state,
        matchedFrom: match.matchedFrom,
        candidates: match.candidates,
      });
    }
    if (resolved.length) {
      const pctTotal = resolved.reduce((s, r) => s + r.practicePercent, 0);
      if (!inputs.pickHighest && Math.abs(pctTotal - 100) > 1e-9) {
        missing.push(`Practice % across specialities must total 100 (got ${pctTotal}); or set pickHighest`);
      }
      factors.specialities = resolved;
      factors.speciality = specialityFactor(resolved, inputs.pickHighest ?? false);
    }
  }

  // Territory (county → territory, else "Remainder of State")
  if (stateRow) {
    const county = inputs.county?.replace(/\s+county$/i, '').trim() || null;
    const byCounty = county
      ? ctx.territories.find((t) => t.counties.some((c) => normKey(c) === normKey(county)))
      : undefined;
    const remainder = ctx.territories.find((t) => t.isRemainder);
    const row = byCounty ?? remainder;
    if (!row)
      missing.push(
        `Territory for ${state}${county ? ` county ${county}` : ''} (no county match and no "Remainder of State" row)`,
      );
    else {
      if (!usable(row.factor))
        missing.push(`Territory ${row.territory} factor for ${state} (rate table value ${row.factor} is not usable)`);
      factors.territory = {
        territory: row.territory,
        factor: row.factor,
        county,
        matched: byCounty ? 'county' : 'remainder',
      };
      if (!county)
        flags.push(
          `County unknown — used ${state} "Remainder of State" territory ${row.territory} (factor ${row.factor}). A ZIP code would settle it.`,
        );
    }
  }

  // Limits (ILF/DLF). Only limits not stated at all fall back to the state default; a stated limit the table
  // does not offer (or offers with another aggregate) is never priced as a different one.
  if (stateRow) {
    const rows = ctx.limits;
    const pair = (inc: number, agg: number | undefined) => `${money(inc)}/${agg === undefined ? '?' : money(agg)}`;
    const offered = rows.map((r) => pair(r.incidentLimit, r.aggregateLimit)).join(', ');
    let row = inputs.limitKey ? rows.find((r) => r.key === inputs.limitKey) : undefined;
    if (!row && inputs.limit) {
      const { incident, aggregate } = inputs.limit;
      row =
        rows.find((r) => r.incidentLimit === incident && r.aggregateLimit === aggregate) ??
        rows.find((r) => r.incidentLimit === incident);
      if (row && aggregate && row.aggregateLimit !== aggregate) {
        flags.push(
          `Limit ${pair(incident, aggregate)} matched on per-incident only; table row is ${pair(row.incidentLimit, row.aggregateLimit)} — check the ILF/DLF data`,
        );
        missing.push(
          `Coverage limit — ${pair(incident, aggregate)} requested, the ${state} table has ${pair(row.incidentLimit, row.aggregateLimit)}; confirm the aggregate`,
        );
      }
      if (!row) {
        flags.push(`Requested limit ${pair(incident, aggregate)} is not offered in ${state} (offered: ${offered})`);
        missing.push(
          `Coverage limit — ${pair(incident, aggregate)} is not offered in ${state}; choose an offered limit`,
        );
      }
    } else if (!row && inputs.limitKey) {
      missing.push(`Coverage limit — ${inputs.limitKey} is not a ${state} limit (offered: ${offered})`);
    } else if (!row) {
      row = rows.find((r) => r.isDefault);
      if (row) flags.push(`Limits not stated — used ${state} default ${pair(row.incidentLimit, row.aggregateLimit)}`);
      else missing.push(`Coverage limit for ${state}`);
    }
    if (row && !usable(row.factor))
      missing.push(`Limit factor for ${state} ${row.key} (rate table value ${row.factor} is not usable)`);
    if (row && row.aggregateLimit < row.incidentLimit) {
      missing.push(
        `Coverage limit — ${state} table row ${row.key} ${pair(row.incidentLimit, row.aggregateLimit)} has an aggregate below the per-incident limit (bad ILF/DLF data)`,
      );
    }
    if (row)
      factors.limits = {
        key: row.key,
        incidentLimit: row.incidentLimit,
        aggregateLimit: row.aggregateLimit,
        factor: row.factor,
      };
  }

  // FTE / hours worked
  {
    let row = inputs.hoursWorkedKey ? ctx.hours.find((r) => r.key === inputs.hoursWorkedKey) : undefined;
    if (!row && inputs.hoursPerWeek !== undefined) row = ctx.hours.find((r) => inputs.hoursPerWeek! <= r.maxHours);
    if (!row) {
      row = ctx.hours.find((r) => r.isDefault);
      if (row) flags.push(`Weekly hours not stated — used default "${row.title}" (factor ${row.factor})`);
    }
    if (!row) missing.push('Hours worked factor');
    else if (!usable(row.factor))
      missing.push(`Hours worked factor "${row.title}" (rate table value ${row.factor} is not usable)`);
    if (row) factors.fte = { key: row.key, title: row.title, factor: row.factor };
  }

  // Scheduled credits / debits
  const credits = (inputs.scheduledCreditKeys ?? [])
    .map((key) => {
      const row = ctx.credits.find((c) => c.key === key);
      if (!row) missing.push(`Unknown scheduled credit/debit ${key}`);
      return row;
    })
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  factors.scheduledCredits = credits.map((c) => ({
    key: c.key,
    title: c.title,
    percent: c.percent,
    type: c.type,
    deductibleLabel: c.deductibleLabel,
  }));
  factors.deductible = credits.find((c) => /deductible/i.test(c.type))?.deductibleLabel || null;
  if (credits.filter((c) => /deductible/i.test(c.type)).length > 1)
    flags.push('More than one deductible-type credit selected');

  // Rating fees: required for the state (or "All") + optional ones selected
  if (state) {
    const chosen = ctx.ratingFees.filter((f) => f.required || inputs.optionalFeeKeys?.includes(f.key));
    for (const key of inputs.optionalFeeKeys ?? []) {
      if (!ctx.ratingFees.some((f) => f.key === key))
        flags.push(`Rating fee ${key} does not apply to ${state} — ignored`);
    }
    factors.ratingFees = chosen.map((f) => {
      const entered = inputs.feeAmounts?.[f.key];
      // Flat fees are money: cents, so the stored fee and the priced fee are the same number.
      const amount = f.calculate
        ? f.amountOrPercent
        : round2(f.allowEdit && entered && entered > 0 ? entered : f.amountOrPercent);
      return {
        key: f.key,
        title: f.title,
        calculate: f.calculate,
        amount,
        required: f.required,
        state: f.state,
        ...(f.earnPercent != null ? { earnPercent: f.earnPercent } : {}),
      };
    });
  }

  // Policy (coverage) fees: submission-level, required ones
  factors.policyFees = ctx.policyFees
    .filter((f) => f.required)
    .map((f) => ({
      key: f.key,
      title: f.title,
      amount: round2(f.amount),
      ...(f.earnPercent != null ? { earnPercent: f.earnPercent } : {}),
    }));

  const base = { rateGroup: ctx.rateGroup, inputs, factors, flags, missing };
  if (missing.length || !stateRow) return { ...base, status: 'INCOMPLETE', pricing: null, summary: null };

  const pricing = priceRating({
    baseRate: stateRow.baseRate,
    specialityFactor: factors.speciality!,
    stepUpFactor: factors.stepUp!,
    territoryFactor: factors.territory!.factor,
    limitsFactor: factors.limits!.factor,
    fteFactor: factors.fte!.factor,
    scheduled: credits.map((c) => ({ title: c.title, percent: c.percent })),
    uwCreditPercent: inputs.uwCreditPercent ?? 0,
    ratingFees: (factors.ratingFees ?? []).map((f) => ({ title: f.title, calculate: f.calculate, amount: f.amount })),
    domicileState: config.DOMICILE_STATE,
    domicileTaxPercent: stateRow.domicileTaxRate,
    state: stateRow.state,
    stateTaxPercent: stateRow.stateTaxRate,
    policyFeesTotal: (factors.policyFees ?? []).reduce((s, f) => s + f.amount, 0),
  });

  return {
    ...base,
    status: 'QUOTED',
    pricing,
    summary: {
      premium: round2(pricing.premium),
      ratingFees: round2(pricing.ratingFeesTotal),
      taxes: round2(pricing.taxTotal),
      policyFees: round2(pricing.policyFeesTotal),
      total: round2(pricing.total),
      combineTotal: round2(pricing.combineTotal),
    },
  };
}

/** Resolves location from ZIP/city, loads only the rate rows this state needs, and prices. */
export async function priceInputs(inputs: RatingInputs, rateGroup?: string): Promise<QuoteResult> {
  const group = rateGroup ?? (await activeRateGroup());
  const loc = await resolveLocation(inputs);
  const ctx = await loadRateContext(group, loc.inputs.state);
  const result = calculateQuote(loc.inputs, ctx);
  result.factors.location = loc.location;
  result.flags.unshift(...loc.flags);

  // A ZIP spanning counties in different territories changes the price: say so explicitly.
  if (loc.location.zipCounties && loc.location.zipCounties.length > 1 && result.factors.territory) {
    const others = loc.location.zipCounties.slice(1).flatMap((c) => {
      const t =
        ctx.territories.find((tr) => tr.counties.some((n) => normKey(n) === normKey(c.name))) ??
        ctx.territories.find((tr) => tr.isRemainder);
      return t && t.factor !== result.factors.territory!.factor
        ? [`${c.name} → territory ${t.territory} (×${t.factor})`]
        : [];
    });
    if (others.length) result.flags.push(`Other counties in this ZIP rate differently: ${others.join('; ')}`);
  }
  return result;
}

/**
 * A submission keeps the rate group it was first quoted with, while that group exists. Group names carry a hash of
 * the workbooks (importer.ts), so a kept group still has the rates its earlier quotes were priced with.
 */
async function submissionRateGroup(
  submissionId: string,
): Promise<{ rateGroup: string; previous: string | null; active: string | null }> {
  const { rows } = await pool.query(
    'SELECT rate_group FROM single_rating WHERE submission_id=$1 ORDER BY version DESC LIMIT 1',
    [submissionId],
  );
  const previous: string | null = rows[0]?.rate_group ?? null;
  if (!previous || !(await rateGroupExists(previous))) {
    const active = await activeRateGroup();
    return { rateGroup: active, previous, active };
  }
  // No active group is a valid answer here (the quote keeps its own); any other failure (the database) is not.
  const active = await activeRateGroup().catch((err: unknown) => {
    if (err instanceof RatesNotLoadedError) return null;
    throw err;
  });
  return { rateGroup: previous, previous, active };
}

/**
 * Where each input came from: the derived source when the underwriter kept the value, "underwriter" when it was
 * changed in the quote dialog.
 */
export async function inputSources(submissionId: string, inputs: RatingInputs): Promise<Record<string, string>> {
  const derived = await deriveRatingInputs(submissionId);
  const sources: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (v === undefined) continue;
    const same = JSON.stringify(v) === JSON.stringify(derived.inputs[k as keyof RatingInputs]);
    sources[k] = same && derived.sources[k] ? derived.sources[k]! : 'underwriter';
  }
  if (
    derived.sources.surgeryType &&
    JSON.stringify(inputs.specialities) === JSON.stringify(derived.inputs.specialities)
  ) {
    sources.surgeryType = derived.sources.surgeryType;
  }
  return sources;
}

const RETRO_DEFAULT_FLAG =
  'Retro date not stated — same as the effective date (step-up year 1, no prior acts); confirm it, as an earlier retro date raises the premium';

/** The flag a defaulted date leaves on a quote, and the source the dialog shows for it. */
const DATE_DEFAULT_FLAGS = {
  effectiveDate: ['Effective date not stated', DEFAULT_EFFECTIVE_SOURCE],
  retroDate: ['Retro date not stated', DEFAULT_RETRO_SOURCE],
  expirationDate: ['Expiration date not stated', DEFAULT_EXPIRATION_SOURCE],
} as const;

/**
 * Prefill for editing a saved quote: its inputs as the underwriter stated them, not as the engine resolved them.
 * Dates it defaulted keep a "default" source (so, unchanged, they are recomputed), a county it took from the ZIP or
 * city is left out (so a changed ZIP rates in its own territory), and `rateGroup` is the group a save prices with.
 */
export async function editInputs(
  submissionId: string,
  quoteId: string,
): Promise<{ inputs: RatingInputs; sources: Record<string, string>; rateGroup: string } | null> {
  const [q] = await loadQuotes({ id: quoteId });
  if (
    !q ||
    !(await pool.query('SELECT 1 FROM single_rating WHERE id=$1 AND submission_id=$2', [quoteId, submissionId]))
      .rowCount
  )
    return null;
  const inputs: RatingInputs = structuredClone(q.inputs);
  if (q.label) inputs.label = q.label;
  else delete inputs.label;
  const countySource = q.factors.location?.countySource;
  if (countySource && countySource !== 'stated') delete inputs.county;
  if (inputs.state && q.flags.some((f) => f.startsWith(`State ${inputs.state} taken from ZIP`))) delete inputs.state;
  const sources: Record<string, string> = Object.fromEntries(
    Object.keys(inputs).map((k) => [k, `quote v${q.version}`]),
  );
  for (const [k, [flag, source]] of Object.entries(DATE_DEFAULT_FLAGS)) {
    if (inputs[k as keyof typeof DATE_DEFAULT_FLAGS] && q.flags.some((f) => f.startsWith(flag))) sources[k] = source;
  }
  return { inputs, sources, rateGroup: (await submissionRateGroup(submissionId)).rateGroup };
}

/** Prices the inputs for a submission without saving anything. */
export async function previewQuote(
  submissionId: string,
  inputs: RatingInputs,
): Promise<QuoteResult & { sources: Record<string, string> }> {
  const sources = await inputSources(submissionId, inputs);
  const priced = { ...inputs };
  applyDateDefaults(priced, sources);
  const { rateGroup, previous, active } = await submissionRateGroup(submissionId);
  const result = await priceInputs(priced, rateGroup);
  if (sources.effectiveDate?.startsWith('default'))
    result.flags.push(`${DATE_DEFAULT_FLAGS.effectiveDate[0]}: assumed ${priced.effectiveDate} (1st of next month)`);
  if (sources.retroDate?.startsWith('default')) result.flags.push(RETRO_DEFAULT_FLAG);
  if (sources.expirationDate?.startsWith('default'))
    result.flags.push(
      `${DATE_DEFAULT_FLAGS.expirationDate[0]}: 1 year after the effective date (${priced.expirationDate})`,
    );
  if (previous && previous !== rateGroup)
    result.flags.push(`Earlier quotes used rate group ${previous}, which no longer exists; priced with ${rateGroup}`);
  else if (previous && active && active !== rateGroup) {
    result.flags.push(
      `Priced with rate group ${rateGroup}, as this submission's earlier quotes; newer rates (${active}) are active for new submissions`,
    );
  }
  return { ...result, sources };
}

/** Two saves racing for the same next version: retried a few times, then reported as a conflict (HTTP 409). */
export class QuoteConflictError extends Error {}

/**
 * Prices the underwriter's inputs and stores them as the submission's next quote version. With `basedOn` (the
 * saved quote being edited) it is audited as a revision and, when priced and that quote is still primary at save
 * time, becomes primary instead.
 */
/** The specialties an underwriter rated with their own factor, for the audit trail. */
const manualFactors = (r: { factors: QuoteFactors }) =>
  (r.factors.specialities ?? [])
    .filter((s) => s.manual)
    .map((s) => ({ specialty: s.requested, factor: s.specialityClass, reason: s.manual!.reason }));

export async function createQuote(
  submissionId: string,
  inputs: RatingInputs,
  actorId: string | null,
  basedOn?: { id: string; version: number },
): Promise<string> {
  const result = await previewQuote(submissionId, inputs);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(async (db) => {
        const q = await saveRating(db, submissionId, inputs.label ?? null, result, actorId);
        if (basedOn && result.status === 'QUOTED') {
          const moved = await db.query(
            'UPDATE submissions SET primary_rating_id=$2 WHERE id=$1 AND primary_rating_id=$3',
            [submissionId, q.id, basedOn.id],
          );
          if (moved.rowCount) await syncCoverageFees(db, submissionId, q.id);
        }
        await audit(
          {
            action: basedOn ? 'QUOTE_REVISED' : 'QUOTE_CREATED',
            entityType: 'quote',
            entityId: q.id,
            submissionId,
            actorId,
            details: {
              version: q.version,
              status: result.status,
              rateGroup: result.rateGroup,
              premium: result.summary?.premium ?? null,
              total: result.summary?.total ?? null,
              missing: result.missing,
              ...(manualFactors(result).length && { manualFactors: manualFactors(result) }),
              ...(basedOn && { basedOnId: basedOn.id, basedOnVersion: basedOn.version }),
            },
          },
          db,
        );
        return q.id;
      });
    } catch (err) {
      const versionTaken =
        (err as { code?: string; constraint?: string }).code === '23505' &&
        (err as { constraint?: string }).constraint === 'single_rating_submission_id_version_key';
      if (!versionTaken) throw err;
      if (attempt >= 3)
        throw new QuoteConflictError('Another quote was saved for this submission at the same time; try again');
    }
  }
}

/**
 * Prices the underwriter's inputs and saves them over an existing quote: same id and version, audited as an update
 * with the totals it replaced. Returns false when the quote is not this submission's (nothing is saved).
 */
export async function updateQuote(
  submissionId: string,
  quoteId: string,
  inputs: RatingInputs,
  actorId: string,
): Promise<boolean> {
  const result = await previewQuote(submissionId, inputs);
  return withTransaction(async (db) => {
    const q = await overwriteRating(db, submissionId, quoteId, inputs.label ?? null, result, actorId);
    if (!q) return false;
    await audit(
      {
        action: 'QUOTE_UPDATED',
        entityType: 'quote',
        entityId: quoteId,
        submissionId,
        actorId,
        details: {
          version: q.version,
          status: result.status,
          rateGroup: result.rateGroup,
          premium: result.summary?.premium ?? null,
          total: result.summary?.total ?? null,
          missing: result.missing,
          ...(manualFactors(result).length && { manualFactors: manualFactors(result) }),
          previous: q.before,
        },
      },
      db,
    );
    return true;
  });
}

export interface SpecialityOption {
  rank: number;
  code: string;
  title: string;
  /** Rest of the class wording (what is included / excluded), when the table has it. */
  description: string | null;
  surgeryType: SurgeryType;
  specialityClass: number;
  factorState: string;
  score: number;
  matchedFrom: string;
  /** The class + surgery type the automatic quote picks. */
  recommended: boolean;
  /** Cheapest option among good matches (score ≥ 60). */
  lowestPremium: boolean;
  /** No real match: offered only because the wording is closest — choose by hand, with care. */
  weak: boolean;
  quote: { status: QuoteResult['status']; premium: number | null; total: number | null; missing: string[] };
}

/**
 * Ranks the state's speciality classes against a submission's speciality (or `title`) and prices
 * each class × surgery type with the submission's other inputs — nothing is saved. Pick one and
 * save it as `specialities[index] = {code, surgeryType}` to quote it.
 */
export async function specialityOptions(
  submissionId: string,
  inputs: RatingInputs,
  opts: { title?: string; index?: number; limit?: number } = {},
): Promise<{
  state: string | null;
  requested: string | null;
  index: number;
  rateGroup: string;
  options: SpecialityOption[];
  note?: string;
}> {
  const index = opts.index ?? 0;
  const current = inputs.specialities?.[index];
  const requested = opts.title ?? current?.title ?? null;
  const { rateGroup } = await submissionRateGroup(submissionId);
  const loc = await resolveLocation(inputs);
  const ctx = await loadRateContext(rateGroup, loc.inputs.state);
  const base = { state: ctx.stateCode, requested, index, rateGroup, options: [] as SpecialityOption[] };
  if (!ctx.state)
    return {
      ...base,
      note: ctx.stateCode
        ? `State ${ctx.stateCode} is not in the rate tables`
        : 'State unknown — add a ZIP or state first',
    };
  if (!requested) return { ...base, note: 'No speciality on the submission — pass ?title=' };

  const { matched, cands } = rankClasses(ctx, requested, current?.surgeryType);
  // Nothing scored: offer the closest titles so a class can still be chosen by hand.
  const ranked: [string, Cand][] = matched.length
    ? matched
    : [...cands.entries()]
        .map(
          ([code, c]) =>
            [code, { ...c, score: Math.round(dice(requested, c.title) * 50), via: 'closest wording' }] as [
              string,
              Cand,
            ],
        )
        .sort((a, b) => b[1].score - a[1].score);
  const auto = calculateQuote(
    {
      ...loc.inputs,
      specialities: [{ title: requested, ...(current?.surgeryType ? { surgeryType: current.surgeryType } : {}) }],
    },
    ctx,
  ).factors.specialities?.[0];

  const options: SpecialityOption[] = [];
  for (const [code, c] of ranked.slice(0, opts.limit ?? 6)) {
    const own = ctx.specialityFactors.filter((r) => r.code === code && r.state === ctx.stateCode);
    const rows = own.length ? own : ctx.specialityFactors.filter((r) => r.code === code && r.state === 'All');
    for (const row of [...rows].sort(
      (a, b) => SURGERY_TYPES.indexOf(a.surgeryType) - SURGERY_TYPES.indexOf(b.surgeryType),
    )) {
      const specialities = [...(loc.inputs.specialities ?? [])];
      specialities[index] = {
        code,
        surgeryType: row.surgeryType,
        practicePercent: current?.practicePercent ?? (specialities.length > 1 ? undefined : 100),
      };
      const q = calculateQuote({ ...loc.inputs, specialities }, ctx);
      const [name, ...rest] = row.title.split(/\.\.?\s+|\n/);
      options.push({
        rank: options.length + 1,
        code,
        title: firstLine(row.title) || (name ?? row.title),
        description: rest.join(' ').trim() || null,
        surgeryType: row.surgeryType,
        specialityClass: row.factor,
        factorState: row.state,
        score: c.score,
        matchedFrom: describeMatch(c),
        recommended: auto?.code === code && auto.surgeryType === row.surgeryType,
        lowestPremium: false,
        weak: c.score < 60,
        quote: {
          status: q.status,
          premium: q.summary?.premium ?? null,
          total: q.summary?.total ?? null,
          missing: q.missing,
        },
      });
    }
  }
  const good = options.filter((o) => o.score >= 60 && o.quote.total !== null);
  const cheapest = good.sort((a, b) => a.quote.total! - b.quote.total!)[0];
  if (cheapest) cheapest.lowestPremium = true;
  const note = !matched.length
    ? `No ${ctx.stateCode} class matches "${requested}" — these are only the closest wording. Pick one by hand or ask the broker how the practice is rated.`
    : options.every((o) => o.weak)
      ? `Only weak matches for "${requested}" in ${ctx.stateCode} — confirm the class with the broker.`
      : undefined;
  return { ...base, options, ...(note ? { note } : {}) };
}

/** Dropdown data for the UI and the Claude skill — queried per state. */
export async function rateOptions(state?: string, rateGroup?: string) {
  const group = rateGroup ?? (await activeRateGroup());
  const ctx = await loadRateContext(group, state);
  const base = {
    rateGroup: group,
    states: ctx.ratedStates,
    surgeryTypes: SURGERY_TYPES,
    hours: ctx.hours.map((h) => ({ key: h.key, title: h.title, factor: h.factor, isDefault: h.isDefault })),
    scheduledCredits: ctx.credits,
    policyFees: ctx.policyFees,
  };
  if (!ctx.stateCode) return base;
  const codes = new Map<string, { code: string; title: string; surgeryTypes: string[] }>();
  for (const r of ctx.specialityFactors) {
    const entry = codes.get(r.code) ?? { code: r.code, title: firstLine(r.title), surgeryTypes: [] };
    if (!entry.surgeryTypes.includes(r.surgeryType)) entry.surgeryTypes.push(r.surgeryType);
    codes.set(r.code, entry);
  }
  return {
    ...base,
    state: ctx.state,
    stepUp: Object.fromEntries(ctx.stepUp),
    limits: ctx.limits,
    territories: ctx.territories,
    ratingFees: ctx.ratingFees,
    specialities: [...codes.values()].sort((a, b) => a.title.localeCompare(b.title)),
  };
}

/**
 * The primary rating (else the latest quote), for the Underwriting Analysis and workspace chat. Not part of the
 * Synthesis evidence: a quote is the underwriter's pricing, not a fact the submission states.
 */
export async function quoteContext(submissionId: string): Promise<string> {
  const quotes = await loadQuotes({ submissionId });
  const m = quotes.find((x) => x.isPrimary) ?? quotes[0];
  if (!m) return '<underwriter_quote>No quote has been created yet.</underwriter_quote>';
  const f = m.factors;
  const money = (n: number | null | undefined) =>
    n == null ? 'n/a' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const lines = [
    `Quote v${m.version}${m.label ? ` "${m.label}"` : ''}${m.isPrimary ? ' (primary rating)' : ''}: ${m.status}, created by ${m.createdBy?.name ?? 'the system (automatic)'} on ${m.createdAt.slice(0, 10)} with rate group ${m.rateGroup}`,
    `- Premium ${money(m.premium)}; total with taxes and fees ${money(m.total)}`,
    f.location &&
      `- Location: ${[f.location.city, f.location.county && `${f.location.county} County`, f.location.state, f.location.zip].filter(Boolean).join(', ')}`,
    f.territory &&
      `- Territory ${f.territory.territory} (factor ${f.territory.factor}, matched by ${f.territory.matched})`,
    ...(f.specialities ?? []).map((s) =>
      s.code === MANUAL_CODE
        ? `- Specialty "${s.requested}" rated with a manual factor ${s.specialityClass} (no rate class matched; ${s.matchedFrom.replace(/^manual factor: /, 'reason: ')}), ${s.practicePercent}% of practice`
        : `- Specialty "${s.requested}" rated as ${s.code} ${s.title.split(/\n|\.\s/)[0]} / ${s.surgeryType}, class ${s.specialityClass}, ${s.practicePercent}% of practice`,
    ),
    f.dates &&
      `- Effective ${f.dates.effectiveDate} to ${f.dates.expirationDate}; retro ${f.dates.retroDate} (step-up year ${f.dates.retroYears}, factor ${f.stepUp ?? 'n/a'})`,
    f.limits &&
      `- Limits ${money(f.limits.incidentLimit)} / ${money(f.limits.aggregateLimit)} (factor ${f.limits.factor})`,
    f.fte && `- Hours worked: ${f.fte.title} (factor ${f.fte.factor})`,
    f.scheduledCredits?.length &&
      `- Scheduled credits/debits: ${f.scheduledCredits.map((c) => `${c.title} ${c.percent}%`).join(', ')}`,
    m.inputs?.uwCreditPercent && `- Underwriter credit/debit: ${m.inputs.uwCreditPercent}%`,
    m.flags.length && `- Flags: ${m.flags.join(' | ')}`,
    m.missing.length && `- Missing for pricing: ${m.missing.join(' | ')}`,
  ].filter(Boolean);
  // Each step of the formula (FORMULA.md), so the model can explain the premium rather than restate it.
  const p = m.pricing;
  const pct = (n: number) => `${n > 0 ? '+' : ''}${n}%`;
  const calc =
    p &&
    [
      'Calculation:',
      `- Speciality factor ${f.speciality}${m.inputs?.pickHighest ? ' (pick highest class)' : ' (Σ practice% × class)'}`,
      `- Base modifier total ${p.baseModifierTotal} = speciality ${f.speciality} × step-up ${f.stepUp} × territory ${f.territory?.factor} × limits ${f.limits?.factor} × FTE ${f.fte?.factor}`,
      `- Scheduled premium ${money(p.scheduledPremium)} = ${f.state?.state} base rate ${money(f.state?.baseRate)} × ${p.baseModifierTotal}`,
      ...p.scheduled.map((c) => `- ${c.title}: ${c.percent == null ? 'flat' : pct(c.percent)} = ${money(c.amount)}`),
      p.uwCredit.percent !== 0 && `- Underwriter credit/debit ${pct(p.uwCredit.percent)} = ${money(p.uwCredit.amount)}`,
      `- Premium ${money(p.premium)} = scheduled premium ${money(p.scheduledPremium)} + credits/debits ${money(p.creditTotal)}`,
      ...p.ratingFees.map((fe) => `- Rating fee ${fe.title}: ${money(fe.amount)}`),
      ...p.taxes.map((t) => `- ${t.label} on premium: ${money(t.amount)}`),
      `- Policy fees ${money(p.policyFeesTotal)}`,
      `- Total ${money(p.total)} = premium + taxes ${money(p.taxTotal)} + policy fees + rating fees ${money(p.ratingFeesTotal)}`,
    ].filter(Boolean);
  const others =
    quotes.length > 1
      ? [
          `Other saved versions: ${quotes
            .filter((x) => x !== m)
            .map((x) => `v${x.version} ${x.status}${x.premium == null ? '' : ` ${money(x.premium)}`}`)
            .join(', ')}`,
        ]
      : [];
  return `<underwriter_quote>\n${[...lines, ...(calc || []), ...others].join('\n')}\n</underwriter_quote>`;
}
