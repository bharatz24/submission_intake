# Inconsistency Analysis

Turn each material conflict in the synthesis into an inconsistency finding, except conflicts
"Resolved by underwriter entry" and attempts to steer the review (those go in
`potentialConcerns`). Then look for implicit ones the synthesis did not flag:

- Claimed claim count vs loss runs.
- Application answers ("no prior claims", "no board actions") vs loss runs, NPDB or licence
  records showing them. The manual makes non-disclosure grounds for rescission (§1.6).
- Claimed specialty vs NPI taxonomy, or vs procedures listed, or vs the time split (a higher
  class above 25% of time must be the rating class, §4.6).
- Practice state vs NPI registry state vs requested coverage territory (territory is where more
  than 50% of time is spent, §2.4).
- Requested retroactive date vs prior coverage history: gaps, occurrence-form periods, or prior
  limits lower than the requested retro-period limits (§2.5).
- RDI / "no prior acts" requested while the application or loss runs show prior claims-made
  coverage the insured expects DPL to pick up, or vice versa.
- Effective date already in the past, or more than 120 days in the future, measured from the
  email's received date.
- Application signed more than 60 days before the effective date with no No Known Claims
  affidavit (§1.2): LOW–MEDIUM, a documentation issue unless something has happened since.
- Loss runs valued more than 90 days before the effective date, or covering fewer than 10 years
  (§1.3): a gap in the evidence, not a contradiction; report it in completeness unless another
  source shows claims after the valuation date.
- A credit requested that the facts do not support, e.g. loss-free credit with a paid claim in the
  period, part-time credit with more than 20 hours a week, new-to-practice discount more than six
  months after training, group-size discount counting ancillaries, deductible credit on an
  underwriter-imposed deductible (Part 3).
- Hours per week, provider roster or group size that differ between documents.
- Procedures on the website, marketing or CV that are missing from the application's procedure
  list (§5.8 asks for this review for regenerative services).
- A visibly altered application (§1.2).

Severity guidance: misstatement on an application (claims, discipline) = HIGH;
specialty/taxonomy or time-split mismatch = MEDIUM to HIGH depending on tier gap; undeclared
excluded or sublimit procedure = HIGH; unsupported credit = MEDIUM; formatting or minor date
differences = LOW.

A specialty/taxonomy mismatch is reported here only. If it suggests an underreported
higher-risk practice, say so in this finding's `detail` rather than adding a risk indicator.
