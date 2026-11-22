/**
 * The planningReliability end-to-end level (docs/COMPLETION-SPEC.md §3a): beside the
 * verdict, an executable plan must be complete and executable step by step, and a
 * no-plan conclusion must say what would resolve it and show it compared the openings
 * held. Every case here is synthetic; the grader is pure, so no planner runs.
 */
import { describe, expect, it } from 'vitest';
import type { PlanningCase } from '../bench/planningReliability/case.ts';
import { grade, observeExecution, priorityLink, type ObservedExecution, type ObservedPlan, type ObservedStep } from '../bench/planningReliability/grade.ts';
import { summarise, type PlanningRow } from '../bench/planningReliability/index.ts';
import type { PlanReading } from '../server/services/goals/plan.ts';

const dims = {
  capital: 'none', target: 'small', deadline: 'long', industry: 'widgets', mechanism: 'SERVICE', autonomy: 'unlimited',
  missingEvidence: 'none', contradictoryEvidence: false, objectiveChanged: false,
} as const;

const executableCase = (over: Partial<PlanningCase> = {}): PlanningCase => ({
  id: 'synthetic-exec', heldOut: false, description: 'synthetic', dimensions: { ...dims },
  objective: 'Collect $3,000 in 30 days.',
  openings: [{ key: 'w', title: 'Widget audit', mechanism: 'SERVICE', industry: 'widgets', price: 600, cost: 50, performer: 'BRAIN' }],
  expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  ...over,
});

const noPlanCase = (over: Partial<PlanningCase> = {}): PlanningCase => ({
  id: 'synthetic-noplan', heldOut: false, description: 'synthetic', dimensions: { ...dims },
  objective: 'Collect $3,000 in 30 days.',
  openings: [{ key: 'w', title: 'Widget audit', mechanism: 'SERVICE', industry: 'widgets', price: 600, performer: 'NOBODY' }],
  expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['FULFILMENT'] } },
  ...over,
});

const step = (order: number, over: Partial<ObservedStep>): ObservedStep => ({
  order, label: `step ${order}`, kind: 'EXECUTE', stage: null, costSource: 'MODEL', unscheduled: null, cost: 0,
  startDay: { low: order, high: order }, dependsOn: order > 1 ? order - 1 : null, requires: [], basis: 'EVIDENCE',
  performer: 'BRAIN', operation: 'PLAN_DECISION', does: 'x', routine: false, capabilities: [], pays: false,
  members: ['w'], absent: [], price: null, ...over,
});

/** A complete chain: reach, deliver, collect — every field the rubric reads present. */
const completeSteps = (): ObservedStep[] => [
  step(1, { stage: 'REACH', operation: 'REACH_BUYERS', routine: true, capabilities: [{ id: 'SEND_A_MESSAGE', state: 'NOT_CONNECTED' }] }),
  step(2, { stage: 'DELIVER', operation: 'BRAIN_PRODUCES', cost: 50, routine: true, capabilities: [{ id: 'PRODUCE_SPREADSHEET', state: 'PRESENT' }] }),
  step(3, { stage: 'COLLECT', operation: 'COLLECT_PAYMENT', costSource: 'NOT_OWNERS', routine: true, capabilities: [{ id: 'TAKE_A_PAYMENT', state: 'UNREAD' }] }),
];

const execution = (over: Partial<ObservedExecution> = {}): ObservedExecution => ({
  steps: completeSteps(), daysLeft: 30, hoursCeiling: null, strategies: 1, considered: ['w'], excluded: [],
  resolves: [], relax: [], researchFirst: 0, economics: { w: { price: { low: 600, high: 600 }, cost: { low: 50, high: 50 } } },
  ...over,
});

const observed = (over: Partial<ObservedPlan>): ObservedPlan => ({
  stance: 'EXECUTABLE', status: 'CANDIDATE_ONLY', verdict: 'QUANTITATIVELY_CONSTRUCTED', infeasible: null, broken: [],
  members: [{ key: 'w', unestablished: [], capitalLow: 0, cashStructure: false, deals: 5 }], missing: {}, named: [],
  collectAfterDeadline: false, scope: { industry: null, recurring: null, hoursPerWeek: null }, targetCents: 300_000, gate: null,
  execution: execution(), ...over,
});

describe('the end-to-end level of an executable plan', () => {
  it('passes a complete, executable plan, and leaves the verdict level as it was', () => {
    const g = grade(executableCase(), observed({}));
    expect(g).toMatchObject({ pass: true, outcome: 'EXECUTABLE_PLAN_CORRECT', failures: [] });
    expect(g.e2e).toMatchObject({ pass: true, failures: [], gaps: [] });
  });

  it('refuses a plan whose chain is missing a link: no buyer reach, no fulfilment, no payment', () => {
    const onlyOffer = [step(1, { stage: 'OFFER', operation: 'SEND_OFFER', capabilities: [{ id: 'SEND_A_MESSAGE', state: 'PRESENT' }] })];
    const g = grade(executableCase(), observed({ execution: execution({ steps: onlyOffer }) }));
    expect(g.pass).toBe(true); // the verdict level is unchanged
    expect(g.e2e.pass).toBe(false);
    expect(g.e2e.failures).toContain('CHAIN_STEP_MISSING');
    expect(g.e2e.detail).toMatch(/fulfilment, payment collection/);
    // Agreements that cover the target need no buyer reach; delivery and payment are still steps.
    const agreed = executableCase({ openings: [{ key: 'w', title: 'Widget audit', mechanism: 'SERVICE', industry: 'widgets', price: 600, cost: 50, performer: 'BRAIN', agreements: [1500, 1500] }] });
    const noReach = completeSteps().slice(1);
    expect(grade(agreed, observed({ execution: execution({ steps: noReach }) })).e2e.pass).toBe(true);
    expect(grade(executableCase(), observed({ execution: execution({ steps: noReach }) })).e2e.failures).toContain('CHAIN_STEP_MISSING');
    // A subcontracted deliverable with a cost needs a step that pays the supplier.
    const sub = executableCase({ openings: [{ key: 'w', title: 'Widget audit', mechanism: 'SERVICE', industry: 'widgets', price: 600, cost: 50, performer: 'SUBCONTRACTOR' }] });
    const provider = completeSteps().map((s) => (s.stage === 'DELIVER' ? { ...s, performer: 'PROVIDER', operation: 'SUPPLIER_DELIVERS' } : s));
    expect(grade(sub, observed({ execution: execution({ steps: provider }) })).e2e.detail).toMatch(/supplier payment/);
    expect(grade(sub, observed({ execution: execution({ steps: provider.map((s) => (s.stage === 'DELIVER' ? { ...s, pays: true } : s)) }) })).e2e.pass).toBe(true);
  });

  it('refuses steps nobody performs, or that Brain is said to perform without the capability or against the evidence', () => {
    const missing = completeSteps().map((s) => (s.stage === 'DELIVER' ? { ...s, performer: 'CAPABILITY_MISSING' } : s));
    expect(grade(executableCase(), observed({ execution: execution({ steps: missing }) })).e2e.failures).toContain('STEP_PERFORMER_UNESTABLISHED');
    const undeclared = completeSteps().map((s) => (s.stage === 'DELIVER' ? { ...s, capabilities: [{ id: 'PRODUCE_SPREADSHEET', state: 'NOT_DECLARED' }] } : s));
    expect(grade(executableCase(), observed({ execution: execution({ steps: undeclared }) })).e2e.failures).toContain('BRAIN_CAPABILITY_NOT_HELD');
    // The evidence says the owner does the work: Brain "producing" it is a capability it does not hold.
    const owner = executableCase({ openings: [{ key: 'w', title: 'Widget audit', mechanism: 'SERVICE', industry: 'widgets', price: 600, cost: 50, performer: 'OWNER', hours: 1 }] });
    expect(grade(owner, observed({})).e2e.failures).toContain('BRAIN_CAPABILITY_NOT_HELD');
    // A subcontractor's work read as the owner's is a mismatch.
    const sub = executableCase({ openings: [{ key: 'w', title: 'Widget audit', mechanism: 'SERVICE', industry: 'widgets', price: 600, performer: 'SUBCONTRACTOR' }] });
    const byOwner = completeSteps().map((s) => (s.stage === 'DELIVER' ? { ...s, performer: 'OWNER', operation: 'OWNER_TASK' } : s));
    expect(grade(sub, observed({ execution: execution({ steps: byOwner }) })).e2e.failures).toEqual(expect.arrayContaining(['PERFORMER_MISMATCH', 'OWNER_ROUTINE_WORK']));
  });

  it('refuses unestablished costs, undated steps, loose dependencies and money after the deadline', () => {
    const f = (steps: ObservedStep[], over: Partial<ObservedExecution> = {}) => grade(executableCase(), observed({ execution: execution({ steps, ...over }) })).e2e.failures;
    expect(f(completeSteps().map((s) => (s.stage === 'REACH' ? { ...s, cost: null, costSource: 'NONE_HELD' } : s)))).toContain('STEP_COST_UNESTABLISHED');
    expect(f(completeSteps().map((s) => (s.stage === 'DELIVER' ? { ...s, startDay: null } : s)))).toContain('STEP_UNSCHEDULED');
    expect(f(completeSteps().map((s) => (s.stage === 'COLLECT' ? { ...s, dependsOn: null } : s)))).toContain('STEP_DEPENDENCY_ABSENT');
    expect(f(completeSteps(), { daysLeft: 2 })).toContain('MONEY_STEP_OUTSIDE_DEADLINE');
    expect(f(completeSteps().map((s) => (s.stage === 'COLLECT' ? { ...s, startDay: null, unscheduled: 'AFTER_DEADLINE' } : s)))).toEqual(['MONEY_STEP_OUTSIDE_DEADLINE']);
  });

  it('allows routine owner work only inside hours the objective gives', () => {
    const owner = executableCase({ openings: [{ key: 'w', title: 'Widget audit', mechanism: 'SERVICE', industry: 'widgets', price: 600, cost: 50, performer: 'OWNER', hours: 1 }] });
    const byOwner = completeSteps().map((s) => (s.stage === 'DELIVER' ? { ...s, performer: 'OWNER', operation: 'OWNER_TASK' } : s));
    expect(grade(owner, observed({ execution: execution({ steps: byOwner }) })).e2e.failures).toEqual(['OWNER_ROUTINE_WORK']);
    const allowed = { ...owner, expect: { ...owner.expect, ownerHoursMax: 20 } };
    expect(grade(allowed, observed({ execution: execution({ steps: byOwner }) })).e2e.pass).toBe(true);
  });

  it('refuses a step priced away from the economics its strategy was judged on', () => {
    const drift = completeSteps().map((s) => (s.stage === 'DELIVER' ? { ...s, cost: 400 } : s));
    expect(grade(executableCase(), observed({ execution: execution({ steps: drift }) })).e2e.failures).toEqual(['ECONOMICS_DRIFT']);
    const sells = completeSteps().map((s) => (s.stage === 'REACH' ? { ...s, price: 900 } : s));
    expect(grade(executableCase(), observed({ execution: execution({ steps: sells }) })).e2e.failures).toEqual(['ECONOMICS_DRIFT']);
  });

  it('records a field the planner does not carry as a measured gap, never a guess', () => {
    const gaps = completeSteps().map((s) => ({ ...s, absent: s.stage === 'REACH' ? ['evidence', 'price'] : ['evidence'] }));
    const g = grade(executableCase(), observed({ execution: execution({ steps: gaps }) }));
    expect(g.e2e.failures).toEqual(['STEP_FIELD_ABSENT']);
    expect(g.e2e.gaps).toEqual(['step.evidence', 'step.price']);
  });

  it('fails the end-to-end level whenever the verdict fails, and when nothing was observed', () => {
    const wrong = grade(noPlanCase(), observed({}));
    expect(wrong.pass).toBe(false);
    expect(wrong.e2e.failures).toContain('VERDICT_INCORRECT');
    const { execution: _none, ...bare } = observed({});
    expect(grade(executableCase(), bare).e2e).toMatchObject({ pass: false, failures: ['NOT_OBSERVED'] });
  });
});

describe('the end-to-end level of a no-plan conclusion', () => {
  const noPlan = (x: Partial<ObservedExecution>) => observed({ stance: 'NO_PLAN', named: ['FULFILMENT'], missing: { w: ['FULFILMENT'] }, execution: execution({ steps: [], ...x }) });

  it('needs a measurement or research of the decisive unknown, not merely its name', () => {
    expect(grade(noPlanCase(), noPlan({ resolves: ['FULFILMENT'] }))).toMatchObject({ pass: true, e2e: { pass: true } });
    const unresolved = grade(noPlanCase(), noPlan({ resolves: ['CONVERSION'] }));
    expect(unresolved.pass).toBe(true);
    expect(unresolved.e2e.failures).toEqual(['RESOLUTION_ABSENT']);
    // An infeasible goal is resolved by the relaxation that would make it feasible.
    const infeasible = noPlanCase({ expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['TARGET'] } } });
    const o = (relax: ObservedExecution['relax']) => observed({ stance: 'NO_PLAN', status: 'NOT_SUPPORTED', infeasible: ['TARGET'], execution: execution({ steps: [], relax }) });
    expect(grade(infeasible, o(['TARGET'])).e2e.pass).toBe(true);
    expect(grade(infeasible, o([])).e2e.failures).toEqual(['RESOLUTION_ABSENT']);
  });

  it('needs the openings held compared, and every one accounted for', () => {
    expect(grade(noPlanCase(), noPlan({ resolves: ['FULFILMENT'], strategies: 0, considered: [], excluded: [] })).e2e.failures).toEqual(['ALTERNATIVES_NOT_COMPARED', 'OPENING_UNACCOUNTED']);
    const two = noPlanCase({ openings: [...noPlanCase().openings, { key: 'v', title: 'Other', mechanism: 'SERVICE', industry: 'widgets', price: 100, performer: 'BRAIN' }] });
    expect(grade(two, noPlan({ resolves: ['FULFILMENT'] })).e2e.failures).toEqual(['OPENING_UNACCOUNTED']);
    expect(grade(two, noPlan({ resolves: ['FULFILMENT'], excluded: ['v'] })).e2e.pass).toBe(true);
  });
});

describe('reading the planner\'s output', () => {
  it('reads steps, executors, alternatives and resolutions from a reading, and marks the fields it lacks', () => {
    const reading = {
      acceptance: { candidate: { opportunityIds: ['id-w'] } },
      steps: [
        {
          order: 1, label: 'Sell', detail: '', startDay: { low: 0, high: 0 }, cost: null, basis: 'ESTIMATE', owner: 'BRAIN', ownerReason: null, dependsOn: null, kill: 'k', execution: [],
          stage: { stage: 'OFFER', costSource: 'NONE_HELD' },
          executor: { performedBy: 'BRAIN', operation: 'SEND_OFFER', does: 'send', via: [], provider: null, capabilities: [{ id: 'SEND_A_MESSAGE', state: 'NOT_CONNECTED' }], routine: true, acquisition: false, acquire: [], permissions: [], approval: { needed: false, reasons: [] } },
        },
        {
          order: 2, label: 'Order', detail: '', startDay: null, cost: 80, basis: 'ASSUMPTION', owner: 'PERSON', ownerReason: null, dependsOn: 1, kill: 'k', execution: [], openings: ['id-w'],
          arrangement: { key: 'arr_1', stage: 'ORDER', costSource: 'MODEL', unscheduled: 'NO_MODEL_DAYS' },
          executor: { performedBy: 'PROVIDER', operation: 'PAY_SUPPLIER', does: 'pay', via: [], provider: 's', capabilities: [], routine: true, acquisition: false, acquire: [], permissions: [], approval: { needed: true, reasons: [{ kind: 'PAYMENT', why: 'w', once: false }] } },
        },
      ],
      nextTest: { link: 'FULFILMENT', test: 'find who does it', by: 'BRAIN', blocker: null },
      strategies: [{ nextTest: { link: 'ECONOMICS', test: '', by: 'BRAIN', blocker: null } }],
      marketTests: [],
      sales: [{ test: { link: 'CONVERSION', test: 'sell it', by: 'BRAIN', blocker: null } }],
      researchPriority: [
        { variable: 'o1_days', field: 'timeToFirstCash', decision: 'RESEARCH_FIRST' },
        { variable: 'plan:direct cost', field: null, decision: 'IGNORE' },
      ],
      portfolio: { demand: [{ opportunityId: 'id-w', price: { p10: 500, p50: 600, p90: 700 }, costHeld: { low: 40, high: 60, own: true } }] },
      target: { daysLeft: 20, hoursCeiling: 0 },
      considered: [{ opportunityId: 'id-w' }],
      excluded: [{ opportunityId: 'id-v' }],
      infeasible: null,
    } as unknown as PlanReading;
    const keys: Record<string, string> = { 'id-w': 'w', 'id-v': 'v' };
    const x = observeExecution(reading, (id) => keys[id] ?? id);
    expect(x.steps[0]).toMatchObject({ stage: 'OFFER', costSource: 'NONE_HELD', cost: null, performer: 'BRAIN', operation: 'SEND_OFFER', members: ['w'], absent: ['evidence', 'price'], kind: 'EXECUTE' });
    expect(x.steps[1]).toMatchObject({ stage: 'ORDER', unscheduled: 'NO_MODEL_DAYS', pays: true, members: ['w'], absent: ['evidence'] });
    // An empty test names nothing; an ignored research priority resolves nothing.
    expect(x.resolves.sort()).toEqual(['CONVERSION', 'FULFILMENT', 'SETTLES_IN_TIME']);
    expect(x).toMatchObject({ daysLeft: 20, strategies: 1, considered: ['w'], excluded: ['v'], researchFirst: 1, economics: { w: { price: { low: 500, high: 700 }, cost: { low: 40, high: 60 } } } });
  });

  it('maps the model\'s variables to the chain links they measure', () => {
    expect(priorityLink({ variable: 'plan:direct cost', field: null })).toBe('ECONOMICS');
    expect(priorityLink({ variable: 'plan:reply', field: null })).toBe('CONVERSION');
    expect(priorityLink({ variable: 'o2_volume', field: null })).toBe('MARKET_VOLUME');
    expect(priorityLink({ variable: 'whatever', field: 'revenueRange' })).toBe('OFFER_AND_PRICE');
    expect(priorityLink({ variable: 'plan:unknown', field: null })).toBeNull();
  });
});

describe('the report', () => {
  it('reports the end-to-end level beside the verdict level, with its own interval and classes, and keeps hidden detail out', () => {
    const rows: PlanningRow[] = [
      { id: 'a', hidden: false, heldOut: false, expect: 'NO_PLAN', observed: 'NO_PLAN', pass: true, outcome: 'NO_PLAN_JUSTIFIED_CORRECT', failures: [], ms: 1, detail: 'ok', e2e: { pass: true, failures: [], gaps: [], detail: 'complete' } },
      { id: 'b', hidden: false, heldOut: false, expect: 'EXECUTABLE_PLAN', observed: 'EXECUTABLE', pass: true, outcome: 'EXECUTABLE_PLAN_CORRECT', failures: [], ms: 1, detail: 'ok', e2e: { pass: false, failures: ['STEP_FIELD_ABSENT'], gaps: ['step.evidence'], detail: 'steps do not carry step.evidence' } },
      { id: 'hidden:c', hidden: true, heldOut: true, expect: 'EXECUTABLE_PLAN', observed: 'EXECUTABLE', pass: true, outcome: 'EXECUTABLE_PLAN_CORRECT', failures: [], ms: 1, detail: 'SECRET', e2e: { pass: false, failures: ['CHAIN_STEP_MISSING'], gaps: [], detail: 'SECRET chain' } },
      { id: 'd', hidden: false, heldOut: false, expect: 'NO_PLAN', observed: null, pass: false, outcome: null, failures: [], ms: 1, detail: 'error' },
    ];
    const s = summarise(rows);
    expect(s.metrics).toMatchObject({ passed: 3, 'e2e.passed': 1, 'e2e.passedBarFieldGaps': 2, 'e2e.failures.STEP_FIELD_ABSENT': 1, 'e2e.failures.CHAIN_STEP_MISSING': 1, 'e2e.failures.NOT_OBSERVED': 1 });
    expect(s.metrics['e2e.accuracy']).toBeCloseTo(0.25);
    expect(s.metrics['e2e.wilsonLow']).toBeGreaterThan(0);
    expect(s.summary[1]).toMatch(/end-to-end: 1\/4 complete .* fields absent: step\.evidence/);
    // A hidden case's grader detail never reaches the shared result or the summary.
    expect(JSON.stringify({ cases: s.cases, summary: s.summary, metrics: s.metrics })).not.toMatch(/SECRET/);
    expect(s.cases[2]).toMatchObject({ pass: true, e2e: { pass: false, failures: ['CHAIN_STEP_MISSING'] } });
  });
});
