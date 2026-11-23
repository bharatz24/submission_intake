/** Settings → Skills routes: the :name path parameter is validated before any skill is looked up (DB-free). */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { AppDeps } from '../src/deps.js';
import { errorHandler } from '../src/errorHandler.js';
import { SkillName, skillsRouter } from '../src/modules/skills/skills.routes.js';

const app = express()
  .use('/api', skillsRouter({} as AppDeps))
  .use(errorHandler);

describe('skill name parameter', () => {
  it('accepts skill folder names only', () => {
    expect(SkillName.safeParse('field-extraction').success).toBe(true);
    for (const bad of ['../etc', 'Field', 'a b', 'x'.repeat(65), '', 'a/b', 'a.md'])
      expect(SkillName.safeParse(bad).success).toBe(false);
  });

  it('answers 400 for a malformed name and 404 for an unknown one', async () => {
    for (const bad of ['..%2F..%2Fsecrets', 'UPPER', 'x'.repeat(65), 'a%00b']) {
      const res = await request(app).get(`/api/skills/${bad}/files?path=SKILL.md`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await request(app).get('/api/skills/no-such-skill/files?path=SKILL.md')).status).toBe(404);
  });
});
