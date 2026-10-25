/**
 * Format detection.
 *
 * Decided by the bytes, not the extension: a `.pdf` that is actually a Word file
 * must not be handed to the PDF parser, and an extension is a claim rather than
 * evidence. The extension only breaks ties between text-shaped formats.
 */
import type { DocumentFormat } from '../../domain/types.ts';

export interface FormatDetection {
  format: DocumentFormat;
  mimeType: string;
  /** Why this decision was reached, for the import screen and the audit trail. */
  reason: string;
  /** Set when the bytes contradict the filename, which is worth telling the user. */
  extensionMismatch: boolean;
}

const PDF_MAGIC = '%PDF-';
/** DOCX is a ZIP; the OOXML marker sits in the archive's first entry name. */
const ZIP_MAGIC = [0x50, 0x4b];

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

/** UTF-8 text with no NUL bytes and a low share of control characters. */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8_192));
  if (sample.byteLength === 0) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Tab, newline and carriage return are ordinary in text.
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.byteLength < 0.05;
}

function isZip(buffer: Buffer): boolean {
  return buffer[0] === ZIP_MAGIC[0] && buffer[1] === ZIP_MAGIC[1];
}

type OoxmlKind = 'docx' | 'xlsx' | 'pptx' | 'other';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The end-of-central-directory record is 22 bytes plus a comment of up to 65 535. */
const EOCD_SEARCH = 22 + 65_535;

/**
 * The entry names a ZIP declares, read from its central directory.
 *
 * Entry names are structure, not text: matching a substring over raw bytes
 * could be satisfied by compressed payload that happens to spell `xl/`. The
 * central directory lists every entry however large the parts before it are, so
 * it is the one place the answer is exact. Returns null when it cannot be read
 * (truncated, ZIP64, damaged) — unknown is not the same as no entries.
 */
function zipEntryNames(buffer: Buffer): string[] | null {
  const floor = Math.max(0, buffer.byteLength - EOCD_SEARCH);
  let eocd = -1;
  for (let at = buffer.byteLength - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  if (size === 0xffffffff || count === 0xffff || size > eocd) return null;
  const names: string[] = [];
  let at = eocd - size;
  for (let seen = 0; seen < count; seen += 1) {
    if (at + 46 > eocd || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    if (at + 46 + nameLength > eocd) return null;
    names.push(buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * Which OOXML package this ZIP is.
 *
 * `[Content_Types].xml` is in every OOXML package — workbooks and presentations
 * included — so it says nothing about Word. The part folders do: `word/`,
 * `xl/`, `ppt/`, read from the real entry names. A package declares one family,
 * so `word/` is asked first and the others only when it is absent.
 */
function ooxmlKind(buffer: Buffer): OoxmlKind {
  const names = zipEntryNames(buffer);
  if (!names) return 'other';
  if (names.some((name) => name.startsWith('word/'))) return 'docx';
  if (names.some((name) => name.startsWith('xl/'))) return 'xlsx';
  if (names.some((name) => name.startsWith('ppt/'))) return 'pptx';
  return 'other';
}

export function detectFormat(filename: string, buffer: Buffer): FormatDetection {
  const extension = extensionOf(filename);
  const head = buffer.subarray(0, 8).toString('latin1');

  if (head.startsWith(PDF_MAGIC)) {
    return {
      format: 'PDF',
      mimeType: 'application/pdf',
      reason: 'The file begins with the %PDF- signature.',
      extensionMismatch: extension !== 'pdf',
    };
  }

  if (isZip(buffer)) {
    const kind = ooxmlKind(buffer);
    if (kind === 'docx') {
      return {
        format: 'DOCX',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        reason: 'The file is an OOXML package containing a word/ part.',
        extensionMismatch: extension !== 'docx',
      };
    }
    if (kind === 'xlsx' || kind === 'pptx') {
      const spreadsheet = kind === 'xlsx';
      return {
        format: 'UNSUPPORTED',
        mimeType: spreadsheet
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        reason:
          `The file is an OOXML ${kind} package (${spreadsheet ? 'a spreadsheet' : 'a presentation'}). ` +
          'Brain reads PDF, DOCX, TXT and Markdown, not this; the original is preserved unchanged.',
        extensionMismatch: false,
      };
    }
    return {
      format: 'UNSUPPORTED',
      mimeType: 'application/zip',
      reason:
        'The file is a ZIP archive but not a Word document. Brain reads PDF, DOCX, TXT and ' +
        'Markdown; the original is preserved unchanged.',
      extensionMismatch: false,
    };
  }

  if (looksLikeText(buffer)) {
    const markdown = extension === 'md' || extension === 'markdown';
    return {
      format: markdown ? 'MARKDOWN' : 'TEXT',
      mimeType: markdown ? 'text/markdown' : 'text/plain',
      reason: markdown
        ? 'The file is text and carries a Markdown extension.'
        : 'The file is plain text.',
      extensionMismatch: false,
    };
  }

  return {
    format: 'UNSUPPORTED',
    mimeType: 'application/octet-stream',
    reason:
      `Brain does not know how to read this file (extension "${extension || 'none'}", ` +
      'binary content). The original is preserved and remains visibly unreadable.',
    extensionMismatch: false,
  };
}

/** Formats whose text Brain can actually extract. */
export function isReadableFormat(format: DocumentFormat): boolean {
  return format !== 'UNSUPPORTED';
}
