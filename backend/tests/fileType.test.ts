import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { DETECTED, sniffFileType, zipEntryNames } from '../src/services/fileType.js';
import { previewMimeType } from '../src/services/storage.js';
import { detectKind, extractText } from '../src/services/textExtraction.js';

const zip = async (files: Record<string, string | Buffer>, compression: 'STORE' | 'DEFLATE' = 'DEFLATE') => {
  const z = new JSZip();
  for (const [name, body] of Object.entries(files)) z.file(name, body);
  return z.generateAsync({ type: 'nodebuffer', compression });
};
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const docx = () =>
  zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Applicant Jane Smith, NPI 1234567893, Austin TX</w:t></w:r></w:p></w:body></w:document>`,
  });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(12), Buffer.from([40, 0, 0, 0]), Buffer.alloc(8)]);

describe('sniffFileType', () => {
  it('recognises formats by their bytes', async () => {
    expect(sniffFileType(Buffer.from('%PDF-1.7\n...'))).toBe(DETECTED.pdf);
    expect(sniffFileType(Buffer.concat([Buffer.alloc(100, 0x20), Buffer.from('%PDF-1.4')]))).toBe(DETECTED.pdf);
    expect(sniffFileType(PNG)).toBe(DETECTED.png);
    expect(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(DETECTED.jpeg);
    expect(sniffFileType(Buffer.from('GIF89a....'))).toBe(DETECTED.gif);
    expect(sniffFileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(DETECTED.webp);
    expect(sniffFileType(BMP)).toBe(DETECTED.bmp);
    expect(sniffFileType(Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0]))).toBe(DETECTED.tiff);
    expect(sniffFileType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(DETECTED.ole);
    expect(sniffFileType(Buffer.from('Applicant: Jane Smith\r\nNPI 1234567893\n'))).toBe(DETECTED.text);
    expect(sniffFileType(Buffer.from('BMI report: normal'))).toBe(DETECTED.text); // "BM" alone isn't a bitmap
    expect(sniffFileType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBe(DETECTED.unknown); // an .exe
  });

  it("tells Office packages from ordinary zips by the archive's own entries", async () => {
    expect(sniffFileType(await docx())).toBe(DETECTED.docx);
    expect(sniffFileType(await zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' }))).toBe(
      DETECTED.xlsx,
    );
    expect(sniffFileType(await zip({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p/>' }))).toBe(
      DETECTED.ooxml,
    );
    expect(sniffFileType(await zip({ 'a.txt': 'hello' }))).toBe(DETECTED.zip);
    // An uncompressed docx inside an ordinary zip: its part names are visible in the bytes, but it's still a zip.
    const outer = await zip({ 'application.docx': await docx() }, 'STORE');
    expect(zipEntryNames(outer)).toEqual(['application.docx']);
    expect(sniffFileType(outer)).toBe(DETECTED.zip);
  });
});

describe('parser choice', () => {
  it('lets recognised content win over the name and the declared type', async () => {
    expect(detectKind('statement.txt', 'text/plain', DETECTED.pdf)).toBe('pdf');
    expect(detectKind('application.pdf', 'application/pdf', DETECTED.docx)).toBe('docx');
    expect(detectKind('report.pdf', 'application/pdf', DETECTED.ole)).toBe('other');
    // Text or unknown content: the declared type decides, so a corrupt PDF still fails in the PDF reader.
    expect(detectKind('application.pdf', 'application/pdf', DETECTED.text)).toBe('pdf');
    expect(detectKind('notes.txt', '', DETECTED.text)).toBe('text');
  });

  it('reads a Word file named .pdf as Word', async () => {
    const r = await extractText(await docx(), 'application.pdf', 'application/pdf');
    expect(r.status).toBe('EXTRACTED');
    expect(r.text).toContain('Jane Smith');
  });

  it('skips a zip hiding inside a zip under a document name', async () => {
    const inner = await zip({ 'a.txt': 'Applicant: Jane Smith, NPI 1234567893, Austin TX' });
    const r = await extractText(await zip({ 'application.pdf': inner }), 'docs.zip', '');
    expect(r.text).toMatch(/application\.pdf: .*zip inside a zip/);
  });
});

describe('previewMimeType with a detected type', () => {
  it('keeps the old behaviour for files stored before sniffing', () => {
    expect(previewMimeType('app.pdf', 'application/octet-stream', null)).toBe('application/pdf');
  });

  it('previews PDFs and pictures as what their bytes say', () => {
    expect(previewMimeType('scan', 'application/octet-stream', DETECTED.pdf)).toBe('application/pdf');
    expect(previewMimeType('photo.pdf', 'application/pdf', DETECTED.jpeg)).toBe('image/jpeg');
  });

  it('refuses a preview when the bytes contradict a previewable label', () => {
    expect(previewMimeType('app.pdf', 'application/pdf', DETECTED.unknown)).toBeNull();
    expect(previewMimeType('app.pdf', 'application/pdf', DETECTED.text)).toBeNull();
    expect(previewMimeType('page.html', 'text/html', DETECTED.text)).toBeNull();
    expect(previewMimeType('notes.txt', 'text/plain', DETECTED.text)).toBe('text/plain; charset=utf-8');
    expect(previewMimeType('logo.svg', 'image/svg+xml', DETECTED.text)).toBeNull();
  });
});
