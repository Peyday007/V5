/**
 * LOOP 1 — do useful design work now.
 *
 * ---------------------------------------------------------------------------
 * The loop, and where each half of it happens
 * ---------------------------------------------------------------------------
 *
 *   render the real interface
 *     → measure it
 *       → judge what measurement cannot settle
 *         → repair
 *           → render again
 *             → measure again
 *               → settle, or stop honestly
 *
 * The measured half runs here, synchronously, because it needs a browser and a
 * running product and nothing else. The judged half is a bin: §8's rule is that
 * model prose never mutates state, and the deployed Brain has no provider of its
 * own (§24), so a view about a screen arrives the way every other model
 * judgement in this codebase arrives — a fired worker, a validated submission,
 * recorded lineage. That means a cycle wanting a judgement **opens the bin and
 * leaves the pass open**; `advanceDesignCycles` on the tick is what reads the
 * answer, which is also what makes the loop survive a restart.
 *
 * ---------------------------------------------------------------------------
 * The stopping condition is the point of the whole module
 * ---------------------------------------------------------------------------
 *
 * A design loop with no bound is the failure mode a design system falls into by
 * default: render, dislike, adjust, render, dislike, adjust. §12's rule is that
 * when the budget runs out the honest outcome is *unresolved*, recorded as such
 * — so `MAX_DESIGN_PASSES` is three, and a cycle that reaches it closes
 * `REPAIR_EXHAUSTED` **with its findings still OPEN**. Closing them to make the
 * cycle read as finished would be the silent success this whole kernel exists
 * not to produce.
 *
 * ---------------------------------------------------------------------------
 * What counts as a repair, said plainly
 * ---------------------------------------------------------------------------
 *
 * Almost every design repair in this product is a change to client code, and
 * §27 reserves authorizing a change to a person. So the default strategy
 * **prepares** the change and routes it — it does not write to a repository, and
 * nothing here can. What the loop does do by itself is the other half, which is
 * real and is not a formality: re-render and re-measure, so a finding that was
 * about a transient state, a race, or a condition that has since been fixed is
 * **closed by the evidence of a later capture** rather than by anybody's say-so.
 *
 * `RepairStrategy` is injected so the boundary is visible rather than assumed. A
 * strategy that could write files would be a different authority decision, made
 * where there is authority to make it — never here, by default, quietly.
 */
import type {
  DesignCapture,
  DesignCycle,
  DesignFinding,
  DesignSeverity,
  DesignStopReason,
  DesignSurface,
  DesignTrigger,
} from '../../domain/design.ts';
import { SEVERITY_RANK } from '../../domain/design.ts';
import {
  advanceCyclePass,
  closeCycle,
  getCycle,
  listFindings,
  observeCapability,
  openCycle,
  recordReview,
  settleFinding,
} from '../../repos/design.ts';
import { captureSurfaces, digestCaptures, type CaptureOutcome } from './capture.ts';
import { evaluateCaptures, summarise, type EvaluationSummary } from './evaluate.ts';
import { resolveSurfaces } from './surfaces.ts';
import { probeRenderRuntime } from './renderRuntime.ts';

/**
 * How many render-evaluate-repair rounds one cycle may spend.
 *
 * Three. Not a tuning parameter dressed as a constant: the first pass finds what
 * is wrong, the second checks whether a repair landed, and the third is the one
 * round of slack a real fix sometimes needs. A fourth is where a loop stops
 * converging and starts oscillating, and the honest thing at that point is to
 * say so rather than to keep going.
 */
export const MAX_DESIGN_PASSES = 3;

/* =========================================================================
 * Repair
 * ====================================================================== */

export interface RepairAttempt {
  findingId: string;
  /** What was done, or why nothing was. Recorded either way. */
  outcome: string;
  /** Whether anything changed that a later render could show. */
  changed: boolean;
  /** Where the repair went, when it went somewhere a person has to answer. */
  routedTo: string | null;
}

export interface RepairStrategy {
  name: string;
  attempt(finding: DesignFinding, context: { surface: DesignSurface | null }): Promise<RepairAttempt>;
}

/**
 * The default: prepare the change and say where it has to go.
 *
 * It changes nothing, and that is a boundary rather than a limitation being
 * apologised for. A design repair here is a change to client code; §27 reserves
 * authorizing one to a person on the Build surface, and a kernel that wrote to
 * the repository to fix a layout would be the thing §22's split forbids — Brain
 * choosing its own permissions to get around where the authority actually lives.
 *
 * So each finding comes back with the objective a person would authorize,
 * composed from the finding's own statement and proposed repair. `changed` is
 * false, which is honest and has a consequence the loop respects: a pass in
 * which nothing changed does not re-render, because re-rendering an unchanged
 * product to see whether a defect went away is a browser run spent learning
 * nothing.
 */
export const PREPARE_FOR_BUILD: RepairStrategy = {
  name: 'PREPARE_FOR_BUILD',
  async attempt(finding) {
    return {
      findingId: finding.id,
      changed: false,
      routedTo: 'BUILD',
      outcome:
        `Prepared as a change somebody authorizes on Build: "${finding.statement} ` +
        `${finding.proposedRepair}" — this kernel does not write to a repository, and ` +
        'authorizing a change to one is a person’s decision.',
    };
  },
};

/* =========================================================================
 * A pass
 * ====================================================================== */

export interface PassInput {
  cycle: DesignCycle;
  baseUrl: string;
  cookie?: { name: string; value: string } | null;
  outputDir: string;
  satisfied?: readonly string[];
  /** Overridden in tests; discovered otherwise. */
  capture?: (request: Parameters<typeof captureSurfaces>[0]) => Promise<CaptureOutcome>;
}

export interface PassResult {
  pass: number;
  captures: DesignCapture[];
  skipped: { surfaceKey: string; reason: string }[];
  findings: DesignFinding[];
  summary: EvaluationSummary;
  /** The digest of what was looked at, so a review or an approval can bind to it. */
  captureDigest: string;
  /** Findings a later capture no longer shows, closed by that evidence. */
  closed: { findingId: string; because: string }[];
}

/**
 * One render-and-measure pass, and the settling of what it no longer sees.
 *
 * The closing half is what makes this a loop rather than a report. A finding
 * from pass 1 that pass 2's capture does not reproduce is `REPAIRED`, and the
 * `resolved_by` column names **the capture that no longer shows it** — so the
 * claim "this was fixed" resolves to a hash and a revision rather than to
 * somebody having said so. That is the same standard §27 holds a factory unit
 * to: a worker's summary is never evidence; the branch is.
 */
export async function runPass(input: PassInput): Promise<PassResult> {
  const cycle = input.cycle;
  const { surfaces } = await resolveSurfaces(cycle.surfaceKeys);
  const pass = cycle.passes;

  const capture = input.capture ?? captureSurfaces;
  const outcome = await capture({
    baseUrl: input.baseUrl,
    cookie: input.cookie ?? null,
    surfaces,
    cycleId: cycle.id,
    pass,
    outputDir: input.outputDir,
    satisfied: input.satisfied,
  });

  const evaluation = await evaluateCaptures({
    cycleId: cycle.id,
    pass,
    captures: outcome.captures,
  });

  await observeCapability({
    capabilityKey: 'RENDER_REAL_INTERFACE',
    failed: outcome.captures.length === 0,
    evidenceRef: cycle.id,
  });
  await observeCapability({
    capabilityKey: 'MEASURE_LAYOUT_FAULTS',
    failed: evaluation.unreadable.length > 0,
    evidenceRef: cycle.id,
  });
  /*
   * The accessibility floor is its own capability and is observed separately.
   *
   * Separate because it fails separately: a page whose geometry reads perfectly
   * can be one whose text sits over photographs, and folding the two into one
   * counter would report a reader that answered nothing as a reader that worked.
   * A partial contrast measurement is the failure here — `partial` rather than
   * `unreadable`, because that is precisely what this capability's stated
   * limitation is about.
   */
  await observeCapability({
    capabilityKey: 'MEASURE_ACCESSIBILITY_FLOOR',
    failed: evaluation.partial.length > 0,
    evidenceRef: cycle.id,
  });

  /*
   * A measured review row per pass.
   *
   * The measured lane needs no worker and no lineage, and the row exists so that
   * "what was looked at, and what was concluded" is answerable for a pass that
   * found nothing — a clean pass with no row would be indistinguishable from a
   * pass that never ran.
   */
  const digest = digestCaptures(outcome.captures);
  const summary = summarise(evaluation);
  await recordReview({
    cycleId: cycle.id,
    pass,
    lane: 'MEASURED',
    captureDigest: digest.digest,
    captureCount: digest.count,
    independenceTier: 'NOT_APPLICABLE',
    verdict: summary.clean ? 'CLEAN' : 'CHANGES_REQUIRED',
    detail: summary.reason,
    findingsCount: evaluation.findings.length,
  });

  const closed = pass > 0 ? await closeWhatIsGone(cycle, outcome.captures, pass) : [];

  return {
    pass,
    captures: outcome.captures,
    skipped: outcome.skipped,
    findings: evaluation.findings,
    summary,
    captureDigest: digest.digest,
    closed,
  };
}

/**
 * Close the findings this pass's captures no longer reproduce.
 *
 * **Only measured findings**, and that is the load-bearing restriction. A
 * measured finding is a fact about a capture, so a later capture of the same
 * surface at the same width genuinely settles it. A *judged* finding is a view,
 * and a later render does not refute a view — closing one because a new
 * screenshot exists would be exactly the silent success this kernel is for.
 * Judged findings are settled by a later judgement or by a person.
 */
async function closeWhatIsGone(
  cycle: DesignCycle,
  captures: readonly DesignCapture[],
  pass: number,
): Promise<{ findingId: string; because: string }[]> {
  const closed: { findingId: string; because: string }[] = [];
  const open = await listFindings({ cycleId: cycle.id, state: 'OPEN', lane: 'MEASURED', limit: 500 });
  if (open.length === 0) return closed;

  const nowFound = await listFindings({ cycleId: cycle.id, lane: 'MEASURED', limit: 1000 });
  const thisPass = new Set(
    nowFound.filter((one) => one.pass === pass).map((one) => `${one.surfaceKey}|${one.kind}|${one.region}`),
  );

  for (const finding of open) {
    if (finding.pass >= pass) continue;
    const key = `${finding.surfaceKey}|${finding.kind}|${finding.region}`;
    if (thisPass.has(key)) continue;

    /*
     * Which capture is the evidence. The one of the same surface at the same
     * width, because a finding measured at 390px is not settled by a render at
     * 1180 — and a `resolved_by` naming the wrong picture would be a citation
     * that does not check out, which §10 refuses at every other altitude.
     */
    const width = Number((finding.evidence as { width?: unknown }).width ?? NaN);
    const evidence =
      captures.find(
        (one) => one.surfaceKey === finding.surfaceKey && (Number.isNaN(width) || one.width === width),
      ) ?? null;
    if (!evidence) continue;

    const because =
      `Pass ${pass} rendered ${finding.surfaceKey} at ${evidence.width}px and the measurement no ` +
      `longer shows it. Capture ${evidence.id} (sha-256 ${evidence.contentHash.slice(0, 12)}…` +
      `${evidence.revision ? `, revision ${evidence.revision.slice(0, 8)}` : ', unstamped tree'}) ` +
      'is what settles it.';
    if (await settleFinding({ id: finding.id, state: 'REPAIRED', resolution: because, resolvedBy: evidence.id })) {
      closed.push({ findingId: finding.id, because });
    }
  }
  return closed;
}

/* =========================================================================
 * The cycle
 * ====================================================================== */

export interface CycleInput {
  triggerKind: DesignTrigger;
  triggerRef: string | null;
  surfaceKeys: readonly string[];
  baseUrl: string;
  cookie?: { name: string; value: string } | null;
  outputDir: string;
  satisfied?: readonly string[];
  repair?: RepairStrategy;
  maxPasses?: number;
  capture?: PassInput['capture'];
  /** Set when the caller wants the tree it rendered recorded on the cycle. */
  revision?: string | null;
}

export interface CycleResult {
  cycle: DesignCycle;
  passes: PassResult[];
  repairs: RepairAttempt[];
  stopReason: DesignStopReason;
  stopDetail: string;
  /** Findings left open when it stopped. Never emptied to look finished. */
  unresolved: DesignFinding[];
}

/**
 * Open a cycle and run it to a stop.
 *
 * Every exit records *why*, from a closed set, and only one of the five is
 * `SETTLED`. §24's sentence at a fifth altitude: a state that says it is waiting
 * for something nobody can supply is stuck rather than waiting — so a cycle with
 * no render runtime closes `NO_RENDER_RUNTIME` naming the remedy, rather than
 * sitting open for ever waiting for a browser to appear.
 */
export async function runDesignCycle(input: CycleInput): Promise<CycleResult> {
  const { surfaces } = await resolveSurfaces(input.surfaceKeys);
  const cycle = await openCycle({
    triggerKind: input.triggerKind,
    triggerRef: input.triggerRef,
    surfaceKeys: surfaces.map((one) => one.surfaceKey),
    revision: input.revision ?? null,
  });
  return driveCycle(cycle, input);
}

/**
 * Pick up a cycle somebody else opened and run it.
 *
 * This is the half that makes UI-impact routing honest. `requestDesignCycle`
 * runs where a change integrates — on a server with no browser — so it opens the
 * cycle and stops; this runs where a browser exists. The cycle stays `OPEN` in
 * between, which is a state with an answering transition rather than a park: the
 * operator surface lists it, and `npm run design resume` is the transition.
 *
 * §24's rule is that a state saying it is waiting for something nobody can
 * supply is stuck. This one names exactly what it is waiting for and exactly who
 * can supply it, which is the difference.
 */
export async function resumeDesignCycle(
  cycle: DesignCycle,
  input: Omit<CycleInput, 'triggerKind' | 'triggerRef' | 'surfaceKeys'>,
): Promise<CycleResult> {
  return driveCycle(cycle, { ...input, surfaceKeys: cycle.surfaceKeys });
}

async function driveCycle(
  cycle: DesignCycle,
  input: Omit<CycleInput, 'triggerKind' | 'triggerRef'>,
): Promise<CycleResult> {
  const maxPasses = Math.max(1, input.maxPasses ?? MAX_DESIGN_PASSES);
  const repair = input.repair ?? PREPARE_FOR_BUILD;

  const { surfaces, unknown } = await resolveSurfaces(cycle.surfaceKeys);

  const runtime = probeRenderRuntime();
  if (!runtime.available) {
    const detail = `${runtime.reason} ${runtime.install.join(' ')}`.trim();
    await closeCycle({ id: cycle.id, stopReason: 'NO_RENDER_RUNTIME', stopDetail: detail });
    return {
      cycle: (await getCycle(cycle.id))!,
      passes: [],
      repairs: [],
      stopReason: 'NO_RENDER_RUNTIME',
      stopDetail: detail,
      unresolved: [],
    };
  }

  if (surfaces.length === 0) {
    const detail =
      unknown.length > 0
        ? `None of the requested surfaces is registered: ${unknown.join(', ')}.`
        : 'No surface was requested, so there was nothing to look at.';
    await closeCycle({ id: cycle.id, stopReason: 'ABANDONED', stopDetail: detail });
    return {
      cycle: (await getCycle(cycle.id))!,
      passes: [],
      repairs: [],
      stopReason: 'ABANDONED',
      stopDetail: detail,
      unresolved: [],
    };
  }

  const passes: PassResult[] = [];
  const repairs: RepairAttempt[] = [];
  const bySurface = new Map(surfaces.map((one) => [one.surfaceKey, one]));

  let current = cycle;
  let stopReason: DesignStopReason = 'REPAIR_EXHAUSTED';
  let stopDetail = '';

  for (let round = 0; round < maxPasses; round += 1) {
    const result = await runPass({
      cycle: current,
      baseUrl: input.baseUrl,
      cookie: input.cookie,
      outputDir: input.outputDir,
      satisfied: input.satisfied,
      capture: input.capture,
    });
    passes.push(result);

    const open = await listFindings({ cycleId: current.id, state: 'OPEN', limit: 500 });
    if (open.length === 0 && result.summary.clean) {
      stopReason = 'SETTLED';
      stopDetail =
        `Pass ${result.pass} rendered ${result.captures.length} capture(s) and nothing is open. ` +
        `Digest ${result.captureDigest.slice(0, 12)}…`;
      break;
    }

    /*
     * A pass that could read nothing is not a pass that found nothing.
     *
     * §9's rule, at the loop rather than at the finding: a surface whose readers
     * threw has not been checked, and spending another round rendering it would
     * be spending a browser run on the same unreadable thing. It stops and says
     * which reader could not answer.
     */
    if (result.captures.length === 0) {
      stopReason = 'NO_RENDER_RUNTIME';
      stopDetail =
        'Nothing was captured: ' +
        result.skipped.map((one) => `${one.surfaceKey} — ${one.reason}`).join('; ');
      break;
    }

    if (round === maxPasses - 1) {
      stopReason = 'REPAIR_EXHAUSTED';
      stopDetail =
        `${maxPasses} pass(es) spent and ${open.length} finding(s) are still open, the worst of ` +
        `them ${worst(open)}. They stay open: closing them to make this cycle read as finished ` +
        'would be the silent success this loop exists not to produce.';
      break;
    }

    /*
     * Repair, worst first. Severity order rather than discovery order, because a
     * round is a scarce thing and a blocker fixed is worth more than four nits.
     */
    let anythingChanged = false;
    for (const finding of [...open].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])) {
      const attempt = await repair.attempt(finding, {
        surface: bySurface.get(finding.surfaceKey) ?? null,
      });
      repairs.push(attempt);
      if (attempt.changed) anythingChanged = true;
    }
    await observeCapability({
      capabilityKey: 'REPAIR_WITHIN_BOUNDS',
      failed: !anythingChanged,
      evidenceRef: current.id,
    });

    if (!anythingChanged) {
      /*
       * Nothing changed, so another render would photograph the same product.
       *
       * `NEEDS_PERSON` rather than `REPAIR_EXHAUSTED`, because the two have
       * different remedies and §24's rule is that an escalation has to name one:
       * exhausted means the loop tried and could not converge, and this means the
       * repair is a decision somebody else makes. Reporting the second as the
       * first would send somebody to look at the loop.
       */
      stopReason = 'NEEDS_PERSON';
      stopDetail =
        `${open.length} finding(s) are open and every repair for them is a change to code, which ` +
        `is a person’s to authorize on Build. Prepared: ` +
        `${repairs.filter((one) => one.routedTo === 'BUILD').length}.`;
      break;
    }

    if (!(await advanceCyclePass(current.id, current.passes))) {
      stopReason = 'ABANDONED';
      stopDetail = 'Another pass advanced this cycle at the same moment; this one stood down.';
      break;
    }
    current = (await getCycle(current.id))!;
  }

  await closeCycle({ id: current.id, stopReason, stopDetail });
  const unresolved = await listFindings({ cycleId: current.id, state: 'OPEN', limit: 500 });

  /*
   * A cycle that stopped with findings open marks them UNRESOLVED rather than
   * leaving them OPEN for ever. The distinction is the one §12 draws: the work
   * stopped, and the finding is still true — so it is a thing somebody has to
   * answer rather than a thing this loop is still working on.
   */
  if (stopReason === 'REPAIR_EXHAUSTED' || stopReason === 'NEEDS_PERSON') {
    for (const finding of unresolved) {
      await settleFinding({
        id: finding.id,
        state: 'UNRESOLVED',
        resolution: stopDetail,
        resolvedBy: current.id,
      });
    }
  }

  return {
    cycle: (await getCycle(current.id))!,
    passes,
    repairs,
    stopReason,
    stopDetail,
    unresolved,
  };
}

function worst(findings: readonly DesignFinding[]): DesignSeverity {
  return findings.reduce<DesignSeverity>(
    (best, one) => (SEVERITY_RANK[one.severity] < SEVERITY_RANK[best] ? one.severity : best),
    'NIT',
  );
}
