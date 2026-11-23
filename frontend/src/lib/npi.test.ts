import { describe, expect, it } from 'vitest';

import type { NpiStatus, NpiVerification } from '../types';
import { assessNpiNeed, npiNeedMessage, parseCandidates, registryPreview } from './npi';

const v = (status: NpiStatus, npi = '1234567893', mismatches: string[] = []): NpiVerification => ({
  id: `${npi}-${status}`,
  npi,
  status,
  mismatches,
  claimedName: null,
  claimedState: null,
  claimedSpecialty: null,
  registryName: null,
  registryTaxonomy: null,
  registryState: null,
  registryStatus: null,
  registryData: null,
  verifiedAt: '',
  claimedType: null,
  claimedFirstName: null,
  claimedLastName: null,
  claimedEntityName: null,
  registryType: null,
  registryFirstName: null,
  registryLastName: null,
  registryEntityName: null,
  source: 'EXTRACTED',
  addedBy: null,
  note: null,
  autoStatus: null,
  overrideNote: null,
  overrideBy: null,
  overrideAt: null,
});

describe('NPI need', () => {
  it('counts MATCH and PARTIAL_MATCH as verified, flagging partial matches for review', () => {
    const partial = v('PARTIAL_MATCH', '1234567893', ['State: TX vs CA']);
    expect(assessNpiNeed([partial])).toEqual({
      kind: 'VERIFIED',
      matched: ['1234567893'],
      others: [],
      review: [partial],
      byUnderwriter: false,
    });
    expect(npiNeedMessage(assessNpiNeed([partial])).severity).toBe('warning');
  });

  it('verifies a submission with several NPIs when any one matches', () => {
    const need = assessNpiNeed([v('MISMATCH', '1000015838'), v('NOT_FOUND', '1111111112'), v('MATCH')]);
    expect(need).toEqual({
      kind: 'VERIFIED',
      matched: ['1234567893'],
      others: ['1000015838', '1111111112'],
      review: [],
      byUnderwriter: false,
    });
    const msg = npiNeedMessage(need);
    expect(msg).toMatchObject({ severity: 'success', title: 'NPI verified' });
    expect(msg.detail).toMatch(/Matched on NPI 1234567893; the other 2 NPIs \(1000015838, 1111111112\) do not match/);
    // A clean match is named before a partial one.
    expect(assessNpiNeed([v('PARTIAL_MATCH', '1000015838'), v('MATCH')])).toMatchObject({
      matched: ['1234567893', '1000015838'],
      others: [],
    });
    expect(npiNeedMessage(assessNpiNeed([v('MATCH')])).detail).toBe('The NPI matches the CMS NPI Registry.');
  });

  it('follows the underwriter decision on a partial match', () => {
    const confirmed = { ...v('MATCH', '1234567893', ['State: TX vs CA']), autoStatus: 'PARTIAL_MATCH' as const };
    const need = assessNpiNeed([confirmed]);
    expect(need).toEqual({ kind: 'VERIFIED', matched: ['1234567893'], others: [], review: [], byUnderwriter: true });
    expect(npiNeedMessage(need).title).toBe('NPI confirmed by an underwriter');
    // A clean registry match on the submission outranks the decision.
    expect(assessNpiNeed([confirmed, v('MATCH', '1000015838')])).toMatchObject({ byUnderwriter: false });

    const rejected = { ...v('MISMATCH', '1234567893', ['State: TX vs CA']), autoStatus: 'PARTIAL_MATCH' as const };
    expect(assessNpiNeed([rejected])).toEqual({ kind: 'MISMATCH', npis: ['1234567893'] });
  });

  it('explains missing, failed, not-found and mismatched checks in that order', () => {
    expect(assessNpiNeed([]).kind).toBe('NONE_CHECKED');
    expect(assessNpiNeed([v('NOT_FOUND'), v('ERROR', '1000015838')]).kind).toBe('REGISTRY_ERROR');
    expect(assessNpiNeed([v('NOT_FOUND'), v('MISMATCH', '1000015838')])).toEqual({
      kind: 'NOT_FOUND',
      npis: ['1234567893'],
    });
    expect(assessNpiNeed([v('MISMATCH')])).toEqual({ kind: 'MISMATCH', npis: ['1234567893'] });
    expect(npiNeedMessage({ kind: 'NOT_FOUND', npis: ['1234567893'] }).detail).toMatch(/^1234567893 is not/);
    expect(npiNeedMessage({ kind: 'NOT_FOUND', npis: ['1234567893', '1000015838'] }).detail).toMatch(
      / are not in the registry/,
    );
  });

  it('offers registry search candidates when no NPI was stated', () => {
    const search = v('NOT_VERIFIED', '', [
      'Not verified: 2 providers match',
      'Candidate 1234567893: JANE SMITH, Obstetrics & Gynecology, HOUSTON TX 77001',
      'Candidate 1000015838: JANE SMITH, Family Medicine, DALLAS TX 75001',
    ]);
    const need = assessNpiNeed([search]);
    expect(need).toEqual({
      kind: 'NO_NPI_STATED',
      candidates: [
        { npi: '1234567893', description: 'JANE SMITH, Obstetrics & Gynecology, HOUSTON TX 77001' },
        { npi: '1000015838', description: 'JANE SMITH, Family Medicine, DALLAS TX 75001' },
      ],
    });
    expect(npiNeedMessage(need).detail).toContain('2 possible matches');
  });

  it('parses only well-formed candidate lines', () => {
    expect(parseCandidates(['Candidate 123: short', 'Something else', ' Candidate 1234567893:  X '])).toEqual([
      { npi: '1234567893', description: 'X' },
    ]);
  });
});

describe('registry preview', () => {
  it('summarizes individual and organization records', () => {
    expect(
      registryPreview({
        enumeration_type: 'NPI-1',
        basic: { first_name: 'JANE', last_name: 'SMITH', credential: 'MD', status: 'A' },
        addresses: [
          { address_purpose: 'MAILING', city: 'AUSTIN', state: 'TX' },
          { address_purpose: 'LOCATION', city: 'HOUSTON', state: 'TX' },
        ],
        taxonomies: [
          { primary: false, desc: 'Family' },
          { primary: true, desc: 'Obstetrics & Gynecology' },
        ],
      }),
    ).toEqual({
      name: 'JANE SMITH',
      credential: 'MD',
      location: 'HOUSTON, TX',
      taxonomy: 'Obstetrics & Gynecology',
      active: true,
    });
    expect(
      registryPreview({ enumeration_type: 'NPI-2', basic: { organization_name: 'ACME CLINIC', status: 'D' } }),
    ).toEqual({ name: 'ACME CLINIC', credential: null, location: null, taxonomy: null, active: false });
    expect(registryPreview(null)).toBeNull();
  });
});
