/**
 * AUTO-20-1: Brain originates work from its own observations, not only from
 * failure records. Repair F4: an earlier change only annotated a recurring
 * weakness as method-inadequate. It did not turn goal constraints, idle
 * capacity, missed opportunities or changing economic conditions into work.
 * These tests pin that each of those observations becomes a candidate in the
 * existing improvement loop, that the judgment behind each one is stored on it,
 * and that the gap loop's NOTICE step is on the record from the start.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCandidateByKey, listImprovementEvents } from '../server/repos/improvement.ts';
import { improvementTick, resetImprovementTick } from '../server/services/improvement/loop.ts';
import { readGapLoop } from '../server/services/selfmodel/gapLoop.ts';
import {
  closingWindowWeaknesses,
  goalConstraintWeaknesses,
  goalsFromAssessments,
  idleCapacityWeaknesses,
  IDLE_MIN_RECORDS,
  isOriginated,
  missedOpportunityWeaknesses,
  originatedFrom,
  unmetNeedWeaknesses,
} from '../server/services/improvement/origination.ts';

const NOW = new Date('2026-11-11T00:00:00.000Z');

describe('origination, pure', () => {
  it('turns recurring idle capacity beside executable work into work, and a single blip into nothing', () => {
    const found = idleCapacityWeaknesses([
      { actor: 'engineering:watchdog', records: 12, samples: ['3 idle, 4 dispatchable'] },
      { actor: 'free-lane:coverage', records: IDLE_MIN_RECORDS - 1, samples: [] },
    ]);
    expect(found.map((w) => w.key)).toEqual(['ORIGINATE:IDLE:engineering-watchdog']);
    expect(found[0]!.kind).toBe('ORIGINATED_IDLE_CAPACITY');
    expect(found[0]!.judgment).toContain(`at least ${IDLE_MIN_RECORDS}`);
    expect(found[0]!.knownCause).toBeTruthy();
    expect(isOriginated(found[0]!)).toBe(true);
  });

  it('turns openings that closed unpursued into work, per stage they stalled at', () => {
    const missed = Array.from({ length: 4 }, (_, i) => ({ state: 'READY', title: `deal ${i}`, mechanism: 'ARBITRAGE' }));
    const found = missedOpportunityWeaknesses({ missed: [...missed, { state: 'DISCOVERED', title: 'x', mechanism: 'M' }], closed: 8, windowDays: 30 });
    expect(found.map((w) => w.key)).toEqual(['ORIGINATE:MISSED:READY']);
    expect(found[0]!.problem).toContain('4 of 8');
    // Most openings were pursued: no work invented.
    expect(missedOpportunityWeaknesses({ missed: missed.slice(0, 3), closed: 40, windowDays: 30 })).toEqual([]);
  });

  it('turns a resource several opportunities need into a question of whether to obtain it, with no favoured kind', () => {
    const found = unmetNeedWeaknesses(
      [
        { blockedAction: 'Supplier capacity for bulk orders', opportunities: 3, recommendedPath: 'find a wholesale supplier', samples: [] },
        { blockedAction: 'One-off login', opportunities: 1, recommendedPath: 'ask', samples: [] },
      ],
      10,
    );
    expect(found.map((w) => w.key)).toEqual(['ORIGINATE:NEED:supplier-capacity-for-bulk-orders']);
    // Whether it is worth obtaining is researched, not assumed.
    expect(found[0]!.knownCause).toBeNull();
    expect(found[0]!.researchQuestion).toContain('worthwhile');
  });

  it('turns a goal whose constraints have not moved into work, and keeps the age across re-records of the same set', () => {
    const rows = [
      { entity_id: 'g1', intent: 'Earn 5k', created_at: '2026-11-10T00:00:00.000Z', payload: JSON.stringify({ blocking: ['MISSING:supplier'] }) },
      { entity_id: 'g1', intent: 'Earn 5k', created_at: '2026-11-01T00:00:00.000Z', payload: JSON.stringify({ blocking: ['MISSING:supplier'] }) },
      { entity_id: 'g1', intent: 'Earn 5k', created_at: '2026-10-20T00:00:00.000Z', payload: JSON.stringify({ blocking: [] }) },
      { entity_id: 'g2', intent: 'New', created_at: '2026-11-09T00:00:00.000Z', payload: JSON.stringify({ blocking: ['BROKEN:x'] }) },
    ];
    const goals = goalsFromAssessments(rows);
    expect(goals.find((g) => g.goalId === 'g1')?.since).toBe('2026-11-01T00:00:00.000Z');
    const found = goalConstraintWeaknesses(goals, NOW);
    expect(found.map((w) => w.key)).toEqual(['ORIGINATE:GOAL:g1']);
    expect(found[0]!.scope).toBe('LOCAL');
  });

  it('turns openings whose window is closing with nothing pursuing them into work', () => {
    const found = closingWindowWeaknesses({
      closing: [
        { title: 'a', expiresAt: '2026-11-13T00:00:00.000Z', reason: 'season ends' },
        { title: 'b', expiresAt: '2026-11-14T00:00:00.000Z', reason: null },
      ],
      open: 6,
    });
    expect(found.map((w) => w.key)).toEqual(['ORIGINATE:CLOSING']);
    expect(found[0]!.samples[0]).toContain('season ends');
    expect(closingWindowWeaknesses({ closing: [{ title: 'a', expiresAt: 'x', reason: null }], open: 6 })).toEqual([]);
  });

  it('does not raise what an earlier detector or an open candidate already owns', () => {
    const observations = {
      idle: [{ actor: 'engineering:watchdog', records: 20, samples: [] }],
      missed: { missed: [], closed: 0, windowDays: 30 },
      needs: [],
      openOpportunities: 0,
      goals: [],
      closing: { closing: [], open: 0 },
    };
    expect(originatedFrom(observations, NOW).map((w) => w.key)).toEqual(['ORIGINATE:IDLE:engineering-watchdog']);
    expect(originatedFrom(observations, NOW, ['ORIGINATE:IDLE:engineering-watchdog#2'])).toEqual([]);
  });
});

describe('origination through the improvement loop, against real rows', () => {
  let brainId = '';
  beforeEach(async () => {
    await freshProject();
    resetImprovementTick();
    const existing = await getProjectBySlug('brain-architecture');
    brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
  });

  async function idleRecords(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.now() - (i + 1) * 11 * 60_000).toISOString();
      await getDb().run(
        `INSERT INTO engineering_interventions (id, project_id, task_ref, kind, rule, attempted_action, replacement_action, minutes_avoided, actor_type, actor_id, created_at)
         VALUES (?, NULL, NULL, 'IDLE_WITH_EXECUTABLE_WORK', 'RULE_9_KEEP_CAPACITY_FED', '2 idle slot(s) beside 5 ready bin(s)', 'one dispatch tick', NULL, 'BRAIN', 'engineering:watchdog', ?)`,
        [newId('ein'), at],
      );
    }
  }

  async function need(opportunityId: string, blockedAction: string): Promise<void> {
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_needs (id, project_id, opportunity_id, blocked_action, why_it_matters, recommended_path, expected_cost_cents, setup_effort, next_step, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'it blocks the sale', 'find a wholesale supplier', NULL, 'LOW', 'search suppliers', 'OPEN', ?, ?)`,
      [newId('need'), brainId, opportunityId, blockedAction, at, at],
    );
  }

  it('originates work nobody asked for from idle capacity and a shared unmet need, with its judgment and its NOTICE on the record', async () => {
    await idleRecords(8);
    await need('opp_1', 'Supplier capacity for bulk orders');
    await need('opp_2', 'Supplier capacity for bulk orders');
    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report.opened).toEqual(expect.arrayContaining(['ORIGINATE:IDLE:engineering-watchdog', 'ORIGINATE:NEED:supplier-capacity-for-bulk-orders']));
    // Recording the NOTICE never failed. The idle weakness carries a cause stated from the rows, so the loop sends it
    // straight to engineering; in this test no project holds Factory's grant, and the loop says so instead of pretending.
    expect(report.errors.filter((e) => e.startsWith('notice '))).toEqual([]);

    const idle = (await getCandidateByKey('ORIGINATE:IDLE:engineering-watchdog'))!;
    expect(idle.kind).toBe('ORIGINATED_IDLE_CAPACITY');
    expect(idle.evidence['originated']).toBe('ORIGINATED_IDLE_CAPACITY');
    expect(String(idle.evidence['judgment'])).toContain('8 idle record(s)');

    const loop = await readGapLoop('ORIGINATE:NEED:supplier-capacity-for-bulk-orders');
    expect(loop.latest.NOTICE?.detail['origin']).toBe('ORIGINATED_UNMET_NEED');
    expect(loop.next).toBe('HYPOTHESIS');

    const detected = await listImprovementEvents({ kinds: ['WEAKNESS_DETECTED'] });
    expect(detected.length).toBeGreaterThanOrEqual(2);

    // A second pass is idempotent: the same observations are the same candidates, and no second NOTICE.
    resetImprovementTick();
    const again = await improvementTick(new Date(Date.now() + 2000));
    expect(again.opened.filter((k) => k.startsWith('ORIGINATE:'))).toEqual([]);
    expect((await readGapLoop('ORIGINATE:IDLE:engineering-watchdog')).steps.filter((s) => s.step === 'NOTICE').length).toBe(1);
  });

  it('originates nothing when the rows show nothing worth work', async () => {
    await idleRecords(2);
    await need('opp_1', 'One-off login');
    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report.opened.filter((k) => k.startsWith('ORIGINATE:'))).toEqual([]);
  });
});
