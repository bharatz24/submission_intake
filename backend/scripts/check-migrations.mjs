// CI guard for migration hygiene (database-postgres skill): every file is NNN_name.sql, and numbers are unique and
// increase. The two files numbered 007 predate this check and are frozen: renaming an applied migration re-runs it.
import { readdirSync, readFileSync } from 'node:fs';

const FROZEN_DUPLICATES = new Set(['007_email_draft_audience.sql', '007_lookup_reference_tables.sql']);
// Files must be plain ASCII: a database not in UTF8 cannot even parse a non-ASCII comment. These predate the check
// and are frozen, since editing an applied migration changes its checksum.
const FROZEN_NON_ASCII = new Set([
  '011_split_report_max_tokens.sql',
  '012_held_for_classification.sql',
  '020_search_trigram_indexes.sql',
  '021_llm_guardrails.sql',
  '022_llm_transcripts_retention.sql',
]);
const files = readdirSync(new URL('../src/db/migrations/', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const problems = [];
const seen = new Map();
for (const f of files) {
  const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f);
  if (!m) {
    problems.push(`${f}: name must be NNN_snake_case.sql`);
    continue;
  }
  if (seen.has(m[1]) && !(FROZEN_DUPLICATES.has(f) && FROZEN_DUPLICATES.has(seen.get(m[1])))) {
    problems.push(`${f}: number ${m[1]} already used by ${seen.get(m[1])}`);
  }
  seen.set(m[1], f);
  const text = readFileSync(new URL(`../src/db/migrations/${f}`, import.meta.url), 'utf8');
  // eslint-disable-next-line no-control-regex
  if (!FROZEN_NON_ASCII.has(f) && /[^\x00-\x7f]/.test(text)) {
    problems.push(`${f}: use plain ASCII (a non-UTF8 database cannot parse other characters, even in comments)`);
  }
}
const numbers = [...seen.keys()].map(Number);
numbers.forEach((n, i) => {
  if (i > 0 && n !== numbers[i - 1] + 1) problems.push(`gap before ${String(n).padStart(3, '0')}`);
});
if (problems.length) {
  console.error(`Migration check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Migrations OK (${files.length} files)`);
