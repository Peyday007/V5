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
import { recordClaimFact } from '../server/repos/construction.ts';
import { FACT_KEY_LIST } from '../server/domain/construction.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { createProject } from '../server/repos/projects.ts';
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

/*
 * A round the pass opens itself (`widenGoalSearch`) files nothing during the
 * pass: its openings are harvested fragment by fragment once research is gated,
 * in a later tick, which is when `discovered_by_candidate_id` is set. So there
 * is no "the pass's own openings" to absorb, and an opening one of the goal's
 * own rounds finds later is evidence the reading never saw. These tests drive
 * that production order rather than filing an opening inside the round's insert.
 */
/*
 * Production, 2026-11-17, release 04b754ce: 5 accepted claims on the $10K
 * goal's research, "no plan evaluation since". A research claim reaches the
 * plan as a construction fact (or a card fact), and the fingerprint saw
 * neither, so it waited out the half-hour refresh.
 */
describe('a research claim filed as a construction fact reaches the plan', () => {
  it('re-reads on the next pass past the floor, inside the half-hour, as evidence', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
    expect((await advanceGoalPlans(start)).read).toBe(1);

    const minutes = (PLAN_EVIDENCE_FLOOR_MS + 8 * 60_000) / 60_000;
    expect((await advanceGoalPlans(at(minutes - 1))).read).toBe(0);
    const filed = await recordClaimFact({
      projectId, nodeId: null, claimId: `clm_${Math.random().toString(36).slice(2, 12)}`, key: FACT_KEY_LIST[0]!, segment: null,
      low: 47, high: 47, status: 'OBSERVED', measures: 'cents per postcard', sourceTitle: 'A price page', sourceUrl: 'https://example.test/price',
      sourceKind: 'PRIMARY', observedAt: new Date().toISOString(),
    });
    expect(filed).not.toBeNull();
    expect(await advanceGoalPlans(at(minutes))).toMatchObject({ read: 1, onEvidence: 1 });
    expect((await advanceGoalPlans(at(minutes + 3))).read).toBe(0);
  });
});

describe("the goal's own rounds and the openings they find", () => {
  async function openings(): Promise<number> {
    const row = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM cash_opportunities WHERE project_id = ?', [projectId]);
    return Number(row?.n ?? 0);
  }
  async function roundsOpened(): Promise<string[]> {
    const rows = await getDb().all<{ candidate_id: string }>('SELECT candidate_id FROM cash_discovery_rounds WHERE project_id = ? ORDER BY created_at', [projectId]);
    return rows.map((one) => one.candidate_id);
  }

  it('a pass that widens the search files no opening of its own, and is not re-read for the rounds it opened', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    await goal(100_000_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    const held = await openings();
    const first = await advanceGoalPlans(start);
    expect(first.read).toBe(1);
    expect(first.asked + first.constructed).toBeGreaterThan(0);
    // The rounds are open, and none of them has filed an opening inside the pass.
    expect((await roundsOpened()).length).toBeGreaterThan(0);
    expect(await openings()).toBe(held);

    // Past the floor, inside the refresh: nothing arrived, so no evidence re-read.
    expect((await advanceGoalPlans(at(10))).onEvidence).toBe(0);
  });

  it("an opening one of the goal's own rounds harvests later is new evidence, and the plan is re-read for it", async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    expect((await advanceGoalPlans(start)).read).toBe(1);
    const own = await roundsOpened();
    expect(own.length).toBeGreaterThan(0);

    // A later harvest of that round files its opening with the round as its finder.
    const found = await play({ title: "Found by the goal's own round", priceCents: 30_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    await getDb().run('UPDATE cash_opportunities SET discovered_by_candidate_id = ? WHERE id = ?', [own[0]!, found.id]);

    expect(await advanceGoalPlans(at(10))).toMatchObject({ read: 1, onEvidence: 1 });
    expect(await goalRunsSince(id, found.createdAt)).toBeGreaterThan(0);
  });

  it("an opening from elsewhere filed while the pass opens its rounds still reads as new evidence", async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    await goal(100_000_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    const db = getDb();
    const original = db.run.bind(db);
    let filed = false;
    vi.spyOn(db, 'run').mockImplementation(async (sql: string, params?: Parameters<typeof db.run>[1]) => {
      const result = await original(sql, params);
      if (!filed && /INSERT INTO cash_discovery_rounds/.test(sql)) {
        filed = true;
        await play({ title: 'Harvested from another round', priceCents: 30_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
      }
      return result;
    });
    expect((await advanceGoalPlans(start)).read).toBe(1);
    vi.restoreAllMocks();
    expect(filed).toBe(true);

    expect(await advanceGoalPlans(at(10))).toMatchObject({ read: 1, onEvidence: 1 });
  });
});

describe('the inputs a reading was taken over (pure)', () => {
  it('has one rule for an arrival: whatever arrived, what a new opening moves comes from before', () => {
    // No exception for a pass's own rounds: the function takes no count of them.
    expect(inputsTakenOver.length).toBe(2);
    expect(inputsTakenOver('1|u0|c0|2|v0|3|g0', '2|u1|c1|4|v1|5|g1')).toBe('1|u1|c0|4|v1|5|g1');
    expect(inputsTakenOver('1|u0|c0|2|v0|3|g0', '3|u1|c1|4|v1|5|g1')).toBe('1|u1|c0|4|v1|5|g1');
  });

  it('takes what a new opening moves from before the read, and everything else from after', () => {
    expect(inputsTakenOver('1|u0|c0|2|v0|3|g0', '2|u1|c1|4|v1|5|g1')).toBe('1|u1|c0|4|v1|5|g1');
    expect(inputsTakenOver('1|u0|c0|2|v0|3|g0', '1|u1|c0|2|v1|3|g1')).toBe('1|u1|c0|2|v1|3|g1');
  });

  it('matches the fingerprint the pass compares against', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    const f = await planInputsFingerprint(projectId, id);
    expect(inputsTakenOver(f, f)).toBe(f);
    expect(f.split('|')).toHaveLength(11);
  });
});

/*
 * Production, 2026-11-15 ($10K goal): the last stored reading was 03:47Z, and
 * a fresh read at 16:29Z drew the identical conclusion, so `persistReading`
 * rightly wrote no row (C-11). But that read's scenario run was on a newly
 * saved model (the definition had moved), which no stored reading references,
 * so `since` never advanced past 03:47Z and every pass after the half-hour
 * read the plan again, holding the process's one scenario slot.
 */
describe('a read that writes no row still counts as the goal having been read', () => {
  async function storedReadings(goalId: string): Promise<number> {
    const row = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM goal_plan_readings WHERE workstream_id = ?', [goalId]);
    return Number(row?.n ?? 0);
  }
  // The model's definition moves, as new evidence moves it in production: the next read saves a new model.
  const moveModel = () => getDb().run(`UPDATE scenario_models SET definition_hash = 'moved' WHERE project_id = ?`, [projectId]);

  it('re-reads once per half-hour, not on every pass, when the conclusion is unchanged under a moved model', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    expect((await advanceGoalPlans(start)).read).toBe(1);
    expect(await storedReadings(id)).toBe(1);
    await moveModel();

    // The half-hour backstop reads it; the conclusion is the same, so no row.
    expect((await advanceGoalPlans(at(31))).read).toBe(1);
    expect(await storedReadings(id)).toBe(1);
    await moveModel();

    // Nothing arrived since that read: no re-read on the next passes inside its half-hour.
    expect((await advanceGoalPlans(at(34))).read).toBe(0);
    expect((await advanceGoalPlans(at(45))).read).toBe(0);
    // The backstop still holds, measured from the read that ran.
    expect((await advanceGoalPlans(at(62))).read).toBe(1);
  });

  it('new evidence after an unstored read is still read at once', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    const start = new Date();
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

    expect((await advanceGoalPlans(start)).read).toBe(1);
    await moveModel();
    expect((await advanceGoalPlans(at(31))).read).toBe(1);

    const filed = await play({ title: 'Quarterly tenant surveys', priceCents: 40_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    expect(await advanceGoalPlans(at(34))).toMatchObject({ read: 1, onEvidence: 1 });
    expect(await goalRunsSince(id, filed.createdAt)).toBeGreaterThan(0);
  });
});

describe('which goal a pass that is cut short reaches', () => {
  async function readings(goalId: string): Promise<number> {
    const rows = await getDb().all<{ n: number | string }>(`SELECT COUNT(*) AS n FROM goal_plan_readings WHERE workstream_id = ?`, [goalId]);
    return Number(rows[0]!.n);
  }

  /*
   * Production, 2026-11-25: ~60 live goals, a pass reading them in table order
   * was ended by its bound after about forty, and the next pass started again
   * at the top — twelve goals created at 19:29Z had no plan read 75 minutes
   * later. A pass reads the goal never read first, then the least recently read.
   */
  it('a new goal is read before goals that are merely due for a refresh', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const older = await goal(100_000);
    const start = new Date();
    expect((await advanceGoalPlans(start)).read).toBe(1);
    expect(await readings(older)).toBe(1);

    // A second goal needs a project of its own (one goal per project).
    const other = await createProject({ name: 'Second goal', slug: `second-goal-${Math.random().toString(36).slice(2, 8)}` });
    expect((await activate({ projectId: other.id, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const g = await createWorkstream({ projectId: other.id, title: 'Collect cash fast too', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId: other.id, capitalCeilingCents: null, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    const fresh = g.id;
    // Both are due — the older one for its half-hour refresh — and the pass may read one.
    const pass = await advanceGoalPlans(new Date(start.getTime() + PLAN_REFRESH_MS + 60_000), { maxReads: 1 });
    expect(pass.read).toBe(1);
    expect(await readings(fresh)).toBe(1);
    expect(await readings(older)).toBe(1);
  });
});
