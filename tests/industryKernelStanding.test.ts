/**
 * The industry kernel as a standing capability (W-1 to W-4 of
 * docs/INTELLIGENCE-RECOVERY-2026-11-14.md).
 *
 * - It runs with no active sprint under a standing research grant, asks only
 *   structural questions, files them with no sprint and words them neutrally.
 * - Revoking that grant stops it; a sprint's wind-down stops only the sprint's
 *   own rounds.
 * - Selection is a recorded score with a reserved exploration share.
 * - A barren subject is a watch that reopens on its conditions.
 * - The whole-economy question and a subject's decomposition come back after
 *   their cool-offs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal, revokeGoal } from '../server/repos/russellAuthority.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { listIndustryRounds } from '../server/repos/industry.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { activate, setLifecycle, launchableUnderCashMode } from '../server/services/cash/lifecycle.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { runIndustryKernel, STANDING_PURPOSES } from '../server/services/industry/kernel.ts';
import {
  allocate,
  BOOTSTRAP_REFRESH_MS,
  EXPLORE_EVERY,
  kernelConcurrency,
  MAP_REFRESH_MS,
  NO_SIGNALS,
  type SubjectSignals,
} from '../server/services/industry/allocate.ts';
import { BARREN_WATCH_MS, standingOf } from '../server/services/industry/verdict.ts';
import { bootstrapQuestion, mapQuestion, STANDING_CONTEXT_LINE } from '../server/services/industry/questions.ts';
import { coverageOf, type GraphSnapshot } from '../server/services/industry/graph.ts';
import { roleIdOfBucket } from '../server/services/industry/expand.ts';
import { SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import type { IndustryNode, IndustryNodeKind, IndustryRound } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `standing-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function standingGrant(): Promise<string> {
  const goal = await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Standing research',
    allowedWork: ['RESEARCH'],
    maxMissions: 0,
    maxFragments: 0,
    maxConcurrent: 6,
    maxProbes: 0,
    workPolicy: 'UNCAPPED',
  });
  return goal.id;
}

describe('the map grows with no sprint, under the standing authority', () => {
  it('opens structural rounds with no sprint, filed with no sprint and worded neutrally', async () => {
    await standingGrant();
    const seed = await seedSubject({ projectId, name: 'Specialty food wholesale', actorRef: userId });

    const pass = await runIndustryKernel(projectId);
    expect(pass.failures ?? []).toEqual([]);
    expect(pass.basis).toBe('STANDING');
    expect(pass.opened.length).toBeGreaterThan(0);
    expect(pass.opened.some((one) => one.nodeId === seed.node.id)).toBe(true);
    for (const one of pass.opened) {
      // Only structure: an opening search would file into a portfolio no sprint holds.
      // (A role question is structural too: who stands where on a mapped flow.)
      expect(STANDING_PURPOSES.includes(one.purpose) || roleIdOfBucket(one.bucketId) !== null).toBe(true);
      expect(one.question).not.toContain('short cash sprint');
    }
    expect(pass.opened.some((one) => one.question.includes(STANDING_CONTEXT_LINE))).toBe(true);
    // Every chosen ask carries its score parts in the recorded reason.
    for (const ask of pass.asks ?? []) expect(ask.why).toMatch(/\[score \d\.\d\d = information/);

    const rounds = await listIndustryRounds(projectId);
    expect(rounds.length).toBe(pass.opened.length);
    for (const round of rounds) expect(round.cashModeId).toBeNull();
    // With no sprint at all the candidate is launchable; the grant authorizes it.
    for (const round of rounds) {
      expect(await launchableUnderCashMode({ candidateId: round.candidateId, mode: null })).toBe(true);
    }
    expect((await listCandidates({ projectId })).length).toBeGreaterThanOrEqual(rounds.length);
  });

  it('stops when the person revokes the standing grant', async () => {
    const grantId = await standingGrant();
    await seedSubject({ projectId, name: 'Specialty food wholesale', actorRef: userId });
    const first = await runIndustryKernel(projectId);
    expect(first.opened.length).toBeGreaterThan(0);

    await seedSubject({ projectId, name: 'Industrial cleaning services', actorRef: userId });
    expect(await revokeGoal({ goalId: grantId, actorUserId: userId, reason: 'stop mapping' })).toBe(true);

    const after = await runIndustryKernel(projectId);
    expect(after.opened).toHaveLength(0);
    expect(after.basis).toBeNull();
    expect(after.declined[0]!.why).toMatch(/standing research grant/);
  });

  it('does nothing in a project with no sprint, no map and no money goal', async () => {
    await standingGrant();
    const pass = await runIndustryKernel(projectId);
    expect(pass.opened).toHaveLength(0);
    expect(await listIndustryRounds(projectId)).toHaveLength(0);
  });

  it("a sprint's wind-down stops the sprint's rounds and not the standing grant's", async () => {
    const outcome = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(outcome.ok).toBe(true);
    const seed = await seedSubject({ projectId, name: 'Specialty food wholesale', actorRef: userId });
    const sprintPass = await runIndustryKernel(projectId);
    expect(sprintPass.basis).toBe('SPRINT');
    const mode = (await getCashMode(projectId))!;
    const sprintRounds = await listIndustryRounds(projectId);
    expect(sprintRounds.length).toBeGreaterThan(0);
    for (const round of sprintRounds) expect(round.cashModeId).toBe(mode.id);

    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'the sprint is ending' });
    const wound = (await getCashMode(projectId))!;
    for (const round of sprintRounds) {
      expect(await launchableUnderCashMode({ candidateId: round.candidateId, mode: wound })).toBe(false);
    }

    // Wound down with no other grant: the sprint's own grant does not carry the map on.
    const stopped = await runIndustryKernel(projectId);
    expect(stopped.opened).toHaveLength(0);
    expect(stopped.declined[0]!.why).toContain('no new discovery');

    // A person's standing grant does.
    await standingGrant();
    const standing = await runIndustryKernel(projectId);
    expect(standing.basis).toBe('STANDING');
    expect(standing.opened.length).toBeGreaterThan(0);
    expect(standing.opened.some((one) => one.nodeId === seed.node.id && one.purpose === 'MAP')).toBe(true);
    const fresh = (await listIndustryRounds(projectId)).filter(
      (round) => !sprintRounds.some((one) => one.id === round.id),
    );
    expect(fresh.length).toBe(standing.opened.length);
    for (const round of fresh) {
      expect(round.cashModeId).toBeNull();
      expect(await launchableUnderCashMode({ candidateId: round.candidateId, mode: wound })).toBe(true);
    }
  });
});

describe('neutral wording', () => {
  it('names no sprint when no objective is given, and keeps the sprint line when one is', () => {
    expect(bootstrapQuestion(null, 1)).toContain(STANDING_CONTEXT_LINE);
    expect(bootstrapQuestion(null, 1)).not.toContain('short cash sprint');
    const sprint = mapQuestion({ path: ['A'], objective: 'Raise cash.', round: 1, childrenSoFar: 0 });
    expect(sprint).toContain('short cash sprint');
  });
});

// ---------------------------------------------------------------------------
// The allocator, over hand-built snapshots.

const T0 = '2026-09-01T00:00:00.000Z';
const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function node(id: string, name: string, kind: IndustryNodeKind = 'SECTOR', parentId: string | null = null): IndustryNode {
  return {
    id,
    projectId: 'prj_t',
    parentId,
    kind,
    name,
    description: null,
    origin: 'DISCOVERED',
    sourceClaimId: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: T0,
    updatedAt: T0,
  };
}

let roundSeq = 0;
function round(input: Partial<IndustryRound> & Pick<IndustryRound, 'purpose'>): IndustryRound {
  roundSeq += 1;
  return {
    id: `irn_${roundSeq}`,
    projectId: 'prj_t',
    cashModeId: null,
    nodeId: null,
    bucketId: null,
    opportunityId: null,
    round: 1,
    candidateId: `cand_${roundSeq}`,
    state: 'HARVESTED',
    openedAt: T0,
    harvestedAt: T0,
    found: 0,
    createdAt: T0,
    updatedAt: T0,
    ...input,
  };
}

function snapshotOf(nodes: IndustryNode[], rounds: IndustryRound[], now: string): GraphSnapshot {
  const boot = rounds.filter((one) => one.purpose === 'BOOTSTRAP');
  return {
    projectId: 'prj_t',
    at: now,
    nodes,
    rounds,
    coverage: coverageOf(nodes, rounds, [], []),
    bootstrap: {
      asked: boot.length > 0,
      open: boot.some((one) => one.state === 'OPEN'),
      found: boot.length > 0 ? boot.reduce((sum, one) => sum + (one.found ?? 0), 0) : null,
    },
    opportunities: [],
    constraints: [],
  };
}

function signals(input: { goals?: Record<string, number>; unpriced?: Record<string, number>; reached?: Record<string, string> }): SubjectSignals {
  return {
    goalsReaching: new Map(Object.entries(input.goals ?? {})),
    unpriced: new Map(Object.entries(input.unpriced ?? {})),
    goalReachedAt: new Map(Object.entries(input.reached ?? {})),
  };
}

describe('scored, adaptive selection (W-2)', () => {
  /*
   * H: high information and relevance (live goals reach it, many positions
   * unpriced, never decomposed) but already searched twice. U: never asked,
   * nothing reaches it. The score prefers H; the reserved exploration pick
   * goes to U.
   */
  function world(extraBootstraps: number): GraphSnapshot {
    const h = node('ind_h', 'High information sector');
    const u = node('ind_u', 'Unexplored sector');
    const rounds = [
      round({ purpose: 'SCAN', nodeId: h.id, bucketId: 'broad-referrals', found: 0 }),
      round({ purpose: 'SCAN', nodeId: h.id, bucketId: 'broad-other-mechanisms', found: 0, round: 1 }),
      ...Array.from({ length: extraBootstraps }, (_, index) => round({ purpose: 'BOOTSTRAP', round: index + 1, found: 2 })),
    ];
    return snapshotOf([h, u], rounds, at(2 * DAY));
  }
  const strong = signals({ goals: { ind_h: 2 }, unpriced: { ind_h: 6 } });

  it('prefers the subject where an answer is worth most, and records why', () => {
    // 4 rounds so far: the next pick is not an exploration pick.
    const plan = allocate({ snapshot: world(2), slots: 1, capitalDecomposed: new Set(), signals: strong });
    expect(plan.asks).toHaveLength(1);
    const [ask] = plan.asks;
    expect(ask!.nodeId).toBe('ind_h');
    expect(ask!.score!.pick).toBe('EXPLOIT');
    expect(ask!.score!.relevance).toBe(1);
    expect(ask!.score!.information).toBeGreaterThan(0.9);
    expect(ask!.why).toMatch(/information .* relevance .* transfer .* novelty/);
    expect(ask!.rank).toBe(1000 - Math.round(ask!.score!.total * 100));
    expect(plan.declined.some((one) => one.subject === 'Unexplored sector')).toBe(true);
  });

  it(`reserves one pick in ${EXPLORE_EVERY} for the least-explored subject`, () => {
    // 3 rounds so far: the next pick is the reserved exploration pick.
    const plan = allocate({ snapshot: world(1), slots: 1, capitalDecomposed: new Set(), signals: strong });
    expect(plan.asks).toHaveLength(1);
    expect(plan.asks[0]!.nodeId).toBe('ind_u');
    expect(plan.asks[0]!.score!.pick).toBe('EXPLORE');
    expect(plan.asks[0]!.why).toMatch(/exploration/);
  });

  it('sizes concurrency from idle research capacity, never above the grant', () => {
    expect(kernelConcurrency({ spare: null, grantCap: null })).toBe(4);
    expect(kernelConcurrency({ spare: 3, grantCap: null })).toBe(7);
    expect(kernelConcurrency({ spare: 3, grantCap: 6 })).toBe(6);
    expect(kernelConcurrency({ spare: 0, grantCap: 1 })).toBe(1);
  });
});

describe('a barren subject is a watch (W-4)', () => {
  function barren(now: string, extra: IndustryRound[] = []): GraphSnapshot {
    const b = node('ind_b', 'A barren sector');
    const rounds = [
      round({ purpose: 'BOOTSTRAP', found: 1 }),
      round({ purpose: 'MAP', nodeId: b.id, found: 0 }),
      round({ purpose: 'SCAN', nodeId: b.id, bucketId: 'broad-referrals', found: 0 }),
      round({ purpose: 'SCAN', nodeId: b.id, bucketId: 'broad-other-mechanisms', found: 0 }),
      round({ purpose: 'SCAN', nodeId: b.id, bucketId: 'broad-referrals', round: 2, found: 0 }),
      ...extra,
    ];
    return snapshotOf([b], rounds, now);
  }

  it('is declined with its reopen conditions while none has fired', () => {
    const snapshot = barren(at(DAY));
    const standing = standingOf(snapshot.coverage[0]!, [], { now: snapshot.at });
    expect(standing.verdict).toBe('WATCH');
    expect(standing.watch!.reopenedBy).toBeNull();
    const plan = allocate({ snapshot, slots: 4, capitalDecomposed: new Set() });
    expect(plan.asks.some((one) => one.nodeId === 'ind_b')).toBe(false);
    expect(plan.declined.find((one) => one.subject === 'A barren sector')!.why).toMatch(/reopens when/);
  });

  it('reopens once its watch has aged', () => {
    const snapshot = barren(at(BARREN_WATCH_MS + DAY));
    const plan = allocate({ snapshot, slots: 4, capitalDecomposed: new Set() });
    const ask = plan.asks.find((one) => one.nodeId === 'ind_b');
    expect(ask).toBeDefined();
    expect(ask!.why).toMatch(/reopened/);
  });

  it('reopens when a live goal reaching it is set after its last round', () => {
    const snapshot = barren(at(2 * DAY));
    const plan = allocate({
      snapshot,
      slots: 4,
      capitalDecomposed: new Set(),
      signals: signals({ goals: { ind_b: 1 }, reached: { ind_b: at(DAY) } }),
    });
    expect(plan.asks.some((one) => one.nodeId === 'ind_b')).toBe(true);
  });

  it('reopens when a mechanism that produced openings elsewhere was never asked of it', () => {
    const other = node('ind_o', 'A productive sector');
    const b = barren(at(2 * DAY));
    const snapshot = snapshotOf(
      [...b.nodes, other],
      [...b.rounds, round({ purpose: 'SCAN', nodeId: other.id, bucketId: 'broad-other-mechanisms', found: 0 }), round({ purpose: 'SCAN', nodeId: other.id, bucketId: firstUnaskedBucket(b), found: 3 })],
      b.at,
    );
    const plan = allocate({ snapshot, slots: 4, capitalDecomposed: new Set() });
    const ask = plan.asks.find((one) => one.nodeId === 'ind_b');
    expect(ask?.purpose).toBe('SCAN');
    expect(ask?.score?.transfer).toBe(1);
  });
});

function firstUnaskedBucket(snapshot: GraphSnapshot): string {
  const asked = snapshot.coverage[0]!.bucketsAsked;
  return SEARCH_BUCKETS.map((one) => one.id).find((one) => !asked.has(one))!;
}

describe('cool-off re-admission (W-3)', () => {
  it('asks the whole-economy question again only past its refresh', () => {
    const rounds = [round({ purpose: 'BOOTSTRAP', found: 5 })];
    const early = allocate({ snapshot: snapshotOf([], rounds, at(10 * DAY)), slots: 4, capitalDecomposed: new Set() });
    expect(early.asks.some((one) => one.purpose === 'BOOTSTRAP')).toBe(false);

    const late = allocate({ snapshot: snapshotOf([], rounds, at(BOOTSTRAP_REFRESH_MS + DAY)), slots: 4, capitalDecomposed: new Set() });
    const again = late.asks.find((one) => one.purpose === 'BOOTSTRAP');
    expect(again).toBeDefined();
    expect(again!.round).toBe(2);
    expect(again!.why).toMatch(/past the refresh/);
  });

  it("asks a subject's decomposition again only past its refresh", () => {
    const s = node('ind_s', 'A mapped sector');
    const child = node('ind_c', 'A narrower one', 'SUB_INDUSTRY', s.id);
    const rounds = [
      round({ purpose: 'BOOTSTRAP', found: 1 }),
      round({ purpose: 'MAP', nodeId: s.id, found: 1 }),
    ];
    const only = ['MAP'] as const;
    const early = allocate({ snapshot: snapshotOf([s, child], rounds, at(10 * DAY)), slots: 4, capitalDecomposed: new Set(), purposes: only });
    expect(early.asks.some((one) => one.nodeId === s.id)).toBe(false);

    const late = allocate({ snapshot: snapshotOf([s, child], rounds, at(MAP_REFRESH_MS + DAY)), slots: 4, capitalDecomposed: new Set(), purposes: only });
    const again = late.asks.find((one) => one.nodeId === s.id);
    expect(again?.purpose).toBe('MAP');
    expect(again?.round).toBe(2);
    expect(again?.why).toMatch(/past the refresh/);
  });

  it('is unchanged when nothing is passed: no signals read as no signal', () => {
    const plan = allocate({ snapshot: snapshotOf([node('ind_x', 'X')], [], at(0)), slots: 4, capitalDecomposed: new Set(), signals: NO_SIGNALS });
    expect(plan.asks.length).toBeGreaterThan(0);
  });
});
