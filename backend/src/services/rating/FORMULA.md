# Rating formula

How a quote is priced. Ported from the Submission-Intake project (`.claude/skills/rating-calculation/references/formula.md`)
and adjusted to how this repo behaves; where the two differ, this file and the code win.

| Piece                                                               | File                                     |
| ------------------------------------------------------------------- | ---------------------------------------- |
| Formula (pure, unit-tested)                                         | `calc.ts`, `tests/ratingCalc.test.ts`    |
| Rate tables (imported from `data/rates/*.xlsx` per rate group)      | `importer.ts`, `tables.ts`               |
| Inputs from the submission's fields and the NPI registry            | `inputs.ts`                              |
| Factor resolution, speciality matching, flags/missing, saved quotes | `quote.ts`, `tests/rating.test.ts`       |
| ZIP → county                                                        | `geo.ts`, `geoImport.ts`                 |
| Saved quotes (rating structure, `single_rating`)                    | `store.ts`, [STRUCTURE.md](STRUCTURE.md) |

## 1. Formula (one quote)

```
specialityFactor  = round4(Σ round4(practice% / 100 × specialityClass))   | pickHighest → max(specialityClass)
baseModifierTotal = specialityFactor × stepUp(retro years) × territoryFactor × limitsFactor × fteFactor
scheduledPremium  = round4(stateBaseRate × baseModifierTotal)
creditTotal       = Σ(scheduledCD% / 100 × scheduledPremium) + (uwCredit% / 100 × scheduledPremium)
premium           = scheduledPremium + creditTotal                (negative % = credit, positive = debit)
ratingFees        = Σ fee   (calculated fee → % / 100 × premium, else flat amount)
taxTotal          = premium × domicileTax% / 100 + premium × stateTax% / 100
total             = premium + taxTotal + policyFeesTotal + ratingFees
combineTotal      = premium + taxTotal + ratingFees               (policy fees added once across combined ratings)
```

Rounding: the per-speciality factor and the scheduled premium are rounded to 4 dp. Every money amount (each credit,
the premium, each fee, each tax, every total) is rounded to cents, half away from zero (`round2` in `calc.ts`, the
only money rounding helper), before it is summed, so the stored line items add up to the stored totals exactly.
`premium = round2(scheduledPremium) + creditTotal`. Money is stored as `numeric(14,2)` (`scheduledpremium`
`numeric(14,4)`).

A base rate or factor that is 0, negative or not a number is bad rate data: the importer rejects it, and
`calculateQuote` treats one already loaded as missing (INCOMPLETE), so it can never price a $0 QUOTED premium.

## 2. Rate data (per state, per rate group)

| Data                     | Used for                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| State factors            | base rate, step-up year table, state tax %, domicile tax %, defense                         |
| Territory factors        | factor per territory, each with a list of counties                                          |
| ILF/DLF limits           | limit options (per-incident / aggregate) with a factor                                      |
| Speciality details       | speciality class per (speciality, state or "All", surgery type: Major / Minor / No Surgery) |
| Hours-worked factors     | FTE factor per weekly-hours band                                                            |
| Scheduled credits/debits | named credit/debit percentages                                                              |
| Rating fees              | per-state fees: flat amount or % of premium                                                 |
| Policy fees              | added to the total, not per factor                                                          |

## 3. Factors

| Factor              | Rule                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Speciality**      | Per speciality `round4(practice% / 100 × specialityClass)`, summed. Practice % must total exactly 100, or set **pick highest**, which uses the highest class and ignores practice %. A state-specific class is used before an "All" class. |
| **Territory**       | The territory whose county list contains the county (case- and punctuation-insensitive, "County" suffix ignored). Otherwise the state's "Remainder of State" territory, flagged when the county is unknown.                                |
| **Limits**          | The chosen ILF/DLF row, else the row matching the requested per-incident and aggregate limits, else per-incident only (flagged), else the state default (flagged).                                                                         |
| **Step-up (retro)** | `retroYears = 1 + whole years between retro date and effective date` (months/days dropped: 2y 11m → 3), minimum 1. The state table's value for that year; a year beyond the table uses the highest year ("Mature").                        |
| **FTE**             | The chosen hours-worked row, else the first band whose upper bound (inclusive) holds the weekly hours, else the default row (flagged).                                                                                                     |

## 4. Premium, fees, taxes

1. `scheduledPremium = round4(stateBaseRate × baseModifierTotal)`.
2. Each scheduled credit/debit with a % → `% / 100 × scheduledPremium`; without one, its flat amount.
3. Underwriter credit/debit: `% / 100 × scheduledPremium`.
4. The combined percentage (UW % + Σ scheduled %) must be ≥ −100, otherwise the quote is rejected (`RatingError`, HTTP 400).
5. `premium = scheduledPremium + creditTotal`.
6. Rating fees: a calculated fee is `% / 100 × premium`; any other fee is its amount.
7. Two taxes, on premium only, never on fees: domicile state (`DOMICILE_STATE`, default NC) and the risk state.
   Labels are `"<state> <rate>% Tax"`.

## 5. Worked example

Base rate 10,000 · one speciality, class 1.2 at 100% · retro 2024-11-01, effective 2026-01-01 → year 2, step-up 0.8 ·
territory 1.1 · limits 1.0 · FTE 1.0 · scheduled credit −10% · UW debit +5% · rating fees: 2% calculated + flat 50 ·
taxes: domicile 1%, state 2.5% · policy fees 150.

| Step              | Value                                          |
| ----------------- | ---------------------------------------------- |
| baseModifierTotal | 1.2 × 0.8 × 1.1 × 1.0 × 1.0 = 1.056            |
| scheduledPremium  | 10,560.0000                                    |
| credits           | −1,056 + 528 = −528                            |
| premium           | 10,032.00                                      |
| rating fees       | 200.64 + 50 = 250.64                           |
| taxes             | 100.32 + 250.80 = 351.12                       |
| total             | 10,032 + 351.12 + 150 + 250.64 = **10,783.76** |
| combineTotal      | 10,032 + 351.12 + 250.64 = **10,633.76**       |

## 6. Policy dates (defaults when not stated)

| Date       | Not stated                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Effective  | 1st of next month                                                                                                                                                              |
| Retro      | not assumed: the quote is INCOMPLETE until a retro date is entered (the effective date when there are no prior acts). A retro date after the effective date is INCOMPLETE too. |
| Expiration | effective + 1 year; a stated expiration on or before the effective date is dropped                                                                                             |

Defaults are labelled `default: …` in the sources and recomputed when the effective date changes. The premium is
annual; a non-standard term is not pro-rated.

## 7. Rules specific to this repo

- **Quotes are manual.** Nothing is priced automatically; an underwriter clicks Create quote. Preview never saves.
- **Missing data gives INCOMPLETE, never $0.** A missing state, step-up table, speciality, territory, limit or hours
  factor saves the quote as `INCOMPLETE` with a `missing` list and no premium (Intake left the factor at 0 and priced $0).
- **Saved quotes are never re-priced.** Each save is a new `single_rating` version; factors and pricing are stored with it
  (see [STRUCTURE.md](STRUCTURE.md)). One quote per submission is the primary rating.
- **Rate version.** A submission is priced with the rate group of its latest quote while that group exists; its first
  quote uses the active group. Importing a workbook (Settings → Rate tables) creates a new group, with the other tables
  copied from the active one, and makes it active.
- Not ported from Intake: self-service FTE floor (0.6), question-driven changes, student/endorsement/invoice pricing,
  primary/"same as primary" ratings.

## 8. Changing rating

Any formula or rounding change is high risk: it changes money on every new quote. Changing a rate, factor or fee value
is a data change (the workbooks), not a code change. Add tests that assert exact premiums for the cases you touch.
