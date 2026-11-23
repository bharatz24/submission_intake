// Table sorting helpers shared by client-sorted tables and server-sorted (paged) ones.
export type SortOrder = 'asc' | 'desc';
export interface SortState<K extends string> {
  key: K;
  order: SortOrder;
}

/** Header click: flip the order on the active column, otherwise start the new column at `first`. */
export function nextSort<K extends string>(cur: SortState<K>, key: K, first: SortOrder = 'asc'): SortState<K> {
  return cur.key === key ? { key, order: cur.order === 'asc' ? 'desc' : 'asc' } : { key, order: first };
}

/** Stable copy sorted by `value`; numbers compare numerically, text case-insensitively, nulls always last. */
export function sortRows<T>(
  rows: readonly T[],
  value: (row: T) => string | number | null | undefined,
  order: SortOrder,
): T[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), undefined, { sensitivity: 'base', numeric: true }) * dir;
  });
}
