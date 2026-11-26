/**
 * The investment committee (§117): each role's deterministic layer on its own,
 * the combination without a vote, disputes as investigations, the tier, the
 * specialist questions carrying only the objective and the evidence, and the
 * acceptance it refuses (`refuseForCommittee`). Pure; the planner-backed cases
 * are in tests/investmentCommitteeWorld.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { committeeNeeds, committeeTier, evidencedReach, reviewPlan, reviewRole, type CommitteeInput, type CommitteeLeg } from '../server/services/goals/committee.ts';
import type { PathFact } from '../server/services/goals/pathways.ts';
import { refuseForCommittee, type PlanAcceptance } from '../server/services/goals/plan.ts';
import { goalCommitteeScope, sendCommitteeNeeds } from '../server/services/goals/portfolioNeeds.ts';

const fact = (value: number | string | null, status: PathFact['status'] = 'PROVEN', basis = 'evidence on the card', low: number | null = typeof value === 'number' ? value : null, high: number | null = low): PathFact => ({ value, low, high, status, basis });

const leg = (over: { id?: string; scope?: CommitteeLeg['scope']; path?: Record<string, unknown>; demand?: Record<string, unknown> | null } = {}): CommitteeLeg => ({
  opportunityId: over.id ?? 'cop_meal',
  scope: over.scope ?? 'COUNTED',
  pathway: {
    title: 'Allergen meal-plan spreadsheet for marketplace shoppers',
    origin: 'FOUND',
    buyer: fact('Marketplace shoppers planning allergen-free meals'),
    channel: fact('The marketplace listing'),
    offer: fact('Allergen meal-plan spreadsheet', 'ESTIMATED'),
    fulfiller: fact('Brain produces it: spreadsheet', 'ESTIMATED'),
    revenuePerDeal: fact(29, 'PROVEN', 'Comparable allergen meal-plan spreadsheets sell for $29 on the marketplace'),
    fulfilmentCost: fact(3),
    acquisitionCost: fact(null, 'UNKNOWN'),
    volume: fact(40, 'PROVEN', '40 reachable buyers'),
    daysToCash: fact(3),
    capital: fact(0),
    gaps: [],
    contribution: { p10: 400, p50: 900, p90: 1040 },
    permissionsMissing: ['CONTACT_BUYER'],
    ...(over.path ?? {}),
  } as CommitteeLeg['pathway'],
  demand: over.demand === null ? null : ({ deals: { p10: 16, p50: 36, p90: 40 }, price: { p10: 29, p50: 29, p90: 29 }, unestablished: [], capitalAtStart: 0, repeatable: true, ...(over.demand ?? {}) } as CommitteeLeg['demand']),
});

const input = (legs: CommitteeLeg[], over: Partial<CommitteeInput['claims']> = {}, ev: Partial<CommitteeInput['evidence']> = {}, tier: CommitteeInput['tier'] = 'ROUTINE'): CommitteeInput => ({
  evidence: { goalId: 'wst_x', objective: 'settled cash of $1,000 more within 30 days', remaining: 1000, daysLeft: 30, capitalCeiling: null, currency: 'USD', legs, ...ev },
  claims: { reach: 0.47, reachBasis: 'COVERAGE', probability: null, portfolioBasis: 'COVERAGE', settledP50: 1073, presentedHigh: 1000, adverse: 468, pathwayP10: 447, keptP50: 900, modelChallenge: null, ...over },
  tier,
});

/** The audited GitHub leg (docs/audits/2026-11-23-10k-plan-audit.md) as the transaction model held it. */
const github = leg({
  id: 'cop_github',
  scope: 'PRESENTED',
  path: {
    title: 'Security programming deliverable for GitHub',
    buyer: fact('GitHub, Inc.'),
    channel: fact(null, 'UNKNOWN'),
    fulfiller: fact(null, 'UNKNOWN'),
    revenuePerDeal: fact(null, 'UNKNOWN', 'not a price: the only figure on record is a reward paid to whoever wins, finds or submits first ("pays security researchers $10,000 for a critical vulnerability")', 10_000, 10_000),
    fulfilmentCost: fact(355),
    volume: fact(null, 'UNKNOWN', 'nobody has established how many buyers exist', 1, 200),
    gaps: ['NO_CHANNEL', 'NO_PRICE', 'NO_SUPPLIER', 'NOT_A_PURCHASE', 'ONE_PAYER_REPEATS', 'VOLUME_UNEVIDENCED'],
    contribution: { p10: 0, p50: 195, p90: 159_142 },
  },
  demand: { deals: { p10: 0, p50: 0, p90: 0 }, price: { p10: 10_000, p50: 10_000, p90: 10_000 }, unestablished: ['price', 'deals the market can take'], capitalAtStart: 0, repeatable: true },
});
const templates = leg({ id: 'cop_templates', path: { title: 'Spreadsheet templates for small business operators', buyer: fact('Small business operators'), channel: fact(null, 'UNKNOWN'), revenuePerDeal: fact(9, 'PROVEN', 'the price on the card'), fulfilmentCost: fact(0.47), volume: fact(null, 'UNKNOWN', 'nobody has established how many', 1, 200), contribution: { p10: 0, p50: 3, p90: 30 } }, demand: { deals: { p10: 0, p50: 0, p90: 0 }, price: { p10: 9, p50: 9, p90: 9 } } });
const audited = input([templates, github], { reach: 0, presentedHigh: 10_000, settledP50: 0, adverse: 0, pathwayP10: 0 }, { remaining: 10_000, daysLeft: 16, capitalCeiling: 375, objective: 'settled cash of $10,000 more within 16 days, tying up at most $375' });

describe('each role on its own', () => {
  it('SKEPTIC fails a non-purchase counted as a price, price evidence about another market, two readings of one price, and a constructed market counted', () => {
    const s = reviewRole('SKEPTIC', audited);
    expect(s.verdict).toBe('FAIL');
    expect(s.critical).toBe(true);
    expect(s.defects[0]).toMatchObject({ opportunityId: 'cop_github', fact: 'price', critical: true });
    expect(s.defects[0]!.why).toMatch(/reward paid to whoever wins/);
    expect(s.defects[0]!.evidenceRef).toMatch(/^cop_github#price: "not a price/);
    const offTopic = leg({ path: { revenuePerDeal: fact(1200, 'PROVEN', 'Software Advice analyzed data from HVAC contractors: field-service management seats cost $1,200 a year') } });
    expect(reviewRole('SKEPTIC', input([offTopic])).defects[0]!.why).toMatch(/names another market/);
    const twoPrices = leg({ demand: { price: { p10: 90, p50: 90, p90: 90 } } });
    expect(reviewRole('SKEPTIC', input([twoPrices])).defects[0]!.why).toMatch(/more than twofold apart/);
    const invented = leg({ id: 'arr_x', path: { origin: 'CONSTRUCTED', buyer: fact('the constructed design names this buyer kind', 'ESTIMATED') } });
    expect(reviewRole('SKEPTIC', input([invented])).defects[0]).toMatchObject({ fact: 'buyer', critical: false });
    expect(reviewRole('SKEPTIC', input([leg()])).verdict).toBe('PASS');
  });

  it('SKEPTIC reads the existing independent model challenge: REVISE fails, a due challenge is open on a final plan only', () => {
    expect(reviewRole('SKEPTIC', input([leg()], { modelChallenge: { required: true, verdict: 'REVISE', due: false } })).verdict).toBe('FAIL');
    expect(reviewRole('SKEPTIC', input([leg()], { modelChallenge: { required: true, verdict: null, due: true } }, {}, 'FULL')).verdict).toBe('UNKNOWN');
    expect(reviewRole('SKEPTIC', input([leg()], { modelChallenge: { required: true, verdict: null, due: true } })).verdict).toBe('PASS');
    // An acceptance on this Brain's measured record of real outcomes already has its independent check.
    expect(reviewRole('SKEPTIC', input([leg()], { modelChallenge: { required: true, verdict: null, due: true }, probability: { value: 0.95, lowerBound: 0.91, basis: 'MEASURED_RECORD' } }, {}, 'FULL')).verdict).toBe('PASS');
  });

  it('MARKET_EXPERT fails one company counted as a population (critical), an unevidenced price or volume, and asks a specialist about an estimate', () => {
    const m = reviewRole('MARKET_EXPERT', audited);
    expect(m.defects.find((d) => d.opportunityId === 'cop_github')).toMatchObject({ fact: 'volume', critical: true });
    expect(m.defects.find((d) => d.opportunityId === 'cop_github')!.why).toMatch(/GitHub, Inc\.".* one organisation/);
    const meridian = leg({ path: { buyer: fact('Meridian Regional Health System'), volume: fact(null, 'UNKNOWN', 'nobody has established', 1, 200) }, demand: { deals: { p10: 1, p50: 3, p90: 14 } } });
    expect(reviewRole('MARKET_EXPERT', input([meridian])).critical).toBe(true);
    const estimated = leg({ path: { volume: fact(40, 'ESTIMATED', 'inferred') } });
    const r = reviewRole('MARKET_EXPERT', input([estimated]));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.open[0]!.fact).toBe('volume');
    expect(reviewRole('MARKET_EXPERT', input([leg()])).verdict).toBe('PASS');
  });

  it('OPERATOR fails no channel, no fulfiller and cash after the deadline (critical); a permission is a citation, never a defect', () => {
    const o = reviewRole('OPERATOR', input([leg({ path: { channel: fact(null, 'UNKNOWN'), fulfiller: fact(null, 'UNKNOWN') } })]));
    expect(o.defects.map((d) => d.fact).sort()).toEqual(['channel', 'fulfilment']);
    const late = reviewRole('OPERATOR', input([leg({ path: { daysToCash: fact(45) } })]));
    expect(late.defects[0]).toMatchObject({ fact: 'payment', critical: true });
    const ok = reviewRole('OPERATOR', input([leg()]));
    expect(ok.verdict).toBe('PASS');
    expect(ok.citations.join(' ')).toMatch(/waits on CONTACT_BUYER/);
    expect(reviewRole('OPERATOR', input([leg({ path: { daysToCash: fact(null, 'UNKNOWN', 'nobody has established', 3, 60) } })])).verdict).toBe('UNKNOWN');
  });

  it('INVESTOR fails capital over the ceiling and a losing deal (critical), and a plan carried by one unevidenced leg', () => {
    expect(reviewRole('INVESTOR', input([leg({ demand: { capitalAtStart: 2000 } })], {}, { capitalCeiling: 500 })).defects[0]).toMatchObject({ fact: 'capital', critical: true });
    expect(reviewRole('INVESTOR', input([leg({ path: { fulfilmentCost: fact(40) } })])).defects[0]).toMatchObject({ fact: 'economics', critical: true });
    const i = reviewRole('INVESTOR', audited);
    expect(i.defects[0]!.claim).toMatch(/98% of the plan's expected money comes from "Security programming deliverable for GitHub"/);
    expect(reviewRole('INVESTOR', input([leg()])).verdict).toBe('PASS');
  });

  it('QUANT reconstructs the figures from the evidence, refuses coverage as a probability, and sets the two estimators against each other', () => {
    const q = reviewRole('QUANT', audited);
    expect(q.defects[0]).toMatchObject({ fact: 'reach', critical: true });
    expect(q.defects[0]!.why).toMatch(/at most \$9/);
    expect(evidencedReach(audited.evidence.legs).total).toBeCloseTo(8.53, 1);
    expect(evidencedReach([leg()]).total).toBe(40 * 26);
    const claimed = reviewRole('QUANT', input([leg({ demand: { unestablished: ['reply rate'] } })], { reachBasis: 'PROBABILITY' }));
    expect(claimed.defects.find((d) => d.fact === 'probability')).toMatchObject({ critical: true });
    const apart = reviewRole('QUANT', input([leg()], { adverse: 32_266, pathwayP10: 368 }, { remaining: 10_000 }));
    expect(apart.defects.some((d) => /two downside estimators disagree/.test(d.why))).toBe(true);
    // An agreed deal the pathway ranking leaves out: the evidence rebuilds the higher downside, so it is cited, not failed.
    const backed = reviewRole('QUANT', input([leg()], { adverse: 1000, pathwayP10: 120 }));
    expect(backed.verdict).toBe('PASS');
    expect(backed.citations.join(' ')).toMatch(/downside estimators disagree/);
    expect(reviewRole('QUANT', input([leg()])).verdict).toBe('PASS');
  });

  it('C58: QUANT rebuilds one deal, not the proven volume, from a leg whose repeats all come from one payer (§116)', () => {
    // A hospital system's purchase history proves 12 orders a year, but every one is the same payer: a second deal is not evidenced.
    const meridian = leg({
      id: 'cop_meridian',
      path: {
        title: 'Staff allergen-awareness handouts for Meridian Regional Health System',
        buyer: fact('Meridian Regional Health System'),
        revenuePerDeal: fact(450, 'PROVEN', 'Meridian paid $450 for the last handout pack (invoice on file)'),
        fulfilmentCost: fact(50),
        volume: fact(12, 'PROVEN', "12 orders in the last 12 months on Meridian's own purchase history"),
        gaps: ['ONE_PAYER_REPEATS'],
        contribution: { p10: 400, p50: 2_400, p90: 4_800 },
      },
      demand: { deals: { p10: 1, p50: 6, p90: 12 }, price: { p10: 450, p50: 450, p90: 450 } },
    });
    const rebuilt = evidencedReach([meridian]);
    expect(rebuilt.byLeg).toEqual([{ opportunityId: 'cop_meridian', deals: 1, net: 400, amount: 400 }]);
    const q = reviewRole('QUANT', input([meridian], { reach: 0.62, presentedHigh: 4_800, settledP50: 2_400 }, { remaining: 4_000 }));
    expect(q.verdict).toBe('FAIL');
    expect(q.defects[0]).toMatchObject({ fact: 'reach', critical: true });
    expect(q.defects[0]!.why).toMatch(/at most \$400/);
  });

  it('OWNER_PROXY fails speculation dressed as repeatable business (critical), routine owner delivery, and a goal the evidence does not reach', () => {
    const o = reviewRole('OWNER_PROXY', audited);
    expect(o.defects.find((d) => d.opportunityId === 'cop_github')).toMatchObject({ fact: 'mechanism', critical: true });
    expect(o.defects.some((d) => /evidence supports \$9 of the \$10,000/.test(d.why))).toBe(true);
    const owner = reviewRole('OWNER_PROXY', input([leg({ path: { fulfiller: fact('The owner, personally') } })]));
    expect(owner.defects[0]!.why).toMatch(/routine owner work/);
    expect(reviewRole('OWNER_PROXY', input([leg({ id: 'arr_y', path: { origin: 'CONSTRUCTED' } })])).defects.some((d) => /speculation/.test(d.why))).toBe(true);
    expect(reviewRole('OWNER_PROXY', input([leg()])).verdict).toBe('PASS');
  });
});

describe('the committee', () => {
  it('fails the audited plan on independent critical defects from SKEPTIC, MARKET_EXPERT and QUANT, and blocks', () => {
    const c = reviewPlan(audited);
    expect(c.verdict).toBe('FAIL');
    expect(c.blocks).toBe(true);
    for (const role of ['SKEPTIC', 'MARKET_EXPERT', 'QUANT'] as const) expect(c.roles.find((r) => r.role === role)).toMatchObject({ verdict: 'FAIL', critical: true });
    expect(c.criticalDefects).toBeGreaterThanOrEqual(4);
    expect(c.blocker).toMatch(/\(critical\)/);
  });

  it('blocks on one critical defect however many roles pass: never a majority', () => {
    const late = input([leg({ path: { daysToCash: fact(45) } })]);
    const c = reviewPlan(late);
    expect(c.roles.filter((r) => r.verdict === 'PASS')).toHaveLength(5);
    expect(c.verdict).toBe('FAIL');
    expect(c.blocks).toBe(true);
  });

  it('passes a fully evidenced plan; on a final plan an unsettled role keeps it a candidate', () => {
    const ok = reviewPlan(input([leg()], {}, {}, 'FULL'));
    expect(ok).toMatchObject({ verdict: 'PASS', blocks: false, criticalDefects: 0, blocker: null });
    const unsettled = leg({ path: { daysToCash: fact(null, 'UNKNOWN', 'nobody has established when the money settles', 3, 20) } });
    const open = reviewPlan(input([unsettled], {}, {}, 'FULL'));
    expect(open).toMatchObject({ verdict: 'UNKNOWN', blocks: true });
    expect(open.blocker).toMatch(/OPERATOR could not settle/);
    expect(reviewPlan(input([unsettled])).blocks).toBe(false);
    // An estimated volume cannot carry the figure: QUANT rebuilds one deal from it, and that is a defect, not an open question.
    expect(reviewPlan(input([leg({ path: { volume: fact(40, 'ESTIMATED', 'inferred') } })], {}, {}, 'FULL')).roles.find((r) => r.role === 'QUANT')!.verdict).toBe('FAIL');
  });

  it('turns two roles reading one fact the opposite way into a targeted investigation, and the FAIL still stands', () => {
    // The price is evidenced as a figure (MARKET_EXPERT) but its own words say it is a reward (SKEPTIC).
    const disputed = leg({ path: { title: 'Bounty rewards for valid findings in disclosure programs', revenuePerDeal: fact(1500, 'PROVEN', '$1500') } });
    const c = reviewPlan(input([disputed]));
    expect(c.investigations).toHaveLength(1);
    expect(c.investigations[0]).toMatchObject({ opportunityId: 'cop_meal', fact: 'price', broken: ['SKEPTIC'] });
    expect(c.investigations[0]!.established).toContain('MARKET_EXPERT');
    expect(c.investigations[0]!.question).toMatch(/disputed/);
    expect(c.verdict).toBe('FAIL');
    const needs = committeeNeeds(c);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ route: 'RESEARCH', subject: 'committee dispute: price of cop_meal' });
  });

  it("asks specialists only on a final plan, with the objective and the evidence and none of the planner's conclusions", () => {
    const unsettled = leg({ path: { daysToCash: fact(null, 'UNKNOWN', 'nobody has established when the money settles', 3, 20) } });
    expect(committeeNeeds(reviewPlan(input([unsettled])))).toEqual([]);
    const full = reviewPlan(input([unsettled], { reach: 0.97 }, {}, 'FULL'));
    const [need] = committeeNeeds(full);
    expect(need!.question).toMatch(/^Independent review\. Objective: settled cash of \$1,000 more within 30 days\./);
    expect(need!.question).toMatch(/days to cash: nothing on record/);
    expect(need!.question).toMatch(/price: "Comparable allergen meal-plan spreadsheets sell for \$29/);
    expect(need!.question).not.toMatch(/\b97|\breach\b|ACCEPTED|CANDIDATE|probability/i);
  });

  it('sends its questions through the existing needs owner, keyed per goal', async () => {
    const sent: unknown[] = [];
    const c = reviewPlan(input([leg({ path: { title: 'Bounty rewards for valid findings in disclosure programs', revenuePerDeal: fact(1500, 'PROVEN', '$1500') } })]));
    const out = await sendCommitteeNeeds({ goalId: 'wst_x', projectId: 'prj_x', committee: c }, { sendNeeds: async (i) => (sent.push(i), i.needs.map((n) => ({ subject: n.subject, sent: true as const, to: 'RESEARCH_CANDIDATE' as const, ref: 'k_1', created: true }))) });
    expect(out).toMatchObject({ sent: 1, created: 1 });
    expect(sent[0]).toMatchObject({ projectId: 'prj_x', graphScope: goalCommitteeScope('wst_x') });
  });

  it('earns a full review for a final plan or a material commitment, never for the ledger itself', () => {
    expect(committeeTier({ accepted: true, targetMet: false, capitalCommitted: 0, remaining: 1000 })).toBe('FULL');
    expect(committeeTier({ accepted: true, targetMet: true, capitalCommitted: 0, remaining: 0 })).toBe('ROUTINE');
    expect(committeeTier({ accepted: false, targetMet: false, capitalCommitted: 2000, remaining: 10_000 })).toBe('FULL');
    expect(committeeTier({ accepted: false, targetMet: false, capitalCommitted: 100, remaining: 10_000 })).toBe('ROUTINE');
  });
});

describe('refuseForCommittee', () => {
  const accepted = { status: 'ACCEPTED', required: 0.9, probability: { value: 0.95, lowerBound: 0.91, basis: 'MEASURED_RECORD', sample: 40, note: 'x' }, accepted: { label: 'a', opportunityIds: ['cop_github'] }, candidate: { label: 'a', opportunityIds: ['cop_github'], source: 'STRATEGY', settledP50: 10_000, reach: 0.98, reachBasis: 'COVERAGE' }, shortfalls: [], sentence: 'Accepted.' } as PlanAcceptance;

  it('takes an acceptance away with the committee blocker first, and never grants one', () => {
    const c = reviewPlan({ ...audited, tier: 'FULL' });
    const refused = refuseForCommittee(accepted, c);
    expect(refused.status).toBe('CANDIDATE_ONLY');
    expect(refused.probability).toBeNull();
    expect(refused.accepted).toBeNull();
    expect(refused.shortfalls[0]).toMatch(/^committee (SKEPTIC|MARKET_EXPERT|QUANT|INVESTOR|OWNER_PROXY|OPERATOR)/);
    expect(refused.sentence).toMatch(/^Not accepted: the investment committee failed the plan/);
    const passing = reviewPlan(input([leg()], {}, {}, 'FULL'));
    expect(refuseForCommittee(accepted, passing)).toBe(accepted);
    const candidate = { ...accepted, status: 'CANDIDATE_ONLY' } as PlanAcceptance;
    expect(refuseForCommittee(candidate, c)).toBe(candidate);
  });
});
