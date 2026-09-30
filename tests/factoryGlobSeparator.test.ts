/**
 * `**` followed by a separator keeps the separator.
 *
 * `src/**` + `/*.ts` used to compile to `src(?:/.*)?[^/]*\.ts`, so a unit owning
 * `src/**` + `/*.ts` was judged to own `srcevil.ts` — a file outside the directory
 * it declared — and `a/**` + `/b` matched `ab`. The glob decides whether a diff
 * stayed inside a unit's owned paths and whether a path is forbidden.
 */
import { describe, expect, it } from 'vitest';
import { matchesGlob } from '../server/services/factory/glob.ts';

describe('a glob with ** in the middle', () => {
  it('does not match a sibling path that merely shares the prefix', () => {
    expect(matchesGlob('srcevil.ts', 'src/**/*.ts')).toBe(false);
    expect(matchesGlob('ab', 'a/**/b')).toBe(false);
  });

  it('still matches zero or more directories between', () => {
    expect(matchesGlob('src/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/x/y.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('a/b', 'a/**/b')).toBe(true);
    expect(matchesGlob('a/x/y/b', 'a/**/b')).toBe(true);
    expect(matchesGlob('b', '**/b')).toBe(true);
    expect(matchesGlob('x/b', '**/b')).toBe(true);
  });

  it('keeps a trailing /** owning the directory itself', () => {
    expect(matchesGlob('a', 'a/**')).toBe(true);
    expect(matchesGlob('a/b/c', 'a/**')).toBe(true);
    expect(matchesGlob('ab', 'a/**')).toBe(false);
  });
});
