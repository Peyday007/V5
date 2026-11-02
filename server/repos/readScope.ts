/**
 * One read, one fetch per project-wide list.
 *
 * A plan read walks every opening in a project and, per opening, asked for the
 * project's workflows, its card facts, its agreements, its value layers and its
 * source claim. Production, 2026-11-02: 841 statements for 150 openings, which
 * against the remote database took the goal plan from 15 s to past the Goals
 * workflow's 15-minute bound — while the same code read the same plan locally
 * in 0.7 s. Inside `withReadScope` each project-wide list is fetched once and
 * per-opening rows are sliced from it; outside it every call reads current rows
 * exactly as before, so nothing that writes and then reads sees stale data.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Run `fn` with a fresh read scope (nested scopes share the outer one). */
export function withReadScope<T>(fn: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return fn();
  return scope.run(new Map(), fn);
}

/** The loader's value, once per key inside a scope; the loader itself outside one. */
export function scopedRead<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const memo = scope.getStore();
  if (!memo) return loader();
  let hit = memo.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = loader();
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}

/** Whether a read scope is active, for callers choosing between a batch and a single read. */
export function inReadScope(): boolean {
  return scope.getStore() !== undefined;
}
