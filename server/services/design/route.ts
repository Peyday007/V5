/**
 * Turning a completed change into design work, where the change completed.
 *
 * ---------------------------------------------------------------------------
 * Why this is not just a call to `runDesignCycle`
 * ---------------------------------------------------------------------------
 *
 * A change integrates on a server. A render needs a browser. Those are two
 * different machines in the deployed arrangement and one machine in a
 * developer's, and the routing has to be correct in both — so the moment a
 * change lands, this **opens a cycle and stops**. The cycle sits `OPEN` with the
 * surfaces it is about, and whatever has a browser picks it up with
 * `resumeDesignCycle`.
 *
 * That is deliberately not a park. §24's rule is that a state saying it is
 * waiting for something nobody can supply is stuck rather than waiting, and the
 * difference here is that this one names what it is waiting for (a machine that
 * can render) and who supplies it (`npm run design resume`, the visual harness,
 * or a developer). `pendingCycles` is how anybody finds them.
 *
 * ---------------------------------------------------------------------------
 * No impact is a decision, and it is recorded
 * ---------------------------------------------------------------------------
 *
 * A change with no UI consequence produces **no cycle and a reason**. That is
 * the case that has to be cheap, because it is most of them: rendering the whole
 * product to discover that a migration changed nothing visible is a browser run
 * spent learning what a path check already knew.
 *
 * But it is a *decision*, so it comes back with its reasoning rather than as
 * silence — §33's rule that a rejection with no reason on it is a claim
 * destroyed silently, and the same is true of a screen not looked at.
 */
import type { DesignCycle, DesignTrigger } from '../../domain/design.ts';
import { binRequestFor, listCycles, openCycle } from '../../repos/design.ts';
import { classifyUiImpact, shouldOpenCycle, type UiImpact } from './impact.ts';

export interface RouteRequest {
  /** What caused this — a campaign id, a correction id, a person. */
  triggerKind: DesignTrigger;
  triggerRef: string | null;
  changedPaths: readonly string[];
  description: string;
  revision?: string | null;
}

export interface RouteOutcome {
  impact: UiImpact;
  /** The cycle waiting to be run, when one was opened. */
  cycle: DesignCycle | null;
  /** Why nothing was opened, when nothing was. Never silence. */
  because: string;
}

/**
 * Classify a completed change and open design work if it reaches the interface.
 *
 * Idempotent by the trigger: a campaign that integrates twice, or a tick that
 * reads one integration twice, produces one cycle. The arbiter is a scan of open
 * cycles rather than a flag, for the reason §27 records twice — a flag can be
 * set by a tick that then dies, and a row cannot.
 */
export async function requestDesignCycle(request: RouteRequest): Promise<RouteOutcome> {
  const impact = await classifyUiImpact({
    changedPaths: request.changedPaths,
    description: request.description,
  });

  if (!shouldOpenCycle(impact)) {
    return {
      impact,
      cycle: null,
      because:
        impact.verdict === 'UNKNOWN'
          ? `No design work was opened and that is not the same as no impact: ${impact.because}`
          : `No design work was opened: ${impact.because}`,
    };
  }

  if (impact.surfaces.length === 0) {
    /*
     * A direct interface change that reaches no registered surface.
     *
     * Reported rather than fanned out to everything. A fallback that captured the
     * whole product on any client change is a fallback somebody turns off, and
     * then the mechanism is gone rather than imperfect — §27's four widenings,
     * avoided by making the cost of a miss small instead.
     */
    return {
      impact,
      cycle: null,
      because:
        'The change reaches the interface and no registered surface is about the concepts it ' +
        `names${impact.unrepresented.length > 0 ? ` (${impact.unrepresented.join(', ')})` : ''}. ` +
        'Registering a surface for one of them is what would make this routable — the whole ' +
        'product is deliberately not the fallback.',
    };
  }

  const existing = await pendingCycleFor(request.triggerRef);
  if (existing) {
    return {
      impact,
      cycle: existing,
      because: `A cycle for this change is already open and waiting to be run (${existing.id}).`,
    };
  }

  const cycle = await openCycle({
    triggerKind: request.triggerKind,
    triggerRef: request.triggerRef,
    surfaceKeys: impact.surfaces.map((one) => one.surfaceKey),
    revision: request.revision ?? null,
  });

  return {
    impact,
    cycle,
    because:
      `${impact.because} ${impact.surfaces.length} surface(s) will be rendered and evaluated by ` +
      'whatever picks this up next: this machine may have no browser, so the cycle waits rather ' +
      'than deciding a screen is fine without looking at it.',
  };
}

/** An open cycle already about this trigger, or null. */
async function pendingCycleFor(triggerRef: string | null): Promise<DesignCycle | null> {
  if (triggerRef === null) return null;
  const open = await listCycles({ state: 'OPEN', limit: 200 });
  return open.find((one) => one.triggerRef === triggerRef) ?? null;
}

/**
 * Cycles waiting, and what each one is waiting for.
 *
 * The answering transition's other half: a request that nothing can find is a
 * request nobody will run. The operator surface prints this, which is what makes
 * "the cycle waits" a state with a way out rather than a park.
 *
 * **Two waits, not one, and they have different remedies.** A cycle with no
 * capture and no render bin is waiting for somebody to *ask* — which the tick
 * now does by itself, so seeing one means the tick is not running or could not
 * ask. A cycle with a render bin outstanding is waiting for a worker with a
 * browser to answer it, and one with a review bin outstanding is waiting for a
 * reader. §24's sentence at a projection: naming the wrong wait sends somebody
 * to fix a thing that is working.
 *
 * The first version guessed between them from `passes === 0`, which is a proxy
 * rather than a reading — it called a cycle that had been rendered and was
 * waiting on its judgement "waiting for a machine that can render". The
 * outstanding request row *is* the distinction, so it is read rather than
 * inferred.
 */
export type DesignWaitKind = 'NOBODY_HAS_ASKED' | 'WAITING_FOR_A_RENDER' | 'WAITING_FOR_A_READER';

export interface WaitingCycle {
  cycle: DesignCycle;
  waitingFor: DesignWaitKind;
  /** What would move it, in the words somebody can act on. */
  remedy: string;
}

export async function pendingCycles(): Promise<WaitingCycle[]> {
  const out: WaitingCycle[] = [];
  for (const cycle of await listCycles({ state: 'OPEN', limit: 200 })) {
    const review = await binRequestFor({ cycleId: cycle.id, pass: cycle.passes, kind: 'REVIEW' });
    if (review) {
      out.push({
        cycle,
        waitingFor: 'WAITING_FOR_A_READER',
        remedy: `bin ${review.binId} is open for a reader; nothing here can answer it`,
      });
      continue;
    }
    const render = await binRequestFor({ cycleId: cycle.id, pass: cycle.passes, kind: 'RENDER' });
    if (render) {
      out.push({
        cycle,
        waitingFor: 'WAITING_FOR_A_RENDER',
        remedy:
          `bin ${render.binId} is open for a machine with a browser: ` +
          `npm run design -- render --pass ${render.pass} --surfaces ${render.surfaceKeys.join(',')}`,
      });
      continue;
    }
    out.push({
      cycle,
      waitingFor: 'NOBODY_HAS_ASKED',
      remedy:
        'no render has been asked for. The tick asks by itself, so this means it has not run ' +
        'here, or it could not — check the pass’s problems.',
    });
  }
  return out;
}
