# Applicant / Provider Profile

The six named fields describe the insured candidate (individual provider or group):

- `name`: the applicant as written in the submission. The report usually displays the
  pipeline's own name fields instead, so put the registry spelling and any variants
  (nickname, maiden name, middle initial) in `other` as well.
- `npi`: a verified (`MATCH` / `PARTIAL_MATCH`) number, or an underwriter's manual entry.
- `specialty`: the claimed specialty. The registry taxonomy goes in `other` when it differs.
- `state`: the practice state. List any other licensed or practicing states in `other`.
- `practiceName`: group, LLC or clinic name.
- `yearsInPractice`: as stated in the application or CV, or the stated start year.

Put every other sourced fact about the provider in `other`: provider type (MD, DO, NP, PA,
CNM, resident...), each licence with its type (full, limited licence, NY Limited Permit) and
status, medical education and ECFMG status for a foreign graduate, board certification, the
time split across specialties, procedures performed (exact names, volumes and settings; high-risk
ones such as surgery, obstetrics, anesthesia or cosmetic), hours per week, training completion
date, risk-management CME and patient volume. `references/dpl-manual-facts.md` lists the full set.

Coverage and claims facts go in `extractedFacts`, not here: coverage requested (limits, effective
date, claims-made or occurrence, retro date or RDI), prior carriers and policy periods, expiring
premium, tail / ERP requirements, claims and incidents (count, dates, status, paid amounts,
allegations) and disciplinary or board actions.

For a group with several providers, name the entity in `name` and list each provider with
their NPI in `other`.
