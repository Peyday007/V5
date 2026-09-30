import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const NOTE = 'rejoined hyphenated line breaks';

describe('suspended hyphens are not line breaks', () => {
  it('leaves real hyphens before a space alone', () => {
    const input = 'pre- and post-closing inspections; short- or long-term leases';
    const out = normalizeBlockText(input);
    expect(out.text).toBe(input);
    expect(out.notes).not.toContain(NOTE);
  });

  it('rejoins a hard hyphen across a newline', () => {
    const out = normalizeBlockText('recog-\nnition');
    expect(out.text).toBe('recognition');
    expect(out.notes).toContain(NOTE);
  });

  it('still joins a soft hyphen before a space', () => {
    const out = normalizeBlockText('intermedi\u00ad ation');
    expect(out.text).toBe('intermediation');
    expect(out.notes).toContain(NOTE);
  });
});
