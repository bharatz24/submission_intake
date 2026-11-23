// Whether a submission has a verified NPI and, if not, why: the only place that decides it (see NpiEntryBar).
import type { NpiVerification } from '../types';

export interface NpiCandidate {
  npi: string;
  description: string;
}

export type NpiNeed =
  /**
   * At least one MATCH or PARTIAL_MATCH: with several NPIs, any one that matches verifies the submission.
   * `matched` lists those NPIs (clean matches first), `others` the NPIs that did not match.
   * `review` lists partial matches whose mismatches still need a look;
   * `byUnderwriter` means every MATCH is an underwriter's decision, none a clean registry match.
   */
  | { kind: 'VERIFIED'; matched: string[]; others: string[]; review: NpiVerification[]; byUnderwriter: boolean }
  | { kind: 'NONE_CHECKED' }
  | { kind: 'REGISTRY_ERROR'; failed: NpiVerification[] }
  | { kind: 'NO_NPI_STATED'; candidates: NpiCandidate[] }
  | { kind: 'NOT_FOUND'; npis: string[] }
  | { kind: 'MISMATCH'; npis: string[] };

const VERIFIED = new Set(['MATCH', 'PARTIAL_MATCH']);

/** Registry search hits the backend lists as "Candidate 1234567893: JANE SMITH, Obstetrics, Houston TX 77001". */
export function parseCandidates(mismatches: string[]): NpiCandidate[] {
  return mismatches.flatMap((m) => {
    const hit = /^Candidate (\d{10}):\s*(.+)$/.exec(m.trim());
    return hit?.[1] && hit[2] ? [{ npi: hit[1], description: hit[2] }] : [];
  });
}

export function assessNpiNeed(verifications: NpiVerification[]): NpiNeed {
  if (verifications.some((v) => VERIFIED.has(v.status))) {
    const matches = verifications.filter((v) => v.status === 'MATCH');
    const npis = (list: NpiVerification[]) => [...new Set(list.map((v) => v.npi).filter(Boolean))];
    const matched = npis([...matches, ...verifications.filter((v) => v.status === 'PARTIAL_MATCH')]);
    const others = npis(verifications.filter((v) => !VERIFIED.has(v.status))).filter((n) => !matched.includes(n));
    return {
      kind: 'VERIFIED',
      matched,
      others,
      review: verifications.filter((v) => v.status === 'PARTIAL_MATCH' && v.mismatches.length > 0),
      byUnderwriter: matches.length > 0 && matches.every((v) => v.autoStatus),
    };
  }
  if (verifications.length === 0) return { kind: 'NONE_CHECKED' };
  // A failed registry call says nothing about the NPI: re-verify before entering one by hand.
  const failed = verifications.filter((v) => v.status === 'ERROR');
  if (failed.length) return { kind: 'REGISTRY_ERROR', failed };
  const search = verifications.find((v) => !v.npi && v.status === 'NOT_VERIFIED');
  if (search) return { kind: 'NO_NPI_STATED', candidates: parseCandidates(search.mismatches) };
  const notFound = verifications.filter((v) => v.status === 'NOT_FOUND').map((v) => v.npi);
  if (notFound.length) return { kind: 'NOT_FOUND', npis: notFound };
  return { kind: 'MISMATCH', npis: verifications.map((v) => v.npi).filter(Boolean) };
}

/** Headline and explanation shown above the NPI entry bar. */
export function npiNeedMessage(need: NpiNeed): {
  severity: 'success' | 'info' | 'warning' | 'error';
  title: string;
  detail: string;
} {
  switch (need.kind) {
    case 'VERIFIED': {
      // Several NPIs: name the one that matched; the others not matching does not undo the verification.
      const others = need.others.length
        ? ` Matched on NPI ${need.matched[0]}; ${need.others.length === 1 ? `the other NPI (${need.others[0]}) does` : `the other ${need.others.length} NPIs (${need.others.join(', ')}) do`} not match, and one match is enough.`
        : '';
      if (need.review.length) {
        return {
          severity: 'warning',
          title: 'NPI verified with differences',
          detail: `The registry record partly matches. Review the differences below, then confirm or reject the match.${others}`,
        };
      }
      return need.byUnderwriter
        ? {
            severity: 'success',
            title: 'NPI confirmed by an underwriter',
            detail: `The registry record differs, and an underwriter reviewed the differences and confirmed the match.${others}`,
          }
        : { severity: 'success', title: 'NPI verified', detail: `The NPI matches the CMS NPI Registry.${others}` };
    }
    case 'NONE_CHECKED':
      return {
        severity: 'info',
        title: 'No NPI checked yet',
        detail: 'Enter the applicant’s NPI to verify it against the CMS NPI Registry.',
      };
    case 'REGISTRY_ERROR':
      return {
        severity: 'error',
        title: 'The registry check failed',
        detail: 'The CMS NPI Registry could not be reached. Re-verify before entering an NPI.',
      };
    case 'NO_NPI_STATED':
      return {
        severity: 'warning',
        title: 'No NPI stated in the submission',
        detail: need.candidates.length
          ? `The registry search found ${need.candidates.length} possible match${need.candidates.length > 1 ? 'es' : ''}. Pick one or enter the NPI.`
          : 'The registry search found no single match. Enter the NPI.',
      };
    case 'NOT_FOUND':
      return {
        severity: 'error',
        title: need.npis.length > 1 ? 'NPIs not in the CMS registry' : 'NPI not in the CMS registry',
        detail: `${need.npis.join(', ')} ${need.npis.length > 1 ? 'are' : 'is'} not in the registry. Check the number or enter the correct NPI.`,
      };
    case 'MISMATCH':
      return {
        severity: 'error',
        title: 'NPI does not match the applicant',
        detail: 'The registry record belongs to someone else. Enter the applicant’s NPI.',
      };
  }
}

export interface RegistryPreview {
  name: string;
  credential: string | null;
  location: string | null;
  taxonomy: string | null;
  active: boolean | null;
}

/** The parts of an NPPES record shown while typing an NPI. Null when the record is missing or unreadable. */
export function registryPreview(record: unknown): RegistryPreview | null {
  const r = record as {
    enumeration_type?: string;
    basic?: {
      first_name?: string;
      last_name?: string;
      organization_name?: string;
      credential?: string;
      status?: string;
    };
    addresses?: { address_purpose?: string; city?: string; state?: string }[];
    taxonomies?: { primary?: boolean; desc?: string }[];
  } | null;
  if (!r?.basic) return null;
  const b = r.basic;
  const name =
    r.enumeration_type === 'NPI-2' || b.organization_name
      ? (b.organization_name ?? '')
      : [b.first_name, b.last_name].filter(Boolean).join(' ');
  if (!name) return null;
  const loc = r.addresses?.find((a) => a.address_purpose === 'LOCATION') ?? r.addresses?.[0];
  const tax = r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];
  return {
    name,
    credential: b.credential || null,
    location: loc ? [loc.city, loc.state].filter(Boolean).join(', ') || null : null,
    taxonomy: tax?.desc ?? null,
    active: b.status ? b.status === 'A' : null,
  };
}
