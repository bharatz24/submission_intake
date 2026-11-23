/**
 * File type from content ("magic bytes"), not from the sender's MIME type or the file name. Stored as
 * documents.detected_type at ingest; it decides which parser reads a file and whether it may be previewed inline.
 */

export const DETECTED = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  /** Another Office Open XML package (pptx, xlsm without a workbook part, …): not read. */
  ooxml: 'application/x-ooxml',
  zip: 'application/zip',
  /** Legacy Office / Outlook .msg compound file: not read. */
  ole: 'application/x-ole-storage',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  text: 'text/plain',
  /** Sniffed, and none of the above. */
  unknown: 'application/octet-stream',
} as const;
export type DetectedType = (typeof DETECTED)[keyof typeof DETECTED];

/** PDF readers accept the header anywhere in the first 1024 bytes. */
const PDF_HEADER_WINDOW = 1024;
/** Bytes inspected to decide whether a file is plain text. */
const TEXT_SNIFF_BYTES = 8192;
/** Share of control characters (other than tab, newline, CR, form feed, ESC) above which a file isn't text. */
const TEXT_MAX_CONTROL_RATIO = 0.02;

const BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const startsWith = (data: Buffer, bytes: number[], offset = 0) =>
  data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);

function looksLikeText(data: Buffer): boolean {
  const head = data.subarray(0, TEXT_SNIFF_BYTES);
  let control = 0;
  for (const b of head) {
    if (b === 0) return false; // binary, or UTF-16 (which the text reader can't decode anyway)
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++;
  }
  return control <= head.length * TEXT_MAX_CONTROL_RATIO;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
/** End-of-central-directory record: 22 bytes plus a comment of up to 65535. */
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
/** Enough to find an Office package's marker parts; the rest of a big archive isn't listed. */
const ZIP_NAMES_MAX = 2000;

/**
 * Names of the archive's own top-level entries, from its central directory, or null when it can't be read.
 * (A substring search would also see the names inside a stored, uncompressed docx sitting in an ordinary zip.)
 */
export function zipEntryNames(data: Buffer): string[] | null {
  const from = Math.max(0, data.length - EOCD_SEARCH);
  let eocd = -1;
  for (let i = data.length - EOCD_MIN; i >= from; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = data.readUInt16LE(eocd + 10);
  let p = data.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < Math.min(count, ZIP_NAMES_MAX); n++) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== CENTRAL_ENTRY_SIGNATURE) return null;
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    if (p + 46 + nameLen > data.length) return null;
    names.push(data.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** An Office Open XML package is a zip with a [Content_Types].xml part at its root. */
function zipType(data: Buffer): DetectedType {
  const names = new Set(zipEntryNames(data) ?? []);
  if (!names.has('[Content_Types].xml')) return DETECTED.zip;
  if (names.has('word/document.xml')) return DETECTED.docx;
  if (names.has('xl/workbook.xml')) return DETECTED.xlsx;
  return DETECTED.ooxml;
}

export function sniffFileType(data: Buffer): DetectedType {
  if (data.subarray(0, PDF_HEADER_WINDOW).includes('%PDF-')) return DETECTED.pdf;
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) return zipType(data);
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return DETECTED.ole;
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return DETECTED.png;
  if (startsWith(data, [0xff, 0xd8, 0xff])) return DETECTED.jpeg;
  if (data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a')
    return DETECTED.gif;
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP')
    return DETECTED.webp;
  // "BM" alone would match text starting with those letters: also require a known DIB header size.
  if (startsWith(data, [0x42, 0x4d]) && data.length >= 18 && BMP_DIB_HEADER_SIZES.has(data.readUInt32LE(14)))
    return DETECTED.bmp;
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) return DETECTED.tiff;
  return looksLikeText(data) ? DETECTED.text : DETECTED.unknown;
}
