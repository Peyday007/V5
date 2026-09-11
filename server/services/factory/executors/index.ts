/**
 * How a worker is actually run.
 *
 * One interface, several surfaces. The factory above this directory knows that
 * a unit is assigned to a worker and that the worker comes back with a branch;
 * it does not know whether that worker was a process on this machine, a Cowork
 * activation Brain fired, or a session somewhere else. That is the whole point
 * of the split: **adding a worker must be registration rather than a factory
 * change**, and it can only be that if the dispatch path has no idea what kind
 * of thing it is dispatching to.
 *
 * An executor is also where the honest answer about a surface lives. `probe`
 * asks whether the thing a registered worker needs exists *here* — §16's
 * separation between an engine passing its tests and the tool actually working
 * on this machine. A worker whose surface is missing is reported unusable, never
 * discovered halfway through a campaign.
 */
import type { FactoryUsage, FactoryWorkerKind } from '../../../domain/factory.ts';

export interface ExecutionRequest {
  campaignId: string;
  unitId: string;
  sessionId: string;
  /** Where the worker runs. Its own worktree, and nobody else's. */
  worktreePath: string;
  branch: string;
  model: string;
  /** The compiled assignment. Everything the worker is told, and nothing else. */
  assignment: string;
  timeoutMs: number;
  /** Which tools the surface may use, when the surface takes such a list. */
  allowedTools?: string[];
}

export type ExecutionOutcome = 'COMPLETED' | 'RATE_LIMITED' | 'ERROR' | 'TIMEOUT';

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  /**
   * The surface's own identifier for the session it ran.
   *
   * Observed from the run rather than taken from the worker's output, because a
   * session that could name itself could name another — and this id is what
   * review independence is decided on.
   */
  externalSessionId: string | null;
  /** The worker's own words. Evidence of what it believes, never of what happened. */
  summary: string;
  /** The full transcript of the run, for the artifact table. */
  rawLog: string;
  durationMs: number;
  numTurns: number | null;
  usage: FactoryUsage | null;
  /** Set when the outcome is RATE_LIMITED: how long to defer, not to fail. */
  retryAfterMs: number | null;
  detail: string;
  /**
   * Whether this execution used a paid model API.
   *
   * False for every executor here, structurally rather than by promise: the
   * local executor strips API-key variables out of the child's environment, so a
   * worker cannot be run on a paid key even by accident.
   */
  paidApi: boolean;
}

export interface Executor {
  kind: FactoryWorkerKind;
  probe(): Promise<{ ok: boolean; detail: string }>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

import { localCliExecutor } from './localCli.ts';
import { coworkExecutor } from './cowork.ts';

/**
 * The executors that exist.
 *
 * A worker kind absent from this map is refused at registration. That refusal is
 * the reason the registry can report capacity truthfully: every registered
 * worker is a worker something knows how to run.
 */
const EXECUTORS = new Map<FactoryWorkerKind, Executor>([
  [localCliExecutor.kind, localCliExecutor],
  [coworkExecutor.kind, coworkExecutor],
]);

export function executorKinds(): FactoryWorkerKind[] {
  return [...EXECUTORS.keys()];
}

export function executorFor(kind: FactoryWorkerKind): Executor | null {
  return EXECUTORS.get(kind) ?? null;
}

export async function probeExecutor(
  kind: FactoryWorkerKind,
): Promise<{ ok: boolean; detail: string }> {
  const executor = EXECUTORS.get(kind);
  if (!executor) return { ok: false, detail: `No executor implements ${kind}.` };
  return await executor.probe();
}

/**
 * A seam for tests, and deliberately nothing more.
 *
 * A test that wants a scripted worker replaces one here; what it must never be
 * able to do is register a worker kind production would then dispatch to. So
 * the replacement is explicit, reversible, and has no path from a row: nothing
 * a caller sends can reach this function.
 */
export function installExecutorForTests(executor: Executor): () => void {
  const previous = EXECUTORS.get(executor.kind);
  EXECUTORS.set(executor.kind, executor);
  return () => {
    if (previous) EXECUTORS.set(executor.kind, previous);
    else EXECUTORS.delete(executor.kind);
  };
}
