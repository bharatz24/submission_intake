import { Router } from 'express';
import { z } from 'zod';

import type { AppDeps } from '../../deps.js';
import { currentUser, parseBody, requirePermission } from '../../http.js';
import {
  listSkillRevisions,
  MAX_SKILL_FILE_CHARS,
  readSkillFile,
  resetSkillFile,
  saveSkillFile,
  skillSummaries,
} from '../../services/skillEditor.js';

/** A runtime skill's folder name under backend/skills (e.g. `field-extraction`); anything else is never a skill. */
export const SkillName = z
  .string()
  .max(64, 'Skill names are at most 64 characters')
  .regex(/^[a-z0-9-]+$/, 'Skill names use lowercase letters, digits and hyphens');
const FileQuery = z.object({ path: z.string().min(1).max(200) });
const SaveBody = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(MAX_SKILL_FILE_CHARS),
  baseHash: z.string().min(1),
  note: z.string().trim().max(500).default(''),
});
const ResetBody = z.object({ path: z.string().min(1).max(200), note: z.string().trim().max(500).default('') });

/**
 * Settings → Skills: the runtime skills under backend/skills and their eval scores. Anyone signed in can read them;
 * only skill editors change them (services/skillEditor.ts keeps revisions). Mounted behind requireAuth (app.ts).
 */
export function skillsRouter(_deps: AppDeps): Router {
  const router = Router();
  // A malformed name is a 400; a well-formed one that is not a skill is a 404 (services/skillEditor.ts).
  const name = (value: string | string[] | undefined): string => parseBody(SkillName, value);

  router.get('/skills', (_req, res) => {
    res.json(skillSummaries());
  });

  router.get('/skills/:name/files', (req, res) => {
    res.json(readSkillFile(name(req.params.name), parseBody(FileQuery, req.query).path));
  });

  router.get('/skills/:name/files/revisions', async (req, res) => {
    res.json(await listSkillRevisions(name(req.params.name), parseBody(FileQuery, req.query).path));
  });

  router.put('/skills/:name/files', requirePermission('skill:edit'), async (req, res) => {
    const body = parseBody(SaveBody, req.body);
    res.json(
      await saveSkillFile(
        name(req.params.name),
        body.path,
        body.content,
        body.baseHash,
        body.note,
        currentUser(req).id,
      ),
    );
  });

  router.post('/skills/:name/files/reset', requirePermission('skill:edit'), async (req, res) => {
    const body = parseBody(ResetBody, req.body);
    res.json(await resetSkillFile(name(req.params.name), body.path, body.note, currentUser(req).id));
  });

  return router;
}
