/**
 * The possibility graph's reach orders real path research.
 *
 * `researchGoalPaths` is the producer the goals tick calls (through plan.ts)
 * to raise research needs for a goal's openings. These tests drive it against
 * a real database holding the owner's possibility graph: an opening whose kept
 * possibility leads on to others is researched before one that leads nowhere,
 * and a zero-reach opening gets nothing while stronger openings use the budget.
 * The cash repositories are replaced so each raised need is one research job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const opportunities = new Map<string, Record<string, unknown>>();
const raised: { opportunityId: string; requestKey: string }[] = [];

vi.mock('../server/repos/cashPortfolio.ts', () => ({
  getOpportunity: async (id: string) => opportunities.get(id) ?? null,
  listNeeds: async () => [],
}));
vi.mock('../server/repos/cashCardFacts.ts', () => ({ cardFact: async () => null }));
vi.mock('../server/services/cash/needs.ts', () => ({
  raiseNeed: async (input: { opportunityId: string; requestKey: string }) => {
    raised.push({ opportunityId: input.opportunityId, requestKey: input.requestKey });
    return { ok: true, value: { id: `need_${raised.length}` } };
  },
  closeNeed: async () => ({ ok: true }),
}));
vi.mock('../server/repos/russellCandidates.ts', () => ({ getCandidate: async () => null }));
vi.mock('../server/repos/russellMissions.ts', () => ({ latestMissionForCandidate: async () => null }));
vi.mock('../server/services/cash/operate.ts', () => ({ diveOwnsItsQuestions: () => false }));

const { freshProject } = await import('./helpers.ts');
const { createUser } = await import('../server/repos/identity.ts');
const { keepPossibility, linkPossibilities, possibilityGraphFor } = await import('../server/repos/economy.ts');
const { openingSourceRef } = await import('../server/services/economy/possibilities/opening.ts');
const { researchGoalPaths } = await import('../server/services/goals/pathResearch.ts');

let projectId = '';
let alice = '';
let bob = '';

function opening(id: string) {
  opportunities.set(id, { id, title: `Opening ${id}`, peakFundingCents: null, validationState: 'NONE' });
  return {
    opportunityId: id, title: `Opening ${id}`, modelled: true,
    missing: ['SETTLES_IN_TIME', 'ECONOMICS'], supportedReach: 5000, potentialReach: 5000, competitiveAward: false,
  };
}

function reading(considered: ReturnType<typeof opening>[]) {
  return {
    goalId: 'goal_t', considered,
    target: { currency: 'USD', projectId, remainingCents: 1_000_000, daysLeft: null, capitalCeilingCents: null, capitalBeforeProofCents: null, proven: false },
  } as never;
}

const kept = async (owner: string, opportunityId: string | null, title: string) =>
  (await keepPossibility({
    projectId, ownerUserId: owner, kind: 'OPPORTUNITY', title, requirements: {},
    sourceRef: opportunityId ? openingSourceRef(opportunityId) : null,
  })).possibility.id;

const firstAsked = () => [...new Set(raised.map((one) => one.opportunityId))];

beforeEach(async () => {
  opportunities.clear();
  raised.length = 0;
  projectId = (await freshProject()).project.id;
  const mk = async (n: string) =>
    (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: n, password: 'correct horse battery staple' })).id;
  alice = await mk('alice');
  bob = await mk('bob');
});

/** Alice's graph: A leads to B and on to a venture; B and C each lead somewhere; L leads nowhere. */
async function aliceGraph() {
  const a = await kept(alice, 'opp_a', 'A'); const b = await kept(alice, 'opp_b', 'B');
  const c = await kept(alice, 'opp_c', 'C'); await kept(alice, 'opp_lone', 'L');
  const venture = await kept(alice, null, 'venture');
  await linkPossibilities({ projectId, fromId: a, toId: b, relation: 'ENABLES' });
  await linkPossibilities({ projectId, fromId: b, toId: venture, relation: 'UNLOCKS_AFTER' });
  await linkPossibilities({ projectId, fromId: c, toId: venture, relation: 'SUPPLIES' });
}

describe('reach inside path research', () => {
  it('passes over a zero-reach opening while stronger openings take the budget', async () => {
    await aliceGraph();
    // Evidence order puts the dead end first; reach must still win.
    const considered = [opening('opp_lone'), opening('opp_c'), opening('opp_b'), opening('opp_a')];
    await researchGoalPaths({ reading: reading(considered), projectId, ownerUserId: alice });
    expect(raised.length).toBeGreaterThan(0);
    expect(raised.some((one) => one.opportunityId === 'opp_lone')).toBe(false);
    // Highest reach first (A: 2), then B and C (1 each) in their evidence order.
    expect(firstAsked()).toEqual(['opp_a', 'opp_c', 'opp_b']);
  });

  it('reaches a zero-reach opening once nothing stronger is left', async () => {
    await aliceGraph();
    await researchGoalPaths({ reading: reading([opening('opp_lone'), opening('opp_a')]), projectId, ownerUserId: alice });
    expect(firstAsked()).toEqual(['opp_a', 'opp_lone']);
  });

  it('without the owner, the evidence order stands and the dead end is asked first', async () => {
    await aliceGraph();
    const considered = [opening('opp_lone'), opening('opp_c'), opening('opp_b'), opening('opp_a')];
    await researchGoalPaths({ reading: reading(considered), projectId });
    expect(firstAsked()[0]).toBe('opp_lone');
  });

  it("another owner's graph never moves this owner's research", async () => {
    await aliceGraph();
    const considered = [opening('opp_lone'), opening('opp_a')];
    await researchGoalPaths({ reading: reading(considered), projectId, ownerUserId: bob });
    expect(firstAsked()[0]).toBe('opp_lone');
    expect((await possibilityGraphFor(projectId, bob, ['opportunity:opp_a'])).edges).toEqual([]);
  });

  it('a dry run applies the same order to what it would ask', async () => {
    await aliceGraph();
    const trace: string[] = [];
    await researchGoalPaths({ reading: reading([opening('opp_lone'), opening('opp_a')]), projectId, ownerUserId: alice, dryRun: true, trace });
    expect(raised).toEqual([]);
    const firstAsk = trace.findIndex((line) => line.includes('would ask'));
    expect(trace[firstAsk]).toContain('Opening opp_a');
    expect(trace.some((line) => line.includes('Opening opp_a: leads on to 2 other possibilities'))).toBe(true);
  });
});
