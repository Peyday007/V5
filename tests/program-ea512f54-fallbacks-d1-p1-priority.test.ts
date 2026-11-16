/**
 * FALL-37-6: fallbacks are prioritized by consequence, cheap reversible
 * backups are prepared early, a live dependency promotes its safeguard with a
 * stated reason, and the ranking writes, schedules and pauses nothing
 * (`server/services/quant/fallbackPriority.ts`). Dependencies come from
 * unrelated domains: a payments provider, a research evidence route, a data
 * backup, an outbound-email channel and an internal report.
 */
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  keepCashLedger,
  prepareFallbacks,
  readFallbackPreparation,
  recordFailureRecovery,
  recordFallbackDependency,
  withLiveFailures,
  type FailureRecoveryRecord,
} from '../server/services/quant/ledger.ts';
import type { CashForecast } from '../server/services/cash/forecast.ts';
import { makeFigure, unknownFigure, type Figure } from '../server/services/quant/graph.ts';
import type { Dependency, Substitute } from '../server/services/quant/fallbacks.ts';
import {
  CONSEQUENCE_CLASSES,
  REUSED_OWNERS,
  decidingClass,
  isLowCost,
  rankFallbacks,
  type PriorityInput,
} from '../server/services/quant/fallbackPriority.ts';

function fig(meaning: string, unit: string, value: number): Figure {
  const made = makeFigure({ meaning, unit, value, status: 'EVIDENCED', source: `test record: ${meaning}` });
  if (!made.ok) throw new Error(made.reason);
  return made.figure;
}
const usd = (meaning: string, value: number) => fig(meaning, 'USD', value);

function substitute(key: string, over: Partial<Substitute> = {}): Substitute {
  return {
    key,
    label: key,
    changes: ['PROVIDER'],
    readiness: 'VALIDATED',
    capacity: fig(`${key} capacity`, 'units', 100),
    failureProbability: unknownFigure(`${key} failure probability`, 'probability'),
    eligibility: { authorized: true, meetsObligations: true, basis: 'approved alternative on record' },
    switchingCost: null,
    timeToSwitchDays: null,
    overrides: {},
    recoveryVerification: null,
    ...over,
  };
}

function dependency(key: string, substitutes: Substitute[], cashAtRisk = 1000): Dependency {
  return {
    key,
    label: key,
    servesActivity: `activity behind ${key}`,
    primaryPath: `primary path of ${key}`,
    primaryFailureProbability: fig(`${key} fails`, 'probability', 0.1),
    failureModes: [],
    substitutes,
    consequence: {
      cashAtRisk: usd(`${key} cash at risk`, cashAtRisk),
      obligations: [],
      capability: null,
      tolerableLoss: usd(`${key} tolerable loss`, 10),
    },
  };
}

function input(key: string, over: Partial<PriorityInput> = {}, subs?: Substitute[]): PriorityInput {
  return {
    dependency: dependency(key, subs ?? [substitute(`${key}-alt`)]),
    consequences: [],
    nominalPriority: 5,
    ...over,
  };
}

describe('fallbackPriority: consequence sets the priority', () => {
  it.each(CONSEQUENCE_CLASSES)('%s ranks above a fallback with no consequence, and is named as deciding', (klass) => {
    const ranking = rankFallbacks([
      // The no-consequence one is nominally earlier, so consequence alone must move it.
      input('internal-report', { nominalPriority: 1 }),
      input('consequential', { nominalPriority: 9, consequences: [{ class: klass, basis: 'stated by the caller' }] }),
    ]);
    expect(ranking.ranked.map((one) => one.dependency)).toEqual(['consequential', 'internal-report']);
    expect(ranking.ranked[0]!.decidedBy).toBe(klass);
    expect(ranking.ranked[0]!.reason).toContain(`decided by ${klass}`);
    expect(ranking.ranked[1]!.decidedBy).toBe('NO_CONSEQUENCE');
  });

  it('a class the caller names outside the six still counts as a consequence (no whitelist)', () => {
    const ranking = rankFallbacks([
      input('internal-report', { nominalPriority: 1 }),
      input('licence', { nominalPriority: 9, consequences: [{ class: 'REGULATORY_LAPSE', basis: 'licence renewal' }] }),
    ]);
    expect(ranking.ranked[0]!.dependency).toBe('licence');
    expect(ranking.ranked[0]!.decidedBy).toBe('REGULATORY_LAPSE');
  });

  it('the deciding class is the first the specification names among those carried', () => {
    expect(
      decidingClass([
        { class: 'LOST_DATA', basis: 'x' },
        { class: 'FINANCIAL_LOSS', basis: 'y' },
      ]),
    ).toBe('FINANCIAL_LOSS');
    expect(decidingClass([])).toBeNull();
  });
});

describe('fallbackPriority: cheap reversible backups are prepared early', () => {
  const ceiling = usd('low-cost ceiling', 200);
  const consequences = [{ class: 'LOST_DATA' as const, basis: 'customer records' }];

  it('among equal consequence, a low-cost reversible backup ranks first and is marked for early preparation', () => {
    const ranking = rankFallbacks([
      input(
        'data-backup',
        { consequences, lowCostCeiling: ceiling, reversible: { 'snapshot-copy': true, 'second-vendor': false } },
        [
          substitute('second-vendor', { switchingCost: usd('migrate to vendor', 5000) }),
          substitute('snapshot-copy', { switchingCost: usd('nightly snapshot to cold storage', 40) }),
        ],
      ),
    ]);
    expect(ranking.ranked.map((one) => one.substitute)).toEqual(['snapshot-copy', 'second-vendor']);
    expect(ranking.ranked[0]!.prepareEarly).toBe(true);
    expect(ranking.ranked[0]!.reason).toContain('prepare early');
    expect(ranking.ranked[1]!.prepareEarly).toBe(false);
  });

  it('an unknown cost or unstated reversibility is not read as cheap or reversible', () => {
    const sub = substitute('mystery', { switchingCost: null });
    expect(isLowCost(sub, ceiling)).toBeNull();
    expect(isLowCost(substitute('priced', { switchingCost: usd('c', 10) }), undefined)).toBeNull();
    const ranking = rankFallbacks([
      input('channel', { consequences, lowCostCeiling: ceiling }, [substitute('cheap-unstated', { switchingCost: usd('c', 10) })]),
    ]);
    expect(ranking.ranked[0]!.lowCost).toBe(true);
    expect(ranking.ranked[0]!.reversible).toBeNull();
    expect(ranking.ranked[0]!.prepareEarly).toBe(false);
  });

  it('cheapness never lifts a fallback above one with greater consequence', () => {
    const ranking = rankFallbacks([
      input('internal-report', { lowCostCeiling: ceiling, reversible: { 'internal-report-alt': true } }, [
        substitute('internal-report-alt', { switchingCost: usd('c', 1) }),
      ]),
      input('payments', { consequences: [{ class: 'FINANCIAL_LOSS', basis: 'settlement' }] }),
    ]);
    expect(ranking.ranked[0]!.dependency).toBe('payments');
  });
});

describe('fallbackPriority: a live dependency promotes its safeguard', () => {
  it('moves ahead of nominal priority and of greater consequence, with the reason recorded', () => {
    const reason = 'outbound email provider reports a live incident; sends are failing now';
    const ranking = rankFallbacks([
      input('payments', { nominalPriority: 1, consequences: [{ class: 'FINANCIAL_LOSS', basis: 'settlement' }] }),
      input('email-channel', { nominalPriority: 8, live: { necessary: true, reason } }),
    ]);
    expect(ranking.ranked[0]!.dependency).toBe('email-channel');
    expect(ranking.ranked[0]!.promoted).toBe(true);
    expect(ranking.ranked[0]!.decidedBy).toBe('LIVE_DEPENDENCY');
    expect(ranking.ranked[0]!.promotedBecause).toBe(reason);
    expect(ranking.ranked[0]!.reason).toContain(reason);
    expect(ranking.ranked[1]!.promoted).toBe(false);
    expect(ranking.ranked[1]!.promotedBecause).toBeNull();
  });

  it('refuses a live promotion with no stated reason', () => {
    expect(() => rankFallbacks([input('email-channel', { live: { necessary: true, reason: ' ' } })])).toThrow(/stated reason/);
  });

  it('ranking does not make an ineligible substitute eligible', () => {
    const ranking = rankFallbacks([
      input('research-source', { live: { necessary: true, reason: 'primary source offline' } }, [
        substitute('mirror', { evidenceRoute: { verified: false, basis: 'unofficial mirror' } }),
      ]),
    ]);
    expect(ranking.ranked[0]!.eligible).toBe(false);
    expect(ranking.ranked[0]!.ineligibleBecause.join(' ')).toContain('unverified');
  });
});

describe('fallbackPriority: owns nothing and pauses nothing', () => {
  const source = readFileSync(new URL('../server/services/quant/fallbackPriority.ts', import.meta.url), 'utf8');

  it('has no write, no timer, no table and no database or scheduler import', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/setTimeout|setInterval|setImmediate/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./fallbacks.ts', './graph.ts']);
  });

  it('produces no action on discovery or execution, and names the existing owners it reuses', () => {
    const ranking = rankFallbacks([input('a'), input('b', { live: { necessary: true, reason: 'live' } })]);
    expect(ranking.preservesOngoingWork).toBe(true);
    for (const one of ranking.ranked) {
      expect(Object.keys(one).sort()).toEqual(
        [
          'changesMechanism',
          'consequenceClasses',
          'decidedBy',
          'dependency',
          'eligible',
          'ineligibleBecause',
          'lowCost',
          'nominalPriority',
          'prepareEarly',
          'promoted',
          'promotedBecause',
          'rank',
          'reason',
          'reversible',
          'substitute',
        ].sort(),
      );
    }
    for (const path of Object.values(REUSED_OWNERS)) {
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
    }
  });

  it('is deterministic: the same inputs give the same order', () => {
    const inputs = [input('x'), input('y'), input('z', { consequences: [{ class: 'LOST_DATA', basis: 'b' }] })];
    expect(rankFallbacks(inputs)).toEqual(rankFallbacks(inputs));
  });
});

/* ------------------------------------------------------------------------- */
/* Invoked in production: the cash-ledger refresh ranks and records it         */
/* ------------------------------------------------------------------------- */

function failure(dependency: string, occurrence: string, recovered: boolean | null): FailureRecoveryRecord {
  return {
    occurrence,
    dependency,
    failureMode: 'provider outage',
    failureClass: 'provider-outage',
    detectionDelayDays: 1,
    timeToHarmDays: 3,
    detectionTimely: true,
    tried: ['retry'],
    recovered,
    cashLostCents: null,
    cashPreservedCents: null,
    timeLostDays: null,
    reputation: null,
    methodsToImprove: [],
    at: '2026-11-01T00:00:00.000Z',
  };
}

describe('fallback preparation on the ledger: an unrecovered failure makes its dependency live', () => {
  it('promotes a dependency with an unrecovered failure, citing it, and leaves recovered ones alone', () => {
    const out = withLiveFailures(
      [input('payments'), input('email'), input('backup', { live: { necessary: false, reason: 'stated by caller' } })],
      [failure('payments', 'occ-1', null), failure('email', 'occ-2', true), failure('backup', 'occ-3', false)],
    );
    expect(out[0]!.live).toEqual({ necessary: true, reason: 'failure occ-1 (provider outage) is on record and recovery is not yet known' });
    expect(out[1]!.live).toBeUndefined();
    expect(out[2]!.live).toEqual({ necessary: false, reason: 'stated by caller' });
  });

  it('records the order once and writes nothing again while it is unchanged', async () => {
    const written: unknown[] = [];
    const record = async (row: unknown) => {
      written.push(row);
    };
    const declarations = async () => [input('payments', { consequences: [{ class: 'FINANCIAL_LOSS', basis: 'card revenue' }] }), input('report')];
    const first = await prepareFallbacks('prj', { record, declarations, failures: async () => [], last: async () => null });
    expect(first.written).toBe(true);
    expect(first.ranking.ranked.map((r) => r.dependency)).toEqual(['payments', 'report']);
    const again = await prepareFallbacks('prj', { record, declarations, failures: async () => [], last: async () => first.record });
    expect(again.written).toBe(false);
    expect(written).toHaveLength(1);
  });
});

describe('fallback preparation is invoked by the cash-ledger refresh and recorded on production rows', () => {
  it('keepCashLedger ranks the declared dependencies, promotes the one with a live failure, and records it once', async () => {
    const { project } = await freshProject();
    const projectId = project.id;
    await recordFallbackDependency(
      input('payments-provider', {
        nominalPriority: 1,
        consequences: [{ class: 'FINANCIAL_LOSS', basis: 'every card payment routes through it' }],
        reversible: { 'payments-provider-alt': true },
        lowCostCeiling: usd('low-cost ceiling', 100),
      }, [substitute('payments-provider-alt', { switchingCost: usd('switch to the alternate processor', 40) })]),
      { projectId },
    );
    await recordFallbackDependency(input('weekly-report', { nominalPriority: 9 }), { projectId });
    await recordFailureRecovery(
      { ...failure('weekly-report', `occ-${projectId}`, null) } as Omit<FailureRecoveryRecord, 'detectionTimely' | 'at'>,
      { projectId },
    );

    const forecast = {
      projectId,
      currency: 'USD',
      considered: 0,
      qualified: 0,
      revenue: { valueCents: null, lowCents: null, highCents: null, basis: 'none', fromRows: 0 },
      contribution: { valueCents: null, lowCents: null, highCents: null, basis: 'none', fromRows: 0 },
      upfrontCash: { valueCents: null, lowCents: null, highCents: null, basis: 'none', fromRows: 0 },
      timeToFirstDollar: { days: null },
    } as unknown as CashForecast;
    const kept = await keepCashLedger(projectId, ['USD'], { forecast: async () => forecast, measured: async () => [] });
    expect(kept.preparation).toEqual({ ranked: 2, written: true });

    const recorded = await readFallbackPreparation(projectId);
    expect(recorded).not.toBeNull();
    expect(recorded!.ranked.map((r) => r.dependency)).toEqual(['weekly-report', 'payments-provider']);
    expect(recorded!.ranked[0]).toMatchObject({ promoted: true, decidedBy: 'LIVE_DEPENDENCY' });
    expect(recorded!.ranked[0]!.promotedBecause).toContain(`occ-${projectId}`);
    expect(recorded!.ranked[1]).toMatchObject({ decidedBy: 'FINANCIAL_LOSS', prepareEarly: true });
    expect(recorded!.owners).toEqual(REUSED_OWNERS);

    const again = await keepCashLedger(projectId, ['USD'], { forecast: async () => forecast, measured: async () => [] });
    expect(again.preparation).toEqual({ ranked: 2, written: false });
  });

  it('the ranking has a production caller: the ledger refresh calls it', () => {
    const ledger = readFileSync(new URL('../server/services/quant/ledger.ts', import.meta.url), 'utf8');
    expect(ledger).toMatch(/import\('\.\/fallbackPriority\.ts'\)/);
    expect(ledger).toMatch(/deps\.prepare \?\? prepareFallbacks/);
  });
});
