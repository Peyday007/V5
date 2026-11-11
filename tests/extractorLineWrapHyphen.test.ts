/**
 * A word hyphenated across a line break reaches normalisation with the break
 * kept, in every extractor, so `normalizeBlockText` rejoins it; a suspended
 * hyphen within one line ("pre- and post-closing") stays exactly as written.
 * normalize.ts is unchanged (PR #748): it rejoins only across a real newline.
 */
import { describe, expect, it } from 'vitest';
import { collapseBlockWhitespace, joinBlockLines, layoutPage, type PdfTextItem } from '../server/services/documents/pdf.ts';
import { blocksFromTsv, type TsvRow } from '../server/services/documents/ocr.ts';
import { ocrBlocksFor } from '../server/services/documents/extraction.ts';
import { textToBlocks } from '../server/services/documents/text.ts';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const normalized = (text: string): string => normalizeBlockText(text).text;

function item(text: string, y: number): PdfTextItem {
  return { text, x: 72, y, width: text.length * 5, height: 10 };
}

function word(line: number, left: number, text: string): TsvRow {
  return { level: 5, block: 1, paragraph: 1, line, left, top: line * 20, width: 40, height: 14, confidence: 95, text };
}

function ocrParagraph(lines: string[][]): TsvRow[] {
  const rows: TsvRow[] = [
    { level: 3, block: 1, paragraph: 1, line: 0, left: 0, top: 0, width: 400, height: 20 * lines.length, confidence: -1, text: '' },
  ];
  lines.forEach((words, index) => {
    rows.push({ level: 4, block: 1, paragraph: 1, line: index + 1, left: 0, top: (index + 1) * 20, width: 400, height: 14, confidence: -1, text: '' });
    words.forEach((text, position) => rows.push(word(index + 1, position * 50, text)));
  });
  return rows;
}

describe('line-wrap hyphen across extractors', () => {
  it('A01: a PDF paragraph keeps the wrap as a newline, and normalisation rejoins the word', () => {
    const page = layoutPage(1, [item('the recog-', 700), item('nition rule', 688)], 612, 792);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]!.text).toBe('the recog-\nnition rule');
    expect(normalized(page.blocks[0]!.text)).toBe('the recognition rule');
  });

  it('A01: a PDF paragraph still joins ordinary lines with a space', () => {
    const page = layoutPage(1, [item('the first', 700), item('second line', 688)], 612, 792);
    expect(page.blocks[0]!.text).toBe('the first second line');
  });

  it('A02: a plain-text paragraph wrapped by a hyphen is rejoined', () => {
    for (const markdown of [false, true]) {
      const [block] = textToBlocks('the recog-\nnition rule', markdown);
      expect(block!.text).toBe('the recog-\nnition rule');
      expect(normalized(block!.text)).toBe('the recognition rule');
    }
  });

  it('A02: an OCR paragraph whose first line ends "recog-" is rejoined (structured TSV)', () => {
    const [block] = blocksFromTsv(ocrParagraph([['the', 'recog-'], ['nition', 'rule']]), 1000, 300);
    expect(block!.text).toBe('the recog-\nnition rule');
    expect(normalized(block!.text)).toBe('the recognition rule');
  });

  it('A02: an OCR page read as text only is rejoined', () => {
    const [block] = ocrBlocksFor({ pageNumber: 1, text: 'the recog-\nnition rule\n\nnext paragraph', confidence: 0.9, warnings: [] }, 'note');
    expect(block!.text).toBe('the recog-\nnition rule');
    expect(normalized(block!.text)).toBe('the recognition rule');
  });

  it('A02: a suspended hyphen within one line is unchanged in every extractor', () => {
    const line = 'pre- and post-closing';
    const pdf = layoutPage(1, [item(line, 700)], 612, 792).blocks[0]!.text;
    const text = textToBlocks(line, false)[0]!.text;
    const markdown = textToBlocks(line, true)[0]!.text;
    const tsv = blocksFromTsv(ocrParagraph([['pre-', 'and', 'post-closing']]), 1000, 300)[0]!.text;
    const ocrText = ocrBlocksFor({ pageNumber: 1, text: line, confidence: 0.9, warnings: [] }, 'note')[0]!.text;
    for (const extracted of [pdf, text, markdown, tsv, ocrText]) {
      expect(extracted).toBe(line);
      expect(normalized(extracted)).toBe(line);
    }
  });

  it('A02: only the last word of an OCR line is treated as a possible wrap', () => {
    // Only the last word of a line can be a wrap; a hyphen mid-line is never turned into a break.
    const [block] = blocksFromTsv(ocrParagraph([['short-', 'or', 'long-'], ['term', 'plans']]), 1000, 300);
    expect(block!.text).toBe('short- or long-\nterm plans');
  });

  it('joins and collapses only what a line wrap is', () => {
    expect(joinBlockLines(['a recog-  ', 'nition'])).toBe('a recog-\nnition');
    expect(joinBlockLines(['ends in a digit 3-', 'next'])).toBe('ends in a digit 3- next');
    expect(joinBlockLines(['one', 'two'])).toBe('one two');
    expect(collapseBlockWhitespace('a  recog- \n\t nition   rule\nnext')).toBe('a recog-\nnition rule next');
    expect(collapseBlockWhitespace('pre-   and post')).toBe('pre- and post');
  });
});
