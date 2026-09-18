/**
 * What Brain should research about its own capability, and when to stop.
 *
 * ---------------------------------------------------------------------------
 * Two properties, and both are refusals
 * ---------------------------------------------------------------------------
 *
 * **Most gaps are not research.** `MUST_BE_BUILT` is implementation,
 * `REQUIRES_PERSON_AUTHORITY` is a decision, `EXISTS_BUT_DISCONNECTED` is
 * wiring. Turning any of those into a research mission spends the fleet on a
 * question whose answer is already known.
 *
 * **The archive comes first.** §13's default is *not* to research, and the
 * check that decides it is `coverBeforeWork` reused whole — not a second copy,
 * because the copy is always the one that goes stale.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { scanSystem } from '../server/services/selfmodel/scan.ts';
import {
  classifyOutcome,
  decisionReadiness,
  directorPass,
  questionFor,
  REMEDY,
  RESEARCHABLE,
} from '../server/services/realize/director.ts';
import {
  derivePacket,
  judgeGap,
  listGaps,
  openPacket,
  setGapState,
} from '../server/services/realize/packet.ts';
import { GAP_KINDS } from '../server/services/realize/gaps.ts';
import { promoteCandidate, putCandidate } from '../server/repos/faculties.ts';
import { validateFacultyDefinition } from '../server/domain/faculties.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';

let fixture: TestProject;

function definition(overrides: Record<string, unknown> = {}): ReturnType<typeof validateFacultyDefinition> {
  return validateFacultyDefinition({
    canonicalName: 'Research Intelligence',
    ordinal: 1,
    purpose: 'Determines what Brain needs to learn to support a decision.',
    centralQuestion: 'What must we learn, and when do we know enough?',
    promisedPower: 'Brain can say what it does not know that would change what it does.',
    responsibilities: ['Identify decision-relevant uncertainties.'],
    boundaries: ['Grants no authority.'],
    inputs: ['An interpreted objective.'],
    outputs: ['Validated or rejected claims.'],
    activationConditions: ['A decision depends on something unestablished.'],
    reentryConditions: ['New evidence changes what is worth asking.'],
    dependencies: ['A calibrated confidence model for partial evidence.'],
    infrastructure: ['A budget the operator approved for external retrieval.'],
    allowedProposals: ['Belief updates.'],
    invariants: ['Uncertainty must survive the pipeline.'],
    evaluationRequirements: ['A decision reached that could not be reached before.'],
    failureModes: ['Missing the decisive question.'],
    connections: [],
    ...overrides,
  } as unknown);
}

async function packetWithGaps(): Promise<string> {
  const registered = await registerBlueprint({
    filename: 'map.md',
    contents: Buffer.from(
      '# Map\n\n## 5.1 Research Intelligence\n\nA section long enough to quote from here.\n',
      'utf8',
    ),
    title: 'Map',
    kind: 'BLUEPRINT',
    origin: 'test',
    registeredBy: 'test',
  });
  const candidate = await putCandidate({
    sourceId: registered.source.id,
    binId: null,
    definition: definition(),
    evidenceQuote: 'A section long enough to quote from here.',
    evidenceBlockId: null,
    evidencePage: 1,
    state: 'VALIDATED',
  });
  const faculty = await promoteCandidate({
    candidateId: candidate.id,
    auditId: 'bin_audit',
    actorType: 'SYSTEM',
    actorId: 'test',
  });
  await scanSystem('BOOT');
  const { packet } = await openPacket({ facultyId: faculty.id, createdByType: 'SYSTEM' });
  await derivePacket(packet.id);
  return packet.id;
}

describe('the capability research director', () => {
  beforeEach(async () => {
    fixture = await freshProject();
  });

  describe('what becomes a question', () => {
    it('researches exactly one gap kind and names a remedy for every other', () => {
      expect(RESEARCHABLE).toEqual(['MUST_BE_RESEARCHED']);
      // Every kind has a remedy, so a gap can never be reported as real with
      // nothing to do about it — §24's escalation with no answering transition.
      for (const kind of GAP_KINDS) {
        expect(REMEDY[kind]).toBeTruthy();
        expect(REMEDY[kind].length).toBeGreaterThan(10);
      }
    });

    it('turns no derived gap into research, because none of them is a question', async () => {
      const packetId = await packetWithGaps();
      const pass = await directorPass({
        packetId,
        projectId: fixture.project.id,
        layerId: (await fixture.layerByName('World Model')).id,
      });

      // Everything the calculus derives is a reading, a wiring job, a build or
      // a person's decision. None of those is answered by research.
      expect(pass.researchable).toBe(0);
      expect(pass.questions).toEqual([]);
      expect(pass.notResearch.length).toBeGreaterThan(0);
      expect(pass.explanation).toMatch(/Nothing here is a question about the world/);
      // And the one naming a budget went to a person rather than to the fleet.
      expect(pass.notResearch.some((entry) => entry.kind === 'REQUIRES_PERSON_AUTHORITY')).toBe(true);
    });

    it('asks the archive before it spends anything, and closes what is answered', async () => {
      const packetId = await packetWithGaps();
      const [gap] = await listGaps(packetId, { kinds: ['NEEDS_A_READING'] });
      await judgeGap({
        gapId: gap?.id as string,
        kind: 'MUST_BE_RESEARCHED',
        derivedBy: 'WORKER',
        evidence: 'A reader found nothing in the codebase that speaks to this.',
      });

      const pass = await directorPass({
        packetId,
        projectId: fixture.project.id,
        layerId: (await fixture.layerByName('World Model')).id,
      });

      expect(pass.researchable).toBe(1);
      // The archive was consulted — `coverage` is non-null — before anything
      // became a mission.
      expect(pass.coverage).not.toBeNull();
      expect(pass.coverage?.claimsConsidered).toBeGreaterThanOrEqual(0);
      // A fresh Brain answers nothing, so the question survives.
      expect(pass.questions).toHaveLength(1);
      expect(pass.questions[0]?.gapId).toBe(gap?.id);
    });

    it('composes a question from the gap rather than from a template', async () => {
      const question = questionFor(
        {
          id: 'rlg_abcdef12345678',
          requirement: 'A calibrated confidence model for partial evidence.',
          aspect: 'dependencies',
          kind: 'MUST_BE_RESEARCHED',
          componentKey: null,
          evidence: 'No component in the self-model has a name containing a distinctive word.',
          derivedBy: 'WORKER',
          state: 'OPEN',
          stateReason: null,
          carriedBy: null,
        },
        { slug: 'RESEARCH_INTELLIGENCE', canonicalName: 'Research Intelligence' },
      );

      // The requirement's own words, quoted rather than paraphrased.
      expect(question.statement).toContain('A calibrated confidence model for partial evidence.');
      // And Brain's own reading, so the worker knows what has already been ruled out.
      expect(question.statement).toContain('No component in the self-model');
      // A question whose answer changes nothing is not worth asking, so what it
      // decides is part of it.
      expect(question.decides).toMatch(/decides whether a change request is made/);
      expect(question.completionCriteria.length).toBeGreaterThan(1);
      // Short: never one giant prompt pasted into every Routine.
      expect(question.statement.length).toBeLessThan(1000);
    });
  });

  describe('telling a failed search from a refused claim', () => {
    it('keeps retrieval failure and evidence rejection apart', () => {
      const unreachable = classifyOutcome({
        claimsSubmitted: 0,
        claimsAccepted: 0,
        unreachableSources: 3,
      });
      expect(unreachable.outcome).toBe('UNREACHABLE');
      expect(unreachable.detail).toMatch(/reason to look somewhere else/);

      const insufficient = classifyOutcome({
        claimsSubmitted: 5,
        claimsAccepted: 0,
        unreachableSources: 0,
      });
      expect(insufficient.outcome).toBe('INSUFFICIENT');
      // Different remedy, said in the detail rather than left to be inferred.
      expect(insufficient.detail).toMatch(/ask differently rather than to search again/);

      expect(
        classifyOutcome({ claimsSubmitted: 4, claimsAccepted: 2, unreachableSources: 1 }).outcome,
      ).toBe('ANSWERED');
      expect(
        classifyOutcome({ claimsSubmitted: 0, claimsAccepted: 0, unreachableSources: 0 }).outcome,
      ).toBe('NOTHING_SUBMITTED');
    });

    it('keeps accepted claims from an otherwise incomplete attempt', () => {
      // Two of six accepted is an answer, not a failure. Discarding the two
      // because four did not land is what §12 forbids.
      const outcome = classifyOutcome({
        claimsSubmitted: 6,
        claimsAccepted: 2,
        unreachableSources: 2,
      });
      expect(outcome.outcome).toBe('ANSWERED');
      expect(outcome.detail).toMatch(/2 claim\(s\) cleared the gate/);
    });
  });

  describe('stopping', () => {
    it('reports every clause and why, rather than a verdict', async () => {
      const packetId = await packetWithGaps();
      const verdict = await decisionReadiness(packetId);

      expect(verdict.decisionReady).toBe(false);
      expect(verdict.conditions).toHaveLength(5);
      expect(verdict.conditions.every((c) => c.detail.length > 0)).toBe(true);
      // Named rather than counted, so the next reader knows which question.
      expect(verdict.unresolved.length).toBeGreaterThan(0);
      expect(verdict.unresolved.some((line) => line.startsWith('needs a reading:'))).toBe(true);
      expect(verdict.reason).toMatch(/Not decision-ready/);
    });

    it('says plainly when there is nothing to build, and does not call that ready', async () => {
      const packetId = await packetWithGaps();
      for (const gap of await listGaps(packetId)) {
        await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'closed for the test' });
      }
      const verdict = await decisionReadiness(packetId);
      const build = verdict.conditions.find((c) => c.clause === 'there is something to build');
      expect(build?.holds).toBe(false);
      expect(build?.detail).toMatch(/connecting, evaluating or authorising rather than building/);
      // Nothing to build is not decision-ready to build.
      expect(verdict.decisionReady).toBe(false);
    });

    it('becomes ready only when every clause holds', async () => {
      const packetId = await packetWithGaps();
      for (const gap of await listGaps(packetId)) {
        if (gap.kind === 'NEEDS_A_READING' || gap.kind === 'REQUIRES_PERSON_AUTHORITY') {
          await setGapState({ gapId: gap.id, state: 'WAIVED', reason: 'answered for the test' });
        }
      }
      // One real thing to build, judged by a reader as the calculus refuses to.
      const remaining = await listGaps(packetId, { states: ['OPEN'] });
      const first = remaining[0];
      if (first) {
        await judgeGap({
          gapId: first.id,
          kind: 'MUST_BE_BUILT',
          derivedBy: 'WORKER',
          evidence: 'A reader compared it against the component and found no coverage.',
        });
      } else {
        // Nothing left open: the fixture must still exercise the ready path.
        const any = (await listGaps(packetId))[0];
        await setGapState({ gapId: any?.id as string, state: 'OPEN', reason: 'reopened for the test' });
        await judgeGap({
          gapId: any?.id as string,
          kind: 'MUST_BE_BUILT',
          derivedBy: 'WORKER',
          evidence: 'A reader compared it against the component and found no coverage.',
        });
      }

      const verdict = await decisionReadiness(packetId);
      expect(verdict.decisionReady).toBe(true);
      expect(verdict.reason).toMatch(/Every clause of the stopping condition holds/);
      expect(verdict.unresolved).toEqual([]);
    });

    it('will not be made ready by a gap Brain closed on its own authority', async () => {
      const packetId = await packetWithGaps();
      // `decisionReadiness` reads gap states and moves none of them, so there is
      // no path here through which stopping could be achieved by lowering a bar.
      const before = await listGaps(packetId);
      await decisionReadiness(packetId);
      const after = await listGaps(packetId);
      expect(after.map((gap) => `${gap.id}:${gap.state}:${gap.kind}`)).toEqual(
        before.map((gap) => `${gap.id}:${gap.state}:${gap.kind}`),
      );
    });
  });

  it('closes cleanly', async () => {
    await teardown();
  });
});
