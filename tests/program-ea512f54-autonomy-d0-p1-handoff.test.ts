/**
 * AUTO-20-2 step 5 (S-0249), repair F-HANDOFF-UNTESTED.
 *
 * A gap whose missing piece is a connector, a supplier, a payer, information or
 * a watched fact is handed to the owner that already acquires it, not turned
 * into an engineering objective. These pin, on real rows:
 *
 * - `needExecutionOwner` reads the owner from the typed blocker key;
 * - `handNeedsToOwners` records CASH_NEED_ROUTED on each open need and skips
 *   the ones that settled;
 * - `executionRouteOf` reads the route the originator recorded;
 * - the loop's `handToOwner` rejects a gap whose rows all settled, holds one
 *   where everything waits on a person, and otherwise records the delivery
 *   (OWNER:<route>:<owner>), which `gapLoopSync` records as the ACQUIRE owner
 *   and which moves DELIVERED → MEASURING → DECIDE;
 * - a hand-off whose metric regressed is decided REVERTED without a revert
 *   objective, because nothing was merged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { listCashEvents } from '../server/repos/cashMode.ts';
import { getCandidate, listImprovementEvents, upsertCandidate, type ImprovementCandidate } from '../server/repos/improvement.ts';
import { closeNeed, handNeedsToOwners, needExecutionOwner, raiseNeed } from '../server/services/cash/needs.ts';
import { executionRouteOf, improvementTick, OWNER_HANDOFF_PREFIX, resetImprovementTick } from '../server/services/improvement/loop.ts';
import { unmetNeedWeaknesses, type NeedRow } from '../server/services/selfmodel/originate.ts';
import { readGapLoop } from '../server/services/selfmodel/gapLoop.ts';
import type { MetricKey } from '../server/domain/improvement.ts';

const HOUR = 3_600_000;

describe('needExecutionOwner reads the owner from the typed cause', () => {
  it.each([
    ['CAPABILITY:SEND_A_MESSAGE', 'INTEGRATION', 'server/services/cash/capabilities.ts'],
    ['SUPPLIER:widget-capacity', 'COMMERCIAL', 'server/services/cash/operate.ts'],
    ['CUSTOMER:payer', 'COMMERCIAL', 'server/services/cash/operate.ts'],
    ['EVIDENCE:market-size', 'RESEARCH', 'server/services/goals/pathResearch.ts'],
    ['FIELD:payer', 'RESEARCH', 'server/services/goals/pathResearch.ts'],
    ['SOURCE_HOST:example.com', 'RESEARCH', 'server/services/cash/reconsider.ts'],
    ['DEPENDENCY:opp_1', 'WATCH', 'server/services/cash/reconsider.ts'],
    ['AUTHORITY:SEND', 'PERSON', 'server/services/cash/authority.ts'],
    ['PERSON', 'PERSON', 'server/services/cash/needs.ts'],
  ])('%s → %s (%s)', (key, route, owner) => {
    expect(needExecutionOwner(key)).toMatchObject({ route, owner });
  });

  it('an untyped or malformed need stays with the cash need path, never the Factory', () => {
    for (const key of [null, undefined, '', 'NOT_A_KIND:x', 'garbage']) {
      expect(needExecutionOwner(key)).toMatchObject({ route: 'WATCH', owner: 'server/services/cash/operate.ts' });
    }
  });
});

describe('executionRouteOf reads the route the originator recorded', () => {
  const evidence = (origination: unknown) => ({ evidence: { origination } as Record<string, unknown> });

  it('is null for a gap the Factory or method research may own', () => {
    expect(executionRouteOf({ evidence: {} })).toBeNull();
    expect(executionRouteOf(evidence({ family: 'IDLE_CAPACITY', observed: ['x'] }))).toBeNull();
    expect(executionRouteOf(evidence({ family: 'UNMET_NEED', route: { kind: 'FACTORY', owner: 'x' } }))).toBeNull();
    expect(executionRouteOf(evidence({ family: 'UNMET_NEED', route: { kind: 'RESEARCH' } }))).toBeNull();
  });

  it('hands the rows the originator named, else the ones it observed', () => {
    const route = { kind: 'COMMERCIAL', owner: 'server/services/cash/operate.ts', why: 'w' };
    expect(executionRouteOf(evidence({ family: 'MISSED_OPPORTUNITY', observed: ['a', 'b'], handTo: ['b', 7], route }))).toEqual({
      kind: 'COMMERCIAL',
      owner: 'server/services/cash/operate.ts',
      why: 'w',
      family: 'MISSED_OPPORTUNITY',
      observed: ['b'],
    });
    expect(executionRouteOf(evidence({ family: 'UNMET_NEED', observed: ['a', 'b'], route }))?.observed).toEqual(['a', 'b']);
  });
});

describe('the hand-off on real rows', () => {
  let projectId = '';
  let userId = '';

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    userId = (await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true })).id;
    resetImprovementTick();
  });

  async function need(blockerKey: string | null, tag: string): Promise<string> {
    const raised = await raiseNeed({
      projectId,
      actorRef: 'BRAIN',
      blockedAction: `Reach the supplier (${tag})`,
      whyItMatters: 'Two openings wait on it.',
      recommendedPath: 'Connect the channel.',
      setupEffort: 'Minutes.',
      nextStep: 'Record the channel.',
      completionCondition: 'A channel is recorded.',
      requestKey: `handoff:${tag}`,
      blockerKey,
    });
    if (!raised.ok) throw new Error(raised.reason);
    return raised.value.id;
  }

  async function withdraw(id: string): Promise<void> {
    const closed = await closeNeed({ needId: id, to: 'WITHDRAWN', resolution: 'No longer needed.', actorUserId: userId });
    if (!closed.ok) throw new Error(closed.reason);
  }

  /** The candidate the originator makes from these needs, registered as the loop registers it. */
  async function candidateFor(rows: NeedRow[], metric?: MetricKey): Promise<ImprovementCandidate> {
    const [weakness] = unmetNeedWeaknesses(rows);
    if (!weakness) throw new Error('the originator made nothing from these needs');
    const { candidate } = await upsertCandidate({
      weaknessKey: weakness.key,
      kind: weakness.kind,
      title: weakness.title,
      problem: weakness.problem,
      metric: metric ?? weakness.metric,
      downstreamMetric: metric ? null : weakness.downstreamMetric,
      ownerComponent: weakness.ownerComponent,
      frequency: weakness.frequency,
      denominator: weakness.denominator,
      scope: weakness.scope,
      severity: weakness.severity,
      evidence: { samples: weakness.samples, mutationScope: weakness.mutationScope, knownCause: null, origination: weakness.origination },
    });
    return candidate;
  }

  const row = (id: string, opportunityId: string, blockerKey: string | null): NeedRow => ({
    id,
    opportunityId,
    blockerKey,
    blockedAction: 'Reach the supplier',
    recommendedPath: 'Connect the channel.',
    expectedCostCents: null,
  });

  it('handNeedsToOwners routes each open need to its owner and skips a settled one', async () => {
    const connector = await need('CAPABILITY:SEND_A_MESSAGE', 'a');
    const person = await need('PERSON', 'b');
    const settled = await need('SUPPLIER:widgets', 'c');
    await withdraw(settled);
    const result = await handNeedsToOwners({ needIds: [connector, person, settled, connector], gapKey: 'gap:test', actorRef: 'improvement loop' });
    expect(result.skipped).toBe(1);
    expect(result.handed.map((h) => [h.needId, h.route, h.owner])).toEqual([
      [connector, 'INTEGRATION', 'server/services/cash/capabilities.ts'],
      [person, 'PERSON', 'server/services/cash/needs.ts'],
    ]);
    const routed = (await listCashEvents(projectId, 100)).filter((e) => e.kind === 'CASH_NEED_ROUTED');
    expect(routed).toHaveLength(2);
    expect(routed.map((e) => (e.detail as Record<string, unknown>)['needId']).sort()).toEqual([connector, person].sort());
    expect(routed.every((e) => (e.detail as Record<string, unknown>)['gapKey'] === 'gap:test')).toBe(true);
  });

  it('a gap whose needs all settled is REJECTED with nothing handed, and no Factory or research work', async () => {
    const a = await need('CAPABILITY:SEND_A_MESSAGE', 'a');
    const b = await need('CAPABILITY:SEND_A_MESSAGE', 'b');
    const candidate = await candidateFor([row(a, 'o1', 'CAPABILITY:SEND_A_MESSAGE'), row(b, 'o2', 'CAPABILITY:SEND_A_MESSAGE')]);
    expect(executionRouteOf(candidate)?.kind).toBe('INTEGRATION');
    await withdraw(a);
    await withdraw(b);
    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report.decided).toContain(`${candidate.weaknessKey} REJECTED`);
    const after = (await getCandidate(candidate.id))!;
    expect(after.decision).toBe('REJECTED');
    expect(after.decisionReason).toContain('has settled');
    expect(after.changeRequestId).toBeNull();
    expect(after.researchGoalId).toBeNull();
    expect(after.deliveredRef).toBeNull();
    const value = (await readGapLoop(candidate.weaknessKey)).latest.VALUE!;
    expect(value.detail).toMatchObject({ decision: 'HAND_TO_OWNER', route: 'INTEGRATION', handed: 0 });
    expect((await listCashEvents(projectId, 100)).filter((e) => e.kind === 'CASH_NEED_ROUTED')).toHaveLength(0);
  });

  it('a gap where every need waits on a person is HELD for that person', async () => {
    const a = await need('PERSON', 'a');
    const b = await need('PERSON', 'b');
    const candidate = await candidateFor([row(a, 'o1', 'PERSON'), row(b, 'o2', 'PERSON')]);
    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report.decided).toContain(`${candidate.weaknessKey} HELD`);
    const after = (await getCandidate(candidate.id))!;
    expect(after.decision).toBe('HELD');
    expect(after.heldOn).toContain('a person settles');
    expect(after.changeRequestId).toBeNull();
    expect(after.deliveredRef).toBeNull();
    const decided = await listImprovementEvents({ candidateId: candidate.id, kinds: ['DECIDED'] });
    expect(decided[0]!.detail).toMatchObject({ decision: 'HELD', needsPerson: true, route: 'PERSON' });
    expect((await listCashEvents(projectId, 100)).filter((e) => e.kind === 'CASH_NEED_ROUTED')).toHaveLength(2);
  });

  it('a routable gap is DELIVERED to its owner, recorded as ACQUIRE, then MEASURING and DECIDE', async () => {
    const a = await need('CAPABILITY:SEND_A_MESSAGE', 'a');
    const b = await need('CAPABILITY:SEND_A_MESSAGE', 'b');
    const candidate = await candidateFor([row(a, 'o1', 'CAPABILITY:SEND_A_MESSAGE'), row(b, 'o2', 'CAPABILITY:SEND_A_MESSAGE')]);
    const t0 = Date.now() + 1000;
    const first = await improvementTick(new Date(t0));
    expect(first.advanced).toContain(`${candidate.weaknessKey}: handed 2 row(s) to server/services/cash/capabilities.ts (INTEGRATION)`);
    const delivered = (await getCandidate(candidate.id))!;
    expect(delivered.deliveredRef).toBe(`${OWNER_HANDOFF_PREFIX}INTEGRATION:server/services/cash/capabilities.ts`);
    expect(delivered.deliveredAt).toBe(new Date(t0).toISOString());
    expect(delivered.changeRequestId).toBeNull();
    expect(delivered.researchGoalId).toBeNull();
    expect(delivered.decision).toBeNull();
    expect((await listImprovementEvents({ candidateId: candidate.id, kinds: ['DELIVERED'] }))[0]!.detail).toMatchObject({
      handedTo: 'server/services/cash/capabilities.ts',
      route: 'INTEGRATION',
      handed: 2,
    });
    // Reuse came first: the search was recorded before the hand-off was valued.
    const loop = await readGapLoop(candidate.weaknessKey);
    expect(loop.latest.SEARCH_EXISTING).toBeDefined();
    expect(loop.latest.VALUE!.detail).toMatchObject({ decision: 'HAND_TO_OWNER', route: 'INTEGRATION', handed: 2 });
    // gapLoopSync records the owner hand-off as the acquisition.
    expect(loop.latest.ACQUIRE).toBeDefined();
    expect(JSON.stringify(loop.latest.ACQUIRE!.detail)).toContain('server/services/cash/capabilities.ts (INTEGRATION)');
    const routed = (await listCashEvents(projectId, 100)).filter((e) => e.kind === 'CASH_NEED_ROUTED');
    expect(routed).toHaveLength(2);

    // Inside the window it measures; nothing else happens.
    await improvementTick(new Date(t0 + HOUR));
    const stages = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['STAGE'], limit: 1 }))[0]!;
    expect(stages.detail['stage']).toBe('MEASURING');
    expect((await getCandidate(candidate.id))!.decision).toBeNull();

    // After the window it is measured against the period before delivery.
    const report = await improvementTick(new Date(t0 + 13 * HOUR));
    expect(report.advanced).toContain(`${candidate.weaknessKey}: measured`);
    expect((await getCandidate(candidate.id))!.result).not.toBeNull();
  });

  it('a hand-off whose metric regressed is REVERTED without a revert objective: nothing was merged', async () => {
    const a = await need('SUPPLIER:widgets', 'a');
    const b = await need('SUPPLIER:widgets', 'b');
    const candidate = await candidateFor([row(a, 'o1', 'SUPPLIER:widgets'), row(b, 'o2', 'SUPPLIER:widgets')], 'FREE_LANE_FRAGMENT_PASS_RATE');
    const t0 = Date.now() + 1000;
    await improvementTick(new Date(t0));
    expect((await getCandidate(candidate.id))!.deliveredRef).toBe(`${OWNER_HANDOFF_PREFIX}COMMERCIAL:server/services/cash/operate.ts`);

    // Before delivery every free-lane fragment passed; after it, every one failed.
    for (let i = 0; i < 40; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model a', evidenceClass: 'MEASURED' });
    }
    await getDb().run("UPDATE bin_events SET at = ? WHERE event_type = 'FREE_LANE_ITEM'", [new Date(t0 - 6 * HOUR).toISOString()]);
    for (let i = 0; i < 40; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason: 'model a: no readable source among 6 candidate page(s)', evidenceClass: 'MEASURED' });
    }
    await getDb().run("UPDATE bin_events SET at = ? WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'FAILED_RETRYABLE'", [new Date(t0 + HOUR).toISOString()]);

    const report = await improvementTick(new Date(t0 + 13 * HOUR));
    expect(report.decided).toContain(`${candidate.weaknessKey} REVERTED`);
    const after = (await getCandidate(candidate.id))!;
    expect(after.decision).toBe('REVERTED');
    expect(after.changeRequestId).toBeNull();
    // No revert was submitted, and none was attempted and failed: the branch was skipped.
    expect(await listImprovementEvents({ candidateId: candidate.id, kinds: ['REVERT_SUBMITTED', 'REVERT_NOT_SUBMITTED'] })).toEqual([]);
    const objectives = await getDb().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM factory_change_requests WHERE submission_key = ?", [`improvement-revert:${candidate.id}`]);
    expect(Number(objectives?.n ?? 0)).toBe(0);
  });
});
