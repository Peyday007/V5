import { describe, expect, it } from 'vitest';
import { contentTypeFor, safeSegment } from '../server/services/storage/keys.ts';

describe('safeSegment keeps the extension when it truncates', () => {
  it('a 250-character .pdf name stays within 180 and still ends .pdf', () => {
    const segment = safeSegment(`${'a'.repeat(246)}.pdf`);
    expect(segment.length).toBeLessThanOrEqual(180);
    expect(segment.endsWith('.pdf')).toBe(true);
    expect(contentTypeFor(segment)).toBe('application/pdf');
  });

  it('a ~193-character "... 2026 edition.pdf" keeps .pdf', () => {
    const name = `${'records sources '.repeat(11)}2026 edition.pdf`;
    expect(name.length).toBeGreaterThan(180);
    const segment = safeSegment(name);
    expect(segment.length).toBeLessThanOrEqual(180);
    expect(segment.endsWith('.pdf')).toBe(true);
  });

  it('names within the limit are returned unchanged', () => {
    expect(safeSegment('Opportunity Research v1.pdf')).toBe('Opportunity Research v1.pdf');
    const edge = `${'b'.repeat(176)}.pdf`;
    expect(edge.length).toBe(180);
    expect(safeSegment(edge)).toBe(edge);
  });

  it('a very long extension or none is still bounded', () => {
    expect(safeSegment(`name.${'x'.repeat(300)}`).length).toBeLessThanOrEqual(180);
    expect(safeSegment('c'.repeat(300)).length).toBe(180);
  });

  it('re-strips trailing dots and spaces from the truncated stem', () => {
    const name = `${'d'.repeat(174)} . .pdf`;
    const segment = safeSegment(name);
    expect(segment.length).toBeLessThanOrEqual(180);
    expect(segment.endsWith('.pdf')).toBe(true);
    expect(segment.slice(0, -4)).not.toMatch(/[-.\s]$/);
  });
});
