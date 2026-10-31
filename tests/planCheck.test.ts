/**
 * A quantitative plan is one model, and every number shown is one of its numbers.
 *
 * The regression this file exists for is the mailer plan presented on
 * 2026-10-31 (`plans/mailer-2026-10-31-as-presented.json`): 24 sales derived
 * beside "23" stated, a checkpoint projecting 8, $15,600 of mailings owed and
 * carried nowhere, and "roughly 90%" from no model. Each case here takes a real
 * plan, breaks exactly one thing, and asserts the gate names that thing — then
 * asserts the corrected plan passes, because a gate that refuses everything is
 * as useless as one that refuses nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkPlan, numbersIn, planDigest, unverifiedChanceClaims, type PlanCheck, type QuantitativePlan } from '../server/services/scenario/planCheck.ts';
import { checkExpressionUnit, parseUnit } from '../server/services/scenario/units.ts';
import { validateProposal } from '../server/services/russell/proposal.ts';
import type { Principal } from '../server/domain/types.ts';

const presented = (): QuantitativePlan => JSON.parse(readFileSync('plans/mailer-2026-10-31-as-presented.json', 'utf8'));
const corrected = (): QuantitativePlan => JSON.parse(readFileSync('plans/mailer-corrected-2026-10-31.json', 'utf8'));
const codes = (check: PlanCheck) => check.problems.map((p) => p.code);
const figure = (check: PlanCheck, key: string) => check.figures.find((f) => f.key === key)?.value;

describe('the 2026-10-31 mailer plan, exactly as presented', () => {
  const check = checkPlan(presented());

  it('is rejected', () => {
    expect(check.verdict).toBe('REJECTED');
  });

  it('derives 24 sales from its own rates, so "23" in the narrative is not one of its numbers', () => {
    expect(figure(check, 'packages')).toBe(24);
    expect(check.problems.some((p) => p.code === 'NARRATIVE_UNVERIFIED_NUMBER' && p.message.includes('"23"'))).toBe(true);
    expect(check.problems.some((p) => p.code === 'NARRATIVE_UNVERIFIED_NUMBER' && p.message.includes('$10,350'))).toBe(true);
  });

  it('refuses the checkpoint: 2 per 1,000 projects 8 of the 24 the plan needs', () => {
    expect(figure(check, 'checkpoint:Day-7 checkpoint:projected')).toBe(8);
    expect(codes(check)).toContain('CHECKPOINT_TOO_LOW');
  });

  it('costs the promised delivery at $15,600 against $10,800 collected, and says so', () => {
    expect(figure(check, 'fulfilment')).toBe(15600);
    expect(figure(check, 'collected')).toBe(10800);
    expect(figure(check, 'contribution')).toBe(-4800);
    expect(codes(check)).toContain('OBLIGATION_NOT_IN_EXPOSURE');
    expect(codes(check)).toContain('NEGATIVE_CONTRIBUTION');
  });

  it('refuses "90%" because nothing computed it', () => {
    expect(codes(check)).toContain('PROBABILITY_UNSUPPORTED');
    expect(codes(check)).toContain('NARRATIVE_UNVERIFIED_PROBABILITY');
    expect(check.probability).toBeNull();
    expect(check.sweep?.basis).toBe('SWEEP');
  });

  it('cannot check the deadline, the capital ceiling or the up-front limit it never modelled', () => {
    expect(check.problems.filter((p) => p.code === 'LIMIT_NOT_MODELLED')).toHaveLength(3);
  });

  it('once exposure is modelled, the owed mailings break the capital ceiling', () => {
    const plan = presented();
    plan.model.derived!.push({ key: 'exposure', label: 'Owed and unpaid', unit: 'USD', expr: 'fulfilment' });
    plan.roles.peakExposure = 'exposure';
    const again = checkPlan(plan);
    expect(codes(again)).toContain('CAPITAL_CEILING');
    expect(codes(again)).not.toContain('OBLIGATION_NOT_IN_EXPOSURE');
  });
});

describe('the corrected mailer model', () => {
  it('passes, as an analysis, with every narrative number one of its own', () => {
    const check = checkPlan(corrected());
    expect(check.problems).toEqual([]);
    expect(check.verdict).toBe('VERIFIED_ANALYSIS');
    expect(figure(check, 'collected')).toBe(5400);
    expect(figure(check, 'fulfilment')).toBe(3900);
    expect(figure(check, 'contribution')).toBe(1400);
  });

  it('is refused if it claims to reach the target, because at its own rates it does not', () => {
    const plan = corrected();
    plan.claim = 'REACHES_TARGET';
    expect(codes(checkPlan(plan))).toContain('TARGET_NOT_REACHED');
  });

  it('a corrected plan that does reach it passes — and its old narrative does not', () => {
    const plan = corrected();
    plan.claim = 'REACHES_TARGET';
    plan.point = { reply_rate: 0.05, close_rate: 0.25 };
    // The checkpoint must move with the assumption it confirms.
    plan.checkpoints![0]!.atLeast = { numerator: 13, denominator: 1000 };
    const stale = checkPlan(plan);
    expect(figure(stale, 'collected')).toBe(11250);
    expect(codes(stale)).toEqual(expect.arrayContaining(['NARRATIVE_UNVERIFIED_NUMBER']));
    plan.narrative = 'At 5% replies and 25% closing, 6,000 contacts sell 75 spots at $150: $11,250 collected, 5 cards mailed for $6,500, $4,650 after costs. The first checkpoint needs 13 spots per 1,000 contacts.';
    const fixed = checkPlan(plan);
    expect(fixed.problems).toEqual([]);
    expect(fixed.verdict).toBe('VERIFIED');
  });

  it('keeps the checkpoint honest when the assumption moves', () => {
    const plan = corrected();
    plan.claim = 'REACHES_TARGET';
    plan.point = { reply_rate: 0.05, close_rate: 0.25 };
    plan.narrative = 'x';
    // 6 per 1,000 passed the old assumption and fails the new one.
    expect(codes(checkPlan(plan))).toContain('CHECKPOINT_TOO_LOW');
  });

  it('an edit to the narrative after verification is a different plan', () => {
    const plan = corrected();
    const before = checkPlan(plan);
    plan.narrative = plan.narrative.replace('$5,400', '$5,900');
    const after = checkPlan(plan);
    expect(after.digest).not.toBe(before.digest);
    expect(after.verdict).toBe('REJECTED');
    expect(codes(after)).toContain('NARRATIVE_UNVERIFIED_NUMBER');
  });
});

describe('every invariant, broken one at a time', () => {
  it('units: a cost per card multiplied by spots is not a cost', () => {
    const plan = corrected();
    plan.model.derived!.find((d) => d.key === 'fulfilment')!.expr = 'spots_sold * cost_per_card';
    expect(codes(checkPlan(plan))).toContain('UNIT_MISMATCH');
  });

  it('whole things: a count that is not whole is refused', () => {
    const plan = corrected();
    plan.model.derived!.find((d) => d.key === 'replies')!.expr = 'contacts * reply_rate';
    plan.point = { reply_rate: 0.0333, close_rate: 0.2 };
    expect(codes(checkPlan(plan))).toContain('NOT_INTEGER');
  });

  it('capacity: sales may not exceed what the cards hold', () => {
    const plan = corrected();
    plan.model.derived!.find((d) => d.key === 'spots_sold')!.expr = 'floor(replies * close_rate)';
    plan.model.strategies[0]!.set = { cards: 1, selling_days: 20 };
    expect(codes(checkPlan(plan))).toContain('BOUND_EXCEEDED');
  });

  it('settlement: money that settles after the deadline does not count', () => {
    const plan = corrected();
    plan.model.strategies[0]!.set = { cards: 5, selling_days: 24 };
    plan.narrative = 'x';
    expect(codes(checkPlan(plan))).toContain('DEADLINE');
  });

  it('payment delays and refunds move the outcome and are checked against it', () => {
    const plan = corrected();
    plan.model.variables.push({ key: 'refund_rate', label: 'Spots refunded', unit: '1', provenance: 'ASSUMPTION', controllable: false, spec: { kind: 'FIXED', value: 0.1 } });
    plan.model.derived!.find((d) => d.key === 'collected')!.expr = 'spots_sold * spot_price * (1 - refund_rate)';
    plan.narrative = 'x';
    const check = checkPlan(plan);
    expect(figure(check, 'collected')).toBe(4860);
    expect(check.verdict).toBe('VERIFIED_ANALYSIS');
  });

  it('up-front spending above its limit is refused', () => {
    const plan = corrected();
    plan.model.variables.find((v) => v.key === 'lead_cost')!.spec = { kind: 'FIXED', value: 400 };
    plan.narrative = 'x';
    expect(codes(checkPlan(plan))).toContain('PRE_PAYMENT_CEILING');
  });

  it('an obligation whose cost is charged nowhere is refused', () => {
    const plan = corrected();
    plan.obligations![0]!.costLine = 'leads';
    expect(codes(checkPlan(plan))).toContain('OBLIGATION_UNCOSTED');
  });

  it('exposure that leaves out the delivery owed is refused', () => {
    const plan = corrected();
    plan.model.derived!.find((d) => d.key === 'peak_exposure')!.expr = 'lead_cost';
    expect(codes(checkPlan(plan))).toContain('OBLIGATION_NOT_IN_EXPOSURE');
  });

  it('a second revenue path brings its own obligation, which must be costed too', () => {
    const plan = corrected();
    plan.model.variables.push({ key: 'installs', label: 'Light installs sold', unit: 'install', provenance: 'ASSUMPTION', controllable: false, spec: { kind: 'FIXED', value: 3 } });
    plan.model.variables.push({ key: 'install_price', label: 'Install price', unit: 'USD/install', provenance: 'ASSUMPTION', controllable: false, spec: { kind: 'FIXED', value: 700 } });
    plan.model.lines.push({ key: 'install_sales', label: 'Installs', kind: 'REVENUE', expr: 'installs * install_price' });
    plan.obligations!.push({ label: 'Each install is a job a subcontractor must do', revenueLine: 'install_sales', costLine: 'install_cost', costDerived: 'install_cost' });
    const check = checkPlan(plan);
    expect(codes(check)).toContain('OBLIGATION_UNCOSTED');
  });

  it('an unknown cost must be stated where the plan quotes it, not filled in', () => {
    const plan = corrected();
    plan.model.variables.find((v) => v.key === 'cost_per_card')!.spec = { kind: 'RANGE', min: 900, max: 2200 };
    plan.model.variables.find((v) => v.key === 'cost_per_card')!.provenance = 'UNKNOWN';
    expect(codes(checkPlan(plan))).toContain('POINT_NOT_STATED');
  });

  it('a point outside an input’s own range is refused', () => {
    const plan = corrected();
    plan.point = { reply_rate: 0.2, close_rate: 0.2 };
    expect(codes(checkPlan(plan))).toContain('POINT_OUTSIDE_RANGE');
  });

  it('internally consistent and economically impossible: every number reconciles and the cash goes back out', () => {
    const plan = corrected();
    plan.claim = 'REACHES_TARGET';
    plan.point = { reply_rate: 0.05, close_rate: 0.3 };
    plan.model.variables.find((v) => v.key === 'cost_per_card')!.spec = { kind: 'FIXED', value: 3000 };
    plan.checkpoints = [];
    plan.narrative = 'x';
    const check = checkPlan(plan);
    expect(figure(check, 'collected')).toBeGreaterThanOrEqual(10000);
    expect(codes(check)).toContain('NEGATIVE_CONTRIBUTION');
  });
});

describe('a probability is computed or it is not stated', () => {
  /** A small model whose only uncertainty is sourced, so the engine can compute a chance. */
  function sourced(claimed?: number, narrative = 'x'): QuantitativePlan {
    return {
      version: 1,
      title: 'sourced',
      goal: { metric: 'SETTLED_CASH', target: 1000, unit: 'USD' },
      model: {
        title: 'sourced', currency: 'USD', horizon: 'a month',
        variables: [
          { key: 'sales', label: 'Sales', unit: 'sale', provenance: 'HISTORICAL', controllable: false, spec: { kind: 'EMPIRICAL', values: [4, 6, 8, 10, 12, 5, 7, 9, 11, 13, 6, 8, 10, 12, 14, 7, 9, 11, 13, 15] }, sources: [{ kind: 'LEDGER_ENTRY', ref: 'test' }] },
          { key: 'price', label: 'Price', unit: 'USD/sale', provenance: 'EVIDENCE', controllable: false, spec: { kind: 'FIXED', value: 100 } },
        ],
        derived: [{ key: 'cash', label: 'Cash', unit: 'USD', expr: 'sales * price' }],
        lines: [{ key: 'rev', label: 'Revenue', kind: 'REVENUE', expr: 'cash' }],
        strategies: [{ key: 's', label: 's', set: {} }],
      },
      strategy: 's',
      point: { sales: 10 },
      roles: { outcome: 'cash' },
      ...(claimed !== undefined ? { probability: { value: claimed, outcome: 'cash' } } : {}),
      narrative,
    };
  }

  it('from a Monte Carlo run over sourced inputs, the computed chance is admitted', () => {
    const first = checkPlan(sourced());
    expect(first.sweep?.basis).toBe('MONTE_CARLO');
    const p = first.probability!;
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.8);
    const shown = Math.round(p * 100);
    const check = checkPlan(sourced(p, `The chance of reaching $1,000 is ${shown}%.`));
    expect(check.problems).toEqual([]);
  });

  it('a higher chance than the model computes is refused', () => {
    const p = checkPlan(sourced()).probability!;
    expect(codes(checkPlan(sourced(Math.min(1, p + 0.2))))).toContain('PROBABILITY_MISMATCH');
  });

  it('a chance of a different outcome is not a chance of this one', () => {
    const plan = sourced(0.5);
    plan.probability!.outcome = 'sales';
    expect(codes(checkPlan(plan))).toContain('PROBABILITY_MISMATCH');
  });

  it('wording or spelled-out numbers do not get past it', () => {
    for (const text of ['This is almost certain to work.', 'Ninety percent likely to hit the target.', 'Nine in ten cities will fill.', 'A 90% chance.']) {
      expect(unverifiedChanceClaims(text).length, text).toBeGreaterThan(0);
    }
    expect(unverifiedChanceClaims('Send 300 emails a day and track replies.')).toEqual([]);
  });
});

describe('the other doors: a Russell answer is held to the same rule', () => {
  const principal = { type: 'HUMAN', id: 'usr_x', handle: 'x', displayName: 'x', isBrainAdmin: false, mustChangePassword: false, credentialId: 'ses', authMethod: 'SESSION_COOKIE', memberships: [], requestId: 'r' } as unknown as Principal;

  it('refuses an answer that states a chance of success no model computed', () => {
    const result = validateProposal({ raw: { action: 'ANSWER_ONLY', answer: 'Run the mailer in four cities; it is about 90% likely to reach $10,000.' }, principal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNVERIFIED_PROBABILITY');
  });

  it('accepts an ordinary answer with numbers in it', () => {
    const result = validateProposal({ raw: { action: 'ANSWER_ONLY', answer: 'Postage is $0.26 a piece and a card holds 16 spots.' }, principal });
    expect(result.ok).toBe(true);
  });
});

describe('generated cases', () => {
  it('a checkpoint passes exactly when it is at least the rate the plan needs', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let i = 0; i < 40; i++) {
      const plan = corrected();
      plan.point = { reply_rate: 0.005 + rand() * 0.045, close_rate: 0.05 + rand() * 0.25 };
      plan.narrative = 'x';
      const base = checkPlan(plan);
      const needed = figure(base, 'spots_sold')! / figure(base, 'contacts')!;
      plan.checkpoints![0]!.atLeast = { numerator: Math.ceil(needed * 1000), denominator: 1000 };
      expect(codes(checkPlan(plan))).not.toContain('CHECKPOINT_TOO_LOW');
      if (Math.ceil(needed * 1000) > 0) {
        plan.checkpoints![0]!.atLeast = { numerator: Math.ceil(needed * 1000) - 1, denominator: 1000 };
        if ((Math.ceil(needed * 1000) - 1) / 1000 < needed) expect(codes(checkPlan(plan))).toContain('CHECKPOINT_TOO_LOW');
      }
    }
  });

  it('any figure, written at the precision shown, is recognised as itself', () => {
    for (const value of [0, 1, 16, 150, 1300, 5400, 10000, 0.03, 0.2, 1234.5]) {
      const text = value < 1 && value > 0 ? `${(value * 100).toFixed(0)}%` : `$${value.toLocaleString('en-US')}`;
      const [n] = numbersIn(text);
      expect(n, text).toBeTruthy();
    }
  });

  it('the digest covers the narrative', () => {
    const a = corrected();
    const b = corrected();
    b.narrative += ' ';
    expect(planDigest(a)).not.toBe(planDigest(b));
  });
});

describe('units', () => {
  it('combines, cancels and refuses', () => {
    const unitOf = (n: string) => ({ price: parseUnit('USD/package'), packages: parseUnit('package'), contacts: parseUnit('contact') } as Record<string, ReturnType<typeof parseUnit>>)[n] ?? null;
    expect(checkExpressionUnit('price * packages', 'USD', unitOf)).toBeNull();
    expect(checkExpressionUnit('price + packages', 'USD', unitOf)).toMatch(/mixes/);
    expect(checkExpressionUnit('packages / contacts', 'package/contact', unitOf)).toBeNull();
    expect(checkExpressionUnit('packages * 2 + 1', 'package', unitOf)).toBeNull();
    expect(() => parseUnit('USD per package')).toThrow();
  });
});
