import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { DEBOUNCE_MS, PAGE_SIZE } from '../../../constants';
import type { Classification, DuplicateStrength, InboxView, SubmissionStatus } from '../../../types';
import { VIEWS } from './inboxOptions';

export type InboxPatch = Record<string, string | number | null>;

/**
 * The inbox's tab, filters, search and page, kept in the URL (so a reload or a shared link shows the same list).
 * `search` is the text box; it reaches the URL (`q`) after a short debounce.
 */
export function useInboxParams() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((v) => v.key === params.get('view')) ? params.get('view') : 'submissions') as InboxView;
  const status = (params.get('status') ?? '') as SubmissionStatus | '';
  const classification = (params.get('classification') ?? '') as Classification | '';
  const strength = (params.get('strength') ?? '') as DuplicateStrength | '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const pageSize = Number(params.get('pageSize') ?? String(PAGE_SIZE.inbox)) || PAGE_SIZE.inbox;
  const [search, setSearch] = useState(q);

  // Latest params, so the debounced search below doesn't revert a tab/filter change made while it waited.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const update = (patch: InboxPatch) => {
    const next = new URLSearchParams(paramsRef.current);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => update({ q: search, page: null }), DEBOUNCE_MS.inboxSearch);
    return () => clearTimeout(t);
    // Runs on typing only: `update` reads the latest URL through paramsRef, and a URL change (Back, a tab switch)
    // must not re-fire the debounce with the old text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const clearFilters = () => {
    setSearch('');
    update({ q: null, status: null, classification: null, strength: null, page: null });
  };
  /** The filters the server applies to "mark all read" and "delete all" for this tab. */
  const filters = {
    q: q || undefined,
    status: status || undefined,
    classification: classification || undefined,
    strength: strength || undefined,
  };
  const hasFilters = !!(status || classification || strength || q);

  return {
    view,
    status,
    classification,
    strength,
    q,
    page,
    pageSize,
    search,
    setSearch,
    update,
    clearFilters,
    filters,
    hasFilters,
  };
}

export type InboxParams = ReturnType<typeof useInboxParams>;
