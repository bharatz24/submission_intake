import { describe, expect, it } from 'vitest';

import type { Field } from '../src/services/fieldExtraction.js';
import type { ZipInfo } from '../src/services/rating/geo.js';
import { addZipCounties, ZIP_LOOKUP_SOURCE } from '../src/services/zipCounty.js';

const field = (fieldName: string, value: string, confidence = 0.95): Field => ({
  fieldName,
  value,
  confidence,
  evidenceQuote: value,
  sourceLabel: 'email body',
  documentId: null,
});

const ZIPS: Record<string, ZipInfo> = {
  '78701': { zip: '78701', city: 'Austin', state: 'TX', counties: [{ name: 'Travis' }] },
  '78681': { zip: '78681', city: 'Round Rock', state: 'TX', counties: [{ name: 'Williamson' }, { name: 'Travis' }] },
  '70112': { zip: '70112', city: 'New Orleans', state: 'LA', counties: [{ name: 'Orleans' }] },
};
const lookup = async (zip: string) => ZIPS[zip.slice(0, 5)] ?? null;
const counties = (fields: Field[]) => fields.filter((f) => f.fieldName === 'practice_county');

describe('county from practice ZIP', () => {
  it('adds the county for a ZIP+4, labelled as a ZIP lookup', async () => {
    const out = counties(
      await addZipCounties([field('practice_zip', '78701-1923'), field('practice_state', 'TX')], lookup),
    );
    expect(out).toEqual([
      expect.objectContaining({
        value: 'Travis County',
        confidence: 0.85,
        sourceLabel: ZIP_LOOKUP_SOURCE,
        documentId: null,
        evidenceQuote: 'ZIP 78701 (practice_zip, email body) → Travis County, TX',
      }),
    ]);
  });

  it('reads the ZIP from the practice address when practice_zip is missing, never the mailing address', async () => {
    expect(counties(await addZipCounties([field('mailing_address', '1 Main St, Austin, TX 78701')], lookup))).toEqual(
      [],
    );
    const out = counties(
      await addZipCounties([field('practice_location', '1313 Red River St, Austin, TX 78701-1923', 0.8)], lookup),
    );
    expect(out.map((f) => [f.value, f.confidence])).toEqual([['Travis County', 0.8]]);
  });

  it('names every county of a multi-county ZIP, with a lower confidence', async () => {
    const [c] = counties(await addZipCounties([field('practice_zip', '78681')], lookup));
    expect(c.value).toBe('Williamson County');
    expect(c.confidence).toBe(0.6);
    expect(c.evidenceQuote).toMatch(/also spans Travis$/);
  });

  it('keeps a stated county and adds nothing when it matches', async () => {
    const fields = [field('practice_zip', '78701'), field('practice_county', 'Travis County')];
    expect(await addZipCounties(fields, lookup)).toBe(fields);
  });

  it('adds the looked-up county beside a stated one that disagrees, so the conflict stays visible', async () => {
    const out = counties(
      await addZipCounties([field('practice_zip', '78701'), field('practice_county', 'Hays')], lookup),
    );
    expect(out.map((f) => f.value)).toEqual(['Hays', 'Travis County']);
  });

  it('skips a ZIP in another state, an unknown ZIP, and repeats of the same ZIP', async () => {
    expect(
      counties(await addZipCounties([field('practice_zip', '78701'), field('practice_state', 'FL')], lookup)),
    ).toEqual([]);
    expect(counties(await addZipCounties([field('practice_zip', '99999')], lookup))).toEqual([]);
    const out = counties(
      await addZipCounties(
        [field('practice_zip', '78701'), field('practice_location', 'Austin, TX 78701-1923')],
        lookup,
      ),
    );
    expect(out).toHaveLength(1);
  });

  it('writes Louisiana counties as parishes', async () => {
    expect(counties(await addZipCounties([field('practice_zip', '70112')], lookup))[0].value).toBe('Orleans Parish');
  });
});
