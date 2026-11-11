/**
 * §9: normalisation removes only extraction artifacts. A suspended hyphen on one
 * line ("pre- and post-closing") is the author's text, not a line break, and
 * must survive; a hyphen that ends a line, and a soft hyphen, are artifacts.
 */
import { describe, expect, it } from 'vitest';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';

const REJOIN = 'rejoined hyphenated line breaks';

describe('suspended hyphens are not line breaks', () => {
  it('A01: leaves suspended hyphens on one line unchanged and records no rejoin', () => {
    const input = 'pre- and post-closing inspections; short- or long-term leases';
    const result = normalizeBlockText(input);
    expect(result.text).toBe(input);
    expect(result.notes).not.toContain(REJOIN);
  });

  it('keeps a hyphen followed by spaces or tabs but no newline', () => {
    const result = normalizeBlockText('first-\tand second- \t order effects');
    expect(result.text).toBe('first- and second- order effects');
    expect(result.notes).not.toContain(REJOIN);
  });

  it('A02: rejoins a word split by a hyphen across a line break, with the note', () => {
    const result = normalizeBlockText('recog-\nnition');
    expect(result.text).toBe('recognition');
    expect(result.notes).toContain(REJOIN);
  });

  it('rejoins across a CRLF break with surrounding spaces or tabs', () => {
    const result = normalizeBlockText('intermedi- \t\r\n  ation');
    expect(result.text).toBe('intermediation');
    expect(result.notes).toContain(REJOIN);
  });

  it('A02: still joins a soft hyphen across ordinary whitespace', () => {
    const result = normalizeBlockText('co\u00ad operate');
    expect(result.text).toBe('cooperate');
    expect(result.notes).toContain(REJOIN);
  });

  it('does not rejoin before a capital letter on the next line', () => {
    const result = normalizeBlockText('Jean-\nPaul');
    expect(result.text).toBe('Jean-\nPaul');
    expect(result.notes).not.toContain(REJOIN);
  });
});
