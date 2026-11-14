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
  return {
    required: 0.9,
    baseline: variant(),
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
    ...over,
  };
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
    const p = portfolio({ assurance: { claimsAtLeast90: true, status: 'CLAIMS_AT_LEAST_90', range: { low: 0.93, high: 0.99 }, reason: 'calibrated evidence (smallest sample 140) puts the lower bound at 93%, above 90%' } as GoalPortfolio['assurance'] });
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: p, measuredChance: null, considered: [{ opportunityId: 'o1', missing: [] }] });
    expect(a.status).toBe('ACCEPTED');
    expect(a.probability).toMatchObject({ basis: 'EVIDENCED_PORTFOLIO', lowerBound: 0.93, sample: 140 });
  });
});

describe('C-6: one plan', () => {
  it('adopts the reconstruction when it beats the plan as held: the candidate is its members, and its reach stays coverage', () => {
    const { adoption, candidate } = adoptReconstruction({ reconstruction: reconstruction(), baseline: portfolio({ reach: 0.011, basis: 'COVERAGE' }), openings });
    expect(adoption).toMatchObject({ source: 'RECONSTRUCTED', hypothetical: false });
    expect(candidate).toMatchObject({ source: 'RECONSTRUCTED', opportunityIds: ['o1', 'o2'], reach: 0.979, reachBasis: 'COVERAGE' });
  });

  it('keeps the plan as held and says the reconstruction is hypothetical when it is flagged implausible', () => {
    const r = reconstruction({ ...({ implausible: true, flags: ['price ×9 with close unchanged'] } as object) } as Partial<Reconstruction>);
    const out = adoptReconstruction({ reconstruction: r, baseline: portfolio({ reach: 0.011, basis: 'COVERAGE' }), openings });
    expect(out.candidate).toBeNull();
    expect(out.adoption).toMatchObject({ source: 'BASELINE', hypothetical: true });
    expect(out.adoption.reason).toMatch(/implausible/);
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
    expect(continueSearch({ achieved: false, daysLeft: 2, outcomeRecorded: false, policy: 'SQUEEZE', acceptance: a.status })).toBe(false);
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

  it('orders the changes by start day, ends with the sale, and names each step\'s basis, cost and dependency', () => {
    expect(steps.map((s) => s.label)).toEqual(['marketplace leads', 'bundle ×9', 'deposit at signing', 'Sell and collect']);
    expect(steps[0]).toMatchObject({ order: 1, cost: 300, basis: 'ESTIMATE', dependsOn: null });
    expect(steps[1]).toMatchObject({ basis: 'ASSUMPTION', dependsOn: 1 });
    expect(steps[2]).toMatchObject({ dependsOn: 2 });
    expect(steps[3]).toMatchObject({ dependsOn: 3 });
  });

  it('gives a person only rule-11 kinds: a payment is the owner\'s, the rest is Brain\'s', () => {
    expect(steps[0]).toMatchObject({ owner: 'PERSON' });
    expect(steps[0]!.ownerReason).toMatch(/payment of \$300/);
    expect(steps.slice(1).every((s) => s.owner === 'BRAIN')).toBe(true);
  });

  it('states the measurement that kills each step, from the reply rate the plan needs', () => {
    expect(steps[0]!.kill).toMatch(/reply rate under 1\.2% after \d[\d,]* sends → stop and re-plan/);
    expect(steps[1]!.kill).toMatch(/fewer than 1 in 10 offered buyers accepts "bundle ×9"/);
    expect(steps[2]!.kill).toMatch(/deposit/);
  });

  it('lists contact permission, invoicing and billing as execution dependencies, never as owners or blockers of the plan', () => {
    expect(steps[0]!.execution).toEqual(['CONTACT_BUYER', 'Instantly connected (messaging)']);
    expect(steps[1]!.execution).toEqual(['QUOTE_AND_INVOICE', 'a billing provider']);
    expect(steps[3]!.execution).toHaveLength(4);
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

  it('chooses the search brief by what binds', () => {
    const reply = planSearchBrief(r, 10_000, 30);
    const price = planSearchBrief(reconstruction({ diagnosis: [{ factor: 'PRICE', moved: 'price ×2', reach: 0.3, settledP50: 1, liftReach: 0.3, liftP50: 1 }] }), 10_000, 30);
    expect(reply).toMatch(/Reply rate binds: find buyers who already ask/);
    expect(reply).toMatch(/reply at ×2\.40/);
    expect(price).toMatch(/Revenue per deal binds/);
    expect(reply).not.toBe(price);
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
