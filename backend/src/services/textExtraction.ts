import path from 'node:path';

import type { JSZipObject } from 'jszip';

import { config } from '../config.js';
import {
  EXTRACTED_TEXT_MAX_CHARS,
  OOXML_MAX_ENTRIES,
  PDF_OCR_SCALE,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_RATIO,
  ZIP_MAX_TOTAL_BYTES,
  ZIP_RATIO_FLOOR_BYTES,
  ZIP_TEXT_BUDGET,
} from '../constants.js';
import { logger } from '../logger.js';
import { DETECTED, type DetectedType, sniffFileType } from './fileType.js';
import { limits } from './limitsSettings.js';

/** The Settings → Limits values extraction reads; passed in when it runs in a worker thread (no settings there). */
export interface ExtractionLimits {
  uploadMaxFileMb: number;
  ocrMaxPages: number;
}
export const extractionLimits = (): ExtractionLimits => ({
  uploadMaxFileMb: limits().uploadMaxFileMb,
  ocrMaxPages: limits().ocrMaxPages,
});

/** One part of a zip may be as large as one uploaded file. */
const zipMaxEntryBytes = (lim: ExtractionLimits) => lim.uploadMaxFileMb * 1024 * 1024;

export type ExtractionStatus = 'EXTRACTED' | 'OCR_EXTRACTED' | 'UNREADABLE' | 'UNSUPPORTED' | 'ERROR';

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  ocrUsed: boolean;
  pageCount: number | null;
  error?: string;
  /** The OCR worker timed out or crashed: nothing is wrong with the file, so a later run may read it. */
  transient?: boolean;
}

const ZIP_CLUTTER = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'image' | 'text' | 'zip' | 'other';

/** Parser for a type recognised from the file's own bytes; null for text or unknown content. */
function kindFromContent(detected: DetectedType): FileKind | null {
  switch (detected) {
    case DETECTED.pdf:
      return 'pdf';
    case DETECTED.docx:
      return 'docx';
    case DETECTED.xlsx:
      return 'xlsx';
    case DETECTED.zip:
      return 'zip';
    case DETECTED.ooxml:
    case DETECTED.ole:
      return 'other';
    case DETECTED.png:
    case DETECTED.jpeg:
    case DETECTED.gif:
    case DETECTED.webp:
    case DETECTED.bmp:
    case DETECTED.tiff:
      return 'image';
    default:
      return null;
  }
}

/**
 * Which parser reads a file. A binary signature recognised in the content wins over the sender's MIME type and the
 * file name, so a mislabelled file never reaches another format's parser. For text or unrecognised content the
 * declared type decides (a corrupt "PDF" still goes to the PDF reader and fails there with ERROR).
 */
export function detectKind(filename: string, mimeType: string, detected?: DetectedType | null): FileKind {
  const fromContent = detected ? kindFromContent(detected) : null;
  if (fromContent) return fromContent;
  const ext = path.extname(filename).toLowerCase();
  if (mimeType === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (ext === '.docx' || mimeType.includes('wordprocessingml')) return 'docx';
  if (ext === '.xlsx' || mimeType.includes('spreadsheetml')) return 'xlsx';
  if (ext === '.zip' || mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') return 'zip';
  if (
    mimeType.startsWith('image/') ||
    ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp'].includes(ext)
  )
    return 'image';
  if (mimeType.startsWith('text/') || ['.txt', '.csv', '.md', '.eml'].includes(ext)) return 'text';
  return 'other';
}

/**
 * Text of one file; never throws. Runs in the calling thread: the pipeline goes through extractionPool.ts, which runs
 * it in a worker thread with a memory limit and a hard timeout.
 */
export async function extractText(
  data: Buffer,
  filename: string,
  mimeType: string,
  lim: ExtractionLimits = extractionLimits(),
  /** For the log line only: logs carry the document id, never the filename (it often names the applicant). */
  documentId?: string,
): Promise<ExtractionResult> {
  const kind = detectKind(filename, mimeType, sniffFileType(data));
  try {
    switch (kind) {
      case 'pdf':
        return await extractPdf(data, lim);
      case 'docx': {
        const rejected = await zipBombCheck(data, OOXML_MAX_ENTRIES, lim);
        if (rejected) return rejected;
        const mammoth = await import('mammoth');
        const { value } = await withTimeout(
          mammoth.extractRawText({ buffer: data }),
          config.EXTRACTION_TIMEOUT_MS,
          'DOCX extraction',
        );
        return done(value, false, null);
      }
      case 'xlsx':
        return (
          (await zipBombCheck(data, OOXML_MAX_ENTRIES, lim)) ??
          (await withTimeout(extractXlsx(data), config.EXTRACTION_TIMEOUT_MS, 'XLSX extraction'))
        );
      case 'image':
        return done(await ocr(data), true, 1);
      case 'text':
        return done(data.toString('utf8'), false, null);
      case 'zip':
        return await extractZip(data, lim);
      default:
        return { status: 'UNSUPPORTED', text: '', ocrUsed: false, pageCount: null };
    }
  } catch (err) {
    logger.warn({ err, documentId, kind }, 'extraction failed');
    return {
      status: 'ERROR',
      text: '',
      ocrUsed: false,
      pageCount: null,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof OcrWorkerError ? { transient: true } : {}),
    };
  }
}

function done(text: string, ocrUsed: boolean, pageCount: number | null): ExtractionResult {
  const clean = text
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, EXTRACTED_TEXT_MAX_CHARS);
  const readable = clean.replace(/[^A-Za-z0-9]/g, '').length >= 20;
  return {
    status: readable ? (ocrUsed ? 'OCR_EXTRACTED' : 'EXTRACTED') : 'UNREADABLE',
    text: clean,
    ocrUsed,
    pageCount,
  };
}

async function extractPdf(data: Buffer, lim: ExtractionLimits): Promise<ExtractionResult> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await withTimeout(parser.getText(), config.EXTRACTION_TIMEOUT_MS, 'PDF text extraction');
    const text = result.text ?? '';
    const pages = result.total ?? null;
    if (text.replace(/\s/g, '').length >= 50) return done(text, false, pages);
    // Scanned PDF: rasterise pages one by one, each scaled down to fit OCR_MAX_PIXELS (a page may declare any size).
    const ocrPages = lim.ocrMaxPages;
    const info = await withTimeout(
      parser.getInfo({ parsePageInfo: true, first: ocrPages }),
      config.EXTRACTION_TIMEOUT_MS,
      'PDF page info',
    );
    const parts: string[] = [];
    const deadline = Date.now() + config.EXTRACTION_TIMEOUT_MS;
    for (let n = 1; n <= Math.min(ocrPages, info.total); n++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`PDF OCR timed out after ${config.EXTRACTION_TIMEOUT_MS} ms`);
      const page = info.pages?.find((p) => p.pageNumber === n);
      const area = page && page.width > 0 && page.height > 0 ? page.width * page.height : null;
      const scale = area ? Math.min(PDF_OCR_SCALE, Math.sqrt(config.OCR_MAX_PIXELS / area)) : 1;
      const shot = await withTimeout(
        parser.getScreenshot({ partial: [n], scale, imageDataUrl: false, imageBuffer: true }),
        left,
        'PDF page rendering',
      );
      for (const img of shot.pages) parts.push(await ocr(Buffer.from(img.data)));
    }
    return done(parts.join('\n\n'), true, pages);
  } finally {
    await parser.destroy();
  }
}

async function extractXlsx(data: Buffer): Promise<ExtractionResult> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as any);
  const out: string[] = [];
  wb.eachSheet((sheet) => {
    out.push(`## Sheet: ${sheet.name}`);
    sheet.eachRow((row) => {
      const values = (row.values as unknown[]).slice(1).map(cellText);
      if (values.some((v) => v !== '')) out.push(values.join(' | '));
    });
  });
  return done(out.join('\n'), false, wb.worksheets.length);
}

interface ZipItem {
  name: string;
  status: ExtractionStatus;
  text: string;
  ocrUsed: boolean;
  skipped?: string; // Why the file was not read at all.
  error?: string;
}

/** Text of every readable file in the zip, under a contents list that states what was skipped or cut. */
async function extractZip(data: Buffer, lim: ExtractionLimits): Promise<ExtractionResult> {
  const JSZip = (await import('jszip')).default;
  const archive = await JSZip.loadAsync(data);
  const entries = Object.values(archive.files).filter((e) => !e.dir && !ZIP_CLUTTER.test(e.name));

  const items: ZipItem[] = [];
  let bytesLeft = ZIP_MAX_TOTAL_BYTES;
  for (const entry of entries.slice(0, ZIP_MAX_ENTRIES)) {
    const name = zipEntryLabel(entry.name);
    const skip = (status: ExtractionStatus, skipped: string): ZipItem => ({
      name,
      status,
      text: '',
      ocrUsed: false,
      skipped,
    });
    const kind = detectKind(entry.name, '');
    if (kind === 'zip') items.push(skip('UNSUPPORTED', 'zip inside a zip'));
    else if (kind === 'other') items.push(skip('UNSUPPORTED', 'unsupported file type'));
    else if (bytesLeft <= 0) items.push(skip('UNREADABLE', 'zip too large'));
    else {
      const inflated = await inflateEntry(entry, Math.min(zipMaxEntryBytes(lim), bytesLeft));
      bytesLeft -= inflated.bytes;
      if (!inflated.data) items.push(skip('UNREADABLE', 'too large'));
      // Named like a document but really a zip: still no nested archives.
      else if (sniffFileType(inflated.data) === DETECTED.zip) items.push(skip('UNSUPPORTED', 'zip inside a zip'));
      else items.push({ name, ...(await extractText(inflated.data, entry.name, '', lim)) });
    }
  }

  const read = items.filter(isRead);
  const reserved = 200 + items.reduce((sum, i) => sum + 2 * i.name.length + 60, 0); // Contents list and headers.
  const shares = fairShares(
    read.map((i) => i.text.length),
    ZIP_TEXT_BUDGET - reserved,
  );
  const shareOf = new Map(read.map((item, n) => [item, shares[n]!]));

  const contents = items.map((i) => `- ${i.name}: ${zipItemNote(i, shareOf.get(i))}`);
  const left = entries.length - items.length;
  if (left > 0)
    contents.push(`- ${left} more file${left === 1 ? '' : 's'} not read (limit of ${ZIP_MAX_ENTRIES} per zip)`);
  const sections = read.map((i) => `--- ${i.name} ---\n${i.text.slice(0, shareOf.get(i))}`);

  return {
    status: zipStatus(items),
    text: [`Zip contents:\n${contents.join('\n')}`, ...sections].join('\n\n'),
    ocrUsed: read.some((i) => i.ocrUsed),
    pageCount: null,
    error: items.find((i) => i.error)?.error,
  };
}

function isRead(item: ZipItem): boolean {
  return item.status === 'EXTRACTED' || item.status === 'OCR_EXTRACTED';
}

function zipStatus(items: ZipItem[]): ExtractionStatus {
  const read = items.filter(isRead);
  if (read.length) return read.some((i) => i.ocrUsed) ? 'OCR_EXTRACTED' : 'EXTRACTED';
  if (items.some((i) => i.status === 'ERROR')) return 'ERROR';
  if (items.length && items.every((i) => i.status === 'UNSUPPORTED')) return 'UNSUPPORTED';
  return 'UNREADABLE';
}

function zipItemNote(item: ZipItem, share: number | undefined): string {
  if (item.skipped) return `not read (${item.skipped})`;
  if (item.status === 'ERROR') return 'not read (could not be opened)';
  if (share === undefined) return 'not read (no readable text)';
  return share < item.text.length ? `read, cut to ${share} of ${item.text.length} characters` : 'read';
}

/** Entry names come from the sender: keep them from adding lines or tags to the text the model reads. */
function zipEntryLabel(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
      .trim()
      .slice(0, 200)
  );
}

/** Splits `budget` evenly; what a short text doesn't use passes to the longer ones. */
function fairShares(lengths: number[], budget: number): number[] {
  const shares: number[] = new Array(lengths.length).fill(0);
  const shortestFirst = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  let left = budget;
  shortestFirst.forEach((i, position) => {
    const share = Math.min(lengths[i]!, Math.floor(left / (lengths.length - position)));
    shares[i] = share;
    left -= share;
  });
  return shares;
}

/**
 * Inflates an entry, counting real bytes: the sizes in a zip's headers are written by the sender.
 * `data` is null once `limit` is passed. Pausing stops the inflate, as the stream only produces while being read.
 * `keep: false` only counts (data is then an empty buffer when within the limit).
 */
function inflateEntry(entry: JSZipObject, limit: number, keep = true): Promise<{ data: Buffer | null; bytes: number }> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream();
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        stream.removeAllListeners('data');
        stream.pause();
        resolve({ data: null, bytes });
        return;
      }
      if (keep) chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), bytes }));
  });
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, any>;
    if ('result' in o) return cellText(o.result);
    if ('text' in o) return String(o.text);
    if ('richText' in o) return o.richText.map((r: any) => r.text).join('');
    return JSON.stringify(o);
  }
  return String(v);
}

/**
 * Inflates a zip-based file (DOCX/XLSX) entry by entry, counting real bytes without keeping them, and returns an
 * UNSUPPORTED result when it breaks a limit: too many entries, an entry or the total too large, or an expansion
 * ratio only a zip bomb has. Null when the file may be parsed.
 */
export async function zipBombCheck(
  data: Buffer,
  maxEntries: number,
  lim: ExtractionLimits = extractionLimits(),
): Promise<ExtractionResult | null> {
  const reject = (why: string): ExtractionResult => ({
    status: 'UNSUPPORTED',
    text: '',
    ocrUsed: false,
    pageCount: null,
    error: `File not read: ${why}`,
  });
  const JSZip = (await import('jszip')).default;
  const archive = await JSZip.loadAsync(data);
  const entries = Object.values(archive.files).filter((e) => !e.dir);
  if (entries.length > maxEntries) return reject(`it holds ${entries.length} parts (limit ${maxEntries})`);
  let total = 0;
  const maxEntryBytes = zipMaxEntryBytes(lim);
  for (const entry of entries) {
    const { data: ok, bytes } = await inflateEntry(entry, Math.min(maxEntryBytes, ZIP_MAX_TOTAL_BYTES - total), false);
    if (!ok) {
      return reject(
        bytes > maxEntryBytes
          ? `a part expands past ${maxEntryBytes / 1024 / 1024} MB`
          : `it expands past ${ZIP_MAX_TOTAL_BYTES / 1024 / 1024} MB`,
      );
    }
    total += bytes;
    if (total > ZIP_RATIO_FLOOR_BYTES && total / data.length > ZIP_MAX_RATIO) {
      return reject(`it expands more than ${ZIP_MAX_RATIO} times its size (likely a zip bomb)`);
    }
  }
  return null;
}

/** Rejects after `ms`. The work itself is not stopped, so callers free what they can (parser, OCR worker). */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Width and height from a PNG, JPEG, GIF, BMP or WebP header; null for other formats or a truncated header. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8')
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM')
    return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { width: 1 + (v & 0x3fff), height: 1 + ((v >>> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the first start-of-frame marker.
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** OCR failed in the worker (timeout, crash), not because of the image. */
export class OcrWorkerError extends Error {}

// One Tesseract worker per process, created on first use. Dropped (and terminated) after any failure or timeout,
// so a crashed or stuck worker is replaced on the next call instead of failing every later OCR.
// Calls take turns (ocrQueue): the worker would queue them internally anyway, and then a timeout would count the
// wait behind other jobs' pages and terminating the worker would kill their in-flight OCR. Taking turns here, the
// timeout measures only this call's recognize and only the active call can ever terminate the worker.
let workerPromise: Promise<any> | null = null;
let ocrQueue: Promise<unknown> = Promise.resolve();
async function ocr(image: Buffer): Promise<string> {
  const size = imageSize(image);
  if (size && size.width * size.height > config.OCR_MAX_PIXELS) {
    throw new Error(`Image too large to OCR (${size.width}x${size.height} pixels, limit ${config.OCR_MAX_PIXELS})`);
  }
  const turn = ocrQueue.then(() => ocrNow(image));
  ocrQueue = turn.catch(() => undefined);
  return turn;
}

async function ocrNow(image: Buffer): Promise<string> {
  const current = (workerPromise ??= import('tesseract.js').then((t) =>
    t.createWorker('eng', undefined, { cachePath: config.OCR_DATA_PATH }),
  ));
  try {
    const worker = await current;
    const { data } = await withTimeout<{ data: { text: string } }>(
      worker.recognize(image),
      config.OCR_TIMEOUT_MS,
      'OCR',
    );
    return data.text;
  } catch (err) {
    if (workerPromise === current) workerPromise = null;
    void current.then((w) => w.terminate()).catch(() => undefined);
    throw new OcrWorkerError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

/** Stop the OCR worker (graceful shutdown). */
export async function stopOcr(): Promise<void> {
  const current = workerPromise;
  workerPromise = null;
  await current?.then((w) => w.terminate()).catch(() => undefined);
}
