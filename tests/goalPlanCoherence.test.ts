/**
 * The plan read's coherence repairs (planning recovery, C-6..C-13):
 *
 *   C-7  a simulated world is not evidence: acceptance reads the engine's own
 *        assurance over the smallest real sample, never a Wilson bound over worlds;
 *   C-6  one plan: the reconstruction becomes the candidate when it beats the
 *        plan as held, or the reading says it is hypothetical and why;
 *   C-10 a goal arithmetic rules out reads NOT_SUPPORTED and stops widening,
 *        while a goal whose openings are merely weak keeps searching (§65);
 *   C-8  the adopted plan is a sequence of steps with owners and kill criteria;
 *   C-9  research is asked of the adopted plan's own conditions, and the brief
 *        follows what binds;
 *   C-11 search churn does not rewrite the plan's history;
 *   C-13 a failure inside the read is carried on it and recorded.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  adoptReconstruction,
  collectsOutsideWindow,
  continueSearch,
  judgeAcceptance,
  judgeFeasibility,
  notSupported,
  planResearchPriority,
  planSearchBrief,
  planSteps,
  readingDigest,
  reconstructionDigest,
  reconstructionFor,
  recordDegraded,
  stepAsNextTest,
  type PlanAcceptance,
  type PlanReading,
  type StrategyReading,
  withholdImplausibleFigures,
  withoutFigures,
} from '../server/services/goals/plan.ts';
import { planFieldsFor } from '../server/services/goals/pathResearch.ts';
import { goalPlanScope, sendPlanQuestions } from '../server/services/goals/portfolioNeeds.ts';
import { requiredStructures } from '../server/services/goals/pathways.ts';
import type { Reconstruction, StrategyChange, VariantReading } from '../server/services/goals/reconstruction.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS } from './fixtures/goal10k.ts';
import { listEvents } from '../server/repos/events.ts';

function portfolio(over: Partial<GoalPortfolio> & { reach?: number; ids?: string[] } = {}): GoalPortfolio {
  const ids = over.ids ?? ['o1'];
  return {
    basis: 'PROBABILITY',
    worlds: 2000,
    best: { members: ids.map((id) => ({ opportunityId: id, title: `Opening ${id}`, share: 1 })), reach: over.reach ?? 0.95, settledP10: 9000, settledP50: 12000, settledP90: 15000, capitalShort: 0, overSpend: 0 },
    alternatives: [],
    demand: [],
    limits: { target: 10_000, deadlineDays: 30, startingCapital: 375, perArrangement: 375, spendCeiling: 3000, contactsPerDay: { value: 945, low: 400, high: 945, source: 'measured' }, correlation: 0.5 },
    missing: [],
    searched: 1,
    ...over,
  } as GoalPortfolio;
}

function variant(over: Partial<VariantReading> = {}): VariantReading {
  return { key: 'as planned', changes: [], reach: 0.011, settledP10: 0, settledP50: 650, settledP90: 2000, basis: 'COVERAGE', committed: 0, feasible: true, why: null, members: ['Opening o1'], ...over };
}

const change = (over: Partial<StrategyChange>): StrategyChange => ({ dimension: 'TRANSACTION', label: 'bundle ×9', detail: 'sell nine units as one bundle', cost: 0, basis: 'ASSUMPTION', ...over });

function reconstruction(over: Partial<Reconstruction> = {}): Reconstruction {
  const best = variant({
    key: 'ACQUISITION:marketplace leads + CASH_TIMING:deposit + TRANSACTION:bundle ×9',
    reach: 0.979,
    settledP50: 14_000,
    members: ['Opening o1', 'Opening o2'],
    changes: [
      change({ dimension: 'CASH_TIMING', label: 'deposit at signing', detail: 'take 50% at signing', startDay: { low: 3, high: 5 } }),
      change({ dimension: 'ACQUISITION', label: 'marketplace leads', detail: 'buy qualified marketplace leads', cost: 300, basis: 'ESTIMATE', startDay: { low: 0, high: 1 } }),
      change({ dimension: 'TRANSACTION', label: 'bundle ×9', detail: 'sell nine units as one bundle', startDay: { low: 1, high: 2 } }),
    ],
  });
  // The same plan with its assumed moves (deposit, bundle) taken away: the marketplace leads alone (invariant 39).
  const established = variant({ key: 'ACQUISITION:marketplace leads @no-assumptions', reach: 0.4, settledP50: 6_000, members: ['Opening o1', 'Opening o2'], changes: best.changes.filter((c) => c.basis !== 'ASSUMPTION') });
  return {
    required: 0.9,
    baseline: variant(),
    established,
    diagnosis: [
      { factor: 'REPLY', moved: 'reply ×3', reach: 0.3, settledP50: 4000, liftReach: 0.29, liftP50: 3350 },
      { factor: 'CAPITAL', moved: 'limits ×2', reach: 0.02, settledP50: 700, liftReach: 0.009, liftP50: 50 },
    ],
    headroom: { reach: 0.6, settledP50: 9000 },
    structural: true,
    challenges: [],
    rounds: [],
    best,
    floor: variant({ reach: 0.2 }),
    requiredReply: 0.012,
    volumePlans: [],
    limitation: null,
    confidence: { basis: 'COVERAGE', measured: [], assumed: [], statement: '' },
    searchBrief: 'Reconstruction (§99): the fixed template.',
    evaluations: 10,
    exploration: null,
    flags: [],
    ...over,
  } as Reconstruction;
}

const openings = [
  { opportunity: { id: 'o1', title: 'Opening o1' } },
  { opportunity: { id: 'o2', title: 'Opening o2' } },
];

describe('C-7: simulated worlds are not evidence', () => {
  it('does not accept a 95% reach over 2000 worlds whose assurance does not claim 90% (repro6)', () => {
    const p = portfolio({
      missing: ['the best combination reaches the target in 95% of worlds, which is not a defensible 90%: strongest defensible range is 75%–99% (smallest sample 12)'],
      assurance: { claimsAtLeast90: false, range: { low: 0.75, high: 0.99 } } as GoalPortfolio['assurance'],
    });
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: p, measuredChance: null, considered: [{ opportunityId: 'o1', missing: [] }] });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.probability).toBeNull();
    expect(a.shortfalls.join(' ')).toMatch(/simulated worlds are not evidence/);
  });

  it('does not accept a probability-basis combination with no assurance at all', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio({ reach: 0.99 }), measuredChance: null, considered: [{ opportunityId: 'o1', missing: [] }] });
    expect(a.status).toBe('CANDIDATE_ONLY');
  });

  it('accepts on the assurance, reading its lower bound and its smallest sample', () => {
    const p = portfolio({ assurance: { claimsAtLeast90: true, status: 'CLAIMS_AT_LEAST_90', range: { low: 0.93, high: 0.99 }, sample: { events: 140, from: 'STATED' }, reason: 'calibrated evidence (smallest sample 140) puts the lower bound at 93%, above 90%' } as GoalPortfolio['assurance'] });
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: p, measuredChance: null, considered: [{ opportunityId: 'o1', missing: [] }] });
    expect(a.status).toBe('ACCEPTED');
    expect(a.probability).toMatchObject({ basis: 'EVIDENCED_PORTFOLIO', lowerBound: 0.93, sample: 140 });
  });
});

describe('C-6: one plan', () => {
  it('adopts the reconstruction when it beats the plan as held: the candidate is its members, and its reach stays coverage', () => {
    const { adoption, candidate } = adoptReconstruction({ reconstruction: reconstruction(), baseline: portfolio({ reach: 0.011, basis: 'COVERAGE' }), openings });
    expect(adoption).toMatchObject({ source: 'RECONSTRUCTED', hypothetical: false });
    // Was 0.979, the reach with its deposit and bundle assumed accepted: the candidate now carries what holds without them (invariant 39).
    expect(candidate).toMatchObject({ source: 'RECONSTRUCTED', opportunityIds: ['o1', 'o2'], reach: 0.4, reachBasis: 'COVERAGE', assumedUpside: { reach: 0.979 } });
  });

  it('keeps the plan as held and says the reconstruction is hypothetical when it is flagged implausible', () => {
    const base = reconstruction();
    const r = reconstruction({ flags: [{ key: base.best.key, reach: base.best.reach, settledP50: base.best.settledP50, flags: [{ kind: 'RETURN', detail: 'price ×9 with close unchanged' }] }] });
    const out = adoptReconstruction({ reconstruction: r, baseline: portfolio({ reach: 0.011, basis: 'COVERAGE' }), openings });
    expect(out.candidate).toBeNull();
    expect(out.adoption).toMatchObject({ source: 'BASELINE', hypothetical: true });
    expect(out.adoption.reason).toMatch(/implausible.*price ×9/);
  });

  it('a flag on some other reading does not stop the strongest plan being adopted', () => {
    const r = reconstruction({ flags: [{ key: 'TRANSACTION:bundle ×50', reach: 1, settledP50: 900_000, flags: [{ kind: 'DEALS', detail: 'more deals than the market holds' }] }] });
    expect(adoptReconstruction({ reconstruction: r, baseline: portfolio({ reach: 0.011, basis: 'COVERAGE' }), openings }).adoption.source).toBe('RECONSTRUCTED');
  });

  it('keeps the plan as held when the reconstruction does not beat it, and says so', () => {
    const out = adoptReconstruction({ reconstruction: reconstruction(), baseline: portfolio({ reach: 0.98, basis: 'COVERAGE' }), openings });
    expect(out.adoption.hypothetical).toBe(true);
    expect(out.adoption.reason).toMatch(/does not beat the plan as held/);
  });
});

describe('C-10: an infeasible goal is concluded by arithmetic, and only by arithmetic', () => {
  const million = requiredStructures({ remaining: 1_000_000, daysLeft: 2, currency: 'USD', perArrangement: 0, spendCeiling: 0, outreachPerDay: { low: 400, high: 945, stated: true } });
  const tenK = requiredStructures({ remaining: GOAL_10K_LIMITS.remaining, daysLeft: GOAL_10K_LIMITS.daysLeft, currency: 'USD', perArrangement: 375, spendCeiling: 3000, outreachPerDay: { low: 400, high: 945, stated: true } });

  it('reads $1M in 48 hours with $0 as NOT_SUPPORTED, names what to relax, and stops the search', () => {
    const r = reconstruction({ headroom: { reach: 0, settledP50: 1800 }, best: variant({ reach: 0, settledP50: 900 }) });
    const infeasible = judgeFeasibility({ reconstruction: r, structures: million, required: 0.9, remaining: 1_000_000, daysLeft: 2, capitalCeiling: 0 });
    expect(infeasible).not.toBeNull();
    expect(infeasible!.relax.map((one) => one.constraint)).toEqual(['DEADLINE', 'CAPITAL', 'TARGET']);
    expect(infeasible!.relax[0]!.suggestion).toMatch(/at least \d+ days/);
    expect(infeasible!.relax[2]!.suggestion).toMatch(/\$1,800/);
    const base: PlanAcceptance = { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate: null, shortfalls: [], sentence: '' };
    const a = notSupported(base, infeasible!);
    expect(a.status).toBe('NOT_SUPPORTED');
    expect(a.sentence).toMatch(/^INFEASIBLE AS STATED/);
    // A checkout sale is not ruled out by arithmetic in 48 hours, so the search narrows rather than stops (§65; review F2).
    expect(infeasible!.instantOnly).toBe(true);
    expect(a.sentence).toMatch(/keeps searching/);
    expect(continueSearch({ achieved: false, daysLeft: 2, outcomeRecorded: false, policy: 'SQUEEZE', acceptance: a.status, instantOnly: infeasible!.instantOnly })).toBe(true);
  });

  it('stops the search when no structure at all, instant sales included, can close the gap', () => {
    const none = requiredStructures({ remaining: 1_000_000, daysLeft: 0, currency: 'USD', perArrangement: 0, spendCeiling: 0, outreachPerDay: { low: 400, high: 945, stated: true } });
    const r = reconstruction({ headroom: { reach: 0, settledP50: 0 }, best: variant({ reach: 0, settledP50: 0 }) });
    const infeasible = judgeFeasibility({ reconstruction: r, structures: none, required: 0.9, remaining: 1_000_000, daysLeft: 0, capitalCeiling: 0 })!;
    expect(infeasible.instantOnly).toBe(false);
    const base: PlanAcceptance = { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate: null, shortfalls: [], sentence: '' };
    const a = notSupported(base, infeasible);
    expect(a.sentence).toMatch(/stops widening/);
    expect(continueSearch({ achieved: false, daysLeft: 1, outcomeRecorded: false, policy: 'SQUEEZE', acceptance: a.status, instantOnly: infeasible.instantOnly })).toBe(false);
  });

  it('never reads the $10K goal as infeasible: weak openings are a reason to search, not a verdict (§65)', () => {
    // Even with the openings held reaching nothing at their best, outreach-sized structures exist.
    expect(tenK.structures.some((one) => one.verdict === 'OUTREACH_CAN_CARRY' || one.verdict === 'ONLY_AT_BEST_CONVERSION')).toBe(true);
    const r = reconstruction({ headroom: { reach: 0, settledP50: 0 } });
    expect(judgeFeasibility({ reconstruction: r, structures: tenK, required: 0.9, remaining: 10_000, daysLeft: 30, capitalCeiling: 3000 })).toBeNull();
    expect(continueSearch({ achieved: false, daysLeft: 30, outcomeRecorded: false, policy: 'SQUEEZE', acceptance: 'CANDIDATE_ONLY' })).toBe(true);
  });

  it('a reconstruction with headroom over the requirement is never infeasible, whatever the structures', () => {
    expect(judgeFeasibility({ reconstruction: reconstruction({ headroom: { reach: 0.95, settledP50: 20_000 }, structural: false }), structures: million, required: 0.9, remaining: 1_000_000, daysLeft: 2, capitalCeiling: 0 })).toBeNull();
  });

  it('stops widening past the deadline and once an outcome is recorded', () => {
    expect(continueSearch({ achieved: false, daysLeft: 0, outcomeRecorded: false, policy: 'SQUEEZE', acceptance: 'CANDIDATE_ONLY' })).toBe(false);
    expect(continueSearch({ achieved: false, daysLeft: -3, outcomeRecorded: false, policy: 'EVIDENCE_FIRST', acceptance: 'NO_CANDIDATE' })).toBe(false);
    expect(continueSearch({ achieved: false, daysLeft: 5, outcomeRecorded: true, policy: 'SQUEEZE', acceptance: 'CANDIDATE_ONLY' })).toBe(false);
    expect(continueSearch({ achieved: false, daysLeft: null, outcomeRecorded: false, policy: 'EVIDENCE_FIRST', acceptance: 'NO_CANDIDATE' })).toBe(true);
  });
});

describe('C-8: the adopted plan is a sequence of steps', () => {
  const r = reconstruction();
  const adoption = { source: 'RECONSTRUCTED' as const, hypothetical: false, reason: 'beats it' };
  const permissionsMissing = ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'Instantly connected (messaging)', 'a billing provider'];
  const steps = planSteps({ adoption, reconstruction: r, sales: [], nextTest: null, permissionsMissing });

  it('orders the changes by start day, ends with the sale and the collection, and names each step\'s basis, cost and dependency', () => {
    // A step is titled by what the change does, never by the reconstruction's key (stepTitle.ts).
    expect(steps.map((s) => s.label)).toEqual(['Buy qualified marketplace leads', 'Sell nine units as one bundle', 'Take 50% at signing', "Sell the plan's openings", 'Collect payment']);
    expect(steps[0]).toMatchObject({ order: 1, cost: 300, basis: 'ESTIMATE', dependsOn: null });
    expect(steps[1]).toMatchObject({ basis: 'ASSUMPTION', dependsOn: 1 });
    expect(steps[2]).toMatchObject({ dependsOn: 2 });
    // Selling starts once the changes are in place; the model prices no cost of selling or collecting, so neither is 0.
    expect(steps[3]).toMatchObject({ dependsOn: 3, startDay: { low: 5, high: 5 }, cost: null });
    // No member's days to usable cash are held: the collection names what sets its day.
    // Collecting commits nothing before the buyer pays: the provider's fee comes out of the payment (NOT_OWNERS).
    expect(steps[4]).toMatchObject({ dependsOn: 4, startDay: null, cost: 0, stage: { stage: 'COLLECT', costSource: 'NOT_OWNERS', unscheduled: 'NO_MODEL_DAYS' } });
  });

  it('gives a person only rule-11 kinds: a payment is the owner\'s, the rest is Brain\'s', () => {
    expect(steps[0]).toMatchObject({ owner: 'PERSON' });
    expect(steps[0]!.ownerReason).toMatch(/payment of \$300/);
    expect(steps.slice(1).every((s) => s.owner === 'BRAIN')).toBe(true);
  });

  it('states the measurement that kills each step, from the reply rate the plan needs', () => {
    expect(steps[0]!.kill).toMatch(/reply rate under 1\.2% after \d[\d,]* sends → stop and re-plan/);
    expect(steps[1]!.kill).toMatch(/fewer than 1 in 10 offered buyers accepts "Sell nine units as one bundle"/);
    expect(steps[2]!.kill).toMatch(/deposit/);
  });

  it('lists contact permission, invoicing and billing as execution dependencies, never as owners or blockers of the plan', () => {
    expect(steps[0]!.execution).toEqual(['CONTACT_BUYER', 'Instantly connected (messaging)']);
    expect(steps[1]!.execution).toEqual(['QUOTE_AND_INVOICE', 'a billing provider']);
    expect(steps[3]!.execution).toEqual(['CONTACT_BUYER', 'Instantly connected (messaging)']);
    expect(steps[4]!.execution).toEqual(['QUOTE_AND_INVOICE', 'a billing provider']);
    expect(steps[3]!.owner).toBe('BRAIN');
    // The plan's next step is its first step, carried with its kill criterion.
    const next = stepAsNextTest(steps[1]!, r);
    expect(next).toMatchObject({ link: 'OFFER_AND_PRICE', by: 'BRAIN', blocker: null });
    expect(next.test).toMatch(/Stop if/);
  });
});

describe('C-9: research follows the adopted plan', () => {
  const r = reconstruction({
    exploration: {
      sweep: {
        requirements: [
          { condition: 'reply', family: 'DEMAND', needed: 2.4, evidencedTop: 1.5, inEvidence: false },
          { condition: 'ticket', family: 'MARKET', needed: 1.2, evidencedTop: 2, inEvidence: true },
          { condition: 'price:o2', family: 'PRICE', needed: 1.8, evidencedTop: 1.1, inEvidence: false },
        ],
        sensitive: [{ condition: 'volume:o1', swing: 4000 }],
      },
      asks: ['What evidence shows reply at ×2.40 of today\'s middle estimate?'],
    } as unknown as Reconstruction['exploration'],
  });
  const adoption = { source: 'RECONSTRUCTED' as const, hypothetical: false, reason: 'beats it' };
  const priority = planResearchPriority({ reconstruction: r, adoption, adoptedIds: ['o1', 'o2'], daysLeft: 30, remaining: 10_000, legacy: [{ variable: 'o9_days', opportunityId: 'o9', field: 'timeToFirstCash', value: 0.5, changesDecision: true, decision: 'RESEARCH_FIRST', reason: 'legacy' }] });

  it('asks the conditions the plan needs outside evidence, the ones that swing it, and its assumed changes, before the run\'s own', () => {
    const vars = priority.map((one) => one.variable);
    expect(vars).toContain('plan:reply');
    expect(vars).toContain('plan:price:o2');
    expect(vars).toContain('plan:volume:o1');
    expect(vars.some((v) => v.startsWith('plan:change:TRANSACTION'))).toBe(true);
    expect(vars).not.toContain('plan:ticket');
    // The legacy question on an opening outside the adopted plan is dropped.
    expect(vars).not.toContain('o9_days');
    expect(priority.find((one) => one.variable === 'plan:price:o2')).toMatchObject({ opportunityId: 'o2', field: 'revenueRange' });
  });

  it('sends the plan-wide questions through the needs door under stable keys, and the per-opening ones through path research', async () => {
    const calls: Array<{ graphScope: string; subjects: string[] }> = [];
    const fake = (async (input: { graphScope: string; needs: readonly { subject: string }[] }) => {
      calls.push({ graphScope: input.graphScope, subjects: input.needs.map((n) => n.subject) });
      return input.needs.map((n) => ({ subject: n.subject, sent: true as const, to: 'RESEARCH_UNCERTAINTY' as const, ref: 'u', created: true }));
    }) as unknown as NonNullable<Parameters<typeof sendPlanQuestions>[1]>['sendNeeds'];
    const forced = priority.map((one) => ({ ...one, decision: 'RESEARCH_FIRST' as const }));
    const sent = await sendPlanQuestions({ goalId: 'wst_g', projectId: 'prj', priority: forced }, { sendNeeds: fake });
    expect(sent.sent).toBeGreaterThan(0);
    expect(calls[0]!.graphScope).toBe(goalPlanScope('wst_g'));
    // Stable: the subject names the condition, never its figure; assumed changes are measured by their steps, not researched.
    expect(calls[0]!.subjects).toContain('the goal plan\'s condition "reply"');
    expect(calls[0]!.subjects.some((s) => s.includes('change:'))).toBe(false);
    expect(planFieldsFor({ researchPriority: forced } as Pick<PlanReading, 'researchPriority'>, 'o2')).toEqual(['revenueRange']);
  });

  it('asks a plan condition as the measurement it names, never the bare word (production: "close" was researched as Close CRM)', async () => {
    const questions: string[] = [];
    const fake = (async (input: { needs: readonly { subject: string; question: string }[] }) => {
      questions.push(...input.needs.map((n) => n.question));
      return input.needs.map((n) => ({ subject: n.subject, sent: true as const, to: 'RESEARCH_UNCERTAINTY' as const, ref: 'u', created: true }));
    }) as unknown as NonNullable<Parameters<typeof sendPlanQuestions>[1]>['sendNeeds'];
    const asks = ['reply', 'close', 'days to cash', 'something-new'].map((c, i) => ({ variable: `plan:${c}`, opportunityId: null, decision: 'RESEARCH_FIRST', value: 1 - i / 10, reason: 'r' }));
    await sendPlanQuestions({ goalId: 'wst_g', projectId: 'prj', priority: asks, max: 4 }, { sendNeeds: fake });
    expect(questions[0]).toMatch(/reply rate to cold outreach/);
    expect(questions[1]).toMatch(/close rate: the share of qualified buyers offered the deal who buy/);
    expect(questions[2]).toMatch(/days from a buyer agreeing to the money arriving/);
    expect(questions[3]).toMatch(/the plan's "something-new" figure/);
    expect(questions.some((q) => /how (close|reply) behaves/.test(q))).toBe(false);
  });

  it('chooses the search brief by what binds', () => {
    const reply = planSearchBrief(r, 10_000, 30);
    const price = planSearchBrief(reconstruction({ diagnosis: [{ factor: 'PRICE', moved: 'price ×2', reach: 0.3, settledP50: 1, liftReach: 0.3, liftP50: 1 }] }), 10_000, 30);
    expect(reply).toMatch(/Reply rate binds: find buyers who already ask/);
    expect(reply).toMatch(/reply at ×2\.40/);
    expect(price).toMatch(/Revenue per deal binds/);
    expect(reply).not.toBe(price);
  });

  it('always asks the factor that binds the plan, ranked by what moving it alone lifts, and only the top one', () => {
    const bound = reconstruction({
      diagnosis: [
        { factor: 'CASH_TIMING', moved: 'days to cash ×0.5', reach: 0.967, settledP50: 10_000, liftReach: 0.905, liftP50: 9000 },
        { factor: 'PRICE', moved: 'price ×2', reach: 0.3, settledP50: 1, liftReach: 0.24, liftP50: 1 },
      ],
    });
    const asked = planResearchPriority({ reconstruction: bound, adoption, adoptedIds: ['o1', 'o2'], daysLeft: 30, remaining: 10_000, legacy: [] });
    const vars = asked.map((one) => one.variable);
    expect(vars).toContain('plan:days to cash');
    expect(vars).not.toContain('plan:ticket');
    expect(asked[0]!.variable).toBe('plan:days to cash');
    expect(asked[0]!.reason).toMatch(/binds the plan: days to cash ×0\.5 lifts reach by/);
    // Volume and capital are measured by sending or decided by a person, never researched.
    const volume = planResearchPriority({ reconstruction: reconstruction({ diagnosis: [{ factor: 'VOLUME', moved: 'volume ×3', reach: 0.9, settledP50: 1, liftReach: 0.8, liftP50: 1 }] }), adoption, adoptedIds: ['o1', 'o2'], daysLeft: 30, remaining: 10_000, legacy: [] });
    expect(volume.some((one) => /volume ×|plan:volume$/.test(one.variable))).toBe(false);
  });
});

describe('C-11: search churn does not rewrite history', () => {
  it('two reads that differ only in the search\'s winning key and direction have one digest', () => {
    const a = reconstruction();
    const b = reconstruction({ best: { ...a.best, key: 'a different order of the same moves' }, exploration: { winner: { direction: { name: 'VARIABLE:BACKWARD' } }, replaced: true } as unknown as Reconstruction['exploration'] });
    expect(reconstructionDigest(a)).toEqual(reconstructionDigest(b));
    expect(JSON.stringify(reconstructionDigest(b))).not.toMatch(/VARIABLE:BACKWARD|different order/);
    const reading = (r: Reconstruction) =>
      ({
        verdict: 'NEEDS_EVIDENCE',
        chosen: null,
        strategies: [],
        nextTest: { link: 'OFFER_AND_PRICE', test: `${r.best.key}: worded from the winner`, by: 'BRAIN', blocker: null },
        refusal: null,
        sales: [],
        considered: [],
        ladder: {},
        researchDiagnosis: [],
        bestReach: null,
        portfolio: null,
        pathways: null,
        acceptance: { status: 'CANDIDATE_ONLY', probability: null, candidate: { source: 'RECONSTRUCTED', opportunityIds: [r.best.key] } },
        adoption: { source: 'RECONSTRUCTED', hypothetical: false, reason: r.best.key },
        reconstruction: r,
      }) as unknown as PlanReading;
    expect(readingDigest(reading(a))).toBe(readingDigest(reading(b)));
  });
});

describe('C-13: a failure inside the read is carried and recorded', () => {
  it('a failed reconstruction and library are degraded entries, not silence', async () => {
    const degraded: string[] = [];
    const model = { portfolio: portfolio(), portfolioInput: { openings: GOAL_10K_OPENINGS as ModelledOpportunity[] } as never };
    const r = await reconstructionFor(model, 0.9, {
      degraded,
      library: async () => {
        throw new Error('library table missing');
      },
      reconstruct: async () => {
        throw new Error('evaluator pool died');
      },
    });
    expect(r).toBeNull();
    expect(degraded.join(' | ')).toMatch(/reasoning library: library table missing/);
    expect(degraded.join(' | ')).toMatch(/reconstruction: evaluator pool died/);
  });

  it('records one project event per failure, at most hourly per goal and stage', async () => {
    const projectId = (await freshProject()).project.id;
    const written = await recordDegraded('wst_degraded', projectId, ['reconstruction: boom (read without)', 'construction: bang'], 1_000);
    expect(written).toBe(2);
    expect(await recordDegraded('wst_degraded', projectId, ['reconstruction: boom again'], 2_000)).toBe(0);
    const events = (await listEvents(projectId)).filter((e) => e.eventType === 'GOAL_PLAN_DEGRADED');
    expect(events.map((e) => e.payload['stage']).sort()).toEqual(['construction', 'reconstruction']);
  });
});

/*
 * Production baseline, 2026-11-24 (independent judge, 12 fresh requests): plans
 * presented figures the reading itself flags implausible ("$3,161,954 toward
 * $1,500"; an HVAC deal that "keeps $37,271" on $1 of capital), and one plan's
 * only collection landed after the goal's 21-day window while it was presented.
 */
describe('a figure the reading cannot stand behind is never presented as the plan', () => {
  it('a flagged reconstruction shows none of its money figures and carries no upside', () => {
    const base = reconstruction();
    const r = reconstruction({ flags: [{ key: base.best.key, reach: base.best.reach, settledP50: base.best.settledP50, flags: [{ kind: 'SCALE', detail: 'one deal of "HVAC retrofit" needs $1 and keeps $37,271, 37271× the $1 behind the plan (bound ×20)' }] }] });
    const out = adoptReconstruction({ reconstruction: r, baseline: portfolio({ reach: 0.011, basis: 'COVERAGE' }), openings });
    expect(out.adoption.reason).toMatch(/flagged implausible \(SCALE: .*none of its figures is shown/);
    expect(out.adoption.reason).not.toMatch(/37,271|\$1\b/);
    expect(out.adoption.upside).toBeUndefined();
    expect(withoutFigures('keeps $37,271 on $1, or 3,161,954 USD')).toBe('keeps [figure withheld] on [figure withheld], or [figure withheld]');
  });

  const strategy = (over: Partial<StrategyReading>): StrategyReading => ({
    key: 's', label: 'HVAC retrofit leads', verdict: 'NEEDS_EVIDENCE', opportunityIds: ['o1'], links: [], constraintsFailed: [],
    sweep: { goalMetShare: 1, settledP50: 3_161_954, settledP90: 4_000_000, infeasibleShare: 0, probabilistic: false },
    conservativeSettled: null, chainComplete: false, nextTest: null, ...over,
  });

  it('withholds a settled figure over 100× what remains on inputs not all established, and says so', () => {
    const s = [strategy({})];
    const candidate = { label: 'HVAC retrofit leads', opportunityIds: ['o1'], source: 'PATHWAYS' as const, settledP50: 3_161_954, reach: 1, reachBasis: 'COVERAGE' as const };
    const withheld = withholdImplausibleFigures(s, candidate, 1_500);
    expect(s[0]!.sweep).toMatchObject({ settledP50: null, settledP90: null, goalMetShare: 1 });
    expect(s[0]!.basis).toMatch(/figures withheld: a settled figure of 2667× what remains/);
    expect(candidate.settledP50).toBeNull();
    expect(withheld).toHaveLength(2);
  });

  it('keeps a figure established inputs carry, and every figure inside the bound', () => {
    const established = [strategy({ chainComplete: true, conservativeSettled: 200_000 })];
    const modest = [strategy({ sweep: { goalMetShare: 0.6, settledP50: 9_000, settledP90: 140_000, infeasibleShare: 0, probabilistic: false } })];
    expect(withholdImplausibleFigures(established, null, 1_500)).toEqual([]);
    expect(established[0]!.sweep.settledP50).toBe(3_161_954);
    expect(withholdImplausibleFigures(modest, null, 1_500)).toEqual([]);
    expect(modest[0]!.sweep.settledP90).toBe(140_000);
  });

  it('a plan whose every collection lands after the window is not presented; one inside it, or unestablished, is', () => {
    const late = { label: 'Collect payment for "HVAC retrofit"', when: 'not scheduled: cash would be usable on day 35–40 (proven), after the 21 days left', stage: { stage: 'COLLECT' as const, costSource: 'NOT_OWNERS' as const, unscheduled: 'AFTER_DEADLINE' as const } };
    const inside = { label: 'Collect payment', when: 'day 9–12', stage: { stage: 'COLLECT' as const, costSource: 'NOT_OWNERS' as const } };
    const unknown = { ...inside, stage: { ...inside.stage, unscheduled: 'NO_MODEL_DAYS' as const } };
    const offer = { label: 'Sell', stage: { stage: 'OFFER' as const, costSource: 'NONE_HELD' as const } };
    expect(collectsOutsideWindow([offer, late], 21)).toMatch(/cash would be usable on day 35–40 .* no cash inside the goal's window/);
    expect(collectsOutsideWindow([offer, late, inside], 21)).toBeNull();
    expect(collectsOutsideWindow([offer, unknown], 21)).toBeNull();
    expect(collectsOutsideWindow([offer], 21)).toBeNull();
    expect(collectsOutsideWindow([offer, late], null)).toBeNull();
  });
});
