/**
 * OPP-03, the discovery unit: cash discovery seeds its rounds from all five
 * origins of the opportunity field (`industry/construction/origins.ts`) through
 * the owner it already has — no new scheduler, no migration — records on each
 * round's opening event which origin(s) it was asked from, treats the search
 * buckets and goal lenses as prompts rather than a closed list, and never
 * defaults a question to where the owner happens to be.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture, decline } from '../server/services/cash/opportunities.ts';
import { createNode } from '../server/repos/industry.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { getDb } from '../server/db/database.ts';
import { statesNamedIn } from '../server/domain/jurisdiction.ts';
import {
  GOAL_LENSES,
  MARKET_PREFERENCE_SENTENCE,
  MAX_ORIGIN_LENSES,
  SEARCH_BUCKETS,
  openConstructedRound,
  openDiscovery,
  openGoalDiscovery,
  originLenses,
  questionFor,
  type SearchBucket,
} from '../server/services/cash/discovery.ts';
import { OPPORTUNITY_ORIGINS, type OpportunitySeed } from '../server/services/industry/construction/origins.ts';

const seedOf = (origin: OpportunitySeed['origin'], n: number, prompt = `explore ${origin} ${n}`, category: string | null = null): OpportunitySeed => ({
  key: `${origin}:x/${n}`,
  origin,
  prompt,
  category,
  sources: [{ table: 'cash_opportunities', id: `cop_${origin}_${n}` }],
});

describe('the opportunity field becomes goal lenses', () => {
  it('reaches every one of the five origins within a bounded set, interleaved', () => {
    const seeds = OPPORTUNITY_ORIGINS.flatMap((origin) => Array.from({ length: 20 }, (_, n) => seedOf(origin, n)));
    const lenses = originLenses(seeds, 10);
    expect(lenses).toHaveLength(10);
    // The first five are one of each origin; the next five another of each.
    expect(lenses.slice(0, 5).map((one) => one.origin)).toEqual([...OPPORTUNITY_ORIGINS]);
    expect(lenses.slice(5, 10).map((one) => one.origin)).toEqual([...OPPORTUNITY_ORIGINS]);
    for (const lens of lenses) {
      expect(lens.id).toMatch(new RegExp(`^org-${lens.origin.toLowerCase()}-[0-9a-z]+$`));
      expect(lens.seedKey).toBeTruthy();
    }
    expect(originLenses(seeds).length).toBeLessThanOrEqual(MAX_ORIGIN_LENSES);
  });

  it('filters by no category list: an unfamiliar mechanism or industry is a lens like any other', () => {
    const odd = seedOf('RECOMBINATION', 1, 'Recombine "pet-cremation logistics" with "estate-sale consignment": which piece of each survives?', 'deathcare × resale');
    const lenses = originLenses([odd]);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.angle).toContain('pet-cremation');
    // It is not one of the fixed angles or buckets, and is offered anyway.
    expect(GOAL_LENSES.some((one) => one.angle.includes('pet-cremation'))).toBe(false);
    expect(SEARCH_BUCKETS.some((one) => one.question.includes('pet-cremation'))).toBe(false);
  });

  it('leaves out a seed whose words would turn the round into one jurisdiction, as a held title is', () => {
    const state = seedOf('MEMORY', 1, 'Past transaction "Snow removal for Missouri homeowners": what adjacent buyer does it reach?');
    expect(statesNamedIn(state.prompt).length).toBeGreaterThan(0);
    expect(originLenses([state, seedOf('MEMORY', 2)]).map((one) => one.seedKey)).toEqual(['MEMORY:x/2']);
  });
});

describe('no question defaults to the owner’s location', () => {
  const bucket: SearchBucket = { id: 'b', mechanism: 'OTHER', title: 't', question: 'Where is money published?' };

  it('says in every question that markets are preferred for economics and remote control, and names no place', () => {
    const q = questionFor(bucket, 'Collect cash', 1, []);
    expect(q).toContain(MARKET_PREFERENCE_SENTENCE);
    expect(statesNamedIn(q)).toEqual([]);
    expect(statesNamedIn(MARKET_PREFERENCE_SENTENCE)).toEqual([]);
  });

  it('reads no owner location anywhere in discovery', () => {
    const source = readFileSync('server/services/cash/discovery.ts', 'utf8');
    expect(source).not.toMatch(/owner(?:'s)?\s*(?:location|geography|address|city|region)/i);
    expect(source).not.toMatch(/\breadGeography\b|\bownerLocation\b/);
  });
});

describe('every round records the origin it was asked from', () => {
  let projectId = '';
  let userId = '';
  const now = new Date();
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

  beforeEach(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    const fixture = await freshProject();
    projectId = fixture.project.id;
    userId = (await createUser({ email: `od-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  });

  async function openedOrigins(): Promise<{ bucketId: string; origins: string[]; originSeeds: string[] }[]> {
    const rows = await getDb().all<{ detail: string }>(`SELECT detail FROM cash_events WHERE project_id = ? AND kind = 'CASH_DISCOVERY_OPENED' ORDER BY created_at`, [projectId]);
    return rows.map((row) => JSON.parse(row.detail) as { bucketId: string; origins: string[]; originSeeds: string[] });
  }

  async function goal() {
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
    expect(
      (await setTarget({
        goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
        capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
      } as Parameters<typeof setTarget>[0])).ok,
    ).toBe(true);
    return (await getWorkstream(g.id))!;
  }

  it('a search bucket round is asked of the world', async () => {
    const opened = await openDiscovery({ projectId });
    expect(opened.length).toBeGreaterThan(0);
    const [first] = await openedOrigins();
    expect(first).toMatchObject({ origins: ['WORLD'], originSeeds: [] });
  });

  it('a constructed round is reasoned backward from the goal unless its construction says otherwise', async () => {
    const w = await goal();
    expect(await openConstructedRound({ goal: w, projectId, key: 'k1', title: 'Constructed: a', question: 'Which firms pay for a?' })).not.toBeNull();
    expect(await openConstructedRound({ goal: w, projectId, key: 'k2', title: 'Constructed: b', question: 'Which firms pay for b?', origins: ['RECOMBINATION'], seedKeys: ['RECOMBINATION:x/1'] })).not.toBeNull();
    const events = await openedOrigins();
    expect(events.map((one) => one.origins)).toEqual([['FIRST_PRINCIPLES'], ['RECOMBINATION']]);
    expect(events[1]!.originSeeds).toEqual(['RECOMBINATION:x/1']);
  });

  it('a goal’s rounds reach memory, the world, first principles and recombination when their rows exist', async () => {
    const w = await goal();
    // MEMORY: a node of the map Brain holds.
    await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Commercial laundry', origin: 'SEED' });
    // WORLD: an opening observed and not yet acted on, with its source.
    const seen = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Restaurants buying linen service', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', industry: 'hospitality', source: 'https://example.com/linen' });
    if (!seen.ok) throw new Error(seen.reason);
    // RECOMBINATION: a prior business that did not go ahead, beside another.
    const failed = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Mobile car detailing bookings', mechanism: 'OTHER', currency: 'USD', industry: 'automotive', source: 'https://example.com/detail' });
    if (!failed.ok) throw new Error(failed.reason);
    expect((await decline({ opportunityId: failed.value.id, actorUserId: userId, reason: 'margin too thin at the time' })).ok).toBe(true);

    const target = (await readGoalPlan({ goalId: w.id, evaluations: 200 }))!.target;
    // Enough passes to ask every fixed angle, the industry and the field's lenses once each.
    for (let i = 0; i < GOAL_LENSES.length + 1 + 12; i += 1) {
      await openGoalDiscovery({ goal: w, target, bestReach: null, now: now.toISOString(), liveCap: 100 });
    }
    const events = await openedOrigins();
    expect(events.length).toBeGreaterThan(GOAL_LENSES.length);
    // Every round names its origin(s), and only origins from the closed set.
    for (const one of events) {
      expect(one.origins.length).toBeGreaterThan(0);
      for (const origin of one.origins) expect(OPPORTUNITY_ORIGINS).toContain(origin);
    }
    const reached = new Set(events.flatMap((one) => one.origins));
    for (const origin of ['FIRST_PRINCIPLES', 'MEMORY', 'WORLD', 'RECOMBINATION']) expect(reached).toContain(origin);
    // A field-seeded round says which seed it came from.
    const seeded = events.filter((one) => one.bucketId.includes('-org-'));
    expect(seeded.length).toBeGreaterThan(0);
    for (const one of seeded) expect(one.originSeeds).toHaveLength(1);
  });
});

describe('open-world arrangements are asked by the running goal search (ARCH-01)', () => {
  let projectId = '';
  let userId = '';
  const now = new Date();
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

  beforeEach(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    const fixture = await freshProject();
    projectId = fixture.project.id;
    userId = (await createUser({ email: `ow-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  });

  it('constructs roles no record represents from the project’s map, opens a round for them, and records the arrangement on the round', async () => {
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok).toBe(true);
    const w = (await getWorkstream(g.id))!;
    // A recorded flow on the map: who buys what from whom. No opening, no record of any role on it.
    const root = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'commercial cleaning', origin: 'SEED' });
    const buyer = await createNode({ projectId, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'property managers', origin: 'SEED' });
    await createNode({ projectId, parentId: buyer.node.id, kind: 'TRANSACTION_TYPE', name: 'monthly janitorial contract', description: 'paid monthly per building', origin: 'SEED' });

    const target = (await readGoalPlan({ goalId: w.id, evaluations: 200 }))!.target;
    for (let i = 0; i < GOAL_LENSES.length + 3 + 4; i += 1) {
      await openGoalDiscovery({ goal: w, target, bestReach: null, now: now.toISOString(), liveCap: 100 });
    }
    const rows = await getDb().all<{ detail: string }>(`SELECT detail FROM cash_events WHERE project_id = ? AND kind = 'CASH_DISCOVERY_OPENED' ORDER BY created_at`, [projectId]);
    const events = rows.map((row) => JSON.parse(row.detail) as { bucketId: string; origins: string[]; originSeeds: string[]; construction?: { subject: string; roleId: string; roleLabel: string; business: string; viability: string } });
    const asked = events.filter((one) => one.construction);
    expect(asked.length).toBeGreaterThan(0);
    for (const one of asked) {
      expect(one.bucketId).toContain('-ow-');
      expect(one.origins[0]).toBe('FIRST_PRINCIPLES');
      expect(one.originSeeds).toHaveLength(1);
      expect(one.originSeeds[0]).toMatch(/^openworld:/);
      expect(one.construction!.subject).toBe('commercial cleaning');
      expect(one.construction!.business.length).toBeGreaterThan(0);
      expect(one.construction!.viability).not.toBe('NOT_VIABLE');
    }
    // The question itself puts the arrangement to real sources.
    const candidate = await getDb().get<{ statement: string }>(
      `SELECT c.statement FROM russell_candidates c JOIN cash_discovery_rounds r ON r.candidate_id = c.id WHERE r.project_id = ? AND r.bucket_id = ?`,
      [projectId, asked[0]!.bucketId],
    );
    expect(candidate!.statement).toContain(`standing as ${asked[0]!.construction!.roleLabel}`);
    expect(candidate!.statement).toMatch(/Confirm or refute it from real sources/);
  });
});

describe('the existing owner does the work', () => {
  it('adds no scheduler and no migration: discovery imports the field and records origin in the event it already writes', () => {
    const source = readFileSync('server/services/cash/discovery.ts', 'utf8');
    expect(source).toMatch(/from '\.\.\/industry\/construction\/origins\.ts'/);
    expect(source).toMatch(/origins: \[\.\.\.input\.origins\]/);
    expect(source).not.toMatch(/setInterval\(|registerTick\(/);
  });
});
