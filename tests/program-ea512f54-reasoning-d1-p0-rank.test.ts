/**
 * META-18-1 (S-0191, S-0192): every category competes on estimated economics,
 * feasibility, risk, time to cash, capital requirement and scale read from its
 * own evidence; no label, kind or seed origin is a preference, nothing is
 * shortlisted, and an unfamiliar category with better evidence outranks every
 * familiar one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_CAPITAL_FACTOR,
  UNKNOWN_FAILURE_RATE,
  UNKNOWN_FEASIBILITY,
  marketCriteria,
  marketOfEvidence,
  marketScore,
  rankMarkets,
  rankSubjectMarkets,
  unknownFloor,
  type MarketCandidate,
} from '../server/services/industry/construction/origins.ts';
import { assembleEvidence, evidenceFromMap } from '../server/services/industry/construction/service.ts';
import { commercialRoles } from '../server/services/industry/construction/roles.ts';
import type { IndustryEvidence } from '../server/domain/construction.ts';
import type { IndustryNode } from '../server/domain/types.ts';

const evidenceOf = (name: string): IndustryEvidence => assembleEvidence({ text: name, industry: name, geography: null, map: evidenceFromMap([], []), recorded: [] });
const clone = (e: IndustryEvidence): IndustryEvidence => JSON.parse(JSON.stringify(e)) as IndustryEvidence;
const market = (key: string, e: IndustryEvidence) => marketOfEvidence(key, e, commercialRoles(e));

/** The same evidence under another label: what renaming a subject leaves unchanged. */
function relabel(e: IndustryEvidence, label: string): IndustryEvidence {
  const out = clone(e);
  out.industry = label;
  return out;
}

/** The same evidence with reachable accounts multiplied: a strictly more favourable market. */
function moreAccounts(e: IndustryEvidence, factor: number): IndustryEvidence {
  const out = clone(e);
  for (const f of out.facts) if (f.key === 'accounts_reachable') { f.low *= factor; f.high *= factor; }
  return out;
}

const FAMILIAR = ['Insurance brokerage', 'Subcontracting', 'Distribution', 'Insurance', 'Manufacturing', 'Last-mile delivery'];

describe('the criteria a market competes on (META-18-1)', () => {
  it('reads economics, scale, time to cash, capital, feasibility and risk from evidence', () => {
    const m = market('d', evidenceOf('Last-mile delivery'));
    const c = marketCriteria(m);
    expect(c.monthlyContributionUsd).toBeGreaterThan(0);
    expect(c.daysToCash).toBeGreaterThan(0);
    expect(c.feasibility).toBeGreaterThan(0);
    expect(c.riskFactor).toBeGreaterThan(0);
    expect(c.riskFactor).toBeLessThanOrEqual(1);
    expect(c.capitalFactor).toBeGreaterThan(0);
    expect(c.score).toBe(marketScore(m));
  });

  it('keeps every unknown unfavourable (invariant 39)', () => {
    const base: MarketCandidate = { key: 'k', geography: null, marginUsd: 100, monthlyVolume: 100, daysToCash: 10, remoteControl: 1, capitalUsd: 0, feasibility: 1, failureModes: 0, failureRate: 0 };
    const known = marketScore(base);
    for (const field of ['capitalUsd', 'feasibility', 'failureRate'] as const) {
      expect(marketScore({ ...base, [field]: null }), field).toBeLessThan(known);
    }
    expect(marketScore({ ...base, daysToCash: null })).toBeLessThan(known);
    expect(marketScore({ ...base, marginUsd: null })).toBe(0);
    expect(marketScore({ ...base, monthlyVolume: null })).toBe(0);
    const c = marketCriteria({ ...base, capitalUsd: null, feasibility: null, failureRate: null });
    expect(c.capitalFactor).toBe(UNKNOWN_CAPITAL_FACTOR);
    expect(c.feasibility).toBe(UNKNOWN_FEASIBILITY);
    expect(c.failureRate).toBe(UNKNOWN_FAILURE_RATE);
    expect(c.unknown).toEqual(expect.arrayContaining(['capital', 'feasibility', 'failure rate']));
  });

  it('penalises capital, infeasibility, recorded failure modes and failure rate', () => {
    const base: MarketCandidate = { key: 'k', geography: null, marginUsd: 100, monthlyVolume: 100, daysToCash: 10, remoteControl: 1, capitalUsd: 0, feasibility: 1, failureModes: 0, failureRate: 0 };
    const s = marketScore(base);
    expect(marketScore({ ...base, capitalUsd: 50_000 })).toBeLessThan(s);
    expect(marketScore({ ...base, feasibility: 0.5 })).toBeLessThan(s);
    expect(marketScore({ ...base, failureModes: 2 })).toBeLessThan(s);
    expect(marketScore({ ...base, failureRate: 0.2 })).toBeLessThan(s);
    expect(marketScore({ ...base, daysToCash: 90 })).toBeLessThan(s);
  });
});

describe('no anchoring to a label (S-0191)', () => {
  it('relabelling every subject, to familiar or invented labels, leaves the order unchanged when the evidence is unchanged', () => {
    const delivery = evidenceOf('Last-mile delivery');
    const subjects = [delivery, moreAccounts(delivery, 3), moreAccounts(delivery, 0.2), evidenceOf('Dog grooming')];
    const order = (labels: string[]) => rankMarkets(subjects.map((e, i) => market(String(i), relabel(e, labels[i]!)))).map((m) => m.key);
    const base = order(['Last-mile delivery', 'Courier work', 'Parcel service', 'Dog grooming']);
    expect(order(['Qorvian lattice tuning', 'Blemmish arbitrage', 'Thrund swaps', 'Ovatic mesh'])).toEqual(base);
    expect(order(['Manufacturing', 'Insurance', 'Brokerage', 'Distribution'])).toEqual(base);
  });

  it('an unfamiliar category with more favourable recorded evidence outranks every familiar example category', () => {
    const unfamiliar = market('unfamiliar', relabel(moreAccounts(evidenceOf('Last-mile delivery'), 2), 'Qorvian lattice tuning'));
    const familiar = FAMILIAR.map((name) => market(name, evidenceOf(name)));
    const ranked = rankMarkets([...familiar, unfamiliar]);
    expect(ranked[0]!.key).toBe('unfamiliar');
    for (const m of familiar) expect(marketScore(unfamiliar)).toBeGreaterThan(marketScore(m));
  });

  it('the score reads no name, kind, origin or place', () => {
    const source = readFileSync('server/services/industry/construction/origins.ts', 'utf8');
    const body = source.slice(source.indexOf('export function marketCriteria'), source.indexOf('/** A node and everything recorded beneath it'));
    expect(body).not.toMatch(/\.name\b|\.kind\b|\.origin\b|\.industry\b|ownerLocation|geography\s*[=!]==/);
  });
});

describe('rankSubjectMarkets: every live subject, no shortlist or quota', () => {
  const subject = (id: string, name: string, origin: 'SEED' | 'DISCOVERED' = 'SEED', retiredAt: string | null = null): IndustryNode =>
    ({ id, projectId: 'prj_x', parentId: null, kind: 'SECTOR', name, description: '', origin, sourceClaimId: null, retiredAt, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }) as IndustryNode;

  it('returns every live subject with its per-criterion reading', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => subject(`ind_${String(i).padStart(2, '0')}`, i % 5 === 0 ? 'Last-mile delivery' : `Category ${i}`));
    rows.push(subject('ind_retired', 'Courier work', 'SEED', '2026-11-02T00:00:00.000Z'));
    const ranked = await rankSubjectMarkets(rows, []);
    expect(ranked).toHaveLength(40);
    expect(new Set(ranked.map((r) => r.node.id)).size).toBe(40);
    for (const r of ranked) expect(r.criteria.score).toBe(marketScore(r.market));
    // Several subjects of one category are all kept: no quota per category.
    expect(ranked.slice(0, 8).filter((r) => r.node.name === 'Last-mile delivery')).toHaveLength(8);
  });

  it('a discovered subject and a seeded one with the same evidence score the same', async () => {
    const seeded = await rankSubjectMarkets([subject('ind_a', 'Last-mile delivery', 'SEED'), subject('ind_b', 'Dog grooming', 'SEED')], []);
    const discovered = await rankSubjectMarkets([subject('ind_a', 'Last-mile delivery', 'DISCOVERED'), subject('ind_b', 'Dog grooming', 'DISCOVERED')], []);
    expect(discovered.map((r) => r.node.id)).toEqual(seeded.map((r) => r.node.id));
    expect(discovered.map((r) => r.criteria.score)).toEqual(seeded.map((r) => r.criteria.score));
  });

  it('takes no owner location', () => {
    expect(rankSubjectMarkets.length).toBe(2);
  });
});

describe('an unknown never outranks adverse evidence (invariant 39)', () => {
  const base: MarketCandidate = { key: 'k', geography: null, marginUsd: 100, monthlyVolume: 100, daysToCash: 30, remoteControl: 1, capitalUsd: 0, feasibility: 1, failureModes: 0, failureRate: 0 };

  it('a heavy known capital does not rank below an identical market whose capital nobody read', () => {
    const known = { ...base, key: 'a-known', capitalUsd: 100_000 };
    const unknown = { ...base, key: 'b-unknown', capitalUsd: null };
    const ranked = rankMarkets([unknown, known]);
    expect(ranked.map((m) => m.key)).toEqual(['a-known', 'b-unknown']);
    const floor = unknownFloor([known, unknown]);
    expect(marketScore(unknown, floor)).toBeLessThanOrEqual(marketScore(known, floor));
    // Whatever the keys, the unknown is never strictly ahead.
    const swapped = rankMarkets([{ ...known, key: 'z-known' }, { ...unknown, key: 'a-unknown' }]);
    expect(marketScore(swapped[0]!, unknownFloor(swapped))).toBe(marketScore({ ...known, key: 'z-known' }, unknownFloor(swapped)));
  });

  it('a high measured failure rate does not rank below an identical unmeasured market', () => {
    const known = { ...base, key: 'a-known', failureRate: 0.5 };
    const unknown = { ...base, key: 'b-unknown', failureRate: null };
    expect(rankMarkets([unknown, known]).map((m) => m.key)).toEqual(['a-known', 'b-unknown']);
    const floor = unknownFloor([known, unknown]);
    expect(floor.failureRate).toBe(0.5);
    expect(marketScore(unknown, floor)).toBeLessThanOrEqual(marketScore(known, floor));
  });

  it('keeps the fixed defaults when no known reading is worse', () => {
    const floor = unknownFloor([{ ...base, capitalUsd: 1_000, failureRate: 0.1 }, { ...base, capitalUsd: null, failureRate: null }]);
    expect(floor.capitalFactor).toBe(UNKNOWN_CAPITAL_FACTOR);
    expect(floor.failureRate).toBe(UNKNOWN_FAILURE_RATE);
  });

  it('a zero contribution says nothing about capital and does not set the floor', () => {
    const floor = unknownFloor([{ ...base, marginUsd: null, capitalUsd: 5 }, { ...base, capitalUsd: null }]);
    expect(floor.capitalFactor).toBe(UNKNOWN_CAPITAL_FACTOR);
  });

  it('a better known reading still outranks the unknown', () => {
    const cheap = { ...base, key: 'z-cheap', capitalUsd: 1_000, failureRate: 0.05 };
    const unknown = { ...base, key: 'a-unknown', capitalUsd: null, failureRate: null };
    expect(rankMarkets([unknown, cheap]).map((m) => m.key)).toEqual(['z-cheap', 'a-unknown']);
  });

  it('the ranked subjects report the criteria their place was decided on', async () => {
    const node = (id: string, name: string): IndustryNode =>
      ({ id, projectId: 'prj_x', parentId: null, kind: 'SECTOR', name, description: '', origin: 'SEED', sourceClaimId: null, retiredAt: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }) as IndustryNode;
    const ranked = await rankSubjectMarkets([node('ind_a', 'Last-mile delivery'), node('ind_b', 'Dog grooming')], []);
    const floor = unknownFloor(ranked.map((r) => r.market));
    for (const r of ranked) expect(r.criteria.score).toBe(marketScore(r.market, floor));
  });
});
