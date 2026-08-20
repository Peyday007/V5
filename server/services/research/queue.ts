/**
 * Scheduling research, and surviving a restart.
 *
 * One job at a time. Two deep-research runs against the same local tool compete
 * for the same account, the same rate limit and the same machine, and the second
 * usually makes the first slower rather than finishing sooner. Extra assignments
 * queue in the order they were asked for.
 *
 * Cancellation is real: the abort signal reaches the provider, which kills the
 * process tree it started. A cancelled job stops being work rather than becoming
 * an orphan nobody is waiting for.
 *
 * And a job that was interrupted — the machine slept, the server was restarted,
 * the process was killed mid-pass — is recovered at boot rather than left
 * looking live forever. Recovery is deliberately conservative: it marks what was
 * in flight as interrupted and says so, and it never silently re-runs work that
 * costs the user quota.
 */
import type { ResearchOrchestration } from '../../domain/types.ts';
import {
  abandonRunningPasses,
  currentFragments,
  getOrchestration,
  listPendingOrchestrations,
  updateFragment,
  updateOrchestration,
} from '../../repos/research.ts';
import { recordEvent } from '../../repos/events.ts';
import { abandonRunningJobs, openQuotaPause, resolveQuotaPause } from '../../repos/jobs.ts';
import {
  runOrchestration,
  ResearchCancelled,
  type OrchestrationOutcome,
  type RunOrchestrationOptions,
} from './orchestrator.ts';

interface QueueEntry {
  orchestrationId: string;
  options: RunOrchestrationOptions;
  resolve: (outcome: OrchestrationOutcome) => void;
  reject: (error: unknown) => void;
}

const pending: QueueEntry[] = [];
const inFlight = new Map<string, Promise<OrchestrationOutcome>>();
const controllers = new Map<string, AbortController>();
let draining = false;
let idleWaiters: (() => void)[] = [];

/** Live progress, for whichever browser is watching. */
type Listener = (progress: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

export function onResearchProgress(orchestrationId: string, listener: Listener): () => void {
  const set = listeners.get(orchestrationId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(orchestrationId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(orchestrationId);
  };
}

function emit(orchestrationId: string, progress: unknown): void {
  for (const listener of listeners.get(orchestrationId) ?? []) {
    try {
      listener(progress);
    } catch {
      // A browser that went away must not take the research run down with it.
    }
  }
}

function settleIdle(): void {
  if (pending.length > 0 || inFlight.size > 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const waiter of waiters) waiter();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const entry = pending.shift();
      if (!entry) break;
      const controller = new AbortController();
      controllers.set(entry.orchestrationId, controller);
      try {
        entry.resolve(
          await runOrchestration(entry.orchestrationId, {
            ...entry.options,
            signal: controller.signal,
            onProgress: (progress) => {
              emit(entry.orchestrationId, progress);
              entry.options.onProgress?.(progress);
            },
          }),
        );
      } catch (error) {
        entry.reject(error);
      } finally {
        controllers.delete(entry.orchestrationId);
        inFlight.delete(entry.orchestrationId);
      }
    }
  } finally {
    draining = false;
    settleIdle();
  }
}

/**
 * Schedule an assignment. Returns the promise for an already-running one rather
 * than starting it twice.
 */
export function enqueueResearch(
  orchestrationId: string,
  options: RunOrchestrationOptions = {},
): Promise<OrchestrationOutcome> {
  const existing = inFlight.get(orchestrationId);
  if (existing) return existing;

  const promise = new Promise<OrchestrationOutcome>((resolve, reject) => {
    pending.push({ orchestrationId, options, resolve, reject });
  });
  inFlight.set(orchestrationId, promise);
  // Errors reach whoever awaited the promise; an unawaited enqueue must not take
  // the process down.
  promise.catch(() => undefined);
  void drain();
  return promise;
}

/**
 * Stop a research run.
 *
 * Works whether it is running (the signal aborts the provider and kills its
 * process tree) or still queued (the status is written, and the orchestrator
 * checks it before every pass).
 */
export function cancelResearch(orchestrationId: string, reason: string): ResearchOrchestration | null {
  const orchestration = getOrchestration(orchestrationId);
  if (!orchestration) return null;
  if (['COMPLETE', 'CANCELLED', 'FAILED'].includes(orchestration.status)) return orchestration;

  updateOrchestration(orchestrationId, {
    status: 'CANCELLED',
    cancelledAt: new Date().toISOString(),
    cancelReason: reason,
  });
  for (const fragment of currentFragments(orchestrationId)) {
    if (['QUEUED', 'PLANNED', 'RUNNING', 'VALIDATING'].includes(fragment.status)) {
      updateFragment(fragment.id, { status: 'CANCELLED', blockedReason: reason });
    }
  }
  abandonRunningPasses(orchestrationId, `Cancelled: ${reason}`);

  controllers.get(orchestrationId)?.abort();

  recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_CANCELLED',
    payload: { orchestrationId, reason },
  });

  emit(orchestrationId, {
    orchestrationId,
    phase: 'DONE',
    passKey: null,
    fragmentKey: null,
    index: 0,
    total: 0,
    message: `Cancelled: ${reason}`,
  });

  return getOrchestration(orchestrationId);
}

export function whenResearchIdle(): Promise<void> {
  if (pending.length === 0 && inFlight.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
  });
}

/**
 * Jobs the queue is responsible for: the one running plus the ones waiting.
 *
 * Counted from `inFlight` alone, which holds an entry from the moment a job is
 * enqueued until it settles. Adding `pending` to it would double-count
 * everything still in the line.
 */
export function researchQueueDepth(): number {
  return inFlight.size;
}

export function isRunning(orchestrationId: string): boolean {
  return inFlight.has(orchestrationId);
}

/**
 * Close the books on anything a dead process left open.
 *
 * Called at boot, before the port opens. A row that says RESEARCHING with no
 * process behind it is the same lie as a document that says READY with no text
 * behind it, so it is corrected to INTERRUPTED, with its in-flight passes marked
 * and its fragments returned to the queue.
 *
 * Nothing is restarted automatically: research costs the user's quota, and the
 * decision to spend it again is theirs. What they get is an accurate picture and
 * a resumable job — the completed passes and accepted fragments are all still
 * there, so resuming is cheap.
 */
export function recoverInterruptedResearch(): number {
  const interrupted = listPendingOrchestrations().filter(
    (orchestration) => !inFlight.has(orchestration.id),
  );
  let recovered = 0;

  for (const orchestration of interrupted) {
    const closed = abandonRunningPasses(
      orchestration.id,
      'The server stopped while this pass was running, so its result was never received.',
    );

    // An external job this instance has no handle on cannot be resumed and must
    // not be left claiming to be running.
    const abandonedJobs = abandonRunningJobs(
      orchestration.id,
      'The server stopped while this job was running. Whatever the tool did, this instance never ' +
        'received it, so nothing from it was recorded.',
    );

    // A fragment caught mid-job goes back to the queue: its passes were
    // abandoned, and its next attempt starts from the last completed one.
    for (const fragment of currentFragments(orchestration.id)) {
      if (fragment.status === 'RUNNING' || fragment.status === 'VALIDATING') {
        updateFragment(fragment.id, { status: 'QUEUED', startedAt: null });
      }
    }

    updateOrchestration(orchestration.id, {
      status: 'INTERRUPTED',
      failureReason:
        orchestration.status === 'QUEUED'
          ? 'Queued when the server stopped. Nothing had run yet.'
          : `Interrupted while ${orchestration.status.toLowerCase()}. ` +
            `${closed} pass(es) were in flight and their results were lost. ` +
            'Everything already completed is kept; resume to continue from there.',
    });

    recordEvent({
      projectId: orchestration.projectId,
      layerId: orchestration.layerId,
      entityType: 'RUN',
      entityId: orchestration.runId,
      eventType: 'RESEARCH_BLOCKED',
      payload: {
        orchestrationId: orchestration.id,
        recovered: true,
        abandonedPasses: closed,
        abandonedJobs,
      },
    });
    recovered += 1;
  }

  return recovered;
}

/**
 * Continue an interrupted or awaiting-repair job.
 *
 * Completed passes are not re-run and accepted fragments are not re-researched,
 * so resuming after a crash costs only the work that was actually lost.
 */
export function resumeResearch(
  orchestrationId: string,
  options: RunOrchestrationOptions = {},
): Promise<OrchestrationOutcome> {
  const orchestration = getOrchestration(orchestrationId);
  if (!orchestration) throw new Error(`Unknown research run ${orchestrationId}`);
  if (orchestration.status === 'COMPLETE') {
    throw new Error('That research run already finished.');
  }
  // A run picked up by hand closes any quota pause it was holding: the pause
  // recorded why it stopped, and leaving it open would report a run as paused
  // while it is running.
  const pause = openQuotaPause(orchestrationId);
  if (pause) resolveQuotaPause(pause.id);

  updateOrchestration(orchestrationId, {
    status: 'QUEUED',
    failureReason: null,
    cancelledAt: null,
    cancelReason: null,
  });
  return enqueueResearch(orchestrationId, options);
}

export { ResearchCancelled };
