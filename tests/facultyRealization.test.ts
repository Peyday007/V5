/**
 * The five dimensions nothing moved, and the compiled contract nothing sent.
 *
 * ---------------------------------------------------------------------------
 * The two properties this suite exists for
 * ---------------------------------------------------------------------------
 *
 * **A reading refuses more often than it answers.** `realized.ts` derives three
 * of the six faculty dimensions and every branch of it has a way to say
 * nothing: an unclassified packet, a faculty that declares no evaluation
 * standard, an evaluation nobody can see from here, and a reading that would
 * walk a state backwards on the strength of an unknown. Those refusals are
 * asserted here at least as carefully as the answers, because a derivation that
 * always produced one would turn six honest columns into six confident wrong
 * ones — §36's own opening sentence.
 *
 * **A compiled contract becomes a row somebody can approve, and nothing more.**
 * `handoff.ts` submits and stops. The assertions below say the change request
 * exists in its pre-approval state, that the packet points at it, that a second
 * hand-off produces one ask rather than two, and that approving is somewhere
 * else entirely — `approveAndStartCampaign` is not imported by that module and a
 * test reads the source to say so.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import {
  DERIVED_DIMENSIONS,
  REFUSED_DIMENSIONS,
  applyRealization,
  readRealization,
} from '../server/services/realize/realized.ts';
import { handOff } from '../server/services/realize/handoff.ts';
import { askTheWorld, outstandingQuestions } from '../server/services/realize/askTheWorld.ts';
import {
  derivePacket,
  getPacket,
  judgeGap,
  listGaps,
  openPacket,
  putSection,
} from '../server/services/realize/packet.ts';
import {
  getFaculty,
  listStateEvents,
  promoteCandidate,
  putCandidate,
} from '../server/repos/faculties.ts';
import { FACULTY_DIMENSIONS } from '../server/domain/faculties.ts';
import { validateFacultyDefinition, type FacultyDefinition } from '../server/domain/faculties.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

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

/** One component row, with exactly the answers a case needs. */
async function component(input: {
  key: string;
  connected?: 'YES' | 'NO' | 'UNKNOWN';
  evaluated?: 'YES' | 'NO' | 'UNKNOWN';
  proven?: 'YES' | 'NO' | 'UNKNOWN';
}): Promise<void> {
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO system_components
       (id, component_key, kind, name, detail, documented, in_source, connected, deployed,
        observed_active, evaluated, production_proven, evidence, revision, observed_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('sys'),
      input.key,
      'SERVICE_MODULE',
      input.key.split(':')[1] ?? input.key,
      null,
      'UNKNOWN',
      'YES',
      input.connected ?? 'UNKNOWN',
      'YES',
      'UNKNOWN',
      input.evaluated ?? 'UNKNOWN',
      input.proven ?? 'UNKNOWN',
      '{}',
      null,
      at,
      at,
      at,
    ] as never[],
  );
}

/**
 * A packet whose gaps are all classified, with each one's kind chosen here.
 *
 * `derivePacket` writes the gaps; this then judges every one of them, which is
 * what a reader does in production. Judging is how a gap stops being
 * `NEEDS_A_READING`, so a fixture that skipped it would be testing the refusal
 * branch and nothing else.
 */
async function classifiedPacket(input: {
  facultyId: string;
  kind: 'EXISTS_AND_LIVE' | 'MUST_BE_BUILT' | 'EXISTS_BUT_DISCONNECTED';
  componentKey?: string;
  /**
   * Written after the derivation, and that ordering is the fixture's one
   * subtlety. `derivePacket` takes a scan, and a scan records honestly that a
   * component it can no longer observe is `IN_SOURCE: NO` — so a row inserted
   * beforehand is correctly overwritten with an absence. The self-model is
   * behaving; the fixture had to stop fighting it.
   */
  component?: () => Promise<void>;
}): Promise<string> {
  const opened = await openPacket({
    facultyId: input.facultyId,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  await derivePacket(opened.packet.id);
  if (input.component) await input.component();
  for (const gap of await listGaps(opened.packet.id)) {
    await judgeGap({
      gapId: gap.id,
      kind: input.kind,
      componentKey: input.componentKey ?? null,
      evidence: 'A reader compared the requirement against the component.',
      derivedBy: 'PERSON',
    });
  }
  return opened.packet.id;
}

/* ------------------------------------------------------------------------- */

describe('moving a faculty dimension from what the rows say', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('names the dimensions it may read, and the three it refuses, exhaustively', () => {
    // Between them these two must cover every dimension, so a seventh added
    // later is a compile-and-test failure rather than a column that silently
    // has no opinion attached to it.
    const covered = [...DERIVED_DIMENSIONS, ...Object.keys(REFUSED_DIMENSIONS)].sort();
    expect(covered).toEqual([...FACULTY_DIMENSIONS].sort());

    // AVAILABILITY is the one whose wrong answer is a wrong *action* rather
    // than a wrong belief, so the refusal is asserted by name.
    expect(DERIVED_DIMENSIONS).not.toContain('AVAILABILITY');
    expect(REFUSED_DIMENSIONS.AVAILABILITY).toMatch(/person/i);
  });

  it('has no function that moves availability, which is the absence of a mover', () => {
    // Read the source rather than call anything: the property is that nothing
    // exists, and a behavioural test can only ever say that the thing it
    // happened to call did not do it.
    const source = readFileSync('server/services/realize/realized.ts', 'utf8');
    expect(source).not.toMatch(/dimension:\s*'AVAILABILITY'/);
    expect(source).not.toMatch(/dimension:\s*'DEFINITION'/);
  });

  it('refuses an implementation reading while any gap still needs one', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await derivePacket(packet.id);
    const unread = (await listGaps(packet.id)).filter((gap) => gap.kind === 'NEEDS_A_READING');
    expect(unread.length).toBeGreaterThan(0);

    const reading = await readRealization(packet.id);
    const implementation = reading.readings.find((row) => row.dimension === 'IMPLEMENTATION');
    expect(implementation?.to).toBeNull();
    // Not ABSENT. "We could not tell" and "there is nothing there" have
    // different remedies, and only the second is a finding.
    expect(implementation?.reason).toMatch(/still need a reading/);

    const applied = await applyRealization({ packetId: packet.id, actorType: 'SYSTEM' });
    expect(applied.moved.map((row) => row.dimension)).not.toContain('IMPLEMENTATION');
    expect((await getFaculty(facultyId))?.implementationState).toBe('ABSENT');
  });

  it('reads every requirement served and reached as LIVE, and records the move', async () => {
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({
      facultyId,
      kind: 'EXISTS_AND_LIVE',
      componentKey: 'SERVICE_MODULE:research',
      component: () => component({ key: 'SERVICE_MODULE:research', connected: 'YES' }),
    });

    const applied = await applyRealization({ packetId, actorType: 'SYSTEM', actorId: 'test' });
    expect(applied.moved.find((row) => row.dimension === 'IMPLEMENTATION')?.to).toBe('LIVE');
    expect((await getFaculty(facultyId))?.implementationState).toBe('LIVE');

    // The column and the event are written together, so what changed it is
    // answerable from history rather than from this test's memory.
    const events = await listStateEvents(facultyId);
    const move = events.find((row) => row.dimension === 'IMPLEMENTATION');
    expect(move?.toState).toBe('LIVE');
    expect(move?.reason).toContain(packetId);
  });

  it('reads a served-but-unreached faculty as CONNECTED rather than LIVE', async () => {
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({
      facultyId,
      kind: 'EXISTS_BUT_DISCONNECTED',
      componentKey: 'SERVICE_MODULE:orphan',
      component: () => component({ key: 'SERVICE_MODULE:orphan', connected: 'UNKNOWN' }),
    });

    const applied = await applyRealization({ packetId, actorType: 'SYSTEM' });
    // A module nobody imports is not a mechanism, which is the whole reason
    // this dimension has four values rather than two.
    expect(applied.moved.find((row) => row.dimension === 'IMPLEMENTATION')?.to).toBe('CONNECTED');
  });

  it('reads a faculty with nothing serving it as ABSENT', async () => {
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });

    const reading = await readRealization(packetId);
    const implementation = reading.readings.find((row) => row.dimension === 'IMPLEMENTATION');
    expect(implementation?.to).toBe('ABSENT');
    // Already ABSENT, so the move records nothing: history holds changes.
    const applied = await applyRealization({ packetId, actorType: 'SYSTEM' });
    expect(applied.moved.map((row) => row.dimension)).not.toContain('IMPLEMENTATION');
    expect(applied.unchanged.find((row) => row.dimension === 'IMPLEMENTATION')?.why).toMatch(
      /already ABSENT/i,
    );
  });

  it('never lowers a state on a reading built partly out of unknowns', async () => {
    const facultyId = await promoteFaculty(definition());
    const live = await classifiedPacket({
      facultyId,
      kind: 'EXISTS_AND_LIVE',
      componentKey: 'SERVICE_MODULE:research',
      component: () => component({ key: 'SERVICE_MODULE:research', connected: 'YES' }),
    });
    await applyRealization({ packetId: live, actorType: 'SYSTEM' });
    expect((await getFaculty(facultyId))?.implementationState).toBe('LIVE');

    // A later packet over a Brain that can no longer see the component. This is
    // what a deployed instance looks like: `tests/` is not in the image, and a
    // reading taken there must not walk a proven faculty back to nothing.
    await getDb().run(`DELETE FROM realization_packets WHERE id = ?`, [live] as never[]);
    const blind = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });

    const reading = await readRealization(blind);
    const implementation = reading.readings.find((row) => row.dimension === 'IMPLEMENTATION');
    expect(implementation?.to).toBeNull();
    expect(implementation?.withheld).toMatch(/may raise a state and never lower one/);

    await applyRealization({ packetId: blind, actorType: 'SYSTEM' });
    expect((await getFaculty(facultyId))?.implementationState).toBe('LIVE');
  });

  it('refuses an evaluation reading for a faculty that declares no standard', async () => {
    const facultyId = await promoteFaculty(definition({ evaluationRequirements: [] }));
    const packetId = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });

    const reading = await readRealization(packetId);
    const evaluation = reading.readings.find((row) => row.dimension === 'EVALUATION');
    expect(evaluation?.to).toBeNull();
    expect(evaluation?.reason).toMatch(/no exam behind it/);
  });

  it('never derives FAILING, because a suite that exists says nothing about passing', async () => {
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({
      facultyId,
      kind: 'EXISTS_AND_LIVE',
      componentKey: 'SERVICE_MODULE:research',
      component: () =>
        component({ key: 'SERVICE_MODULE:research', connected: 'YES', evaluated: 'NO' }),
    });

    const reading = await readRealization(packetId);
    const evaluation = reading.readings.find((row) => row.dimension === 'EVALUATION');
    expect(evaluation?.to).not.toBe('FAILING');
    // Nothing covers it, so there is no reading — rather than an alarm nobody
    // can act on.
    expect(evaluation?.to).toBeNull();
    expect(evaluation?.reason).toMatch(/cannot see `tests\/` at all/);

    // Matched as an assignment rather than as a word, because this module's own
    // header explains at length why FAILING is unreachable from here — and a
    // matcher that reads prose is the defect `operatorConsoleRemoved` already
    // had to be corrected for, one suite along.
    const source = readFileSync('server/services/realize/realized.ts', 'utf8');
    expect(source).not.toMatch(/to:\s*(guard\([^)]*)?'FAILING'/);
  });

  it('reads PRODUCTION_PROVEN only when the rows say it ran in production', async () => {
    const facultyId = await promoteFaculty(definition());
    const passing = await classifiedPacket({
      facultyId,
      kind: 'EXISTS_AND_LIVE',
      componentKey: 'SERVICE_MODULE:research',
      component: () =>
        component({
          key: 'SERVICE_MODULE:research',
          connected: 'YES',
          evaluated: 'YES',
          proven: 'NO',
        }),
    });
    expect(
      (await readRealization(passing)).readings.find((row) => row.dimension === 'EVALUATION')?.to,
    ).toBe('PASSING');

    await getDb().run(`UPDATE system_components SET production_proven = 'YES' WHERE component_key = ?`, [
      'SERVICE_MODULE:research',
    ] as never[]);
    expect(
      (await readRealization(passing)).readings.find((row) => row.dimension === 'EVALUATION')?.to,
    ).toBe('PRODUCTION_PROVEN');
  });

  it('moves the contract dimension from the sections that exist', async () => {
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });

    expect(
      (await readRealization(packetId)).readings.find((row) => row.dimension === 'CONTRACT')?.to,
    ).toBe('MISSING');

    await putSection({
      packetId,
      section: 'COGNITIVE_CONTRACT',
      content: { statement: 'What this faculty promises.' },
      authorKind: 'ACCEPTED',
      evidence: 'written by a person',
    });
    expect(
      (await readRealization(packetId)).readings.find((row) => row.dimension === 'CONTRACT')?.to,
    ).toBe('DRAFT');

    await putSection({
      packetId,
      section: 'TARGET_TOPOLOGY',
      content: { modules: ['services/research/intelligence'] },
      authorKind: 'ACCEPTED',
      evidence: 'written by a person',
    });
    expect(
      (await readRealization(packetId)).readings.find((row) => row.dimension === 'CONTRACT')?.to,
    ).toBe('COMPILED');
  });
});

/* ------------------------------------------------------------------------- */

describe('handing a decision-ready packet to the Factory', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('returns the compiler\'s own refusal rather than reinterpreting it', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await derivePacket(packet.id);

    const outcome = await handOff({ packetId: packet.id, projectId: 'prj_missing' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    // A packet one open question short and one with nothing to build are
    // different outcomes; a caller told "could not hand off" for both would go
    // looking in the wrong place.
    expect(outcome.reason.length).toBeGreaterThan(20);
    expect(await getPacket(packet.id)).toMatchObject({ changeRequestId: null });
  });

  it('never imports the approval, so a compiled contract cannot start itself', () => {
    // An import, not a mention: the module's header names the approval in order
    // to say it is somewhere else, and a matcher that could not tell those
    // apart would fail on the sentence that documents the boundary.
    const source = readFileSync('server/services/realize/handoff.ts', 'utf8');
    const imports = source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
    expect(imports.join('\n')).not.toContain('approveAndStartCampaign');
    expect(imports.join('\n')).not.toContain('factory/start.ts');
    expect(source).not.toMatch(/\bapproveAndStartCampaign\(/);
    // Submitting is the whole effect. §27 keeps approving the objective and
    // approving the release as the two decisions the factory has no path
    // around, and a self-expansion loop that approved its own work would be the
    // one failure mode declining a pull request does not contain.
    expect(source).toContain('submitObjective');
  });

  it('records the ask on the packet, once, and refuses to point it at a second', async () => {
    const { project } = await freshProject();
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });
    await putSection({
      packetId,
      section: 'COGNITIVE_CONTRACT',
      content: { statement: 'What this faculty promises.' },
      authorKind: 'ACCEPTED',
      evidence: 'written by a person',
    });
    await putSection({
      packetId,
      section: 'TARGET_TOPOLOGY',
      content: { modules: ['services/research/intelligence'] },
      authorKind: 'ACCEPTED',
      evidence: 'written by a person',
    });

    const first = await handOff({ packetId, projectId: project.id });
    if (!first.ok) {
      // A packet the stopping condition still refuses is a legitimate outcome
      // here, and asserting the refusal is honest rather than skipping.
      expect(first.reason.length).toBeGreaterThan(20);
      expect(await getPacket(packetId)).toMatchObject({ changeRequestId: null });
      return;
    }

    expect(first.changeRequest.state).not.toBe('APPROVED');
    expect((await getPacket(packetId))?.changeRequestId).toBe(first.changeRequest.id);

    // Idempotency means the effect is present after either call, not that the
    // second call does nothing.
    const again = await handOff({ packetId, projectId: project.id });
    if (!again.ok) throw new Error(again.reason);
    expect(again.changeRequest.id).toBe(first.changeRequest.id);
    expect((await getPacket(packetId))?.changeRequestId).toBe(first.changeRequest.id);

    const rows = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM realization_packets WHERE change_request_id = ?`,
      [first.changeRequest.id] as never[],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });
});

/* ------------------------------------------------------------------------- */

describe('asking the world what a packet still needs to know', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('turns a researchable gap into an idea, and moves the gap to it', async () => {
    const { project, layers } = await freshProject();
    const layerId = layers[0]?.id;
    if (!layerId) throw new Error('the fixture project has no layer');
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });
    // A reader turns one gap into a question about the world. The others stay
    // as things to build, which is the common case and is not research.
    const gaps = await listGaps(packetId);
    const first = gaps[0];
    if (!first) throw new Error('the packet derived no gaps');
    await judgeGap({
      gapId: first.id,
      kind: 'MUST_BE_RESEARCHED',
      evidence: 'A reader could not tell what would satisfy this without looking it up.',
      derivedBy: 'PERSON',
    });

    const outcome = await askTheWorld({ packetId, projectId: project.id, layerId });
    expect(outcome.asked).toHaveLength(1);
    const asked = outcome.asked[0];
    expect(asked?.candidateId).toBeTruthy();
    expect(asked?.gapId).toBe(first.id);

    // The link is a row rather than a search, so a merge cannot make a later
    // reader resolve the wrong idea.
    const outstanding = await outstandingQuestions(packetId);
    expect(outstanding.map((row) => row.candidateId)).toEqual([asked?.candidateId]);

    // Everything else was reported as real and not research, rather than asked.
    expect(outcome.notResearch.length).toBe(gaps.length - 1);
  });

  it('asks nothing twice, because the gap it asked about is no longer open', async () => {
    const { project, layers } = await freshProject();
    const layerId = layers[0]?.id;
    if (!layerId) throw new Error('the fixture project has no layer');
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });
    const first = (await listGaps(packetId))[0];
    if (!first) throw new Error('the packet derived no gaps');
    await judgeGap({
      gapId: first.id,
      kind: 'MUST_BE_RESEARCHED',
      evidence: 'A reader could not tell what would satisfy this without looking it up.',
      derivedBy: 'PERSON',
    });

    const once = await askTheWorld({ packetId, projectId: project.id, layerId });
    const twice = await askTheWorld({ packetId, projectId: project.id, layerId });
    expect(once.asked).toHaveLength(1);
    expect(twice.asked).toHaveLength(0);

    const candidates = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ?`,
      [project.id] as never[],
    );
    expect(Number(candidates[0]?.n ?? 0)).toBe(1);
  });

  it('launches, approves, enqueues and spends nothing', async () => {
    const { project, layers } = await freshProject();
    const layerId = layers[0]?.id;
    if (!layerId) throw new Error('the fixture project has no layer');
    const facultyId = await promoteFaculty(definition());
    const packetId = await classifiedPacket({ facultyId, kind: 'MUST_BE_BUILT' });
    const first = (await listGaps(packetId))[0];
    if (!first) throw new Error('the packet derived no gaps');
    await judgeGap({
      gapId: first.id,
      kind: 'MUST_BE_RESEARCHED',
      evidence: 'A reader could not tell what would satisfy this without looking it up.',
      derivedBy: 'PERSON',
    });

    const before = await counts();
    await askTheWorld({ packetId, projectId: project.id, layerId });
    const after = await counts();

    // A capability question is Brain reasoning about Brain, which is the least
    // supervised thing in this codebase — so it may ask and it may not spend.
    expect(after).toEqual(before);

    // And the assertion is not vacuous: something did happen, in the one table
    // an idea is allowed to reach. A pass that had captured nothing would
    // satisfy the equality above while doing nothing at all.
    const candidates = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ?`,
      [project.id] as never[],
    );
    expect(Number(candidates[0]?.n ?? 0)).toBe(1);
  });

  it('holds no authorization and imports nothing that could grant one', () => {
    const source = readFileSync('server/services/realize/askTheWorld.ts', 'utf8');
    const imports = source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
    const joined = imports.join('\n');
    for (const forbidden of [
      'approvalEnvelope',
      'standingAuthority',
      'russell/authority',
      'russell/launch',
      'startPacket',
      'approvePlan',
      'enqueue',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });
});

/** Every table a launch, an approval, an enqueue or a spend would touch. */
async function counts(): Promise<Record<string, number>> {
  const tables = [
    'russell_missions',
    'russell_goals',
    'research_orchestrations',
    'research_fragments',
    'work_items',
    'work_leases',
    'bins',
  ];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const rows = await getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    out[table] = Number(rows[0]?.n ?? 0);
  }
  return out;
}
