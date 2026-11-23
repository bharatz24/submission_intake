import {
  lookupNpi,
  type NpiDeps,
  type NpiLookup,
  type NpiSearchClaim,
  type NpiSearchOutcome,
  searchNpi,
} from '../../services/npi.js';

/**
 * The CMS NPPES NPI Registry, as the rest of the app sees it (external-integrations skill: one adapter per system,
 * an interface the app is given rather than a module it imports). The real client keeps everything services/npi.ts
 * does: Zod-checked answers, retries of transient errors with backoff, the 24 h cache. Tests inject a fake through
 * createApp({ npi }) instead of mocking modules.
 */
export interface NpiClient {
  /** The registry record for a 10-digit NPI, `found: false` when there is none. */
  lookup(npi: string): Promise<NpiLookup>;
  /** A registry search by name, state, ZIP and specialty. */
  search(claim: NpiSearchClaim): Promise<NpiSearchOutcome>;
}

export function createNpiClient(deps: NpiDeps = {}): NpiClient {
  return {
    lookup: (npi) => lookupNpi(npi, deps),
    search: (claim) => searchNpi(claim, deps),
  };
}
