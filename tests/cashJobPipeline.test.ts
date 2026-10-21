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
    // The whole tick first: Brain marks a complete card READY by itself, and
    // READY must not read as somebody having committed to the work.
    await operate(projectId);
    expect((await listJobs(projectId)).filter((one) => one.opportunityId === id)).toEqual([]);
    const result = await reconcileCashJobs(projectId);
    expect(result.created).toEqual([]);
    // Since 2026-10-21 the tier refuses it too, so it is not even counted as
    // qualified: the page, the ranking and the job pipeline read one answer.
    const reading = (await pipelineReading(projectId, { userId, owner: true }))!;
    expect(reading.counts.QUALIFIED).toBe(0);
    expect(reading.counts.UNDER_QUALIFICATION).toBe(1);
    // Nor did the tick mark it ready on the way.
    expect((await getOpportunity(id))!.state).not.toBe('READY');
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

describe('a candidate whose dives are spent can still be qualified', () => {
  /*
   * Production, 2026-10-20: 79 CANDIDATE openings, none QUALIFIED, 26 with both
   * dives of their epoch spent and qualification fields no column holds — so
   * nothing could ever ask again. Each blank engine field is now one narrow
   * research question, through the same gate, and the answer lands on the card.
   */
  async function spentCandidate(): Promise<string> {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A published request for parcel research',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    const id = captured.value.id;
    await fillCard({
      opportunityId: id,
      actorRef: userId,
      patch: {
        payer: 'The drainage authority',
        reachableChannel: 'procurement@authority.example',
        buyingSignal: 'Request 2026-441, published',
        signalObservedAt: '2026-10-15T09:00:00.000Z',
        offerScope: 'Ownership research on twenty parcels',
        acceptanceCondition: 'Twenty parcels delivered',
        priceCents: 200_000,
        deliveryMethod: 'A report by email',
        fulfillmentOwner: 'Brain',
        peakFundingCents: 0,
      },
    });
    // Everything a person or a dive answered, except the engine facts.
    const engine = new Set(['revenueRange', 'directCosts', 'requiredCapital', 'timeToFirstCash', 'laborNeeds']);
    for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
      if (engine.has(field)) continue;
      await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `Answered: ${field}.`, decidedBy: userId });
    }
    await getDb().run(
      `UPDATE cash_opportunities SET validation_state = 'BLOCKED', validation_rounds = 2,
         source_claim_id = NULL WHERE id = ?`,
      [id],
    );
    return id;
  }

  it('asks each blank engine field once, capped, and never the disqualifier question', async () => {
    const id = await spentCandidate();
    const { reconcileEngineGaps, MAX_OPEN_ENGINE_QUESTIONS } = await import('../server/services/cash/operate.ts');
    const first = await reconcileEngineGaps(projectId);
    const fields = first.filter((one) => one.opportunityId === id).map((one) => one.field).sort();
    expect(fields).toEqual(['directCosts', 'laborNeeds', 'requiredCapital', 'revenueRange', 'timeToFirstCash']);
    expect(fields).not.toContain('disqualifiers');
    // Idempotent: the next pass raises nothing new.
    expect(await reconcileEngineGaps(projectId)).toEqual([]);
    expect(first.length).toBeLessThanOrEqual(MAX_OPEN_ENGINE_QUESTIONS);

    // An answer arriving by any route settles the question from the card.
    await recordCardFact({ projectId, opportunityId: id, field: 'laborNeeds', kind: 'PERSON', value: 'Brain alone.', decidedBy: userId });
    await reconcileEngineGaps(projectId);
    const open = await getDb().all<{ request_key: string }>(
      `SELECT request_key FROM cash_needs WHERE opportunity_id = ? AND state = 'OPEN'`,
      [id],
    );
    expect(open.map((one) => one.request_key)).not.toContain(`question:${id}:laborNeeds`);
  });

  it('does not ask while a dive could still ask everything at once', async () => {
    const id = await spentCandidate();
    await getDb().run(`UPDATE cash_opportunities SET validation_rounds = 1 WHERE id = ?`, [id]);
    const { reconcileEngineGaps } = await import('../server/services/cash/operate.ts');
    expect((await reconcileEngineGaps(projectId)).filter((one) => one.opportunityId === id)).toEqual([]);
  });
});

describe('a job stops when its grounds do', () => {
  it('releases an uncommitted job once its figures show a loss, keeping the row', async () => {
    const id = await qualifiedPiece();
    await reconcileCashJobs(projectId);
    await getDb().run('UPDATE cash_opportunities SET peak_funding_cents = 900000 WHERE id = ?', [id]);
    const result = await reconcileCashJobs(projectId);
    expect(result.released[0]!.because).toContain('no longer actionable');
    expect((await listJobs(projectId)).map((one) => one.state)).toEqual(['RELEASED']);
    // Nothing new is prepared while the loss stands.
    await reconcileCashJobs(projectId);
    expect(await listJobs(projectId)).toHaveLength(1);
  });
});
