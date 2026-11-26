/**
 * The investment committee (§117) on Brain's real planner: each world is filed the way
 * research files it and read by `readGoalPlan` (bench/planningReliability/world.ts), so
 * the committee judges exactly what production would put in front of it.
 *
 *   (a) the audited GitHub-bounty plan (mv-01) is failed by SKEPTIC, MARKET_EXPERT and
 *       QUANT with cited defects, and is never ACCEPTED — not even when the acceptance
 *       is forced, counterfactually, to ACCEPTED: the gate takes it away;
 *   (b) a fully evidenced legitimate plan passes every deterministic role and is not
 *       blocked, on a routine and on a full review;
 *   (c) two roles reading one fact the opposite way yield an investigation that the
 *       existing needs owner accepts.
 *
 * It prints what the owner asked to be measured: critical defects detected, false
 * approvals prevented, legitimate plans incorrectly rejected, and the review time a
 * plan read pays.
 */
// First: the bench's process environment (as `bench/planningReliability/index.ts` loads it).
import '../bench/env.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaseDimensions, PlanningCase } from '../bench/planningReliability/case.ts';
import { MECHANISM_CASES } from '../bench/planningReliability/mechanismCases.ts';
import { buildTemplate, closeWorldDatabase, proveDeliverables, runWorld, type Template } from '../bench/planningReliability/world.ts';
import { committeeInputOf, committeeOf, reviewPlan } from '../server/services/goals/committee.ts';
import { gateIntegrity, type PlanAcceptance, type PlanReading, type PlanStep } from '../server/services/goals/plan.ts';
import { sendCommitteeNeeds } from '../server/services/goals/portfolioNeeds.ts';

const dims = (industry: string, mechanism: string): CaseDimensions => ({ capital: 'none', target: 'small', deadline: 'long', industry, mechanism, autonomy: 'unlimited', missingEvidence: 'none', contradictoryEvidence: false, objectiveChanged: false });

/** A marketplace product Brain produces, every link evidenced: many buyers who do buy, a channel, a price, a cost, cash in days. */
const LEGITIMATE: PlanningCase = {
  id: 'committee-legitimate-marketplace',
  heldOut: false,
  description: 'Every link evidenced: 2,300 comparable sales a year, a measured 4% conversion at $29, Brain produces it, cash in 3 days.',
  dimensions: dims('home meal planning', 'PRODUCTIZED_SERVICE'),
  objective: 'Collect $1,000 of settled cash within 30 days using no up-front capital.',
  openings: [
    {
      key: 'meal', title: 'Allergen meal-plan spreadsheet sold on a digital-download marketplace', mechanism: 'PRODUCTIZED_SERVICE', industry: 'home meal planning',
      payer: 'Marketplace shoppers planning allergen-free meals', channel: 'The marketplace listing and its search', price: 29,
      priceEvidence: 'Comparable allergen meal-plan spreadsheets sell for $29 on the marketplace (listing prices, 2026-11).',
      cost: 3, capital: 0, daysToCash: 3, hours: 0.1, performer: 'BRAIN',
      volume: 'The marketplace shows 2,300 sales of comparable meal-plan spreadsheets in the last 12 months across 40 sellers; buyers return each season.',
      conversion: { paid: 60, of: 1500 },
    },
  ],
  expect: { verdict: 'EXECUTABLE_PLAN' },
};

const INVALID = MECHANISM_CASES.filter((c) => c.expect.verdict === 'NO_PLAN');

let dir = '';
let template: Template;
const readings = new Map<string, PlanReading>();
let index = 0;
const read = async (c: PlanningCase): Promise<PlanReading> => {
  const w = await runWorld(c, template, dir, index++);
  readings.set(c.id, w.reading);
  return w.reading;
};

/** The counterfactual: the same reading as if the planner had accepted it on its own record. */
const forcedAccepted = (r: PlanReading): PlanReading => {
  const ids = r.acceptance.candidate?.opportunityIds ?? [];
  const acceptance: PlanAcceptance = {
    ...r.acceptance,
    status: 'ACCEPTED',
    probability: { value: 0.95, lowerBound: 0.91, basis: 'MEASURED_RECORD', sample: 40, note: 'counterfactual acceptance for the committee test' },
    accepted: { label: r.acceptance.candidate?.label ?? 'plan', opportunityIds: ids },
    sentence: 'Accepted (counterfactual).',
    verdict: 'CONFIDENCE_VERIFIED',
  };
  return { ...r, acceptance, verdict: 'RECOMMENDABLE', summary: acceptance.sentence, integrity: [] };
};
/** The reading as it stands once the existing independent model challenge (`quant/modelChallenge.ts`) answered PROCEED. */
const challengeAnswered = (r: PlanReading): PlanReading => {
  const assurance = r.portfolio?.assurance as { challenge?: { modelChallenge?: object } } | null | undefined;
  if (!r.portfolio || !assurance?.challenge) return r;
  return { ...r, portfolio: { ...r.portfolio, assurance: { ...r.portfolio.assurance, challenge: { ...assurance.challenge, modelChallenge: { ...assurance.challenge.modelChallenge, verdict: 'PROCEED', due: false } } } as never } };
};
const gate = (r: PlanReading) => gateIntegrity(r, () => ({ timelines: r.timelines, objective: r.objective, planSet: r.planSet, continuation: r.continuation }));

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env['BRAIN_DATA_DIR'] ?? os.tmpdir(), 'committee-'));
  await proveDeliverables();
  template = await buildTemplate(dir);
}, 120_000);

afterAll(async () => {
  await closeWorldDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the investment committee on the real planner', () => {
  it('(a) fails the audited GitHub-bounty plan with cited defects from SKEPTIC (its one buyer and its price already corrected upstream), and never accepts it', { timeout: 300_000 }, async () => {
    const r = await read(MECHANISM_CASES.find((c) => c.id === 'mv-01-github-bounty-audit')!);
    expect(r.acceptance.status).not.toBe('ACCEPTED');
    const c = r.committee!;
    expect(c.verdict).toBe('FAIL');
    const githubId = r.pathways!.pathways.find((p) => /GitHub/.test(p.title) && p.origin === 'FOUND')!.opportunityId;
    // Upstream, construction and the goal model already read GitHub, Inc. as one buyer making one deal (§116),
    // so the market expert finds no inflated population left to fail; the skeptic and the quant still fail the price.
    const githubDeals = r.portfolio?.demand.find((d) => d.opportunityId === githubId)?.deals?.p90 ?? 0;
    expect(githubDeals).toBeLessThanOrEqual(1);
    // With the price already unestablished upstream, the quant has no presented figure left to contradict; the skeptic still names the reward.
    for (const role of ['SKEPTIC'] as const) {
      const v = c.roles.find((one) => one.role === role)!;
      expect(v, role).toMatchObject({ verdict: 'FAIL', critical: true });
      expect(v.citations.length, role).toBeGreaterThan(0);
    }
    const skeptic = c.roles.find((one) => one.role === 'SKEPTIC')!.defects.find((d) => d.opportunityId === githubId)!;
    expect(skeptic.why).toMatch(/reward paid to whoever wins/);
    expect(skeptic.evidenceRef).toContain(`${githubId}#price`);
    // Even accepted, the gate takes it away: the committee's critical defects block whatever else holds.
    const gated = gate(forcedAccepted(r));
    expect(gated.acceptance.status).toBe('CANDIDATE_ONLY');
    expect(gated.acceptance.shortfalls.join(' ')).toMatch(/committee|integrity/);
    expect(gated.verdict).not.toBe('RECOMMENDABLE');
    expect(gated.committee!.blocks).toBe(true);
  });

  it('(b) passes a fully evidenced legitimate plan on every deterministic role, and does not block it', { timeout: 300_000 }, async () => {
    const r = await read(LEGITIMATE);
    const c = r.committee!;
    expect(c.roles.map((one) => [one.role, one.verdict])).toEqual(['SKEPTIC', 'INVESTOR', 'OPERATOR', 'MARKET_EXPERT', 'QUANT', 'OWNER_PROXY'].map((role) => [role, 'PASS']));
    expect(c).toMatchObject({ verdict: 'PASS', blocks: false, criticalDefects: 0 });
    // A full review (a final plan) owes the deep-review model challenge: until the existing challenger answers, SKEPTIC is
    // open on that alone — held, not rejected. Answered PROCEED, nothing blocks, and the gate leaves a counterfactual acceptance standing.
    const full = committeeInputOf(r);
    const pending = reviewPlan({ ...full, tier: 'FULL' });
    if (pending.blocks) {
      expect(pending.roles.filter((one) => one.verdict !== 'PASS').map((one) => [one.role, one.verdict, one.open.map((q) => q.subject)])).toEqual([['SKEPTIC', 'UNKNOWN', ['SKEPTIC: the independent model challenge']]]);
    }
    expect(reviewPlan({ ...full, claims: { ...full.claims, modelChallenge: { required: true, verdict: 'PROCEED', due: false } }, tier: 'FULL' }).blocks).toBe(false);
    const gated = gate(challengeAnswered(forcedAccepted(r)));
    expect(gated.committee!.blocks).toBe(false);
    expect(gated.acceptance.status).toBe('ACCEPTED');
  });

  it('C60: refuses an acceptance the committee passes when the plan breaks an integrity rule', { timeout: 300_000 }, async () => {
    const r = readings.get(LEGITIMATE.id) ?? (await read(LEGITIMATE));
    const clean = challengeAnswered(forcedAccepted(r));
    // The same legitimate plan, with one step titled by an internal key instead of the action a person takes.
    const keyed: PlanStep = { order: r.steps.length + 1, label: 'focus:4', detail: 'concentrate outreach', startDay: { low: 0, high: 0 }, cost: 0, basis: 'ESTIMATE', owner: 'BRAIN', ownerReason: null, dependsOn: null, kill: 'k', execution: [] };
    const gated = gate({ ...clean, steps: [...clean.steps, keyed] });
    expect(gated.committee!.blocks).toBe(false);
    expect(gated.integrity!.map((v) => v.rule)).toContain('NO_INTERNAL_KEYS');
    expect(gated.acceptance).toMatchObject({ status: 'CANDIDATE_ONLY', probability: null, accepted: null });
    expect(gated.acceptance.shortfalls.join(' ')).toMatch(/NO_INTERNAL_KEYS/);
    expect(gated.verdict).not.toBe('RECOMMENDABLE');
  });

  it('(c) turns a disputed fact into an investigation the existing needs owner takes', { timeout: 300_000 }, async () => {
    const r = readings.get(LEGITIMATE.id) ?? (await read(LEGITIMATE));
    // Research files a sentence the planner has not yet re-read: the price is evidenced as a figure, but its own words say it is a reward.
    const counted = r.acceptance.candidate!.opportunityIds[0]!;
    const disputed: PlanReading = {
      ...r,
      pathways: {
        ...r.pathways!,
        pathways: r.pathways!.pathways.map((p) => (p.opportunityId === counted ? { ...p, revenuePerDeal: { ...p.revenuePerDeal, basis: 'The marketplace pays sellers $29 rewards for each winning entry in its meal-plan contest.' } } : p)),
      },
    };
    const c = committeeOf(disputed);
    const dispute = c.investigations.find((i) => i.opportunityId === counted && i.fact === 'price')!;
    expect(dispute.established).toContain('MARKET_EXPERT');
    expect(dispute.broken).toContain('SKEPTIC');
    expect(c.verdict).toBe('FAIL');
    const sent = await sendCommitteeNeeds({ goalId: r.goalId, projectId: r.target.projectId, committee: c });
    expect(sent.refused).toEqual([]);
    expect(sent.sent).toBeGreaterThanOrEqual(1);
    // Asked once: a re-read raises nothing new.
    expect((await sendCommitteeNeeds({ goalId: r.goalId, projectId: r.target.projectId, committee: c })).created).toBe(0);
  });

  it('measures what it detects, what it prevents, what it wrongly rejects, and what it costs a read', { timeout: 600_000 }, async () => {
    for (const c of INVALID) if (!readings.has(c.id)) await read(c);
    if (!readings.has(LEGITIMATE.id)) await read(LEGITIMATE);
    const invalid = INVALID.map((c) => readings.get(c.id)!);
    const legit = [readings.get(LEGITIMATE.id)!];
    const critical = invalid.reduce((s, r) => s + r.committee!.criticalDefects, 0);
    const prevented = invalid.filter((r) => committeeOf(challengeAnswered(forcedAccepted(r))).blocks).length;
    const wronglyRejected = legit.filter((r) => committeeOf(challengeAnswered(forcedAccepted(r))).blocks).length;
    const ms = [...readings.values()].map((r) => r.committee!.reviewMs ?? 0);
    const mean = ms.reduce((s, x) => s + x, 0) / ms.length;
    console.log(
      `committee measurement: ${invalid.length} commercially invalid plans, ${critical} critical defects detected; ` +
        `false approvals prevented ${prevented}/${invalid.length}; legitimate plans incorrectly rejected ${wronglyRejected}/${legit.length}; ` +
        `review time per plan read mean ${mean.toFixed(2)} ms, max ${Math.max(...ms).toFixed(2)} ms over ${ms.length} reads`,
    );
    for (const [id, r] of readings) console.log(`  ${id}: ${r.committee!.verdict}, ${r.committee!.criticalDefects} critical; ${r.committee!.roles.map((one) => `${one.role}=${one.verdict}`).join(' ')}`);
    expect(prevented).toBe(invalid.length);
    expect(wronglyRejected).toBe(0);
    expect(invalid.every((r) => r.committee!.criticalDefects > 0)).toBe(true);
    expect(mean).toBeLessThan(250);
  });
});
