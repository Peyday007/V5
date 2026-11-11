import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';
import { textToBlocks } from '../server/services/documents/text.ts';
import { extractPdf } from '../server/services/documents/pdf.ts';
import { buildPdf, prosePage } from './fixtures/pdf.ts';

const REJOIN_NOTE = 'rejoined hyphenated line breaks';

describe('normalizeBlockText keeps real hyphens (§9)', () => {
  it('leaves suspended hyphens before a space untouched', () => {
    const text = 'pre- and post-closing inspections; short- or long-term leases';
    const result = normalizeBlockText(text);
    expect(result.text).toBe(text);
    expect(result.notes).not.toContain(REJOIN_NOTE);
  });

  it('rejoins a hard hyphen across a newline', () => {
    const result = normalizeBlockText('recog-\nnition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('rejoins a hard hyphen across a CRLF with surrounding spaces', () => {
    const result = normalizeBlockText('recog- \r\n nition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('still joins a soft hyphen before a space', () => {
    const result = normalizeBlockText('recog\u00ad nition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN_NOTE);
  });
});

/*
 * What extraction actually hands normalization. A review found the cases above
 * asserted a state production could not produce: every extractor joined a
 * block's lines with a space and collapsed whitespace before normalization, so
 * no block ever carried the newline the hard-hyphen rule needs, and a word
 * hyphenated across two lines stayed split. Extractors now keep a block's lines
 * as lines; these cases feed normalization exactly what an extractor produced.
 */

describe('normalization of what the extractors produce (§9)', () => {
  it('a text paragraph keeps its source lines, so a word hyphenated across them is rejoined', () => {
    const [block] = textToBlocks('The interme-\ndiation layer covers pre- and post-closing\ninspections.', false);
    expect(block!.text).toBe('The interme-\ndiation layer covers pre- and post-closing\ninspections.');
    const result = normalizeBlockText(block!.text);
    expect(result.text).toBe('The intermediation layer covers pre- and post-closing inspections.');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('a PDF paragraph keeps its lines, so a hyphenated line break is rejoined and a suspended hyphen survives', async () => {
    const pdf = buildPdf([
      prosePage('Terms', [['Short- or long-term leases follow the interme-', 'diation rules for every party.']]),
    ]);
    const extraction = await extractPdf(pdf);
    const block = extraction.pages[0]!.blocks.find((b) => b.blockType === 'PARAGRAPH')!;
    expect(block.text).toBe('Short- or long-term leases follow the interme-\ndiation rules for every party.');
    const result = normalizeBlockText(block.text);
    expect(result.text).toBe('Short- or long-term leases follow the intermediation rules for every party.');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('joins wrapped lines with a space unless the block keeps line breaks as content', () => {
    expect(normalizeBlockText('first line\nsecond line').text).toBe('first line second line');
    expect(normalizeBlockText('const a = 1;\nconst b = 2;', { preserveLineBreaks: true }).text).toBe('const a = 1;\nconst b = 2;');
  });
});
