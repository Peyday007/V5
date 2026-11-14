/**
 * The open opportunity field (OPP-03, ARCH-01): five origins, one origin per
 * candidate with its source rows, no category allow-list, recombination from
 * unsuccessful businesses, market preference by economics and remote control
 * and never by the owner's location, and a read-only probe reader.
 *
 * Review finding (repair-opp03-market-ranking-unused): rankMarkets had no
 * production caller. `rankSubjectMarkets` now scores each map subject from its
 * own evidence (`marketOfEvidence`) and `openGoalDiscovery` takes its industry
 * angles in that order; the tests under "markets in production" hold it there.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createNode } from '../server/repos/industry.ts';
import { assembleEvidence, evidenceFromMap } from '../server/services/industry/construction/service.ts';
import { commercialRoles } from '../server/services/industry/construction/roles.ts';
import type { IndustryNode } from '../server/domain/types.ts';
import {
  OPPORTUNITY_ORIGINS,
  countByOrigin,
  opportunityField,
  opportunityFieldHoldsOnRows,
  marketOfEvidence,
  marketScore,
  rankMarkets,
  rankSubjectMarkets,
  seedsFromConstraints,
  seedsFromFirstPrinciples,
  seedsFromMemory,
  seedsFromRecombination,
  seedsFromWorld,
  type ConstraintRow,
  type FieldInput,
  type GoalRow,
  type MarketCandidate,
  type NodeRow,
  type OpportunityRow,
} from '../server/services/industry/construction/origins.ts';

const node = (id: string, name: string): NodeRow => ({ id, kind: 'SECTOR', name, description: null, retiredAt: null });
const opp = (id: string, state: OpportunityRow['state'], industry: string | null, mechanism: OpportunityRow['mechanism'] = 'EXPLICIT_PAID_REQUEST', claim: string | null = null): OpportunityRow => ({
  id,
  title: `opening ${id}`,
  industry,
  mechanism,
  state,
  source: claim ? 'https://example.org/post' : null,
  sourceClaimId: claim,
});
const goal = (id: string): GoalRow => ({ id, title: 'Reach $5,000 a month', intent: 'cash', outcome: '$5k/mo', archivedAt: null, cancelledAt: null, pausedAt: null, target: { kind: 'CASH' } as unknown as GoalRow['target'] });
const constraint = (id: string): ConstraintRow => ({ id, kind: 'SUBCONTRACTING_PROHIBITED', statement: 'Buyer forbids passing work on', effect: null, opportunityId: 'o-1', nodeId: null, sourceClaimId: 'clm-9' });

const INPUT: FieldInput = {
  nodes: [node('n-1', 'Residential cleaning')],
  opportunities: [
    opp('o-1', 'COLLECTED', 'Bookkeeping'),
    opp('o-2', 'DISCOVERED', 'Freight brokerage', 'SUPPLY_DEMAND_MISMATCH', 'clm-1'),
    opp('o-3', 'DECLINED', 'AI transcription', 'DIAGNOSTIC_OPPORTUNITY'),
    opp('o-4', 'ARCHIVED', null, 'TEMPORARY_EXPLOIT'),
  ],
  goals: [goal('wst-1')],
  constraints: [constraint('c-1')],
};

describe('the five origins', () => {
  it('each origin has a seed function producing candidates from rows', () => {
    expect(seedsFromMemory(INPUT.nodes, INPUT.opportunities).length).toBeGreaterThan(0);
    expect(seedsFromWorld(INPUT.opportunities).length).toBeGreaterThan(0);
    expect(seedsFromFirstPrinciples(INPUT.goals).length).toBeGreaterThan(0);
    expect(seedsFromRecombination(INPUT.opportunities).length).toBeGreaterThan(0);
    expect(seedsFromConstraints(INPUT.constraints).length).toBeGreaterThan(0);
    const counts = countByOrigin(opportunityField(INPUT));
    for (const origin of OPPORTUNITY_ORIGINS) expect(counts[origin]).toBeGreaterThan(0);
  });

  it('every candidate carries exactly one origin and its source rows', () => {
    for (const s of opportunityField(INPUT)) {
      expect(OPPORTUNITY_ORIGINS).toContain(s.origin);
      expect(typeof s.origin).toBe('string');
      expect(s.sources.length).toBeGreaterThan(0);
      for (const ref of s.sources) expect(ref.id).toBeTruthy();
    }
    const world = seedsFromWorld(INPUT.opportunities)[0]!;
    expect(world.sources).toEqual([{ table: 'cash_opportunities', id: 'o-2' }, { table: 'research_claims', id: 'clm-1' }]);
  });

  it('recombination includes pieces of unsuccessful prior businesses', () => {
    const seeds = seedsFromRecombination(INPUT.opportunities);
    const ids = new Set(seeds.flatMap((s) => s.sources.map((r) => r.id)));
    expect(ids.has('o-3')).toBe(true);
    expect(ids.has('o-4')).toBe(true);
    // A pair of two failures appears once, not twice.
    const pair = seeds.filter((s) => s.sources.some((r) => r.id === 'o-3') && s.sources.some((r) => r.id === 'o-4'));
    expect(pair).toHaveLength(1);
  });

  it('a paused or targetless goal is not reasoned backward from', () => {
    expect(seedsFromFirstPrinciples([{ ...goal('g'), pausedAt: '2026-01-01T00:00:00Z' }])).toHaveLength(0);
    expect(seedsFromFirstPrinciples([{ ...goal('g'), target: null }])).toHaveLength(0);
  });
});

describe('no category is a whitelist', () => {
  it('a candidate in a category nobody has seen passes through every origin', () => {
    const unseen = 'Orbital debris salvage brokerage for insurers';
    const field = opportunityField({
      nodes: [node('n-x', unseen)],
      opportunities: [opp('x-1', 'DISCOVERED', unseen, 'EXPLICIT_PAID_REQUEST', 'clm-x'), opp('x-2', 'DECLINED', unseen, 'TEMPORARY_EXPLOIT'), opp('x-3', 'COLLECTED', 'Dog walking')],
      goals: [],
      constraints: [],
    });
    const origins = new Set(field.filter((s) => s.category?.includes(unseen)).map((s) => s.origin));
    expect(origins.has('MEMORY')).toBe(true);
    expect(origins.has('WORLD')).toBe(true);
    expect(origins.has('RECOMBINATION')).toBe(true);
  });

  it('the module holds no allow-list of categories or industries', () => {
    const source = readFileSync('server/services/industry/construction/origins.ts', 'utf8');
    expect(source).not.toMatch(/ALLOWED_(CATEGORIES|INDUSTRIES)|WHITELIST|APPROVED_INDUSTRIES/);
    expect(source).not.toMatch(/\b(industry|category)\s*===\s*'/);
  });
});

describe('market preference', () => {
  const markets: MarketCandidate[] = [
    { key: 'detroit-local', geography: 'Detroit, MI', marginUsd: 40, monthlyVolume: 20, daysToCash: 14, remoteControl: 0.2 },
    { key: 'uk-remote', geography: 'United Kingdom', marginUsd: 60, monthlyVolume: 30, daysToCash: 21, remoteControl: 0.9 },
    { key: 'unknowns', geography: 'Texas', marginUsd: null, monthlyVolume: null, daysToCash: null, remoteControl: 1 },
  ];

  it('prefers economics and remote control', () => {
    expect(rankMarkets(markets).map((m) => m.key)).toEqual(['uk-remote', 'detroit-local', 'unknowns']);
  });

  it('changing the owner location does not reorder markets', () => {
    const base = rankMarkets(markets).map((m) => m.key);
    for (const ownerLocation of ['Detroit, MI', 'London', 'Texas', null]) {
      expect(rankMarkets(markets, { ownerLocation }).map((m) => m.key)).toEqual(base);
    }
  });
});

describe('markets in production: a subject is scored from its own evidence', () => {
  const subject = (id: string, name: string, at: string, retiredAt: string | null = null): IndustryNode =>
    ({ id, projectId: 'prj_x', parentId: null, kind: 'SECTOR', name, description: '', origin: 'SEED', sourceClaimId: null, retiredAt, createdAt: at, updatedAt: at }) as IndustryNode;
  const evidenceOf = (name: string) => assembleEvidence({ text: name, industry: name, geography: null, map: evidenceFromMap([], []), recorded: [] });

  it('reads each figure at its unfavourable bound, and an unstated figure as unknown', () => {
    const delivery = evidenceOf('Last-mile delivery');
    const m = marketOfEvidence('d', delivery, commercialRoles(delivery));
    expect(m.marginUsd).not.toBeNull();
    expect(m.monthlyVolume).not.toBeNull();
    expect(m.daysToCash).not.toBeNull();
    expect(m.remoteControl).toBeGreaterThan(0);
    expect(m.remoteControl).toBeLessThanOrEqual(1);
    expect(marketScore(m)).toBeGreaterThan(0);

    const bare = evidenceOf('Dog grooming');
    const u = marketOfEvidence('u', bare, commercialRoles(bare));
    expect(u).toMatchObject({ marginUsd: null, monthlyVolume: null, daysToCash: null });
    expect(marketScore(u)).toBe(0);
  });

  it('does not read where the evidence was measured: the same economics elsewhere score the same', () => {
    const delivery = evidenceOf('Last-mile delivery');
    const here = marketOfEvidence('d', delivery, commercialRoles(delivery));
    const moved = { ...delivery, geography: 'Somewhere else entirely' };
    const there = marketOfEvidence('d', moved, commercialRoles(moved));
    expect(marketScore(there)).toBe(marketScore(here));
  });

  it('orders the map by economics and remote control, not by row order, and keeps row order for ties', async () => {
    const rows = [
      subject('ind_a', 'Commercial cleaning', '2026-11-01T00:00:00.000Z'),
      subject('ind_b', 'Dog grooming', '2026-11-02T00:00:00.000Z'),
      subject('ind_c', 'Last-mile delivery', '2026-11-03T00:00:00.000Z'),
      subject('ind_r', 'Retired courier work', '2026-11-04T00:00:00.000Z', '2026-11-05T00:00:00.000Z'),
    ];
    const ranked = await rankSubjectMarkets(rows, []);
    expect(ranked.map((one) => one.node.id)).toEqual(['ind_c', 'ind_a', 'ind_b']);
    expect(marketScore(ranked[0]!.market)).toBeGreaterThan(0);
  });

  it('takes no owner location at all', () => {
    expect(rankSubjectMarkets.length).toBe(2);
    const source = readFileSync('server/services/industry/construction/origins.ts', 'utf8');
    const body = source.slice(source.indexOf('export function marketOfEvidence'), source.indexOf('// The probe reader'));
    expect(body).not.toMatch(/ownerLocation|owner\.location|homeLocation/);
  });

  it('is what goal discovery takes its industry angles from', () => {
    const source = readFileSync('server/services/cash/discovery.ts', 'utf8');
    expect(source).toMatch(/await rankSubjectMarkets\(nodes, constraints\)\)\s*\.slice\(0, MAX_INDUSTRY_LENSES\)/);
  });
});

describe('opportunityFieldHoldsOnRows', () => {
  afterAll(teardown);

  it('reports per-origin counts on rows and writes nothing', async () => {
    const { project } = await freshProject();
    await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Commercial laundry', origin: 'SEED' });
    const tables = ['industry_nodes', 'cash_opportunities', 'opportunity_constraints', 'workstreams', 'project_events'];
    const count = async () => Promise.all(tables.map(async (t) => (await getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))[0]!.n));
    const before = await count();
    const report = await opportunityFieldHoldsOnRows();
    expect(await count()).toEqual(before);
    expect(report.ok).toBe(true);
    expect(report.counts.MEMORY).toBeGreaterThan(0);
    for (const origin of OPPORTUNITY_ORIGINS) expect(report.detail).toContain(`${origin}=`);
  });
});
