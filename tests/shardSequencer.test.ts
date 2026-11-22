/**
 * The CI shards are split by recorded duration (tests/helpers/shardSequencer.ts).
 *
 * Splitting is the one change that could quietly shrink the gate, so the
 * properties that matter are held here as well as in the verdict job: every
 * file is in exactly one shard, every shard computes the same answer, a file
 * the table has never seen is still placed, and the split is actually even.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import DurationSequencer, {
  backendOfThisRun,
  partition,
  readDurationTables,
} from './helpers/shardSequencer.ts';

const ROOT = path.resolve(__dirname, '..');

function suiteFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.test\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  walk('tests');
  return out.sort();
}

describe('duration-balanced shards', () => {
  const files = suiteFiles();
  const tables = readDurationTables();

  it('has a table for both backends that knows most of the suite', () => {
    for (const backend of ['postgres', 'sqlite'] as const) {
      const table = tables[backend] ?? {};
      const known = files.filter((f) => table[f] !== undefined).length;
      // Not every file: a new one is weighed at the median. Most of them,
      // or the split has drifted back to a guess.
      expect(known / files.length).toBeGreaterThan(0.8);
    }
  });

  for (const [backend, count] of [['postgres', 8], ['sqlite', 4]] as const) {
    it(`puts every ${backend} file in exactly one of ${count} shards, the same way every time`, () => {
      const table = tables[backend] ?? {};
      const shards = partition(files, count, table);
      expect(shards).toHaveLength(count);
      const union = shards.flat();
      expect(union.length).toBe(files.length);
      expect([...union].sort()).toEqual(files);
      // The order a shard's list arrives in changes nothing.
      expect(partition([...files].reverse(), count, table)).toEqual(shards);
    });

    it(`splits the ${backend} suite within a few percent of even`, () => {
      const table = tables[backend] ?? {};
      const loads = partition(files, count, table).map((s) =>
        s.reduce((sum, f) => sum + (table[f] ?? 0), 0),
      );
      expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.05);
    });
  }

  it('places a file the table has never seen, and an empty table still partitions', () => {
    const shards = partition(['tests/a.test.ts', 'tests/new.test.ts', 'tests/b.test.ts'], 2, {
      'tests/a.test.ts': 100,
      'tests/b.test.ts': 50,
    });
    expect(shards.flat().sort()).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/new.test.ts']);
    expect(partition(files, 3, {}).flat().length).toBe(files.length);
    expect(() => partition(files, 0, {})).toThrow();
  });

  it('is what vitest uses, and each shard gets its own slice longest first', async () => {
    const config = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/sequencer: DurationSequencer/);
    const specs = files.map((f) => ({ moduleId: path.join(ROOT, f) }));
    const seen: string[] = [];
    for (let index = 1; index <= 4; index++) {
      const ctx = { config: { root: ROOT, shard: { index, count: 4 } } };
      const sequencer = new DurationSequencer(ctx as never);
      const mine = await sequencer.shard(specs as never);
      const sorted = (await sequencer.sort(mine)) as unknown as Array<{ moduleId: string }>;
      const table = tables[backendOfThisRun()] ?? {};
      const weights = sorted.map((s) => table[path.relative(ROOT, s.moduleId)] ?? 0);
      // Longest first among the files the table knows.
      const known = weights.filter((w) => w > 0);
      expect(known).toEqual([...known].sort((a, b) => b - a));
      seen.push(...sorted.map((s) => path.relative(ROOT, s.moduleId)));
    }
    expect(seen.sort()).toEqual(files);
  });
});
