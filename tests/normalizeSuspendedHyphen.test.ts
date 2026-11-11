import { describe, expect, it } from 'vitest';
import { joinExtractedLines, normalizeBlockText } from '../server/services/documents/normalize.ts';
import { textToBlocks } from '../server/services/documents/text.ts';

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

describe('hyphenated line breaks survive extraction to reach normalization (§9)', () => {
  it('rejoins a word hyphenated across lines of a text paragraph', () => {
    const [block] = textToBlocks('The recog-\nnition of revenue is deferred.\n', false);
    expect(block?.text).toBe('The recog-\nnition of revenue is deferred.');
    const result = normalizeBlockText(block?.text ?? '');
    expect(result.text).toBe('The recognition of revenue is deferred.');
    expect(result.notes).toContain(REJOIN_NOTE);
  });

  it('keeps suspended hyphens in a multi-line paragraph', () => {
    const [block] = textToBlocks('pre- and post-closing\ninspections; short- or long-term leases\n', false);
    const result = normalizeBlockText(block?.text ?? '');
    expect(result.text).toBe('pre- and post-closing inspections; short- or long-term leases');
    expect(result.notes).not.toContain(REJOIN_NOTE);
  });

  it('joins other line boundaries with a single space, as before', () => {
    expect(joinExtractedLines(['First  line', '  Second line ', '', 'third-', 'Fourth'])).toBe(
      'First line Second line third- Fourth',
    );
    expect(joinExtractedLines(['ends in a digit 3-', 'next'])).toBe('ends in a digit 3- next');
    expect(joinExtractedLines(['recog-', 'nition'])).toBe('recog-\nnition');
  });
});
