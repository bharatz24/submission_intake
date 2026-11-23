/**
 * Deterministic field-level diff of two report `content_json` values of the same kind.
 * Lists of objects are matched by a natural key (title, item, question, …) rather than position,
 * so re-ordering is not a change; strings compare with whitespace collapsed.
 */
export type ChangeType = 'ADDED' | 'REMOVED' | 'MODIFIED';
export interface FieldChange {
  section: string; // top-level key, e.g. "riskIndicators"
  path: string; // e.g. riskIndicators[title="Prior claims"].severity
  changeType: ChangeType;
  before: unknown; // undefined is stored as null
  after: unknown;
}

const KEY_FIELDS = ['title', 'item', 'question', 'description', 'text'] as const;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function equal(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return norm(a) === norm(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => equal(a[k], b[k]));
  }
  return a === b;
}

/** The key a list element is matched on, and how it is shown in the path. */
function itemKey(v: unknown): { key: string; label: string } | null {
  if (typeof v === 'string') return { key: norm(v).toLowerCase(), label: `"${truncate(norm(v), 60)}"` };
  if (isObject(v)) {
    for (const f of KEY_FIELDS) {
      const k = v[f];
      if (typeof k === 'string' && k.trim())
        return { key: `${f}:${norm(k).toLowerCase()}`, label: `${f}="${truncate(norm(k), 60)}"` };
    }
  }
  return null;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function diffReportContent(before: unknown, after: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  walk(before, after, '', '', out);
  return out;
}

function push(
  out: FieldChange[],
  section: string,
  path: string,
  changeType: ChangeType,
  before: unknown,
  after: unknown,
) {
  out.push({ section: section || path, path, changeType, before: before ?? null, after: after ?? null });
}

function walk(a: unknown, b: unknown, path: string, section: string, out: FieldChange[]): void {
  if (a === undefined || a === null) {
    if (b !== undefined && b !== null) push(out, section, path, path ? 'ADDED' : 'MODIFIED', null, b);
    return;
  }
  if (b === undefined || b === null) {
    push(out, section, path, 'REMOVED', a, null);
    return;
  }
  if (isObject(a) && isObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      walk(a[k], b[k], path ? `${path}.${k}` : k, section || k, out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    diffList(a, b, path, section, out);
    return;
  }
  if (!equal(a, b)) push(out, section, path, 'MODIFIED', a, b);
}

function diffList(a: unknown[], b: unknown[], path: string, section: string, out: FieldChange[]): void {
  const keyed = [...a, ...b].every((v) => itemKey(v) !== null);
  if (!keyed) {
    // No natural key: compare by position.
    for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`, section, out);
    return;
  }
  // Queue per key so duplicate keys pair up in order.
  const pending = new Map<string, unknown[]>();
  for (const v of b) {
    const { key } = itemKey(v)!;
    pending.set(key, [...(pending.get(key) ?? []), v]);
  }
  for (const v of a) {
    const { key, label } = itemKey(v)!;
    const match = pending.get(key)?.shift();
    const p = `${path}[${label}]`;
    if (match === undefined) push(out, section, p, 'REMOVED', v, null);
    else if (isObject(v) && isObject(match)) walk(v, match, p, section, out);
    // Matched strings share a normalized key, so they are equal.
  }
  for (const rest of pending.values()) {
    for (const v of rest) push(out, section, `${path}[${itemKey(v)!.label}]`, 'ADDED', null, v);
  }
}
