/**
 * From a decision-ready packet to a contract the Factory can act on.
 *
 * ---------------------------------------------------------------------------
 * The chain this suite is protecting
 * ---------------------------------------------------------------------------
 *
 * Every acceptance condition traces to a gap, the gap to a requirement, the
 * requirement to a faculty's definition, the definition to a candidate, the
 * candidate to a quote, and the quote to a block in the registered source. A
 * clause with no gap behind it breaks that at its first link, so the assertions
 * below are mostly about what the compiler will *not* produce.
 *
 * And it produces a submission rather than starting one. §27 gives approving
 * the objective and approving the release to a person, and this adds no third
 * path around either.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { scanSystem } from '../server/services/selfmodel/scan.ts';
import { compile, BUILDABLE, provenanceStillHolds } from '../server/services/realize/compile.ts';
import {
  derivePacket,
  judgeGap,
  listGaps,
  openPacket,
  setGapState,
} from '../server/services/realize/packet.ts';
import { decisionReadiness } from '../server/services/realize/director.ts';
import { promoteCandidate, putCandidate } from '../server/repos/faculties.ts';
import { validateFacultyDefinition } from '../server/domain/faculties.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';

let fixture: TestProject;

async function readyPacket(): Promise<{ packetId: string; buildableGapIds: string[] }> {
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
    definition: validateFacultyDefinition({
      canonicalName: 'Research Intelligence',
      ordinal: 1,
      purpose: 'Determines what Brain needs to learn to support a decision.',
      centralQuestion: 'What must we learn, and when do we know enough?',
      promisedPower:
        'Brain can name the unknown that would change what it does, and say when it has ' +
        'learned enough to stop.',
      responsibilities: ['Identify decision-relevant uncertainties.'],
      boundaries: ['Grants no authority and performs no external action.'],
      inputs: ['An interpreted objective.'],
      outputs: ['Validated or rejected claims.'],
      activationConditions: ['A decision depends on something unestablished.'],
      reentryConditions: ['New evidence changes what is worth asking.'],
      dependencies: ['A calibrated confidence model for partial evidence.'],
      infrastructure: ['A holographic projector for spatial reasoning.'],
      allowedProposals: ['Belief updates.'],
      invariants: ['Uncertainty must survive the pipeline.'],
      evaluationRequirements: ['A decision reached that could not be reached before.'],
      failureModes: ['Missing the decisive question.'],
      connections: [],
    } as unknown),
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

  // A reader does what the calculus refuses to: two gaps become builds, and
  // everything else is answered so the stopping condition can hold.
  const gaps = await listGaps(packet.id, { states: ['OPEN'] });
  const buildable: string[] = [];
  for (const [index, gap] of gaps.entries()) {
    if (index < 2 && gap.kind === 'NEEDS_A_READING') {
      await judgeGap({
        gapId: gap.id,
        kind: 'MUST_BE_BUILT',
        derivedBy: 'WORKER',
        evidence: 'A reader compared the requirement against the component and found no coverage.',
      });
      buildable.push(gap.id);
      continue;
    }
    await setGapState({ gapId: gap.id, state: 'WAIVED', reason: 'answered for the test' });
  }
  return { packetId: packet.id, buildableGapIds: buildable };
}

describe('compiling a packet into a change request', () => {
  beforeEach(async () => {
    fixture = await freshProject();
  });

  it('refuses a packet that is not decision-ready', async () => {
    const registered = await registerBlueprint({
      filename: 'map.md',
      contents: Buffer.from('# Map\n\n## 5.1 Research Intelligence\n\nA long enough section.\n', 'utf8'),
      title: 'Map',
      kind: 'BLUEPRINT',
      origin: 'test',
      registeredBy: 'test',
    });
    const candidate = await putCandidate({
      sourceId: registered.source.id,
      binId: null,
      definition: validateFacultyDefinition({
        canonicalName: 'Research Intelligence',
        ordinal: 1,
        purpose: 'p',
        centralQuestion: null,
        promisedPower: 'Brain can say what it does not know.',
        responsibilities: [],
        boundaries: [],
        inputs: ['An interpreted objective.'],
        outputs: [],
        activationConditions: [],
        reentryConditions: [],
        dependencies: [],
        infrastructure: [],
        allowedProposals: [],
        invariants: [],
        evaluationRequirements: [],
        failureModes: [],
        connections: [],
      } as unknown),
      evidenceQuote: 'A long enough section.',
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

    const outcome = await compile({ packetId: packet.id, projectId: fixture.project.id });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // A contract compiled over open questions asks for work nobody has
    // established is the right work.
    expect(outcome.reason).toMatch(/asks for work nobody has established/);
    expect(outcome.unresolved.length).toBeGreaterThan(0);
  });

  it('compiles one acceptance condition per buildable gap, each naming its gap', async () => {
    const { packetId, buildableGapIds } = await readyPacket();
    expect((await decisionReadiness(packetId)).decisionReady).toBe(true);

    const outcome = await compile({
      packetId,
      projectId: fixture.project.id,
      repositoryRemote: 'https://github.com/example/fixture.git',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { submission, provenance } = outcome.compiled;
    expect(provenance).toHaveLength(buildableGapIds.length);
    expect(submission.acceptanceConditions).toHaveLength(buildableGapIds.length);

    for (const entry of provenance) {
      expect(buildableGapIds).toContain(entry.gapId);
      // The gap id travels in the sentence, so a reviewer can walk back from a
      // clause in the contract to the passage it came from.
      expect(entry.condition).toContain(`[gap ${entry.gapId}]`);
      // The requirement is quoted rather than paraphrased.
      expect(entry.condition).toContain(`"${entry.requirement}"`);
    }
    // Every condition is mandatory and names how it is verified.
    for (const condition of submission.acceptanceConditions ?? []) {
      expect(condition.mandatory).toBe(true);
      expect(condition.verification).toMatch(/fails against the current tree/);
    }
  });

  it('carries the faculty’s own promise as the expected outcome', async () => {
    const { packetId } = await readyPacket();
    const outcome = await compile({ packetId, projectId: fixture.project.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.compiled.submission.expectedOutcome).toMatch(
      /name the unknown that would change what it does/,
    );
  });

  it('adds the two non-goals that stop a campaign looking finished', async () => {
    const { packetId } = await readyPacket();
    const outcome = await compile({ packetId, projectId: fixture.project.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const nonGoals = (outcome.compiled.submission.nonGoals ?? []).join(' ');
    // A dimension moves because code ran and was evaluated, never because an
    // implementation was merged.
    expect(nonGoals).toMatch(/never because an implementation was merged/);
    // And no parallel orchestration universe.
    expect(nonGoals).toMatch(/not a parallel universe/);
    // The faculty's own boundaries are carried too.
    expect(nonGoals).toMatch(/Grants no authority/);
  });

  it('never chooses the repository itself', async () => {
    const { packetId } = await readyPacket();
    const outcome = await compile({ packetId, projectId: fixture.project.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Which repository a project may change is an authorization in rows a
    // person wrote. A compiler that chose one would be picking its own reach.
    expect(outcome.compiled.submission.repositoryRemote).toBeUndefined();
  });

  it('produces a submission and starts nothing', async () => {
    const { packetId } = await readyPacket();
    const outcome = await compile({ packetId, projectId: fixture.project.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // No campaign, no change request row: approving is a person's decision
    // through the same entrance every other caller uses.
    const rows = await (
      await import('../server/db/database.ts')
    ).getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM factory_change_requests`);
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it('refuses when nothing is classified as a build', async () => {
    const { packetId } = await readyPacket();
    for (const gap of await listGaps(packetId, { states: ['OPEN', 'ASSIGNED'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'closed for the test' });
    }
    const outcome = await compile({ packetId, projectId: fixture.project.id });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    /*
     * The *readiness* guard catches this, not the empty-gaps one, because
     * `decisionReadiness` already requires something to build. That ordering is
     * correct and the second guard is deliberate defence in depth: the two
     * could drift, and a change request that asks for nothing is the outcome
     * nobody would notice until a campaign had run. The assertion follows the
     * reachable path rather than the one it would like to exercise.
     */
    expect(outcome.reason).toMatch(/there is something to build/);
    expect(outcome.reason).toMatch(/Not decision-ready/);
  });

  describe('provenance is a fact about now', () => {
    it('notices a gap that was waived after the contract was compiled', async () => {
      const { packetId } = await readyPacket();
      const outcome = await compile({ packetId, projectId: fixture.project.id });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect((await provenanceStillHolds(outcome.compiled)).ok).toBe(true);

      const [first] = outcome.compiled.provenance;
      await setGapState({
        gapId: first?.gapId as string,
        state: 'WAIVED',
        reason: 'somebody decided it is not required after all',
      });

      const after = await provenanceStillHolds(outcome.compiled);
      // A contract approved a week ago against gaps that have since been waived
      // is a campaign building something nobody wants any more.
      expect(after.ok).toBe(false);
      expect(after.stale.join(' ')).toMatch(/is WAIVED/);
    });

    it('notices a gap reclassified into something that is not a build', async () => {
      const { packetId } = await readyPacket();
      const outcome = await compile({ packetId, projectId: fixture.project.id });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const [first] = outcome.compiled.provenance;
      await judgeGap({
        gapId: first?.gapId as string,
        kind: 'EXISTS_BUT_DISCONNECTED',
        derivedBy: 'PERSON',
        evidence: 'It turned out to exist and need wiring.',
      });

      const after = await provenanceStillHolds(outcome.compiled);
      expect(after.ok).toBe(false);
      expect(after.stale.join(' ')).toMatch(/reclassified as EXISTS_BUT_DISCONNECTED/);
      expect(BUILDABLE).not.toContain('EXISTS_BUT_DISCONNECTED');
    });
  });

  it('closes cleanly', async () => {
    await teardown();
  });
});
