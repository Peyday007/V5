/**
 * Work an effect's transaction asks for, run once that transaction has committed.
 *
 * Production, 2026-11-14 (connection reports 17:39Z and after #894): the top
 * pooled-connection holder in every stalled process was `runIdempotent`'s
 * transaction, up to 2,020 s on one connection. What it held the connection
 * for was not the effect: a judge submission, a filing or a completion ends
 * with `recomputeProject`, and inside a transaction that recompute asked the
 * document store about every document (an HTTPS round trip each, queued
 * behind eight sockets) and re-derived every layer — all while the effect's
 * row locks and its pooled connection waited. Eight of those and the pool was
 * empty, and `/healthz` stalled behind the event loop they kept busy.
 *
 * A recompute is a re-derivation from rows (§6): it changes nothing the effect
 * committed, and run a second time it writes nothing. So it does not need to
 * be atomic with the effect, only to happen after it. Inside this scope a
 * caller registers the work under a key instead of doing it; `runIdempotent`
 * commits, releases the connection, and then runs each key's work once, before
 * it returns — so a caller still sees derived state that includes its effect.
 * A rolled-back transaction drops what it registered, because nothing it would
 * re-derive was written.
 *
 * Why not `afterCommit` in `db/database.ts`: those hooks are fire-and-forget
 * (detached, not awaited, not keyed), so a request would return before the
 * layer statuses its own effect changed were written, and two registrations of
 * one project's recompute would both run. This is the awaited, keyed form, and
 * it exists only for the effect engine's single transaction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { inTransaction } from '../../db/database.ts';

interface Scope {
  open: boolean;
  work: Map<string, () => Promise<unknown>>;
}

const scope = new AsyncLocalStorage<Scope>();

/**
 * Register `work` under `key` to run after the enclosing effect commits.
 *
 * Returns false — and registers nothing — when there is no open effect scope or
 * the caller is not inside its transaction, so the caller does the work itself.
 * A scope whose transaction has already committed is closed: background work
 * that inherited its context runs normally rather than into a list nobody reads.
 */
export function deferUntilEffectCommit(key: string, work: () => Promise<unknown>): boolean {
  const current = scope.getStore();
  if (!current?.open || !inTransaction()) return false;
  if (!current.work.has(key)) current.work.set(key, work);
  return true;
}

/** Whether a caller here would have its work deferred. */
export function insideEffectTransaction(): boolean {
  const current = scope.getStore();
  return Boolean(current?.open) && inTransaction();
}

/** One effect's deferral scope: run its transaction in it, then flush it once committed. */
export interface PostCommitScope {
  /** Run the effect's transaction with deferral on. The scope closes when it settles. */
  run<T>(transaction: () => Promise<T>): Promise<T>;
  /**
   * Run every registered piece of work once, in registration order, outside any
   * transaction. Call only after the transaction committed. A failure does not
   * undo or misreport the committed effect: it is handed to `onError`, and the
   * next recompute re-derives what the work would have written.
   */
  flush(onError?: (key: string, error: unknown) => void): Promise<void>;
  /** Forget what was registered: the transaction rolled back. */
  discard(): void;
}

export function postCommitScope(): PostCommitScope {
  const current: Scope = { open: true, work: new Map() };
  return {
    async run(transaction) {
      try {
        return await scope.run(current, transaction);
      } finally {
        current.open = false;
      }
    },
    async flush(onError = () => undefined) {
      const pending = [...current.work];
      current.work.clear();
      for (const [key, work] of pending) {
        try {
          await work();
        } catch (error) {
          onError(key, error);
        }
      }
    },
    discard() {
      current.open = false;
      current.work.clear();
    },
  };
}
