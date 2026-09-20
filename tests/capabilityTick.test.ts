/**
 * The kernel advancing on the tick that already runs, rather than on a runbook.
 *
 * ---------------------------------------------------------------------------
 * What this suite is for
 * ---------------------------------------------------------------------------
 *
 * `advanceSources` reached the tick and stopped at the registry: a blueprint
 * became a canonical definition unattended, and everything after it waited for
 * somebody to run six CLI commands in the right order. The properties below are
 * the ones that make the automatic path the *same* path rather than a second
 * one, and the refusals are asserted at least as carefully as the advances —
 * an autonomous walk that approved, spent or guessed would be worse than the
 * runbook it replaces.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  advanceCapabilityPackets,
  authorityResumeKey,
  CAPABILITY_AUTHORITY_CHOICES,
} from '../server/services/realize/advance.ts';
import { derivePacket, judgeGap, listGaps, openPacket, setGapState } from '../server/services/realize/packet.ts';
import { getFaculty, promoteCandidate, putCandidate } from '../server/repos/faculties.ts';
import { validateFacultyDefinition, type FacultyDefinition } from '../server/domain/faculties.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';
import { readRealization } from '../server/services/realize/realized.ts';

function definition(overrides: Partial<FacultyDefinition> = {}): FacultyDefinition {
  return validateFacultyDefinition({
    canonicalName: 'Research Intelligence',
    ordinal: 1,
    purpose: 'Determines what Brain needs to learn to support a decision.',
    centralQuestion: 'What must we learn, and when do we know enough?',
    promisedPower: 'Brain can say what it does not know that would change what it does.',
    responsibilities: ['Identify decision-relevant uncertainties.'],
    boundaries: ['Grants no authority and performs no external action.'],
    inputs: ['Permission and privacy boundaries.'],
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

describe('the kernel advancing on the tick', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('derives a packet that has no gaps, without anybody running a command', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    expect(await listGaps(packet.id)).toHaveLength(0);

    const report = await advanceCapabilityPackets();
    expect(report.considered).toBeGreaterThan(0);
    expect((await listGaps(packet.id)).length).toBeGreaterThan(0);
    expect(report.failed).toHaveLength(0);
  });

  it('never re-derives over a reader, because a judgement is not overwritten on a timer', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await advanceCapabilityPackets();

    const first = (await listGaps(packet.id))[0];
    if (!first) throw new Error('the derivation produced no gaps');
    await judgeGap({
      gapId: first.id,
      kind: 'MUST_BE_BUILT',
      evidence: 'A reader compared the requirement against the component.',
      derivedBy: 'PERSON',
    });

    await advanceCapabilityPackets();
    const after = (await listGaps(packet.id)).find((gap) => gap.id === first.id);
    // A re-derivation would have replaced this with NEEDS_A_READING and made
    // the chain unfinishable: every tick would undo the last reading.
    expect(after?.kind).toBe('MUST_BE_BUILT');
    expect(after?.derivedBy).toBe('PERSON');
  });

  it('raises a person-owned gap on the decision surface that already exists, once', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await advanceCapabilityPackets();

    const person = (await listGaps(packet.id)).find(
      (gap) => gap.kind === 'REQUIRES_PERSON_AUTHORITY',
    );
    // The fixture names "Permission and privacy boundaries" as an input, which
    // `gaps.ts` routes to a person whatever machinery matched it.
    if (!person) throw new Error('the fixture produced no person-owned gap');

    const rows = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_human_requests WHERE resume_key = ?`,
      [authorityResumeKey(person.id)] as never[],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(1);

    // Idempotent by resume_key: a restart mid-pass raises one card, not a queue.
    await advanceCapabilityPackets();
    const again = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_human_requests WHERE resume_key = ?`,
      [authorityResumeKey(person.id)] as never[],
    );
    expect(Number(again[0]?.n ?? 0)).toBe(1);
  });

  it('offers a refusal as well as a grant, because a card with one answer is not a decision', () => {
    const keys = CAPABILITY_AUTHORITY_CHOICES.map((choice) => choice.key);
    expect(keys).toContain('GRANT_AUTHORITY');
    expect(keys).toContain('REFUSE_AUTHORITY');
    for (const choice of CAPABILITY_AUTHORITY_CHOICES) {
      expect(choice.consequence.length).toBeGreaterThan(20);
    }
  });

  it('never reads a waived requirement as implemented', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await derivePacket(packet.id);
    for (const gap of await listGaps(packet.id)) {
      await setGapState({
        gapId: gap.id,
        state: 'WAIVED',
        reason: "Owned by another faculty's packet.",
      });
    }

    await advanceCapabilityPackets();
    const faculty = await getFaculty(facultyId);
    // A waiver says another packet owns the requirement. That is the opposite
    // of a reading that this faculty runs, and LIVE is the most expensive
    // available direction to be wrong in.
    expect(faculty?.implementationState).not.toBe('LIVE');
    expect(faculty?.implementationState).toBe('ABSENT');

    const reading = await readRealization(packet.id);
    expect(reading.readings.find((row) => row.dimension === 'IMPLEMENTATION')?.to).toBeNull();
  });

  it('approves nothing and spends nothing on its own', async () => {
    const facultyId = await promoteFaculty(definition());
    await openPacket({ facultyId, createdByType: 'SYSTEM', createdById: 'test' });

    const before = await counts();
    await advanceCapabilityPackets();
    const after = await counts();

    // A capability packet is Brain reasoning about Brain. It may ask; only a
    // person may approve the objective or authorise the spending.
    expect(after.missions).toBe(before.missions);
    expect(after.goals).toBe(before.goals);
    expect(after.orchestrations).toBe(before.orchestrations);
    expect(after.approvedRequests).toBe(before.approvedRequests);
  });

  it('shares its transitions with the CLI rather than reimplementing them', () => {
    // The property is that both reach the same functions. Asserted against the
    // import statements, because a second implementation is exactly the thing
    // that would pass a behavioural test and drift a month later.
    const tick = readFileSync('server/services/realize/advance.ts', 'utf8');
    const cli = readFileSync('scripts/capability.ts', 'utf8');
    for (const shared of ['derivePacket', 'readiness', 'askTheWorld', 'applyRealization', 'handOff']) {
      expect(tick).toContain(shared);
      expect(cli).toContain(shared);
    }
    // And it holds no approval of its own.
    const imports = tick.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
    expect(imports.join('\n')).not.toContain('approveAndStartCampaign');
    expect(imports.join('\n')).not.toContain('factory/start.ts');
  });
});

async function counts(): Promise<{
  missions: number;
  goals: number;
  orchestrations: number;
  approvedRequests: number;
}> {
  const one = async (sql: string): Promise<number> => {
    const rows = await getDb().all<{ n: number }>(sql);
    return Number(rows[0]?.n ?? 0);
  };
  return {
    missions: await one('SELECT COUNT(*) AS n FROM russell_missions'),
    goals: await one('SELECT COUNT(*) AS n FROM russell_goals'),
    orchestrations: await one('SELECT COUNT(*) AS n FROM research_orchestrations'),
    approvedRequests: await one(
      "SELECT COUNT(*) AS n FROM factory_change_requests WHERE state = 'APPROVED'",
    ),
  };
}
