# DPL Manual: Procedure Restrictions and Required Endorsements

Source: DPLRRG Underwriting Manual v5.7.26, Part 6 and Appendices B and C. These rules apply
whoever performs the procedure: physician, ancillary provider or midlevel.

Match on meaning, not just spelling: "UV blood irradiation" is UBI; "Biote" and "BHRT pellets"
are hormone pellet insertion; "PRP O-Shot" is the O-Shot; "phosphatidylcholine / deoxycholate
injections" are Lipodissolve (PCDC). When a term is ambiguous (e.g. whether a product is
FDA-approved for the use described), ask instead of assuming.

## Excluded procedures: will not write (§6.1, Appendix B)

- Ozone therapy
- UBI (ultraviolet blood irradiation) treatments
- Hyaluronic acid for penile girth
- Silicone injections
- Medical directorship for LTC, nursing homes, ALFs or telemedicine

Report each as a `riskIndicators` finding (HIGH severity) citing the manual. See
`references/dpl-eligibility-and-appetite.md` for whether the result is an exclusion
(`PROCEED_WITH_CONDITIONS`) or `DECLINE`.

## Sublimit procedures: $100,000 per claim / $300,000 aggregate (§6.2, Appendix B)

| Procedure                                       | Extra condition                         |
| ----------------------------------------------- | --------------------------------------- |
| O-Shot                                          | —                                       |
| P-Shot                                          | —                                       |
| Stem cells                                      | —                                       |
| Hormone pellet insertion (Biote / BHRT)         | —                                       |
| Dermal filler for penile girth                  | —                                       |
| Lipodissolve procedures (PCDC)                  | —                                       |
| All non-FDA-approved procedures                 | —                                       |
| Correctional medicine                           | Standard **$10,000 deductible**         |
| Chelation therapy                               | —                                       |
| Ketamine therapy                                | **Endorsement #49**                     |
| Brazilian Butt Lift (all states except Florida) | **Endorsement #46**                     |
| Semaglutide weight-loss medications             | Weight Loss Sublimit Endorsement (§5.9) |

A sublimit procedure is acceptable with conditions: report it once (as a `riskIndicators`
finding, MEDIUM unless volume or claims make it worse) and list the sublimit and endorsement in
`recommendedNextSteps`. In Florida, BBL follows §5.7 instead (BBL endorsement, $15K deductible,
statutory minimum limits).

Midlevel exclusions (§5.5), MedSpa and PDGF / PDRN rules (§5.8) and the loss-run carve-out (§1.6)
are in `references/dpl-specialty-programs.md` and `references/dpl-eligibility-and-appetite.md`.

## Required endorsements by risk type (Appendix C)

| Trigger                                       | Required endorsement(s)                                                                         | Section |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| Co-owned entity added vicariously             | #26 Vicarious Liability                                                                         | §7.2    |
| Entity with < 50% of providers insured by DPL | VL-only endorsement, excluding all other providers                                              | §7.3    |
| Nursing home / LTC exposure                   | Nursing Home Drop-Down                                                                          | §5.3    |
| NY assisted living facility                   | LTC Endorsement                                                                                 | §5.3    |
| NY Limited Permit Physician                   | Limited Permit Physician Endorsement                                                            | §5.10   |
| Florida BBL / liposuction > 1,000 cc          | BBL-Specific Endorsement                                                                        | §5.7    |
| MedSpa / aesthetic medicine                   | #38 MedSpa + MedSpa Scope of Services + PDGF / PDRN Topical / Non-Invasive Use                  | §5.8    |
| Weight loss / semaglutide                     | Weight Loss Sublimit Endorsement                                                                | §5.9    |
| Ketamine therapy                              | #49                                                                                             | §6.2    |
| BBL outside Florida                           | #46                                                                                             | §6.2    |
| Waiver of COI                                 | #51 (Director of Underwriting approval)                                                         | §7.5    |
| Separate limits for more than one insured     | Standard Non-Stacking Language on quote, AI endorsement and declarations; total aggregate ≤ $5M | §7.1    |
| Unlimited ERP                                 | DPL ERP Endorsement                                                                             | §8.1    |
| Standalone ERP                                | Following-Form + Prior-or-Pending / Known Circumstances Exclusion                               | §8.2    |

## Required deductibles

| Trigger                                         | Deductible                                                                                     | Section |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| BBL or liposuction > 1,000 cc (Florida program) | $15,000                                                                                        | §5.7    |
| Nursing home exposure                           | $5,000                                                                                         | §5.3    |
| NY ALF                                          | $5,000 minimum per claim, not waivable                                                         | §5.3    |
| MedSpa / aesthetic procedures                   | $2,500 standard; newly trained procedures $7,500 (year 1), $5,000 (year 2), $2,500 from year 3 | §5.8    |
| Correctional medicine                           | $10,000                                                                                        | §6.2    |

An underwriter-imposed deductible (for claims history or high risk) earns **no** deductible
credit (§3.6).
