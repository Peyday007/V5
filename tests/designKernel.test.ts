/**
 * The design kernel: what it may conclude, and what it must refuse to.
 *
 * ---------------------------------------------------------------------------
 * What this file is trying to catch
 * ---------------------------------------------------------------------------
 *
 * Almost every way a design system goes wrong is a way of **claiming more than
 * was established**, so nearly every assertion here is a refusal:
 *
 *   - a surface reported as clean when a reader could not run;
 *   - an owner's correction about one card applied to the product;
 *   - a judgement submitted under a measurement's name;
 *   - a capability marked LIVE because somebody wrote the module;
 *   - a cycle that closed its own findings to look finished;
 *   - an expansion promoted because the work it was routed to finished;
 *   - a design taxonomy that was declared rather than discovered.
 *
 * The acceptances are cheap to make pass and prove little. The refusals are the
 * contract, and three of them below were run against a deliberately weakened
 * guard first, to watch them fail — a regression test nobody has seen fail is a
 * claim rather than a reading.
 *
 * ---------------------------------------------------------------------------
 * Why there is no browser in here
 * ---------------------------------------------------------------------------
 *
 * The *rules* are pure functions over readings, so they are exercised against
 * readings. That is deliberate rather than a shortcut: a rule that can only be
 * run by a twenty-second render is a rule nobody runs, and `evaluate.ts` is
 * split the way it is precisely so the repair loop's own standard is testable
 * without Chromium. The real render is `npm run design cycle`, and what it
 * proved is written down in `docs/DESIGN-KERNEL.md`.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  DESIGN_PRIMITIVES,
  JUDGED_KINDS,
  MEASURED_KINDS,
  PRIMITIVE_OF_KIND,
  SCOPE_RANK,
  type CaptureReadings,
  type DesignFindingKind,
} from '../server/domain/design.ts';
import {
  declareCapability,
  getCapability,
  getCycle,
  listCaptures,
  listExpansions,
  listFindings,
  listPatterns,
  listSurfaces,
  moveCapabilityDimension,
  observeCapability,
  openCycle,
  recordCapture,
  recordCorrection,
  recordFinding,
  type RecordCaptureInput,
} from '../server/repos/design.ts';
import { seedDesignKernel } from '../server/services/design/kernel.ts';
import { seedDesignSurfaces, resolveSurfaces } from '../server/services/design/surfaces.ts';
import {
  evaluateCaptures,
  findingsFromReadings,
  responsiveRegressions,
  summarise,
} from '../server/services/design/evaluate.ts';
import { classifyUiImpact, conceptsNamed } from '../server/services/design/impact.ts';
import {
  decideReviewIndependence,
  validateJudgedSubmission,
} from '../server/services/design/judge.ts';
import {
  mayWiden,
  recordOwnerCorrection,
  suggestScope,
} from '../server/services/design/corrections.ts';
import {
  confidenceFor,
  patternFingerprint,
  proposePatternFromCorrection,
} from '../server/services/design/patterns.ts';
import { readAbility, refreshCapabilities } from '../server/services/design/capabilities.ts';
import { rankCapabilities, rankSurfaces } from '../server/services/design/priority.ts';
import { routeFor, shouldExpand } from '../server/services/design/expand.ts';
import { requestDesignCycle } from '../server/services/design/route.ts';
import { MAX_DESIGN_PASSES, runDesignCycle } from '../server/services/design/operate.ts';
import { probeRenderRuntime } from '../server/services/design/renderRuntime.ts';
import { createUser } from '../server/repos/identity.ts';

/** A complete, readable set of readings with nothing wrong in it. */
function cleanReadings(overrides: Partial<CaptureReadings> = {}): CaptureReadings {
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
    counts: { interactive: 12, headings: 3, landmarks: 2, textNodes: 20 },
    outline: [{ level: 1, text: 'Russell' }],
    unreadable: [],
    partial: [],
    ...overrides,
  };
}

async function capture(
  overrides: Partial<RecordCaptureInput> = {},
): Promise<Awaited<ReturnType<typeof recordCapture>>> {
  return recordCapture({
    cycleId: null,
    pass: 0,
    surfaceKey: 'russell/default',
    screen: 'russell',
    stateKey: 'default',
    viewportName: 'desktop',
    width: 1180,
    height: 900,
    revision: 'abc1234',
    treeDirty: false,
    contentHash: 'a'.repeat(64),
    byteSize: 1024,
    artifactRef: 'russell-default-1180w-p0.png',
    engine: 'chromium',
    engineVersion: 'Chromium 141',
    readings: cleanReadings(),
    capturedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe('the seed is a seed', () => {
  beforeEach(async () => {
    await freshProject();
  });

  /**
   * The rule the whole kernel rests on, asserted by reading the repository.
   *
   * `operatorConsoleRemoved` reads the source for the same reason: what must not
   * exist is not something a behavioural test can see. A taxonomy of UI patterns
   * would pass every behavioural test in this file while being the encyclopedia
   * the kernel exists not to be.
   */
  it('declares ten design concerns and no taxonomy of patterns beneath them', () => {
    expect(DESIGN_PRIMITIVES).toHaveLength(10);

    const source = readFileSync('server/domain/design.ts', 'utf8');
    // A branch is discovered and lives in a row. Nothing here may enumerate one.
    expect(source).not.toMatch(/const\s+DESIGN_BRANCHES/);
    expect(source).not.toMatch(/const\s+UI_PATTERNS/);

    // Every kind has exactly one home, so the self-model cannot count a
    // weakness twice or under-report two.
    for (const kind of [...MEASURED_KINDS, ...JUDGED_KINDS]) {
      expect(DESIGN_PRIMITIVES).toContain(PRIMITIVE_OF_KIND[kind as DesignFindingKind]);
    }
  });

  it('seeds surfaces, patterns and capabilities without writing a capability state', async () => {
    const seeded = await seedDesignKernel();
    expect(seeded.surfaces).toBeGreaterThan(0);
    expect(seeded.patterns).toBeGreaterThan(0);
    expect(seeded.capabilities).toBeGreaterThan(0);

    /*
     * The separation the whole registry rests on: declaring a capability says
     * what Brain is *about*, and only a reading may say it works. A seed that
     * could set a state would be a path by which "we wrote this down" becomes
     * "this works" — §37's most expensive available lie, because it stops the
     * work that exists to close the gap.
     */
    for (const key of ['RENDER_REAL_INTERFACE', 'MOBILE_INTERACTION']) {
      const capability = await getCapability(key);
      expect(capability?.abilityState).toBe('ABSENT');
      expect(capability?.evidenceState).toBe('UNTESTED');
    }

    // Seeding twice is the same seed, not a second copy of it.
    await seedDesignKernel();
    expect((await listSurfaces()).length).toBe(seeded.surfaces);
  });

  it('declares abilities it does not have, so the expansion loop can find them', async () => {
    await seedDesignKernel();
    const absent = (await Promise.all(
      ['MOBILE_INTERACTION', 'VISUAL_COMPOSITION_FROM_PIXELS', 'MOTION_AND_TRANSITION'].map((key) =>
        getCapability(key),
      ),
    )).filter((one) => one !== null);
    expect(absent).toHaveLength(3);
    for (const capability of absent) {
      expect(capability!.route).toBeNull();
      expect(capability!.limitations.join(' ')).toMatch(/Nothing implements this/);
    }
  });
});

describe('a surface registry that refuses to guess', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignSurfaces();
  });

  it('reports a surface it does not know rather than looking at fewer screens', async () => {
    const resolved = await resolveSurfaces(['russell/default', 'nowhere/at-all']);
    expect(resolved.surfaces.map((one) => one.surfaceKey)).toEqual(['russell/default']);
    expect(resolved.unknown).toEqual(['nowhere/at-all']);
  });

  it('puts a surface nobody has rendered first, because nothing is known about it', async () => {
    const ranked = await rankSurfaces(await listSurfaces());
    expect(ranked[0]?.inputs.neverCaptured).toBe(true);
    expect(ranked[0]?.because).toMatch(/never been rendered/);
  });
});

describe('measurement becomes findings, and an unread reading is never a clean one', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('turns each reading into a finding that names a region, a reason and a repair', () => {
    const findings = findingsFromReadings(
      cleanReadings({
        horizontalOverflow: true,
        offenders: ['div.rs-wide@0..1400 of 1180'],
        clipped: ['span.label inside div.rs-cell'],
        lowContrast: ['p.rs-hint: 3.90:1 against 4.5:1 (13px)'],
      }),
      { width: 390, surfaceKey: 'russell/default' },
    );

    // The four properties that make it a finding rather than a critique.
    for (const finding of findings) {
      expect(finding.region.length).toBeGreaterThan(0);
      expect(finding.whyItMatters.length).toBeGreaterThan(20);
      expect(finding.proposedRepair.length).toBeGreaterThan(20);
      expect(Object.keys(finding.evidence).length).toBeGreaterThan(0);
    }
    // Severity is an argument about the width, not a constant.
    expect(findings.find((one) => one.kind === 'HORIZONTAL_OVERFLOW')?.severity).toBe('BLOCKER');
    expect(
      findingsFromReadings(cleanReadings({ horizontalOverflow: true }), {
        width: 1180,
        surfaceKey: 'x',
      }).find((one) => one.kind === 'HORIZONTAL_OVERFLOW')?.severity,
    ).toBe('MAJOR');
  });

  /**
   * §9's rule at the design kernel: *a BLOCKED document is something the auditor
   * does not have*. A capture whose contrast reader threw has no contrast
   * findings, and calling that clean is the false confidence the engine exists
   * to prevent.
   */
  it('refuses to call a surface clean while a reader could not run', async () => {
    const readable = await capture();
    const broken = await capture({
      contentHash: 'b'.repeat(64),
      artifactRef: 'b.png',
      readings: cleanReadings({ unreadable: ['lowContrast: TypeError'] }),
    });

    const clean = summarise(await evaluateCaptures({ cycleId: null, pass: 0, captures: [readable] }));
    expect(clean.clean).toBe(true);

    const notClean = summarise(await evaluateCaptures({ cycleId: null, pass: 0, captures: [broken] }));
    expect(notClean.clean).toBe(false);
    expect(notClean.reason).toMatch(/could not be taken/);
  });

  /**
   * And the other half, which was a correction rather than a design: a reader
   * that ran and could not answer about *some* elements must not make a clean
   * page permanently unclean. Every real page has text over something, so the
   * first version made SETTLED unreachable — a bar with no way over it (§24).
   */
  it('reports a partial measurement without withholding a clean verdict', async () => {
    const partial = await capture({
      contentHash: 'c'.repeat(64),
      artifactRef: 'c.png',
      readings: cleanReadings({ partial: ['lowContrast: 3 element(s) had no opaque backdrop'] }),
    });
    const summary = summarise(await evaluateCaptures({ cycleId: null, pass: 0, captures: [partial] }));
    expect(summary.clean).toBe(true);
    expect(summary.reason).toMatch(/unknown rather than acceptable/);
  });

  it('writes one finding per capture, kind and region however often it is evaluated', async () => {
    const one = await capture({
      readings: cleanReadings({ horizontalOverflow: true }),
    });
    await evaluateCaptures({ cycleId: null, pass: 0, captures: [one] });
    await evaluateCaptures({ cycleId: null, pass: 0, captures: [one] });
    const findings = await listFindings({ limit: 100 });
    expect(findings.filter((f) => f.kind === 'HORIZONTAL_OVERFLOW')).toHaveLength(1);
  });

  /**
   * The defect §29 paid for: a stylesheet removed the element the phone menu
   * lived in, taking Sign out with it, while every React test passed.
   */
  it('finds a destination that exists at one width and not at another', async () => {
    const wide = await capture({
      readings: cleanReadings({ reachableControls: ['Russell', 'Work', 'Build', 'Sign out'] }),
    });
    const narrow = await capture({
      width: 390,
      viewportName: 'phone',
      contentHash: 'd'.repeat(64),
      artifactRef: 'd.png',
      readings: cleanReadings({ reachableControls: ['Russell', 'Work'] }),
    });
    const regressions = responsiveRegressions([wide, narrow]);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]?.captureId).toBe(narrow.id);
    expect(regressions[0]?.finding.severity).toBe('BLOCKER');
    expect(regressions[0]?.finding.statement).toMatch(/Build/);

    // And a width that lost nothing produces nothing, which is the half that
    // stops this crying wolf.
    expect(responsiveRegressions([wide, { ...narrow, readings: wide.readings }])).toHaveLength(0);
  });
});

describe('the judged lane never arrives as a measurement', () => {
  const surfaces = ['russell/default'];

  it('refuses a judgement submitted under a measured kind, by name', () => {
    const verdict = validateJudgedSubmission(
      JSON.stringify({
        verdict: 'CHANGES_REQUIRED',
        findings: [
          {
            surfaceKey: 'russell/default',
            region: 'div.rs-hero',
            kind: 'CONTRAST_BELOW_FLOOR',
            statement: 'The hero is hard to read.',
            whyItMatters: 'It is the first thing anybody sees.',
            severity: 'MAJOR',
            proposedRepair: 'Darken it.',
          },
        ],
      }),
      surfaces,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problems.join(' ')).toMatch(/measured kind/);
  });

  it('refuses a finding missing any of the sentences that make it one', () => {
    const verdict = validateJudgedSubmission(
      JSON.stringify({
        verdict: 'CHANGES_REQUIRED',
        findings: [
          {
            surfaceKey: 'russell/default',
            region: 'div.rs-hero',
            kind: 'HIERARCHY_UNCLEAR',
            statement: 'The hierarchy could be improved.',
            whyItMatters: '',
            severity: 'MAJOR',
            proposedRepair: '',
          },
        ],
      }),
      surfaces,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problems.join(' ')).toMatch(/whyItMatters/);
    expect(verdict.ok === false && verdict.problems.join(' ')).toMatch(/proposedRepair/);
  });

  it('refuses a verdict that disagrees with its own content, in both directions', () => {
    const cleanWithFindings = validateJudgedSubmission(
      JSON.stringify({
        verdict: 'CLEAN',
        findings: [
          {
            surfaceKey: 'russell/default',
            region: 'r',
            kind: 'DENSITY_WRONG',
            statement: 's',
            whyItMatters: 'w',
            severity: 'NIT',
            proposedRepair: 'p',
          },
        ],
      }),
      surfaces,
    );
    expect(cleanWithFindings.ok).toBe(false);

    const changesWithNone = validateJudgedSubmission(
      JSON.stringify({ verdict: 'CHANGES_REQUIRED', findings: [] }),
      surfaces,
    );
    expect(changesWithNone.ok).toBe(false);

    // CLEAN with nothing is a real and common answer, and must pass.
    const clean = validateJudgedSubmission(
      JSON.stringify({ verdict: 'CLEAN', findings: [] }),
      surfaces,
    );
    expect(clean.ok).toBe(true);
  });

  it('refuses a finding about a surface the review was not about', () => {
    const verdict = validateJudgedSubmission(
      JSON.stringify({
        verdict: 'CHANGES_REQUIRED',
        findings: [
          {
            surfaceKey: 'somewhere/else',
            region: 'r',
            kind: 'DENSITY_WRONG',
            statement: 's',
            whyItMatters: 'w',
            severity: 'NIT',
            proposedRepair: 'p',
          },
        ],
      }),
      surfaces,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problems.join(' ')).toMatch(/not one of the surfaces/);
  });

  /** §23's floor, at a third kind of work. Unknown lineage fails closed. */
  it('refuses a reviewer with no resolvable lineage, and one that wrote the change', () => {
    expect(
      decideReviewIndependence({ sessionId: null, workerId: 'w', accountId: null, routineId: null }, []),
    ).toMatchObject({ ok: false });

    expect(
      decideReviewIndependence(
        { sessionId: 'future:rt_1', workerId: 'w', accountId: 'a', routineId: 'rt_1' },
        [],
      ),
    ).toMatchObject({ ok: false });

    expect(
      decideReviewIndependence(
        { sessionId: 's1', workerId: 'w', accountId: 'a', routineId: 'r' },
        [{ sessionId: 's1', workerId: 'w', accountId: 'a', routineId: 'r' }],
      ),
    ).toMatchObject({ ok: false });
  });

  it('reports the tier it achieved and never rounds it up', () => {
    const sameAccount = decideReviewIndependence(
      { sessionId: 's2', workerId: 'w', accountId: 'a', routineId: 'r' },
      [{ sessionId: 's1', workerId: 'w', accountId: 'a', routineId: 'r' }],
    );
    expect(sameAccount).toMatchObject({ ok: true, tier: 'SESSION_SEPARATED' });

    const otherAccount = decideReviewIndependence(
      { sessionId: 's2', workerId: 'w2', accountId: 'b', routineId: 'r2' },
      [{ sessionId: 's1', workerId: 'w', accountId: 'a', routineId: 'r' }],
    );
    expect(otherAccount).toMatchObject({ ok: true, tier: 'ACCOUNT_SEPARATED' });

    /*
     * A cycle nobody authored has nobody to be independent of. Reported as
     * NOT_APPLICABLE rather than as separation it did not achieve — the same
     * refusal to round up, at the one case where rounding would be easy.
     */
    expect(
      decideReviewIndependence({ sessionId: 's', workerId: 'w', accountId: 'a', routineId: 'r' }, []),
    ).toMatchObject({ ok: true, tier: 'NOT_APPLICABLE' });
  });
});

describe('an owner correction keeps the scope it was given at', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  it('suggests the narrowest reading of what was pointed at, never the widest', () => {
    expect(
      suggestScope({ components: ['rs-collection-card'], surfaceKey: 'russell/default', faculty: 'RUSSELL' }),
    ).toMatchObject({ scope: 'COMPONENT', scopeRef: 'rs-collection-card' });

    expect(
      suggestScope({ components: [], surfaceKey: 'russell/default', faculty: 'RUSSELL' }),
    ).toMatchObject({ scope: 'SCREEN' });

    // Nothing to point at is a one-off, not a global rule.
    expect(suggestScope({ components: [], surfaceKey: null, faculty: null })).toMatchObject({
      scope: 'ONE_OFF',
    });
  });

  it('never widens a scope on its own', () => {
    expect(mayWiden('COMPONENT', 'GLOBAL').ok).toBe(false);
    expect(mayWiden('GLOBAL', 'COMPONENT').ok).toBe(true);
    expect(SCOPE_RANK.COMPONENT).toBeLessThan(SCOPE_RANK.GLOBAL);
  });

  it('refuses a correction filed against a screen that does not exist', async () => {
    const person = await createUser({ email: 'owner@example.invalid', displayName: 'Owner', password: 'owner-password-01' });
    const outcome = await recordOwnerCorrection({
      correction: 'Make this smaller.',
      surfaceKey: 'not/registered',
      beforeCaptureId: null,
      afterCaptureId: null,
      components: [],
      scope: 'ONE_OFF',
      scopeRef: null,
      confidence: 'LOW',
      lesson: null,
      recordedByUserId: person.id,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refusal).toMatch(/never be retrieved/);
  });

  it('refuses a comparison whose before or after does not resolve', async () => {
    const person = await createUser({ email: 'owner2@example.invalid', displayName: 'Owner', password: 'owner-password-01' });
    const outcome = await recordOwnerCorrection({
      correction: 'I preferred version 2.',
      surfaceKey: 'russell/default',
      beforeCaptureId: 'dcp_doesnotexist',
      afterCaptureId: null,
      components: [],
      scope: 'ONE_OFF',
      scopeRef: null,
      confidence: 'HIGH',
      lesson: null,
      recordedByUserId: person.id,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refusal).toMatch(/nothing to compare later/);
  });

  it('never promotes a one-off, and promotes everything else at its own scope', async () => {
    const person = await createUser({ email: 'owner3@example.invalid', displayName: 'Owner', password: 'owner-password-01' });

    const oneOff = await recordCorrection({
      surfaceKey: 'russell/default',
      beforeCaptureId: null,
      afterCaptureId: null,
      correction: 'Make this one smaller.',
      components: [],
      lesson: 'this card is too big',
      scope: 'ONE_OFF',
      scopeRef: null,
      confidence: 'HIGH',
      recordedByUserId: person.id,
    });
    const refused = await proposePatternFromCorrection({
      correction: oneOff,
      primitive: 'DENSITY',
      branch: null,
      statement: 'Cards are too big.',
      appliesWhen: 'always',
      exceptions: null,
    });
    expect(refused.pattern).toBeNull();
    expect(refused.refused).toMatch(/one-off/);

    const scoped = await recordCorrection({
      surfaceKey: 'russell/default',
      beforeCaptureId: null,
      afterCaptureId: null,
      correction: 'Do not nest cards like this.',
      components: ['rs-collection-card'],
      lesson: 'a card inside a card inside a card reads as one thing',
      scope: 'COMPONENT',
      scopeRef: 'rs-collection-card',
      confidence: 'HIGH',
      recordedByUserId: person.id,
    });
    const promoted = await proposePatternFromCorrection({
      correction: scoped,
      primitive: 'GROUPING',
      branch: 'nested containers',
      statement: 'A card inside a card inside a card reads as one thing rather than three.',
      appliesWhen: 'Any list of grouped items.',
      exceptions: null,
    });
    expect(promoted.pattern?.scope).toBe('COMPONENT');
    expect(promoted.pattern?.scopeRef).toBe('rs-collection-card');
    // PROPOSED, never ACTIVE: nothing canonical arrives without a decision.
    expect(promoted.pattern?.state).toBe('PROPOSED');
  });

  it('counts confidence from independent evidence rather than from repetition', () => {
    expect(confidenceFor({ ownerCorrections: 0, distinctCycles: 1, gatedClaims: 0 })).toBe('LOW');
    expect(confidenceFor({ ownerCorrections: 1, distinctCycles: 0, gatedClaims: 0 })).toBe('MEDIUM');
    expect(confidenceFor({ ownerCorrections: 2, distinctCycles: 0, gatedClaims: 0 })).toBe('HIGH');
    expect(confidenceFor({ ownerCorrections: 0, distinctCycles: 4, gatedClaims: 0 })).toBe('HIGH');
  });

  it('gives the same lesson written twice one row with the evidence accumulated', () => {
    const a = patternFingerprint({
      primitive: 'GROUPING',
      scope: 'GLOBAL',
      scopeRef: null,
      statement: 'Do not nest cards.',
    });
    const b = patternFingerprint({
      primitive: 'GROUPING',
      scope: 'GLOBAL',
      scopeRef: null,
      statement: '  do not   nest  cards!  ',
    });
    expect(a).toBe(b);
  });
});

describe('UI impact is classified from paths and concepts, not from filenames alone', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignSurfaces();
  });

  it('matches concepts on word boundaries against what surfaces declare', () => {
    expect(conceptsNamed('rAPId prototyping of an API', ['api'])).toEqual(['api']);
    expect(conceptsNamed('rAPId prototyping', ['api'])).toEqual([]);
    expect(conceptsNamed('two missions ran', ['mission'])).toEqual(['mission']);
  });

  it('calls a server change with a UI consequence INDIRECT rather than nothing', async () => {
    const impact = await classifyUiImpact({
      changedPaths: ['server/services/russell/projections.ts'],
      description: 'The briefing now says how many missions are waiting on a decision.',
    });
    expect(impact.verdict).toBe('INDIRECT');
    expect(impact.surfaces.length).toBeGreaterThan(0);
  });

  it('calls a change that cannot alter anything visible NONE, with a reason', async () => {
    const impact = await classifyUiImpact({
      changedPaths: ['tests/designKernel.test.ts', 'docs/DESIGN-KERNEL.md'],
      description: 'Added a test.',
    });
    expect(impact.verdict).toBe('NONE');
    expect(impact.because.length).toBeGreaterThan(20);
  });

  /**
   * §30's distinction at a classifier: *we could not tell* must never read the
   * same as *we checked*.
   */
  it('answers UNKNOWN when no paths were recorded, and says it is not no impact', async () => {
    const impact = await classifyUiImpact({ changedPaths: [], description: 'Something happened.' });
    expect(impact.verdict).toBe('UNKNOWN');
    expect(impact.because).toMatch(/not the same fact as it not reaching it/);
  });

  it('opens a cycle for an interface change and none for a change that reaches nothing', async () => {
    const opened = await requestDesignCycle({
      triggerKind: 'UI_IMPACT',
      triggerRef: 'cmp_1',
      changedPaths: ['client/src/russell/Home.tsx'],
      description: 'Show each conversation collection with its thread count.',
    });
    expect(opened.cycle).not.toBeNull();
    expect(opened.cycle?.state).toBe('OPEN');

    // Idempotent by the trigger: one campaign, one cycle.
    const again = await requestDesignCycle({
      triggerKind: 'UI_IMPACT',
      triggerRef: 'cmp_1',
      changedPaths: ['client/src/russell/Home.tsx'],
      description: 'Show each conversation collection with its thread count.',
    });
    expect(again.cycle?.id).toBe(opened.cycle?.id);

    const none = await requestDesignCycle({
      triggerKind: 'UI_IMPACT',
      triggerRef: 'cmp_2',
      changedPaths: ['server/db/migrations/099_x.sql'],
      description: 'Add a column.',
    });
    expect(none.cycle).toBeNull();
  });
});

describe('the repair loop stops, and says why', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  it('is bounded at three rounds', () => {
    expect(MAX_DESIGN_PASSES).toBe(3);
  });

  /**
   * The honest stop. A cycle that reached its ceiling keeps its findings rather
   * than closing them to read as finished, which is the silent success the whole
   * loop exists not to produce.
   */
  it('closes REPAIR_EXHAUSTED with the findings kept, never closed to look finished', async () => {
    let round = 0;
    const result = await runDesignCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: ['russell/default'],
      baseUrl: 'http://127.0.0.1:1',
      outputDir: '/tmp/design-test-unused',
      satisfied: ['SIGNED_IN'],
      maxPasses: 2,
      // A repair that always "changes" something, so the loop runs to its bound
      // rather than stopping at NEEDS_PERSON.
      repair: {
        name: 'TEST_ALWAYS_CHANGES',
        async attempt(finding) {
          return { findingId: finding.id, outcome: 'pretended', changed: true, routedTo: null };
        },
      },
      capture: async (request) => {
        const made = await recordCapture({
          cycleId: request.cycleId,
          pass: request.pass,
          surfaceKey: 'russell/default',
          screen: 'russell',
          stateKey: 'default',
          viewportName: 'desktop',
          width: 1180,
          height: 900,
          revision: 'abc1234',
          treeDirty: false,
          contentHash: String(round++).padStart(64, '0'),
          byteSize: 10,
          artifactRef: `p${request.pass}.png`,
          engine: 'test',
          engineVersion: null,
          // The same defect every round, so nothing can close it.
          readings: cleanReadings({ horizontalOverflow: true }),
          capturedAt: new Date().toISOString(),
        });
        return {
          captures: [made],
          skipped: [],
          runtime: probeRenderRuntime(),
        };
      },
    });

    // Only meaningful where a browser exists; elsewhere the honest stop is the
    // absent runtime, which the next test pins.
    if (result.stopReason === 'NO_RENDER_RUNTIME') return;

    expect(result.stopReason).toBe('REPAIR_EXHAUSTED');
    expect(result.unresolved.length).toBeGreaterThan(0);
    const settled = await listFindings({ cycleId: result.cycle.id, limit: 50 });
    // Kept as UNRESOLVED — a thing somebody has to answer — and never REPAIRED.
    expect(settled.some((one) => one.state === 'REPAIRED')).toBe(false);
    expect(settled.some((one) => one.state === 'UNRESOLVED')).toBe(true);
  });

  /**
   * A finding closes because a later capture no longer shows it, and the
   * resolution names that capture's hash. §27's standard: a worker's summary is
   * never evidence; the branch is. Here the branch is the picture.
   */
  it('closes a finding on the evidence of a later capture, naming it', async () => {
    let round = 0;
    const result = await runDesignCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: ['russell/default'],
      baseUrl: 'http://127.0.0.1:1',
      outputDir: '/tmp/design-test-unused',
      satisfied: ['SIGNED_IN'],
      maxPasses: 3,
      repair: {
        name: 'TEST_FIXES_IT',
        async attempt(finding) {
          return { findingId: finding.id, outcome: 'fixed', changed: true, routedTo: null };
        },
      },
      capture: async (request) => {
        const broken = round === 0;
        round += 1;
        const made = await recordCapture({
          cycleId: request.cycleId,
          pass: request.pass,
          surfaceKey: 'russell/default',
          screen: 'russell',
          stateKey: 'default',
          viewportName: 'desktop',
          width: 1180,
          height: 900,
          revision: 'abc1234',
          treeDirty: false,
          contentHash: String(round).padStart(64, '0'),
          byteSize: 10,
          artifactRef: `p${request.pass}.png`,
          engine: 'test',
          engineVersion: null,
          readings: cleanReadings({ horizontalOverflow: broken }),
          capturedAt: new Date().toISOString(),
        });
        return { captures: [made], skipped: [], runtime: probeRenderRuntime() };
      },
    });

    if (result.stopReason === 'NO_RENDER_RUNTIME') return;

    expect(result.stopReason).toBe('SETTLED');
    const findings = await listFindings({ cycleId: result.cycle.id, limit: 50 });
    const closed = findings.find((one) => one.kind === 'HORIZONTAL_OVERFLOW');
    expect(closed?.state).toBe('REPAIRED');
    expect(closed?.resolution).toMatch(/sha-256/);
    expect(closed?.resolvedBy).toBeTruthy();
    // And the thing it names is a capture that exists.
    const captures = await listCaptures({ cycleId: result.cycle.id, limit: 20 });
    expect(captures.map((one) => one.id)).toContain(closed?.resolvedBy);
  });

  it('stops at NEEDS_PERSON when every repair is somebody else s decision', async () => {
    const result = await runDesignCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: ['russell/default'],
      baseUrl: 'http://127.0.0.1:1',
      outputDir: '/tmp/design-test-unused',
      satisfied: ['SIGNED_IN'],
      maxPasses: 3,
      capture: async (request) => {
        const made = await recordCapture({
          cycleId: request.cycleId,
          pass: request.pass,
          surfaceKey: 'russell/default',
          screen: 'russell',
          stateKey: 'default',
          viewportName: 'desktop',
          width: 1180,
          height: 900,
          revision: null,
          treeDirty: true,
          contentHash: 'f'.repeat(64),
          byteSize: 10,
          artifactRef: 'p.png',
          engine: 'test',
          engineVersion: null,
          readings: cleanReadings({ lowContrast: ['p.x: 3.1:1 against 4.5:1 (13px)'] }),
          capturedAt: new Date().toISOString(),
        });
        return { captures: [made], skipped: [], runtime: probeRenderRuntime() };
      },
    });
    if (result.stopReason === 'NO_RENDER_RUNTIME') return;

    expect(result.stopReason).toBe('NEEDS_PERSON');
    expect(result.stopDetail).toMatch(/authorize on Build/);
    // One pass only: re-rendering an unchanged product learns nothing.
    expect(result.passes).toHaveLength(1);
  });
});

describe('the self-model is read, never declared', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  it('leaves a capability ABSENT while nothing has been done with it', async () => {
    const reading = await readAbility('RENDER_REAL_INTERFACE');
    expect(reading?.ability).not.toBe('LIVE');
    expect(reading?.because.join(' ')).toMatch(/nothing has been captured|no render runtime/i);
  });

  it('moves a dimension only from the state it was read at, and records why', async () => {
    const moved = await moveCapabilityDimension({
      capabilityKey: 'RENDER_REAL_INTERFACE',
      dimension: 'ABILITY',
      from: 'ABSENT',
      to: 'CONNECTED',
      reason: 'a browser was found',
      evidenceRef: null,
      actorType: 'TEST',
      actorId: null,
    });
    expect(moved).toBe(true);

    // The same move again finds a different state and does nothing, which is
    // what stops two ticks writing two events for one change.
    const again = await moveCapabilityDimension({
      capabilityKey: 'RENDER_REAL_INTERFACE',
      dimension: 'ABILITY',
      from: 'ABSENT',
      to: 'CONNECTED',
      reason: 'a browser was found',
      evidenceRef: null,
      actorType: 'TEST',
      actorId: null,
    });
    expect(again).toBe(false);
  });

  it('cannot leave UNTESTED without a stated way of checking', async () => {
    await declareCapability({
      capabilityKey: 'UNCHECKABLE',
      title: 'Something with no evaluation',
      primitive: 'DENSITY',
      route: 'somewhere.ts',
      evaluationMethod: null,
      limitations: [],
    });
    await refreshCapabilities('TEST');
    const capability = await getCapability('UNCHECKABLE');
    expect(capability?.evidenceState).toBe('UNTESTED');
  });

  it('becomes LIVE because work happened, not because a module exists', async () => {
    const before = await getCapability('RENDER_REAL_INTERFACE');
    expect(before?.abilityState).toBe('ABSENT');

    await capture();
    await refreshCapabilities('TEST');

    const after = await getCapability('RENDER_REAL_INTERFACE');
    expect(after?.abilityState).toBe('LIVE');
    expect(after?.evidenceState).toBe('PASSING');
  });
});

describe('the expansion loop originates work with nothing having failed', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  /**
   * The property that separates this loop from retry logic: a capability that
   * is weak, in demand, and has never thrown an error is still reached.
   */
  it('proposes work for a weak in-demand capability with no failure behind it', async () => {
    const one = await capture({
      readings: cleanReadings({ lowContrast: ['p.x: 3.1:1 against 4.5:1 (13px)'] }),
    });
    await evaluateCaptures({ cycleId: null, pass: 0, captures: [one] });

    await declareCapability({
      capabilityKey: 'DEEP_ACCESSIBILITY',
      title: 'Read focus order and label association',
      primitive: 'ACCESSIBILITY',
      route: null,
      evaluationMethod: null,
      limitations: ['Nothing implements this.'],
    });

    const ranked = await rankCapabilities([(await getCapability('DEEP_ACCESSIBILITY'))!]);
    const decision = shouldExpand(ranked[0]!);
    expect(decision.worth).toBe(true);
    // Nothing failed. The justification is demand and absence.
    expect(ranked[0]?.inputs.failures).toBe(0);
    expect(ranked[0]?.inputs.demand).toBeGreaterThan(0);
  });

  /**
   * And the correction that made that possible: zero demand is not the same
   * fact as no demand where nothing can look. §30's unknown, failing in the
   * direction that would quietly end self-expansion.
   */
  it('does not read an unmeasurable demand as no demand', async () => {
    const ranked = await rankCapabilities([(await getCapability('MOTION_AND_TRANSITION'))!]);
    expect(ranked[0]?.inputs.demand).toBe(0);
    expect(ranked[0]?.inputs.demandKnown).toBe(false);
    expect(shouldExpand(ranked[0]!).worth).toBe(true);

    // Whereas a capability something *can* look for, with no findings, is not a gap.
    await declareCapability({
      capabilityKey: 'IMPLEMENTED_AND_QUIET',
      title: 'Something nothing has needed',
      primitive: 'TYPOGRAPHY',
      route: 'somewhere.ts',
      evaluationMethod: 'a reading',
      limitations: [],
    });
    const quiet = await rankCapabilities([(await getCapability('IMPLEMENTED_AND_QUIET'))!]);
    expect(quiet[0]?.inputs.demandKnown).toBe(true);
    expect(shouldExpand(quiet[0]!).worth).toBe(false);
  });

  it('refuses to call something a gap when it already works', async () => {
    await capture();
    await refreshCapabilities('TEST');
    const ranked = await rankCapabilities([(await getCapability('RENDER_REAL_INTERFACE'))!]);
    const decision = shouldExpand(ranked[0]!);
    expect(decision.worth).toBe(false);
    expect(decision.why).toMatch(/polish rather than capability/);
  });

  it('prefers the cheapest route that could close the gap', async () => {
    // Nothing implements it and nothing says what implementing it would mean:
    // the first bounded question is what the approaches are.
    expect(routeFor((await getCapability('MOBILE_INTERACTION'))!).route).toBe('RESEARCH');

    // It exists and nothing has checked it: a reading, which costs nothing.
    await declareCapability({
      capabilityKey: 'EXISTS_UNCHECKED',
      title: 'Something wired and unproved',
      primitive: 'DENSITY',
      route: 'somewhere.ts',
      evaluationMethod: 'run it once',
      limitations: [],
    });
    await moveCapabilityDimension({
      capabilityKey: 'EXISTS_UNCHECKED',
      dimension: 'ABILITY',
      from: 'ABSENT',
      to: 'CONNECTED',
      reason: 'wired',
      evidenceRef: null,
      actorType: 'TEST',
      actorId: null,
    });
    expect(routeFor((await getCapability('EXISTS_UNCHECKED'))!).route).toBe('READING');
  });

  /**
   * A gap is offered once, and a gap that parked is not offered again until the
   * cool-off has passed.
   *
   * Both halves were needed and the second was a real defect the test found: an
   * expansion parked for want of somewhere to file it is no longer *live*, so
   * the partial unique index allowed another, and every tick opened two more
   * rows about the same three gaps for ever. §38's cool-off on a settled round,
   * at a second kernel.
   */
  it('opens one expansion per capability, and does not re-open a parked gap on the next pass', async () => {
    const { runExpansionPass } = await import('../server/services/design/expand.ts');
    await runExpansionPass('PROACTIVE');
    const first = (await listExpansions({ limit: 50 })).length;
    expect(first).toBeGreaterThan(0);

    const second = await runExpansionPass('PROACTIVE');
    expect(second.declined.some((one) => /looked at/.test(one.why))).toBe(true);

    /*
     * One row per capability is the property, not a fixed total. The second pass
     * is *allowed* to open a gap the first declined for the concurrency ceiling
     * — a ceiling is not a quota — and that is what it did here. What it may
     * never do is write a second row about a gap it has already looked at.
     */
    const all = await listExpansions({ limit: 50 });
    const byCapability = new Map<string, number>();
    for (const one of all) {
      byCapability.set(one.capabilityKey, (byCapability.get(one.capabilityKey) ?? 0) + 1);
    }
    expect([...byCapability.values()].every((count) => count === 1)).toBe(true);

    // And a third pass adds nothing, because every gap has now been looked at.
    await runExpansionPass('PROACTIVE');
    expect((await listExpansions({ limit: 50 })).length).toBe(all.length);
  });

  /**
   * No promotion without a reading. §37's rule: a merged pull request moves no
   * dimension in the registry, because a campaign routinely succeeds at
   * something narrower than the packet asked for.
   */
  it('never promotes an expansion because the work it was routed to finished', async () => {
    const { runExpansionPass, settleLiveExpansions } = await import(
      '../server/services/design/expand.ts'
    );
    await runExpansionPass('PROACTIVE');
    const live = (await listExpansions({ limit: 50 })).filter(
      (one) => one.state === 'IDENTIFIED' || one.state === 'ROUTED',
    );
    if (live.length === 0) return;

    // Nothing about the capability has changed, so nothing is promoted.
    const settled = await settleLiveExpansions();
    expect(settled.filter((one) => one.state === 'PROMOTED')).toHaveLength(0);
  });
});

describe('the record survives the run', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  it('binds a capture to its bytes, its engine and its revision', async () => {
    const made = await capture();
    expect(made.contentHash).toHaveLength(64);
    expect(made.engine).toBe('chromium');
    expect(made.revision).toBe('abc1234');
    expect(made.readings.counts.interactive).toBe(12);
  });

  it('keeps the measurement on a finding rather than a summary of it', async () => {
    const made = await capture({ readings: cleanReadings({ horizontalOverflow: true }) });
    const { findings } = await evaluateCaptures({ cycleId: null, pass: 0, captures: [made] });
    expect(findings[0]?.evidence).toMatchObject({ width: 1180 });
  });

  it('counts an observation without turning two numbers into a rate', async () => {
    await observeCapability({ capabilityKey: 'RENDER_REAL_INTERFACE', failed: false, evidenceRef: 'x' });
    await observeCapability({ capabilityKey: 'RENDER_REAL_INTERFACE', failed: true, evidenceRef: 'y' });
    const capability = await getCapability('RENDER_REAL_INTERFACE');
    expect(capability?.observations).toBe(2);
    expect(capability?.failures).toBe(1);
    expect(capability?.evidence).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('records a finding against a cycle that can be read back whole', async () => {
    const cycle = await openCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: ['russell/default'],
      revision: 'abc1234',
    });
    const made = await capture({ cycleId: cycle.id });
    await recordFinding({
      cycleId: cycle.id,
      reviewId: null,
      captureId: made.id,
      pass: 0,
      surfaceKey: 'russell/default',
      region: 'div.rs-hero',
      lane: 'MEASURED',
      kind: 'HORIZONTAL_OVERFLOW',
      primitive: 'RESPONSIVENESS',
      statement: 's',
      whyItMatters: 'w',
      severity: 'MAJOR',
      evidence: { width: 1180 },
      proposedRepair: 'p',
    });
    expect((await getCycle(cycle.id))?.surfaceKeys).toEqual(['russell/default']);
    expect(await listFindings({ cycleId: cycle.id, limit: 10 })).toHaveLength(1);
    expect((await listPatterns({ state: 'ACTIVE' })).length).toBeGreaterThan(0);
  });
});

describe('the judged lane goes through a bin, and its plumbing is real', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  /**
   * The bin is the entrance, so its contract and its routing class have to be
   * the ones the existing machinery already understands. A bin declaring a class
   * `classesForFamilies` does not cover matches nothing and the assigner answers
   * NO_READY_BINS with every other row correct — §37 records the capability
   * kernel finding exactly that, on `GENERAL_`.
   */
  it('opens a review bin the existing fleet can route and evaluate', async () => {
    const { openDesignReview, DESIGN_REVIEW_CONTRACT, DESIGN_WORKLOAD_CLASS } = await import(
      '../server/services/design/judge.ts'
    );
    const { familyOf, classesForFamilies } = await import('../server/services/bins/routing.ts');
    const { hasEvaluator } = await import('../server/services/bins/contracts.ts');
    const { getBin } = await import('../server/repos/bins.ts');
    const { listProjects } = await import('../server/repos/projects.ts');

    const project = (await listProjects())[0]!;
    const surface = (await listSurfaces()).find((one) => one.surfaceKey === 'russell/default')!;
    const cycle = await openCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: ['russell/default'],
      revision: null,
    });
    const made = await capture({ cycleId: cycle.id });

    const binId = await openDesignReview({
      cycle,
      pass: 0,
      projectId: project.id,
      surfaces: [surface],
      captures: [made],
    });
    const bin = await getBin(binId);
    expect(bin?.completionContract).toBe(DESIGN_REVIEW_CONTRACT);
    expect(bin?.workloadClass).toBe(DESIGN_WORKLOAD_CLASS);

    // The contract has an evaluator, so the bin can actually be judged. A
    // declared contract with none refuses every bin under it, silently.
    expect(hasEvaluator(DESIGN_REVIEW_CONTRACT)).toBe(true);

    // And the router puts it in a family whose class prefixes cover it.
    const family = familyOf(bin!);
    expect(family).toBe('GENERAL');
    const { prefixes } = classesForFamilies([family]);
    expect(prefixes.some((prefix) => DESIGN_WORKLOAD_CLASS.startsWith(prefix))).toBe(true);

    // The brief carries what the reviewer is meant to reason from, and says
    // plainly which questions it may not answer.
    const brief = bin!.manifest.units[0]!.input;
    expect(brief).toMatch(/WHAT THIS SCREEN REPRESENTS/);
    expect(brief).toMatch(/WHAT A PERSON CAN DO HERE/);
    expect(bin!.manifest.excludedSources.join(' ')).toMatch(/You have not been shown one/);
  });

  it('stores a validated judgement with its lineage, and refuses one that is not', async () => {
    const { openDesignReview, ingestDesignReview, REVIEW_UNIT_KEY } = await import(
      '../server/services/design/judge.ts'
    );
    const { putBinUnitResult } = await import('../server/repos/bins.ts');
    const { listProjects } = await import('../server/repos/projects.ts');
    const { listReviews } = await import('../server/repos/design.ts');

    const project = (await listProjects())[0]!;
    const surface = (await listSurfaces()).find((one) => one.surfaceKey === 'russell/default')!;
    const cycle = await openCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: ['russell/default'],
      revision: null,
    });
    const made = await capture({ cycleId: cycle.id });
    const binId = await openDesignReview({
      cycle,
      pass: 0,
      projectId: project.id,
      surfaces: [surface],
      captures: [made],
    });

    const submission = JSON.stringify({
      verdict: 'CHANGES_REQUIRED',
      findings: [
        {
          surfaceKey: 'russell/default',
          region: 'section.rs-hero',
          kind: 'EMPHASIS_MISPLACED',
          statement: 'The loudest thing on the page is the thread list, not the decision.',
          whyItMatters:
            'A person opens this to find out whether anything needs them, and the one line that ' +
            'answers that is quieter than a list they browse.',
          severity: 'MAJOR',
          proposedRepair: 'Give the needs line the hero weight and let the list settle below it.',
        },
      ],
    });
    await putBinUnitResult({
      binId,
      unitKey: REVIEW_UNIT_KEY,
      value: submission,
      contentHash: 'h'.repeat(64),
      leaseId: null,
      leaseGeneration: null,
      submittedBy: 'wkr_reviewer',
    });

    const outcome = await ingestDesignReview({
      binId,
      cycle,
      pass: 0,
      captures: [made],
      surfaceKeys: ['russell/default'],
      authors: [{ sessionId: 's_author', workerId: 'wkr_author', accountId: 'a', routineId: 'r' }],
      reviewer: { sessionId: 's_reviewer', workerId: 'wkr_reviewer', accountId: 'a', routineId: 'r' },
    });

    expect(outcome.refused).toBeNull();
    expect(outcome.review?.verdict).toBe('CHANGES_REQUIRED');
    /*
     * WORKER_SEPARATED, because that is what the fleet actually supplied here:
     * a different worker on the same account. Reported at the tier it earned
     * and neither rounded up to ACCOUNT_SEPARATED nor down to the floor.
     */
    expect(outcome.review?.independenceTier).toBe('WORKER_SEPARATED');
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.lane).toBe('JUDGED');
    expect(outcome.findings[0]?.primitive).toBe('EMPHASIS');

    /*
     * And the same bin read by the session that made the change is refused, with
     * the refusal recorded rather than silent: a review nobody can see is one
     * that looks as though it never happened (§8).
     */
    const second = await openDesignReview({
      cycle,
      pass: 1,
      projectId: project.id,
      surfaces: [surface],
      captures: [made],
    });
    await putBinUnitResult({
      binId: second,
      unitKey: REVIEW_UNIT_KEY,
      value: submission,
      contentHash: 'i'.repeat(64),
      leaseId: null,
      leaseGeneration: null,
      submittedBy: 'wkr_author',
    });
    const refused = await ingestDesignReview({
      binId: second,
      cycle,
      pass: 1,
      captures: [made],
      surfaceKeys: ['russell/default'],
      authors: [{ sessionId: 's_author', workerId: 'wkr_author', accountId: 'a', routineId: 'r' }],
      reviewer: { sessionId: 's_author', workerId: 'wkr_author', accountId: 'a', routineId: 'r' },
    });
    expect(refused.refused).toMatch(/reviewing its own work/);
    expect(refused.findings).toHaveLength(0);
    const rows = await listReviews(cycle.id);
    expect(rows.some((one) => one.verdict === 'REFUSED')).toBe(true);
  });
});

describe('a research gap goes down the path that already exists', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  /**
   * The claim this pins is that the RESEARCH route is not a second research
   * engine: it creates a Russell candidate, which is the entrance the archive
   * check, the compiler, the approval envelope, the evidence gate and the three
   * audit roles all sit behind. Nothing here bypasses any of them.
   */
  it('creates a Russell candidate on the architecture project', async () => {
    const { createProject } = await import('../server/repos/projects.ts');
    const { listCandidates } = await import('../server/repos/russellCandidates.ts');
    const { runExpansionPass } = await import('../server/services/design/expand.ts');

    const architecture = await createProject({
      name: 'Brain architecture',
      purpose: 'TECHNICAL',
    });

    const pass = await runExpansionPass('PROACTIVE');
    const research = pass.opened.filter((one) => one.route === 'RESEARCH');
    expect(research.length).toBeGreaterThan(0);

    for (const expansion of research) {
      expect(expansion.state).toBe('ROUTED');
      expect(expansion.routeRef).toBeTruthy();
    }

    const candidates = await listCandidates({ projectId: architecture.id });
    expect(candidates.length).toBe(research.length);
    expect(candidates[0]?.title).toMatch(/Design capability:/);
    // The question is bounded and says why it is worth asking.
    expect(candidates[0]?.statement).toMatch(/Why this is worth asking:/);
  });

  /**
   * And with no such project it parks naming the remedy, rather than filing
   * architecture research into somebody's research project — §31's boundary, and
   * §24's rule that a park has to name what would unpark it.
   */
  it('parks with the remedy when there is nowhere to file it', async () => {
    const { runExpansionPass } = await import('../server/services/design/expand.ts');
    const pass = await runExpansionPass('PROACTIVE');
    const parked = pass.opened.filter((one) => one.state === 'PARKED');
    expect(parked.length).toBeGreaterThan(0);
    expect(parked[0]?.outcome).toMatch(/npm run admin/);
  });
});

describe('learning compiles a rule from what kept happening', () => {
  beforeEach(async () => {
    await freshProject();
    await seedDesignKernel();
  });

  /** One cycle with the same defect is one observation, whatever it wrote. */
  async function cycleWithOverflow(surfaceKey: string, hash: string): Promise<string> {
    const cycle = await openCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: [surfaceKey],
      revision: null,
    });
    const made = await capture({
      cycleId: cycle.id,
      surfaceKey,
      contentHash: hash.repeat(64).slice(0, 64),
      artifactRef: `${hash}.png`,
      readings: cleanReadings({ horizontalOverflow: true }),
    });
    await evaluateCaptures({ cycleId: cycle.id, pass: 0, captures: [made] });
    return cycle.id;
  }

  it('needs three distinct cycles, not three findings in one', async () => {
    const { learnFleetWide, RECURRENCE_THRESHOLD } = await import(
      '../server/services/design/learn.ts'
    );
    expect(RECURRENCE_THRESHOLD).toBe(3);

    await cycleWithOverflow('russell/default', 'a');
    await cycleWithOverflow('russell/default', 'b');
    expect((await learnFleetWide()).compiled).toHaveLength(0);

    await cycleWithOverflow('build/default', 'c');
    const compiled = (await learnFleetWide()).compiled;
    expect(compiled).toHaveLength(1);

    const pattern = compiled[0]!;
    // PROPOSED: a kernel that activated its own rules would be generalising
    // from its own output.
    expect(pattern.state).toBe('PROPOSED');
    expect(pattern.origin).toBe('OPERATION');
    // Across surfaces, so the lesson is about the product rather than a screen.
    expect(pattern.scope).toBe('GLOBAL');
    // The statement is composed from the *kind*, so it carries no one screen's
    // specifics — and it says what to do, not that something keeps happening.
    expect(pattern.statement).toMatch(/Constrain against the container/);
    // The evidence names the cycles it rests on.
    expect(pattern.evidence.filter((one) => one.startsWith('design_cycle:')).length).toBe(3);
    // And the branch it created is real rather than invented.
    expect(pattern.branch).toBe('horizontal overflow');
  });

  it('files a recurrence on one screen as a fact about that screen', async () => {
    const { learnFleetWide } = await import('../server/services/design/learn.ts');
    await cycleWithOverflow('russell/default', 'a');
    await cycleWithOverflow('russell/default', 'b');
    await cycleWithOverflow('russell/default', 'c');

    const pattern = (await learnFleetWide()).compiled[0]!;
    expect(pattern.scope).toBe('SCREEN');
    expect(pattern.scopeRef).toBe('russell/default');
  });

  it('compiles the same recurrence once however often the pass runs', async () => {
    const { learnFleetWide } = await import('../server/services/design/learn.ts');
    await cycleWithOverflow('russell/default', 'a');
    await cycleWithOverflow('build/default', 'b');
    await cycleWithOverflow('fleet/default', 'c');

    await learnFleetWide();
    const first = (await listPatterns({ state: 'PROPOSED' })).length;
    await learnFleetWide();
    expect((await listPatterns({ state: 'PROPOSED' })).length).toBe(first);
  });
});
