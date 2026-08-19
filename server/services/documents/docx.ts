/**
 * DOCX extraction.
 *
 * mammoth converts the OOXML into semantic HTML, which preserves exactly what
 * section 7 asks for: heading hierarchy, paragraphs, lists, tables, captions and
 * section order. We walk that HTML into blocks rather than flattening it, so a
 * heading stays a heading and a table row stays one row.
 *
 * mammoth also reports what it could not convert. Those become extraction
 * warnings — never silent discards — because an assignment that depends on an
 * embedded object Brain cannot read is not audit-ready.
 */
import type { BlockType } from '../../domain/types.ts';
import type { ExtractedBlock, ExtractedPage } from './pdf.ts';

export class DocxUnreadableError extends Error {
  readonly reason: string;
  readonly recovery: string;

  constructor(reason: string, recovery: string) {
    super(reason);
    this.name = 'DocxUnreadableError';
    this.reason = reason;
    this.recovery = recovery;
  }
}

export interface DocxExtraction {
  /** DOCX has no fixed pagination, so the whole document is one logical page. */
  pages: ExtractedPage[];
  warnings: string[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const BLOCK_PATTERN =
  /<(h[1-6]|p|li|table|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;

function blockTypeFor(tag: string, text: string): BlockType {
  const lower = tag.toLowerCase();
  if (lower.startsWith('h')) return 'HEADING';
  if (lower === 'li') return 'LIST_ITEM';
  if (lower === 'table') return 'TABLE';
  if (lower === 'pre') return 'CODE';
  // Word captions are ordinary paragraphs styled as captions; the text usually says so.
  if (/^(figure|table|exhibit)\s+\d+/i.test(text)) return 'CAPTION';
  return 'PARAGRAPH';
}

/** Flatten a table to one block per row, so cell boundaries survive as separators. */
function tableRows(html: string): string[] {
  const rows: string[] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row = rowPattern.exec(html);
  while (row !== null) {
    const cells: string[] = [];
    const cellPattern = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cell = cellPattern.exec(row[1] ?? '');
    while (cell !== null) {
      cells.push(stripTags(cell[1] ?? ''));
      cell = cellPattern.exec(row[1] ?? '');
    }
    if (cells.some((value) => value.length > 0)) rows.push(cells.join(' | '));
    row = rowPattern.exec(html);
  }
  return rows;
}

/** Turn mammoth's HTML into ordered blocks. */
export function htmlToBlocks(html: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  let match = BLOCK_PATTERN.exec(html);
  while (match !== null) {
    const tag = (match[1] ?? 'p').toLowerCase();
    const inner = match[2] ?? '';

    if (tag === 'table') {
      for (const row of tableRows(inner)) {
        blocks.push({ pageNumber: 1, blockType: 'TABLE', text: row, bbox: null, warnings: [] });
      }
    } else {
      const text = stripTags(inner);
      if (text.length > 0) {
        blocks.push({
          pageNumber: 1,
          blockType: blockTypeFor(tag, text),
          text,
          bbox: null,
          warnings: [],
        });
      }
    }
    match = BLOCK_PATTERN.exec(html);
  }
  return blocks;
}

export async function extractDocx(buffer: Buffer): Promise<DocxExtraction> {
  let mammoth: { convertToHtml: (input: { buffer: Buffer }) => Promise<MammothResult> };
  try {
    mammoth = (await import('mammoth')) as unknown as typeof mammoth;
  } catch (error) {
    throw new DocxUnreadableError(
      'The DOCX reader could not be loaded.',
      `Reinstall dependencies (npm install). ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }

  let result: MammothResult;
  try {
    result = await mammoth.convertToHtml({ buffer });
  } catch (error) {
    throw new DocxUnreadableError(
      `The DOCX could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      'The file may be corrupt or password-protected. Re-save it from Word and import again.',
    );
  }

  const blocks = htmlToBlocks(result.value ?? '');
  const characterCount = blocks.reduce((total, block) => total + block.text.length, 0);

  // Anything mammoth could not convert is surfaced, never dropped in silence.
  const warnings = (result.messages ?? [])
    .filter((message) => message.type === 'warning' || message.type === 'error')
    .map((message) => `DOCX: ${message.message}`);

  return {
    pages: [
      {
        pageNumber: 1,
        blocks,
        characterCount,
        itemCount: blocks.length,
        width: 0,
        height: 0,
        signals: {
          characterDensity: characterCount > 0 ? 1 : 0,
          columnCount: 1,
          hasReplacementGlyphs: false,
          nearlyEmpty: characterCount < 40,
        },
      },
    ],
    warnings,
  };
}

interface MammothResult {
  value: string;
  messages: { type: string; message: string }[];
}
