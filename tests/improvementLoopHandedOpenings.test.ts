/**
 * A MISSED_OPPORTUNITY hand-off is judged on the openings it handed (review findings F1, R2-F1, R2-F2).
 *
 * The loop hands closing openings back to the cash lifecycle and then measures its metric. A rise in
 * that metric is not the hand-off's effect when every opening it handed is still unpursued, so the
 * hand-off records what it handed and the measurement reads what became of each one. This drives the
 * real path end to end: the originator's weakness, `improvementTick` handing the openings over, and a
 * later tick measuring and deciding from the openings' production rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity } from '../server/repos/cashPortfolio.ts';
import { getCandidate, listImprovementEvents, upsertCandidate, type ImprovementCandidate } from '../server/repos/improvement.ts';
import { improvementTick, resetImprovementTick } from '../server/services/improvement/loop.ts';
import { opportunityWeaknesses } from '../server/services/selfmodel/originate.ts';
import { MEASURE_MAX_HOURS } from '../server/domain/improvement.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('a MISSED_OPPORTUNITY hand-off on real rows', () => {
  let projectId = '';
  let userId = '';
  let cashModeId = '';
  let t0 = 0;

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    userId = (
      await createUser({
        email: `handed-${Math.random().toString(36).slice(2, 10)}@example.test`,
        displayName: 'Owner',
        password: 'correct horse battery staple 1',
        isBrainAdmin: true,
      })
    ).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
    cashModeId = (await getCashMode(projectId))!.id;
    resetImprovementTick();
    t0 = Date.now() + 1000;
  });

  async function opening(title: string, closesInMs: number): Promise<string> {
    const o = await createOpportunity({
      projectId,
      cashModeId,
      ownerUserId: userId,
      title,
      mechanism: 'PRODUCTIZED_SERVICE',
      currency: 'USD',
      sourceClaimId: null,
      source: 'A publisher',
      expiresAt: new Date(t0 + closesInMs).toISOString(),
    });
    return o.id;
  }

  /** The candidate the originator makes from these openings, measured on a metric the test can move. */
  async function closingCandidate(ids: string[]): Promise<ImprovementCandidate> {
    const rows = [];
    for (const id of ids) {
      const o = (await getOpportunity(id))!;
      rows.push({ id: o.id, title: o.title, state: o.state, expiresAt: o.expiresAt! });
    }
    const weakness = opportunityWeaknesses(rows, new Date(t0)).find((w) => w.key === 'ORIGINATED:MISSED_OPPORTUNITY:CLOSING');
    if (!weakness) throw new Error('the originator made no CLOSING weakness from these openings');
    const { candidate } = await upsertCandidate({
      weaknessKey: weakness.key,
      kind: weakness.kind,
      title: weakness.title,
      problem: weakness.problem,
      metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
      downstreamMetric: null,
      ownerComponent: weakness.ownerComponent,
      frequency: weakness.frequency,
      denominator: weakness.denominator,
      scope: weakness.scope,
      severity: weakness.severity,
      evidence: { samples: weakness.samples, mutationScope: weakness.mutationScope, knownCause: null, origination: weakness.origination },
    });
    return candidate;
  }

  /** Before delivery every free-lane fragment failed; after it, every one passed: the metric IMPROVED. */
  async function metricImproves(): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason: 'model a: no readable source', evidenceClass: 'MEASURED' });
    }
    await getDb().run("UPDATE bin_events SET at = ? WHERE event_type = 'FREE_LANE_ITEM'", [new Date(t0 - 6 * HOUR).toISOString()]);
    for (let i = 0; i < 40; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model a', evidenceClass: 'MEASURED' });
    }
    await getDb().run("UPDATE bin_events SET at = ? WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED'", [new Date(t0 + HOUR).toISOString()]);
  }

  /** Hands two openings closing in four days (past the 72 h dive runway, inside the 5-day CLOSING window). */
  async function handOff(): Promise<{ candidate: ImprovementCandidate; ids: string[] }> {
    const ids = [await opening('PRPA RFP 26-152-P — zero-emission forklifts', 4 * DAY), await opening('JPFans buyer request', 4 * DAY)];
    const candidate = await closingCandidate(ids);
    const first = await improvementTick(new Date(t0));
    expect(first.advanced.join('\n')).toContain(`${candidate.weaknessKey}: handed 2 row(s)`);
    return { candidate, ids };
  }

  it('records the openings it handed, on the candidate and on the DELIVERED event', async () => {
    const { candidate, ids } = await handOff();
    const delivered = (await getCandidate(candidate.id))!;
    expect(delivered.deliveredAt).toBe(new Date(t0).toISOString());
    const handed = delivered.evidence['handedOpenings'] as { id: string; stateAtHandOff: string; expiresAt: string | null }[];
    expect(handed.map((h) => h.id).sort()).toEqual([...ids].sort());
    for (const one of handed) {
      expect(one.stateAtHandOff).toBe('DISCOVERED');
      expect(one.expiresAt).toBe(new Date(t0 + 4 * DAY).toISOString());
    }
    const event = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['DELIVERED'] }))[0]!;
    expect((event.detail['handedOpenings'] as { id: string }[]).map((h) => h.id).sort()).toEqual([...ids].sort());
  });

  it('does not keep an improved metric while every handed opening is still open and unpursued', async () => {
    const { candidate } = await handOff();
    await metricImproves();
    await improvementTick(new Date(t0 + 13 * HOUR));
    const measured = (await getCandidate(candidate.id))!;
    expect(measured.decision).toBeNull();
    expect(measured.result!['handedOpenings']).toMatchObject({ handed: 2, pursued: 0, stillOpen: 2, expiredUnpursued: 0, missing: 0 });
  });

  it('decides KEPT_NO_EFFECT once every handed opening expired unpursued, though the metric improved', async () => {
    const { candidate } = await handOff();
    await metricImproves();
    const report = await improvementTick(new Date(t0 + 5 * DAY));
    expect(report.decided).toContain(`${candidate.weaknessKey} KEPT_NO_EFFECT`);
    const decided = (await getCandidate(candidate.id))!;
    expect(decided.decision).toBe('KEPT_NO_EFFECT');
    expect(decided.result!['handedOpenings']).toMatchObject({ handed: 2, pursued: 0, stillOpen: 0, expiredUnpursued: 2 });
  });

  it('keeps the improvement when the lifecycle pursued a handed opening', async () => {
    const { candidate, ids } = await handOff();
    await metricImproves();
    // The lifecycle moved one handed opening to execution.
    await getDb().run("UPDATE cash_opportunities SET state = 'EXECUTING' WHERE id = ?", [ids[0]!]);
    const report = await improvementTick(new Date(t0 + 13 * HOUR));
    expect(report.decided).toContain(`${candidate.weaknessKey} KEPT`);
    const decided = (await getCandidate(candidate.id))!;
    expect(decided.decision).toBe('KEPT');
    expect(decided.result!['handedOpenings']).toMatchObject({ handed: 2, pursued: 1, stillOpen: 1 });
  });

  it('still decides after MEASURE_MAX_HOURS when a handed opening stays open and unpursued (R2-F1)', async () => {
    const { candidate, ids } = await handOff();
    await metricImproves();
    // The windows move out past the measurement bound: without the bound this candidate is never decided.
    for (const id of ids) await getDb().run('UPDATE cash_opportunities SET expires_at = ? WHERE id = ?', [new Date(t0 + 60 * DAY).toISOString(), id]);
    await improvementTick(new Date(t0 + (MEASURE_MAX_HOURS - 1) * HOUR));
    expect((await getCandidate(candidate.id))!.decision).toBeNull();
    const report = await improvementTick(new Date(t0 + (MEASURE_MAX_HOURS + 1) * HOUR));
    expect(report.decided).toContain(`${candidate.weaknessKey} KEPT_NO_EFFECT`);
    expect((await getCandidate(candidate.id))!.result!['handedOpenings']).toMatchObject({ pursued: 0, stillOpen: 2 });
  });
});
