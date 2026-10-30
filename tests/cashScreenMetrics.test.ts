/**
 * The screen's counters are rows read back, and the explore/exploit balance is
 * the yield measurement, not a fixed split.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createNeed, createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordDecision } from '../server/repos/cashDecisions.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { getDb } from '../server/db/database.ts';
import { screenMetrics, QUESTION_SKIPPED_EVENT } from '../server/services/cash/screenMetrics.ts';
import { yieldBalance, type DiscoveryYield, type YieldRow } from '../server/services/cash/discoveryYield.ts';

let projectId = '';
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const owner = await createUser({
    email: `metrics-${Math.random().toString(36).slice(2, 10)}@example.com`,
    displayName: 'Owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  ownerId = owner.id;
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize usable cash.' });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
});

const open = (title: string) =>
  createOpportunity({ projectId, cashModeId: modeId, ownerUserId: ownerId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });

const decide = (opportunityId: string, verdict: 'REJECT' | 'HOLD' | 'PRIORITIZE', changeRef: string, goalId = 'goal_1') =>
  recordDecision({ projectId, opportunityId, goalId, verdict, reason: `${verdict} because`, detail: 'd', reopenCondition: 'r', changeRef });

describe('screen metrics', () => {
  it('reads zero from an empty scope and says so', async () => {
    const m = await screenMetrics(projectId);
    expect(m.decisions).toEqual({ REJECT: 0, HOLD: 0, PRIORITIZE: 0 });
    expect(m.claudeJobsAvoided.total).toBe(0);
    expect(m.notes.length).toBeGreaterThan(0);
  });

  it('counts current decisions by verdict, and keeps superseded ones apart', async () => {
    const a = await open('a');
    const b = await open('b');
    const c = await open('c');
    await decide(a.id, 'HOLD', 'ref-1');
    await decide(a.id, 'REJECT', 'ref-2');
    await decide(b.id, 'PRIORITIZE', 'ref-1');
    await decide(c.id, 'REJECT', 'ref-1', 'goal_2');
    const m = await screenMetrics(projectId, 'goal_1');
    expect(m.decisions).toEqual({ REJECT: 1, HOLD: 0, PRIORITIZE: 1 });
    expect(m.superseded).toBe(1);
    expect((await screenMetrics(projectId)).decisions.REJECT).toBe(2);
  });

  it('counts jobs avoided only for rejected openings that never had a dive, plus recorded skips', async () => {
    const a = await open('never dived');
    const b = await open('dived');
    await decide(a.id, 'REJECT', 'r1');
    await decide(b.id, 'REJECT', 'r1');
    await getDb().run('UPDATE cash_opportunities SET validation_orchestration_id = ? WHERE id = ?', ['orc_x', b.id]);
    await recordCashEvent({ projectId, opportunityId: a.id, kind: QUESTION_SKIPPED_EVENT, actorRef: 'BRAIN', summary: 'skipped' });
    const m = await screenMetrics(projectId);
    expect(m.claudeJobsAvoided).toEqual({ rejectedBeforeAnyDive: 1, questionsSkipped: 1, total: 2 });
  });

  it('counts withdrawn research only for rejected openings', async () => {
    const a = await open('rejected');
    const b = await open('kept');
    await decide(a.id, 'REJECT', 'r1');
    for (const o of [a, b]) {
      const need = await createNeed({
        projectId, opportunityId: o.id, actorRef: 'BRAIN', blockedAction: 'x', whyItMatters: 'y',
        recommendedPath: 'z', setupEffort: 'e', nextStep: 'n', completionCondition: 'c', blocksState: 'EXECUTING', requestKey: `k-${o.id}`,
      } as never);
      await getDb().run("UPDATE cash_needs SET state = 'WITHDRAWN', resolution = 'Not researched: because.' WHERE id = ?", [(need as { id: string }).id]);
    }
    expect((await screenMetrics(projectId)).research.needsWithdrawn).toBe(1);
  });
});

const row = (key: string, over: Partial<YieldRow> = {}): YieldRow => ({
  key, rounds: 0, failedRounds: 0, fragments: 0, openings: 0, useful: 0, qualified: 0, duplicates: 0, ...over,
});

describe('yield balance', () => {
  it('derives modes from measurements and never stops discovery', () => {
    const reading: DiscoveryYield = { byMethod: [row('a', { rounds: 4, openings: 5, useful: 2 }), row('b', { rounds: 1, openings: 2 })], bySource: [] };
    const b = yieldBalance(reading, ['a', 'b', 'c']);
    expect(b.exploit).toEqual(['a']);
    expect(b.investigate).toEqual(['b']);
    expect(b.explore).toEqual(['c']);
    expect(b.share!.EXPLOIT).toBeCloseTo(1 / 3);
    expect(b.discoveryContinues).toBe(true);
  });
  it('with nothing supported, weight falls on investigating and exploring', () => {
    const b = yieldBalance({ byMethod: [row('b', { rounds: 5, openings: 3 })], bySource: [] }, ['b', 'c']);
    expect(b.exploit).toEqual([]);
    expect(b.share!.EXPLOIT).toBe(0);
    expect(b.discoveryContinues).toBe(true);
  });
  it('reports no share when nothing is measured or known', () => {
    expect(yieldBalance({ byMethod: [], bySource: [] }).share).toBeNull();
  });
});
