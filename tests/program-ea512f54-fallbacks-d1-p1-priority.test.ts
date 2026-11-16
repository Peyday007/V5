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

/*
 * Reviewer finding (repair-F5): rankFallbacks was never invoked, and no
 * preparation of any backup was recorded through the owners REUSED_OWNERS
 * names. Every cash-ledger refresh (keepCashLedger, reached from every
 * cash-knowledge refresh) now ranks the project's real acquisition
 * dependency for preparation and records the order on the ledger.
 */
describe('on production rows: fallbacks are ranked for preparation on every cash-ledger refresh', async () => {
  const { beforeEach } = await import('vitest');
  const { freshProject } = await import('./helpers.ts');
  const { getDb } = await import('../server/db/database.ts');
  const { insertOutcome } = await import('../server/repos/cashJourney.ts');
  const { keepCashLedger, recordFailureRecovery } = await import('../server/services/quant/ledger.ts');
  const { FALLBACK_PREPARATION_EVENT, prepareProjectFallbacks, readFallbackPreparation } = await import('../server/services/quant/fallbackPreparation.ts');

  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  async function path(mechanism: string, channel: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await insertOutcome({ projectId, opportunityId: `lead:${mechanism}:${i}`, kind: 'CONTACT_RESULT', mechanism, channel, valueText: i === 0 ? 'BUYER_REPLIED' : 'BUYER_SILENT', basis: 'test row', requestKey: `r:${mechanism}:${channel}:${i}` });
    }
  }
  const granted = async () => ({ ok: true, reason: 'standing authority permits CONTACT_BUYER' });
  const sprint = async () => ({ id: 'cmd_test', horizonDays: 30 });
  const count = async () => Number((await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM bin_events WHERE event_type = ? AND project_id = ?`, [FALLBACK_PREPARATION_EVENT, projectId]))?.n ?? 0);

  it('a cash sprint makes acquisition a blocked-revenue-objective dependency; a substitute path that already ran is cheap and reversible, so it is prepared early (F3-2)', async () => {
    await path('Campaign A', 'email (Instantly)', 4);
    await path('Partner list', 'partner referral', 2);
    const { ranking, written } = await prepareProjectFallbacks(projectId, { authority: granted, sprint, failures: async () => [] });
    expect(written).toBe(true);
    // Before F3-2 this read lowCost: null, reversible: null, prepareEarly: false on every production input.
    expect(ranking!.ranked).toEqual([
      expect.objectContaining({ rank: 1, substitute: 'Partner list @ partner referral', decidedBy: 'BLOCKED_REVENUE_OBJECTIVE', promoted: false, lowCost: true, reversible: true, prepareEarly: true, eligible: true }),
    ]);
    expect(ranking!.ranked[0]!.reason).toMatch(/low cost and reversible: prepare early/);
    expect(ranking!.preservesOngoingWork).toBe(true);
    const recorded = await readFallbackPreparation(projectId);
    expect(recorded!.ranked[0]!.prepareEarly).toBe(true);
  });

  it('with no cash sprint no consequence is claimed', async () => {
    await path('Campaign A', 'email (Instantly)', 3);
    await path('Partner list', 'partner referral', 1);
    const { ranking } = await prepareProjectFallbacks(projectId, { authority: granted, sprint: async () => null, failures: async () => [] });
    expect(ranking!.ranked[0]).toMatchObject({ decidedBy: 'NO_CONSEQUENCE', consequenceClasses: [] });
  });

  it('an unrecovered failure of the dependency on the ledger promotes it, with that failure as the reason', async () => {
    await path('Campaign A', 'email (Instantly)', 3);
    await path('Partner list', 'partner referral', 1);
    await recordFailureRecovery(
      {
        occurrence: 'occ-1', dependency: `acquisition:${projectId}`, failureMode: 'channel-stops-delivering', failureClass: 'CHANNEL_SUSPENDED',
        detectionDelayDays: 1, timeToHarmDays: 3, tried: ['paused sends'], recovered: null, cashLostCents: null, cashPreservedCents: null,
        timeLostDays: null, reputation: null, methodsToImprove: [],
      },
      { projectId },
    );
    const { ranking } = await prepareProjectFallbacks(projectId, { authority: granted, sprint });
    expect(ranking!.ranked[0]).toMatchObject({ decidedBy: 'LIVE_DEPENDENCY', promoted: true });
    expect(ranking!.ranked[0]!.promotedBecause).toMatch(/failure occ-1 \(channel-stops-delivering\) is on the ledger and recovery is not yet known/);
  });

  it('records the order once, again only when it changes, and nothing with no dependency on record', async () => {
    expect(await prepareProjectFallbacks(projectId, { authority: granted, sprint, failures: async () => [] })).toEqual({ ranking: null, written: false });
    await path('Campaign A', 'email (Instantly)', 3);
    await path('Partner list', 'partner referral', 1);
    expect((await prepareProjectFallbacks(projectId, { authority: granted, sprint, failures: async () => [] })).written).toBe(true);
    expect((await prepareProjectFallbacks(projectId, { authority: granted, sprint, failures: async () => [] })).written).toBe(false);
    await path('Campaign B', 'phone', 1);
    expect((await prepareProjectFallbacks(projectId, { authority: granted, sprint, failures: async () => [] })).written).toBe(true);
    expect(await count()).toBe(2);
  });

  it('runs on the production path: a cash-ledger refresh records the preparation order', async () => {
    await path('Campaign A', 'email (Instantly)', 3);
    await path('Campaign B', 'email (Instantly)', 1);
    await keepCashLedger(projectId, []);
    const held = await readFallbackPreparation(projectId);
    expect(held).not.toBeNull();
    expect(held!.ranked).toHaveLength(1);
    expect(held!.owners.ledger).toBe('server/services/quant/ledger.ts');
  });
});

/**
 * Review finding F3-2: the switch terms come from what the rows show about a
 * substitute, and only from that. A path that has not run, or a dependency
 * that carries obligations, is still not read as cheap or reversible.
 */
describe('switchTermsFor: cost and reversibility only where the rows show them (F3-2)', async () => {
  const { switchTermsFor, priorityInputFor, noApprovedSpendCeiling } = await import('../server/services/quant/fallbackPreparation.ts');
  const { acquisitionDependency } = await import('../server/services/quant/fallbackIndependence.ts');
  const granted = { ok: true, reason: 'standing authority permits CONTACT_BUYER' };
  const dep = acquisitionDependency('prj_x', [
    { mechanism: 'Campaign A', channel: 'email (Instantly)', contacts: 4 },
    { mechanism: 'Partner list', channel: 'partner referral', contacts: 2 },
  ], granted)!;
  const sub = dep.substitutes[0]!;

  it('a substitute that already ran, on a dependency with no obligations, commits 0 cents and is reversible, with its basis', () => {
    const terms = switchTermsFor(dep, sub)!;
    expect(terms.reversible).toBe(true);
    expect(terms.cost).toMatchObject({ value: 0, unit: 'cents', status: 'OBSERVED' });
    expect(terms.cost.source).toMatch(/already reached 2 prospect\(s\)/);
    expect(isLowCost({ ...sub, switchingCost: terms.cost }, noApprovedSpendCeiling())).toBe(true);
  });

  it('a path that has not run is not read as cheap or reversible', () => {
    expect(switchTermsFor(dep, { ...sub, readiness: 'LOCATED' })).toBeNull();
    expect(switchTermsFor(dep, { ...sub, capacity: { ...sub.capacity, value: 0 } })).toBeNull();
  });

  it('a dependency that carries obligations, or a substitute that does not meet them, is not read as cheap or reversible', () => {
    const bound = { ...dep, consequence: { ...dep.consequence, obligations: ['deliver 40 units to the buyer by Friday'] } };
    expect(switchTermsFor(bound, sub)).toBeNull();
    expect(switchTermsFor(dep, { ...sub, eligibility: { ...sub.eligibility, meetsObligations: false } })).toBeNull();
    const ranked = rankFallbacks([priorityInputFor(bound, { id: 'cmd', horizonDays: 30 }, [])]);
    expect(ranked.ranked[0]).toMatchObject({ lowCost: null, reversible: null, prepareEarly: false });
  });

  it('a switching cost a row already states is kept, not replaced', () => {
    const priced = { ...sub, switchingCost: usd('stated switch cost', 900) };
    const input = priorityInputFor({ ...dep, substitutes: [priced] }, null, []);
    expect(input.dependency.substitutes[0]!.switchingCost).toBe(priced.switchingCost);
    expect(input.reversible).toBeUndefined();
  });
});
