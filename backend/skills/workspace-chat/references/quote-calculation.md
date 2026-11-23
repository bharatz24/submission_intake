# Underwriter Quote and Premium Calculation

The `<underwriter_quote>` block is the underwriter's own rating of this submission: the primary
rating if one is set, otherwise the latest saved version. The app computes it from the rate tables;
you never price the risk. Use this file to read the block, explain how its premium was reached, and
check its inputs against the evidence.

## Two premium figures, two meanings

| Figure                  | Where                 | What it is                                                                             |
| ----------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| Quote premium and total | `<underwriter_quote>` | The underwriter's rating from the rate tables, with the factors they chose.            |
| Worksheet total premium | `<derived_coverage>`  | Arithmetic on rating inputs the documents state (base premium, factors). Often absent. |
| Expiring premium        | extracted fields      | What the prior carrier charged. Context, not a rating.                                 |

Never mix them up or present one as another. When a document states a premium that differs from the
quote, report both with their sources; a difference is not an error by itself.

## Quote status

- **QUOTED**: priced. Quote the premium and total exactly as given, in dollars and cents.
- **INCOMPLETE**: could not be priced. There is no premium; never say $0. Name the `Missing for pricing`
  items, and the documents or answers that would supply them.
- **No quote yet**: say so. Do not estimate a premium.
- A saved version is never re-priced. If the evidence changed after the quote was created, say the
  quote may be stale and which fact changed, rather than recalculating.

## The formula

The `Calculation:` lines show each step. Explain a premium by walking through them in this order.

1. **Speciality factor.** For each specialty, practice % / 100 × its class, rounded to 4 places, then
   summed. Practice % must total 100. With "pick highest", the highest class is used and practice %
   is ignored. A class for the state is used before an "All states" class.
2. **Step-up (claims-made year).** Retro years = 1 + the whole years from the retro date to the
   effective date (2 years 11 months counts as 3), minimum 1. A year past the table uses the highest
   year ("Mature"). When the retro date was not stated, it equals the effective date (year 1, the
   lowest factor); a real earlier retro date would raise the premium.
3. **Territory.** The territory whose county list holds the risk county, otherwise the state's
   "Remainder of State" territory.
4. **Limits factor.** The ILF/DLF row for the per-incident / aggregate limits.
5. **FTE factor.** The hours-worked band for weekly hours.
6. **Base modifier total** = speciality × step-up × territory × limits × FTE.
7. **Scheduled premium** = state base rate × base modifier total, rounded to 4 places.
8. **Credits and debits.** Each scheduled credit/debit % × scheduled premium (negative is a credit,
   positive a debit), plus the underwriter credit/debit % × scheduled premium. Combined, they cannot go
   below −100%.
9. **Premium** = scheduled premium + credits and debits.
10. **Rating fees.** A calculated fee is its % × premium; any other fee is a flat amount.
11. **Taxes**, on premium only, never on fees: the domicile state tax and the risk state tax.
12. **Total** = premium + taxes + policy fees + rating fees.

The premium is annual. A policy term other than one year is not pro-rated.

## Checking the quote against the evidence

Each check that fails is a point to raise. Cite both the quote line and the source of the conflicting fact.

| Quote input                           | Check against                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State, county, ZIP                    | Practice locations; the territory is set by where most of the time is spent (DPL §2.4). A county from `ZIP lookup (Census / GeoNames)` is derived, not stated: a quote county that matches it is consistent, and a multi-county ZIP is a follow-up question, not an inconsistency. |
| Specialties, surgery type, practice % | The application's specialty and procedure list. Major surgery rated as No Surgery under-prices the risk.                                                                                                                                                                           |
| Retro date and step-up year           | Prior coverage and retro date in the documents. A default retro date with prior acts claimed is a gap.                                                                                                                                                                             |
| Limits                                | Requested limits; state rules (Florida $250K / $750K, New York up to $1.3M / $3.9M).                                                                                                                                                                                               |
| Hours worked                          | Stated weekly hours; part-time credits need 20 h/wk or less (DPL §2.11).                                                                                                                                                                                                           |
| Scheduled credits/debits              | Whether the evidence supports each one (`references/dpl-manual-quick-reference.md`). A loss-free credit with a paid claim in the period is an inconsistency.                                                                                                                       |
| Flags                                 | Each flag is an assumption the app made (remainder territory, default limit, multi-county ZIP). Say which ones the evidence could settle.                                                                                                                                          |

## Rules

- **Advise; don't decide.** You can say the quote looks under- or over-rated and why. Never state
  or imply that the quote is approved, bindable or final.
- **Do not recompute** with factors of your own. If a factor looks wrong, say which one, what the
  evidence suggests, and that the underwriter should re-rate.
- **Credits must be earned.** Name the evidence for each credit applied; flag one that has none.
- The quote is the underwriter's work, not a fact the submission states. Do not cite it as evidence
  about the applicant.
