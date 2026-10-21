/**
 * Every person gets the same menu, and nobody gets the same job.
 *
 * The owner's rule (2026-10-21): jobs are dealt per kind of work. Four of one
 * kind go one to each person; when a kind is short, the people who got none are
 * owed one and the next of that kind goes to them, while Brain looks for more
 * of that kind first. These pin the rule, the refusals around it — a job in
 * execution is never taken off its holder, a job is never dealt twice — and the
 * discovery half that closes the gap.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createJob, getJob, listJobs } from '../server/repos/cashJobs.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { pipelineReading, reconcileCashJobs } from '../server/services/cash/jobPipeline.ts';
import {
  chooseSeat,
  dealJobs,
  owed,
  owedByCategory,
  tally,
  type Seat,
} from '../server/services/cash/dealer.ts';
import { getDb } from '../server/db/database.ts';
import type { CashMechanism } from '../server/domain/types.ts';

let projectId = '';
let users: string[] = [];

async function person(name: string): Promise<string> {
  const user = await createUser({
    email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: name,
    password: 'correct horse battery staple',
  });
  return user.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  users = [];
  for (const name of ['Peyton', 'Airyn', 'Caleb', 'Jordan']) users.push(await person(name));
  expect(
    (await activate({ projectId, ownerUserId: users[0]!, actorUserId: users[0]!, objective: 'Usable cash, quickly.' }))
      .ok,
  ).toBe(true);
});

let n = 0;
/** A piece whose whole qualification set a person answered: QUALIFIED. */
async function qualified(mechanism: CashMechanism): Promise<string> {
  n += 1;
  const owner = users[0]!;
  const captured = await capture({
    projectId,
    actorRef: owner,
    ownerUserId: owner,
    title: `${mechanism} opening ${n}`,
    mechanism,
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: owner,
    patch: {
      payer: `Buyer ${n}`,
      reachableChannel: `buyer${n}@example.test`,
      buyingSignal: 'Asked publicly for a quote',
      signalObservedAt: '2026-10-15T09:00:00.000Z',
      offerScope: `Offer ${n}`,
      acceptanceCondition: 'The buyer confirms receipt',
      priceCents: 50_000,
      deliveryMethod: 'By email',
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
      value: `Answered: ${field}.`,
      decidedBy: owner,
    });
  }
  return captured.value.id;
}

async function heldBy(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const job of await listJobs(projectId)) {
    if (job.state === 'RELEASED' || !job.ownerUserId) continue;
    out.set(job.ownerUserId, [...(out.get(job.ownerUserId) ?? []), job.opportunityId]);
  }
  return out;
}

describe('the rule, as a pure decision', () => {
  const seats: Seat[] = ['a', 'b', 'c', 'd'].map((id) => ({ userId: `usr_${id}`, displayName: id.toUpperCase() }));

  it('gives the next job of a kind to somebody who holds none of it', () => {
    const t = tally(seats, [
      { userId: 'usr_b', category: 'RESALE_OR_ASSET', at: '2026-10-01' },
      { userId: 'usr_c', category: 'RESALE_OR_ASSET', at: '2026-10-02' },
    ]);
    const choice = chooseSeat('RESALE_OR_ASSET', seats, t)!;
    expect(['usr_a', 'usr_d']).toContain(choice.userId);
    expect(choice.because).toMatch(/owed one/);
  });

  it('marks who is owed, and only in the kinds somebody already holds', () => {
    const t = tally(seats, [{ userId: 'usr_a', category: 'CAPABILITY_ARBITRAGE', at: null }]);
    const debts = owed(seats, t);
    expect([...debts.keys()]).toEqual(['CAPABILITY_ARBITRAGE']);
    expect([...debts.get('CAPABILITY_ARBITRAGE')!.keys()].sort()).toEqual(['usr_b', 'usr_c', 'usr_d']);
  });

  it('breaks a tie on total work, never on a weight, and the same way every time', () => {
    const t = tally(seats, [
      { userId: 'usr_a', category: 'OTHER', at: '2026-10-01' },
      { userId: 'usr_b', category: 'OTHER', at: '2026-10-01' },
    ]);
    const first = chooseSeat('RESALE_OR_ASSET', seats, t)!;
    expect(['usr_c', 'usr_d']).toContain(first.userId);
    expect(chooseSeat('RESALE_OR_ASSET', seats, t)!.userId).toBe(first.userId);
  });

  it('ignores a holding by somebody who is not dealt in', () => {
    const t = tally(seats, [{ userId: 'usr_gone', category: 'OTHER', at: null }]);
    expect(owed(seats, t).size).toBe(0);
  });
});

describe('dealing real jobs', () => {
  it('deals four of a kind one to each person, and never one job twice', async () => {
    for (let i = 0; i < 4; i += 1) await qualified('RESALE_OR_ASSET');
    const first = await reconcileCashJobs(projectId);
    expect(first.dealt).toHaveLength(4);
    const held = await heldBy();
    expect([...held.keys()].sort()).toEqual([...users].sort());
    for (const list of held.values()) expect(list).toHaveLength(1);

    // Idempotent: a second pass deals nothing, and each job has one deal event.
    const second = await reconcileCashJobs(projectId);
    expect(second.dealt).toEqual([]);
    const events = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM cash_events WHERE project_id = ? AND kind = 'CASH_JOB_DEALT'`,
      [projectId],
    );
    expect(Number(events[0]!.n)).toBe(4);
  });

  it('marks a short kind as owed, and gives the next one to somebody owed', async () => {
    await qualified('CAPABILITY_ARBITRAGE');
    await qualified('CAPABILITY_ARBITRAGE');
    await reconcileCashJobs(projectId);
    const firstHolders = [...(await heldBy()).keys()];
    expect(firstHolders).toHaveLength(2);
    expect((await owedByCategory(projectId)).get('CAPABILITY_ARBITRAGE')).toBe(2);

    await qualified('CAPABILITY_ARBITRAGE');
    const next = await reconcileCashJobs(projectId);
    expect(next.dealt).toHaveLength(1);
    expect(firstHolders).not.toContain(next.dealt[0]!.toUserId);
    expect((await owedByCategory(projectId)).get('CAPABILITY_ARBITRAGE')).toBe(1);

    // Each person reads their own plate, and what they are owed.
    const owedPerson = users.find((id) => !firstHolders.includes(id) && id !== next.dealt[0]!.toUserId)!;
    const reading = (await pipelineReading(projectId, { userId: owedPerson, owner: false }))!;
    expect(reading.plate.mine).toEqual([]);
    expect(reading.plate.owedToMe.map((one) => one.category)).toEqual(['CAPABILITY_ARBITRAGE']);
    expect(reading.plate.everyone).toBeUndefined();
    const full = (await pipelineReading(projectId, { userId: users[0]!, owner: true }))!;
    expect(full.plate.everyone).toHaveLength(4);
  });

  it('re-deals a job handed to the owner by default, and leaves work in execution alone', async () => {
    const inherited = await qualified('PRODUCTIZED_SERVICE');
    const started = await qualified('PRODUCTIZED_SERVICE');
    // The old default: created ASSIGNED to the sprint's owner in one statement.
    const old = (await createJob({
      opportunityId: inherited,
      projectId,
      currency: 'USD',
      ownerUserId: users[0]!,
      createdBy: 'BRAIN',
    }))!;
    const running = (await createJob({
      opportunityId: started,
      projectId,
      currency: 'USD',
      ownerUserId: users[0]!,
      createdBy: 'BRAIN',
    }))!;
    await getDb().run(`UPDATE cash_jobs SET state = 'EXECUTING' WHERE id = ?`, [running.id]);

    const report = await dealJobs(projectId);
    expect(report.dealt.map((one) => one.jobId)).toEqual([old.id]);
    // The running job stayed with its holder, so the inherited one went elsewhere.
    expect((await getJob(running.id))!.ownerUserId).toBe(users[0]);
    expect((await getJob(old.id))!.ownerUserId).not.toBe(users[0]);
    // And it is not dealt again.
    expect((await dealJobs(projectId)).dealt).toEqual([]);
  });

  it('gives back a job whose holder can no longer sign in', async () => {
    await qualified('RESALE_OR_ASSET');
    await reconcileCashJobs(projectId);
    const job = (await listJobs(projectId))[0]!;
    const holder = job.ownerUserId!;
    await getDb().run('UPDATE users SET disabled_at = ? WHERE id = ?', [new Date().toISOString(), holder]);
    const report = await dealJobs(projectId);
    expect(report.dealt).toHaveLength(1);
    expect(report.dealt[0]!.fromUserId).toBe(holder);
    expect((await getJob(job.id))!.ownerUserId).not.toBe(holder);
  });
});

describe('discovery closes the gap', () => {
  it('asks first for the kind of work somebody is owed', async () => {
    await qualified('RESALE_OR_ASSET');
    await reconcileCashJobs(projectId);
    const { openDiscovery } = await import('../server/services/cash/discovery.ts');
    const opened = await openDiscovery({ projectId, limit: 1 });
    expect(opened.map((one) => one.bucketId)).toEqual(['resale-or-asset']);
  });

  it('never opens the retired paid-request bucket, and can still read its rounds', async () => {
    const { openDiscovery, SEARCH_BUCKETS, ALL_BUCKETS } = await import('../server/services/cash/discovery.ts');
    expect(SEARCH_BUCKETS.map((one) => one.id)).not.toContain('explicit-paid-request');
    expect(ALL_BUCKETS.map((one) => one.id)).toContain('explicit-paid-request');
    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 5 });
    expect(opened.map((one) => one.bucketId)).not.toContain('explicit-paid-request');
  });
});

describe('one shared frontier', () => {
  it('stops buying corrected rounds for an old per-person cash project', async () => {
    const { createProject } = await import('../server/repos/projects.ts');
    const { createLayer } = await import('../server/repos/layers.ts');
    const { askedBySharedFrontier, LEGACY_CASH_LAYER } = await import('../server/services/research/judgeRound.ts');
    const { CASH_LAYER_NAME } = await import('../server/services/cash/lifecycle.ts');
    expect(LEGACY_CASH_LAYER).toBe(CASH_LAYER_NAME);

    const legacy = await createProject({ name: 'Cash Mode 2' });
    await createLayer({ projectId: legacy.id, name: CASH_LAYER_NAME, orderIndex: 0 });
    expect(await askedBySharedFrontier(legacy.id)).toMatch(/shared frontier/);
    // The root itself, and an ordinary project, are not affected.
    expect(await askedBySharedFrontier(projectId)).toBeNull();
    const ordinary = await createProject({ name: 'Something else' });
    expect(await askedBySharedFrontier(ordinary.id)).toBeNull();
  });
});
