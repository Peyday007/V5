/**
 * One design cycle, walked the whole way, with nothing arranged in the middle.
 *
 * ---------------------------------------------------------------------------
 * Why a walk and not more unit tests
 * ---------------------------------------------------------------------------
 *
 * `designKernel.test.ts` is fifty-four assertions about what the kernel may and
 * may not conclude, and every one of them passed while **the judged lane was
 * reachable by nothing**: `openDesignReview` had exactly one caller in the whole
 * repository and it was that file. A test that arranges its own starting state
 * cannot tell a mechanism from a function nobody calls, which is a sentence §24
 * and §30 have both already had to write after walking a journey found five
 * transitions that were tested and dead.
 *
 * So this walks it once, from a change landing to a cycle closing:
 *
 *   a change integrates
 *     → `requestDesignCycle` opens a cycle on a Brain with no browser
 *       → the tick asks for a render, as a bin
 *         → a worker claims it, renders, submits, completes
 *           → the tick reads it back, records captures, measures them
 *             → the tick asks for the judgement, as a bin
 *               → a *different* session claims it and submits a verdict
 *                 → the tick reads that back and closes the cycle
 *
 * ---------------------------------------------------------------------------
 * What is real here and what is not, said rather than implied
 * ---------------------------------------------------------------------------
 *
 * **Real**: the route, the tick, the bins, the leases, the fencing generations,
 * the completion contracts, `assignNextBin`'s admission, the zero-trust
 * validators, the independence decision over recorded lineage, the capture rows,
 * the measured findings, and the cycle's own stop reason.
 *
 * **Simulated**: the Cowork activation. No Routine is fired, no provider is
 * called and no token is minted — the workers are `WORKER` principals claiming
 * real bins off the real queue, which is exactly what `cashIntegrationPass` and
 * `sharedKnowledge` already say of themselves. And the capture *metadata* is a
 * fixture rather than a live Chromium run, because a twenty-second render per
 * assertion is a test nobody runs; the live render is
 * `npm run design render`, and what it produced is in `docs/DESIGN-KERNEL.md`.
 *
 * A fleet-fired review needs this branch deployed, which is a person's decision.
 * That is stated here so nobody reads a green file as that having happened.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createWorker } from '../server/repos/identity.ts';
import { closeSession, openSession } from '../server/repos/factoryFleet.ts';
import {
  assignNextBin,
  claimDispatchIntent,
  ensureDispatchIntent,
  finishBin,
  getBin,
  listBins,
  markDispatchSent,
  putBinUnitResult,
} from '../server/repos/bins.ts';
import {
  getCycle,
  listCaptures,
  listFindings,
  listReviews,
  binRequestFor,
  recordCapture,
} from '../server/repos/design.ts';
import type { CaptureReadings } from '../server/domain/design.ts';
import { seedDesignKernel, runDesignKernel } from '../server/services/design/kernel.ts';
import { requestDesignCycle } from '../server/services/design/route.ts';
import { ingestDesignReview, REVIEW_UNIT_KEY } from '../server/services/design/judge.ts';
import { RENDER_UNIT_KEY, validateRenderSubmission } from '../server/services/design/render.ts';
import { resolveSurfaces } from '../server/services/design/surfaces.ts';

const SURFACE = 'russell/default';

function readings(overrides: Partial<CaptureReadings> = {}): CaptureReadings {
  return {
    horizontalOverflow: false,
    clipped: [],
    offenders: [],
    unreachable: [],
    overlaps: [],
    smallTargets: [],
    lowContrast: [],
    reachableControls: ['Russell', 'Work', 'Sign out'],
    deepestNesting: { depth: 4, where: 'div.rs-card' },
    counts: { interactive: 18, headings: 4, landmarks: 6, textNodes: 44 },
    outline: [
      { level: 1, text: 'Brain Russell' },
      { level: 3, text: 'Where things stand' },
    ],
    unreadable: [],
    partial: [],
    ...overrides,
  };
}

/**
 * What a worker submits, shaped exactly as `npm run design render` prints it.
 *
 * The numbers are a real run's: the widths russell/default declares, Chromium
 * 141's own version string, and the `p.rs-hero-needs.is-needed: 3.15:1` the live
 * render actually reported. A fixture whose shape drifted from the command's
 * output would be a test of a submission nothing produces.
 */
function submission(options: { widths?: number[]; lowContrast?: string[] } = {}): string {
  const widths = options.widths ?? [1180, 953, 390];
  return JSON.stringify({
    revision: 'a'.repeat(40),
    treeDirty: false,
    captures: widths.map((width, index) => ({
      surfaceKey: SURFACE,
      viewportName: width === 1180 ? 'desktop' : width === 953 ? 'intermediate' : 'phone',
      width,
      height: width === 390 ? 844 : 900,
      contentHash: `${index}`.repeat(64).slice(0, 64),
      byteSize: 100_000 + index,
      artifactRef: `russell-default-${width}w-p0.png`,
      engine: 'chromium',
      engineVersion: 'Chromium 141.0.7390.37',
      capturedAt: new Date().toISOString(),
      readings: readings({ lowContrast: options.lowContrast ?? [] }),
    })),
  });
}

/**
 * Brain fires the bin, a worker arrives, answers it and finishes it.
 *
 * The fire is here rather than skipped because **the session a judgement is
 * attributed to comes from Brain's own dispatch row**, never from anything the
 * worker says about itself — §24's rule, which `lineageFor` implements by
 * reading `bin_dispatch`. A test that assigned without dispatching would have a
 * reviewer with no resolvable lineage, and the independence check would refuse
 * it: which is exactly what happened when this helper did not fire, and is the
 * guard working rather than a problem with it.
 */
async function answerBin(input: {
  workerId: string;
  projectId: string;
  unitKey: string;
  value: string;
  expectKind: string;
  sessionRef: string;
}): Promise<string> {
  const ready = (await listBins({ limit: 50 })).find(
    (one) => one.kind === input.expectKind && one.state === 'READY',
  );
  expect(ready, `no ${input.expectKind} bin was ready to be fired`).toBeTruthy();
  await ensureDispatchIntent(ready!);
  const intent = await claimDispatchIntent();
  expect(intent, `no dispatch intent was claimable for ${input.expectKind}`).toBeTruthy();
  expect(intent!.binId).toBe(ready!.id);
  await markDispatchSent(intent!.id, {
    routineRef: 'trig_design_walk',
    sessionRef: input.sessionRef,
    projectId: input.projectId,
  });

  const assigned = await assignNextBin({
    workerId: input.workerId,
    projectIds: [input.projectId],
  });
  expect(assigned, `no bin was ready for ${input.expectKind}`).toBeTruthy();
  expect(assigned!.bin.kind).toBe(input.expectKind);

  await putBinUnitResult({
    binId: assigned!.bin.id,
    unitKey: input.unitKey,
    value: input.value,
    contentHash: 'h',
    // The authenticated principal, exactly as the MCP tool passes it: a review
    // whose worker is unknown establishes no independence and is refused.
    submittedBy: input.workerId,
    leaseId: assigned!.leaseId,
    leaseGeneration: assigned!.leaseGeneration,
  });
  expect(
    await finishBin(
      {
        binId: assigned!.bin.id,
        leaseId: assigned!.leaseId,
        leaseGeneration: assigned!.leaseGeneration,
        workerId: input.workerId,
      },
      { state: 'COMPLETE', reason: 'answered' },
    ),
  ).toBe('OK');
  return assigned!.bin.id;
}

describe('a design cycle reaches a worker and comes back', () => {
  let architectureId = '';
  let renderer = '';
  let reviewer = '';

  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
    architectureId = (
      await createProject({ name: 'Brain architecture', purpose: 'TECHNICAL' })
    ).id;
    renderer = (
      await createWorker({ name: 'design-renderer', createdByType: 'SYSTEM', createdById: 't' })
    ).id;
    reviewer = (
      await createWorker({ name: 'design-reviewer', createdByType: 'SYSTEM', createdById: 't' })
    ).id;
  });

  it('walks a landed change to a closed cycle, through two real bins', async () => {
    /*
     * 1. A change lands. This is `remoteLoop`'s own call, with a campaign's
     *    integrated paths — nothing about the cycle is arranged by hand.
     */
    /*
     * The session that wrote the change, as the factory records one. A design
     * review is held against these, and a cycle with none reports
     * `NOT_APPLICABLE` — truthfully, but it proves nothing about the guard, so
     * the walk gives it somebody to be independent *of*.
     */
    const authoring = await openSession({
      campaignId: 'cmp_walk',
      unitId: null,
      workerId: (
        await createWorker({ name: 'design-author', createdByType: 'SYSTEM', createdById: 't' })
      ).id,
      accountRef: 'primary',
      attempt: 0,
      role: 'IMPLEMENTER',
      model: 'claude',
    });
    await closeSession(authoring.id, {
      state: 'FINISHED',
      externalSessionId: 'cse_author_01',
    });

    const routed = await requestDesignCycle({
      triggerKind: 'UI_IMPACT',
      triggerRef: 'cmp_walk',
      changedPaths: ['client/src/russell/Home.tsx'],
      description: 'Rework how the conversation list is grouped',
      revision: 'a'.repeat(40),
    });
    expect(routed.cycle).toBeTruthy();
    const cycleId = routed.cycle!.id;

    // Nothing has looked at it yet, and the cycle says so by having no captures.
    expect(await listCaptures({ cycleId, limit: 10 })).toHaveLength(0);

    /*
     * 2. The tick asks for a render. This is the transition that did not exist:
     *    before it, a cycle opened by a change waited for a person to run a
     *    command against a database that does not hold it.
     */
    const asked = await runDesignKernel();
    const renderAsk = asked.asked.find((one) => one.cycleId === cycleId && one.kind === 'RENDER');
    expect(renderAsk, 'the tick did not ask anybody to render the cycle').toBeTruthy();

    const renderRequest = await binRequestFor({ cycleId, pass: 0, kind: 'RENDER' });
    expect(renderRequest?.binId).toBe(renderAsk!.binId);
    // A render has nothing to bind to yet, and the row says so rather than
    // carrying a digest of a set nobody has produced.
    expect(renderRequest?.captureDigest).toBeNull();

    /*
     * 3. A worker claims it off the real queue, renders, and submits.
     */
    const renderBin = await answerBin({
      workerId: renderer,
      projectId: architectureId,
      unitKey: RENDER_UNIT_KEY,
      value: submission({ lowContrast: ['p.rs-hero-needs.is-needed: 3.15:1 against 4.5:1 (15px)'] }),
      expectKind: 'DESIGN_RENDER',
      sessionRef: 'cse_render_01',
    });
    expect(renderBin).toBe(renderAsk!.binId);

    /*
     * 4. The tick reads it back, stores the captures, measures them, and asks
     *    for the judgement.
     */
    const ingested = await runDesignKernel();
    const rendered = ingested.rendered.find((one) => one.cycleId === cycleId);
    expect(rendered?.refused).toBeNull();
    expect(rendered?.captures).toBe(3);

    const captures = await listCaptures({ cycleId, pass: 0, limit: 10 });
    expect(captures).toHaveLength(3);
    // The engine and revision travelled with the picture, which is what makes a
    // measurement a fact about a tree rather than about a filename.
    expect(captures.every((one) => one.engine === 'chromium')).toBe(true);
    expect(captures.every((one) => one.revision === 'a'.repeat(40))).toBe(true);

    // The measured lane ran on exactly the same code a local render uses, so the
    // contrast reading became a finding without anybody judging anything.
    const measured = await listFindings({ cycleId, lane: 'MEASURED', limit: 50 });
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.some((one) => one.kind === 'CONTRAST_BELOW_FLOOR')).toBe(true);

    const reviewAsk = ingested.asked.find((one) => one.cycleId === cycleId && one.kind === 'REVIEW');
    expect(reviewAsk, 'the tick did not ask for the judgement').toBeTruthy();

    /*
     * 5. The review is bound to the capture set it was briefed on, and to the
     *    revision. This is what stops a judgement about one set settling another.
     */
    const reviewRequest = await binRequestFor({ cycleId, pass: 0, kind: 'REVIEW' });
    expect(reviewRequest?.binId).toBe(reviewAsk!.binId);
    expect(reviewRequest?.captureCount).toBe(3);
    expect(reviewRequest?.captureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewRequest?.revision).toBe('a'.repeat(40));

    /*
     * 6. A different session answers it.
     */
    await answerBin({
      workerId: reviewer,
      projectId: architectureId,
      unitKey: REVIEW_UNIT_KEY,
      value: JSON.stringify({
        verdict: 'CHANGES_REQUIRED',
        findings: [
          {
            surfaceKey: SURFACE,
            region: 'h3 "Where things stand"',
            kind: 'EMPHASIS_MISPLACED',
            statement:
              'The heading outline jumps from h1 straight to h3, so the section a person comes ' +
              'here to read is nested under nothing.',
            whyItMatters:
              'This screen exists to answer "what is happening", and the answer is filed a level ' +
              'below a heading that is not there.',
            severity: 'MINOR',
            proposedRepair: 'Promote "Where things stand" to h2, or add the h2 it belongs under.',
          },
        ],
      }),
      expectKind: 'DESIGN_REVIEW',
      sessionRef: 'cse_review_01',
    });

    /*
     * 7. The tick reads the judgement back and closes the cycle.
     */
    const closed = await runDesignKernel();
    expect(closed.ingested.some((one) => one.cycleId === cycleId)).toBe(true);

    const reviews = await listReviews(cycleId);
    const judged = reviews.find((one) => one.lane === 'JUDGED');
    expect(judged?.verdict).toBe('CHANGES_REQUIRED');
    expect(judged?.captureDigest).toBe(reviewRequest!.captureDigest);
    expect(judged?.workerId).toBe(reviewer);
    // Two distinct workers, so the tier reported is the one the fleet supplied
    // — never rounded up, and never rounded down either.
    expect(judged?.independenceTier).toBe('WORKER_SEPARATED');

    const judgedFindings = await listFindings({ cycleId, lane: 'JUDGED', limit: 50 });
    expect(judgedFindings).toHaveLength(1);
    expect(judgedFindings[0]?.kind).toBe('EMPHASIS_MISPLACED');

    const settled = closed.settled.find((one) => one.cycleId === cycleId);
    expect(settled?.stopReason).toBe('NEEDS_PERSON');

    const finished = await getCycle(cycleId);
    expect(finished?.state).toBe('CLOSED');
    expect(finished?.stopReason).toBe('NEEDS_PERSON');
    // Never emptied to look finished.
    expect(finished?.stopDetail).toMatch(/stay open/);

    /*
     * 8. And the loop is idempotent: a tick that runs again asks for nothing,
     *    reads nothing back twice, and does not reopen a closed cycle.
     */
    const again = await runDesignKernel();
    expect(again.asked.filter((one) => one.cycleId === cycleId)).toHaveLength(0);
    expect(again.ingested.filter((one) => one.cycleId === cycleId)).toHaveLength(0);
    expect(again.settled.filter((one) => one.cycleId === cycleId)).toHaveLength(0);
    expect(await listFindings({ cycleId, lane: 'JUDGED', limit: 50 })).toHaveLength(1);
  });

  it('asks one render for one pass however many ticks read it', async () => {
    const routed = await requestDesignCycle({
      triggerKind: 'UI_IMPACT',
      triggerRef: 'cmp_twice',
      changedPaths: ['client/src/russell/Home.tsx'],
      description: 'Group the conversation list differently',
      revision: null,
    });
    const cycleId = routed.cycle!.id;

    await runDesignKernel();
    await runDesignKernel();

    const bins = (await listBins({ limit: 50 })).filter((one) => one.kind === 'DESIGN_RENDER');
    const live = bins.filter((one) => one.state !== 'CANCELLED');
    expect(live).toHaveLength(1);
    expect(await binRequestFor({ cycleId, pass: 0, kind: 'RENDER' })).toBeTruthy();
  });

  it('refuses a judgement whose evidence has moved underneath it', async () => {
    const routed = await requestDesignCycle({
      triggerKind: 'UI_IMPACT',
      triggerRef: 'cmp_stale',
      changedPaths: ['client/src/russell/Home.tsx'],
      description: 'Regroup the conversation list',
      revision: null,
    });
    const cycleId = routed.cycle!.id;

    await runDesignKernel();
    await answerBin({
      workerId: renderer,
      projectId: architectureId,
      unitKey: RENDER_UNIT_KEY,
      value: submission({ widths: [1180] }),
      expectKind: 'DESIGN_RENDER',
      sessionRef: 'cse_render_01',
    });
    const ingested = await runDesignKernel();
    const reviewBinId = ingested.asked.find((one) => one.kind === 'REVIEW')!.binId;

    /*
     * A capture written after the review was briefed. In production this is a
     * second renderer, a resumed pass, or a re-render against a newer tree; here
     * it is one row, because the shape of the defect is what matters.
     */
    await recordCapture({
      cycleId,
      pass: 0,
      surfaceKey: SURFACE,
      screen: 'russell',
      stateKey: 'default',
      viewportName: 'phone',
      width: 390,
      height: 844,
      revision: 'b'.repeat(40),
      treeDirty: false,
      contentHash: 'f'.repeat(64),
      byteSize: 1,
      artifactRef: 'late.png',
      engine: 'chromium',
      engineVersion: 'Chromium 141',
      readings: readings(),
      capturedAt: new Date().toISOString(),
    });

    await answerBin({
      workerId: reviewer,
      projectId: architectureId,
      unitKey: REVIEW_UNIT_KEY,
      value: JSON.stringify({ verdict: 'CLEAN', findings: [] }),
      expectKind: 'DESIGN_REVIEW',
      sessionRef: 'cse_review_01',
    });

    await runDesignKernel();

    const judged = (await listReviews(cycleId)).find((one) => one.lane === 'JUDGED');
    expect(judged?.verdict).toBe('REFUSED');
    expect(judged?.detail).toMatch(/evidence moved/);
    expect(await getBin(reviewBinId)).toBeTruthy();

    /*
     * The cycle closes and says a refusal is what closed it. It may not read as
     * judged — nothing judged it — and it may not stay open either, because
     * nothing would ever ask again: `ingestFinishedReviews` skips a pass that
     * already carries a JUDGED row, so an open cycle here would be a park.
     */
    const finished = await getCycle(cycleId);
    expect(finished?.state).toBe('CLOSED');
    expect(finished?.stopReason).toBe('NEEDS_PERSON');
    expect(finished?.stopDetail).toMatch(/judgement was refused/);
    expect(finished?.stopDetail).not.toMatch(/and judged CLEAN/);
  });

  it('refuses a judgement nothing recorded a question for', async () => {
    const routed = await requestDesignCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      changedPaths: ['client/src/russell/Home.tsx'],
      description: 'Look at the conversation list',
      revision: null,
    });
    const cycle = (await getCycle(routed.cycle!.id))!;

    /*
     * A real bin with no request row against it — which is what an unbound
     * judgement looks like in production: a bin from before this binding
     * existed, or one whose question nothing recorded. The render bin is the
     * nearest real one to hand, and using an invented id instead would have been
     * testing the foreign key rather than the guard.
     */
    const asked = await runDesignKernel();
    const renderBinId = asked.asked.find((one) => one.kind === 'RENDER')!.binId;

    const outcome = await ingestDesignReview({
      binId: renderBinId,
      cycle,
      pass: 1,
      captures: [],
      surfaceKeys: [SURFACE],
      authors: [],
      reviewer: { sessionId: 's1', workerId: reviewer, accountId: null, routineId: null },
    });
    expect(outcome.refused).toMatch(/No record says what this review was asked about/);
  });
});

describe('a submitted render is validated before it is believed', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  it('refuses a width the surface does not declare', async () => {
    const { surfaces } = await resolveSurfaces([SURFACE]);
    const bad = JSON.parse(submission({ widths: [1180] })) as {
      captures: { width: number }[];
    };
    bad.captures[0]!.width = 1181;

    const verdict = validateRenderSubmission(JSON.stringify(bad), surfaces);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(' ')).toMatch(/does not declare/);
  });

  it('refuses a content hash that is not a sha-256', async () => {
    const { surfaces } = await resolveSurfaces([SURFACE]);
    const bad = JSON.parse(submission({ widths: [1180] })) as {
      captures: { contentHash: string }[];
    };
    bad.captures[0]!.contentHash = 'not-a-hash';

    const verdict = validateRenderSubmission(JSON.stringify(bad), surfaces);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(' ')).toMatch(/sha-256/);
  });

  it('refuses an empty render rather than reading it as a clean screen', async () => {
    const { surfaces } = await resolveSurfaces([SURFACE]);
    const verdict = validateRenderSubmission(
      JSON.stringify({ revision: null, treeDirty: true, captures: [] }),
      surfaces,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(' ')).toMatch(/blocker naming what stopped it/);
  });

  it('refuses two pictures of one surface at one width', async () => {
    const { surfaces } = await resolveSurfaces([SURFACE]);
    const bad = JSON.parse(submission({ widths: [1180, 953] })) as {
      captures: { width: number }[];
    };
    bad.captures[1]!.width = 1180;

    const verdict = validateRenderSubmission(JSON.stringify(bad), surfaces);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(' ')).toMatch(/second picture/);
  });

  it('accepts a real submission and keeps every reading it was given', async () => {
    const { surfaces } = await resolveSurfaces([SURFACE]);
    const verdict = validateRenderSubmission(
      submission({ lowContrast: ['p.rs-hero-needs.is-needed: 3.15:1 against 4.5:1 (15px)'] }),
      surfaces,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.captures).toHaveLength(3);
      expect(verdict.captures[0]?.readings.lowContrast).toHaveLength(1);
      expect(verdict.captures[0]?.engineVersion).toBe('Chromium 141.0.7390.37');
    }
  });
});
