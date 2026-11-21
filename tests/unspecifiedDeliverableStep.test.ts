/**
 * Production, 2026-11-21 (release 91bf9ef8, goal wst_4f0c312400e1425dab2e,
 * plan read 44874080198): the leading constructed designs (arr_30354053591a,
 * arr_03e3254dced2, "Constructed: homeowner: Brain produces it and charges a
 * fee") deliver "what homeowner pay for (not yet specified)". Construction
 * refuses that as a proved deliverable (`provedDeliverable`), so no performer
 * is established — yet step 10 read
 *
 *   [BRAIN] Deliver and confirm
 *   by  performed by Brain through Brain's deliverable renderers
 *       (PRODUCE_SPREADSHEET); approval needed: no
 *
 * and "brain does" / "depends on" credited the renderer: an executability
 * claim for work nobody has specified (invariant 39, §37). A Deliver step over
 * an unspecified deliverable now says so, names no performer and no renderer,
 * claims no "approval needed: no", and its next action is to specify what the
 * buyers pay for. A proved deliverable keeps its performer.
 */
import { describe, expect, it } from 'vitest';
import { planIntegrity } from '../server/domain/planIntegrity.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import type { PlanAcceptance, PlanReading, PlanStep } from '../server/services/goals/plan.ts';
import { arrangementSteps } from '../server/services/goals/arrangementSteps.ts';
import { integrityInput } from '../server/services/goals/planIntegrityInput.ts';
import { declaredInventory, executorLine, planExecution, type CapabilityInventory } from '../server/services/goals/stepExecutor.ts';

function produced(supplyName: string): ConstructedArrangement {
  return {
    key: '30354053591a',
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' },
    origin: 'FORWARD',
    precedent: null,
    sector: null,
    demand: { name: 'homeowner', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_home' },
    need: null,
    supply: { name: supplyName, claimId: null, from: 'CAPABILITY', ref: 'capability' },
    label: 'Constructed: homeowner: Brain produces it and charges a fee',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'COMPARABLE', p10: 6000, p50: 6000, p90: 6000, observations: 1 },
    unknownParts: ['buyers', 'value', 'fixed_cost', 'days_to_cash', 'cost', 'repeat_rate', 'conversion'],
    relatedOpenings: [],
    question: '',
  } as unknown as ConstructedArrangement;
}

/** Every declared capability read usable: the renderer is there, so only the deliverable's absence can withhold it. */
function connected(): CapabilityInventory {
  const inv = declaredInventory();
  for (const e of Object.values(inv.entries)) e.state = 'PRESENT';
  return { ...inv, read: true };
}

const ctx = { currency: 'USD', daysLeft: 179, capitalBeforeProof: 25_000, send: ['CONTACT_BUYER'], collect: ['QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'], capabilities: connected() };
const deliverOf = (steps: PlanStep[]) => steps.find((s) => s.label === 'Deliver and confirm')!;

describe('a Deliver step over a deliverable nobody specified establishes no performer', () => {
  it('names no renderer, claims no "approval needed: no", and says to specify what the buyers pay for', () => {
    const steps = arrangementSteps(produced('what homeowner pay for (not yet specified)'), ctx);
    const deliver = deliverOf(steps);
    const e = deliver.executor!;
    expect(e.performedBy).toBe('NOT_ESTABLISHED');
    expect(e.via).toEqual([]);
    expect(e.capabilities).toEqual([]);
    const line = executorLine(e);
    expect(line).not.toMatch(/renderers|PRODUCE_SPREADSHEET/);
    expect(line).not.toMatch(/approval needed: no\b/);
    expect(line).toMatch(/approval needed: not established until the work is specified$/);
    expect(line).toMatch(/not yet specified/);
    expect(line).toMatch(/no performer is established/);
    expect(deliver.detail).toMatch(/not yet specified, so no performer is established/);
    expect(deliver.detail).toMatch(/specify what "homeowner" pay for/);
    expect(deliver.detail).not.toMatch(/^Brain produces/);

    // The plan's execution summary credits nothing to Brain or to its renderers for it.
    const x = planExecution(steps);
    expect(x.brain.some((one) => one.includes('Deliver and confirm'))).toBe(false);
    expect(x.dependencies.some((one) => /renderers|PRODUCE_/.test(one))).toBe(false);
    expect(x.unestablished.some((one) => one.includes('Deliver and confirm'))).toBe(true);
  });

  it('an accepted plan holding it is refused by EXECUTABLE_BY_BRAIN', () => {
    const steps = arrangementSteps(produced('what homeowner pay for (not yet specified)'), ctx);
    const acceptance = { status: 'ACCEPTED', required: 0.9, shortfalls: [], sentence: 'Accepted.', candidate: null, accepted: null, probability: null } as unknown as PlanAcceptance;
    const reading = { goalId: 'wst_4f0c312400e1425dab2e', verdict: 'RECOMMENDABLE', summary: '', acceptance, steps, nextTest: null, portfolio: null } as unknown as PlanReading;
    const violations = planIntegrity(integrityInput(reading)).violations.filter((v) => v.rule === 'EXECUTABLE_BY_BRAIN');
    expect(violations.map((v) => v.detail).join(' | ')).toMatch(/Deliver and confirm.*no performer is established/);
  });

  it('a deliverable Brain has proved for these buyers keeps Brain and its renderer', () => {
    const steps = arrangementSteps(produced('spreadsheet for homeowner'), ctx);
    const e = deliverOf(steps).executor!;
    expect(e.performedBy).toBe('BRAIN');
    expect(executorLine(e)).toMatch(/^performed by Brain through Brain's deliverable renderers \(PRODUCE_[A-Z_]+\); approval needed: no$/);
    expect(deliverOf(steps).detail).toMatch(/^Brain produces "spreadsheet for homeowner" for each buyer/);
  });
});
