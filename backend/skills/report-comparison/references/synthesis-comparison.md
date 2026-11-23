# Comparing two Synthesis versions

A Synthesis establishes facts. A change matters when an underwriter would now believe a
different fact, or trust a fact more or less.

## Sections (JSON key → what to look for)

| Key                                               | HIGH when                                                                                                                                                                                                                                                                                    | MEDIUM when                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `applicantProfile`                                | name, NPI, specialty, state or practice changes value or appears/disappears                                                                                                                                                                                                                  | `yearsInPractice` or an `other` fact changes                      |
| `extractedFacts`                                  | a fact about limits, retro/effective dates, prior-acts / RDI basis, coverage gaps, premium, claims history or licensure changes value or is added/removed; a procedure on the DPL manual's excluded or sublimit lists (or BBL / liposuction volume, PDGF / PDRN route) appears or disappears | any other fact added/removed, or its source or confidence changes |
| `npiVerificationSummary`                          | the verification outcome changes (match ↔ mismatch, found ↔ not found)                                                                                                                                                                                                                     | the explanation of the same outcome changes in substance          |
| `conflicts`                                       | a conflict about identity, coverage dates, limits or claims is added, removed or resolved differently                                                                                                                                                                                        | any other conflict added/removed                                  |
| `missingInformation`                              | a CRITICAL item is added or removed, or an item's importance moves to/from CRITICAL                                                                                                                                                                                                          | an IMPORTANT item is added/removed or its importance changes      |
| `emailAndAttachmentInventory`                     | an attachment changes status between readable and unreadable                                                                                                                                                                                                                                 | an item is added/removed                                          |
| `dataConfidence`                                  | `overall` changes                                                                                                                                                                                                                                                                            | `notes` change in substance                                       |
| `submissionOverview`, `consolidatedContextForLlm` | — (summaries; rate by the facts they change, usually LOW)                                                                                                                                                                                                                                    | a fact that is only stated here changes                           |

## Cause hints

- A new or re-extracted attachment, a manual field entry, or a new NPI check shows up as a
  different `context_version`: prefer `NEW_EVIDENCE` for changed facts and inventory.
- Same context, same skill, same model, but different facts: `MODEL_VARIANCE`. Flag it, since a
  Synthesis should be deterministic on facts that are plainly stated in the evidence.
