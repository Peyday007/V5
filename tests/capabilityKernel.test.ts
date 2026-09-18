/**
 * One blueprint, read the whole way: bytes to canonical faculties.
 *
 * ---------------------------------------------------------------------------
 * Why this walks the journey instead of testing the parts
 * ---------------------------------------------------------------------------
 *
 * §24 records what walking found that reading did not: five transitions that
 * existed, were tested, and could be reached by nothing. Every one of them was
 * invisible to a test that arranged its own starting state. So this suite
 * starts from a file, registers it the way a person would, and drives the same
 * tick production drives — `advanceSources` — with only the worker simulated.
 *
 * What is fixture here is exactly the external edge: the sentences a worker
 * read out of the document, and the verdicts a second reader reached about
 * them. Everything else is the real importer, the real extraction queue, the
 * real bin machinery, the real validator and the real promotion.
 *
 * ---------------------------------------------------------------------------
 * The properties it is actually holding
 * ---------------------------------------------------------------------------
 *
 * The declines are the half that matters, so most of what is asserted below is
 * a refusal: a quote that is not in the document, a definition filed under the
 * wrong section, an unknown field, a verdict that is not one of the three, and
 * a candidate nobody judged. Each of those is a way the registry could come to
 * hold something the source does not say.
 *
 * And the one that this whole design exists for: **reading a document may not
 * move any dimension but the definition.** A Brain that ingested a blueprint
 * about Research Intelligence and then reported Research Intelligence as
 * implemented would be lying in the most expensive available direction, because
 * it would stop the very work the document exists to start.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  ensureArchitectureScope,
  registerBlueprint,
} from '../server/services/capability/ingest.ts';
import {
  advanceSources,
  dispatchAudit,
  dispatchExtraction,
  readSource,
  settleAudit,
  settleExtraction,
} from '../server/services/capability/extraction.ts';
import { scanSections, sectionUnitKey } from '../server/services/capability/sections.ts';
import {
  getFacultyBySlug,
  listCandidates,
  listFaculties,
  listRelationships,
  listStateEvents,
  getSource,
} from '../server/repos/faculties.ts';
import {
  assertIngestionScope,
  describeFaculty,
  facultySlug,
  IngestionScopeViolation,
  InvalidFacultyDefinition,
  validateFacultyDefinition,
} from '../server/domain/faculties.ts';
import { getBin, listBinUnitResults, putBinUnitResult } from '../server/repos/bins.ts';
import { hashUnitValue } from '../server/services/bins/contracts.ts';
import { evaluateContract } from '../server/services/bins/contracts.ts';
import { capabilityAuditLineage } from '../server/services/capability/independence.ts';

/* ------------------------------------------------------------------------- */
/* The document                                                               */
/* ------------------------------------------------------------------------- */

/**
 * A blueprint with the shape the real one has and none of its length.
 *
 * Three numbered faculties under chapter 5, a Shared Executive chapter, and —
 * deliberately — a numbered heading under a *different* chapter, so the scan's
 * "these are not faculties" branch is exercised by the fixture rather than
 * asserted about in the abstract.
 */
const BLUEPRINT = `# Brain Intelligence Map

**Status:** Canonical working blueprint

## 2. The Shared Executive: The Mind That Coordinates the Faculties

The Shared Executive maintains the active understanding of the whole situation
and calls the other faculties when their form of reasoning is needed. It is not
a fifteenth specialist department.

# 5. Intelligence Faculty Definitions

## 5.1 Research Intelligence

Research Intelligence determines what Brain needs to learn in order to support a
decision, plan, model, creation, or action. Its fundamental unit is a
decision-relevant uncertainty: a coherent unknown whose answer could change what
Brain believes or does.

## 5.2 Simulation and Modeling Intelligence

Simulation and Modeling Intelligence converts beliefs about a system into
explicit representations of how outcomes may be produced. A simulation is a
conditional representation, not reality.

## 5.3 Intent and Context Intelligence

Intent and Context Intelligence determines what a person actually means within
the surrounding conversation, history, project, relationships, and situation.

# 9. Shared Contracts Between Faculties

## 9.1 Observation

What happened, the source, the time, the scope and the permissions.
`;

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canonicalName: 'Research Intelligence',
    ordinal: 1,
    purpose:
      'Determines what Brain needs to learn in order to support a decision, plan, model, ' +
      'creation, or action.',
    centralQuestion: 'What must we learn, and when do we know enough?',
    promisedPower: 'Brain can say what it does not know that would change what it does.',
    responsibilities: ['Identify decision-relevant uncertainties.'],
    boundaries: ['Proposes what is true and what remains unknown; grants no authority.'],
    inputs: ['An interpreted objective.'],
    outputs: ['Validated or rejected claims.'],
    activationConditions: ['A decision depends on something Brain does not know.'],
    reentryConditions: ['New evidence changes what is worth asking.'],
    dependencies: ['Intent and Context Intelligence'],
    infrastructure: ['Evidence Engine'],
    allowedProposals: ['Belief updates.'],
    invariants: ['Uncertainty must survive the pipeline.'],
    evaluationRequirements: ['A decision reached that could not be reached before.'],
    failureModes: ['Collecting evidence while missing the decisive question.'],
    connections: [
      {
        relationship: 'CONSUMES',
        toFacultySlug: 'INTENT_AND_CONTEXT_INTELLIGENCE',
        toComponent: null,
        rationale: 'Intent protects research from literal wording and false restrictions.',
      },
      {
        relationship: 'PERSISTS_TO',
        toFacultySlug: null,
        toComponent: 'Evidence Engine',
        rationale: 'Claims, sources and provenance are stored there.',
      },
    ],
    ...overrides,
  };
}

/** An exact sentence from the fixture above, long enough to anchor. */
const RESEARCH_QUOTE =
  'Research Intelligence determines what Brain needs to learn in order to support a';
const SIMULATION_QUOTE =
  'Simulation and Modeling Intelligence converts beliefs about a system into';
const INTENT_QUOTE = 'Intent and Context Intelligence determines what a person actually means';
const EXECUTIVE_QUOTE =
  'The Shared Executive maintains the active understanding of the whole situation';

/* ------------------------------------------------------------------------- */
/* Driving a worker                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Submit a unit the way a worker does, through the repository the service uses.
 *
 * The bin's own lease is not taken: the point of these suites is the validation
 * and the promotion, and `tests/bins.test.ts` already owns the lease contract.
 * What is preserved is the thing the independence check reads — the lease
 * generation each result carries — so the refusal below is decided on the same
 * column production decides it on.
 */
async function submit(
  binId: string,
  unitKey: string,
  value: unknown,
  options: { generation?: number; workerId?: string } = {},
): Promise<void> {
  const text = JSON.stringify(value);
  await putBinUnitResult({
    binId,
    unitKey,
    value: text,
    contentHash: hashUnitValue(text),
    leaseId: `lease_${unitKey}`,
    leaseGeneration: options.generation ?? 1,
    submittedBy: options.workerId ?? 'wkr_extractor',
  });
}

/** Mark a bin finished, so the tick's "has this bin ended" question answers yes. */
async function finish(binId: string, state = 'COMPLETE'): Promise<void> {
  await getDb().run(`UPDATE bins SET state = ?, updated_at = ? WHERE id = ?`, [
    state,
    new Date().toISOString(),
    binId,
  ] as never[]);
}

let fixture: TestProject;

async function registerFixture(): Promise<{ sourceId: string; documentId: string }> {
  const registered = await registerBlueprint({
    filename: 'Brain_Intelligence_Map.md',
    contents: Buffer.from(BLUEPRINT, 'utf8'),
    title: 'Brain Intelligence Map',
    kind: 'BLUEPRINT',
    origin: 'the operator, attached to the workstream instruction',
    registeredBy: 'test',
  });
  expect(registered.problems).toEqual([]);
  return { sourceId: registered.source.id, documentId: registered.documentId };
}

/* ------------------------------------------------------------------------- */

describe('the capability kernel', () => {
  beforeEach(async () => {
    fixture = await freshProject();
  });

  describe('registering the source', () => {
    it('makes it a real document with bytes, a hash and a reading', async () => {
      const { sourceId, documentId } = await registerFixture();
      const source = await getSource(sourceId);

      expect(source).not.toBeNull();
      expect(source?.kind).toBe('BLUEPRINT');
      expect(source?.ingestState).toBe('REGISTERED');
      // Not a fixture row: the hash and the size came off the stored object.
      expect(source?.contentHash).toMatch(/^[0-9a-f]{16,}$/);
      expect(source?.byteSize).toBe(Buffer.byteLength(BLUEPRINT, 'utf8'));

      const document = await getDb().get<Record<string, unknown>>(
        `SELECT * FROM documents WHERE id = ?`,
        [documentId] as never[],
      );
      expect(document?.['scope']).toBe('PROJECT_SOURCE');
      // §11: a project-wide source is registered with no layer on purpose.
      expect(document?.['layer_id']).toBeNull();

      const reading = await readSource(sourceId);
      expect(reading?.unreadable).toBeNull();
    });

    it('registers identical bytes once, and says which call created it', async () => {
      const first = await registerFixture();
      const again = await registerBlueprint({
        filename: 'Brain_Intelligence_Map.md',
        contents: Buffer.from(BLUEPRINT, 'utf8'),
        title: 'Brain Intelligence Map',
        kind: 'BLUEPRINT',
        origin: 'a second attempt at the same registration',
        registeredBy: 'test',
      });
      expect(again.created).toBe(false);
      expect(again.source.id).toBe(first.sourceId);
    });

    it('lives in a TECHNICAL scope, so it is never counted as somebody’s work', async () => {
      const project = await ensureArchitectureScope();
      expect(project.purpose).toBe('TECHNICAL');
      // Idempotent by slug rather than by a flag.
      expect((await ensureArchitectureScope()).id).toBe(project.id);
    });

    it('refuses an amendment that names nothing to amend', async () => {
      await expect(
        registerBlueprint({
          filename: 'amendment.md',
          contents: Buffer.from('# Amendment\n\nFaculty 14 is expanded.\n', 'utf8'),
          title: 'Faculty 14 clarification',
          kind: 'AMENDMENT',
          origin: 'test',
          registeredBy: 'test',
        }),
      ).rejects.toThrow(/must name the source it amends/);
    });

    it('keeps the blueprint’s bytes when an amendment arrives', async () => {
      const { sourceId } = await registerFixture();
      const before = await getSource(sourceId);

      const amendment = await registerBlueprint({
        filename: 'faculty-14-amendment.md',
        contents: Buffer.from(
          '# Amendment to the Brain Intelligence Map\n\nFaculty 14 is expanded from ' +
            'Capability-Acquisition Intelligence to Capability Acquisition and Realization ' +
            'Intelligence.\n',
          'utf8',
        ),
        title: 'Faculty 14: acquisition and realization',
        kind: 'AMENDMENT',
        amendsId: sourceId,
        origin: 'the operator, in the workstream instruction',
        registeredBy: 'test',
      });

      expect(amendment.source.amendsId).toBe(sourceId);
      const after = await getSource(sourceId);
      // §5: the original keeps its bytes and its hash. An amendment is a source,
      // not an edit.
      expect(after?.contentHash).toBe(before?.contentHash);
      expect(after?.byteSize).toBe(before?.byteSize);
      expect(amendment.source.contentHash).not.toBe(before?.contentHash);
    });
  });

  describe('reading the document’s own structure', () => {
    it('finds the faculties under the definitions chapter and nothing else', async () => {
      const { sourceId } = await registerFixture();
      const reading = await readSource(sourceId);
      const faculties = (reading?.sections ?? []).filter((s) => s.kind === 'FACULTY');
      const executive = (reading?.sections ?? []).filter((s) => s.kind === 'SHARED_EXECUTIVE');

      expect(faculties.map((s) => s.number)).toEqual(['5.1', '5.2', '5.3']);
      expect(faculties.map((s) => s.ordinal)).toEqual([1, 2, 3]);
      // 9.1 is a shared contract, not a faculty. It is skipped and *named*,
      // so a wrong chapter guess is visible rather than silent.
      expect(reading?.skipped).toContain('9.1 Observation');
      // The Shared Executive is a chapter and is never counted as a faculty.
      expect(executive).toHaveLength(1);
      expect(faculties.some((s) => /executive/i.test(s.title))).toBe(false);
    });

    it('derives the same unit key twice, so two scans agree', async () => {
      const { sourceId } = await registerFixture();
      const reading = await readSource(sourceId);
      const keys = (reading?.sections ?? []).map(sectionUnitKey);
      expect(keys).toEqual(['shared_executive', 'faculty_01', 'faculty_02', 'faculty_03']);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('reports an unreadable source rather than an empty one', async () => {
      const { sourceId, documentId } = await registerFixture();
      // §9: a BLOCKED document is something Brain does not have. Forcing the run
      // into that state is the only part of this simulated.
      await getDb().run(
        `UPDATE extraction_runs SET status = 'BLOCKED', blocked_reason = ? WHERE document_id = ?`,
        ['the fixture forced it', documentId] as never[],
      );
      const reading = await readSource(sourceId);
      expect(reading?.unreadable).toMatch(/BLOCKED/);
      expect(reading?.sections).toEqual([]);
      // And it must not become an extraction assignment.
      expect(await dispatchExtraction(sourceId)).toBeNull();
      expect((await getSource(sourceId))?.ingestState).toBe('FAILED');
    });
  });

  describe('the extraction assignment', () => {
    it('declares one unit per section Brain found, so coverage is checkable', async () => {
      const { sourceId } = await registerFixture();
      const binId = await dispatchExtraction(sourceId);
      expect(binId).not.toBeNull();

      const bin = await getBin(binId as string);
      expect(bin?.completionContract).toBe('BLUEPRINT_EXTRACTION_V1');
      expect(bin?.workloadClass).toBe('CAPABILITY_READ');
      expect((bin?.manifest.units ?? []).map((u) => u.key)).toEqual([
        'shared_executive',
        'faculty_01',
        'faculty_02',
        'faculty_03',
      ]);
      // The worker is told what it may not do, and the list names the exact
      // over-reach this kernel exists to prevent.
      expect(bin?.manifest.prohibitedActions.join(' ')).toMatch(/implemented, evaluated/);
    });

    it('is handed out once, however many ticks read it', async () => {
      const { sourceId } = await registerFixture();
      const [first, second] = await Promise.all([
        dispatchExtraction(sourceId),
        dispatchExtraction(sourceId),
      ]);
      // A compare-and-swap on a value the claimant does not supply. Exactly one
      // wins; the loser creates no bin, which is an ordinary outcome.
      expect([first, second].filter((id) => id !== null)).toHaveLength(1);
    });

    it('refuses to finish while a declared section is unanswered', async () => {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      await submit(binId, 'faculty_01', { definition: definition(), quote: RESEARCH_QUOTE });

      const verdict = await evaluateContract((await getBin(binId)) as never);
      expect(verdict.satisfied).toBe(false);
      expect(verdict.reasons.join(' ')).toMatch(/3 declared section\(s\) have no submission/);
    });
  });

  describe('validating what came back', () => {
    async function extractAndSettle(
      submissions: Array<[string, unknown]>,
    ): Promise<Awaited<ReturnType<typeof settleExtraction>>> {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      for (const [key, value] of submissions) await submit(binId, key, value);
      await finish(binId);
      return settleExtraction(sourceId);
    }

    it('accepts a definition whose quote is in the document', async () => {
      const settled = await extractAndSettle([
        ['faculty_01', { definition: definition(), quote: RESEARCH_QUOTE }],
      ]);
      expect(settled?.validated).toBe(1);
      expect(settled?.rejected).toBe(0);

      const [candidate] = await listCandidates({ states: ['VALIDATED'] });
      expect(candidate?.slug).toBe('RESEARCH_INTELLIGENCE');
      // The page came from the block Brain found the quote in, never from the
      // model — which is what makes the citation a fact about the document.
      expect(candidate?.evidenceBlockId).not.toBeNull();
      expect(candidate?.evidencePage).toBe(1);
    });

    it('refuses a quote that is not in the document, and keeps the refusal', async () => {
      const settled = await extractAndSettle([
        [
          'faculty_01',
          {
            definition: definition(),
            quote:
              'Research Intelligence is responsible for scheduling the fleet and paying invoices.',
          },
        ],
      ]);
      expect(settled?.validated).toBe(0);
      expect(settled?.rejected).toBe(1);

      const [rejected] = await listCandidates({ states: ['REJECTED'] });
      expect(rejected?.rejectionReason).toMatch(/does not appear in the source/);
      // Kept, not dropped: a dropped candidate makes a coverage gap look like
      // something nobody proposed.
      expect(rejected?.definition.canonicalName).toBe('Research Intelligence');
    });

    it('refuses a quote too short to be a citation', async () => {
      const settled = await extractAndSettle([
        ['faculty_01', { definition: definition(), quote: 'Research' }],
      ]);
      expect(settled?.rejected).toBe(1);
    });

    it('refuses a definition filed under the wrong section', async () => {
      // The Westbrook defect at a section number: every row is healthy and the
      // work is filed under the wrong heading.
      const settled = await extractAndSettle([
        [
          'faculty_02',
          { definition: definition(), quote: RESEARCH_QUOTE },
        ],
      ]);
      expect(settled?.validated).toBe(0);
      expect(settled?.problems.join(' ')).toMatch(
        /asked about "Simulation and Modeling Intelligence" and the definition names/,
      );
      // Refused rather than reconciled.
      expect(settled?.problems.join(' ')).toMatch(/refused rather than reconciled/);
    });

    it('names the sections nobody answered rather than passing over them', async () => {
      const settled = await extractAndSettle([
        ['faculty_01', { definition: definition(), quote: RESEARCH_QUOTE }],
      ]);
      expect(settled?.unanswered).toEqual([
        'shared_executive (The Shared Executive: The Mind That Coordinates the Faculties)',
        'faculty_02 (Simulation and Modeling Intelligence)',
        'faculty_03 (Intent and Context Intelligence)',
      ]);
    });

    it('ignores a unit Brain never declared, and says so', async () => {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      await submit(binId, 'faculty_01', { definition: definition(), quote: RESEARCH_QUOTE });
      // Written straight to the table: `submitUnit` already refuses an
      // undeclared key, and this asserts the settle is not relying on that.
      await getDb().run(
        `INSERT INTO bin_unit_results (id, bin_id, unit_key, work_item_id, value, content_hash,
           lease_id, lease_generation, submitted_by, created_at)
         VALUES (?, ?, 'faculty_99', NULL, '{}', 'x', NULL, 1, 'wkr', ?)`,
        ['bur_stray', binId, new Date().toISOString()] as never[],
      );
      await finish(binId);
      const settled = await settleExtraction(sourceId);
      expect(settled?.problems.join(' ')).toMatch(/"faculty_99" was submitted and is not a declared/);
    });
  });

  describe('the schema a worker is held to', () => {
    it('refuses the whole candidate for an unknown field', () => {
      let thrown: unknown;
      try {
        validateFacultyDefinition(definition({ implementationStatus: 'LIVE' }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidFacultyDefinition);
      expect((thrown as InvalidFacultyDefinition).problems.join(' ')).toMatch(
        /unknown field\(s\): implementationStatus/,
      );
    });

    it('refuses a relationship nobody implemented', () => {
      expect(() =>
        validateFacultyDefinition(
          definition({
            connections: [
              {
                relationship: 'VIBES_WITH',
                toFacultySlug: 'INTENT_AND_CONTEXT_INTELLIGENCE',
                toComponent: null,
                rationale: 'invented',
              },
            ],
          }),
        ),
      ).toThrow(/is not one of/);
    });

    it('refuses an edge with two endpoints or none', () => {
      const both = { relationship: 'READS', toFacultySlug: 'X', toComponent: 'Y', rationale: 'r' };
      const neither = {
        relationship: 'READS',
        toFacultySlug: null,
        toComponent: null,
        rationale: 'r',
      };
      expect(() => validateFacultyDefinition(definition({ connections: [both] }))).toThrow(
        /exactly one endpoint/,
      );
      expect(() => validateFacultyDefinition(definition({ connections: [neither] }))).toThrow(
        /exactly one endpoint/,
      );
    });

    it('derives the slug rather than taking the worker’s', () => {
      const parsed = validateFacultyDefinition(
        definition({ slug: 'whatever-the-worker-felt-like' }),
      );
      // The platform owns the identifier, exactly as it owns a filename.
      expect(parsed.slug).toBe('RESEARCH_INTELLIGENCE');
      expect(facultySlug('Capability-Acquisition Intelligence')).toBe(
        'CAPABILITY_ACQUISITION_INTELLIGENCE',
      );
    });

    it('reports every problem at once rather than one per round trip', () => {
      let thrown: InvalidFacultyDefinition | null = null;
      try {
        validateFacultyDefinition({
          canonicalName: '',
          purpose: '',
          promisedPower: '',
          responsibilities: 'not a list',
          connections: [],
        });
      } catch (error) {
        thrown = error as InvalidFacultyDefinition;
      }
      expect(thrown?.problems.length).toBeGreaterThan(3);
    });
  });

  describe('the independent audit', () => {
    async function readyForAudit(): Promise<{ sourceId: string; extractionBinId: string }> {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      await submit(binId, 'faculty_01', { definition: definition(), quote: RESEARCH_QUOTE });
      await submit(binId, 'faculty_02', {
        definition: definition({
          canonicalName: 'Simulation and Modeling Intelligence',
          ordinal: 2,
          connections: [],
        }),
        quote: SIMULATION_QUOTE,
      });
      await submit(binId, 'faculty_03', {
        definition: definition({
          canonicalName: 'Intent and Context Intelligence',
          ordinal: 3,
          connections: [],
        }),
        quote: INTENT_QUOTE,
      });
      await submit(binId, 'shared_executive', {
        definition: definition({
          canonicalName: 'The Shared Executive: The Mind That Coordinates the Faculties',
          ordinal: null,
          connections: [],
        }),
        quote: EXECUTIVE_QUOTE,
      });
      await finish(binId);
      await settleExtraction(sourceId);
      return { sourceId, extractionBinId: binId };
    }

    it('refuses the session that produced the reading', async () => {
      const { extractionBinId } = await readyForAudit();
      // Brain's own dispatch row is what says which session it fired.
      await getDb().run(
        `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count,
           next_attempt_at, session_ref, created_at, updated_at)
         VALUES (?, ?, 1, 'SENT', 1, ?, 'cse_extractor', ?, ?)`,
        [
          'bdp_1',
          extractionBinId,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        ] as never[],
      );

      const same = await capabilityAuditLineage({
        extractionBinId,
        reviewer: { sessionId: 'cse_extractor', workerId: 'wkr_extractor' },
      });
      expect(same.ok).toBe(false);
      expect(same.reason).toMatch(/produced this reading/);

      const other = await capabilityAuditLineage({
        extractionBinId,
        reviewer: { sessionId: 'cse_auditor', workerId: 'wkr_extractor' },
      });
      expect(other.ok).toBe(true);
      // Reported at the tier it earned, never rounded up: the same worker
      // identity means SESSION_SEPARATED and not WORKER_SEPARATED.
      expect(other.tier).toBe('SESSION_SEPARATED');

      const separate = await capabilityAuditLineage({
        extractionBinId,
        reviewer: { sessionId: 'cse_auditor', workerId: 'wkr_auditor' },
      });
      expect(separate.tier).toBe('WORKER_SEPARATED');
    });

    it('fails closed when the arrival reports no session', async () => {
      const { extractionBinId } = await readyForAudit();
      const unknown = await capabilityAuditLineage({
        extractionBinId,
        reviewer: { sessionId: null, workerId: 'wkr_auditor' },
      });
      expect(unknown.ok).toBe(false);
      expect(unknown.reason).toMatch(/fails closed/);
    });

    it('promotes only what the audit called faithful', async () => {
      const { sourceId } = await readyForAudit();
      const auditBinId = (await dispatchAudit(sourceId)) as string;
      expect(auditBinId).not.toBeNull();

      await submit(auditBinId, 'verdict_research_intelligence', {
        verdict: 'FAITHFUL',
        reason: 'Every clause is in the section.',
      });
      await submit(auditBinId, 'verdict_simulation_and_modeling_intelligence', {
        verdict: 'OVERREACHES',
        reason: 'The source states no activation conditions for it.',
      });
      await submit(auditBinId, 'verdict_intent_and_context_intelligence', {
        verdict: 'FAITHFUL',
        reason: 'Faithful to 5.3.',
      });
      // The Shared Executive is deliberately left unjudged.
      await finish(auditBinId);

      const settled = await settleAudit(sourceId);
      expect(settled?.promoted).toBe(2);
      expect(settled?.refused).toBe(1);
      expect(settled?.unjudged).toEqual([
        'THE_SHARED_EXECUTIVE_THE_MIND_THAT_COORDINATES_THE_FACULTIES',
      ]);

      const promoted = (await listFaculties()).map((f) => f.slug);
      expect(promoted).toContain('RESEARCH_INTELLIGENCE');
      expect(promoted).toContain('INTENT_AND_CONTEXT_INTELLIGENCE');
      // Refused and unjudged both stay out. An unjudged definition that became
      // canonical because nobody got to it is the vacuous satisfaction the
      // candidate stage exists to prevent.
      expect(promoted).not.toContain('SIMULATION_AND_MODELING_INTELLIGENCE');
      expect(promoted).not.toContain('THE_SHARED_EXECUTIVE_THE_MIND_THAT_COORDINATES_THE_FACULTIES');
    });

    it('refuses a verdict that is not one of the three', async () => {
      const { sourceId } = await readyForAudit();
      const auditBinId = (await dispatchAudit(sourceId)) as string;
      await submit(auditBinId, 'verdict_research_intelligence', {
        verdict: 'mostly faithful',
        reason: 'close enough',
      });
      await finish(auditBinId);

      const settled = await settleAudit(sourceId);
      // Matched exactly. No substring matching, no "closest verdict".
      expect(settled?.promoted).toBe(0);
      expect(settled?.problems.join(' ')).toMatch(/is not one of FAITHFUL, OVERREACHES, INCOMPLETE/);
    });

    it('refuses a verdict with no reason', async () => {
      const { sourceId } = await readyForAudit();
      const auditBinId = (await dispatchAudit(sourceId)) as string;
      await submit(auditBinId, 'verdict_research_intelligence', { verdict: 'FAITHFUL' });
      await finish(auditBinId);
      const settled = await settleAudit(sourceId);
      expect(settled?.promoted).toBe(0);
      expect(settled?.problems.join(' ')).toMatch(/carried no reason/);
    });

    it('fails the source when nothing survived validation', async () => {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      await submit(binId, 'faculty_01', { definition: definition(), quote: 'nowhere in the text at all here' });
      await finish(binId);
      await settleExtraction(sourceId);
      expect(await dispatchAudit(sourceId)).toBeNull();
      const source = await getSource(sourceId);
      expect(source?.ingestState).toBe('FAILED');
      expect(source?.ingestDetail).toMatch(/No candidate survived validation/);
    });
  });

  describe('what promotion may and may not change', () => {
    it('moves the definition and leaves the other five exactly where they were', async () => {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      await submit(binId, 'faculty_01', { definition: definition(), quote: RESEARCH_QUOTE });
      await finish(binId);
      await settleExtraction(sourceId);
      const auditBinId = (await dispatchAudit(sourceId)) as string;
      await submit(auditBinId, 'verdict_research_intelligence', {
        verdict: 'FAITHFUL',
        reason: 'Faithful to 5.1.',
      });
      await finish(auditBinId);
      await settleAudit(sourceId);

      const faculty = await getFacultyBySlug('RESEARCH_INTELLIGENCE');
      expect(faculty?.definitionState).toBe('CANONICAL');
      // This is the property the whole registry exists to keep.
      expect(faculty?.contractState).toBe('MISSING');
      expect(faculty?.implementationState).toBe('ABSENT');
      expect(faculty?.evaluationState).toBe('UNTESTED');
      expect(faculty?.availabilityState).toBe('DISABLED');
      expect(faculty?.freshnessState).toBe('CURRENT');

      // And Brain says so in words, with no number standing in for the six.
      const sentence = describeFaculty({
        canonicalName: faculty?.canonicalName ?? '',
        definitionState: faculty?.definitionState ?? 'MISSING',
        contractState: faculty?.contractState ?? 'MISSING',
        implementationState: faculty?.implementationState ?? 'ABSENT',
        evaluationState: faculty?.evaluationState ?? 'UNTESTED',
        availabilityState: faculty?.availabilityState ?? 'DISABLED',
        freshnessState: faculty?.freshnessState ?? 'CURRENT',
      });
      expect(sentence).toMatch(/canonically defined/);
      expect(sentence).toMatch(/no implementation/);
      expect(sentence).toMatch(/not yet evaluated/);
    });

    it('refuses an ingestion that tries to move any other dimension', () => {
      expect(() => assertIngestionScope('DEFINITION')).not.toThrow();
      for (const dimension of ['IMPLEMENTATION', 'EVALUATION', 'AVAILABILITY', 'CONTRACT'] as const) {
        expect(() => assertIngestionScope(dimension)).toThrow(IngestionScopeViolation);
      }
    });

    it('records why each dimension moved, append-only', async () => {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      await submit(binId, 'faculty_01', { definition: definition(), quote: RESEARCH_QUOTE });
      await finish(binId);
      await settleExtraction(sourceId);
      const auditBinId = (await dispatchAudit(sourceId)) as string;
      await submit(auditBinId, 'verdict_research_intelligence', {
        verdict: 'FAITHFUL',
        reason: 'Faithful.',
      });
      await finish(auditBinId);
      await settleAudit(sourceId);

      const faculty = await getFacultyBySlug('RESEARCH_INTELLIGENCE');
      const events = await listStateEvents(faculty?.id as string);
      expect(events).toHaveLength(1);
      expect(events[0]?.dimension).toBe('DEFINITION');
      expect(events[0]?.fromState).toBe('MISSING');
      expect(events[0]?.toState).toBe('CANONICAL');
      // A move names its evidence, so "when did Brain start believing this"
      // is answerable from rows.
      expect(events[0]?.evidenceRef).toBe(auditBinId);
      expect(events[0]?.reason).toMatch(/Promoted from candidate/);
    });
  });

  describe('the edges', () => {
    it('records what resolves and reports what does not, rather than inventing it', async () => {
      const { sourceId } = await registerFixture();
      const binId = (await dispatchExtraction(sourceId)) as string;
      // Research Intelligence declares an edge to Intent, which is promoted in
      // the same pass, and one to the Evidence Engine, which is a component.
      await submit(binId, 'faculty_01', { definition: definition(), quote: RESEARCH_QUOTE });
      await submit(binId, 'faculty_03', {
        definition: definition({
          canonicalName: 'Intent and Context Intelligence',
          ordinal: 3,
          connections: [
            {
              relationship: 'PROPOSES_TO',
              toFacultySlug: 'STRATEGIC_INTELLIGENCE',
              toComponent: null,
              rationale: 'The blueprint names Strategy as a consumer.',
            },
          ],
        }),
        quote: INTENT_QUOTE,
      });
      await finish(binId);
      await settleExtraction(sourceId);
      const auditBinId = (await dispatchAudit(sourceId)) as string;
      await submit(auditBinId, 'verdict_research_intelligence', {
        verdict: 'FAITHFUL',
        reason: 'ok',
      });
      await submit(auditBinId, 'verdict_intent_and_context_intelligence', {
        verdict: 'FAITHFUL',
        reason: 'ok',
      });
      await finish(auditBinId);
      const settled = await settleAudit(sourceId);

      const edges = await listRelationships();
      const kinds = edges.map((e) => `${e.relationship}:${e.toComponent ?? e.toFacultyId}`);
      // The forward reference resolves, because edges are linked after every
      // faculty this source produced exists.
      const intent = await getFacultyBySlug('INTENT_AND_CONTEXT_INTELLIGENCE');
      expect(kinds).toContain(`CONSUMES:${intent?.id}`);
      expect(kinds).toContain('PERSISTS_TO:Evidence Engine');
      // Strategic Intelligence was never defined by this source, so the edge is
      // missing and *named* rather than pointed at nothing.
      expect(settled?.problems.join(' ')).toMatch(
        /INTENT_AND_CONTEXT_INTELLIGENCE PROPOSES_TO STRATEGIC_INTELLIGENCE: that faculty is not canonical/,
      );
    });
  });

  describe('the tick', () => {
    it('carries a source the whole way with nothing but a worker simulated', async () => {
      const { sourceId } = await registerFixture();

      // 1. Nothing is assigned until the tick runs.
      expect((await getSource(sourceId))?.ingestState).toBe('REGISTERED');

      const first = await advanceSources();
      expect(first.dispatched).toBe(1);
      const extractionBin = (await getSource(sourceId))?.binId as string;

      // 2. A worker reads it.
      await submit(extractionBin, 'faculty_01', {
        definition: definition(),
        quote: RESEARCH_QUOTE,
      });
      await finish(extractionBin);

      const second = await advanceSources();
      expect(second.settled).toBe(1);
      expect(second.audited).toBe(1);
      expect((await getSource(sourceId))?.ingestState).toBe('AUDITING');

      // 3. A different session judges it.
      const auditBin = (await getSource(sourceId))?.binId as string;
      expect(auditBin).not.toBe(extractionBin);
      await submit(auditBin, 'verdict_research_intelligence', {
        verdict: 'FAITHFUL',
        reason: 'Faithful to section 5.1.',
      });
      await finish(auditBin);

      const third = await advanceSources();
      expect(third.promoted).toBe(1);
      expect((await getSource(sourceId))?.ingestState).toBe('PROMOTED');
      expect((await listFaculties()).map((f) => f.slug)).toEqual(['RESEARCH_INTELLIGENCE']);

      // 4. Running again changes nothing. Every stage is idempotent by its own
      //    rows rather than by a flag a dead tick could have left set.
      const fourth = await advanceSources();
      expect(fourth).toEqual({
        dispatched: 0,
        settled: 0,
        audited: 0,
        promoted: 0,
        recovered: 0,
      });
      expect(await listFaculties()).toHaveLength(1);
    });

    it('puts back a source claimed by a tick that died before it made the bin', async () => {
      const { sourceId } = await registerFixture();
      // Exactly the crash window `dispatchExtraction` opens on purpose: the swap
      // happened and the bin did not.
      await getDb().run(
        `UPDATE capability_sources SET ingest_state = 'EXTRACTING', bin_id = NULL WHERE id = ?`,
        [sourceId] as never[],
      );
      const report = await advanceSources();
      expect(report.recovered).toBe(1);
      // And it is handed out again in the same tick.
      expect(report.dispatched).toBe(1);
    });
  });

  afterEachTeardown();
});

function afterEachTeardown(): void {
  it('leaves the database closable', async () => {
    await teardown();
  });
}
