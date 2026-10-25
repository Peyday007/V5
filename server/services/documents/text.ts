/**
 * Plain text, Markdown and pasted text.
 *
 * Line and heading boundaries are the structure these formats have, so they are
 * preserved rather than reflowed. Pasted text is treated identically to an
 * uploaded file — it gets the same identity, the same blocks and the same
 * quality record, because the auditor should not care how the words arrived.
 */
import type { BlockType } from '../../domain/types.ts';
import type { ExtractedBlock, ExtractedPage } from './pdf.ts';

const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const SETEXT_UNDERLINE = /^(=+|-{2,})\s*$/;
const THEMATIC_BREAK = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const FENCE = /^\s*(?:```|~~~)/;

function blockOf(type: BlockType, text: string): ExtractedBlock {
  return { pageNumber: 1, blockType: type, text, bbox: null, warnings: [] };
}

/**
 * Split text into blocks on blank lines, respecting Markdown structure: fenced
 * code stays verbatim, headings and list items stay separate blocks.
 */
export function textToBlocks(source: string, markdown: boolean): ExtractedBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ExtractedBlock[] = [];
  let paragraph: string[] = [];
  let fenced: string[] | null = null;

  const flushParagraph = (): void => {
    const text = paragraph.join(' ').replace(/[ \t]+/g, ' ').trim();
    if (text.length > 0) blocks.push(blockOf('PARAGRAPH', text));
    paragraph = [];
  };

  for (const line of lines) {
    if (markdown && FENCE.test(line)) {
      if (fenced === null) {
        flushParagraph();
        fenced = [];
      } else {
        // Code is evidence too: keep it exactly as written.
        blocks.push(blockOf('CODE', fenced.join('\n')));
        fenced = null;
      }
      continue;
    }
    if (fenced !== null) {
      fenced.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    if (markdown) {
      const atx = ATX_HEADING.exec(line);
      if (atx) {
        flushParagraph();
        blocks.push(blockOf('HEADING', (atx[2] ?? '').trim()));
        continue;
      }
      // Setext: an underline turns the paragraph above it, of any length, into a heading.
      if (SETEXT_UNDERLINE.test(line) && paragraph.length > 0) {
        const text = paragraph.join(' ').replace(/[ \t]+/g, ' ').trim();
        paragraph = [];
        if (text.length > 0) blocks.push(blockOf('HEADING', text));
        continue;
      }
      // A thematic break is a flush and carries no text of its own.
      if (THEMATIC_BREAK.test(line)) {
        flushParagraph();
        continue;
      }
      if (SETEXT_UNDERLINE.test(line) && blocks.at(-1)?.blockType === 'HEADING') continue;
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph();
      blocks.push(blockOf('LIST_ITEM', line.trim()));
      continue;
    }

    paragraph.push(line.trim());
  }

  if (fenced !== null && fenced.length > 0) blocks.push(blockOf('CODE', fenced.join('\n')));
  flushParagraph();
  return blocks;
}

export function extractText(buffer: Buffer, markdown: boolean): { pages: ExtractedPage[] } {
  const source = buffer.toString('utf8');
  const blocks = textToBlocks(source, markdown);
  const characterCount = blocks.reduce((total, block) => total + block.text.length, 0);
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
  };
}
