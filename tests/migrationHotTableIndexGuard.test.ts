/**
 * INF-8: no boot migration may build an index on a large, write-hot table.
 *
 * Migration 115 / pg 106 indexed `identity_events` at boot. On a saturated
 * database the build hit the statement timeout, the migration rolled back on
 * every boot attempt, and production served 503 until one attempt happened to
 * land in a quieter minute (CLAUDE.md §61). The rule against doing it again
 * existed only as prose. This is the rule as a test.
 *
 * What it refuses, in both chains: `CREATE [UNIQUE] INDEX … ON` one of the
 * tables below, and the two `ALTER TABLE … ADD … UNIQUE / PRIMARY KEY` forms,
 * which build an index just the same. An index there is built outside the boot
 * path, by a person who has measured the build.
 *
 * The files that already did it are listed by name and left exactly as they
 * are: they are applied, checksum-locked (§3), and rewriting one to make this
 * pass would stop the next boot. The list can only be shrunk. A new file on it
 * is a visible edit somebody reviews, and the test also fails if a listed file
 * stops containing what it is listed for — a stale exemption is a hole.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HOT_TABLES = ['identity_events', 'bin_events', 'project_events'] as const;

const CHAINS = ['server/db/migrations', 'server/db/pg-migrations'] as const;

/** Already applied before this guard existed. Never add to this list. */
const GRANDFATHERED: Readonly<Record<string, readonly string[]>> = {
  'server/db/migrations/001_initial.sql': ['project_events'],
  'server/db/migrations/014_identity.sql': ['identity_events'],
  'server/db/migrations/024_bins.sql': ['bin_events'],
  'server/db/migrations/026_fleet.sql': ['bin_events'],
  'server/db/migrations/107_infra_incidents.sql': ['project_events'],
  'server/db/migrations/115_hot_path_indexes.sql': ['identity_events'],
  'server/db/pg-migrations/001_baseline.sql': ['project_events'],
  'server/db/pg-migrations/003_identity.sql': ['identity_events'],
  'server/db/pg-migrations/015_bins.sql': ['bin_events'],
  'server/db/pg-migrations/017_fleet.sql': ['bin_events'],
  'server/db/pg-migrations/098_infra_incidents.sql': ['project_events'],
  'server/db/pg-migrations/106_hot_path_indexes.sql': ['identity_events'],
};

/** Comments out, whitespace collapsed, lower case: the statement as the server reads it. */
function normalise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** The hot tables a migration's text builds an index on. */
export function hotTablesIndexed(sql: string): string[] {
  const text = normalise(sql);
  const found = new Set<string>();
  const table = `(?:"?[a-z_][a-z0-9_]*"?\\.)?"?(${HOT_TABLES.join('|')})"?`;
  const createIndex = new RegExp(
    `create (?:unique )?index (?:concurrently )?(?:if not exists )?(?:"?[a-z0-9_]+"? )?on (?:only )?${table}\\b`,
    'g',
  );
  const addConstraint = new RegExp(
    `alter table (?:if exists )?(?:only )?${table} [^;]*?add (?:constraint "?[a-z0-9_]+"? )?(?:unique|primary key)\\b`,
    'g',
  );
  for (const pattern of [createIndex, addConstraint]) {
    for (const match of text.matchAll(pattern)) if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

function migrationFiles(): string[] {
  return CHAINS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => path.posix.join(dir, name)),
  );
}

describe('boot migrations do not index the write-hot tables (INF-8)', () => {
  it('recognises every shape that builds an index, and nothing else', () => {
    expect(hotTablesIndexed('CREATE INDEX idx ON identity_events (target_id);')).toEqual(['identity_events']);
    expect(hotTablesIndexed('create unique index if not exists x\n  on public."bin_events" (a)')).toEqual(['bin_events']);
    expect(hotTablesIndexed('CREATE INDEX CONCURRENTLY x ON ONLY project_events (a)')).toEqual(['project_events']);
    expect(hotTablesIndexed('ALTER TABLE bin_events ADD CONSTRAINT u UNIQUE (a, b);')).toEqual(['bin_events']);
    expect(hotTablesIndexed('ALTER TABLE project_events ADD PRIMARY KEY (id);')).toEqual(['project_events']);
    // A comment is not a statement, and another table is not a hot one.
    expect(hotTablesIndexed('-- CREATE INDEX x ON identity_events (a)\nSELECT 1;')).toEqual([]);
    expect(hotTablesIndexed('/* CREATE INDEX x ON bin_events (a) */')).toEqual([]);
    expect(hotTablesIndexed('CREATE INDEX x ON identity_events_archive (a)')).toEqual([]);
    expect(hotTablesIndexed('CREATE INDEX x ON work_items (a)')).toEqual([]);
    expect(hotTablesIndexed('ALTER TABLE bin_events ADD COLUMN routine_id TEXT;')).toEqual([]);
  });

  it('reads both chains, and finds the indexes that are already there', () => {
    const files = migrationFiles();
    // Not vacuous: both chains are read, and the scanner finds every
    // grandfathered index — a scanner that matched nothing would pass below.
    expect(files.filter((f) => f.startsWith('server/db/migrations/')).length).toBeGreaterThan(100);
    expect(files.filter((f) => f.startsWith('server/db/pg-migrations/')).length).toBeGreaterThan(90);
    for (const [file, tables] of Object.entries(GRANDFATHERED)) {
      expect(hotTablesIndexed(readFileSync(file, 'utf8')), file).toEqual([...tables].sort());
    }
  });

  it('refuses any other migration that builds one', () => {
    const offenders = migrationFiles()
      .filter((file) => !(file in GRANDFATHERED))
      .map((file) => ({ file, tables: hotTablesIndexed(readFileSync(file, 'utf8')) }))
      .filter((entry) => entry.tables.length > 0);
    expect(
      offenders,
      'A boot migration may not index identity_events, bin_events or project_events: on a busy ' +
        'database the build outlives the statement timeout and the boot never completes (CLAUDE.md §61). ' +
        'Build it outside the boot path, after measuring it.',
    ).toEqual([]);
  });
});
