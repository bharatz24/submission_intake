# DPL Manual: Rating, Credits and Surcharges

Source: DPLRRG Underwriting Manual v5.7.26, Parts 3–4 and Appendix A. You do **not** price the
risk: premium figures come from `<underwriter_quote>` (see `quote-calculation.md`) and are quoted
as given. Use this file to
(a) say which credits and debits the evidence supports or rules out, (b) flag a requested credit
the facts do not support, and (c) flag surcharges the underwriter should apply. Put these in
`recommendedNextSteps`, citing the section; a requested credit that the evidence contradicts is
an `inconsistencies` finding.

## Calculation sequence for a provider (§4.1)

Specialty class (§4.6) → territory (§2.4) → claims-made step (§2.6) → limits factor (ILF / DLF;
limits in `references/dpl-coverage-rules.md`) → FT / PT factor → credits (leave of absence, new to
private practice, loss-free, board certified, risk management, claims management, premises
conditions, unusual risk characteristics) → part-time credit (§2.11) → surcharge for a change in
scope or rating class.

**Credit cap:** the manual says combined credits "cannot exceed 75% off manual, with exceptions
allowing up to 50%"; Appendix A ties the 50% to corporate / partnership scenarios (and §4.4 caps
scheduled credits for corporations at 50%). The wording is ambiguous; if a rating approaches
either cap, flag it for the underwriter rather than resolving it.

## Credits

| Credit                                               | Amount                               | Conditions                                                                                                                                                                                        | Section |
| ---------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Loss-free, 3–5 years                                 | 5%                                   | Individual physician; continuous claims-made coverage for the prior 3 years; no open claim with indemnity reserve over $10,000; no paid indemnity in the period; proof from prior insurer or NPDB | §3.1    |
| Loss-free, 6–10 years                                | 15%                                  | as above                                                                                                                                                                                          | §3.1    |
| Loss-free, 11+ years                                 | 25%                                  | as above                                                                                                                                                                                          | §3.1    |
| Risk management                                      | 5%                                   | Sullivan Group CME with a passing score; applied at the **next renewal**                                                                                                                          | §3.2    |
| Group size 5–9 / 10–14 / 15–20 / 21–25 / 26–30 / 31+ | 5% / 10% / 12.5% / 15% / 17.5% / 20% | Full- and part-time physicians only (not ancillaries); set at renewal, no midterm change                                                                                                          | §3.3    |
| New to private practice (year 1)                     | 50%                                  | Within six months of residency / fellowship / tuition-linked military obligation; entering a group or starting a practice; normal rating at renewal                                               | §2.13   |
| Schedule rating                                      | up to 25% (up to 50% in rare cases)  | Board certification, specialty, loss experience, staff supervision, risk management, unusual characteristics; reviewed each anniversary                                                           | §3.4    |
| Part-time 10–20 h/wk                                 | 25% (major surgery 15%)              | 20 h/wk or less; other credits minimal                                                                                                                                                            | §2.11   |
| Part-time under 10 h/wk                              | 40% (major surgery 25%)              | as above                                                                                                                                                                                          | §2.11   |
| Midlevel part-time                                   | 25%                                  | 20 h/wk or less                                                                                                                                                                                   | §5.5    |
| Weight-loss part-time                                | 40% only                             | No further discounts except case by case                                                                                                                                                          | §5.9    |
| Nursing home claims-free                             | up to 25%                            | Nursing home portion only                                                                                                                                                                         | §5.3    |
| CNM maximum credit                                   | 35% (25% in NJ, IL)                  |                                                                                                                                                                                                   | §5.2    |
| Deductible 5% / 7.5% / 10% / 15%                     | 2% / 3.5% / 5% / 10%                 | Not when the underwriter imposed the deductible for claims or risk                                                                                                                                | §3.6    |

## Surcharges and debits

| Trigger                                                                                  | Surcharge                                                   | Section |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------- |
| 1 new claim at renewal                                                                   | +50%                                                        | §4.5    |
| 2 new claims at renewal                                                                  | +100%                                                       | §4.5    |
| 3+ new claims at renewal                                                                 | +300% or decline (may non-renew; follow notification rules) | §4.5    |
| Pain management exposure                                                                 | 5–25%                                                       | §3.4    |
| Prior claims with BBL / liposuction                                                      | heavy debit, may increase if quoted                         | §5.7    |
| Midlevel prior claims, board / licensing issues, unsupervised or undocumented procedures | debit                                                       | §5.5    |
| Unusual risk characteristics                                                             | schedule debit                                              | §3.4    |

## Other rated exposures

| Exposure                         | Rate                                                                                          | Section |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| RNs, MAs, LPNs                   | Included at no charge (unless a visit-based group policy)                                     | §4.2    |
| Allied provider, shared limits   | Lowest class, 10–25% credit, 0.82 ILF                                                         | §4.2    |
| Allied provider, separate limits | 1.00 ILF                                                                                      | §4.2    |
| Vicarious-only exposure          | 25% of the full allied rate; COI required; provider's limits must match the primary insured's | §4.2    |

Rates stated with their rules elsewhere: entities and corporations (§2.10, §4.4), labs and misc
medical entities (§2.14, §4.3), suspended coverage (§2.8), locum (§2.12) and ERP (§2.9, §8.1, §8.2)
in `references/dpl-coverage-rules.md`; medical directors (§5.6), CNMs (§5.2) and midlevels (§5.5) in
`references/dpl-specialty-programs.md`.

## FTE / slot rating (§3.5)

At DPL's discretion, groups may be rated by FTE slot rather than named provider; the application
must be approved before the start date, and eliminating a slot requires a reporting endorsement.
One FTE = 5,500 ER visits / year (emergency medicine); 10,000 visits / year (outpatient clinic);
9,000 encounters / year (urgent care); 50 reads / day per radiologist. **More than 100 reads / day
breaches the standard of care**: report it as a HIGH-severity risk indicator.
