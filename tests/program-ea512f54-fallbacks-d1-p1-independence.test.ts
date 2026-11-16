/**
 * FALL-37-3: independence is scored by common cause, not by the number of
 * named backups; concentration and the correlated tail are reported per
 * cause; diversity is recommended only when it pays; a fallback that makes
 * things worse is ineligible; an unknown confirmation is reconciled, never
 * retried. Two unrelated domains: acquisition channels on shared accounts,
 * and suppliers behind a shared warehouse.
 */
import { describe, expect, it } from 'vitest';
import { makeFigure, unknownFigure, type Figure } from '../server/services/quant/graph.ts';
import type { Dependency, Substitute } from '../server/services/quant/fallbacks.ts';
import { optimizePortfolio, type Activity, type PortfolioProblem } from '../server/services/quant/portfolio.ts';
import {
  HARM_CLASSES,
  assessEligibility,
  judgeDiversity,
  nextFallbackAction,
  objectiveCommonCauses,
  scoreIndependence,
} from '../server/services/quant/fallbackIndependence.ts';

function fig(meaning: string, unit: string, value: number): Figure {
  const made = makeFigure({ meaning, unit, value, status: 'EVIDENCED', source: `test record: ${meaning}` });
  if (!made.ok) throw new Error(made.reason);
  return made.figure;
}
const p = (meaning: string, value: number) => fig(meaning, 'probability', value);
const usd = (meaning: string, value: number) => fig(meaning, 'USD', value);

function sub(over: Partial<Substitute> & Pick<Substitute, 'key'>): Substitute {
  return {
    label: over.key,
    readiness: 'VALIDATED',
    changes: ['PROVIDER'],
    capacity: fig(`${over.key} capacity`, 'units', 100),
    failureProbability: p(`${over.key} fails`, 0.1),
    eligibility: { authorized: true, meetsObligations: true, basis: 'approved alternative on record' },
    switchingCost: null,
    timeToSwitchDays: null,
    overrides: {},
    recoveryVerification: null,
    ...over,
  };
}

function dependency(over: Partial<Dependency> & Pick<Dependency, 'key' | 'substitutes'>): Dependency {
  return {
    label: over.key,
    servesActivity: 'a goal pathway',
    primaryPath: 'the primary',
    primaryFailureProbability: p('primary fails', 0.2),
    failureModes: [],
    consequence: { cashAtRisk: usd('cash at risk', 10_000), obligations: [], capability: null, tolerableLoss: usd('tolerable', 100) },
    ...over,
  };
}

const safe = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { safe: true }]));

/* Domain 1: acquisition channels. Three on one ad account; one through a partner's list. */
const channels = dependency({
  key: 'acquisition',
  commonCauses: ['ACCOUNT:ads-1'],
  substitutes: [
    sub({ key: 'search-ads', commonCauses: ['ACCOUNT:ads-1'] }),
    sub({ key: 'display-ads', commonCauses: ['ACCOUNT:ads-1'] }),
    sub({ key: 'video-ads', commonCauses: ['ACCOUNT:ads-1'] }),
    sub({ key: 'partner-list', commonCauses: ['PARTNER:p1'], changes: ['DISTRIBUTION'] }),
  ],
});

/* Domain 2: suppliers. Two behind one warehouse; one elsewhere. */
const suppliers = dependency({
  key: 'supply',
  commonCauses: ['WAREHOUSE:w1'],
  substitutes: [
    sub({ key: 'supplier-b', commonCauses: ['WAREHOUSE:w1'] }),
    sub({ key: 'supplier-c', commonCauses: ['WAREHOUSE:w1'] }),
    sub({ key: 'supplier-d', commonCauses: ['WAREHOUSE:w2'] }),
  ],
});

describe('FALL-37-3 — independence, not count', () => {
  it('backups sharing a common cause score as one path, whatever their count', () => {
    const allOnOne = dependency({ key: 'one-account', commonCauses: ['ACCOUNT:ads-1'], substitutes: channels.substitutes.slice(0, 3) });
    const r = scoreIndependence(allOnOne, { assessments: safe(['search-ads', 'display-ads', 'video-ads']) });
    expect(r.namedBackups).toBe(3);
    expect(r.independentBackups).toBe(0);
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.members).toEqual(['primary', 'display-ads', 'search-ads', 'video-ads']);

    const c = scoreIndependence(channels, { assessments: safe(channels.substitutes.map((s) => s.key)) });
    expect(c.namedBackups).toBe(4);
    expect(c.independentBackups).toBe(1);
    const s = scoreIndependence(suppliers, { assessments: safe(suppliers.substitutes.map((x) => x.key)) });
    expect(s.namedBackups).toBe(3);
    expect(s.independentBackups).toBe(1);
  });

  it('a chain of shared causes joins paths transitively', () => {
    const chained = dependency({
      key: 'chain',
      commonCauses: ['A'],
      substitutes: [sub({ key: 'x', commonCauses: ['A', 'B'] }), sub({ key: 'y', commonCauses: ['B'] }), sub({ key: 'z', commonCauses: ['C'] })],
    });
    const r = scoreIndependence(chained, { assessments: safe(['x', 'y', 'z']) });
    expect(r.independentBackups).toBe(1);
    expect(r.paths.find((one) => one.includesPrimary)!.members).toEqual(['primary', 'x', 'y']);
  });

  it('reports concentration and the correlated tail per common cause', () => {
    const r = scoreIndependence(channels, { assessments: safe(channels.substitutes.map((s) => s.key)), causeFailure: { 'ACCOUNT:ads-1': 0.05, 'PARTNER:p1': 0.1 } });
    const account = r.concentration.find((one) => one.cause === 'ACCOUNT:ads-1')!;
    expect(account.paths).toEqual(['primary', 'search-ads', 'display-ads', 'video-ads']);
    expect(account.share).toBeCloseTo(0.8);
    expect(account.survivorsIfItFails).toEqual(['partner-list']);
    expect(account.tailProbability).toBeCloseTo(0.05 * 0.1);
    expect(r.jointFailureProbability).not.toBeNull();
    // Without the cause's failure probability, the tail is unknown and named as missing — never zero.
    const blind = scoreIndependence(channels, { assessments: safe(channels.substitutes.map((s) => s.key)) });
    expect(blind.concentration.find((one) => one.cause === 'ACCOUNT:ads-1')!.tailProbability).toBeNull();
    expect(blind.jointFailureProbability).toBeNull();
    expect(blind.missing).toContain('failure probability of common cause ACCOUNT:ads-1');
  });

  it('reads objective-level common causes through challenge.ts detectSharedExposure on the portfolio worlds', () => {
    const act = (key: string, needs: string[]): Activity => ({ key, label: key, cash: [60], days: [2], justified: true, capital: 10, evidence: { sampleSize: 30 }, needs });
    // Two wedges that both ride on one payments provider, and are both needed to reach the target.
    const problem: PortfolioProblem = { activities: [act('w1', ['payments-x']), act('w2', ['payments-x'])], target: 100, deadlineDays: 10, startingCapital: 100, worlds: 2000, resourceFailure: { 'payments-x': 0.2 } } as PortfolioProblem;
    const best = optimizePortfolio(problem).best!;
    expect(best.keys.sort()).toEqual(['w1', 'w2']);
    const causes = objectiveCommonCauses(problem, best);
    const shared = causes.find((one) => one.cause === 'RESOURCE:payments-x')!;
    expect(shared.activities.sort()).toEqual(['w1', 'w2']);
    expect(shared.share).toBe(1);
    expect(shared.failureProbability).toBe(0.2);
    expect(shared.reachIfItFails).toBe(0);
    expect(shared.reachAsPlanned).toBe(best.reach);
  });
});

describe('FALL-37-3 — diversity only where it pays', () => {
  const base = dependency({ key: 'supply-2', commonCauses: ['WAREHOUSE:w1'], substitutes: [sub({ key: 'supplier-b', commonCauses: ['WAREHOUSE:w1'] })] });
  const causeFailure = { 'WAREHOUSE:w1': 0.1, 'WAREHOUSE:w2': 0.05 };
  const independent = sub({ key: 'supplier-d', commonCauses: ['WAREHOUSE:w2'] });
  const correlated = sub({ key: 'supplier-c', commonCauses: ['WAREHOUSE:w1'] });
  const assessments = safe(['supplier-b', 'supplier-c', 'supplier-d']);

  it('recommends an independent fallback whose removed expected loss exceeds its cost and capital exposure', () => {
    const r = judgeDiversity(base, independent, { cost: usd('cost', 200), capitalExposure: usd('capital', 100) }, { assessments, causeFailure });
    expect(r.verdict).toBe('RECOMMENDED');
    expect(r.expectedLossBefore! - r.expectedLossAfter!).toBeGreaterThan(300);
  });

  it('does not recommend it when cost plus capital exposure exceeds what it removes', () => {
    const r = judgeDiversity(base, independent, { cost: usd('cost', 5_000), capitalExposure: usd('capital', 5_000) }, { assessments, causeFailure });
    expect(r.verdict).toBe('NOT_WORTH_IT');
  });

  it('a backup on the same common cause removes little and is not worth its price', () => {
    const r = judgeDiversity(base, correlated, { cost: usd('cost', 200), capitalExposure: usd('capital', 100) }, { assessments, causeFailure });
    expect(r.verdict).toBe('NOT_WORTH_IT');
    expect(r.because).toMatch(/adds no independent one/);
  });

  it('option value counts toward the gain, and an unknown figure is never judged', () => {
    const r = judgeDiversity(base, independent, { cost: usd('cost', 5_000), capitalExposure: usd('capital', 0), optionValue: usd('option', 10_000) }, { assessments, causeFailure });
    expect(r.verdict).toBe('RECOMMENDED');
    const blank = judgeDiversity(base, independent, { cost: unknownFigure('cost', 'USD'), capitalExposure: usd('capital', 0) }, { assessments, causeFailure });
    expect(blank.verdict).toBe('NOT_JUDGED');
  });
});

describe('FALL-37-3 — a fallback that makes things worse is not eligible', () => {
  it('each harm class alone makes a fallback HARMFUL and ineligible, and it is not scored as a path', () => {
    for (const harm of HARM_CLASSES) {
      const s = sub({ key: `h-${harm}`, commonCauses: ['OTHER'] });
      const reading = assessEligibility(s, { harms: [harm], safe: true });
      expect(reading.status, harm).toBe('HARMFUL');
      expect(nextFallbackAction(s, { harms: [harm], safe: true }).action, harm).toBe('INELIGIBLE');
      const scored = scoreIndependence(dependency({ key: 'd', substitutes: [s] }), { assessments: { [s.key]: { harms: [harm], safe: true } } });
      expect(scored.independentBackups, harm).toBe(0);
    }
  });

  it('failing obligations, authority or safety makes a fallback ineligible', () => {
    expect(assessEligibility(sub({ key: 'a', eligibility: { authorized: false, meetsObligations: true, basis: '' } }), { safe: true }).status).toBe('INELIGIBLE');
    expect(assessEligibility(sub({ key: 'o', eligibility: { authorized: true, meetsObligations: false, basis: '' } }), { safe: true }).status).toBe('INELIGIBLE');
    expect(assessEligibility(sub({ key: 's' }), { safe: false }).status).toBe('INELIGIBLE');
    expect(assessEligibility(sub({ key: 'ok' }), { safe: true }).status).toBe('ELIGIBLE');
  });
});

describe('FALL-37-3 — unknown is reconciled, never retried', () => {
  it('an unknown external confirmation returns RECONCILE_FIRST, and no action is ever a retry', () => {
    const s = sub({ key: 'booked' });
    const r = nextFallbackAction(s, { safe: true, externalConfirmation: 'UNKNOWN' });
    expect(r.action).toBe('RECONCILE_FIRST');
    expect(nextFallbackAction(sub({ key: 'unrecorded', eligibility: { authorized: null, meetsObligations: true, basis: '' } }), { safe: true }).action).toBe('RECONCILE_FIRST');
    expect(nextFallbackAction(s, { safe: true, externalConfirmation: 'CONFIRMED' }).action).toBe('SWITCH');
    const actions = new Set(['SWITCH', 'RECONCILE_FIRST', 'INELIGIBLE']);
    for (const confirmation of ['CONFIRMED', 'REFUSED', 'UNKNOWN', null] as const) {
      expect(actions.has(nextFallbackAction(s, { safe: true, externalConfirmation: confirmation }).action)).toBe(true);
    }
  });
});
