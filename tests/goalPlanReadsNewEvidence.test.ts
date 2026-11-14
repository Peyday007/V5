/**
 * CAPABILITY:GOAL_PLAN.PLAN.READS_NEW_EVIDENCE — "plan not re-read".
 *
 * Reading a goal's plan runs a scenario and is slow. An opening harvested while
 * it runs was not in the model the reading used, but `advanceGoalPlans` took
 * the inputs fingerprint after the pass, folded that opening into `lastInputs`,
 * and so never saw it as new evidence: it waited for the half-hour refresh.
 * These tests file an opening while the read is under way, at the moment the
 * read starts its scenario run, which is what production does on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { advanceGoalPlans, forgetGoalReadings, inputsTakenOver, planInputsFingerprint, PLAN_EVIDENCE_FLOOR_MS, PLAN_REFRESH_MS } from '../server/services/goals/plan.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({ email: `goal-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
  ).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function fact(o: CashOpportunity, field: string, value: string, kind: 'EVIDENCE' | 'PERSON' = 'EVIDENCE'): Promise<void> {
  await recordCardFact({ projectId, opportunityId: o.id, field, kind, value, claimId: kind === 'EVIDENCE' ? `clm_${field}_${o.id}` : null, decidedBy: kind === 'EVIDENCE' ? 'BRAIN' : 'PERSON' });
}

/** A qualified, repeatable play with the given economics. */
async function play(input: { title: string; priceCents: number; days?: number; capitalCents?: number; hours?: number; costCents?: number; reach?: boolean; signal?: boolean; volume?: string | null }): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title: input.title,
    mechanism: 'PRODUCTIZED_SERVICE',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
    source: 'A publisher',
    requiredCapabilities: ['PRODUCE_SPREADSHEET'],
  });
  await fact(o, CAPTURE_KEY, 'Sell a monthly report to each buyer.');
  await fact(o, 'payer', 'Property managers');
  await fact(o, 'delivery', 'A spreadsheet Brain produces.');
  await updateOpportunity(o.id, {
    payer: 'Property managers',
    price_cents: input.priceCents,
    offer_scope: 'One monthly report',
    reachable_channel: input.reach === false ? null : 'Published business email addresses',
    buying_signal: input.signal === false ? null : 'Posted asking for this report',
    signal_observed_at: input.signal === false ? null : inDays(-3),
    peak_funding_cents: input.capitalCents ?? null,
    human_hours: input.hours ?? null,
  });
  await fact(o, 'price', `$${input.priceCents / 100}`);
  if (input.days !== undefined) await fact(o, 'timeToFirstCash', `${input.days} days`);
  if (input.costCents !== undefined) await fact(o, 'directCosts', `$${input.costCents / 100}`);
  if (input.capitalCents !== undefined) await fact(o, 'exposure', `$${input.capitalCents / 100}`);
  // Established by default, so each test exercises the link it names; the
  // market-volume link has its own tests.
  if (input.volume !== null) await fact(o, 'buyerVolume', input.volume ?? '400 property managers are listed in the state directory; each orders monthly.');
  return o;
}

async function goal(amountCents: number, capitalCents: number | null = null, days = 30): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: capitalCents, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}


afterEach(() => {
  vi.restoreAllMocks();
  forgetGoalReadings();
});

/** While the next scenario run is being started, do `during` once — inside the plan read. */
function duringNextScenarioRun(during: () => Promise<unknown>): { fired: () => boolean } {
  const db = getDb();
  const original = db.run.bind(db);
  let done = false;
  vi.spyOn(db, 'run').mockImplementation(async (sql: string, params?: Parameters<typeof db.run>[1]) => {
    const result = await original(sql, params);
    if (!done && /INSERT INTO scenario_runs/.test(sql)) {
      done = true;
      await during();
    }
    return result;
  });
  return { fired: () => done };
}

async function goalRunsSince(goalId: string, at: string): Promise<number> {
  const rows = await getDb().all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM scenario_runs WHERE label = ? AND started_at > ?`,
    [`goal ${goalId}`, at],
  );
  return Number(rows[0]!.n);
}

describe('an opening filed while the plan is being read reaches the plan', () => {
  it('re-reads on the next pass past the floor, inside the half-hour, as evidence', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    let filed: CashOpportunity | null = null;
    const hook = duringNextScenarioRun(async () => {
      filed = await play({ title: 'Quarterly tenant surveys', priceCents: 40_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    });
    expect((await advanceGoalPlans(start)).read).toBe(1);
    expect(hook.fired()).toBe(true);
    vi.restoreAllMocks();
    expect(filed).not.toBeNull();
    const filedAt = filed!.createdAt;

    // Past the evidence floor, well inside the refresh: the opening the read never saw is new evidence.
    const minutes = (PLAN_EVIDENCE_FLOOR_MS + 8 * 60_000) / 60_000;
    expect(minutes * 60_000).toBeLessThan(PLAN_REFRESH_MS);
    const pass = await advanceGoalPlans(at(minutes));
    expect(pass).toMatchObject({ read: 1, onEvidence: 1 });
    // OPENINGS_REACH_PLAN: a goal scenario run started after the opening was filed.
    expect(await goalRunsSince(id, filedAt)).toBeGreaterThan(0);

    // Read once for it, not again until something else moves.
    expect((await advanceGoalPlans(at(minutes + 3))).read).toBe(0);
  });

  it("the pass's own writes to existing openings during the read cause no extra read", async () => {
    const o = await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    await goal(100_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    const hook = duringNextScenarioRun(async () => {
      // A write of the kind the pass's own research makes: an existing opening's row moves.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await updateOpportunity(o.id, { offer_scope: 'One monthly report, revised' });
    });
    expect((await advanceGoalPlans(start)).read).toBe(1);
    expect(hook.fired()).toBe(true);
    vi.restoreAllMocks();

    expect((await advanceGoalPlans(at(10))).read).toBe(0);
  });
});

describe('the inputs a reading was taken over (pure)', () => {
  it('takes what a new opening moves from before the read, and everything else from after', () => {
    expect(inputsTakenOver('1|u0|c0|2|v0|3|g0', '2|u1|c1|4|v1|5|g1')).toBe('1|u1|c0|4|v1|5|g1');
    expect(inputsTakenOver('1|u0|c0|2|v0|3|g0', '1|u1|c0|2|v1|3|g1')).toBe('1|u1|c0|2|v1|3|g1');
  });

  it('matches the fingerprint the pass compares against', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    const f = await planInputsFingerprint(projectId, id);
    expect(inputsTakenOver(f, f)).toBe(f);
    expect(f.split('|')).toHaveLength(7);
  });
});
