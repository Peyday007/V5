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
import fs from 'node:fs';
import path from 'node:path';
import { freshProject, teardown } from './helpers.ts';
import { getHumanRequest, answerHumanRequest } from '../server/repos/russellMissions.ts';
import type { RussellHumanRequest } from '../server/domain/types.ts';
import { createUser } from '../server/repos/identity.ts';
import { reopenAnswered, resumeAnsweredRequest } from '../server/services/russell/needsHuman.ts';
import { getDb } from '../server/db/database.ts';
import {
  advanceCapabilityPackets,
  authorityResumeKey,
  CAPABILITY_AUTHORITY_CHOICES,
} from '../server/services/realize/advance.ts';
import {
  advance as advancePacket,
  derivePacket,
  facultiesWithoutPackets,
  judgeGap,
  listGaps,
  listPackets,
  openPacket,
  setGapState,
} from '../server/services/realize/packet.ts';
import { getFaculty, moveDimension, promoteCandidate, putCandidate } from '../server/repos/faculties.ts';
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

  /*
   * The whole point, and the half that nothing else in this file asserts.
   *
   * Raising a card is easy; §24's defect is a person *answering* one and
   * nothing happening — the mission flipped back to RUNNING while the packet
   * underneath stayed exactly where it was, so the same question could be
   * answered every day and the decision recorded and ignored. Here it would be
   * worse than that: `resumeAnsweredRequest` returns `settled: true` for any
   * request with no mission — *"the request was not about a mission"* — so the
   * card would be marked RESUMED having carried nothing out, vanish, and be
   * raised again identically on the next tick.
   *
   * So this walks it: the tick raises the card, a person answers it through
   * the same repository call `POST /api/russell/needs-you/:id/answer` makes,
   * the tick's own resume runs, and the *gap* is what is asserted on.
   */
  it('closes the gap when a person answers the card, rather than only closing the card', async () => {
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
    if (!person) throw new Error('the fixture produced no person-owned gap');
    const request = await cardFor(person.id);

    const administrator = await anAdministrator();
    const answered = await answerHumanRequest({
      requestId: request.id,
      actorUserId: administrator.id,
      choice: 'GRANT_AUTHORITY',
      reason: 'Authorized: read published sources only, and spend nothing.',
    });
    expect(answered.ok).toBe(true);

    const resumed = await resumeAnsweredRequest(answered.request!);
    expect(resumed.ok).toBe(true);

    const closed = (await listGaps(packet.id)).find((gap) => gap.id === person.id);
    expect(closed?.state).toBe('CLOSED');
    // And the sentence says who, through what, in their own words — because a
    // gap closed with no statement records that somebody pressed something.
    expect(closed?.stateReason).toContain(administrator.email);
    expect(closed?.stateReason).toContain('spend nothing');
    // Attribution, not authentication: a browser answer is BROWSER, and the
    // weaker value is what a shell gets. §23's column pair.
    expect(closed?.stateReason).toContain('BROWSER');
    expect(closed?.derivedBy).toBe('PERSON');
  });

  /*
   * The other answer, which must not read the same as the first. A refusal is
   * WAIVED with the refusal recorded, so the packet correctly stays short of
   * whatever that requirement was load-bearing for.
   */
  it('records a refusal as a refusal, never as a grant', async () => {
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
    if (!person) throw new Error('the fixture produced no person-owned gap');
    const request = await cardFor(person.id);

    const administrator = await anAdministrator();
    const answered = await answerHumanRequest({
      requestId: request.id,
      actorUserId: administrator.id,
      choice: 'REFUSE_AUTHORITY',
      reason: 'Not while this is unreviewed.',
    });
    await resumeAnsweredRequest(answered.request!);

    const after = (await listGaps(packet.id)).find((gap) => gap.id === person.id);
    expect(after?.state).toBe('WAIVED');
    expect(after?.state).not.toBe('CLOSED');
    expect(after?.stateReason).toContain('Refused by');
  });

  /*
   * An answer that cannot be carried out goes back in front of the person, and
   * it has to go back as the card it was.
   *
   * `answerAuthorityGap` resolves an **enabled Brain administrator** against
   * `users` at the moment the effect happens — authority read per request
   * rather than baked into the card when it was written. So an ordinary member
   * with write access to the project can press the button and the transition
   * will refuse, which is correct and is exactly the case `reopenAnswered`
   * exists for.
   *
   * What it must not do is come back as a *different* card. Everything in that
   * function derives the offer and the words from a packet's shape, and a
   * capability question has no packet: `packetShape` of nothing is `{0, 0, 0}`,
   * `choicesFor` of that is `[STOP]`, and `stopWords` writes about an evidence
   * bar and a repair ladder. The person would have been offered to stop a
   * mission that never existed, under an explanation of a research failure that
   * never happened.
   *
   * Newly reachable rather than newly wrong: until the capability branch
   * started returning a real failure, `resumeAnsweredRequest` answered
   * `settled: true` for everything with no mission and nothing ever arrived
   * there.
   */
  it('puts an answer it could not carry out back as the card it was', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await advanceCapabilityPackets();

    const gap = (await listGaps(packet.id)).find(
      (row) => row.kind === 'REQUIRES_PERSON_AUTHORITY',
    );
    if (!gap) throw new Error('the fixture produced no person-owned gap');
    const request = await cardFor(gap.id);

    // Somebody who may read the project and is not an administrator of this
    // Brain. The route would let them press it; the transition will not.
    const member = await createUser({
      email: `capability-tick-member-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Member',
      password: 'correct horse battery staple',
    });
    const answered = await answerHumanRequest({
      requestId: request.id,
      actorUserId: member.id,
      choice: 'GRANT_AUTHORITY',
      reason: 'I think this is fine.',
    });
    expect(answered.ok).toBe(true);

    const resumed = await resumeAnsweredRequest(answered.request!);
    expect(resumed.settled).toBe(false);
    expect(resumed.reason).toContain('administrator');

    // What the tick does with an unsettled answer.
    expect(await reopenAnswered(answered.request!, resumed.reason)).toBe(true);

    const back = await getHumanRequest(request.id);
    expect(back?.state).toBe('OPEN');
    // Its own offer, not a packet's.
    expect(back?.choices.map((choice) => choice.key).sort()).toEqual([
      'GRANT_AUTHORITY',
      'REFUSE_AUTHORITY',
    ]);
    // Its own words, not a packet's.
    expect(back?.authorityNeeded).toBe(request.authorityNeeded);
    expect(back?.whyNotRussell).toBe(request.whyNotRussell);
    expect(back?.whyNotRussell).not.toContain('repair ladder');
    // And the reason it came back.
    expect(back?.recommendation).toContain('administrator');

    // The gap is untouched: a refused answer closes nothing.
    const still = (await listGaps(packet.id)).find((row) => row.id === gap.id);
    expect(still?.state).toBe('OPEN');
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

  /*
   * A tick runs every thirty seconds for the life of a process, and a restart
   * re-enters the same pass over the same rows. So the pass has to be
   * idempotent by its own effects rather than by a cursor or a flag — a flag
   * can be set by a tick that then dies, and a cursor is a second place for
   * the truth to live.
   *
   * Asserted on the append-only rows, because those are what a duplicate would
   * be visible in: a dimension move that recorded "already LIVE" every thirty
   * seconds would bury the one that mattered under ten thousand that did not.
   */
  it('runs again over the same rows without duplicating anything', async () => {
    const facultyId = await promoteFaculty(definition());
    const { packet } = await openPacket({
      facultyId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });

    await advanceCapabilityPackets();
    const first = await appendOnlyCounts(packet.id);

    // Three more passes, which is what a restart plus two ticks looks like.
    await advanceCapabilityPackets();
    await advanceCapabilityPackets();
    await advanceCapabilityPackets();
    const after = await appendOnlyCounts(packet.id);

    expect(after).toEqual(first);
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
    const tick = fs.readFileSync('server/services/realize/advance.ts', 'utf8');
    const cli = fs.readFileSync('scripts/capability.ts', 'utf8');
    for (const shared of ['derivePacket', 'readiness', 'askTheWorld', 'applyRealization', 'handOff']) {
      expect(tick).toContain(shared);
      expect(cli).toContain(shared);
    }
    // And it holds no approval of its own.
    const imports = tick.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
    expect(imports.join('\n')).not.toContain('approveAndStartCampaign');
    expect(imports.join('\n')).not.toContain('factory/start.ts');
  });

  /*
   * The assertion this whole module exists for, and the one no behavioural
   * test can make: that something *calls* it. §37 records four transitions
   * that existed, were tested, and were reached by nothing, and every one of
   * them passed its own suite throughout.
   */
  it('is reached by the durable tick, and reports what it moved', () => {
    const loop = fs.readFileSync(
      path.join(process.cwd(), 'server/services/russell/loop.ts'),
      'utf8',
    );
    expect(loop).toContain("from '../realize/advance.ts'");
    expect(loop).toContain('await advanceCapabilityPackets(');
    // Reported rather than silent: a tick that advanced a packet and said
    // nothing is one nobody can tell from a tick that did not.
    expect(loop).toMatch(/report\.capability\.packets\.considered/);
    expect(loop).toMatch(/report\.capability\.packets\.changeRequests/);
  });

  /*
   * And that it cannot take the tick down with it. A reading *about* Brain is
   * never a precondition of Brain: the writeback, the request resumption and
   * every other project's work run on this same tick, and a packet that could
   * not be walked must cost them nothing.
   */
  it('cannot stop the tick when a packet cannot be walked', () => {
    const loop = fs.readFileSync(
      path.join(process.cwd(), 'server/services/russell/loop.ts'),
      'utf8',
    );
    const call = loop.indexOf('await advanceCapabilityPackets(');
    expect(call).toBeGreaterThan(-1);
    // The nearest `try {` before the call, and a `catch` after it: the call is
    // inside a guard rather than beside one.
    const guard = loop.lastIndexOf('try {', call);
    expect(guard).toBeGreaterThan(-1);
    expect(loop.slice(guard, call)).not.toContain('catch');
    expect(loop.slice(call, call + 900)).toContain('catch');
  });
});

/**
 * The seventh command, which stood in front of the six.
 *
 * `advance.ts` exists because running the chain was six invocations in the
 * right order. It could not run at all until somebody typed a seventh —
 * `packet open <slug>` — because nothing opened a packet for a faculty that
 * had just become canonical. Two functions had already been written for the
 * caller they never got: `openPacket`, whose comment says idempotency is
 * "what makes this safe to call from a tick", and `facultiesWithoutPackets`,
 * whose comment says it exists "so a tick can see what has not been started".
 *
 * The refusals below matter more than the advance. An opener that ranked
 * faculties, opened all fourteen at once, or reopened an abandoned packet on a
 * timer would each be worse than the command it replaces.
 */
describe('opening the packet the chain has reached', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('opens one for a canonical faculty nobody opened, without a command', async () => {
    const facultyId = await promoteFaculty(definition());
    expect(await listPackets()).toHaveLength(0);

    const report = await advanceCapabilityPackets();

    expect(report.opened).not.toBeNull();
    expect(report.opened?.facultySlug).toBe('RESEARCH_INTELLIGENCE');
    const packets = await listPackets();
    expect(packets).toHaveLength(1);
    expect(packets[0]?.facultyId).toBe(facultyId);
    expect(report.failed).toHaveLength(0);

    // The author is recorded as the tick rather than as a person, because a
    // row that cannot say who opened it answers nothing later.
    const rows = await getDb().all<{ created_by_type: string }>(
      'SELECT created_by_type FROM realization_packets WHERE id = ?',
      [packets[0]!.id] as never[],
    );
    expect(rows[0]?.created_by_type).toBe('TICK');
  });

  it('walks the same pass it opened, so a new packet is not idle for a tick', async () => {
    await promoteFaculty(definition());
    const report = await advanceCapabilityPackets();

    const opened = report.opened?.packetId;
    if (!opened) throw new Error('nothing was opened');
    // Opened and then considered in the one pass: the gaps exist already.
    expect(report.advances.some((advance) => advance.packetId === opened)).toBe(true);
    expect((await listGaps(opened)).length).toBeGreaterThan(0);
  });

  it('takes the blueprint’s own order rather than one it chose', async () => {
    // Promoted out of order on purpose: the opener must read `ordinal`, which
    // is the document's numbering, and not creation order or the slug.
    await promoteFaculty(
      definition({ canonicalName: 'Simulation and Modeling Intelligence', ordinal: 2 }),
    );
    await promoteFaculty(definition({ canonicalName: 'Research Intelligence', ordinal: 1 }));

    const first = await advanceCapabilityPackets();
    expect(first.opened?.facultySlug).toBe('RESEARCH_INTELLIGENCE');
  });

  it('opens one per pass, which is a rate rather than a ceiling nothing releases', async () => {
    await promoteFaculty(definition({ canonicalName: 'Research Intelligence', ordinal: 1 }));
    await promoteFaculty(
      definition({ canonicalName: 'Simulation and Modeling Intelligence', ordinal: 2 }),
    );

    const first = await advanceCapabilityPackets();
    expect(first.opened?.facultySlug).toBe('RESEARCH_INTELLIGENCE');
    expect(await listPackets()).toHaveLength(1);

    /*
     * The second one arrives on the next pass with nothing released in
     * between. A concurrency ceiling would have withheld it for ever, because
     * nothing in `server/` writes a terminal packet state — `advance` in
     * `packet.ts` has no production caller, so every packet is DRAFT always.
     * That is the trap this rate exists to avoid, and the assertion is that
     * the first packet is still live when the second opens.
     */
    const second = await advanceCapabilityPackets();
    expect(second.opened?.facultySlug).toBe('SIMULATION_AND_MODELING_INTELLIGENCE');
    const packets = await listPackets();
    expect(packets).toHaveLength(2);
    expect(packets.every((packet) => packet.state === 'DRAFT')).toBe(true);
  });

  it('never opens a second packet for a faculty that already has one', async () => {
    await promoteFaculty(definition());

    await advanceCapabilityPackets();
    await advanceCapabilityPackets();
    await advanceCapabilityPackets();

    expect(await listPackets()).toHaveLength(1);
  });

  it('never reopens a faculty whose packet went terminal, which a live packet cannot pin', async () => {
    await promoteFaculty(definition());
    const first = await advanceCapabilityPackets();
    const opened = first.opened?.packetId;
    if (!opened) throw new Error('nothing was opened');

    /*
     * `facultiesWithoutPackets` asks for faculties with no *live* packet, so
     * while every packet is DRAFT the skip that stops a second one is
     * redundant and no assertion above can reach it. Moving this one to
     * ABANDONED through `packet.ts`'s own compare-and-swap — the transition
     * that exists and has no production caller — is what makes the faculty a
     * candidate again, and therefore what makes the guard the only thing
     * standing between a timer and a fresh packet every tick.
     */
    expect(await advancePacket({ id: opened, from: 'DRAFT', to: 'ABANDONED' })).toBe(true);
    expect(await facultiesWithoutPackets()).toHaveLength(1);

    const again = await advanceCapabilityPackets();
    expect(again.opened).toBeNull();
    expect(await listPackets()).toHaveLength(1);
    expect(again.notOpenedBecause).toContain('terminal');
  });

  it('says why it opened nothing, rather than reporting an empty pass', async () => {
    await promoteFaculty(definition());
    await advanceCapabilityPackets();

    const again = await advanceCapabilityPackets();
    expect(again.opened).toBeNull();
    expect(again.notOpenedBecause).not.toBe('');
  });

  it('refuses a faculty whose definition is not canonical', async () => {
    const facultyId = await promoteFaculty(definition());
    await moveDimension({
      facultyId,
      dimension: 'DEFINITION',
      to: 'DRAFT',
      reason: 'the reading was reopened, so the definition is no longer canonical',
      actorType: 'SYSTEM',
      actorId: 'test',
    });

    const report = await advanceCapabilityPackets();

    // A packet planned against a draft holds the system against a definition
    // nobody audited, so there is nothing to open and nothing to walk.
    expect(report.opened).toBeNull();
    expect(await listPackets()).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
  });

  it('opens nothing at all against an empty registry, and does not throw', async () => {
    const report = await advanceCapabilityPackets();
    expect(report.opened).toBeNull();
    expect(report.considered).toBe(0);
    expect(report.failed).toHaveLength(0);
  });

  it('approves nothing, spends nothing and starts nothing by opening one', async () => {
    await promoteFaculty(definition());
    const before = await counts();

    const report = await advanceCapabilityPackets();
    expect(report.opened).not.toBeNull();

    const after = await counts();
    expect(after.missions).toBe(before.missions);
    expect(after.goals).toBe(before.goals);
    expect(after.orchestrations).toBe(before.orchestrations);
    expect(after.approvedRequests).toBe(before.approvedRequests);
  });

  it('asks the shared reader rather than a second copy of the same question', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'server/services/realize/advance.ts'),
      'utf8',
    );
    // Two readers of "which faculties have not been started" disagree
    // eventually, which is the rule this repository has had to write four
    // times. The opener must call the one in `packet.ts` and must not rebuild
    // the canonical filter beside it.
    expect(source).toContain('facultiesWithoutPackets');
    expect(source).not.toContain("definitionState !== 'CANONICAL'");
  });

  it('cannot take the tick down when opening one throws', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'server/services/realize/advance.ts'),
      'utf8',
    );
    const call = source.slice(
      source.indexOf('const opening = await openNextPacket()') - 400,
      source.indexOf('const opening = await openNextPacket()') + 400,
    );
    expect(call).toContain('try {');
    expect(call).toContain('catch');
  });
});

/** The card the tick raised for this gap, through the same reader the route uses. */
async function cardFor(gapId: string): Promise<RussellHumanRequest> {
  const rows = await getDb().all<{ id: string }>(
    'SELECT id FROM russell_human_requests WHERE resume_key = ?',
    [authorityResumeKey(gapId)] as never[],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('the card was not raised');
  const request = await getHumanRequest(id);
  if (!request) throw new Error('the card disappeared');
  return request;
}

/**
 * An enabled Brain administrator, because `answerAuthorityGap` resolves one
 * against `users` rather than trusting a name on a call. Created per test, so
 * the email in the recorded sentence is this test's own.
 */
async function anAdministrator(): Promise<{ id: string; email: string }> {
  const email = `capability-tick-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const user = await createUser({
    email,
    displayName: 'Administrator',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  return { id: user.id, email };
}

/**
 * The rows a duplicate would show up in: the cards, the dimension history and
 * the gaps themselves.
 */
async function appendOnlyCounts(
  packetId: string,
): Promise<{ cards: number; stateEvents: number; gaps: number; ideas: number }> {
  const one = async (sql: string, params: unknown[] = []): Promise<number> => {
    const rows = await getDb().all<{ n: number }>(sql, params as never[]);
    return Number(rows[0]?.n ?? 0);
  };
  return {
    cards: await one('SELECT COUNT(*) AS n FROM russell_human_requests'),
    stateEvents: await one('SELECT COUNT(*) AS n FROM faculty_state_events'),
    gaps: await one('SELECT COUNT(*) AS n FROM realization_gaps WHERE packet_id = ?', [packetId]),
    // `askTheWorld` is idempotent because it moves a gap it captured to
    // ASSIGNED and the director reads only OPEN ones — which is a comment in
    // that file rather than something anything here held it to, until now.
    ideas: await one('SELECT COUNT(*) AS n FROM russell_candidates'),
  };
}

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
