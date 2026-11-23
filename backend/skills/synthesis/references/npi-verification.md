# NPI Verification Interpretation

The pipeline checks providers against the CMS NPPES NPI Registry before you run. Only NPIs whose
latest status is `MATCH` or `PARTIAL_MATCH` (including an underwriter's decision) reach this report;
any other result (`MISMATCH`, `NOT_FOUND`, `NOT_VERIFIED`, `ERROR`) is left out. Each line in
`<npi_registry_results>` reads:

`- NPI <number>: <STATUS>; registry name "..." (TYPE), taxonomy "...", state XX, record status A|D; claimed name "..." (TYPE), state XX, specialty "..."; mismatches: ...`

`(entered by an underwriter)` after the number means an underwriter added that NPI by hand.
`(no registry-matched NPI; NPI is not part of this report)`: see "No matched NPI" below.
`(set by an underwriter; registry check said PARTIAL_MATCH; reason: "...")` after the status means
an underwriter reviewed the listed mismatches and decided the status shown.

`TYPE` is `INDIVIDUAL` or `ORGANIZATION` (`?` when unknown). The registry type comes from the
record itself (NPI-1 = individual, NPI-2 = organization); the claimed type is read from the
submission's name (entity words such as LLC, Inc, Group or Clinic mean an organization).

## How the pipeline gets there

- **NPI stated in the submission:** each 10-digit NPI is looked up directly. The submission
  side of the comparison uses the single highest-confidence `applicant_name`, `practice_state`
  and `specialty`, even when the submission names several providers.
- **No NPI in the submission:** the registry is searched by provider name + ZIP. If nothing
  comes back, the search widens to name + state, then name alone. If several records come
  back, the claimed specialty is used to pick one. An NPI found this way came from the
  **registry, not the broker**.
- **Type:** an individual's NPI is NPI-1 and an entity's is NPI-2. A claimed `ORGANIZATION`
  checked against an `INDIVIDUAL` record (or the reverse) usually means a group NPI and a
  provider NPI were swapped; say so rather than treating it as an identity conflict.
- **Registry state** is the license state on the primary taxonomy, or else the practice
  location address. **Record status** `A` = active; anything else (usually `D`) = deactivated.

## Statuses

| Status          | Meaning                                                                                                                                                                                                              | How to treat it                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `MATCH`         | Record found, active, and name/state/specialty agree.                                                                                                                                                                | Registry identity facts are HIGH confidence. |
| `PARTIAL_MATCH` | Record found and the name broadly matches, but something differs: partial name, state, specialty, a deactivated record, or the record was only found by a widened search. Each difference is listed in `mismatches`. | Judge each mismatch (see below).             |

## Judging mismatches

The name and specialty comparisons are automated keyword checks, so not every mismatch is real:

- **Formatting or synonym:** for example nickname vs legal name ("Bob" / "Robert"), middle
  initial, maiden name, "OB/GYN" vs "Obstetrics & Gynecology", "Family Practice" vs
  "Family Medicine". Note the canonical (registry) form; this is not a conflict.
- **Material:** a different surname with no explanation, a different specialty tier (e.g.
  claimed "Family Medicine", registry "Orthopaedic Surgery"), a state that does not appear
  anywhere in the submission, or a deactivated record. Add these to `conflicts` with both sources.
- **Widened search:** the registry ZIP differs from the submission. The provider may have
  moved, or it may be the wrong person with the same name. Flag it, but don't call it a mismatch.

## Underwriter decisions

An underwriter's decision settles whether this NPI belongs to the applicant. Use the status shown,
don't argue it, and report both the decision and the reason in `npiVerificationSummary`.

- **Set to `MATCH`:** the identity is confirmed. Don't list the reviewed mismatches as conflicts,
  unless the record is deactivated: that is a fact about the provider, so keep it as a conflict.
  Don't add "Provider NPI confirmation" to `missingInformation`: the underwriter has confirmed it.

## Writing `npiVerificationSummary`

Write 1–2 sentences per NPI with: the number, how it was obtained (document or which registry
search), the status, the registry name / taxonomy / state, active or deactivated, and each
mismatch judged as formatting or material. Don't comment on fields that agree.

Example: "NPI 1234567890 (application.pdf): MATCH, active; registry 'Jane A. Smith', Dermatology, FL.
Name differs only by middle initial (formatting)."

If the check covered only one of several named providers, add one sentence saying the others
are unverified.

## No matched NPI

When `<npi_registry_results>` says there is no registry-matched NPI:

- `npiVerificationSummary`: exactly "No registry-matched NPI; NPI verification is not included in this report."
- `applicantProfile.npi`: null.
- Don't add any NPI item to `missingInformation` or `conflicts`, and don't lower `dataConfidence`
  because of NPI. Don't guess an NPI from the documents' text.

## Effect on other sections

- **`applicantProfile.npi`:** if the number came from registry search, say so in `other`.
- **`missingInformation`:** when the NPI was found only by registry search, add "Provider NPI
  confirmation" as IMPORTANT, with the reason "not stated in submission; registry search identified
  NNNNNNNNNN". Add nothing else for NPI.
