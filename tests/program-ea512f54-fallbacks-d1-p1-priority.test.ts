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

  it('a cash sprint makes acquisition a blocked-revenue-objective dependency; cost and reversibility unknown are not read as cheap', async () => {
    await path('Campaign A', 'email (Instantly)', 4);
    await path('Partner list', 'partner referral', 2);
    const { ranking, written } = await prepareProjectFallbacks(projectId, { authority: granted, sprint, failures: async () => [] });
    expect(written).toBe(true);
    expect(ranking!.ranked).toEqual([
      expect.objectContaining({ rank: 1, substitute: 'Partner list @ partner referral', decidedBy: 'BLOCKED_REVENUE_OBJECTIVE', promoted: false, lowCost: null, reversible: null, prepareEarly: false, eligible: true }),
    ]);
    expect(ranking!.preservesOngoingWork).toBe(true);
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

/*
 * Reviewer finding (repair-F2-2): live promotion could never fire, because the
 * ranking reads failures under the acquisition key and the only production
 * writer of failure records (the forecast watch) writes them under a forecast
 * claim id. The acquisition dependency's own failures are now recorded under
 * its own key, from its primary path's ordered contact results, on the same
 * refresh that ranks it.
 */
describe('on production rows: the acquisition dependency records its own failures, and a live one promotes its safeguards', async () => {
  const { beforeEach } = await import('vitest');
  const { freshProject } = await import('./helpers.ts');
  const { getDb } = await import('../server/db/database.ts');
  const { keepCashLedger, readFailureRecoveries } = await import('../server/services/quant/ledger.ts');
  const { readFallbackPreparation } = await import('../server/services/quant/fallbackPreparation.ts');
  const { acquisitionFailures } = await import('../server/services/quant/fallbackPlanReading.ts');

  const r = (id: string, result: string, day: number) => ({ id, result, at: new Date(Date.UTC(2026, 9, 1 + day)).toISOString() });

  it('pure: a run improbable under the path\'s own record is a failure; recovery is the next good result, unknown while the run is latest', () => {
    const delivered = Array.from({ length: 10 }, (_, i) => r(`d${i}`, 'BUYER_REPLIED', i));
    const ongoing = acquisitionFailures('acquisition:p', 'A @ email', [...delivered, r('u1', 'CONTACT_UNDELIVERABLE', 10), r('u2', 'CONTACT_UNDELIVERABLE', 12)]);
    expect(ongoing).toEqual([
      expect.objectContaining({
        occurrence: 'acquisition-failure:acquisition:p:A @ email:channel-stops-delivering:u1',
        dependency: 'acquisition:p',
        failureMode: 'channel-stops-delivering',
        failureClass: 'ACQUISITION:channel-stops-delivering',
        detectionDelayDays: 2,
        recovered: null,
        timeToHarmDays: null,
        tried: [],
      }),
    ]);
    const recovered = acquisitionFailures('acquisition:p', 'A @ email', [...delivered, r('u1', 'CONTACT_UNDELIVERABLE', 10), r('u2', 'CONTACT_UNDELIVERABLE', 11), r('d10', 'BUYER_REPLIED', 12)]);
    expect(recovered.map((f) => [f.failureMode, f.recovered])).toEqual([['channel-stops-delivering', true]]);
  });

  it('pure: noise is not failure, a path that never succeeded did not stop, and silence is judged over delivered results only', () => {
    const delivered = Array.from({ length: 10 }, (_, i) => r(`d${i}`, 'BUYER_REPLIED', i));
    expect(acquisitionFailures('k', 'A', [...delivered, r('u1', 'CONTACT_UNDELIVERABLE', 10)])).toEqual([]);
    expect(acquisitionFailures('k', 'A', Array.from({ length: 6 }, (_, i) => r(`u${i}`, 'CONTACT_UNDELIVERABLE', i)))).toEqual([]);
    const silent = acquisitionFailures('k', 'A', [
      ...Array.from({ length: 4 }, (_, i) => r(`a${i}`, 'BUYER_REPLIED', i)),
      r('s1', 'BUYER_SILENT', 4), r('x', 'CONTACT_UNDELIVERABLE', 5), r('s2', 'BUYER_SILENT', 6), r('s3', 'BUYER_SILENT', 7),
    ]);
    expect(silent.map((f) => [f.failureMode, f.occurrence.endsWith(':s1'), f.recovered])).toEqual([['prospects-stop-answering', true, null]]);
  });

  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  async function row(mechanism: string, channel: string, i: number, result: string, day: number): Promise<void> {
    await getDb().run(
      `INSERT INTO cash_outcomes (id, project_id, opportunity_id, kind, mechanism, channel, value_text, basis, request_key, created_at)
       VALUES (?, ?, ?, 'CONTACT_RESULT', ?, ?, ?, 'test row', ?, ?)`,
      [`cou_${mechanism}_${i}_${projectId}`.replace(/\W/g, '_'), projectId, `lead:${mechanism}:${i}`, mechanism, channel, result, `r:${mechanism}:${i}`, new Date(Date.UTC(2026, 9, 1 + day)).toISOString()],
    );
  }

  it('runs on the production path with nothing injected: the channel stopping promotes its safeguard, and its recovery settles it', async () => {
    for (let i = 0; i < 8; i++) await row('Campaign A', 'email (Instantly)', i, 'BUYER_REPLIED', i);
    await row('Partner list', 'partner referral', 0, 'BUYER_REPLIED', 0);
    for (let i = 8; i < 11; i++) await row('Campaign A', 'email (Instantly)', i, 'CONTACT_UNDELIVERABLE', i);

    await keepCashLedger(projectId, []);
    const failures = await readFailureRecoveries(projectId);
    expect(failures).toEqual([
      expect.objectContaining({ dependency: `acquisition:${projectId}`, failureMode: 'channel-stops-delivering', recovered: null }),
    ]);
    const live = await readFallbackPreparation(projectId);
    expect(live!.ranked[0]).toMatchObject({ substitute: 'Partner list @ partner referral', decidedBy: 'LIVE_DEPENDENCY', promoted: true });
    expect(live!.ranked[0]!.promotedBecause).toMatch(/channel-stops-delivering\) is on the ledger and recovery is not yet known/);

    await row('Campaign A', 'email (Instantly)', 11, 'BUYER_REPLIED', 11);
    await keepCashLedger(projectId, []);
    expect((await readFailureRecoveries(projectId)).map((f) => f.recovered)).toEqual([true]);
    expect((await readFallbackPreparation(projectId))!.ranked[0]).toMatchObject({ promoted: false });
  });
});
