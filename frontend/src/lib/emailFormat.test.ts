import { describe, expect, it } from 'vitest';

import { applyFormat, remarkHighlight, toMarkdown } from './emailFormat';

describe('applyFormat', () => {
  it('wraps a selection in bold and unwraps it again', () => {
    const r = applyFormat('Send loss runs', 5, 14, 'bold');
    expect(r.value).toBe('Send **loss runs**');
    expect(applyFormat(r.value, 5, r.value.length, 'bold').value).toBe('Send loss runs');
  });
  it('inserts a highlighted placeholder when nothing is selected', () => {
    const r = applyFormat('', 0, 0, 'highlight');
    expect(r.value).toBe('==text==');
    expect(r.value.slice(r.start, r.end)).toBe('text');
  });
  it('numbers and bullets every touched line, and toggles off', () => {
    const n = applyFormat('a\nb', 0, 3, 'number');
    expect(n.value).toBe('1. a\n2. b');
    expect(applyFormat(n.value, 0, n.value.length, 'number').value).toBe('a\nb');
    expect(applyFormat('a\n\nb', 0, 4, 'bullet').value).toBe('- a\n\n- b');
  });
  it('switches a bullet line to a heading', () => {
    expect(applyFormat('- Documents', 0, 0, 'heading').value).toBe('## Documents');
  });
  it('inserts a table as its own paragraph', () => {
    const r = applyFormat('Hi\n', 3, 3, 'table');
    expect(r.value).toMatch(/^Hi\n\n\| Item \| Details \|\n\| --- \| --- \|/);
  });
});

describe('toMarkdown', () => {
  it('turns legacy bullets into list items and keeps line breaks', () => {
    expect(toMarkdown('Hi Mark,\nThanks.\n\n• Loss runs\n• Application')).toBe(
      'Hi Mark,  \nThanks.\n\n- Loss runs\n- Application',
    );
  });
});

describe('remarkHighlight', () => {
  it('turns ==text== into a mark node', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'by ==Friday== please' }] }],
    };
    remarkHighlight()(tree);
    const kids = (tree.children[0] as { children: { type: string; data?: { hName: string } }[] }).children;
    expect(kids.map((k) => k.type)).toEqual(['text', 'emphasis', 'text']);
    expect(kids[1]?.data?.hName).toBe('mark');
  });
});
