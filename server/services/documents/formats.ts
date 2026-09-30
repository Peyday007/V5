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

/**
 * Which OOXML package this ZIP is.
 *
 * `[Content_Types].xml` is in every OOXML package — workbooks and presentations
 * included — so it says nothing about Word. The part folders do: `word/`,
 * `xl/`, `ppt/`. Entry order is not guaranteed, so the names are looked for in
 * the first 4 KB (local headers) and in the last 64 KB, where the central
 * directory lists every entry however large the parts before it are.
 */
function ooxmlKind(buffer: Buffer): OoxmlKind {
  const head = buffer.subarray(0, Math.min(buffer.byteLength, 4_096)).toString('latin1');
  const tail = buffer.subarray(Math.max(0, buffer.byteLength - 65_536)).toString('latin1');
  const names = `${head}\n${tail}`;
  if (names.includes('xl/')) return 'xlsx';
  if (names.includes('ppt/')) return 'pptx';
  if (names.includes('word/')) return 'docx';
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
