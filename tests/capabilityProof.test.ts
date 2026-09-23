/**
 * What makes a capability exist, as opposed to having been built.
 *
 * ---------------------------------------------------------------------------
 * The one sentence this suite is protecting
 * ---------------------------------------------------------------------------
 *
 * **A merged pull request moves no dimension in the registry.** Every assertion
 * below is a way of checking that: the implementation state comes from the
 * gaps rather than from a campaign, `LIVE` comes from the self-model having
 * *observed* the components, evaluation comes from the faculty's own declared
 * requirements rather than from a green suite, and `PRODUCTION_PROVEN` asks for
 * rows in a project that is somebody's work.
 *
 * And availability never moves at all. A realization that could switch on what
 * it built would be granting itself the one decision §27 reserves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { scanSystem } from '../server/services/selfmodel/scan.ts';
import { applyProof, readProof } from '../server/services/realize/prove.ts';
import {
  derivePacket,
  judgeGap,
  listGaps,
  openPacket,
  setGapState,
} from '../server/services/realize/packet.ts';
import { getFacultyBySlug, listStateEvents, promoteCandidate, putCandidate } from '../server/repos/faculties.ts';
import { applyRealization } from '../server/services/realize/realized.ts';
import { validateFacultyDefinition } from '../server/domain/faculties.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';

function definition(overrides: Record<string, unknown> = {}): ReturnType<typeof validateFacultyDefinition> {
  return validateFacultyDefinition({
    canonicalName: 'Research Intelligence',
    ordinal: 1,
    purpose: 'Determines what Brain needs to learn to support a decision.',
    centralQuestion: 'What must we learn?',
    promisedPower: 'Brain can name the unknown that would change what it does.',
    responsibilities: ['Identify decision-relevant uncertainties.'],
    boundaries: ['Grants no authority.'],
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
    ...overrides,
  } as unknown);
}

async function packetFor(
  overrides: Record<string, unknown> = {},
): Promise<{ packetId: string; facultyId: string }> {
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
    definition: definition(overrides),
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
  return { packetId: packet.id, facultyId: faculty.id };
}

describe('proving a capability', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('leaves everything where it is when nothing has been built', async () => {
    const { packetId } = await packetFor();
    const reading = await readProof(packetId);
    // A freshly-ingested faculty is ABSENT and UNTESTED and stays there.
    expect(reading.moves).toEqual([]);
    expect(await applyProof({ packetId, actorType: 'SYSTEM' })).toMatchObject({ applied: 0 });
  });

  it('reads the implementation from the gaps rather than from a campaign', async () => {
    const { packetId, facultyId } = await packetFor();
    const gaps = await listGaps(packetId, { states: ['OPEN'] });
    const readable = gaps.filter((gap) => gap.kind === 'NEEDS_A_READING').slice(0, 2);
    for (const gap of readable) {
      await judgeGap({
        gapId: gap.id,
        kind: 'MUST_BE_BUILT',
        derivedBy: 'WORKER',
        evidence: 'a reader found no coverage',
      });
    }
    // A campaign on the packet and nothing closed: still ABSENT.
    await getDb().run(`UPDATE realization_packets SET campaign_id = 'fcm_pretend' WHERE id = ?`, [
      packetId,
    ] as never[]);
    expect((await readProof(packetId)).moves).toEqual([]);

    // One of two closed: PARTIAL.
    await setGapState({ gapId: readable[0]?.id as string, state: 'CLOSED', reason: 'integrated' });
    const partial = await readProof(packetId);
    expect(partial.moves).toHaveLength(1);
    expect(partial.moves[0]).toMatchObject({ dimension: 'IMPLEMENTATION', to: 'PARTIAL' });

    await applyProof({ packetId, actorType: 'SYSTEM' });
    expect((await getFacultyBySlug('RESEARCH_INTELLIGENCE'))?.implementationState).toBe('PARTIAL');
    void facultyId;
  });

  it('will not reach LIVE on a build alone, and says what LIVE needs', async () => {
    const { packetId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      if (gap.kind !== 'NEEDS_A_READING') continue;
      await judgeGap({
        gapId: gap.id,
        kind: 'MUST_BE_BUILT',
        derivedBy: 'WORKER',
        evidence: 'a reader found no coverage',
      });
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'integrated' });
    }
    const reading = await readProof(packetId);
    // Everything buildable is closed, so CONNECTED — and no further, because
    // whether anything reaches it is the self-model's answer and it says
    // UNKNOWN for a module.
    expect(reading.moves.find((m) => m.dimension === 'IMPLEMENTATION')).toMatchObject({
      to: 'CONNECTED',
    });
    const withheld = reading.withheld.find((w) => w.dimension === 'IMPLEMENTATION');
    expect(withheld?.needs).toMatch(/LIVE needs:/);
    expect(withheld?.needs).toMatch(/could not be read|not both connected and active/);
  });

  it('will not call a faculty evaluated because code was built', async () => {
    const { packetId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      if (gap.aspect === 'evaluationRequirements') continue;
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'integrated' });
    }
    const reading = await readProof(packetId);
    // Every non-evaluation gap closed and the evaluation requirement still open.
    expect(reading.moves.find((m) => m.dimension === 'EVALUATION')).toBeUndefined();
  });

  it('reaches PASSING only when the faculty’s own requirements are closed', async () => {
    const { packetId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'answered' });
    }
    const reading = await readProof(packetId);
    const evaluation = reading.moves.find((m) => m.dimension === 'EVALUATION');
    expect(evaluation).toMatchObject({ to: 'PASSING' });
    // And not further: production-proven asks for rows in somebody's work.
    const withheld = reading.withheld.find((w) => w.dimension === 'EVALUATION');
    expect(withheld?.needs).toMatch(/PRODUCTION_PROVEN needs:/);
    expect(withheld?.needs).toMatch(/TECHNICAL scope|no campaign/);
  });

  it('will not pass a faculty that declares no evaluation requirements', async () => {
    const { packetId } = await packetFor({ evaluationRequirements: [] });
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'answered' });
    }
    const reading = await readProof(packetId);
    // Calling that PASSING would be passing an exam nobody set.
    expect(reading.moves.find((m) => m.dimension === 'EVALUATION')).toBeUndefined();
  });

  it('never moves availability, and says so rather than staying silent', async () => {
    const { packetId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'answered' });
    }
    const reading = await readProof(packetId);
    expect(reading.moves.some((m) => m.dimension === 'AVAILABILITY')).toBe(false);
    const withheld = reading.withheld.find((w) => w.dimension === 'AVAILABILITY');
    // An absent line reads as "nothing to say about it"; the honest answer is
    // "this is not mine to say".
    expect(withheld?.needs).toMatch(/a person switching it on/);

    await applyProof({ packetId, actorType: 'SYSTEM' });
    expect((await getFacultyBySlug('RESEARCH_INTELLIGENCE'))?.availabilityState).toBe('DISABLED');
  });

  it('never moves the definition, which is the ingestion’s to move', async () => {
    const { packetId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'answered' });
    }
    const reading = await readProof(packetId);
    expect(reading.moves.some((m) => m.dimension === 'DEFINITION')).toBe(false);
  });

  it('records why every move happened, append-only', async () => {
    const { packetId, facultyId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'answered' });
    }
    await applyProof({ packetId, actorType: 'SYSTEM', actorId: 'test' });

    const events = await listStateEvents(facultyId);
    // One for the promotion, plus whatever the proof moved.
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) {
      expect(event.reason.length).toBeGreaterThan(10);
      expect(event.actorType).toBeTruthy();
    }
    // A registry that advanced has, by construction, a row saying why.
    const evaluation = events.find((event) => event.dimension === 'EVALUATION');
    expect(evaluation?.toState).toBe('PASSING');
    expect(evaluation?.reason).toMatch(/evaluation requirement\(s\) are closed/);
  });

  it('is idempotent: a second reading moves nothing', async () => {
    const { packetId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'answered' });
    }
    const first = await applyProof({ packetId, actorType: 'SYSTEM' });
    expect(first.applied).toBeGreaterThan(0);
    const second = await applyProof({ packetId, actorType: 'SYSTEM' });
    expect(second.applied).toBe(0);
  });

  it('closes cleanly', async () => {
    await teardown();
  });
});

describe('the two readers of one column', () => {
  /*
   * `implementationFrom` counts **buildable** gaps closed — how much of what a
   * packet set out to build has been built. `realized.ts` counts every
   * requirement served, closed or waived — how much of the faculty exists.
   * Both are right about their own question and both write
   * `faculties.implementation_state`, so whichever ran last used to decide what
   * the registry said.
   *
   * Production made it visible on the first packet that had both. Research
   * Intelligence: fifteen requirements served by live code, one late-found gap
   * classified MUST_BE_BUILT. `realized` read PARTIAL and the durable tick
   * applied it; `prove` read ABSENT and `--apply` would have put a faculty
   * §40 actually built back to having no implementation at all.
   */
  beforeEach(async () => {
    await freshProject();
  });

  it('will not lower a state a broader reading established', async () => {
    const { packetId, facultyId } = await packetFor();

    // The production shape: everything served except one thing to build.
    const gaps = await listGaps(packetId, { states: ['OPEN'] });
    expect(gaps.length).toBeGreaterThan(1);
    const [toBuild, ...served] = gaps;
    for (const gap of served) {
      await judgeGap({
        gapId: gap.id,
        kind: 'EXISTS_AND_LIVE',
        evidence: 'a live module serves it',
        componentKey: 'SERVICE_MODULE:server/services/research/packetRunner.ts',
        derivedBy: 'PERSON',
      });
    }
    await judgeGap({
      gapId: String(toBuild?.id),
      kind: 'MUST_BE_BUILT',
      evidence: 'nothing produces this output',
      componentKey: null,
      derivedBy: 'PERSON',
    });

    // What the broader reader establishes, and what the tick applies.
    await applyRealization({ packetId, actorType: 'SYSTEM', actorId: 'test' });
    const after = await getFacultyBySlug('RESEARCH_INTELLIGENCE');
    expect(after?.implementationState).toBe('PARTIAL');

    // The narrower reader would say ABSENT. It withholds instead.
    const reading = await readProof(packetId);
    const move = reading.moves.find((one) => one.dimension === 'IMPLEMENTATION');
    expect(move).toBeUndefined();
    const held = reading.withheld.find((one) => one.dimension === 'IMPLEMENTATION');
    expect(held?.needs).toMatch(/never lower/);

    // And applying it changes nothing, which is the half that actually matters.
    await applyProof({ packetId, actorType: 'SYSTEM', actorId: 'test' });
    const stillPartial = await getFacultyBySlug('RESEARCH_INTELLIGENCE');
    expect(stillPartial?.implementationState).toBe('PARTIAL');
  });

  it('still raises, because only the lowering half was wrong', async () => {
    const { packetId } = await packetFor();
    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await judgeGap({
        gapId: gap.id,
        kind: 'MUST_BE_BUILT',
        evidence: 'nothing serves it yet',
        componentKey: null,
        derivedBy: 'PERSON',
      });
    }
    const before = await getFacultyBySlug('RESEARCH_INTELLIGENCE');
    expect(before?.implementationState).toBe('ABSENT');

    for (const gap of await listGaps(packetId, { states: ['OPEN'] })) {
      await setGapState({ gapId: gap.id, state: 'CLOSED', reason: 'the campaign integrated it' });
    }
    const reading = await readProof(packetId);
    const move = reading.moves.find((one) => one.dimension === 'IMPLEMENTATION');
    expect(move?.to).not.toBe('ABSENT');
    expect(['CONNECTED', 'LIVE', 'PARTIAL']).toContain(String(move?.to));
  });
});
