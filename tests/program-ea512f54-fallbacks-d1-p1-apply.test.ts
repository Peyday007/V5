/**
 * FALL-37-1/2/3/6 — the recorded fallback plan, independence reading and
 * preparation order reach the work: an unrecovered failure of the primary
 * switches the plan to the substitute they qualify, and the switched path's
 * re-derived funnel is what every goal plan built on the cash knowledge reads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { getDb } from '../server/db/database.ts';
import { forgetKnowledge, inferCashQuantity, loadCashKnowledge, observationsFor } from '../server/services/quant/knowledge.ts';
import { keepCashLedger, readFailureRecoveries, recordFailureRecovery, type FailureRecoveryInput, type FailureRecoveryRecord } from '../server/services/quant/ledger.ts';
import { readSwitchDecision, switchDecision, switchVerification, triedOf } from '../server/services/quant/fallbackApply.ts';
import {
  ACQUISITION_METHODS,
  NO_REPLACEMENT_METHOD,
  SWITCH_TRIED_PREFIX,
  readSwitchDecisionRecords,
  settledOnOwnPath,
  type ProjectFallbackPlanRecord,
} from '../server/services/quant/fallbackPlanReading.ts';
import type { ProjectIndependenceRecord } from '../server/services/quant/fallbackIndependence.ts';
import type { FallbackPreparationRecord } from '../server/services/quant/fallbackPreparation.ts';
import type { SubstituteReading } from '../server/services/quant/fallbacks.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

/* ------------------------------------------------------------------------- */
/* The decision, from records                                                 */
/* ------------------------------------------------------------------------- */

const DEP = 'acquisition:p';
const fig = (value: number | null) => ({ meaning: 'm', unit: 'u', value, source: 's', derivedFrom: [], status: value === null ? 'UNKNOWN' : 'OBSERVED', window: null, geography: null, scope: null }) as never;

function sub(key: string, over: Partial<SubstituteReading> = {}): SubstituteReading {
  return { key, label: key, readiness: 'VALIDATED', changesMechanism: true, changes: ['DISTRIBUTION'], eligible: true, ineligibleBecause: [], availableCapacity: fig(4), sharedWithPrimary: [], ...over };
}

function planRecord(subs: SubstituteReading[]): ProjectFallbackPlanRecord {
  const modes = [
    { key: 'channel-stops-delivering', condition: 'A: stops delivering' },
    { key: 'prospects-stop-answering', condition: 'A: stops answering' },
  ];
  return {
    signature: 'sig',
    at: '2026-11-16T00:00:00.000Z',
    plan: { dependency: DEP, servesActivity: 'reach', failureModes: modes.map((m) => ({ ...m, detectionSignals: [], failureEvidence: [], timeToHarmDays: fig(null), recoveryWindowDays: fig(10), probability: fig(null) })), substitutes: subs } as never,
    chains: modes.map((m) => ({
      dependency: DEP,
      primaryPath: 'A @ email (10 prospect(s) reached)',
      failureCondition: m.condition,
      failureEvidence: null,
      detectionSignals: [],
      timeToHarmDays: fig(null),
      recoveryWindowDays: fig(10),
      replacements: subs.map((s, i) => ({ substitute: s.key, readiness: s.readiness, changesMechanism: true, eligibility: { eligible: s.eligible, authorized: true, meetsObligations: true, ineligibleBecause: [] }, switchingCost: null, timeToSwitchDays: null, impact: { substitute: s.key, readiness: s.readiness, before: {}, after: { prospectsReached: fig(4 + i), responders: fig(2) }, changed: [], reachBefore: null, reachAfter: null, portfolioUnreadBecause: null }, recoveryVerification: null })),
    })),
  };
}

const independence = (actions: Record<string, 'SWITCH' | 'RECONCILE_FIRST' | 'INELIGIBLE'>): ProjectIndependenceRecord =>
  ({ signature: 'i', dependency: { key: DEP }, independence: {}, actions: Object.entries(actions).map(([key, action]) => ({ key, action, because: [`${action} because`] })), diversity: [], at: '' }) as never;

const preparation = (keys: string[]): FallbackPreparationRecord =>
  ({ signature: 'p', owners: {}, at: '', ranked: keys.map((substitute, i) => ({ rank: i + 1, dependency: DEP, substitute })) }) as never;

function failure(over: Partial<FailureRecoveryRecord> = {}): FailureRecoveryRecord {
  return { occurrence: 'occ-1', dependency: DEP, failureMode: 'channel-stops-delivering', failureClass: 'channel-suspended', detectionDelayDays: null, timeToHarmDays: null, detectionTimely: null, tried: [], recovered: null, cashLostCents: null, cashPreservedCents: null, timeLostDays: null, reputation: null, methodsToImprove: [], at: '', ...over };
}

describe('switchDecision reads the recorded structures and acts on them', () => {
  const subs = [sub('B @ email', { sharedWithPrimary: ['channel account: email'] }), sub('C @ partner'), sub('D @ ads')];
  const actions = independence({ 'B @ email': 'SWITCH', 'C @ partner': 'SWITCH', 'D @ ads': 'SWITCH' });

  it('with no plan on record there is nothing to decide', () => {
    expect(switchDecision({ plan: null, independence: null, preparation: null, failures: [failure()] })).toBeNull();
  });

  it('runs on the primary while no unrecovered failure is on the ledger', () => {
    const d = switchDecision({ plan: planRecord(subs), independence: actions, preparation: null, failures: [failure({ recovered: true })] })!;
    expect(d.state).toBe('PRIMARY');
    expect(d.replacement).toBeNull();
  });

  it('after a failure, follows the preparation order and passes over a substitute sharing the failed cause', () => {
    const d = switchDecision({ plan: planRecord(subs), independence: actions, preparation: preparation(['B @ email', 'D @ ads', 'C @ partner']), failures: [failure()] })!;
    expect(d.state).toBe('SWITCHED');
    expect(d.order).toEqual({ keys: ['B @ email', 'D @ ads', 'C @ partner'], from: 'PREPARATION' });
    expect(d.replacement).toBe('D @ ads');
    expect(d.passedOver).toEqual([{ substitute: 'B @ email', because: [expect.stringMatching(/shares channel account: email/)] }]);
    // The chain's re-derived funnel for the chosen replacement.
    expect(d.funnel).toMatchObject({ responders: 2, prospectsReached: 6 });
  });

  it('never switches to a located, ineligible or unreconciled substitute', () => {
    const d = switchDecision({
      plan: planRecord([sub('L @ x', { readiness: 'LOCATED' }), sub('I @ y', { eligible: false, ineligibleBecause: ['no authority'] }), sub('R @ z')]),
      independence: independence({ 'L @ x': 'SWITCH', 'I @ y': 'SWITCH', 'R @ z': 'RECONCILE_FIRST' }),
      preparation: null,
      failures: [failure({ failureMode: 'prospects-stop-answering' })],
    })!;
    expect(d.state).toBe('NO_REPLACEMENT');
    expect(d.passedOver.map((p) => p.substitute)).toEqual(['L @ x', 'I @ y', 'R @ z']);
    expect(d.funnel).toBeNull();
  });

  it('a failure belongs to the path it happened on: a former primary\'s open failure never fails the healthy primary, and that path is never switched to', () => {
    // The primary is now A @ email; X @ old was the primary when it failed and has since been overtaken.
    const formerPrimary = failure({ occurrence: `acquisition-failure:${DEP}:X @ old:prospects-stop-answering:r3`, path: 'X @ old', failureMode: 'prospects-stop-answering' });
    const withFormer = [...subs, sub('X @ old')];
    const d = switchDecision({ plan: planRecord(withFormer), independence: independence({ 'C @ partner': 'SWITCH', 'D @ ads': 'SWITCH', 'X @ old': 'SWITCH' }), preparation: null, failures: [formerPrimary] })!;
    expect(d.state).toBe('PRIMARY');
    expect(d.failure).toBeNull();
    expect(d.replacement).toBeNull();
    // A record written before records named their path is attributed by its occurrence key, the same way.
    const legacy = { ...formerPrimary, path: undefined };
    expect(switchDecision({ plan: planRecord(withFormer), independence: actions, preparation: null, failures: [legacy] })!.state).toBe('PRIMARY');
    // When the primary itself fails, the former primary — still failing on its own record — is passed over.
    const now = switchDecision({
      plan: planRecord(withFormer),
      independence: independence({ 'B @ email': 'SWITCH', 'C @ partner': 'SWITCH', 'D @ ads': 'SWITCH', 'X @ old': 'SWITCH' }),
      preparation: preparation(['X @ old', 'D @ ads']),
      failures: [formerPrimary, failure({ occurrence: `acquisition-failure:${DEP}:A @ email:channel-stops-delivering:r9`, path: 'A @ email' })],
    })!;
    expect(now.state).toBe('SWITCHED');
    expect(now.failure!.occurrence).toMatch(/:A @ email:/);
    expect(now.replacement).toBe('D @ ads');
    expect(now.passedOver.find((p) => p.substitute === 'X @ old')!.because.join(' ')).toMatch(/unrecovered failure of its own \(prospects-stop-answering/);
  });

  it('a failure of another dependency, or of a mode the plan does not name, switches nothing', () => {
    expect(switchDecision({ plan: planRecord(subs), independence: actions, preparation: null, failures: [failure({ dependency: 'other' })] })!.state).toBe('PRIMARY');
    expect(switchDecision({ plan: planRecord(subs), independence: actions, preparation: null, failures: [failure({ failureMode: 'unknown-mode' })] })!.state).toBe('PRIMARY');
  });
});

/* ------------------------------------------------------------------------- */
/* On production rows, through the cash knowledge every goal plan reads       */
/* ------------------------------------------------------------------------- */

describe('on production rows: a knowledge refresh reads the records back and the goal plan runs on the switched path', () => {
  let projectId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    forgetKnowledge();
    const user = await createUser({ email: `fallback-apply-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    await createAuthority({
      projectId,
      ownerUserId: user.id,
      createdByUserId: user.id,
      name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000,
      maxPerActionCents: 40_000,
      maxConcurrent: 3,
      currency: 'USD',
    });
  });

  // Every contact result gets its own instant, in the order written: rows sharing a millisecond have no order,
  // and the failure reading reads a path's results in order, so a fixture that leaves ties reads differently on
  // every run. Written a day back, before any switch a refresh decides.
  let tick = 0;
  async function insertResult(mechanism: string, channel: string, key: string, value: string, at: Date = new Date(Date.now() - 86_400_000 + tick * 1000)): Promise<void> {
    tick++;
    await getDb().run(
      `INSERT INTO cash_outcomes (id, project_id, opportunity_id, kind, mechanism, channel, value_text, basis, request_key, created_at)
       VALUES (?, ?, ?, 'CONTACT_RESULT', ?, ?, ?, 'test row', ?, ?)`,
      [`cou_${key}_${projectId}`.replace(/\W/g, '_'), projectId, `lead:${mechanism}:${key}`, mechanism, channel, value, `p:${mechanism}:${channel}:${key}`, at.toISOString()],
    );
  }

  /**
   * A path's funnel with no failure in its order: its bounces, then its silences, then its answers. A run of
   * failures that follows a success is a failure the reading records (`acquisitionFailures`); a path whose
   * results open with failures never started, so this funnel is measured without reading as failing.
   */
  async function path(mechanism: string, channel: string, n: number, bounced: number, answered: number): Promise<void> {
    const silent = n - bounced - answered;
    const values = [
      ...Array<string>(bounced).fill('CONTACT_UNDELIVERABLE'),
      ...Array<string>(silent).fill('BUYER_SILENT'),
      ...Array<string>(answered).fill('BUYER_REPLIED'),
    ];
    for (const [i, value] of values.entries()) await insertResult(mechanism, channel, `${mechanism}:${i}`, value);
  }

  const target = (mechanism: string) => ({ id: 'opp-target', projectId, mechanism, opportunitySignal: null, industry: null, priceCents: 50_000, currency: 'USD', title: 'target', duplicateOfId: null }) as unknown as CashOpportunity;

  const failed = (over: Partial<FailureRecoveryInput> = {}): FailureRecoveryInput => ({
    occurrence: `acquisition-failure-${projectId}`,
    dependency: `acquisition:${projectId}`,
    failureMode: 'channel-stops-delivering',
    failureClass: 'outreach-channel-suspended',
    detectionDelayDays: 1,
    timeToHarmDays: null,
    tried: ['paused sends on the suspended account'],
    recovered: null,
    cashLostCents: null,
    cashPreservedCents: null,
    timeLostDays: null,
    reputation: null,
    methodsToImprove: [],
    ...over,
  });

  it('runs on the primary, switches after a recorded failure, and the respond estimate moves to the switched path', async () => {
    await path('Campaign A', 'email (Instantly)', 10, 2, 2);
    await path('Campaign B', 'email (Instantly)', 6, 0, 1);
    await path('Partner list', 'partner referral', 4, 0, 2);

    let knowledge = await loadCashKnowledge(projectId);
    expect(knowledge.fallbackDecision).toMatchObject({ state: 'PRIMARY', dependency: `acquisition:${projectId}` });
    expect(observationsFor(knowledge, 'respond', target('Partner list')).some((o) => o.id.startsWith('fallback-switch:'))).toBe(false);
    expect(inferCashQuantity(knowledge, 'respond', target('Partner list'))).toBeNull();

    await recordFailureRecovery(failed(), { projectId });
    forgetKnowledge();
    knowledge = await loadCashKnowledge(projectId);
    const decision = knowledge.fallbackDecision!;
    expect(decision.state).toBe('SWITCHED');
    // Campaign B goes out through the same suspended account: one correlated failure, never the backup.
    expect(decision.replacement).toBe('Partner list @ partner referral');
    expect(decision.passedOver.find((p) => p.substitute === 'Campaign B @ email (Instantly)')?.because.join(' ')).toMatch(/channel account: email \(Instantly\)/);
    expect(decision.funnel).toMatchObject({ responders: 2, prospectsReached: 4 });
    expect(await readSwitchDecision(projectId)).toMatchObject({ state: 'SWITCHED', replacement: 'Partner list @ partner referral' });

    const switched = observationsFor(knowledge, 'respond', target('Partner list')).find((o) => o.id.startsWith('fallback-switch:'))!;
    expect(switched.value).toEqual({ kind: 'COUNT', successes: 2, trials: 4 });
    expect(switched.broad).toBe(false);
    const estimate = inferCashQuantity(knowledge, 'respond', target('Partner list'));
    expect(estimate).not.toBeNull();
    expect(estimate!.p50).toBeGreaterThan(0.2);
    expect(estimate!.p50).toBeLessThan(0.8);

    // Recovery recorded: the plan is back on its primary, and the switched path stops feeding the estimate.
    await recordFailureRecovery(failed({ recovered: true }), { projectId });
    forgetKnowledge();
    knowledge = await loadCashKnowledge(projectId);
    expect(knowledge.fallbackDecision!.state).toBe('PRIMARY');
    expect(observationsFor(knowledge, 'respond', target('Partner list')).some((o) => o.id.startsWith('fallback-switch:'))).toBe(false);
  });

  it('without standing authority the substitute is ineligible and nothing is switched to', async () => {
    const other = (await freshProject()).project.id;
    projectId = other;
    forgetKnowledge();
    await path('Campaign A', 'email (Instantly)', 5, 1, 1);
    await path('Partner list', 'partner referral', 3, 0, 1);
    await recordFailureRecovery(failed(), { projectId });
    const knowledge = await loadCashKnowledge(projectId);
    expect(knowledge.fallbackDecision).toMatchObject({ state: 'NO_REPLACEMENT', replacement: null });
    expect(observationsFor(knowledge, 'respond', target('Partner list')).some((o) => o.id.startsWith('fallback-switch:'))).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* What Brain tried on a path's failure, and whether it worked (repair-F1)    */
/* ------------------------------------------------------------------------- */

describe('a switch is recorded as what Brain tried, verified on the substitute\'s own rows, and settles the failure', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();

  it('pure: the switch and each substitute passed over are what was tried; a plan on its primary tried nothing', () => {
    const d = {
      dependency: 'acquisition:p', state: 'SWITCHED' as const, primaryPath: 'A @ email (11 prospect(s) reached)',
      failure: { occurrence: 'occ', failureMode: 'channel-stops-delivering', recovered: null },
      replacement: 'C @ partner', funnel: null,
      passedOver: [{ substitute: 'B @ email', because: ['shares channel account: email with the failed primary, so it fails with it'] }],
      order: { keys: ['B @ email', 'C @ partner'], from: 'PREPARATION' as const }, because: '',
    };
    expect(triedOf(d)).toEqual([
      `${SWITCH_TRIED_PREFIX}acquisition:p from A @ email (11 prospect(s) reached) to C @ partner (order from preparation)`,
      'passed over B @ email: shares channel account: email with the failed primary, so it fails with it',
    ]);
    expect(triedOf({ ...d, state: 'PRIMARY', failure: null, replacement: null, passedOver: [] })).toEqual([]);
  });

  it('pure: recovery is verified only by a result written after the switch that is good for the failed mode', () => {
    const results = [
      { id: 'before', result: 'BUYER_REPLIED', at: at(1) },
      { id: 'bounce', result: 'CONTACT_UNDELIVERABLE', at: at(3) },
      { id: 'silent', result: 'BUYER_SILENT', at: at(4) },
      { id: 'reply', result: 'BUYER_REPLIED', at: at(5) },
    ];
    // Delivered is enough for a channel that stopped delivering; an answer is needed for prospects that went silent.
    expect(switchVerification('channel-stops-delivering', at(2), results)!.id).toBe('silent');
    expect(switchVerification('prospects-stop-answering', at(2), results)!.id).toBe('reply');
    expect(switchVerification('channel-stops-delivering', at(6), results)).toBeNull();
  });

  it('pure: a failure settled by a switch still fails its own path until that path\'s rows show recovery', () => {
    const settled = failure({ occurrence: `acquisition-failure:${DEP}:A @ email:channel-stops-delivering:r9`, path: 'A @ email', recovered: true, tried: [`${SWITCH_TRIED_PREFIX}${DEP} from A @ email to C @ partner`] });
    const plan = planRecord([sub('C @ partner')]);
    const ind = independence({ 'C @ partner': 'SWITCH' });
    expect(switchDecision({ plan, independence: ind, preparation: null, failures: [settled], ownRecovered: new Set() })!.state).toBe('SWITCHED');
    expect(switchDecision({ plan, independence: ind, preparation: null, failures: [settled], ownRecovered: new Set([settled.occurrence]) })!.state).toBe('PRIMARY');
    // A failure its own path recovered from is recovered, whatever the own-row reading says.
    expect(switchDecision({ plan, independence: ind, preparation: null, failures: [{ ...settled, tried: ['paused sends'] }], ownRecovered: new Set() })!.state).toBe('PRIMARY');
  });

  it('pure: a failure its own path recovered from carries the recorded decisions, and a missing substitute is a method to improve', () => {
    const found: FailureRecoveryInput = {
      occurrence: 'occ', dependency: 'acquisition:p', path: 'A @ email', failureMode: 'channel-stops-delivering', failureClass: 'ACQUISITION:channel-stops-delivering',
      detectionDelayDays: 1, timeToHarmDays: null, tried: [], recovered: true, cashLostCents: null, cashPreservedCents: null, timeLostDays: null, reputation: null,
      methodsToImprove: [...ACQUISITION_METHODS['channel-stops-delivering']!],
    };
    const settled = settledOnOwnPath(found, [
      { occurrence: 'occ', dependency: 'acquisition:p', state: 'NO_REPLACEMENT', primaryPath: 'A @ email', replacement: null, tried: ['no substitute of acquisition:p qualified to replace A @ email'], at: at(1) },
      { occurrence: 'other', dependency: 'acquisition:p', state: 'NO_REPLACEMENT', primaryPath: 'A @ email', replacement: null, tried: ['unrelated'], at: at(2) },
    ]);
    expect(settled.tried[0]).toBe('no substitute of acquisition:p qualified to replace A @ email');
    expect(settled.tried).not.toContain('unrelated');
    expect(settled.tried[settled.tried.length - 1]).toMatch(/^recovery verified: A @ email recorded a good result/);
    expect(settled.methodsToImprove).toContain(NO_REPLACEMENT_METHOD);
  });

  describe('on production rows, through the cash knowledge refresh', () => {
    let projectId = '';
    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
      forgetKnowledge();
      const user = await createUser({ email: `fallback-tried-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
      await createAuthority({
        projectId, ownerUserId: user.id, createdByUserId: user.id, name: 'Cash Mode commercial authority',
        allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
        maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD',
      });
    });

    async function row(mechanism: string, channel: string, i: number, result: string, when: Date): Promise<void> {
      await getDb().run(
        `INSERT INTO cash_outcomes (id, project_id, opportunity_id, kind, mechanism, channel, value_text, basis, request_key, created_at)
         VALUES (?, ?, ?, 'CONTACT_RESULT', ?, ?, ?, 'test row', ?, ?)`,
        [`cou_${mechanism}_${i}_${projectId}`.replace(/\W/g, '_'), projectId, `lead:${mechanism}:${i}`, mechanism, channel, result, `r:${mechanism}:${i}`, when.toISOString()],
      );
    }
    const past = (d: number) => new Date(Date.UTC(2026, 9, 1 + d));

    it('records the switch once, settles the failure when the substitute delivers, and stays switched until the failed path recovers on its own rows', async () => {
      for (let i = 0; i < 8; i++) await row('Campaign A', 'email (Instantly)', i, 'BUYER_REPLIED', past(i));
      for (let i = 0; i < 3; i++) await row('Partner list', 'partner referral', i, 'BUYER_REPLIED', past(i));
      for (let i = 8; i < 11; i++) await row('Campaign A', 'email (Instantly)', i, 'CONTACT_UNDELIVERABLE', past(i));

      let knowledge = await loadCashKnowledge(projectId);
      expect(knowledge.fallbackDecision).toMatchObject({ state: 'SWITCHED', replacement: 'Partner list @ partner referral' });
      const decisions = await readSwitchDecisionRecords(projectId);
      expect(decisions).toEqual([expect.objectContaining({ state: 'SWITCHED', replacement: 'Partner list @ partner referral' })]);
      expect(decisions[0]!.tried[0]).toMatch(new RegExp(`^${SWITCH_TRIED_PREFIX}acquisition:${projectId} from Campaign A @ email \\(Instantly\\)`));
      let [held] = await readFailureRecoveries(projectId);
      // Open while no substitute row verifies the switch; the methods it names are what a recurring class hands Factory.
      expect(held).toMatchObject({ path: 'Campaign A @ email (Instantly)', recovered: null });
      expect(held!.methodsToImprove).toEqual(ACQUISITION_METHODS['channel-stops-delivering']);

      // The same decision on the next refresh is not recorded again.
      forgetKnowledge();
      await loadCashKnowledge(projectId);
      expect(await readSwitchDecisionRecords(projectId)).toHaveLength(1);

      // The substitute delivers after the switch: the switch worked, and the failure says so.
      await row('Partner list', 'partner referral', 3, 'BUYER_REPLIED', new Date(Date.now() + 1000));
      forgetKnowledge();
      await loadCashKnowledge(projectId);
      [held] = await readFailureRecoveries(projectId);
      expect(held!.recovered).toBe(true);
      expect(held!.tried[0]).toMatch(new RegExp(`^${SWITCH_TRIED_PREFIX}`));
      expect(held!.tried[held!.tried.length - 1]).toMatch(/^recovery verified: Partner list @ partner referral recorded result .* \(BUYER_REPLIED\)/);
      expect(held!.timeLostDays).not.toBeNull();

      // Recovered by the switch, not by Campaign A: the plan stays on the partner list.
      forgetKnowledge();
      knowledge = await loadCashKnowledge(projectId);
      expect(knowledge.fallbackDecision).toMatchObject({ state: 'SWITCHED', replacement: 'Partner list @ partner referral' });

      // Campaign A's own rows recover: the plan is back on its primary.
      await row('Campaign A', 'email (Instantly)', 11, 'BUYER_REPLIED', new Date(Date.now() + 2000));
      await keepCashLedger(projectId, []);
      forgetKnowledge();
      knowledge = await loadCashKnowledge(projectId);
      expect(knowledge.fallbackDecision!.state).toBe('PRIMARY');
    });
  });
});
