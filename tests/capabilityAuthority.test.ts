/**
 * The answer to a gap no amount of building closes.
 *
 * ---------------------------------------------------------------------------
 * The property this suite exists for
 * ---------------------------------------------------------------------------
 *
 * **An escalation must have an answering transition, and that transition must
 * be guarded rather than absent.** `readiness` refuses a packet while any
 * `REQUIRES_PERSON_AUTHORITY` gap is open, which is right — and for as long as
 * the only callers of `judgeGap` and `setGapState` were tests, the packet
 * stopped at a decision nobody could record. §24 writes that sentence at four
 * altitudes and §27 at a fifth; this is the sixth, and it landed on the single
 * decision the whole kernel waits for.
 *
 * So the assertions here are mostly **refusals**, because the transition is
 * only worth having if it cannot be used as a way around the gate: it answers a
 * gap that is genuinely waiting on a person and no other kind, it needs a real
 * administrator rather than a name, it destroys nothing, and a refusal is
 * recorded as a refusal rather than quietly reading like a grant.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser, listIdentityEvents } from '../server/repos/identity.ts';
import { scanSystem } from '../server/services/selfmodel/scan.ts';
import {
  derivePacket,
  judgeGap,
  listGaps,
  openPacket,
  readiness,
} from '../server/services/realize/packet.ts';
import {
  answerAuthorityGap,
  gapsAwaitingAPerson,
} from '../server/services/realize/authority.ts';
import { promoteCandidate, putCandidate } from '../server/repos/faculties.ts';
import { validateFacultyDefinition } from '../server/domain/faculties.ts';
import type { FacultyDefinition } from '../server/domain/faculties.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';

let adminEmail = '';
let packetId = '';
let authorityGapId = '';

/**
 * A faculty whose requirements include one that names an authority.
 *
 * `gaps.ts` routes a requirement naming permission, authority, approval,
 * consent, a credential or spending to a person *whatever machinery matched
 * it*, so the fixture only has to say the words a real blueprint says.
 */
function definition(): FacultyDefinition {
  return validateFacultyDefinition({
    canonicalName: 'Authority Fixture Intelligence',
    ordinal: 99,
    purpose: 'To exercise the one gap kind that is answered rather than built.',
    centralQuestion: 'Who decides what this may use?',
    promisedPower: 'Brain can say what it is waiting on a person for.',
    responsibilities: ['Hold a requirement that names an authority.'],
    boundaries: ['Grants no authority and performs no external action.'],
    // `namesAnAuthority` reads the requirement's own words, so the fixture only
    // has to say what a real blueprint says. Nothing here declares a kind.
    inputs: ['Explicit permission from a person covering the tools and time this may use.'],
    outputs: ['A reading somebody can check.'],
    activationConditions: ['A decision depends on something unestablished.'],
    reentryConditions: ['New evidence changes what is worth asking.'],
    dependencies: ['The extraction pipeline for reading a stored document.'],
    infrastructure: ['A durable workqueue with leases and fencing.'],
    allowedProposals: ['Belief updates.'],
    invariants: ['Uncertainty must survive the pipeline.'],
    evaluationRequirements: ['A decision reached that could not be reached before.'],
    failureModes: ['Collecting evidence while missing the decisive question.'],
    connections: [],
  } as unknown);
}

async function promoteFixture(): Promise<string> {
  const registered = await registerBlueprint({
    filename: 'map.md',
    contents: Buffer.from(
      '# Map\n\n## 9.9 Authority Fixture Intelligence\n\nA section long enough to extract from.\n',
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

beforeEach(async () => {
  await freshProject();
  adminEmail = `authority-${Date.now()}@example.com`;
  await createUser({
    email: adminEmail,
    displayName: 'The administrator',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  await scanSystem('BOOT');
  const facultyId = await promoteFixture();
  const opened = await openPacket({ facultyId, createdByType: 'SYSTEM' });
  packetId = opened.packet.id;
  await derivePacket(packetId);
  const waiting = await gapsAwaitingAPerson(packetId);
  authorityGapId = waiting[0]?.id ?? '';
});

describe('a gap waiting on a person', () => {
  it('is derived from the requirement rather than from who wrote it', async () => {
    // The fixture never says REQUIRES_PERSON_AUTHORITY; the word "permission"
    // in the requirement is what puts it there.
    const waiting = await gapsAwaitingAPerson(packetId);
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting[0]?.kind).toBe('REQUIRES_PERSON_AUTHORITY');
    expect(waiting[0]?.requirement).toMatch(/permission/i);
  });

  it('holds the packet short of ready until it is answered', async () => {
    const before = await readiness(packetId);
    const condition = before.conditions.find((one) => one.condition === 'no gap is waiting on a person');
    expect(condition?.holds).toBe(false);

    await answerAuthorityGap({
      gapId: authorityGapId,
      answer: 'GRANTED',
      statement: 'Use every connected subscription-backed Routine and compatible worker.',
      answeredByEmail: adminEmail,
    });

    const after = await readiness(packetId);
    const now = after.conditions.find((one) => one.condition === 'no gap is waiting on a person');
    expect(now?.holds).toBe(true);
  });
});

describe('and the answer is guarded rather than taken', () => {
  it('refuses a gap that is not waiting on a person', async () => {
    // The one that matters: a caller that could reclassify any gap could turn a
    // MUST_BE_RESEARCHED into something that needs no research, with somebody
    // else's name on it.
    const others = (await listGaps(packetId)).filter(
      (gap) => gap.kind !== 'REQUIRES_PERSON_AUTHORITY',
    );
    const target = others[0];
    expect(target).toBeDefined();
    const before = target?.kind;

    const outcome = await answerAuthorityGap({
      gapId: target?.id as string,
      answer: 'GRANTED',
      statement: 'Trying to answer something that was never a question for a person.',
      answeredByEmail: adminEmail,
    });

    expect(outcome.answered).toBe(false);
    expect(outcome.reason).toMatch(/not a question for a person/);
    const after = (await listGaps(packetId)).find((gap) => gap.id === target?.id);
    expect(after?.kind).toBe(before);
    expect(after?.state).toBe(target?.state);
  });

  it('refuses a name that is not an enabled administrator', async () => {
    await expect(
      answerAuthorityGap({
        gapId: authorityGapId,
        answer: 'GRANTED',
        statement: 'Signed, somebody.',
        answeredByEmail: 'nobody@example.invalid',
      }),
    ).rejects.toThrow(/no enabled administrator/);

    const ordinary = `ordinary-${Date.now()}@example.com`;
    await createUser({
      email: ordinary,
      displayName: 'An ordinary member',
      password: 'a-long-enough-password',
      isBrainAdmin: false,
    });
    await expect(
      answerAuthorityGap({
        gapId: authorityGapId,
        answer: 'GRANTED',
        statement: 'Signed, a member.',
        answeredByEmail: ordinary,
      }),
    ).rejects.toThrow(/no enabled administrator/);

    // And the gap is exactly where it was.
    expect((await gapsAwaitingAPerson(packetId)).map((gap) => gap.id)).toContain(authorityGapId);
  });

  it('refuses an answer that says nothing', async () => {
    await expect(
      answerAuthorityGap({
        gapId: authorityGapId,
        answer: 'GRANTED',
        statement: '   ',
        answeredByEmail: adminEmail,
      }),
    ).rejects.toThrow(/must say what was decided/);
  });

  it('reports a missing gap rather than inventing one', async () => {
    const outcome = await answerAuthorityGap({
      gapId: 'rgp_does_not_exist',
      answer: 'GRANTED',
      statement: 'Answering nothing.',
      answeredByEmail: adminEmail,
    });
    expect(outcome.answered).toBe(false);
    expect(outcome.reason).toMatch(/No gap with id/);
  });
});

describe('and what it records', () => {
  it('keeps the gap and says who answered it, through which channel', async () => {
    const before = (await listGaps(packetId)).find((gap) => gap.id === authorityGapId);

    await answerAuthorityGap({
      gapId: authorityGapId,
      answer: 'GRANTED',
      statement: 'Keep everything private and project-scoped.',
      answeredByEmail: adminEmail,
      channel: 'SHELL',
      executedByRef: 'a GitHub Actions job',
    });

    const after = (await listGaps(packetId)).find((gap) => gap.id === authorityGapId);
    // Nothing is destroyed: §5 at a row.
    expect(after?.aspect).toBe(before?.aspect);
    expect(after?.requirement).toBe(before?.requirement);
    expect(after?.state).toBe('CLOSED');
    expect(after?.derivedBy).toBe('PERSON');
    expect(after?.stateReason).toMatch(/Authorized by/);
    expect(after?.stateReason).toMatch(/SHELL/);

    const events = await listIdentityEvents({ limit: 20 });
    const recorded = events.find((event) => event.action === 'CAPABILITY_AUTHORITY_ANSWERED');
    expect(recorded).toBeDefined();
    expect(recorded?.targetId).toBe(authorityGapId);
    expect((recorded?.metadata as Record<string, unknown>)['answer']).toBe('GRANTED');
    // Attribution is not authentication, so both columns are there: whose
    // authority, and how the call got in.
    expect((recorded?.metadata as Record<string, unknown>)['authorityChannel']).toBe('SHELL');
    expect((recorded?.metadata as Record<string, unknown>)['executedByRef']).toBe(
      'a GitHub Actions job',
    );
  });

  it('records a refusal as a refusal, which is a different fact from a grant', async () => {
    const outcome = await answerAuthorityGap({
      gapId: authorityGapId,
      answer: 'REFUSED',
      statement: 'Not authorizing this until the boundary is written down.',
      answeredByEmail: adminEmail,
    });

    expect(outcome.answered).toBe(true);
    const after = (await listGaps(packetId)).find((gap) => gap.id === authorityGapId);
    expect(after?.state).toBe('WAIVED');
    expect(after?.stateReason).toMatch(/Refused by/);
    // It stops holding the packet, because the question has been answered — and
    // it reads as a refusal, so nothing downstream can mistake it for a grant.
    expect(after?.stateReason).not.toMatch(/Authorized by/);
  });

  it('is idempotent by its effect rather than by a flag', async () => {
    const first = await answerAuthorityGap({
      gapId: authorityGapId,
      answer: 'GRANTED',
      statement: 'The first answer.',
      answeredByEmail: adminEmail,
    });
    expect(first.answered).toBe(true);

    // A second call with a different answer must not overwrite the first: the
    // gap is no longer OPEN, so the guarded UPDATE matches nothing.
    const second = await answerAuthorityGap({
      gapId: authorityGapId,
      answer: 'REFUSED',
      statement: 'A second, contradictory answer.',
      answeredByEmail: adminEmail,
    });
    expect(second.answered).toBe(false);
    expect(second.reason).toMatch(/already CLOSED/);

    const after = (await listGaps(packetId)).find((gap) => gap.id === authorityGapId);
    expect(after?.state).toBe('CLOSED');
    expect(after?.stateReason).toMatch(/The first answer/);
  });

  it('is not undone by re-deriving the packet', async () => {
    await answerAuthorityGap({
      gapId: authorityGapId,
      answer: 'GRANTED',
      statement: 'Authorized, and it should survive a re-derivation.',
      answeredByEmail: adminEmail,
    });

    await derivePacket(packetId);

    const after = (await listGaps(packetId)).find((gap) => gap.id === authorityGapId);
    expect(after?.state).toBe('CLOSED');
    expect(after?.derivedBy).toBe('PERSON');
  });
});

describe('and it grants nothing', () => {
  it('leaves every gap that still needs building exactly where it was', async () => {
    const before = await listGaps(packetId);
    await answerAuthorityGap({
      gapId: authorityGapId,
      answer: 'GRANTED',
      statement: 'Authorized.',
      answeredByEmail: adminEmail,
    });
    const after = await listGaps(packetId);

    // Answering an authority makes a packet compilable. It does not classify,
    // close, waive or judge anything else — a grant that quietly satisfied the
    // other requirements would be the gate answering itself.
    for (const gap of before) {
      if (gap.id === authorityGapId) continue;
      const now = after.find((one) => one.id === gap.id);
      expect(now?.kind).toBe(gap.kind);
      expect(now?.state).toBe(gap.state);
      expect(now?.derivedBy).toBe(gap.derivedBy);
    }
  });

  it('cannot be used to close a gap a reader had judged', async () => {
    const readings = await listGaps(packetId, { kinds: ['NEEDS_A_READING'] });
    const gap = readings[0];
    if (!gap) return;
    await judgeGap({
      gapId: gap.id,
      kind: 'MUST_BE_BUILT',
      derivedBy: 'WORKER',
      evidence: 'A reader compared it against the module and found no coverage.',
    });

    const outcome = await answerAuthorityGap({
      gapId: gap.id,
      answer: 'GRANTED',
      statement: 'Authorizing my way past the building.',
      answeredByEmail: adminEmail,
    });
    expect(outcome.answered).toBe(false);
    const after = (await listGaps(packetId)).find((one) => one.id === gap.id);
    expect(after?.kind).toBe('MUST_BE_BUILT');
    expect(after?.state).toBe(gap.state);
  });
});

teardown();
