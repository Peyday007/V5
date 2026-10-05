/**
 * Several operator surfaces were built in parallel — puzzles, industries,
 * dealflow, the design kernel — and each one added an address to the router, a
 * section to the shell's menu and a rendering branch, in the same three places.
 * Each passed its own suite. What none of those suites can see is the
 * composition: a merge that kept one side's section and dropped the other's
 * rendering branch, or two addresses that resolve to one route, leaves a menu
 * entry that opens nothing, or a bookmark that opens the wrong screen.
 *
 * So this reads the merged tree as a whole: every section in the menu has a
 * branch that renders it, every surface address round-trips through the
 * router, and no two route names share a path.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRoute, pathFor, type Route } from '../client/src/lib/router.ts';

const shell = readFileSync(new URL('../client/src/russell/RussellShell.tsx', import.meta.url), 'utf8');

const sectionNames = [...shell.matchAll(/\{\s*name:\s*'([A-Z_]+)'\s+as const/g)].map((m) => m[1]!);

const SURFACES: Array<[string, Route['name']]> = [
  ['/puzzles', 'PUZZLES'],
  ['/industries', 'INDUSTRIES'],
  ['/dealflow', 'DEALFLOW'],
  ['/design', 'DESIGN'],
  ['/labor', 'LABOR'],
  ['/machines', 'MACHINES'],
];

describe('the shell, composed from several surfaces built apart', () => {
  it('reads a non-trivial menu, so the checks below are not vacuous', () => {
    expect(sectionNames.length).toBeGreaterThanOrEqual(12);
    for (const [, name] of SURFACES) expect(sectionNames).toContain(name);
  });

  it('renders every section the menu offers', () => {
    const missing = sectionNames.filter((name) => !shell.includes(`route.name === '${name}'`));
    expect(missing).toEqual([]);
  });

  it('offers each section once', () => {
    expect(new Set(sectionNames).size).toBe(sectionNames.length);
  });

  it('round-trips every surface address, and no two share a path', () => {
    const paths = new Map<string, string>();
    for (const [path, name] of SURFACES) {
      expect(parseRoute(path)).toEqual({ name });
      const back = pathFor({ name } as Route);
      expect(back).toBe(path);
      expect(paths.get(back)).toBeUndefined();
      paths.set(back, name);
    }
  });
});
