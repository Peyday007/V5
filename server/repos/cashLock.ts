/**
 * The point at which two cash decisions stop being concurrent.
 *
 * ---------------------------------------------------------------------------
 * The finding
 * ---------------------------------------------------------------------------
 *
 * `commit()` inserts its provisional row and then sums the holds ranked ahead
 * of it against the ceiling. On SQLite that is sound, because a write
 * transaction is globally exclusive. On Postgres every transaction runs on its
 * own pooled client under the default READ COMMITTED, so **each one sees its
 * own insert and not the other's**: two $80 commitments against a $100 ceiling
 * each sum to $80, both pass, and $160 is held.
 *
 * Ordering cannot fix it. A ranked sum cannot count a row it cannot see, and
 * the row it cannot see is the other transaction's.
 *
 * ---------------------------------------------------------------------------
 * Why a lock row rather than SERIALIZABLE
 * ---------------------------------------------------------------------------
 *
 * SERIALIZABLE would also be correct and it moves the cost somewhere worse: it
 * turns every conflicting commitment into a `40001` that the *caller* has to
 * retry, which means threading whole-transaction retry through every path that
 * touches money and getting it right in each one. A path that forgot would not
 * fail a test; it would fail under load, occasionally, having already told
 * somebody their money was committed.
 *
 * A guarded `UPDATE` on one row is the primitive this repository already uses
 * everywhere — a write to a row nobody else can write at the same time.
 * Postgres holds that row's lock until commit, so the second transaction blocks
 * *inside* `serializeCash` and does its arithmetic after the first one's insert
 * is visible. SQLite serializes writers anyway and pays nothing for it. There
 * is no retry to forget, and a caller that does not take the lock is a caller
 * that never reaches the money.
 *
 * ---------------------------------------------------------------------------
 * What it does not do
 * ---------------------------------------------------------------------------
 *
 * It is not a mutex a caller holds and releases; there is no unlock, and no
 * lease to expire. The lock is the transaction, so a crash releases it by
 * rolling back — which is the whole reason to put it in the database rather
 * than in a process.
 *
 * It bounds one project and one currency. Two projects commit concurrently, and
 * so do a sprint's dollars and its euros, because neither can spend the other's
 * money: a lock wider than the thing it protects is a throughput cost with no
 * correctness in it.
 */
import { getDb } from '../db/database.ts';
import { nowIso } from './util.ts';

/**
 * Run `fn` with this project's cash decisions serialized against every other
 * caller, in one transaction.
 *
 * The lock statement is the **first** thing in the transaction, because a
 * transaction that read before taking it would have read the stale value it is
 * trying to avoid. Nesting is safe: `Database.transaction` reuses the frame's
 * client, so an inner `serializeCash` re-bumps a row this transaction already
 * holds, which is a no-op rather than a deadlock.
 */
export async function serializeCash<T>(
  projectId: string,
  currency: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async () => {
    const at = nowIso();
    const bumped = await db.run(
      'UPDATE cash_locks SET ticket = ticket + 1, updated_at = ? WHERE project_id = ? AND currency = ?',
      [at, projectId, currency],
    );
    if (bumped.changes === 0) {
      /*
       * The first caller for this project and currency.
       *
       * `ON CONFLICT DO NOTHING` rather than a plain insert, because two first
       * callers race here exactly once per project: on Postgres the loser
       * blocks on the unique index until the winner commits and then does
       * nothing, which is the same serialization one statement earlier. The
       * re-bump afterwards is what makes the lock held in *both* cases, so the
       * caller that inserted and the caller that collided leave this line with
       * the same guarantee.
       */
      await db.run(
        `INSERT INTO cash_locks (project_id, currency, ticket, updated_at)
         VALUES (?, ?, 0, ?)
         ON CONFLICT (project_id, currency) DO NOTHING`,
        [projectId, currency, at],
      );
      await db.run(
        'UPDATE cash_locks SET ticket = ticket + 1, updated_at = ? WHERE project_id = ? AND currency = ?',
        [at, projectId, currency],
      );
    }
    return fn();
  });
}

/** How many cash decisions this project has serialized. Diagnostic only. */
export async function cashLockTicket(projectId: string, currency: string): Promise<number> {
  const rows = await getDb().all<{ ticket: number }>(
    'SELECT ticket FROM cash_locks WHERE project_id = ? AND currency = ?',
    [projectId, currency],
  );
  return Number(rows[0]?.ticket ?? 0);
}
