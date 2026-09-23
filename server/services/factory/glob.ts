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
      // `a/**` owns `a` itself as well as everything under it, which is what a
      // reader of the glob expects and what a directory-owning unit means by it.
      // So the separator in front of the `**` becomes part of the optional tail
      // rather than something the path must contain.
      if (regex.endsWith('/')) regex = `${regex.slice(0, -1)}(?:/.*)?`;
      else regex += '.*';
      i += 1;
      if (pattern[i + 1] === '/') i += 1;
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

