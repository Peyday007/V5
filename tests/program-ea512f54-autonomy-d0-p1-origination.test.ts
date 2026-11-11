/**
 * AUTO-20-1: Brain originates work from its own observations (§87, repair F4).
 *
 * The reviewer's finding: the improvement loop only turned failure records of
 * the research pipeline into work, so a live goal held by the same gap for a
 * week, capacity idle beside waiting work, openings closing unpursued, a
 * resource several opportunities wait on, or bins failing the same way all
 * waited for the owner to notice them. These pin that each of those rows now
 * becomes an improvement candidate in the existing loop, with the judgment
 * that made it work stored on it, and that an earlier repair that did not move
 * a goal is recorded as a method judged inadequate rather than re-run.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordIntervention } from '../server/repos/engineering.ts';
import { getCandidateByKey, listImprovementEvents } from '../server/repos/improvement.ts';
import { composeObjective, improvementTick, resetImprovementTick } from '../server/services/improvement/loop.ts';
import { judgeCause } from '../server/services/selfmodel/gapLoopSync.ts';
import {
  FAILURE_MIN_COUNT,
  GOAL_STUCK_DAYS,
  IDLE_MIN_RECORDS,
  failurePatternWeaknesses,
  goalConstraintWeaknesses,
  idleCapacityWeaknesses,
  isOriginated,
  normalizeReason,
  opportunityWeaknesses,
  unmetNeedWeaknesses,
  type GoalConstraintObservation,
} from '../server/services/selfmodel/originate.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T12:00:00.000Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

function goal(id: string, blockedDays: number, gapId = 'PLAN.SOME_GAP', dueAt: string | null = null): GoalConstraintObservation {
  return { goalId: id, intent: `goal ${id}`, dueAt, blocking: [{ id: gapId, status: 'BROKEN', why: 'probe failed' }], blockedSince: ago(blockedDays) };
}

describe('origination from goal constraints', () => {
  it('originates work for a gap that has held live goals for days with nothing working on it', () => {
    const out = goalConstraintWeaknesses([goal('g1', GOAL_STUCK_DAYS + 2), goal('g2', GOAL_STUCK_DAYS + 1, 'PLAN.SOME_GAP', ahead(3))], [], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe('ORIGINATED:GOAL_CONSTRAINT:PLAN.SOME_GAP');
    expect(out[0]!.severity).toBe('HIGH');
    expect(out[0]!.origination.family).toBe('GOAL_CONSTRAINT');
    expect(out[0]!.origination.observed.sort()).toEqual(['g1', 'g2']);
    expect(out[0]!.origination.methodInadequate).toBeUndefined();
  });

  it('waits while the constraint is new, and still originates for a gap no map names', () => {
    expect(goalConstraintWeaknesses([goal('g1', 1)], [], NOW)).toEqual([]);
    const unnamed = goalConstraintWeaknesses([goal('g1', 10, 'NOT.IN.ANY.MAP')], [], NOW);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]!.ownerComponent).toBe('server/services/goals/plan.ts');
  });

  it('judges a decided repair that did not unblock the goal as an inadequate method, not a missing one', () => {
    // Any map requirement id works: take one from the maps so the capability key resolves.
    return import('../server/domain/capabilityMap.ts').then(({ CAPABILITY_MAPS }) => {
      const [mapKey, map] = Object.entries(CAPABILITY_MAPS).find(([, m]) => m.requirements.some((r) => !r.externalLimit))!;
      const requirement = map.requirements.find((r) => !r.externalLimit)!;
      const key = `CAPABILITY:${mapKey}.${requirement.id}`;
      const open = goalConstraintWeaknesses([goal('g1', 10, requirement.id)], [{ key, decision: null, attempt: 1 }], NOW);
      expect(open).toEqual([]);
      const decided = goalConstraintWeaknesses([goal('g1', 10, requirement.id)], [{ key, decision: 'KEPT_NO_EFFECT', attempt: 1 }], NOW);
      expect(decided).toHaveLength(1);
      expect(decided[0]!.origination.methodInadequate).toContain('KEPT_NO_EFFECT');
      expect(decided[0]!.ownerComponent).toBe(requirement.owner[0]);
      expect(
        judgeCause({ kind: decided[0]!.kind, problem: decided[0]!.problem, evidence: { methodInadequacy: { judgment: decided[0]!.origination.methodInadequate } } }).cause,
      ).toBe('METHOD_INADEQUATE');
    });
  });
});

describe('origination from failure patterns, idle capacity, openings and needs', () => {
  it('reads one cause as one cause across ids and numbers', () => {
    expect(normalizeReason('bin bin_0123456789ab refused after 3 tries')).toBe(normalizeReason('bin bin_ffffeeee0000 refused after 7 tries'));
  });

  it('originates work when one kind of bin keeps ending the same way, and not for one bad job', () => {
    const bins = [
      ...Array.from({ length: FAILURE_MIN_COUNT }, (_, i) => ({ id: `b${i}`, kind: 'SOME_KIND', state: 'FAILED', reason: `upload of item ${i} timed out` })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `ok${i}`, kind: 'SOME_KIND', state: 'COMPLETE', reason: null })),
      { id: 'x', kind: 'OTHER_KIND', state: 'FAILED', reason: 'something unusual' },
    ];
    const out = failurePatternWeaknesses(bins);
    expect(out.map((w) => w.kind)).toEqual(['ORIGINATED_FAILURE_PATTERN']);
    expect(out[0]!.frequency).toBe(FAILURE_MIN_COUNT);
    expect(out[0]!.denominator).toBe(FAILURE_MIN_COUNT + 5);
    expect(failurePatternWeaknesses(bins.slice(0, FAILURE_MIN_COUNT - 1))).toEqual([]);
  });

  it('originates work when capacity keeps standing idle beside executable work', () => {
    const records = Array.from({ length: IDLE_MIN_RECORDS }, (_, i) => ({ id: `e${i}`, actorId: 'engineering:watchdog', attemptedAction: '3 ready, 2 idle slots' }));
    expect(idleCapacityWeaknesses(records).map((w) => w.key)).toEqual(['ORIGINATED:IDLE_CAPACITY:engineering-watchdog']);
    expect(idleCapacityWeaknesses(records.slice(1))).toEqual([]);
  });

  it('originates work for openings that closed unpursued and for openings closing now', () => {
    const rows = [
      ...['a', 'b', 'c'].map((id) => ({ id, title: `opening ${id}`, state: 'EVIDENCE_CARD', expiresAt: ago(2) })),
      { id: 'd', title: 'pursued', state: 'COLLECTED', expiresAt: ago(1) },
      { id: 'e', title: 'closing 1', state: 'READY', expiresAt: ahead(2) },
      { id: 'f', title: 'closing 2', state: 'DISCOVERED', expiresAt: ahead(3) },
    ];
    expect(opportunityWeaknesses(rows, NOW).map((w) => w.key).sort()).toEqual([
      'ORIGINATED:MISSED_OPPORTUNITY:CLOSING',
      'ORIGINATED:MISSED_OPPORTUNITY:EVIDENCE_CARD',
    ]);
    expect(opportunityWeaknesses(rows.slice(3, 5), NOW)).toEqual([]);
  });

  it('originates work for a resource several opportunities wait on, whatever kind of resource it is', () => {
    const need = (id: string, opportunityId: string) => ({
      id,
      opportunityId,
      blockerKey: 'supplier-capacity',
      blockedAction: 'Reserve supplier capacity',
      recommendedPath: 'find a supplier with spare capacity',
      expectedCostCents: null,
    });
    const out = unmetNeedWeaknesses([need('n1', 'o1'), need('n2', 'o2')]);
    expect(out.map((w) => w.key)).toEqual(['ORIGINATED:UNMET_NEED:supplier-capacity']);
    expect(out[0]!.problem).toContain('unknown');
    expect(unmetNeedWeaknesses([need('n1', 'o1'), need('n2', 'o1')])).toEqual([]);
    expect(isOriginated(out[0]!)).toBe(true);
  });
});

describe('originated work enters the existing loop on real rows', () => {
  beforeEach(async () => {
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    resetImprovementTick();
  });

  it('turns repeated idle capacity into a candidate with its judgment, once, with nobody asking', async () => {
    for (let i = 0; i < IDLE_MIN_RECORDS + 1; i += 1) {
      await recordIntervention({
        kind: 'IDLE_WITH_EXECUTABLE_WORK',
        rule: 'RULE_9_KEEP_CAPACITY_FED',
        attemptedAction: '4 executable bin(s) waiting beside 2 idle slot(s)',
        replacementAction: 'one dispatch tick',
        actorType: 'BRAIN',
        actorId: 'engineering:watchdog',
      });
    }
    const report = await improvementTick(new Date(Date.now() + 1000));
    const key = 'ORIGINATED:IDLE_CAPACITY:engineering-watchdog';
    expect(report.originated).toContain(key);
    expect(report.opened).toContain(key);
    const candidate = (await getCandidateByKey(key))!;
    expect(candidate.evidence['origination']).toMatchObject({ family: 'IDLE_CAPACITY' });
    const detected = await listImprovementEvents({ candidateId: candidate.id, kinds: ['WEAKNESS_DETECTED'] });
    expect(detected[0]!.detail['origination']).toMatchObject({ family: 'IDLE_CAPACITY' });
    // The engineering objective says the work was originated, and why.
    const composed = composeObjective(candidate, { research: null, factory: null, archive: [] }, [], {
      key: 'AUTO_RECOVERY_RATE',
      value: null,
      numerator: 0,
      denominator: 0,
      status: 'INSUFFICIENT_DATA',
    } as unknown as Parameters<typeof composeObjective>[3]);
    expect(composed.objective).toContain('Brain originated this from its own observation');
    // A second pass opens nothing new.
    const again = await improvementTick(new Date(Date.now() + 2000));
    expect(again.opened).not.toContain(key);
  });

  it('originates nothing when nothing is stuck, idle, closing or wanted', async () => {
    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report.originated).toEqual([]);
    expect(report.opened).toEqual([]);
    // Every family's read ran against the real schema: an empty answer, not a failed read.
    expect(report.errors.filter((e) => /^(GOAL_CONSTRAINT|FAILURE_PATTERN|IDLE_CAPACITY|MISSED_OPPORTUNITY|UNMET_NEED|origination):/.test(e))).toEqual([]);
  });
});
