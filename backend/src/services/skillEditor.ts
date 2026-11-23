// Skill files viewed and edited in Settings. backend/skills/ on disk is the shipped default; an edit is stored
// as a skill_file_revisions row and overrides that file for every later loadSkill() (see services/skills.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MAX_SKILL_FILE_CHARS, SKILL_OVERRIDES_RESYNC_MS } from '../constants.js';
import { pool } from '../db/pool.js';
import { AppError, notFound } from '../http.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';
import { skillEvalStatus } from './evalStatus.js';
import { notify } from './pgListen.js';
import { listSkills, type LoadedSkill, loadSkill, setSkillOverrides, skillOverride, SKILLS_ROOT } from './skills.js';
import { createSyncedSetting } from './syncedSetting.js';
export { MAX_SKILL_FILE_CHARS } from '../constants.js';

const hashOf = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

/** Rebuild the in-memory overrides from the newest revision of each file (startup, and after every change). */
export async function refreshSkillOverrides(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (skill_name, file_path) skill_name, file_path, content
     FROM skill_file_revisions ORDER BY skill_name, file_path, id DESC`,
  );
  setSkillOverrides(
    new Map(rows.filter((r) => r.content !== null).map((r) => [`${r.skill_name}/${r.file_path}`, r.content as string])),
  );
}

const CHANNEL = 'skill_overrides';
const sync = createSyncedSetting({
  channel: CHANNEL,
  refresh: refreshSkillOverrides,
  resyncMs: SKILL_OVERRIDES_RESYNC_MS,
  name: 'skill override',
});

/**
 * Keep this instance's overrides in step with edits saved on any instance (NOTIFY, plus a periodic re-read). The
 * first load is server.ts's refreshSkillOverrides(), so this does not load again.
 */
export const startSkillOverrideSync = (): Promise<void> => sync.start({ initial: false });
export const stopSkillOverrideSync = (): void => sync.stop();
/** RUNTIME=netlify: re-read when older than SYNCED_SETTING_MAX_AGE_MS (no LISTEN there). */
export const ensureSkillOverridesFresh = (): Promise<void> => sync.ensureFresh();

export function skillSummaries() {
  // `eval`: the recorded eval scores for the skills the eval set covers (null for the others), so an admin editing a
  // prompt sees whether the version in use was evaluated.
  return listSkills().map((s) => ({
    name: s.name,
    version: s.version,
    files: s.files,
    overridden: s.overridden,
    eval: skillEvalStatus(s.name, s.version),
  }));
}

/** The skill and the disk text of one of its files; only files the skill already has can be read or edited. */
function resolve(name: string, file: string): { skill: LoadedSkill; diskContent: string } {
  let skill: LoadedSkill;
  try {
    skill = loadSkill(name);
  } catch {
    throw notFound('Skill');
  }
  if (!skill.files.includes(file)) throw notFound('Skill file');
  return { skill, diskContent: readFileSync(path.join(SKILLS_ROOT, name, file), 'utf8').replace(/\r\n/g, '\n') };
}

export function readSkillFile(name: string, file: string) {
  const { skill, diskContent } = resolve(name, file);
  const content = skillOverride(name, file)?.replace(/\r\n/g, '\n') ?? diskContent;
  return {
    skill: name,
    path: file,
    content,
    defaultContent: diskContent,
    overridden: skill.overridden.includes(file),
    hash: hashOf(content),
    skillVersion: skill.version,
  };
}

/** The skill as it would load with this file's content (null = disk default); throws 400 if that would not load. */
function validated(name: string, file: string, content: string | null): LoadedSkill {
  if (content !== null) {
    if (!content.trim()) throw new AppError('VALIDATION_ERROR', 400, 'A skill file cannot be empty');
    if (content.length > MAX_SKILL_FILE_CHARS)
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `A skill file is limited to ${MAX_SKILL_FILE_CHARS.toLocaleString('en-US')} characters`,
      );
    if (file === 'SKILL.md' && !/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(content)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'SKILL.md must keep its frontmatter block (--- name, description, version … ---)',
      );
    }
  }
  try {
    return loadSkill(name, SKILLS_ROOT, { [file]: content });
  } catch (err) {
    throw new AppError('VALIDATION_ERROR', 400, err instanceof Error ? err.message : String(err));
  }
}

async function record(
  name: string,
  file: string,
  content: string | null,
  note: string,
  actorId: string,
  action: string,
) {
  const before = loadSkill(name).version;
  const after = validated(name, file, content);
  await pool.query(
    `INSERT INTO skill_file_revisions (skill_name, file_path, content, content_hash, skill_version, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [name, file, content, hashOf(content ?? readSkillFile(name, file).defaultContent), after.version, note, actorId],
  );
  await refreshSkillOverrides();
  await notify(CHANNEL).catch((err) =>
    logger.warn({ err }, 'skill override NOTIFY failed; other instances resync within minutes'),
  );
  await audit({
    action,
    entityType: 'skill',
    entityId: `${name}/${file}`,
    actorId,
    details: { skill: name, file, note, versionBefore: before, versionAfter: after.version },
  });
  return readSkillFile(name, file);
}

/**
 * Save an edit. `baseHash` is the hash the editor opened; if the file changed since, 409 so nobody overwrites
 * someone else's edit unseen. Saving the disk text exactly is recorded as a reset, so no stale override lingers.
 */
export async function saveSkillFile(
  name: string,
  file: string,
  content: string,
  baseHash: string,
  note: string,
  actorId: string,
) {
  const current = readSkillFile(name, file);
  if (current.hash !== baseHash) {
    throw new AppError(
      'CONFLICT',
      409,
      'This file was changed by someone else since you opened it. Reload to see the latest version.',
    );
  }
  const text = content.replace(/\r\n/g, '\n');
  if (text === current.content) return current;
  const isDefault = text === current.defaultContent;
  return record(
    name,
    file,
    isDefault ? null : text,
    note,
    actorId,
    isDefault ? 'SKILL_FILE_RESET' : 'SKILL_FILE_UPDATED',
  );
}

export async function resetSkillFile(name: string, file: string, note: string, actorId: string) {
  const current = readSkillFile(name, file);
  if (!current.overridden) return current;
  return record(name, file, null, note, actorId, 'SKILL_FILE_RESET');
}

export async function listSkillRevisions(name: string, file: string) {
  resolve(name, file);
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS created_by_name FROM skill_file_revisions r LEFT JOIN users u ON u.id=r.created_by
     WHERE r.skill_name=$1 AND r.file_path=$2 ORDER BY r.id DESC LIMIT 100`,
    [name, file],
  );
  return rows.map((r) => ({
    id: String(r.id),
    reset: r.content === null,
    content: r.content as string | null,
    hash: r.content_hash,
    skillVersion: r.skill_version,
    note: r.note,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? '' } : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
