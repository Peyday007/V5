/**
 * The search-intelligence migrations take numbers no other migration holds, in
 * both chains, and leave no gap (repair F4-3). The change first landed at
 * SQLite 131/132 and Postgres 122/123, numbers production already used for
 * cash value layers and cash decisions, so it could not be integrated. Both
 * chains are numbered independently; each must be unique and contiguous.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', 'server', 'db');

function chain(dir: string): { version: number; file: string }[] {
  return readdirSync(join(ROOT, dir))
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .map((file) => ({ version: Number(file.slice(0, 3)), file }))
    .sort((a, b) => a.version - b.version);
}

describe.each(['migrations', 'pg-migrations'])('the %s chain', (dir) => {
  const files = chain(dir);

  it('gives every migration its own number', () => {
    const seen = new Map<number, string[]>();
    for (const one of files) seen.set(one.version, [...(seen.get(one.version) ?? []), one.file]);
    const shared = [...seen.entries()].filter(([, names]) => names.length > 1);
    expect(shared).toEqual([]);
  });

  it('skips no number', () => {
    files.forEach((one, i) => expect(one.version, one.file).toBe(i + 1));
  });

  it('holds both search-intelligence migrations, numbered after every migration that existed before them', () => {
    const isSearch = (file: string): boolean => /^\d{3}_search_intelligence\.sql$/.test(file);
    const search = files.filter((one) => isSearch(one.file));
    expect(search).toHaveLength(2);
    const first = Math.min(...search.map((one) => one.version));
    // Everything numbered below them is somebody else's; the two are consecutive.
    expect(search.map((one) => one.version)).toEqual([first, first + 1]);
    expect(files.filter((one) => one.version < first).every((one) => !isSearch(one.file))).toBe(true);
  });
});
