/**
 * A qualified opening becomes one execution job, and nothing else does.
 *
 * The full discovery-to-settlement walk is `cashAutonomousFunnel`; this file
 * pins the refusals around it — the openings that must *not* become jobs, the
 * job a person's decision releases, the duplicate a concurrent pass must not
 * make, and the blockers each task names when authority or a provider is
 * missing. A job prepared is never a buyer contacted and never money.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { countActions } from '../server/repos/cashActions.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { listJobs } from '../server/repos/cashJobs.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL } from '../server/services/cash/authority.ts';
import { capture, decline, fillCard } from '../server/services/cash/opportunities.ts';
import { operate } from '../server/services/cash/operate.ts';
import {
  jobStage,
  jobTasks,
  pipelineReading,
  reconcileCashJobs,
} from '../server/services/cash/jobPipeline.ts';
import { getDb } from '../server/db/database.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `jobs-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  expect(
    (await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Usable cash, quickly.' })).ok,
  ).toBe(true);
});

/** A piece whose whole qualification set a person answered: QUALIFIED. */
async function qualifiedPiece(patch: Record<string, unknown> = {}, title = 'A paid intake repair'): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: userId,
    patch: {
      payer: 'The clinic owner',
      reachableChannel: 'owner@clinic.example',
      buyingSignal: 'Asked publicly for a quote',
      signalObservedAt: '2026-10-15T09:00:00.000Z',
      offerScope: 'One fixed-scope intake form repair',
      acceptanceCondition: 'A test enquiry arrives',
      priceCents: 75_000,
      deliveryMethod: 'Configuration, delivered by email',
      fulfillmentOwner: 'Brain',
      peakFundingCents: 0,
      ...patch,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({
      projectId,
      opportunityId: captured.value.id,
      field,
      kind: 'PERSON',
      value: `The owner's answer to ${field}.`,
      decidedBy: userId,
    });
  }
  return captured.value.id;
}

describe('qualification becomes one job', () => {
  it('prepares exactly one job, even under repeated and concurrent passes', async () => {
    const id = await qualifiedPiece();
    const first = await reconcileCashJobs(projectId);
    expect(first.created.map((one) => one.opportunityId)).toEqual([id]);
    await Promise.all([reconcileCashJobs(projectId), reconcileCashJobs(projectId), operate(projectId)]);
    const jobs = (await listJobs(projectId)).filter((one) => one.opportunityId === id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ownerUserId: userId, createdBy: 'BRAIN' });
    const events = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_JOB_PREPARED'`,
      [id],
    );
    expect(Number(events[0]!.n)).toBe(1);
  });

  it('blocks only the effects that need authority, and contacts nobody', async () => {
    const id = await qualifiedPiece();
    await operate(projectId);
    const reading = (await pipelineReading(projectId, { userId, owner: true }))!;
    const job = reading.jobs.find((one) => one.opportunityId === id)!;
    const byKey = Object.fromEntries(job.tasks.map((task) => [task.key, task]));
    // Preparation proceeds without any grant...
    expect(byKey.offer!.status).toBe('DONE');
    expect(byKey.buyer!.status).toBe('DONE');
    expect(byKey.evidence!.status).toBe('DONE');
    // ...and only the effect on the world waits, naming the exact authority.
    expect(byKey.contact!.status).toBe('BLOCKED_AUTHORITY');
    expect(byKey.contact!.because).toContain('CONTACT_BUYER');
    expect(job.stage).toBe('READY_BLOCKED');
    expect(job.next!.because).toContain('CONTACT_BUYER');
    expect(await countActions(id)).toBe(0);
    expect(reading.authority.live).toBe(false);
    expect(reading.settledCents).toBe(0);
  });

  it('names the missing provider once authority exists, and still sends nothing', async () => {
    const id = await qualifiedPiece();
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Commercial authority',
      allowedActions: ['CONTACT_BUYER'],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 10_000,
      maxPerActionCents: 10_000,
      maxConcurrent: 1,
      currency: 'USD',
    });
    await operate(projectId);
    const job = (await pipelineReading(projectId, { userId, owner: true }))!.jobs.find(
      (one) => one.opportunityId === id,
    )!;
    const contact = job.tasks.find((task) => task.key === 'contact')!;
    expect(contact.status).toBe('BLOCKED_PROVIDER');
    expect(contact.because).toContain('BRAIN_MESSAGING_PROVIDER');
    expect(await countActions(id)).toBe(0);
  });

  it('hides another person’s private half from a shared reader', async () => {
    const id = await qualifiedPiece();
    await reconcileCashJobs(projectId);
    const shared = (await pipelineReading(projectId, { userId: 'usr_somebody_else', owner: false }))!;
    const job = shared.jobs.find((one) => one.opportunityId === id)!;
    expect(job.tasks).toEqual([]);
    expect(job.priceCents).toBeNull();
    expect(job.ownerUserId).toBeNull();
    expect(shared.counts.READY_BLOCKED + shared.counts.JOB_PREPARED).toBe(1);
  });
});

describe('what never becomes a job', () => {
  it('refuses an opening whose published figures say one sale loses money', async () => {
    const id = await qualifiedPiece({ priceCents: 500, peakFundingCents: 80_000 });
    const result = await reconcileCashJobs(projectId);
    expect(result.created).toEqual([]);
    expect(result.declined.find((one) => one.opportunityId === id)!.because).toContain('loses money');
    const reading = (await pipelineReading(projectId, { userId, owner: true }))!;
    expect(reading.counts.QUALIFIED).toBe(1);
    expect(reading.qualifiedWithoutJob[0]!.because).toContain('loses money');
  });

  it('refuses a duplicate record of an opening', async () => {
    const survivor = await qualifiedPiece();
    const second = await qualifiedPiece({}, 'A paid intake repair, again');
    await updateOpportunity(second, { duplicate_of_id: survivor });
    await reconcileCashJobs(projectId);
    const jobs = await listJobs(projectId);
    expect(jobs.map((one) => one.opportunityId)).toEqual([survivor]);
  });

  it('releases the job when a person declines the opportunity, keeping its row', async () => {
    const id = await qualifiedPiece();
    await reconcileCashJobs(projectId);
    const declined = await decline({ opportunityId: id, actorUserId: userId, reason: 'Not this one.' });
    expect(declined.ok).toBe(true);
    const result = await reconcileCashJobs(projectId);
    expect(result.released).toHaveLength(1);
    const jobs = await listJobs(projectId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('RELEASED');
    expect((await getOpportunity(id))!.state).toBe('DECLINED');
  });
});

describe('the derivation is honest about stage', () => {
  it('never reads preparation as agreement, delivery or money', () => {
    const opportunity = {
      id: 'cop_x', state: 'READY', title: 'x', payer: 'p', reachableChannel: 'a@b.example',
      buyingSignal: 's', signalObservedAt: '2026-10-01', offerScope: 'o', priceCents: 100,
      requiredInputs: null, acceptanceCondition: null, deliveryMethod: null, fulfillmentOwner: null,
    } as never;
    const base = {
      opportunity,
      needs: [],
      capabilities: new Map(),
      authority: new Map([['CONTACT_BUYER', { ok: true, reason: 'ok' }]]),
      contacted: false,
      agreed: false,
      delivered: false,
      paid: false,
      settled: false,
      sprintActive: true,
    };
    const tasks = jobTasks(base);
    expect(jobStage(tasks, base)).toBe('READY_BLOCKED');
    expect(tasks.find((t) => t.key === 'collect')!.status).toBe('BLOCKED_DEPENDENCY');
    expect(jobStage(jobTasks({ ...base, contacted: true }), { ...base, contacted: true })).toBe('EXECUTING');
    const paid = { ...base, contacted: true, agreed: true, paid: true };
    expect(jobStage(jobTasks(paid), paid)).toBe('PAID');
  });
});
