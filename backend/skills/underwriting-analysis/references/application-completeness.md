# Application Completeness

Score 0–100. The server computes the score from `gaps`, so list every gap with its level; put your own
best estimate in `score`, it is replaced. Each gap keeps a share of the score that is left:

- Each missing CRITICAL item (from the synthesis Missing Information) keeps 85% (×0.85).
- Each missing IMPORTANT item keeps 95% (×0.95).
- Each missing NICE_TO_HAVE item keeps 99% (×0.99).
- An attachment that was UNREADABLE, UNSUPPORTED or ERROR and likely held required data that is not already
  counted as a missing item above keeps 90% (×0.90) (the synthesis usually lists it; don't count it twice).

The score starts at 100 and never reaches 0: one CRITICAL gap gives 85, two CRITICAL and twelve IMPORTANT
gaps about 39.

`gaps` has one entry per gap, each naming its level in capitals, e.g. "Loss runs (CRITICAL)" or
"Unreadable attachment scan_002.pdf (UNREADABLE)". `summary` explains the score in one sentence by what is
missing; don't restate the arithmetic. The plain list of missing items goes in `missingInformation`, not here.

The score measures completeness only; it does not decide the recommendation (see SKILL.md).
