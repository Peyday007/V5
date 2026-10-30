/**
 * Path globs, as the factory reads them.
 *
 * Its own module because two different questions ask it — whether a diff stayed
 * inside what a unit owns (`integrate.ts`), and whether it reached something no
 * unit may own (`forbidden.ts`) — and the second is asked from inside the
 * first. Kept in `integrate.ts` it would be an import cycle.
 */
import path from 'node:path';

/**
 * Does this path match this glob?
 *
 * `**` crosses directory separators, `*` does not, `?` is one character. Small
 * and exact rather than a dependency, because the answer decides whether a
 * worker's diff is accepted and a surprising matcher would be a surprising
 * rejection.
 */
export function matchesGlob(candidate: string, glob: string): boolean {
  const normalise = (value: string): string => value.split(path.sep).join('/').replace(/^\.\//, '');
  const target = normalise(candidate);
  const pattern = normalise(glob);

  if (pattern === '**' || pattern === '*') return true;

  let regex = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // `**/` is zero or more whole directories, and the separator after it
        // stays required: `src/**/*.ts` owns `src/a.ts` and `src/x/y.ts` and
        // never `srcevil.ts`. Folding that separator into the optional part —
        // which the trailing case below does on purpose — let `a/**/b` match
        // `ab`, a file outside the directory a unit declared.
        regex += '(?:.*/)?';
        i += 2;
      } else if (regex.endsWith('/') && i + 2 >= pattern.length) {
        // A trailing `a/**` owns `a` itself as well as everything under it,
        // which is what a reader of the glob expects and what a
        // directory-owning unit means by it.
        regex = `${regex.slice(0, -1)}(?:/.*)?`;
        i += 1;
      } else {
        regex += '.*';
        i += 1;
      }
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else if (char && '\\^$.|+()[]{}'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  // A pattern naming a directory owns everything under it.
  const asDirectory = pattern.endsWith('/') ? `${regex}.*` : `${regex}(/.*)?`;
  return new RegExp(`^${asDirectory}$`).test(target);
}


/**
 * Does a unit that owns this glob own this file?
 *
 * `matchesGlob`, plus one equivalence: a migration's number is a position in a
 * sequence other campaigns also take from, not part of what the unit owns. A
 * plan names `server/db/migrations/133_x.sql` because 133 was free when it
 * planned; if 131 is free when the unit runs, `131_x.sql` is the same file at
 * its right position. Without this, the only number a unit could write was the
 * one it planned, a gap failed the repository's own tests, and on 2026-10-30
 * three campaigns spent every attempt being told to renumber a file they were
 * not allowed to write. Same directory, same name after the number — nothing
 * wider. Forbidden paths are still asked with `matchesGlob` alone.
 */
export function ownsPath(candidate: string, glob: string): boolean {
  if (matchesGlob(candidate, glob)) return true;
  const owned = /^(.*migrations\/)\d+_([^/*?[\]{}]+)$/.exec(glob.split(path.sep).join('/'));
  if (!owned) return false;
  const file = /^(.*migrations\/)\d+_([^/]+)$/.exec(candidate.split(path.sep).join('/'));
  return !!file && file[1] === owned[1] && file[2] === owned[2];
}
