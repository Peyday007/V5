// @vitest-environment jsdom
/** Magic Deck Lab in the shell: routes resolve on reload, the six primaries are untouched. */
import { describe, expect, it } from 'vitest';
import { parseRoute, pathFor } from '../client/src/lib/router.ts';
import { SECTIONS } from '../client/src/russell/RussellShell.tsx';
import { MAGIC_SECTIONS } from '../client/src/lib/magicApi.ts';

describe('magic routes', () => {
  it('resolves /magic and every subsection, and round-trips the path', () => {
    expect(parseRoute('/magic')).toEqual({ name: 'MAGIC', section: null });
    for (const section of MAGIC_SECTIONS) {
      const route = parseRoute(`/magic/${section}`);
      expect(route).toEqual({ name: 'MAGIC', section });
      expect(pathFor(route)).toBe(`/magic/${section}`);
    }
    expect(pathFor({ name: 'MAGIC', section: null })).toBe('/magic');
  });
  it('does not guess at an unknown subsection', () => {
    expect(parseRoute('/magic/nonsense').name).toBe('NOT_FOUND');
    expect(parseRoute('/magic/decks/extra').name).toBe('NOT_FOUND');
  });
});

describe('magic navigation', () => {
  it('is a secondary entry; the six primaries are unchanged', () => {
    const magic = SECTIONS.find((s) => s.name === 'MAGIC');
    expect(magic?.label).toBe('Magic');
    expect(magic?.primary).toBe(false);
    expect(SECTIONS.filter((s) => s.primary).map((s) => s.label)).toEqual([
      'Home', 'Cash', 'Research', 'Build', 'Needs you', 'Workforce',
    ]);
  });
});
