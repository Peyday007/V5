/**
 * Every account gets an even mix of every kind of job, and no two hold the same one.
 *
 * And what a person adds to a running sprint's objective reaches discovery
 * without replacing the mandate it was activated with.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createJob, listJobs } from '../server/repos/cashJobs.ts';
import { getCashMode, cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { activate, setConstraints, CONSTRAINTS_SET_EVENT } from '../server/services/cash/lifecycle.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { JOB_DEALT_EVENT, reconcileCashJobs } from '../server/services/cash/jobPipeline.ts';
import { chooseHolder } from '../server/services/cash/deal.ts';
import { CANONICAL_CASH_OBJECTIVE, objectiveWith, splitObjective } from '../server/services/cash/root.ts';
import { questionFor, SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import type { CashMechanism } from '../server/domain/types.ts';

let projectId = '';
let ownerId = '';

async function person(name: string): Promise<string> {
  const user = await createUser({
    email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: `${name} ${Math.random().toString(36).slice(2, 6)}`,
    password: 'correct horse battery staple',
  });
  return user.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  ownerId = await person('Owner');
  expect(
    (await activate({ projectId, ownerUserId: ownerId, actorUserId: ownerId, objective: objectiveWith('') })).ok,
  ).toBe(true);
});

async function qualified(mechanism: CashMechanism, title: string): Promise<string> {
  const captured = await capture({ projectId, actorRef: ownerId, ownerUserId: ownerId, title, mechanism, currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: ownerId,
    patch: {
      payer: 'A business owner',
      reachableChannel: 'owner@business.example',
      buyingSignal: 'Asked publicly for a quote',
      signalObservedAt: '2026-10-15T09:00:00.000Z',
      offerScope: `One fixed-scope job: ${title}`,
      acceptanceCondition: 'The owner confirms receipt',
      priceCents: 50_000,
      deliveryMethod: 'Delivered by email',
      fulfillmentOwner: 'Brain',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({
      projectId,
      opportunityId: captured.value.id,
      field,
      kind: 'PERSON',
      value: `Answer to ${field}.`,
      decidedBy: ownerId,
    });
  }
  return captured.value.id;
}

describe('the dealer, as a pure decision', () => {
  it('gives the next job of a kind to whoever holds fewest of that kind, then fewest in all', () => {
    const seats = ['a', 'b', 'c', 'd'];
    const jobs = [
      { ownerUserId: 'a', mechanism: 'X' },
      { ownerUserId: 'b', mechanism: 'X' },
      { ownerUserId: 'c', mechanism: 'Y' },
    ];
    // c and d hold no X; d holds fewer in all.
    expect(chooseHolder('X', seats, jobs)!.userId).toBe('d');
    // Nobody holds Z; d holds fewest in all.
    expect(chooseHolder('Z', seats, jobs)!.userId).toBe('d');
    expect(chooseHolder('X', [], jobs)).toBeNull();
  });

  it('is the same answer on every call when everybody is level', () => {
    const one = chooseHolder('X', ['d', 'b', 'a', 'c'], []);
    const two = chooseHolder('X', ['a', 'b', 'c', 'd'], []);
    expect(one!.userId).toBe('a');
    expect(two!.userId).toBe('a');
    expect(one!.because).toContain('in turn');
  });
});

describe('four people get an even mix', () => {
  it('deals four jobs of one kind one each, and no two hold the same job', async () => {
    const others = [await person('Airyn'), await person('Caleb'), await person('Dee')];
    const everyone = [ownerId, ...others].sort();
    for (let i = 0; i < 4; i += 1) await qualified('EXPLICIT_PAID_REQUEST', `Lead job ${i}`);
    for (let i = 0; i < 4; i += 1) await qualified('SUPPLY_DEMAND_MISMATCH', `Distribution job ${i}`);

    const pass = await reconcileCashJobs(projectId);
    expect(pass.created).toHaveLength(8);
    expect(pass.dealt).toHaveLength(8);

    const jobs = (await listJobs(projectId)).filter((job) => job.state !== 'RELEASED');
    expect(new Set(jobs.map((job) => job.opportunityId)).size).toBe(8);
    const byPerson = new Map<string, number>();
    for (const job of jobs) byPerson.set(job.ownerUserId!, (byPerson.get(job.ownerUserId!) ?? 0) + 1);
    expect([...byPerson.keys()].sort()).toEqual(everyone);
    expect([...byPerson.values()]).toEqual([2, 2, 2, 2]);

    // A second pass moves nothing: dealing converges.
    const again = await reconcileCashJobs(projectId);
    expect(again.dealt).toHaveLength(0);
  });

  it('re-deals prepared jobs that one person held before anybody else joined', async () => {
    for (let i = 0; i < 4; i += 1) await qualified('EXPLICIT_PAID_REQUEST', `Early job ${i}`);
    // Only the owner has joined: every job is theirs.
    await reconcileCashJobs(projectId);
    expect(new Set((await listJobs(projectId)).map((job) => job.ownerUserId))).toEqual(new Set([ownerId]));

    await person('Airyn');
    await person('Caleb');
    await person('Dee');
    const pass = await reconcileCashJobs(projectId);
    expect(pass.dealt.length).toBeGreaterThan(0);
    const owners = (await listJobs(projectId)).map((job) => job.ownerUserId);
    expect(new Set(owners).size).toBe(4);
    const events = await cashEventsOfKindInProject(projectId, JOB_DEALT_EVENT);
    expect(events.some((event) => event.detail['from'] === ownerId)).toBe(true);
  });

  it('leaves a job a person placed somewhere else exactly where it is', async () => {
    const airyn = await person('Airyn');
    await person('Caleb');
    const id = await qualified('EXPLICIT_PAID_REQUEST', 'Placed by hand');
    // A job prepared by somebody, not by Brain, is never moved.
    await createJob({ opportunityId: id, projectId, currency: 'USD', ownerUserId: airyn, createdBy: ownerId });
    for (let i = 0; i < 3; i += 1) await qualified('EXPLICIT_PAID_REQUEST', `More ${i}`);
    await reconcileCashJobs(projectId);
    const held = (await listJobs(projectId)).find((job) => job.opportunityId === id)!;
    expect(held.ownerUserId).toBe(airyn);
  });
});

describe('operator additions on a running sprint', () => {
  it('keeps the mandate, records the change, and reaches the next discovery question', async () => {
    const before = (await getCashMode(projectId))!.objective;
    expect(splitObjective(before)).toEqual({ base: CANONICAL_CASH_OBJECTIVE, constraints: '' });

    const set = await setConstraints({
      projectId,
      actorUserId: ownerId,
      constraints: 'Do not target Detroit or Cleveland.',
    });
    expect(set.ok && set.changed).toBe(true);
    const mode = (await getCashMode(projectId))!;
    expect(splitObjective(mode.objective)).toEqual({
      base: CANONICAL_CASH_OBJECTIVE,
      constraints: 'Do not target Detroit or Cleveland.',
    });
    expect(questionFor(SEARCH_BUCKETS[0]!, mode.objective, 1, [])).toContain('Do not target Detroit or Cleveland.');

    const again = await setConstraints({ projectId, actorUserId: ownerId, constraints: 'Do not target Detroit or Cleveland.' });
    expect(again.ok && !again.changed).toBe(true);
    const events = await cashEventsOfKindInProject(projectId, CONSTRAINTS_SET_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ before: '', after: 'Do not target Detroit or Cleveland.' });

    const cleared = await setConstraints({ projectId, actorUserId: ownerId, constraints: '' });
    expect(cleared.ok && cleared.changed).toBe(true);
    expect((await getCashMode(projectId))!.objective).toBe(CANONICAL_CASH_OBJECTIVE);
  });
});
