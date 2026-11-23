import { describe, expect, it } from 'vitest';

import { gmailMessageUrl, isValidNpi, npiRegistryUrl, remarkLinkify, splitLinks } from './links';

describe('link helpers', () => {
  it('validates the NPI check digit', () => {
    expect(isValidNpi('1234567893')).toBe(true);
    expect(isValidNpi('1234567890')).toBe(false);
    expect(isValidNpi('123456789')).toBe(false);
    expect(isValidNpi('12345678a3')).toBe(false);
  });

  it('builds registry and Gmail URLs', () => {
    expect(npiRegistryUrl('1234567893')).toBe('https://npiregistry.cms.hhs.gov/provider-view/1234567893');
    expect(gmailMessageUrl('18c2f')).toBe('https://mail.google.com/mail/u/0/#all/18c2f');
  });

  it('links valid NPIs and emails in free text', () => {
    expect(splitLinks('NPI 1234567893 deactivated; contact broker@agency.com.')).toEqual([
      { text: 'NPI ' },
      { text: '1234567893', href: npiRegistryUrl('1234567893') },
      { text: ' deactivated; contact ' },
      { text: 'broker@agency.com', href: 'mailto:broker@agency.com' },
      { text: '.' },
    ]);
  });

  it('leaves invalid NPIs, longer numbers, and dashed IDs plain', () => {
    for (const t of ['call 1234567890', 'acct 12345678931', 'id 1234567893-01', 'no links here']) {
      expect(splitLinks(t)).toEqual([{ text: t }]);
    }
  });

  it('linkifies markdown text nodes but not existing links or code', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'NPI 1234567893' },
            { type: 'inlineCode', value: '1234567893' },
            { type: 'link', url: 'x', children: [{ type: 'text', value: '1234567893' }] },
          ],
        },
      ],
    };
    remarkLinkify()(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: 'text', value: 'NPI ' },
      { type: 'link', url: npiRegistryUrl('1234567893'), children: [{ type: 'text', value: '1234567893' }] },
      { type: 'inlineCode', value: '1234567893' },
      { type: 'link', url: 'x', children: [{ type: 'text', value: '1234567893' }] },
    ]);
  });
});
