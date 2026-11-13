/**
 * The reach ordering of the possibility graph runs inside the real research
 * producer. `researchGoalPaths` is what the goals tick calls (through
 * plan.ts `advanceGoalPlans`) to start research on a goal's openings; these
 * tests drive it against real possibility rows and edges and count the
 * research needs it raises. The graph is the goal owner's: another person's
 * edges never steer it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { keepPossibility, linkPossibilities, possibilityGraphOf } from '../server/repos/economy.ts';
import type { PossibilityRelation } from '../server/domain/economy.ts';

const opportunities = new Map<string, Record<string, unknown>>();
const raised: { opportunityId: string; requestKey: string }[] = [];
const goals = new Map<string, Record<string, unknown>>();

vi.mock('../server/repos/cashPortfolio.ts', async (original) => ({
  ...(await original<object>()),
  getOpportunity: async (id: string) => opportunities.get(id) ?? null,
  listNeeds: async () => [],
}));
vi.mock('../server/repos/cashCardFacts.ts', async (original) => ({
  ...(await original<object>()),
  cardFact: async () => null,
}));
vi.mock('../server/services/cash/needs.ts', async (original) => ({
  ...(await original<object>()),
  raiseNeed: async (input: { opportunityId: string; requestKey: string }) => {
    raised.push({ opportunityId: input.opportunityId, requestKey: input.requestKey });
    return { ok: true, value: { id: `need_${raised.length}` } };
  },
  closeNeed: async () => ({ ok: true }),
}));
vi.mock('../server/services/cash/operate.ts', async (original) => ({
  ...(await original<object>()),
  diveOwnsItsQuestions: () => false,
}));
vi.mock('../server/repos/register.ts', async (original) => ({
  ...(await original<object>()),
  getWorkstream: async (id: string) => goals.get(id) ?? null,
}));

const { researchGoalPaths, PATH_RESEARCH_OPENINGS } = await import('../server/services/goals/pathResearch.ts');

let projectId = '';
let alice = '';
let bob = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const mk = async (n: string) =>
    (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: n, password: 'correct horse battery staple' })).id;
  alice = await mk('alice');
  bob = await mk('bob');
  opportunities.clear();
  raised.length = 0;
  goals.clear();
  goals.set('wst_goal', { id: 'wst_goal', ownerUserId: alice, createdByUserId: alice });
});

/** An opening the plan considered, with the given potential, and its kept possibility for `owner`. */
async function opening(id: string, potentialReach: number, owner: string | null = alice) {
  opportunities.set(id, { id, title: `Opening ${id}`, peakFundingCents: null, validationState: 'NONE' });
  const possibility = owner
    ? (await keepPossibility({ projectId, ownerUserId: owner, kind: 'OPPORTUNITY', title: id, requirements: {}, sourceRef: id })).possibility
    : null;
  return {
    considered: {
      opportunityId: id, title: `Opening ${id}`, modelled: true, missing: ['OFFER_AND_PRICE'],
      supportedReach: potentialReach, potentialReach, competitiveAward: false,
    },
    possibilityId: possibility?.id ?? null,
  };
}

const link = (from: string | null, to: string | null, relation: PossibilityRelation = 'ENABLES') =>
  linkPossibilities({ projectId, fromId: from!, toId: to!, relation });

const reading = (considered: unknown[]) => ({
  goalId: 'wst_goal',
  considered,
  target: { currency: 'USD', projectId, remainingCents: 1_000_000, daysLeft: 30, capitalCeilingCents: null, capitalBeforeProofCents: null, proven: false },
}) as never;

const researched = () => [...new Set(raised.map((one) => one.opportunityId))];

describe('possibility reach in the research producer', () => {
  it('passes over a zero-reach opening while stronger ones fill the research budget', async () => {
    // The lone opening has the largest potential, so without reach it is researched first.
    const lone = await opening('opp_lone', 9_000);
    const chain = [];
    for (let i = 0; i < PATH_RESEARCH_OPENINGS; i++) chain.push(await opening(`opp_chain${i}`, 5_000));
    const tail = await opening('opp_tail', 5_000);
    for (const one of chain) await link(one.possibilityId, tail.possibilityId);
    const trace: string[] = [];
    await researchGoalPaths({
      reading: reading([lone.considered, ...chain.map((c) => c.considered), tail.considered]),
      projectId, trace,
    });
    expect(researched()).toEqual(chain.map((c) => c.considered.opportunityId));
    expect(researched()).not.toContain('opp_lone');
    expect(trace.join('\n')).toContain('possibility reach reordered research');
  });

  it('researches the strongest reach first and the zero-reach ones only after', async () => {
    const lone = await opening('opp_lone', 9_000);
    const op = await opening('opp_op', 1_000_000);
    const svc = await opening('opp_svc', 1_000_000);
    const venture = await opening('opp_venture', 1_000_000);
    await link(op.possibilityId, svc.possibilityId, 'ENABLES');
    await link(svc.possibilityId, venture.possibilityId, 'UNLOCKS_AFTER');
    await researchGoalPaths({
      reading: reading([lone.considered, venture.considered, svc.considered, op.considered]),
      projectId,
    });
    // reach: op 2, svc 1; then the zero-reach ones in the plan's own order
    // (larger potential first), none of them dropped.
    expect(researched()).toEqual(['opp_op', 'opp_svc', 'opp_venture', 'opp_lone']);
  });

  it("is steered only by the goal owner's graph, never another person's", async () => {
    const lone = await opening('opp_lone', 9_000);
    const other = await opening('opp_other', 5_000, null);
    // Bob keeps the same openings and links the second one onward.
    const bobsOther = (await keepPossibility({ projectId, ownerUserId: bob, kind: 'OPPORTUNITY', title: 'o', requirements: {}, sourceRef: 'opp_other' })).possibility;
    const bobsNext = (await keepPossibility({ projectId, ownerUserId: bob, kind: 'OPPORTUNITY', title: 'n', requirements: {}, sourceRef: 'opp_next' })).possibility;
    await link(bobsOther.id, bobsNext.id);
    const graph = await possibilityGraphOf(projectId, alice);
    expect(graph.edges).toEqual([]);
    expect([...graph.idBySource.keys()]).toEqual(['opp_lone']);
    await researchGoalPaths({ reading: reading([lone.considered, other.considered]), projectId });
    expect(researched()).toEqual(['opp_lone', 'opp_other']);
  });

  it('leaves the order unchanged for a goal nobody owns', async () => {
    goals.set('wst_goal', { id: 'wst_goal', ownerUserId: null, createdByUserId: null });
    const lone = await opening('opp_lone', 9_000);
    const a = await opening('opp_a', 5_000);
    const b = await opening('opp_b', 5_000);
    await link(a.possibilityId, b.possibilityId);
    await researchGoalPaths({ reading: reading([lone.considered, a.considered, b.considered]), projectId });
    expect(researched()).toEqual(['opp_lone', 'opp_a', 'opp_b']);
  });
});

describe('the producer builds the graph it orders by, from what the openings state', () => {
  /** An opening as production records it: in this project, with its own currency and dependency. */
  const recorded = (id: string, potentialReach: number, extra: Record<string, unknown> = {}) => {
    opportunities.set(id, { id, projectId, title: `Opening ${id}`, currency: 'USD', peakFundingCents: null, dependsOnId: null, validationState: 'NONE', ...extra });
    return { opportunityId: id, title: `Opening ${id}`, modelled: true, missing: ['OFFER_AND_PRICE'], supportedReach: potentialReach, potentialReach, competitiveAward: false };
  };

  it('keeps a dependency and its dependent and links them, so the enabling opening is researched first', async () => {
    const lone = recorded('opp_lone', 9_000);
    const base = recorded('opp_base', 1_000);
    const follow = recorded('opp_follow', 1_000, { dependsOnId: 'opp_base' });
    const trace: string[] = [];
    await researchGoalPaths({ reading: reading([lone, follow, base]), projectId, trace });
    const graph = await possibilityGraphOf(projectId, alice);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ fromId: graph.idBySource.get('opp_base'), toId: graph.idBySource.get('opp_follow'), relation: 'ENABLES' });
    // The enabling opening leads; the rest follow in the plan's order, none dropped.
    expect(researched()).toEqual(['opp_base', 'opp_lone', 'opp_follow']);
    expect(trace.join('\n')).toContain('possibility reach reordered research');
    // A second pass finds the same rows rather than adding new ones.
    await researchGoalPaths({ reading: reading([lone, follow, base]), projectId });
    expect((await possibilityGraphOf(projectId, alice)).edges).toHaveLength(1);
  });

  it('never links a dependency recorded in another project', async () => {
    const lone = recorded('opp_lone', 9_000);
    opportunities.set('opp_elsewhere', { id: 'opp_elsewhere', projectId: 'prj_other', title: 'Elsewhere', currency: 'USD', peakFundingCents: null, dependsOnId: null, validationState: 'NONE' });
    const follow = recorded('opp_follow', 1_000, { dependsOnId: 'opp_elsewhere' });
    await researchGoalPaths({ reading: reading([lone, follow]), projectId });
    expect((await possibilityGraphOf(projectId, alice)).edges).toEqual([]);
    expect(researched()).toEqual(['opp_lone', 'opp_follow']);
  });

  it('keeps an opening the code screen rejects, with why, in the goal owner store', async () => {
    const big = recorded('opp_big', 9_000, { peakFundingCents: 5_000_000 });
    const tight = { goalId: 'wst_goal', considered: [big], target: { currency: 'USD', projectId, remainingCents: 1_000_000, daysLeft: 30, capitalCeilingCents: 10_000, capitalBeforeProofCents: 10_000, proven: false } } as never;
    await researchGoalPaths({ reading: tight, projectId });
    expect(researched()).toEqual([]);
    const graph = await possibilityGraphOf(projectId, alice);
    expect(graph.idBySource.has('opp_big')).toBe(true);
    const { getDb } = await import('../server/db/database.ts');
    const row = await getDb().get<{ parked_reason: string | null; owner_user_id: string }>('SELECT parked_reason, owner_user_id FROM possibilities WHERE source_ref = ?', ['opp_big']);
    expect(row!.owner_user_id).toBe(alice);
    expect(row!.parked_reason).toBeTruthy();
  });
});
