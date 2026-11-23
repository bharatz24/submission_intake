# Comparing two Analysis versions

An Analysis interprets risk from a Synthesis. A change matters when it would move the
underwriter's decision, the questions they ask, or the conditions they impose.

## Sections (JSON key → what to look for)

| Key                                                      | HIGH when                                                                                                                                                                                                                                                                                                                          | MEDIUM when                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `recommendation`                                         | any change (e.g. PROCEED → REFER)                                                                                                                                                                                                                                                                                                  | —                                                                                               |
| `overallRisk`                                            | any change                                                                                                                                                                                                                                                                                                                         | —                                                                                               |
| `riskIndicators`, `inconsistencies`, `potentialConcerns` | a HIGH-severity finding is added or removed, or a finding's severity moves to/from HIGH                                                                                                                                                                                                                                            | a MEDIUM/LOW finding is added or removed, or severity/confidence changes between MEDIUM and LOW |
| `applicationCompleteness`                                | `score` moves by 15 points or more, or crosses 50 or 80                                                                                                                                                                                                                                                                            | `score` moves by 5–14 points, or `gaps` gain/lose an item                                       |
| `missingInformation`                                     | an item that blocks binding is added/removed                                                                                                                                                                                                                                                                                       | any other item added/removed                                                                    |
| `followUpQuestions`                                      | —                                                                                                                                                                                                                                                                                                                                  | a question is added or removed, or is redirected to a different party                           |
| `recommendedNextSteps`                                   | a step that changes the decision path (refer, decline, request info) appears/disappears, or a DPL manual condition appears/disappears: an exclusion, sublimit, required endorsement, program deductible, required approval (management, U/W VP, Director of Underwriting, legal), or writing RDI instead of rolling the retro date | other steps added/removed, including a credit or surcharge note                                 |
| `executiveSummary`, `limitationsAndUncertainties`        | — (rate by the conclusion they change, usually LOW)                                                                                                                                                                                                                                                                                | a limitation that affects reliance on the report is added/removed                               |

A finding that cites a different DPL manual section, or now cites one where it did not, is at
least MEDIUM: the rule the underwriter must apply has changed.

Findings are matched by `title`. A finding with a new title but the same substance as one
that was removed is one MODIFIED change, not one ADDED plus one REMOVED: merge them.

## Cause hints

- If `based_on_synthesis` differs between A and B, changes that trace to facts in the newer
  Synthesis are `NEW_EVIDENCE`.
- Same Synthesis, same skill, same model, but a different `recommendation` or `overallRisk`:
  `MODEL_VARIANCE` with HIGH significance. Say plainly that the recommendation is unstable and
  should be confirmed by the underwriter.
