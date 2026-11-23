import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Effort } from './claude.js';

export const SKILLS_ROOT = path.resolve(process.env.SKILLS_PATH ?? 'skills');

export interface LoadedSkill {
  name: string; // folder name, e.g. "synthesis"
  version: string; // "<frontmatter version>+<content hash>"
  files: string[];
  systemPrompt: string; // SKILL.md first, then companion files
  model?: string; // frontmatter `model:`; per-task env vars override it
  effort?: Effort; // frontmatter `effort:`; falls back to the caller's default
  overridden: string[]; // files whose content comes from a Settings edit, not disk
}

/**
 * Skill files edited in Settings, keyed "<skill>/<file>" (services/skillEditor.ts keeps this in step with
 * skill_file_revisions). Held in memory so loadSkill stays synchronous.
 */
let overrides = new Map<string, string>();
export function setSkillOverrides(next: Map<string, string>): void {
  overrides = next;
}
export const skillOverride = (name: string, file: string) => overrides.get(`${name}/${file}`);

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Load a skill folder. SKILL.md is the entry point; companion .md files (top level, then
 * `references/`) are appended in name order. The version combines the declared semver with
 * a hash of all file contents, so any edit to a skill file yields a new, traceable skill
 * version on every report. A file edited in Settings uses its override instead of the disk copy;
 * `pending` previews unsaved content the same way (used to validate an edit before saving it).
 */
export function loadSkill(name: string, root = SKILLS_ROOT, pending: Record<string, string | null> = {}): LoadedSkill {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
  const dir = path.join(root, name);
  const entry = path.join(dir, 'SKILL.md');
  if (!existsSync(entry)) throw new Error(`Skill not found: ${name}`);

  const mdIn = (sub: string) => {
    const d = path.join(dir, sub);
    return existsSync(d)
      ? readdirSync(d)
          .filter((f) => f.endsWith('.md'))
          .sort()
          .map((f) => (sub ? `${sub}/${f}` : f))
      : [];
  };
  const companions = [...mdIn('').filter((f) => f !== 'SKILL.md'), ...mdIn('references')];
  const files = ['SKILL.md', ...companions];
  const hash = createHash('sha256');
  const sections: string[] = [];
  const overridden: string[] = [];
  // pending: string = unsaved content, null = the disk default; otherwise a saved Settings edit, if any.
  const contentOf = (file: string) => {
    const edited = file in pending ? pending[file] : root === SKILLS_ROOT ? skillOverride(name, file) : undefined;
    if (edited != null) overridden.push(file);
    return (edited ?? readFileSync(path.join(dir, file), 'utf8')).replace(/\r\n/g, '\n');
  };
  let entryText = '';
  for (const file of files) {
    const text = contentOf(file);
    if (file === 'SKILL.md') entryText = text;
    hash.update(file).update('\0').update(text).update('\0');
    sections.push(
      file === 'SKILL.md' ? stripFrontmatter(text) : `<skill_file name="${file}">\n${text.trim()}\n</skill_file>`,
    );
  }
  const head = frontmatter(entryText);
  const effort = head.effort as Effort | undefined;
  if (effort && !EFFORTS.includes(effort)) throw new Error(`Skill ${name}: invalid effort "${effort}"`);
  return {
    name,
    version: `${head.version ?? '0.0.0'}+${hash.digest('hex').slice(0, 10)}`,
    files,
    systemPrompt: sections.join('\n\n'),
    model: head.model,
    effort,
    overridden,
  };
}

/**
 * `key: value` pairs from the leading frontmatter block; `#` lines are comments. Keys nested
 * under the standard `metadata:` map (e.g. `  version: 1.0.0`) are flattened alongside top-level ones.
 */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^\s*([a-z_]+):\s*(.+)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].trim();
  }
  return out;
}

export function listSkills(root = SKILLS_ROOT): LoadedSkill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'SKILL.md')))
    .map((d) => loadSkill(d.name, root));
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}
