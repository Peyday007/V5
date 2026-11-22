/**
 * How the whole suite is split across CI shards, and in what order a shard
 * runs its files.
 *
 * vitest's own `--shard` sorts files by a hash of their path and cuts the list
 * into equal *counts*. A file count is not a duration: measured on the
 * Postgres suite (runs 44952552838 and 44961760615, 2026-11-21), the eight
 * shards of one run took from 10.0 to 25.9 minutes, and the release waited on
 * the slowest. On SQLite the four Deploy shards took 13.4 to 19.0.
 *
 * So the split is by recorded duration instead (`shard-durations.json`, one
 * table per backend): longest file first, each into the shard with the least
 * work so far. Every shard computes the same partition from the same file list
 * and the same table, so every file still runs in exactly one shard — and
 * `postgres-shards.sh check` still proves that from the shards' own reports
 * rather than trusting this code. A file the table does not know yet (a new
 * one) is weighed at the table's median, so it is placed, never dropped.
 *
 * Within a shard the files run longest first. vitest's default order on a
 * fresh CI checkout (no results cache) is by file *size*, which started a
 * nine-minute file after the short ones had gone and left one worker running
 * alone at the end.
 *
 * Refresh the table from shard reports with `node scripts/test-durations.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type WorkspaceSpec } from 'vitest/node';

export type Backend = 'postgres' | 'sqlite';
export type DurationTable = Record<string, number>;

const TABLE_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'shard-durations.json');

export function readDurationTables(file = TABLE_PATH): Partial<Record<Backend, DurationTable>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Record<Backend, DurationTable>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // No table is a slower split, never a missing file: every file still lands somewhere.
    return {};
  }
}

export function backendOfThisRun(env: NodeJS.ProcessEnv = process.env): Backend {
  return (env['BRAIN_TEST_DATABASE_URL'] ?? '').trim() ? 'postgres' : 'sqlite';
}

/** The weight of each file: its recorded duration, or the table's median for a file it has not seen. */
export function weigh(files: readonly string[], table: DurationTable): Map<string, number> {
  const known = Object.values(table).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)]! : 1;
  return new Map(files.map((f) => {
    const recorded = table[f];
    return [f, recorded !== undefined && Number.isFinite(recorded) && recorded > 0 ? recorded : median];
  }));
}

/** Longest first; a path breaks every tie, so the order never depends on how the list arrived. */
export function longestFirst(files: readonly string[], weight: Map<string, number>): string[] {
  return [...files].sort((a, b) => weight.get(b)! - weight.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Split `files` into `count` shards of near-equal recorded duration (greedy
 * longest-processing-time). Every file is in exactly one shard. Pure and
 * deterministic: the same inputs give every shard the same answer.
 */
export function partition(files: readonly string[], count: number, table: DurationTable): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, not ${count}`);
  const unique = [...new Set(files)];
  const weight = weigh(unique, table);
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const file of longestFirst(unique, weight)) {
    let target = shards[0]!;
    for (const shard of shards) if (shard.load < target.load) target = shard;
    target.files.push(file);
    target.load += weight.get(file)!;
  }
  return shards.map((s) => s.files);
}

export default class DurationSequencer extends BaseSequencer {
  #table(): DurationTable {
    return readDurationTables()[backendOfThisRun()] ?? {};
  }

  #key(spec: WorkspaceSpec): string {
    return path.relative(this.ctx.config.root, spec.moduleId).split(path.sep).join('/');
  }

  override async shard(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const { index, count } = this.ctx.config.shard!;
    const byKey = new Map(files.map((spec) => [this.#key(spec), spec] as const));
    const mine = partition([...byKey.keys()], count, this.#table())[index - 1] ?? [];
    return mine.map((key) => byKey.get(key)!);
  }

  override async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const keys = files.map((spec) => this.#key(spec));
    const weight = weigh(keys, this.#table());
    const byKey = new Map(files.map((spec, i) => [keys[i]!, spec] as const));
    return longestFirst([...byKey.keys()], weight).map((key) => byKey.get(key)!);
  }
}
