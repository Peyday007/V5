/**
 * META-18-1 (S-0191, S-0192): the probe reader `noAnchoringHoldsOnRows` —
 * every live subject ranked, the order label-invariant, seed origin conferring
 * no advantage, every place resting on economics, scale, time to cash, capital,
 * feasibility and risk, and no category whitelist in source. Each violation the
 * reader detects is produced here by a ranker or scorer that misbehaves.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createNode } from '../server/repos/industry.ts';
import { commercialRoles } from '../server/services/industry/construction/roles.ts';
import { marketOfEvidence, rankSubjectMarkets, type RankedSubject } from '../server/services/industry/construction/origins.ts';
import {
  RANKING_CRITERIA,
  checkSubjects,
  findCategoryWhitelists,
  noAnchoringHoldsOnRows,
  type EvidenceScorer,
  type SubjectRanker,
} from '../server/services/industry/construction/anchoring.ts';
import type { IndustryNode } from '../server/domain/types.ts';

const subject = (id: string, name: string, origin: 'SEED' | 'DISCOVERED' = 'SEED', retiredAt: string | null = null): IndustryNode =>
  ({ id, projectId: 'prj_x', parentId: null, kind: 'SECTOR', name, description: '', origin, sourceClaimId: origin === 'SEED' ? null : 'clm_x', retiredAt, retiredReason: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }) as IndustryNode;

const ROWS = [
  subject('ind_a', 'Last-mile delivery', 'SEED'),
  subject('ind_b', 'Qorvian lattice tuning', 'DISCOVERED'),
  subject('ind_c', 'Insurance', 'SEED'),
  subject('ind_d', 'Dog grooming', 'DISCOVERED'),
  subject('ind_e', 'Manufacturing', 'SEED'),
  subject('ind_r', 'Distribution', 'SEED', '2026-11-02T00:00:00.000Z'),
];

const kinds = (vs: { kind: string }[]) => vs.map((v) => v.kind);

describe('checkSubjects: the demonstrations on one project’s rows', () => {
  it('holds for the production ranker and scorer', async () => {
    const check = await checkSubjects('prj_x', ROWS, []);
    expect(check.live).toBe(5);
    expect(check.ranked).toBe(5);
    expect(check.violations).toEqual([]);
  });

  it('a project with no live subject has nothing to violate', async () => {
    expect(await checkSubjects('prj_x', [ROWS[5]!], [])).toEqual({ live: 0, ranked: 0, violations: [] });
  });

  it('detects a shortlist (UNRANKED)', async () => {
    const top3: SubjectRanker = async (n, c) => (await rankSubjectMarkets(n, c)).slice(0, 3);
    const check = await checkSubjects('prj_x', ROWS, [], { rank: top3 });
    expect(kinds(check.violations)).toContain('UNRANKED');
    expect(check.violations.find((v) => v.kind === 'UNRANKED')!.detail).toMatch(/2 left out/);
  });

  it('detects a score that reads the label (LABEL_ANCHORED)', async () => {
    // A scorer that boosts the owner’s example categories by name.
    const anchored: EvidenceScorer = (key, e) => {
      const m = marketOfEvidence(key, e, commercialRoles(e));
      return /insurance|manufactur/i.test(e.industry)
        ? { ...m, marginUsd: 1e6, monthlyVolume: 1e3, daysToCash: 1, remoteControl: 1, capitalUsd: 0, feasibility: 1, failureModes: 0, failureRate: 0 }
        : m;
    };
    const check = await checkSubjects('prj_x', ROWS, [], { score: anchored });
    expect(kinds(check.violations)).toContain('LABEL_ANCHORED');
  });

  it('detects a ranker whose order is not the one the evidence earns (RANKER_DIVERGED)', async () => {
    const reversed: SubjectRanker = async (n, c) => [...(await rankSubjectMarkets(n, c))].reverse();
    const check = await checkSubjects('prj_x', ROWS, [], { rank: reversed });
    expect(kinds(check.violations)).toContain('RANKER_DIVERGED');
  });

  it('detects a seed advantage (ORIGIN_ADVANTAGE)', async () => {
    const seedsFirst: SubjectRanker = async (n, c) => {
      const ranked = await rankSubjectMarkets(n, c);
      const boost = (r: RankedSubject) => ({ ...r, criteria: { ...r.criteria, score: r.criteria.score + (r.node.origin === 'SEED' ? 1e9 : 0) } });
      return ranked.map(boost).sort((a, b) => b.criteria.score - a.criteria.score);
    };
    const check = await checkSubjects('prj_x', ROWS, [], { rank: seedsFirst });
    expect(kinds(check.violations)).toContain('ORIGIN_ADVANTAGE');
  });

  it('detects a place resting on no reading of a criterion (CRITERIA_MISSING)', async () => {
    const noRisk: SubjectRanker = async (n, c) =>
      (await rankSubjectMarkets(n, c)).map((r) => ({ ...r, criteria: { ...r.criteria, riskFactor: Number.NaN } }));
    const check = await checkSubjects('prj_x', ROWS, [], { rank: noRisk });
    const v = check.violations.find((x) => x.kind === 'CRITERIA_MISSING');
    expect(v?.detail).toMatch(/risk/);
  });

  it('names economics, scale, time to cash, capital, feasibility and risk', () => {
    expect(Object.keys(RANKING_CRITERIA).sort()).toEqual(['capital', 'economics', 'feasibility', 'risk', 'scale', 'time to cash']);
  });
});

describe('findCategoryWhitelists', () => {
  it('finds a constant of example categories or one named as an allow-list', () => {
    const found = findCategoryWhitelists([
      { path: 'a.ts', text: "const FOCUS = ['Brokerage', 'Insurance', 'Plumbing'];\nif (FOCUS.includes(x)) go();" },
      { path: 'b.ts', text: "export const ALLOWED_INDUSTRIES = new Set<string>(['Plumbing']);" },
      { path: 'c.ts', text: "const DIMENSIONS = ['DEMAND', 'DISTRIBUTION', 'PAYMENT'] as const;" },
    ]);
    expect(found.map((f) => `${f.file}:${f.constant}`)).toEqual(['a.ts:FOCUS', 'b.ts:ALLOWED_INDUSTRIES']);
  });
});

describe('noAnchoringHoldsOnRows', () => {
  afterAll(teardown);

  it('holds on real rows, writes nothing, and finds no whitelist in source', async () => {
    const { project } = await freshProject();
    await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Last-mile delivery', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Qorvian lattice tuning', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Insurance', origin: 'SEED' });
    const tables = ['industry_nodes', 'opportunity_constraints', 'project_events'];
    const count = async () => Promise.all(tables.map(async (t) => (await getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))[0]!.n));
    const before = await count();
    const report = await noAnchoringHoldsOnRows();
    expect(await count()).toEqual(before);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.live).toBeGreaterThanOrEqual(3);
    expect(report.ranked).toBe(report.live);
    expect(report.filesScanned).toBeGreaterThan(5);
    expect(report.whitelists).toEqual([]);
    expect(report.detail).toMatch(/label-invariant and origin-neutral/);
  });

  it('does not hold when there is nothing to demonstrate on', async () => {
    await freshProject();
    const report = await noAnchoringHoldsOnRows();
    expect(report.live).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/no live subject/);
  });
});
