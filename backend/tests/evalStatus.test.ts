/** Settings → Skills' eval status: read from the committed baseline and the last run, never by running evals. */
import { describe, expect, it } from 'vitest';

import { EVALUATED_SKILLS, skillEvalStatus } from '../src/services/evalStatus.js';

describe('skillEvalStatus', () => {
  it('is null for a skill the eval set does not cover', () => {
    expect(skillEvalStatus('synthesis', '3')).toBeNull();
  });

  it('reports the evaluated skills, with baselineCurrent only when the baseline matches the version in use', () => {
    for (const skill of EVALUATED_SKILLS) {
      const status = skillEvalStatus(skill, 'not-a-real-version')!;
      expect(status).not.toBeNull();
      expect(status.baselineCurrent).toBe(false);
      if (status.baseline)
        expect(Object.keys(status.baseline.scores)).toEqual(['classificationAccuracy', 'fieldRecall', 'evidenceRate']);
    }
  });
});
