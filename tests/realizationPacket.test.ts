/**
 * Holding a faculty's requirements against what Brain actually has.
 *
 * ---------------------------------------------------------------------------
 * The property this suite exists for
 * ---------------------------------------------------------------------------
 *
 * **Brain derives what it can read and refuses to guess the rest.** Every
 * assertion below is a variation on it. "Nothing matched" must not become
 * "this must be built"; a name match against a component the self-model cannot
 * speak for must not become "this exists"; and a requirement naming an
 * authority must not become something Brain thinks it can build its way out of.
 *
 * The failure mode is deliberately *missing* a match, which costs a reading,
 * rather than inventing one, which would tell somebody a thing exists when it
 * does not — §25's Westbrook defect, where every row is healthy and the work is
 * filed under the wrong heading.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { scanSystem } from '../server/services/selfmodel/scan.ts';
import type { SystemComponent } from '../server/services/selfmodel/scan.ts';
import {
  classify,
  DERIVABLE,
  deriveGaps,
  GAP_KINDS,
  matchComponent,
  NEEDS_JUDGEMENT,
  REQUIREMENT_ASPECTS,
  summarize,
} from '../server/services/realize/gaps.ts';
import {
  advance,
  currentSections,
  DERIVED_SECTIONS,
  derivePacket,
  facultiesWithoutPackets,
  judgeGap,
  listGaps,
  livePacketFor,
  missingSections,
  openPacket,
  PACKET_SECTIONS,
  putSection,
  readiness,
  setGapState,
} from '../server/services/realize/packet.ts';
import { getFacultyBySlug, promoteCandidate, putCandidate } from '../server/repos/faculties.ts';
import { validateFacultyDefinition, type FacultyDefinition } from '../server/domain/faculties.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';

/* ------------------------------------------------------------------------- */

function component(
  overrides: Partial<SystemComponent> & Pick<SystemComponent, 'name'>,
): SystemComponent {
  return {
    id: `sys_${overrides.name}`,
    componentKey: `SERVICE_MODULE:${overrides.name}`,
    kind: 'SERVICE_MODULE',
    detail: null,
    answers: {
      DOCUMENTED: 'UNKNOWN',
      IN_SOURCE: 'YES',
      CONNECTED: 'UNKNOWN',
      DEPLOYED: 'YES',
      OBSERVED_ACTIVE: 'UNKNOWN',
      EVALUATED: 'UNKNOWN',
      PRODUCTION_PROVEN: 'UNKNOWN',
      ...(overrides.answers ?? {}),
    },
    evidence: {},
    revision: null,
    observedAt: new Date().toISOString(),
    ...overrides,
    name: overrides.name,
  };
}

function definition(overrides: Partial<FacultyDefinition> = {}): FacultyDefinition {
  return validateFacultyDefinition({
    canonicalName: 'Research Intelligence',
    ordinal: 1,
    purpose: 'Determines what Brain needs to learn to support a decision.',
    centralQuestion: 'What must we learn, and when do we know enough?',
    promisedPower: 'Brain can say what it does not know that would change what it does.',
    responsibilities: ['Identify decision-relevant uncertainties.'],
    boundaries: ['Grants no authority and performs no external action.'],
    inputs: ['An interpreted objective from Intent Intelligence.'],
    outputs: ['Validated or rejected claims with provenance.'],
    activationConditions: ['A decision depends on something unestablished.'],
    reentryConditions: ['New evidence changes what is worth asking.'],
    dependencies: ['The extraction pipeline for reading a stored document.'],
    infrastructure: ['A durable workqueue with leases and fencing.'],
    allowedProposals: ['Belief updates.'],
    invariants: ['Uncertainty must survive the pipeline.'],
    evaluationRequirements: ['A decision reached that could not be reached before.'],
    failureModes: ['Collecting evidence while missing the decisive question.'],
    connections: [],
    ...overrides,
  } as unknown);
}

/** Promote a faculty through the repository, without needing a whole reading. */
async function promoteFaculty(def: FacultyDefinition): Promise<string> {
  const registered = await registerBlueprint({
    filename: 'map.md',
    contents: Buffer.from(
      '# Map\n\n## 5.1 Research Intelligence\n\nA section long enough to extract from.\n',
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
    definition: def,
    evidenceQuote: 'A section long enough to extract from.',
    evidenceBlockId: null,
    evidencePage: 1,
    state: 'VALIDATED',
  });
  const faculty = await promoteCandidate({
    candidateId: candidate.id,
    auditId: 'bin_test_audit',
    actorType: 'SYSTEM',
    actorId: 'test',
  });
  return faculty.id;
}

describe('the realization packet', () => {
  beforeEach(async () => {
    await freshProject();
  });

  describe('the gap calculus', () => {
    it('never derives a classification that needs a judgement', () => {
      // The boundary is a constant a test can hold, so moving it is deliberate.
      for (const kind of NEEDS_JUDGEMENT) expect(DERIVABLE).not.toContain(kind);
      expect([...DERIVABLE, ...NEEDS_JUDGEMENT].sort()).toEqual([...GAP_KINDS].sort());
    });

    it('calls nothing-matched a reading rather than something to build', () => {
      const gap = classify('A rendering engine for three-dimensional scenes', 'infrastructure', []);
      expect(gap.kind).toBe('NEEDS_A_READING');
      // This is the whole point. "Nothing matched" and "this must be built" are
      // different statements and only the first is one a name comparison makes.
      expect(gap.kind).not.toBe('MUST_BE_BUILT');
      expect(gap.evidence).toMatch(/"nothing matched" and not "this must be built"/);
    });

    it('reads a match the self-model cannot speak for as a reading, not a presence', () => {
      const gap = classify(
        'A durable workqueue with leases and fencing.',
        'infrastructure',
        [component({ name: 'server/repos/workQueue.ts' })],
      );
      // Matched a name; the self-model answers UNKNOWN for connectedness on
      // purpose, so whether it serves the requirement is somebody's reading.
      expect(gap.kind).toBe('NEEDS_A_READING');
      expect(gap.componentKey).toBe('SERVICE_MODULE:server/repos/workQueue.ts');
      expect(gap.evidence).toMatch(/a reading rather than a derivation/);
    });

    it('reads a live match as live, and a disconnected one as disconnected', () => {
      const live = classify('A durable workqueue with leases.', 'infrastructure', [
        component({
          name: 'server/repos/workQueue.ts',
          answers: {
            DOCUMENTED: 'YES',
            IN_SOURCE: 'YES',
            CONNECTED: 'YES',
            DEPLOYED: 'YES',
            OBSERVED_ACTIVE: 'YES',
            EVALUATED: 'YES',
            PRODUCTION_PROVEN: 'YES',
          },
        }),
      ]);
      expect(live.kind).toBe('EXISTS_AND_LIVE');

      const dead = classify('A durable workqueue with leases.', 'infrastructure', [
        component({
          name: 'server/repos/workQueue.ts',
          answers: {
            DOCUMENTED: 'YES',
            IN_SOURCE: 'YES',
            CONNECTED: 'NO',
            DEPLOYED: 'YES',
            OBSERVED_ACTIVE: 'NO',
            EVALUATED: 'NO',
            PRODUCTION_PROVEN: 'NO',
          },
        }),
      ]);
      expect(dead.kind).toBe('EXISTS_BUT_DISCONNECTED');
      expect(dead.evidence).toMatch(/nothing in the running process reaches it/);
    });

    it('sends anything naming an authority to a person, whatever exists', () => {
      for (const requirement of [
        'The permissions a worker holds on the project.',
        'A budget the operator approved.',
        'Explicit consent before contacting anybody.',
        'A credential issued for the connector.',
      ]) {
        const gap = classify(requirement, 'dependencies', [
          component({
            name: 'server/services/identity/policy.ts',
            answers: {
              DOCUMENTED: 'YES',
              IN_SOURCE: 'YES',
              CONNECTED: 'YES',
              DEPLOYED: 'YES',
              OBSERVED_ACTIVE: 'YES',
              EVALUATED: 'YES',
              PRODUCTION_PROVEN: 'YES',
            },
          }),
        ]);
        // Even with a perfectly live match: somebody has to decide it, and
        // classifying that as something Brain can build is the expensive error.
        expect(gap.kind).toBe('REQUIRES_PERSON_AUTHORITY');
      }
    });

    it('will not match on a stopword or a short token', () => {
      // "the system state" is three words and none of them identifies anything.
      expect(matchComponent('the system state data', [component({ name: 'server/state.ts' })]))
        .toBeNull();
    });

    it('takes requirements only from the aspects that name a thing', () => {
      const def = definition();
      const gaps = deriveGaps(def, []);
      const aspects = new Set(gaps.map((gap) => gap.aspect));
      for (const aspect of aspects) expect(REQUIREMENT_ASPECTS).toContain(aspect as never);
      // `purpose`, `promisedPower` and `boundaries` describe what a faculty is
      // for. Turning those into gaps would produce a build item for a sentence
      // about scope.
      expect(aspects.has('boundaries')).toBe(false);
      expect(aspects.has('purpose')).toBe(false);
      expect(aspects.has('responsibilities')).toBe(false);
    });

    it('counts only gaps that are still open', () => {
      const summary = summarize([
        { kind: 'MUST_BE_BUILT', state: 'OPEN' },
        { kind: 'MUST_BE_BUILT', state: 'CLOSED' },
        { kind: 'NEEDS_A_READING', state: 'WAIVED' },
        { kind: 'REQUIRES_PERSON_AUTHORITY', state: 'OPEN' },
      ]);
      expect(summary.total).toBe(2);
      expect(summary.byKind.MUST_BE_BUILT).toBe(1);
      expect(summary.awaitingAReading).toBe(0);
      expect(summary.awaitingAPerson).toBe(1);
    });
  });

  describe('opening a packet', () => {
    it('refuses a faculty whose definition is not canonical', async () => {
      const facultyId = await promoteFaculty(definition());
      await getDb().run(`UPDATE faculties SET definition_state = 'DRAFT' WHERE id = ?`, [
        facultyId,
      ] as never[]);
      await expect(
        openPacket({ facultyId, createdByType: 'SYSTEM' }),
      ).rejects.toThrow(/nobody audited/);
    });

    it('is one packet however many times it is asked for', async () => {
      const facultyId = await promoteFaculty(definition());
      const first = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      const again = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.packet.id).toBe(first.packet.id);
    });

    it('moves no dimension on the faculty', async () => {
      const facultyId = await promoteFaculty(definition());
      const before = await getFacultyBySlug('RESEARCH_INTELLIGENCE');
      await openPacket({ facultyId, createdByType: 'SYSTEM' });
      const after = await getFacultyBySlug('RESEARCH_INTELLIGENCE');
      // Intending to work on something is not having it.
      expect(after?.implementationState).toBe(before?.implementationState);
      expect(after?.evaluationState).toBe(before?.evaluationState);
      expect(after?.implementationState).toBe('ABSENT');
    });

    it('refuses to be blocked without naming a remedy', async () => {
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await expect(
        advance({ id: packet.id, from: 'DRAFT', to: 'BLOCKED' }),
      ).rejects.toThrow(/cannot resolve is not waiting/);
    });

    it('advances once however many ticks read it', async () => {
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      const results = await Promise.all([
        advance({ id: packet.id, from: 'DRAFT', to: 'RESEARCHING' }),
        advance({ id: packet.id, from: 'DRAFT', to: 'RESEARCHING' }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('stops being live once it is terminal, so a faculty can be realized again', async () => {
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await advance({ id: packet.id, from: 'DRAFT', to: 'ABANDONED' });
      expect(await livePacketFor(facultyId)).toBeNull();
      const second = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      expect(second.created).toBe(true);
      expect(second.packet.id).not.toBe(packet.id);
    });
  });

  describe('deriving', () => {
    it('writes three sections and leaves the other seven for a reader', async () => {
      await scanSystem('BOOT');
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });

      const report = await derivePacket(packet.id);
      expect(report.sectionsWritten.sort()).toEqual([...DERIVED_SECTIONS].sort());
      expect(report.gaps).toBeGreaterThan(0);

      const still = await missingSections(packet.id);
      expect(still).toHaveLength(PACKET_SECTIONS.length - DERIVED_SECTIONS.length);
      // A section written from a template would be indistinguishable from an
      // answered one to every reader downstream.
      expect(still).toContain('COGNITIVE_CONTRACT');
      expect(still).toContain('TARGET_TOPOLOGY');
      expect(still).toContain('EVALUATION_GRAPH');
    });

    it('pins the reading the gaps were decided against', async () => {
      const scan = await scanSystem('BOOT');
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      const report = await derivePacket(packet.id);
      // So "why did this come out that way" is answerable afterwards, rather
      // than re-derived against a database that has moved.
      expect(report.scanId).toBe(scan.scanId);
      const sections = await currentSections(packet.id);
      const currentState = sections.find((row) => row.section === 'CURRENT_STATE');
      expect(currentState?.evidence).toContain(scan.scanId);
    });

    it('does not call the current-state map "missing"', async () => {
      await scanSystem('BOOT');
      const facultyId = await promoteFaculty(
        definition({ infrastructure: ['A holographic projector for spatial reasoning.'] }),
      );
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await derivePacket(packet.id);

      const sections = await currentSections(packet.id);
      const map = sections.find((row) => row.section === 'CURRENT_STATE')
        ?.content as Record<string, unknown>;
      // "Nothing matched" is not "nothing exists", and naming the field
      // "missing" is precisely how the second comes to be believed.
      expect(Object.keys(map)).toContain('nothingMatched');
      expect(Object.keys(map)).not.toContain('missing');
      expect(map['nothingMatched']).toContain('A holographic projector for spatial reasoning.');
    });

    it('every version is kept, so a map that changed under a packet is visible', async () => {
      await scanSystem('BOOT');
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await derivePacket(packet.id);
      await derivePacket(packet.id);

      const rows = await getDb().all<{ version: number }>(
        `SELECT version FROM realization_sections WHERE packet_id = ? AND section = 'CURRENT_STATE'
          ORDER BY version`,
        [packet.id] as never[],
      );
      expect(rows.map((row) => Number(row.version))).toEqual([1, 2]);
      // Reading the packet means the newest of each.
      const current = await currentSections(packet.id);
      expect(current.find((row) => row.section === 'CURRENT_STATE')?.version).toBe(2);
    });

    it('refuses a section that does not say what it came from', async () => {
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await expect(
        putSection({
          packetId: packet.id,
          section: 'TARGET_TOPOLOGY',
          content: { anything: true },
          authorKind: 'PROPOSED',
          evidence: '   ',
        }),
      ).rejects.toThrow(/no stated basis/);
    });

    it('leaves a judged gap alone when it re-derives', async () => {
      await scanSystem('BOOT');
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await derivePacket(packet.id);

      const [gap] = await listGaps(packet.id, { kinds: ['NEEDS_A_READING'] });
      expect(gap).toBeDefined();
      await judgeGap({
        gapId: gap?.id as string,
        kind: 'MUST_BE_BUILT',
        derivedBy: 'WORKER',
        evidence: 'A reader compared the requirement against the module and found no coverage.',
      });

      await derivePacket(packet.id);
      const after = await listGaps(packet.id);
      const judged = after.find((row) => row.id === gap?.id);
      // Re-deriving over somebody's judgement would silently discard the
      // reading they were asked for.
      expect(judged?.kind).toBe('MUST_BE_BUILT');
      expect(judged?.derivedBy).toBe('WORKER');
    });
  });

  describe('readiness', () => {
    it('reports every condition, and never a single score', async () => {
      await scanSystem('BOOT');
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await derivePacket(packet.id);

      const verdict = await readiness(packet.id);
      expect(verdict.ready).toBe(false);
      // Ten sections plus the three gap conditions.
      expect(verdict.conditions).toHaveLength(PACKET_SECTIONS.length + 3);
      // A packet one condition short and one five short need different actions,
      // and a percentage tells a reader neither.
      expect(verdict.conditions.filter((c) => !c.holds).length).toBeGreaterThan(1);
      expect(verdict.conditions.some((c) => c.condition.includes('waiting on a reading'))).toBe(true);
    });

    it('says plainly when there is nothing left to build', async () => {
      await scanSystem('BOOT');
      const facultyId = await promoteFaculty(definition());
      const { packet } = await openPacket({ facultyId, createdByType: 'SYSTEM' });
      await derivePacket(packet.id);
      for (const gap of await listGaps(packet.id)) {
        await setGapState({
          gapId: gap.id,
          state: 'CLOSED',
          reason: 'the condition no longer holds',
        });
      }
      const verdict = await readiness(packet.id);
      const build = verdict.conditions.find((c) => c.condition.includes('left to build'));
      expect(build?.holds).toBe(false);
      // A real outcome, not a failure: a faculty whose requirements are already
      // served needs connecting or evaluating, not building.
      expect(build?.detail).toMatch(/real outcome and not a failure/);
    });
  });

  describe('what has not been started', () => {
    it('lists canonical faculties with no live packet', async () => {
      const facultyId = await promoteFaculty(definition());
      expect((await facultiesWithoutPackets()).map((f) => f.id)).toEqual([facultyId]);
      await openPacket({ facultyId, createdByType: 'SYSTEM' });
      expect(await facultiesWithoutPackets()).toEqual([]);
    });
  });

  it('closes cleanly', async () => {
    await teardown();
  });
});
