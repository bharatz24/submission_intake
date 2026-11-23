/** Zip-bomb and image-size guards in text extraction. No database; fixtures are generated in memory. */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { extractText, imageSize, zipBombCheck } from '../src/services/textExtraction.js';

const MB = 1024 * 1024;

async function zip(files: Record<string, Buffer | string>): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, data] of Object.entries(files)) z.file(name, data);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

describe('zip bomb guard for DOCX/XLSX', () => {
  it('rejects a part that inflates past the per-entry limit, without reading the file', async () => {
    const bomb = await zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': Buffer.alloc(30 * MB) });
    expect(bomb.length).toBeLessThan(MB); // ~30 KB on disk
    const r = await extractText(bomb, 'application.docx', '');
    expect(r).toMatchObject({ status: 'UNSUPPORTED', text: '' });
    expect(r.error).toMatch(/expands past 25 MB/);
  });

  it('rejects an expansion ratio only a zip bomb has', async () => {
    const parts = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`xl/worksheets/sheet${i + 1}.xml`, Buffer.alloc(5 * MB)]),
    );
    const r = await zipBombCheck(await zip(parts), 1000);
    expect(r?.status).toBe('UNSUPPORTED');
    expect(r?.error).toMatch(/more than 100 times/);
  });

  it('rejects too many parts', async () => {
    const parts = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}.xml`, 'x']));
    expect((await zipBombCheck(await zip(parts), 20))?.error).toMatch(/30 parts/);
  });

  it('lets an ordinary file through', async () => {
    expect(
      await zipBombCheck(await zip({ 'word/document.xml': '<w:document>Applicant: Jane Smith</w:document>' }), 1000),
    ).toBeNull();
  });
});

describe('imageSize', () => {
  it('reads PNG, GIF and JPEG headers', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(40000, 16);
    png.writeUInt32BE(30000, 20);
    expect(imageSize(png)).toEqual({ width: 40000, height: 30000 });

    const gif = Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 16, height: 32 });

    // SOI, an APP0 segment of length 4, then SOF0 with height 600, width 800.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600 });
  });

  it('returns null for unknown data', () => {
    expect(imageSize(Buffer.from('not an image at all'))).toBeNull();
  });

  it('refuses to OCR an image over the pixel limit', async () => {
    const png = Buffer.alloc(64);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(100_000, 16);
    png.writeUInt32BE(100_000, 20);
    const r = await extractText(png, 'scan.png', 'image/png');
    expect(r.status).toBe('ERROR');
    expect(r.error).toMatch(/too large to OCR/);
  });
});
