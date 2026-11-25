/**
 * CAPABILITY:GOAL_PLAN.GOAL.PLAN_FRESH — "goal tick stopped", "every pass busy".
 *
 * Every live goal's plan must have a run within the last two hours. Production
 * read 2 of 20. The plan pass (`advanceGoalPlans`) walked goals in row order,
 * read at most `maxReads` (one under database pressure) and stopped reading at
 * the first busy scenario slot, so the same front goals took the slot every
 * pass and the tail starved; and a ruled-out goal (NOT_SUPPORTED) with
 * unchanged inputs skipped its refresh with no upper bound on age.
 *
 * The first block drives the real pass, `advanceGoalPlans`, over goals whose
 * last readings are seeded in `goal_plan_readings`, with one read allowed per
 * pass (the throttled pass) and with the scenario slot held (the busy pass):
 * the recorded failure class, through the real entry point and the `since` it
 * derives from the database. The rest drive the pass's pure decisions —
 * `orderGoalsForPlanPass`, `planDue` and `skipRuledOutRefresh` — across many
 * simulated passes, which a database test cannot afford.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { claimRunSlot } from '../server/services/scenario/isolate.ts';
import { advanceGoalPlans, listReadings, orderGoalsForPlanPass, planDue, PLAN_REFRESH_MS, PLAN_STALE_MAX_MS, skipRuledOutRefresh } from '../server/services/goals/plan.ts';

const MINUTE = 60_000;
const TWO_HOURS = 120 * MINUTE;

interface Goal {
  id: string;
  since: number;
  ruledOut: boolean;
}

/**
 * Run `passes` plan passes `every` ms apart in which the scenario slot serves
 * exactly one read (the throttled pass, or a slot busy after one read). The
 * order function decides who is offered the slot. Returns the oldest plan age
 * any goal reached after the warm-up, and how often each goal was read.
 */
function simulate(goals: Goal[], order: (gs: Goal[]) => Goal[], passes: number, every: number, warmUp: number): { worstAge: number; reads: Map<string, number> } {
  const reads = new Map(goals.map((g) => [g.id, 0]));
  let worstAge = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const now = pass * every;
    let served = false;
    for (const goal of order(goals)) {
      if (served) break;
      let due = planDue({ now, since: goal.since, inputs: null, lastInputs: undefined });
      if (due === 'REFRESH' && skipRuledOutRefresh({ now, since: goal.since, ruledOut: goal.ruledOut, inputsUnchanged: true })) due = null;
      if (!due) continue;
      goal.since = now;
      reads.set(goal.id, reads.get(goal.id)! + 1);
      served = true;
    }
    if (now >= warmUp) for (const goal of goals) worstAge = Math.max(worstAge, now - goal.since);
  }
  return { worstAge, reads };
}

function fleet(n: number): Goal[] {
  // Row order as the database returns it; every goal read once, long ago, in that order.
  return Array.from({ length: n }, (_, i) => ({ id: `ws_${String(i).padStart(2, '0')}`, since: 1 + i, ruledOut: false }));
}

const MINUTE_MS = 60_000;

describe('GOAL.PLAN_FRESH through advanceGoalPlans: the pass offers its one read to the stalest goal', () => {
  const now = new Date();
  let userId = '';

  beforeEach(async () => {
    await freshProject();
    userId = (await createUser({ email: `fresh-${randomUUID().slice(0, 8)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  /**
   * A live goal on its own project's ledger (one live target per figure per
   * ledger, G-7), with one qualified play so reading its plan runs a scenario
   * and needs the slot, and its last reading stored `minutesAgo` back.
   */
  async function goalReadAgo(name: string, minutesAgo: number): Promise<string> {
    const project = await createProject({ name, slug: `${name}-${randomUUID().slice(0, 8)}` });
    expect((await activate({ projectId: project.id, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(project.id))!.id;
    const o = await createOpportunity({
      projectId: project.id,
      cashModeId,
      ownerUserId: userId,
      title: `Monthly owner reports (${name})`,
      mechanism: 'PRODUCTIZED_SERVICE',
      currency: 'USD',
      sourceClaimId: `clm_${randomUUID().slice(0, 10)}`,
      opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
      requiredCapabilities: ['PRODUCE_SPREADSHEET'],
    });
    await updateOpportunity(o.id, {
      payer: 'Property managers',
      price_cents: 50_000,
      offer_scope: 'One monthly report',
      reachable_channel: 'Published business email addresses',
      buying_signal: 'Posted asking for this report',
      signal_observed_at: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      peak_funding_cents: 0,
      human_hours: 3,
    });
    for (const [field, value] of [
      [CAPTURE_KEY, 'Sell a monthly report to each buyer.'],
      ['payer', 'Property managers'],
      ['delivery', 'A spreadsheet Brain produces.'],
      ['price', '$500'],
      ['timeToFirstCash', '7 days'],
      ['directCosts', '$20'],
      ['exposure', '$0'],
      ['buyerVolume', '400 property managers are listed in the state directory; each orders monthly.'],
    ] as const) {
      await recordCardFact({ projectId: project.id, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
    }
    const g = await createWorkstream({ projectId: project.id, title: `Collect cash (${name})`, intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId: project.id, capitalCeilingCents: null, hoursCeiling: 200, now: new Date(now.getTime() - 3 * 60 * MINUTE_MS) });
    expect(set.ok).toBe(true);
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at) VALUES (?, ?, ?, NULL, NULL, 'NEEDS_EVIDENCE', NULL, '[]', NULL, NULL, ?)`,
      [`gpr_${randomUUID().slice(0, 12)}`, g.id, `seed-${name}`, new Date(now.getTime() - minutesAgo * MINUTE_MS).toISOString()],
    );
    return g.id;
  }

  const newest = async (id: string): Promise<number> => Math.max(...(await listReadings(id)).map((one) => Date.parse(one.created_at)));

  it('a throttled pass (maxReads: 1) reads the goal whose stored reading is oldest, not the first row', async () => {
    // Row order is front, middle, tail; every one is past the half-hour, and the tail has waited longest.
    const front = await goalReadAgo('front', 40);
    const middle = await goalReadAgo('middle', 70);
    const tail = await goalReadAgo('tail', 110);
    const seeded = { front: await newest(front), middle: await newest(middle), tail: await newest(tail) };

    expect((await advanceGoalPlans(now, { maxReads: 1 })).read).toBe(1);
    // Before the fix the pass walked row order and gave the one read to `front`; the tail, one pass from two hours, waited again.
    expect(await newest(tail)).toBeGreaterThan(seeded.tail);
    expect(await newest(front)).toBe(seeded.front);
    expect(await newest(middle)).toBe(seeded.middle);

    // The next throttled passes go on down the queue by age: middle, then front.
    expect((await advanceGoalPlans(new Date(now.getTime() + MINUTE_MS), { maxReads: 1 })).read).toBe(1);
    expect(await newest(middle)).toBeGreaterThan(seeded.middle);
    expect(await newest(front)).toBe(seeded.front);
    expect((await advanceGoalPlans(new Date(now.getTime() + 2 * MINUTE_MS), { maxReads: 1 })).read).toBe(1);
    expect(await newest(front)).toBeGreaterThan(seeded.front);
  });

  it('a busy pass reads nobody, and the first pass the slot is free reads the stalest goal', async () => {
    const front = await goalReadAgo('front', 40);
    const tail = await goalReadAgo('tail', 110);
    const seeded = { front: await newest(front), tail: await newest(tail) };

    const release = claimRunSlot();
    try {
      const pass = await advanceGoalPlans(now);
      expect(pass.busy).toBe(true);
      expect(pass.read).toBe(0);
    } finally {
      release();
    }
    expect(await newest(front)).toBe(seeded.front);
    expect(await newest(tail)).toBe(seeded.tail);

    // The slot serves one read again: the goal that has waited longest takes it.
    expect((await advanceGoalPlans(new Date(now.getTime() + MINUTE_MS), { maxReads: 1 })).read).toBe(1);
    expect(await newest(tail)).toBeGreaterThan(seeded.tail);
    expect(await newest(front)).toBe(seeded.front);
  });
});

describe('GOAL.PLAN_FRESH: every live goal is read within two hours', () => {
  it('reproduces the failure: in row order, with one read per pass, goals that keep coming due starve the tail', () => {
    // A pass every two minutes, one read each, twenty goals: the front goals
    // come due again on the half hour before the tail is reached, and row order
    // hands them the slot first every time.
    const goals = fleet(20);
    const rowOrder = (gs: Goal[]) => gs;
    const { worstAge, reads } = simulate(goals, rowOrder, 400, 2 * MINUTE, 4 * 60 * MINUTE);
    expect(worstAge).toBeGreaterThanOrEqual(TWO_HOURS);
    expect(reads.get('ws_19')).toBe(0);
  });

  it('stalest first, the same passes read every goal and none reaches two hours', () => {
    const goals = fleet(20);
    const { worstAge, reads } = simulate(goals, orderGoalsForPlanPass, 400, 2 * MINUTE, 4 * 60 * MINUTE);
    expect(worstAge).toBeLessThan(TWO_HOURS);
    for (const [, n] of reads) expect(n).toBeGreaterThan(0);
  });

  it('orders never-read goals first, then the oldest read, ties by id', () => {
    const ordered = orderGoalsForPlanPass([
      { id: 'b', since: 500 },
      { id: 'c', since: 0 },
      { id: 'a', since: 500 },
      { id: 'd', since: 100 },
    ]);
    expect(ordered.map((g) => g.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('a ruled-out goal with unchanged inputs skips the half-hour refresh, but never past PLAN_STALE_MAX_MS', () => {
    expect(PLAN_STALE_MAX_MS).toBeLessThan(TWO_HOURS);
    expect(PLAN_STALE_MAX_MS).toBeGreaterThan(PLAN_REFRESH_MS);
    const since = 1_000_000;
    // Inside the bound: skipped, as before.
    expect(skipRuledOutRefresh({ now: since + PLAN_REFRESH_MS, since, ruledOut: true, inputsUnchanged: true })).toBe(true);
    // At the bound: read, so the goal never goes stale.
    expect(skipRuledOutRefresh({ now: since + PLAN_STALE_MAX_MS, since, ruledOut: true, inputsUnchanged: true })).toBe(false);
    // Not ruled out, or inputs moved: never skipped.
    expect(skipRuledOutRefresh({ now: since + PLAN_REFRESH_MS, since, ruledOut: false, inputsUnchanged: true })).toBe(false);
    expect(skipRuledOutRefresh({ now: since + PLAN_REFRESH_MS, since, ruledOut: true, inputsUnchanged: false })).toBe(false);
  });

  it('a fleet of ruled-out goals is still read within two hours', () => {
    const goals = fleet(20).map((g) => ({ ...g, ruledOut: true }));
    const { worstAge } = simulate(goals, orderGoalsForPlanPass, 400, 2 * MINUTE, 4 * 60 * MINUTE);
    expect(worstAge).toBeLessThan(TWO_HOURS);
  });
});
