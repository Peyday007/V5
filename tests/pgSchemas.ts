/**
 * The Postgres half of `setup.ts`'s lifecycle, in its own module so both can
 * reach it.
 *
 * `setup.ts` owns the filesystem data root and says exactly why it needs two
 * mechanisms: this run tidies up after itself, and every run sweeps what
 * earlier ones left, because `process.on('exit')` does not fire for the signals
 * vitest's pool uses to stop a worker. The Postgres schema is derived from that
 * same root and got neither, which is the leak — 648 schemas, 636 578
 * relations, 7.6 GB from one machine's ordinary runs.
 *
 * The first correction put the self-tidy in `helpers.ts`'s `teardown()`, and
 * that was the wrong place: **47 of 169 test files call it.** The other 122
 * leaked exactly as before and the sweep carried all of them — and a sweep
 * skips anything younger than `STALE_AFTER_MS`, so a run's own leavings are
 * invisible to it until an hour has passed. Two runs an hour apart therefore
 * still accumulate.
 *
 * So it lives beside the filesystem one instead, in a global `afterAll` every
 * file gets whether or not it knows this module exists. A separate module
 * rather than an import from `helpers.ts`, because `helpers.ts` imports
 * `setup.ts` for the shared cutoff and a cycle between them would be resolved
 * by whichever loaded first.
 *
 * Every drop is best effort: a release that cannot run is a leak for the sweep
 * to clear, and never a reason to fail somebody's test.
 */

/** Schemas this process created, to drop when its file is done. */
const schemasToRelease = new Set<string>();

export function registerSchemaCleanup(schema: string): void {
  schemasToRelease.add(schema);
}

export async function releaseTestSchemas(): Promise<void> {
  const url = process.env['BRAIN_TEST_DATABASE_URL'];
  if (!url || schemasToRelease.size === 0) return;
  const pg = await import('pg');
  const admin = new pg.default.Client({ connectionString: url });
  try {
    await admin.connect();
    for (const schema of schemasToRelease) {
      // The same shape check the sweep makes. These names are Brain's own, but
      // a drop that interpolates a name is one place a bad one must not reach.
      if (!/^brain_t_[a-z0-9_]+$/.test(schema)) continue;
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } catch {
        /* the sweep will get it */
      }
    }
    schemasToRelease.clear();
  } catch {
    /* best effort */
  } finally {
    try {
      await admin.end();
    } catch {
      /* already closed */
    }
  }
}
