/**
 * The judged lane: a view about a screen, and everything that stops it being prose.
 *
 * ---------------------------------------------------------------------------
 * Why the judged lane needs a bin at all
 * ---------------------------------------------------------------------------
 *
 * Hierarchy, emphasis, density and grouping are not measurable. Whether a
 * screen's heading outline skips a level is a reading; whether the thing it
 * emphasises is the thing that matters is a view, and only something that can
 * read the screen against its purpose can hold it.
 *
 * §8's rule is that **model prose never mutates project state**, so this lane
 * goes exactly where every other model judgement in this codebase goes: a bin,
 * a fired worker, a validated structured submission, and recorded execution
 * lineage. There is no second path, no "trusted" caller and no in-process
 * provider. The deployed Brain has no `ANTHROPIC_API_KEY` and no
 * `BRAIN_PROVIDER` (§24), so the fleet is the only place a judgement can come
 * from anyway — and building a second one would be the parallel universe §27
 * refuses.
 *
 * ---------------------------------------------------------------------------
 * What the reviewer is given, and the limitation that follows
 * ---------------------------------------------------------------------------
 *
 * The brief carries the design problem (`model.ts`), the measured readings, the
 * heading outline, the control set and the counts. It does **not** carry the
 * image: Brain holds the bytes and hashes them, and nothing in the tool surface
 * can show a picture to anything that could form a view about it.
 *
 * That is stated in the brief, recorded as a limitation on
 * `VISUAL_COMPOSITION_FROM_PIXELS`, and is the first gap the expansion loop
 * finds. It is **not** papered over: a reviewer that was handed a description
 * and reported on "the visual balance" would be inventing, so the brief tells it
 * which questions it is in a position to answer and refuses the ones it is not.
 *
 * ---------------------------------------------------------------------------
 * Zero-trust on the way back
 * ---------------------------------------------------------------------------
 *
 * `validateJudgedSubmission` is `services/audit/schema.ts`' posture at a smaller
 * artifact. Enums are matched exactly. A judged submission claiming a *measured*
 * kind is refused by name — a view wearing a reading's name is the one thing
 * here that could not be argued with afterwards. A finding missing any of the
 * four required sentences is refused rather than filled in, because the four are
 * what make it a finding rather than a critique.
 *
 * And independence is checked twice: at admission, which the bin machinery
 * already does, and again here before anything is stored, because a lease can
 * expire and be retaken.
 */
import {
  createBin,
  dispatchedSessionForBin,
  listBinUnitResults,
  markBinReady,
  retireBin,
} from '../../repos/bins.ts';
import { workerSessionForBin } from '../../repos/fleet.ts';
import { getBinRequest, openBinRequest, recordFinding, recordReview } from '../../repos/design.ts';
import type {
  DesignCapture,
  DesignCycle,
  DesignFinding,
  DesignIndependenceTier,
  DesignSeverity,
  DesignReview,
  DesignSurface,
  DesignVerdict,
  JudgedKind,
} from '../../domain/design.ts';
import {
  DESIGN_SEVERITIES,
  JUDGED_KINDS,
  MEASURED_KINDS,
  PRIMITIVE_OF_KIND,
  isJudgedKind,
  isMeasuredKind,
} from '../../domain/design.ts';
import { describeProblem, problemBrief } from './model.ts';
import { digestCaptures } from './capture.ts';

export const DESIGN_REVIEW_CONTRACT = 'DESIGN_REVIEW_V1';
export const DESIGN_REVIEW_KIND = 'DESIGN_REVIEW';
/**
 * Design review is general work, not research and not repository work.
 *
 * `GENERAL_` so `classesForFamilies` routes it to the GENERAL family — which is
 * a prefix as well as the absence of one, a distinction §37 records the capability
 * kernel finding the hard way: a bin declaring `GENERAL_…` matched nothing and
 * the assigner answered NO_READY_BINS with everything about the bin correct.
 */
export const DESIGN_WORKLOAD_CLASS = 'GENERAL_DESIGN_REVIEW';

/** The one unit a review bin asks for. */
export const REVIEW_UNIT_KEY = 'design_review';

/**
 * The `created_by_id` one cycle's review bin for one pass carries.
 *
 * One function, called by the writer here and by the reader on the tick, so the
 * key cannot drift between them — "a rule applied by one of two readers is worse
 * than none", which this repository has recorded four times, at a string.
 */
export function reviewCreator(cycle: Pick<DesignCycle, 'id'>, pass: number): string {
  return `design:review:${cycle.id}:${pass}`;
}

/* =========================================================================
 * Asking
 * ====================================================================== */

export interface OpenReviewInput {
  cycle: DesignCycle;
  pass: number;
  projectId: string;
  surfaces: readonly DesignSurface[];
  captures: readonly DesignCapture[];
}

/**
 * Compose the brief and open the bin.
 *
 * The brief is built from rows — the surface's declared concepts and actions,
 * the patterns in scope, the owner's corrections, the measured readings — so
 * everything the reviewer is asked to reason from is something Brain can point
 * at afterwards. A brief assembled from prose somebody wrote once would make the
 * review unreproducible, which is the same defect `router.ts` avoids by keeping
 * its decision answerable from a recorded input.
 *
 * **The capture set it was briefed on is written down**, which is the half that
 * was missing: this function computed the digest and used it for nothing, so the
 * digest a review was finally recorded with came from reading the table back at
 * ingest time. `design_bin_requests` is the binding, and `ingestDesignReview`
 * refuses an answer whose evidence has moved underneath it.
 *
 * Idempotent by the round. The bin is created as a **draft** and only the caller
 * whose request row won the unique key marks it ready — §34's shape, and for its
 * reason: a draft is not dispatchable, so the loser retires one nothing could
 * ever have been fired at. Returns the bin that governs the round, which on a
 * second call is the first call's.
 */
export async function openDesignReview(input: OpenReviewInput): Promise<string> {
  const briefs: string[] = [];
  for (const surface of input.surfaces) {
    const problem = await describeProblem(surface);
    briefs.push(problemBrief(problem));
    briefs.push('');
    briefs.push(renderedState(surface, input.captures));
    briefs.push('');
    briefs.push('-'.repeat(72));
  }

  const digest = digestCaptures(input.captures);

  const bin = await createBin({
    projectId: input.projectId,
    layerId: null,
    kind: DESIGN_REVIEW_KIND,
    title: `Design review: ${input.surfaces.map((one) => one.surfaceKey).join(', ')}`,
    objective:
      'Read the rendered state of each surface below against what that surface is for, and report ' +
      'what is wrong with it as structured findings. Report nothing you are not in a position to ' +
      'establish from what you have been given.',
    rationale:
      'The measured lane has already reported everything geometry can settle. What is left are the ' +
      'questions only a reader can answer: whether the screen emphasises the thing that matters, ' +
      'whether the grouping follows the material, whether the density suits it, and whether any ' +
      'sentence on the screen contradicts a control beside it.',
    manifest: {
      objective: 'Judge the composition of the rendered surfaces described below.',
      why:
        'Brain can measure that a control is covered and cannot measure that the wrong thing is ' +
        'loud. This is the half of design evaluation that needs somebody to read the screen ' +
        'against its purpose.',
      lineage: {
        projectId: input.projectId,
        layerId: null,
        goal: 'An interface that does not have to be corrected by hand on every screen.',
        orchestrationId: null,
      },
      units: [
        {
          key: REVIEW_UNIT_KEY,
          establishes:
            'what is wrong with these surfaces that measurement cannot establish, and what would ' +
            'fix each one',
          /*
           * The brief is the unit's input rather than a field of its own. A
           * manifest has no free-text slot and inventing one would be a second
           * place a worker's instructions live; `acceptableSources` carries the
           * same text for a reader, exactly as the capability extraction bin
           * carries an amendment's body there.
           */
          input: briefs.join('\n'),
          transform: 'NONE',
          dependsOn: [],
        },
      ],
      acceptableSources: [
        'The rendered state of each surface, as described below: its heading outline, the controls ' +
          'a person can actually press, the element counts, and every measurement already taken.',
        'What each surface is for — the product concepts it represents, how much of each exists ' +
          'right now, and what a person can do there with how often and at what cost.',
        'The design patterns already learned, and the owner’s own corrections, both included below.',
        briefs.join('\n'),
      ],
      excludedSources: [
        'The image. You have not been shown one. Any statement about colour, balance, whitespace, ' +
          'beauty or "visual polish" is therefore invented, and is refused at validation.',
        'The source code. This is a review of a rendered interface, not of an implementation.',
        'General design advice not grounded in what this screen is for. "Improve the visual ' +
          'hierarchy" is the critique this contract exists to refuse.',
      ],
      evidence: [
        'Every finding names a region — a selector or a control name taken from the description ' +
          'below, so somebody can open the thing you mean.',
        'Every finding says why it matters *for this screen*, in terms of what a person is here to do.',
      ],
      outputs: [
        `One unit result under the key "${REVIEW_UNIT_KEY}", whose value is a JSON object with ` +
          '"verdict" and "findings".',
        '"verdict" is exactly one of CLEAN or CHANGES_REQUIRED. CLEAN means you read it and there ' +
          'is nothing worth changing, which is a real and common answer.',
        '"findings" is an array, empty when the verdict is CLEAN. Each entry has exactly: ' +
          '"surfaceKey", "region", "kind", "statement", "whyItMatters", "severity", "proposedRepair".',
        `"kind" is exactly one of: ${JUDGED_KINDS.join(', ')}. These are the kinds a reader can ` +
          'establish. Anything geometric has already been measured; naming one of ' +
          `${MEASURED_KINDS.join(', ')} is refused, because a view wearing a measurement’s name ` +
          'cannot be argued with afterwards.',
        `"severity" is exactly one of: ${DESIGN_SEVERITIES.join(', ')}.`,
        '"proposedRepair" says what would fix it. A finding with no remedy is a complaint.',
      ],
      authorizedActions: ['reading the description below', 'submitting one unit result'],
      prohibitedActions: [
        'changing any file, any row, any screen or any setting',
        'reporting anything about the appearance of an image you have not been shown',
        'reporting a defect that has already been measured and listed below',
        'reporting that something "could be improved" without saying what is wrong and what to do',
      ],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: [
        'a verdict and its findings have been submitted',
        'or the surfaces have been read and there is nothing worth changing, which is CLEAN with ' +
          'an empty findings array',
      ],
    },
    completionContract: DESIGN_REVIEW_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: reviewCreator(input.cycle, input.pass),
    /*
     * A draft, until the request row says this caller owns the round. A bin
     * created ready and then found to be a duplicate is one the fleet may
     * already have been fired at; a draft is not in `DISPATCHABLE_SQL` at all.
     */
    ready: false,
    priority: 5,
    maxAttempts: 3,
    workloadClass: DESIGN_WORKLOAD_CLASS,
  });

  const { request, created } = await openBinRequest({
    binId: bin.id,
    cycleId: input.cycle.id,
    pass: input.pass,
    kind: 'REVIEW',
    surfaceKeys: input.surfaces.map((one) => one.surfaceKey),
    revision: input.cycle.revision,
    captureDigest: digest.digest,
    captureCount: digest.count,
  });

  if (!created) {
    await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: 'design-kernel',
      reason:
        `A review of pass ${input.pass} of ${input.cycle.id} was already open as ` +
        `${request.binId}. This draft was never dispatchable and is retired rather than deleted.`,
    });
    return request.binId;
  }

  await markBinReady(bin.id);
  return bin.id;
}

/** The rendered state of one surface, as text a reader can reason from. */
function renderedState(surface: DesignSurface, captures: readonly DesignCapture[]): string {
  const mine = captures.filter((one) => one.surfaceKey === surface.surfaceKey);
  if (mine.length === 0) {
    return `WHAT IT RENDERED AS\n  Nothing was captured for ${surface.surfaceKey}.`;
  }
  const lines: string[] = ['WHAT IT RENDERED AS'];
  for (const capture of [...mine].sort((a, b) => b.width - a.width)) {
    lines.push('');
    lines.push(`  At ${capture.width}x${capture.height} (${capture.viewportName}):`);
    lines.push(
      `    ${capture.readings.counts.interactive} control(s), ` +
        `${capture.readings.counts.headings} heading(s), ` +
        `${capture.readings.counts.landmarks} landmark(s), ` +
        `${capture.readings.counts.textNodes} text block(s).`,
    );
    if (capture.readings.outline.length > 0) {
      lines.push('    Heading outline, in document order:');
      for (const entry of capture.readings.outline) {
        lines.push(`      ${'  '.repeat(Math.max(0, entry.level - 1))}h${entry.level} ${entry.text}`);
      }
    } else {
      lines.push('    No headings at all.');
    }
    if (capture.readings.reachableControls.length > 0) {
      lines.push(`    Pressable right now: ${capture.readings.reachableControls.join(', ')}.`);
    }
    if (capture.readings.deepestNesting) {
      lines.push(
        `    Deepest visible container nesting: ${capture.readings.deepestNesting.depth} ` +
          `at ${capture.readings.deepestNesting.where}.`,
      );
    }
    const measured = [
      capture.readings.horizontalOverflow ? 'the page scrolls sideways' : null,
      capture.readings.clipped.length > 0 ? `${capture.readings.clipped.length} clipped element(s)` : null,
      capture.readings.unreachable.length > 0
        ? `${capture.readings.unreachable.length} unreachable control(s)`
        : null,
      capture.readings.lowContrast.length > 0
        ? `${capture.readings.lowContrast.length} low-contrast text element(s)`
        : null,
    ].filter((one): one is string => one !== null);
    lines.push(
      measured.length > 0
        ? `    Already measured, so do not report these again: ${measured.join('; ')}.`
        : '    Nothing was found by measurement at this width.',
    );
    if (capture.readings.unreadable.length > 0) {
      lines.push(
        `    NOT READ: ${capture.readings.unreadable.join('; ')}. Treat these as unknown rather ` +
          'than as absent.',
      );
    }
  }
  return lines.join('\n');
}

/* =========================================================================
 * Validating what came back
 * ====================================================================== */

export interface JudgedFinding {
  surfaceKey: string;
  region: string;
  kind: JudgedKind;
  statement: string;
  whyItMatters: string;
  severity: DesignSeverity;
  proposedRepair: string;
}

export type JudgedSubmission =
  | { ok: true; verdict: DesignVerdict; findings: JudgedFinding[] }
  | { ok: false; problems: string[] };

const REQUIRED_KEYS = [
  'surfaceKey',
  'region',
  'kind',
  'statement',
  'whyItMatters',
  'severity',
  'proposedRepair',
] as const;

/**
 * Validate one submitted review, exactly.
 *
 * Whole-submission refusal rather than per-finding filtering, deliberately. §24
 * settles the same question for a proposal: *an unknown field refuses the whole
 * proposal*, because a caller that can have some of its output silently dropped
 * cannot tell a rejected finding from one that was never noticed, and will keep
 * sending it.
 */
export function validateJudgedSubmission(
  raw: string,
  knownSurfaces: readonly string[],
): JudgedSubmission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['The submission was not valid JSON.'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: ['The submission was not a structured object.'] };
  }
  const body = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const verdict = body['verdict'];
  if (verdict !== 'CLEAN' && verdict !== 'CHANGES_REQUIRED') {
    problems.push(
      `"verdict" must be exactly CLEAN or CHANGES_REQUIRED; got ${JSON.stringify(verdict)}.`,
    );
  }

  const rawFindings = body['findings'];
  if (!Array.isArray(rawFindings)) {
    problems.push('"findings" must be an array, empty when the verdict is CLEAN.');
    return { ok: false, problems };
  }

  const surfaces = new Set(knownSurfaces);
  const findings: JudgedFinding[] = [];
  rawFindings.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`findings[${index}] is not an object.`);
      return;
    }
    const row = entry as Record<string, unknown>;

    const extra = Object.keys(row).filter(
      (key) => !(REQUIRED_KEYS as readonly string[]).includes(key),
    );
    if (extra.length > 0) {
      problems.push(
        `findings[${index}] carries field(s) this contract does not define: ${extra.join(', ')}.`,
      );
    }

    for (const key of REQUIRED_KEYS) {
      const value = row[key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        problems.push(`findings[${index}].${key} must be a non-empty string.`);
      }
    }
    if (problems.length > 0 && extra.length === 0) {
      // Keep walking so every problem is reported at once: a worker told about
      // one field at a time needs one round trip per mistake.
    }

    const kind = String(row['kind'] ?? '');
    if (isMeasuredKind(kind)) {
      problems.push(
        `findings[${index}].kind is ${kind}, which is a measured kind. Geometry has already been ` +
          'read from the page; a judgement submitted under a measurement’s name could not be ' +
          'argued with afterwards.',
      );
    } else if (!isJudgedKind(kind)) {
      problems.push(
        `findings[${index}].kind must be exactly one of ${JUDGED_KINDS.join(', ')}; got ` +
          `${JSON.stringify(row['kind'])}.`,
      );
    }

    const severity = String(row['severity'] ?? '');
    if (!(DESIGN_SEVERITIES as readonly string[]).includes(severity)) {
      problems.push(
        `findings[${index}].severity must be exactly one of ${DESIGN_SEVERITIES.join(', ')}; got ` +
          `${JSON.stringify(row['severity'])}.`,
      );
    }

    const surfaceKey = String(row['surfaceKey'] ?? '');
    if (!surfaces.has(surfaceKey)) {
      problems.push(
        `findings[${index}].surfaceKey is ${JSON.stringify(row['surfaceKey'])}, which is not one ` +
          `of the surfaces this review was about (${[...surfaces].join(', ')}).`,
      );
    }

    if (problems.length === 0) {
      findings.push({
        surfaceKey,
        region: String(row['region']).slice(0, 200),
        kind: kind as JudgedKind,
        statement: String(row['statement']),
        whyItMatters: String(row['whyItMatters']),
        severity: severity as DesignSeverity,
        proposedRepair: String(row['proposedRepair']),
      });
    }
  });

  if (problems.length > 0) return { ok: false, problems };

  /*
   * A CLEAN verdict with findings, or CHANGES_REQUIRED with none, is refused
   * rather than reconciled. §8's rule about the judge's counts being
   * cross-checked against the gaps it classified: a verdict that disagrees with
   * its own content is one nobody can rely on, and choosing which half to
   * believe would be Brain deciding the outcome.
   */
  if (verdict === 'CLEAN' && findings.length > 0) {
    return {
      ok: false,
      problems: [
        `The verdict is CLEAN and ${findings.length} finding(s) were submitted. A verdict that ` +
          'disagrees with its own content cannot be relied on either way.',
      ],
    };
  }
  if (verdict === 'CHANGES_REQUIRED' && findings.length === 0) {
    return {
      ok: false,
      problems: [
        'The verdict is CHANGES_REQUIRED and no finding says what should change, so there is ' +
          'nothing anybody could act on.',
      ],
    };
  }

  return { ok: true, verdict: verdict as DesignVerdict, findings };
}

/* =========================================================================
 * Independence
 * ====================================================================== */

export interface ReviewLineage {
  sessionId: string | null;
  workerId: string | null;
  accountId: string | null;
  routineId: string | null;
}

export type IndependenceDecision =
  | { ok: true; tier: DesignIndependenceTier; detail: string }
  | { ok: false; reason: string };

/**
 * What separation this reviewer achieved, over the sessions that made the change.
 *
 * The refusal is the floor and everything above it is a report. The shape is
 * `services/factory/review.ts`' `decideIndependence`, deliberately identical —
 * the threat is the same threat, and two implementations of one rule are how the
 * quieter of them stops being a boundary.
 *
 * A design cycle with **no** authoring sessions is not refused, and that is the
 * one real difference: a cycle triggered by proactive expansion or by a person
 * asking has nobody to be independent *of*, so the honest tier is
 * `NOT_APPLICABLE` rather than a refusal. What must not happen is that being
 * reported as separation it did not achieve.
 */
export function decideReviewIndependence(
  reviewer: ReviewLineage,
  authors: readonly ReviewLineage[],
): IndependenceDecision {
  if (!reviewer.sessionId || !reviewer.workerId) {
    return {
      ok: false,
      reason:
        'The reviewer has no resolvable lineage. An independence that cannot be established has ' +
        'not been established.',
    };
  }
  if (reviewer.sessionId.startsWith('future:')) {
    return {
      ok: false,
      reason: 'A predicted session is allocator reasoning, never evidence of independence.',
    };
  }

  const real = authors.filter((one) => one.sessionId !== null);
  if (real.length === 0) {
    return {
      ok: true,
      tier: 'NOT_APPLICABLE',
      detail:
        'no session authored the change this cycle is about, so there is nobody for the reviewer ' +
        'to be independent of — reported as such rather than as separation it did not achieve',
    };
  }

  if (real.some((one) => one.sessionId === reviewer.sessionId)) {
    return {
      ok: false,
      reason:
        'That session made the change this review is about. One model context reviewing its own ' +
        'work is the thing an independent review exists to defeat.',
    };
  }

  const sameWorker = real.some((one) => one.workerId !== null && one.workerId === reviewer.workerId);
  const sameAccount = real.some(
    (one) => one.accountId !== null && one.accountId === reviewer.accountId,
  );
  const sameRoutine = real.some(
    (one) => one.routineId !== null && one.routineId === reviewer.routineId,
  );

  if (reviewer.accountId !== null && !sameAccount) {
    return { ok: true, tier: 'ACCOUNT_SEPARATED', detail: 'a different account reviewed it' };
  }
  if (!sameWorker) {
    return { ok: true, tier: 'WORKER_SEPARATED', detail: 'a different worker on the same account' };
  }
  if (reviewer.routineId !== null && !sameRoutine) {
    return { ok: true, tier: 'ROUTINE_SEPARATED', detail: 'a different Routine bound to one worker' };
  }
  return {
    ok: true,
    tier: 'SESSION_SEPARATED',
    detail: 'a different session of the same worker, which is the floor',
  };
}

/* =========================================================================
 * Ingesting
 * ====================================================================== */

export interface IngestOutcome {
  review: DesignReview | null;
  findings: DesignFinding[];
  refused: string | null;
}

/**
 * Read a finished review bin and store what survives.
 *
 * Refuses rather than partially storing. A review whose submission did not
 * validate produces a `REFUSED` row carrying the problems — because §8's rule
 * is that a failure and its raw response are still persisted: *a verdict you
 * cannot trace is not auditable*, and a refusal nobody can see is a review that
 * looks like it never happened.
 */
export async function ingestDesignReview(input: {
  binId: string;
  cycle: DesignCycle;
  pass: number;
  captures: readonly DesignCapture[];
  surfaceKeys: readonly string[];
  /** Sessions that made the change this cycle is about. May be empty. */
  authors: readonly ReviewLineage[];
  /** Overridden in tests; resolved from Brain's own dispatch row otherwise. */
  reviewer?: ReviewLineage;
}): Promise<IngestOutcome> {
  const digest = digestCaptures(input.captures);
  const results = await listBinUnitResults(input.binId);
  const submitted = results.find((row) => row.unitKey === REVIEW_UNIT_KEY);

  const reviewer = input.reviewer ?? (await lineageFor(input.binId, results));

  const refuse = async (detail: string): Promise<IngestOutcome> => {
    const review = await recordReview({
      cycleId: input.cycle.id,
      pass: input.pass,
      lane: 'JUDGED',
      captureDigest: digest.digest,
      captureCount: digest.count,
      binId: input.binId,
      /*
       * The schema requires a worker and a session on a judged row, because a
       * judged review with no lineage establishes nothing. A refusal that cannot
       * name who it refused is recorded against the bin instead, which is a fact
       * Brain owns.
       */
      workerId: reviewer.workerId ?? `unresolved:${input.binId}`,
      sessionRef: reviewer.sessionId ?? `unresolved:${input.binId}`,
      accountId: reviewer.accountId,
      routineId: reviewer.routineId,
      independenceTier: null,
      verdict: 'REFUSED',
      detail,
      findingsCount: 0,
    });
    return { review, findings: [], refused: detail };
  };

  if (!submitted) {
    return refuse('The review bin finished with no submission, so nothing was judged.');
  }

  /*
   * The evidence has to be the evidence this reviewer was shown.
   *
   * `design_bin_requests` recorded the digest when the question was asked, and
   * `digest` above is the same computation over the captures that exist now. A
   * capture written in between — a resumed pass, a second renderer, a re-render
   * against a newer tree — makes those two different numbers, and a review of a
   * set that has changed is stale by §23's own definition: *a document whose
   * bytes changed is a different operation rather than a repeat.*
   *
   * Refused rather than recorded-with-the-new-digest, because the second would
   * settle the current cycle on a judgement nobody made about it. A request
   * Brain has no row for is also refused: unknown binding fails closed, which is
   * the same answer this repository gives everywhere else it cannot tell.
   */
  const request = await getBinRequest(input.binId);
  if (!request) {
    return refuse(
      'No record says what this review was asked about, so there is nothing to hold its answer ' +
        'against. An unbound judgement could have been briefed on any capture set at all.',
    );
  }
  if (request.captureDigest !== digest.digest) {
    return refuse(
      `The evidence moved: this review was briefed on ${request.captureCount} capture(s) ` +
        `digesting ${String(request.captureDigest).slice(0, 12)}…, and pass ${input.pass} of ` +
        `${input.cycle.id} now holds ${digest.count} digesting ${digest.digest.slice(0, 12)}…. ` +
        'A judgement about one set may not settle another.',
    );
  }

  /*
   * Independence, asked again before anything is stored.
   *
   * Already asked at admission by the bin machinery. Asked again here for
   * §23's reason: a lease can expire and be retaken, so eligible at claim time
   * is not eligible at submit time.
   */
  const independence = decideReviewIndependence(reviewer, input.authors);
  if (!independence.ok) return refuse(independence.reason);

  const validated = validateJudgedSubmission(submitted.value, input.surfaceKeys);
  if (!validated.ok) {
    return refuse(`The submission did not validate: ${validated.problems.join(' ')}`);
  }

  const review = await recordReview({
    cycleId: input.cycle.id,
    pass: input.pass,
    lane: 'JUDGED',
    captureDigest: digest.digest,
    captureCount: digest.count,
    binId: input.binId,
    workerId: reviewer.workerId,
    sessionRef: reviewer.sessionId,
    accountId: reviewer.accountId,
    routineId: reviewer.routineId,
    independenceTier: independence.tier,
    verdict: validated.verdict,
    detail: independence.detail,
    findingsCount: validated.findings.length,
  });

  const findings: DesignFinding[] = [];
  for (const judged of validated.findings) {
    /*
     * A judged finding is attached to the *widest* capture of its surface.
     *
     * One capture rather than all of them, because a composition judgement is
     * about the screen rather than about a width — and recording it against
     * three captures would make one view read as three findings, which is
     * exactly what the repair loop's stopping count must not be inflated by.
     */
    const capture = widestCaptureOf(input.captures, judged.surfaceKey);
    if (!capture) continue;
    const { finding } = await recordFinding({
      cycleId: input.cycle.id,
      reviewId: review.id,
      captureId: capture.id,
      pass: input.pass,
      surfaceKey: judged.surfaceKey,
      region: judged.region,
      lane: 'JUDGED',
      kind: judged.kind,
      primitive: PRIMITIVE_OF_KIND[judged.kind],
      statement: judged.statement,
      whyItMatters: judged.whyItMatters,
      severity: judged.severity,
      evidence: {
        reviewId: review.id,
        binId: input.binId,
        captureDigest: digest.digest,
        independence: independence.tier,
      },
      proposedRepair: judged.proposedRepair,
    });
    findings.push(finding);
  }

  return { review, findings, refused: null };
}

function widestCaptureOf(
  captures: readonly DesignCapture[],
  surfaceKey: string,
): DesignCapture | null {
  const mine = captures.filter((one) => one.surfaceKey === surfaceKey);
  if (mine.length === 0) return null;
  return mine.reduce((widest, one) => (one.width > widest.width ? one : widest));
}

/**
 * Who reviewed it, from Brain's own record of the fire.
 *
 * `finishBin` clears the worker, the lease and the credential in one statement,
 * so a finished bin cannot say who finished it. The dispatch row it was fired
 * through can, keyed by the lease generation the unit result carries — §27's
 * `workerSessionForBin` reasoning, and the same refusal to read it off anything
 * the worker said about itself.
 */
async function lineageFor(
  binId: string,
  results: Awaited<ReturnType<typeof listBinUnitResults>>,
): Promise<ReviewLineage> {
  const result = results.find((row) => row.unitKey === REVIEW_UNIT_KEY) ?? results[0];
  const workerId = result?.submittedBy ?? null;
  const sessionId =
    result?.leaseGeneration !== null && result?.leaseGeneration !== undefined
      ? await dispatchedSessionForBin(binId, result.leaseGeneration)
      : null;

  /*
   * The account and the Routine come from `worker_sessions` — Brain's own record
   * of which fire produced this session — and never from the static worker
   * binding, which §24 records as ambiguous the moment two Routines share one
   * worker identity. A session Brain did not fire resolves to neither, and that
   * is reported as unknown rather than filled in from the binding.
   */
  const session = await workerSessionForBin(binId);

  return {
    sessionId,
    workerId,
    accountId: session?.accountId ?? null,
    routineId: session?.routineId ?? null,
  };
}
