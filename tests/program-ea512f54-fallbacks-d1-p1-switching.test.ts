import { describe, expect, it } from 'vitest';
import { makeFigure, unknownFigure, type Figure } from '../server/services/quant/graph.ts';
import type { Dependency, Substitute } from '../server/services/quant/fallbacks.ts';
import {
  authorityForSwitch,
  earlyWarning,
  minimumSampleFor,
  pathwayReliability,
  readReliability,
  safeguardEffect,
  switchDecision,
  WARNING_KINDS,
  type SwitchFacts,
  type WarningSignal,
} from '../server/services/quant/fallbackSwitch.ts';
import {
  detectionWasTimely,
  readFailureRecoveries,
  recordFailureRecovery,
  recurringFailureClasses,
  type FailureRecoveryInput,
} from '../server/services/quant/ledger.ts';
import { freshProject } from './helpers.ts';

function fig(meaning: string, unit: string, value: number): Figure {
  const made = makeFigure({ meaning, unit, value, status: 'EVIDENCED', source: `test record: ${meaning}` });
  if (!made.ok) throw new Error(made.reason);
  return made.figure;
}
const p = (m: string, v: number) => fig(m, 'probability', v);
const days = (m: string, v: number) => fig(m, 'days', v);
const usd = (m: string, v: number) => fig(m, 'USD', v);

function substitute(over: Partial<Substitute> & Pick<Substitute, 'key' | 'label'>): Substitute {
  return {
    readiness: 'VALIDATED',
    changes: ['PROVIDER'],
    capacity: fig(`${over.label} capacity`, 'units', 500),
    failureProbability: p(`${over.label} fails`, 0.1),
    eligibility: { authorized: true, meetsObligations: true, basis: 'approved alternative on record' },
    switchingCost: null,
    timeToSwitchDays: days(`${over.label} switch`, 2),
    overrides: {},
    recoveryVerification: 'first lot passes inspection',
    ...over,
  };
}

function dependency(over: Partial<Dependency> & Pick<Dependency, 'key'>): Dependency {
  return {
    label: over.key,
    servesActivity: 'deliver the order',
    primaryPath: `${over.key} primary`,
    primaryFailureProbability: p(`${over.key} primary fails`, 0.2),
    failureModes: [],
    substitutes: [],
    consequence: { cashAtRisk: usd('at risk', 10_000), obligations: ['client delivery'], capability: null, tolerableLoss: usd('tolerable', 100) },
    ...over,
  };
}

const safe: SwitchFacts = {
  internal: true,
  reversible: true,
  previouslyApproved: false,
  expandsContractTerms: false,
  spendsUnapprovedMoney: false,
  bypassesAccessRestriction: false,
  movesCustomerDataImproperly: false,
  incursNewObligation: false,
  primaryOutcomeKnown: true,
};
const internal = { ok: null, reason: 'no commercial action applies' };

describe('FALL-37-4: switch criteria — automatic only inside authority', () => {
  const sub = substitute({ key: 'model-b', label: 'Model route B' });

  it('fails over automatically for authorized, reversible internal work', () => {
    const d = switchDecision(sub, safe, internal);
    expect(d.action).toBe('AUTO_FAILOVER');
    expect(d.preconditions.length).toBeGreaterThan(0);
  });

  it('fails over automatically for a previously approved alternative even when external', () => {
    expect(switchDecision(sub, { ...safe, internal: false, reversible: false, previouslyApproved: true }, { ok: true, reason: 'grant' }).action).toBe('AUTO_FAILOVER');
  });

  it('escalates every listed reason, naming it, and an unknown answer to any of them', () => {
    const cases: [keyof SwitchFacts, RegExp][] = [
      ['expandsContractTerms', /contractual terms/],
      ['spendsUnapprovedMoney', /unapproved money|money nobody approved/],
      ['bypassesAccessRestriction', /access restriction/],
      ['movesCustomerDataImproperly', /customer data/],
      ['incursNewObligation', /new obligation/],
    ];
    for (const [fact, says] of cases) {
      const yes = switchDecision(sub, { ...safe, previouslyApproved: true, [fact]: true }, internal);
      expect(yes.action, fact).toBe('ESCALATE');
      expect(yes.reasons.join(' '), fact).toMatch(says);
      const unknown = switchDecision(sub, { ...safe, [fact]: null }, internal);
      expect(unknown.action, `${fact} unknown`).toBe('ESCALATE');
      expect(unknown.reasons.join(' ')).toMatch(/not known/);
    }
  });

  it('escalates external or irreversible work that nobody approved, and work the authority refuses', () => {
    expect(switchDecision(sub, { ...safe, internal: false }, { ok: true, reason: 'grant' }).action).toBe('ESCALATE');
    expect(switchDecision(sub, { ...safe, reversible: null }, internal).action).toBe('ESCALATE');
    const refused = switchDecision(sub, safe, { ok: false, reason: 'no grant in force' });
    expect(refused.action).toBe('ESCALATE');
    expect(refused.reasons.join(' ')).toMatch(/no grant in force/);
  });

  it('reconciles first when the failed effect may have happened, and refuses an ineligible or located substitute', () => {
    expect(switchDecision(sub, { ...safe, primaryOutcomeKnown: false }, internal).action).toBe('RECONCILE_FIRST');
    expect(switchDecision(substitute({ key: 'x', label: 'X', eligibility: { authorized: null, meetsObligations: true, basis: '' } }), safe, internal).action).toBe('REFUSE');
    expect(switchDecision(substitute({ key: 'y', label: 'Y', readiness: 'LOCATED' }), safe, internal).action).toBe('REFUSE');
  });

  it('reads authority through the one commercial path and refuses an action it does not know', async () => {
    const fixture = await freshProject();
    expect(await authorityForSwitch(fixture.project.id, null)).toEqual({ ok: null, reason: 'no commercial action applies' });
    expect((await authorityForSwitch(fixture.project.id, 'NOT_AN_ACTION')).ok).toBe(false);
    const contact = await authorityForSwitch(fixture.project.id, 'CONTACT_BUYER');
    expect(contact.ok).toBe(false); // a fresh project holds no grant: deny by default
  });
});

describe('FALL-37-4: early warning justifies preventive action', () => {
  it('each signal kind over its threshold yields a preventive action with its justification', () => {
    const signals: WarningSignal[] = WARNING_KINDS.map((kind) => ({ kind, dependency: 'supplier-a', observed: 2, threshold: 1, source: 'monitor' }));
    const { actions, unjudged } = earlyWarning(signals);
    expect(actions.map((a) => a.kind)).toEqual([...WARNING_KINDS]);
    for (const a of actions) {
      expect(a.action.length).toBeGreaterThan(10);
      expect(a.justification).toMatch(/read 2 against a threshold of 1/);
    }
    expect(unjudged).toEqual([]);
  });

  it('a signal under threshold acts on nothing, and one with no threshold or reading is reported unjudged', () => {
    const { actions, unjudged } = earlyWarning([
      { kind: 'PRICE_INCREASE', dependency: 'd', observed: 0.01, threshold: 0.05, source: 's' },
      { kind: 'FAILURE_RATE', dependency: 'd', observed: 0.3, threshold: null, source: 's' },
      { kind: 'FORECAST_DRIFT', dependency: 'd', observed: null, threshold: 0.1, source: 's' },
    ]);
    expect(actions).toEqual([]);
    expect(unjudged.map((u) => u.why)).toEqual(['no threshold anyone set', 'no reading']);
  });
});

describe('FALL-37-4: reliability at every level, assurance only where earned', () => {
  const supplier = dependency({
    key: 'supplier-a',
    commonCauses: ['warehouse-1'],
    substitutes: [
      substitute({ key: 'supplier-b', label: 'Supplier B', failureProbability: p('B fails', 0.1), timeToSwitchDays: days('B switch', 3) }),
      substitute({ key: 'supplier-c', label: 'Supplier C', commonCauses: ['warehouse-1'], failureProbability: p('C fails', 0.05) }),
    ],
  });
  const payments = dependency({ key: 'payments', primaryFailureProbability: p('processor fails', 0.05) });

  it('computes pathway reliability with only independent eligible substitutes counting, and time to recovery', () => {
    const r = pathwayReliability('deliver-and-collect', [supplier, payments]);
    // supplier unserved: 0.2 × 0.1 (C shares the warehouse and adds nothing); payments: 0.05 with no substitute.
    expect(r.dependencies.map((d) => d.unserved)).toEqual([0.2 * 0.1, 0.05]);
    expect(r.reliability).toBeCloseTo((1 - 0.02) * (1 - 0.05), 10);
    expect(r.timeToRecoveryDays).toBeNull(); // payments has no eligible switch at all
    expect(pathwayReliability('supplier-only', [supplier]).timeToRecoveryDays).toBe(3);
  });

  it('substitutes sharing a common cause with each other count as one path, not as independent failures (F6)', () => {
    // Primary at warehouse W1; B and C both behind warehouse W2, independent of the primary but not of each other; D elsewhere.
    const correlated = dependency({
      key: 'shared-backups',
      commonCauses: ['WAREHOUSE:W1'],
      substitutes: [
        substitute({ key: 'b', label: 'B', commonCauses: ['WAREHOUSE:W2'], failureProbability: p('B fails', 0.3) }),
        substitute({ key: 'c', label: 'C', commonCauses: ['WAREHOUSE:W2'], failureProbability: p('C fails', 0.2) }),
      ],
    });
    const r = pathwayReliability('shared', [correlated]);
    // Before the repair this read 0.2 × 0.3 × 0.2 = 0.012, as if B and C failed independently.
    expect(r.dependencies[0]!.unserved).toBeCloseTo(0.2 * 0.2, 12);
    expect(r.dependencies[0]!.unserved).not.toBeCloseTo(0.2 * 0.3 * 0.2, 6);
    expect(r.dependencies[0]!.independentSubstitutes).toBe(1);
    expect(r.reliability).toBeCloseTo(1 - 0.04, 12);

    // A genuinely independent substitute still multiplies in.
    const withIndependent = dependency({ ...correlated, substitutes: [...correlated.substitutes, substitute({ key: 'd', label: 'D', commonCauses: ['WAREHOUSE:W3'], failureProbability: p('D fails', 0.5) })] });
    const r2 = pathwayReliability('shared+d', [withIndependent]);
    expect(r2.dependencies[0]!.independentSubstitutes).toBe(2);
    expect(r2.dependencies[0]!.unserved).toBeCloseTo(0.2 * 0.2 * 0.5, 12);

    // A chain of shared causes joins substitutes transitively, as scoreIndependence counts them.
    const chained = dependency({
      key: 'chained',
      substitutes: [
        substitute({ key: 'x', label: 'X', commonCauses: ['ACCOUNT:a', 'ACCOUNT:b'], failureProbability: p('X fails', 0.4) }),
        substitute({ key: 'y', label: 'Y', commonCauses: ['ACCOUNT:b'], failureProbability: p('Y fails', 0.25) }),
      ],
    });
    expect(pathwayReliability('chain', [chained]).dependencies[0]!.independentSubstitutes).toBe(1);
  });

  it('an unknown probability makes the pathway reliability unknown, with what is missing', () => {
    const r = pathwayReliability('p', [dependency({ key: 'q', primaryFailureProbability: unknownFigure('q fails', 'probability') })]);
    expect(r.reliability).toBeNull();
    expect(r.dependencies[0]!.missing).toEqual(['q: primary failure probability']);
  });

  it('never states a 90% outcome on a small sample, nor any assured floor', () => {
    const reading = readReliability({ pathways: [{ key: 'supplier-only', dependencies: [supplier] }], sampleSize: 5 });
    expect(reading.pathways[0]!.reliability).toBeCloseTo(0.98, 10);
    expect(reading.assurance.supported).toBe(false);
    expect(reading.assurance.statement).toMatch(/unsupported/);
    expect(reading.assuredFloor).toBeNull();
    expect(reading.floorStatement).toMatch(/not evidence of an assured floor/);
  });

  it('supports the target only with enough trials and a reliability that reaches it', () => {
    const needed = minimumSampleFor(0.9);
    expect(needed).toBe(30);
    expect(readReliability({ pathways: [{ key: 's', dependencies: [supplier] }], sampleSize: needed }).assurance.supported).toBe(true);
    expect(readReliability({ pathways: [{ key: 's', dependencies: [supplier, dependency({ key: 'weak', primaryFailureProbability: p('weak', 0.5) })] }], sampleSize: 100 }).assurance.supported).toBe(false);
    expect(readReliability({ pathways: [{ key: 'u', dependencies: [dependency({ key: 'q', primaryFailureProbability: unknownFigure('q', 'probability') })] }], sampleSize: 100 }).assurance.statement).toMatch(/unknown/);
  });

  it('shows each safeguard\'s effect on the chance of success and on expected net economics', () => {
    const effect = safeguardEffect({
      pathway: 'collect',
      dependencies: [payments],
      dependencyKey: 'payments',
      safeguard: substitute({ key: 'processor-b', label: 'Processor B', failureProbability: p('B fails', 0.2) }),
      valueAtStake: usd('pathway value', 20_000),
      cost: usd('second processor', 50),
    });
    expect(effect.successBefore).toBeCloseTo(0.95, 10);
    expect(effect.successAfter).toBeCloseTo(1 - 0.05 * 0.2, 10);
    expect(effect.successDelta).toBeCloseTo(0.04, 10);
    expect(effect.expectedNetDelta).toBeCloseTo(0.04 * 20_000 - 50, 6);
    const correlated = safeguardEffect({
      pathway: 'collect',
      dependencies: [dependency({ key: 'payments', commonCauses: ['one-platform'], primaryFailureProbability: p('fails', 0.05) })],
      dependencyKey: 'payments',
      safeguard: substitute({ key: 'same-platform', label: 'Same platform', commonCauses: ['one-platform'] }),
      valueAtStake: usd('v', 20_000),
      cost: usd('c', 50),
    });
    expect(correlated.successDelta).toBe(0);
    expect(correlated.expectedNetDelta).toBe(-50);
  });
});

describe('FALL-37-4: every failure and recovery is recorded and recurring classes are countable', () => {
  const base = (occurrence: string, failureClass: string, over: Partial<FailureRecoveryInput> = {}): FailureRecoveryInput => ({
    occurrence,
    dependency: 'supplier-a',
    failureMode: 'missed-ship-date',
    failureClass,
    detectionDelayDays: 1,
    timeToHarmDays: 5,
    tried: ['moved the order to Supplier B'],
    recovered: true,
    cashLostCents: 0,
    cashPreservedCents: 400_000,
    timeLostDays: 2,
    reputation: null,
    methodsToImprove: ['reserve the substitute before the ship date'],
    ...over,
  });

  it('judges detection timeliness from the figures, unknown when either is', () => {
    expect(detectionWasTimely(1, 5)).toBe(true);
    expect(detectionWasTimely(6, 5)).toBe(false);
    expect(detectionWasTimely(null, 5)).toBeNull();
  });

  it('appends through recordBinEvent, reads back, writes an occurrence once, and counts a recurring class', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const first = await recordFailureRecovery(base('occ-1', 'SUPPLIER_LATE'), { projectId });
    expect(first.written).toBe(true);
    expect(first.record.detectionTimely).toBe(true);
    expect((await recordFailureRecovery(base('occ-1', 'SUPPLIER_LATE', { recovered: false }), { projectId })).written).toBe(false);
    await recordFailureRecovery(base('occ-2', 'SUPPLIER_LATE', { detectionDelayDays: 7, recovered: false, methodsToImprove: ['watch the advance ship notice'] }), { projectId });
    await recordFailureRecovery(base('occ-3', 'PROCESSOR_DOWN'), { projectId });

    const rows = await readFailureRecoveries(projectId);
    expect(rows.map((r) => r.occurrence).sort()).toEqual(['occ-1', 'occ-2', 'occ-3']);
    expect(rows.find((r) => r.occurrence === 'occ-1')!.recovered).toBe(true);

    const recurring = recurringFailureClasses(rows);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({ failureClass: 'SUPPLIER_LATE', occurrences: 2, recovered: 1, notRecovered: 1, untimelyDetections: 1 });
    expect(recurring[0]!.methodsToImprove).toContain('watch the advance ship notice');
  });
});

describe('goal-portfolio bounds (repair-F5-2)', () => {
  it('reads every goal reaching its target at the Fréchet lower bound and the correlated downside at its upper', async () => {
    const { goalPortfolioBounds } = await import('../server/services/quant/fallbackSwitch.ts');
    const b = goalPortfolioBounds([
      { goalId: 'a', reach: 0.9, basis: 'PROBABILITY' },
      { goalId: 'b', reach: 0.8, basis: 'PROBABILITY' },
    ])!;
    expect(b.reliability.low).toBeCloseTo(0.7, 10);
    expect(b.reliability.high).toBeCloseTo(0.8, 10);
    expect(b.downside.low).toBeCloseTo(0.2, 10);
    expect(b.downside.high).toBeCloseTo(0.3, 10);
    expect(b.basis).toBe('PROBABILITY');
    expect(goalPortfolioBounds([{ goalId: 'a', reach: 0.9, basis: 'PROBABILITY' }, { goalId: 'c', reach: 0.9, basis: 'COVERAGE' }])!.basis).toBe('COVERAGE');
    expect(goalPortfolioBounds([{ goalId: 'a', reach: null, basis: null }])).toBeNull();
    expect(goalPortfolioBounds([])).toBeNull();
  });
});
