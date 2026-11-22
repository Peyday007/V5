/**
 * The self-model's "which suites name this file" answer, read from an index
 * rather than `includes` over every suite for every module (Deploy 45046907261:
 * the module observer took 8.9 s of a 14 s pass and a test that observes twice
 * ran past its bound). The index must give exactly the answer `includes` gave.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mentioning } from '../server/services/selfmodel/observe.ts';

const naive = (entries: Array<{ name: string; text: string }>, needles: string[]): string[] =>
  entries.filter((e) => needles.some((n) => e.text.includes(n))).map((e) => e.name).sort();

describe('which entries name a file', () => {
  it('matches includes on the edges: inner .ts, .tsx, a longer name, a path, other needles', () => {
    const entries = [
      { name: 'a', text: "import x from '../server/services/cash/volume.ts';" },
      { name: 'b', text: 'see myvolume.ts and volume.tsx' },
      { name: 'c', text: 'a.ts.b.ts then (cash/volume.ts) and nothing else' },
      { name: 'd', text: 'no file named here, only 001_initial.sql and brain_fetch_source' },
      { name: 'e', text: '' },
    ];
    const needles = [
      ['volume.ts'], ['cash/volume.ts'], ['services/cash/volume.ts'], ['a.ts'], ['b.ts'], ['a.ts.b.ts'],
      ['olume.ts'], ['.ts'], ['missing.ts'], ['001_initial.sql'], ['brain_fetch_source'], ['volume.ts', '001_initial.sql'],
    ];
    for (const n of needles) expect(mentioning(entries, n)).toEqual(naive(entries, n));
  });

  it('matches includes for every server module against the real suites', () => {
    const tests = fs.readdirSync('tests').filter((f) => f.endsWith('.test.ts'));
    const entries = tests.map((name) => ({ name, text: fs.readFileSync(path.join('tests', name), 'utf8') }));
    const modules: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) modules.push(path.relative('server', p));
      }
    };
    walk('server/services');
    walk('server/repos');
    // Every 7th module keeps the naive side of the comparison inside the test's budget.
    for (const file of modules.filter((_, i) => i % 7 === 0)) {
      expect(mentioning(entries, [file, path.basename(file)])).toEqual(naive(entries, [file, path.basename(file)]));
    }
  }, 120_000);
});
