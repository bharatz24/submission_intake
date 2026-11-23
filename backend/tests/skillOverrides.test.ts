import { afterEach, describe, expect, it } from 'vitest';

import { loadSkill, setSkillOverrides } from '../src/services/skills.js';

describe('skill overrides', () => {
  afterEach(() => setSkillOverrides(new Map()));

  it('uses a Settings edit instead of the disk file, with a new version', () => {
    const disk = loadSkill('workspace-chat');
    expect(disk.overridden).toEqual([]);
    setSkillOverrides(
      new Map([
        [
          'workspace-chat/SKILL.md',
          '---\nname: workspace-chat\nmetadata:\n  version: 9.9.9\n  effort: low\n---\nEdited instructions',
        ],
      ]),
    );
    const edited = loadSkill('workspace-chat');
    expect(edited.overridden).toEqual(['SKILL.md']);
    expect(edited.systemPrompt).toContain('Edited instructions');
    expect(edited.version).toMatch(/^9\.9\.9\+/);
    expect(edited.effort).toBe('low');
    setSkillOverrides(new Map());
    expect(loadSkill('workspace-chat').version).toBe(disk.version);
  });

  it('previews pending content, where null means the disk default', () => {
    setSkillOverrides(new Map([['workspace-chat/SKILL.md', '---\nname: x\n---\nEdited']]));
    const disk = loadSkill('workspace-chat', undefined, { 'SKILL.md': null });
    expect(disk.overridden).toEqual([]);
    expect(disk.systemPrompt).not.toContain('Edited');
    expect(() => loadSkill('workspace-chat', undefined, { 'SKILL.md': '---\neffort: turbo\n---\nHi' })).toThrow(
      /invalid effort/,
    );
  });
});
