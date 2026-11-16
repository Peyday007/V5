/**
 * A rule earns ACTIVE from its own verified output: SHADOW rules are read
 * against the independent free screen, promotion and rollback are a pure
 * decision over those readings, and a version change recomputes only itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { listCandidates } from '../server/repos/improvement.ts';
import {
  CONCENTRATED_HIRING,
  DETECTORS,
  PROMOTION_MIN_SCREENED,
  REPEATED_DEMAND,
  RULE_MISS_PROPOSAL_MIN,
  RULE_EFFECTIVE_SOON,
  effectiveDateOf,
  jobFamily,
  modeDecision,
  ruleMissKey,
  ruleMissWeakness,
  ruleReading,
  runDetectors,
  type Detector,
  type DetectorRecord,
} from '../server/services/feeds/detectors.ts';

const now = new Date();
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY).toISOString();
const dayAhead = (n: number) => new Date(now.getTime() + n * DAY).toISOString().slice(0, 10);

function rec(id: string, title: string, org: string | null, published: string | null, source = 'remoteok', body: string | null = null): DetectorRecord {
  return { id, source, url: `https://${source}.test/${id}`, title, organization: org, publishedAt: published, fetchedAt: now.toISOString(), body };
}

beforeEach(async () => {
  await freshProject();
});

describe('new rules start in SHADOW', () => {
  it('every rule but the proven one is SHADOW, and each is versioned', () => {
    expect(CONCENTRATED_HIRING.mode).toBe('ACTIVE');
    for (const rule of DETECTORS.filter((one) => one !== CONCENTRATED_HIRING)) {
      expect(rule.mode).toBe('SHADOW');
      expect(rule.version).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(DETECTORS.map((one) => one.id)).size).toBe(DETECTORS.length);
  });
});

describe('repeated demand', () => {
  it('fires on one family asked for by three distinct employers, and keeps a family with no deliverable', () => {
    const signals = REPEATED_DEMAND.detect(
      [
        rec('a', 'Data Analyst', 'Acme', daysAgo(1)),
        rec('b', 'Data Engineer', 'Globex', daysAgo(3), 'remotive'),
        rec('c', 'BI Developer', 'Initech', daysAgo(6)),
        rec('d', 'Data Analyst', 'Acme Inc', daysAgo(2)),
        rec('e', 'Data Analyst', 'Old Co', daysAgo(40)),
      ],
      now,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ groupKey: 'family:DATA', entityKey: null, category: 'DATA' });
    expect(signals[0]!.memberIds.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(signals[0]!.label).toContain('3 distinct employers');
    expect(signals[0]!.hypothesis).toMatch(/Not established/);
  });

  it('two employers is not repeated demand', () => {
    expect(REPEATED_DEMAND.detect([rec('a', 'Data Analyst', 'Acme', daysAgo(1)), rec('b', 'Data Analyst', 'Globex', daysAgo(1))], now)).toEqual([]);
  });
});

describe('rules taking effect soon', () => {
  it('reads the stated effective date and groups by agency inside the window', () => {
    expect(effectiveDateOf('Final rule. Effective 2026-12-01. Something.')).toBe('2026-12-01');
    expect(effectiveDateOf('no date')).toBeNull();
    const signals = RULE_EFFECTIVE_SOON.detect(
      [
        rec('a', 'Rule A', 'Environmental Protection Agency', daysAgo(2), 'federal-register-rules', `Effective ${dayAhead(10)}.`),
        rec('b', 'Rule B', 'Environmental Protection Agency', daysAgo(3), 'federal-register-rules', `Effective ${dayAhead(20)}.`),
        rec('c', 'Rule C', 'Department of Labor', daysAgo(1), 'federal-register-rules', `Effective ${dayAhead(200)}.`),
        rec('d', 'Rule D', 'Department of Labor', daysAgo(1), 'federal-register-rules', null),
      ],
      now,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.memberIds.sort()).toEqual(['a', 'b']);
    expect(signals[0]).toMatchObject({ category: 'REGULATION', deliverable: 'DOCUMENT' });
    expect(signals[0]!.qualifiers.join(' ')).toMatch(/not who will pay/);
  });
});

describe('the mode decision', () => {
  it('a small sample never moves a rule, whatever it says', () => {
    expect(modeDecision('SHADOW', { precision: null, evidenceQuality: 1, screenedMembers: 3 }).mode).toBe('SHADOW');
    expect(modeDecision('ACTIVE', { precision: null, evidenceQuality: 0, screenedMembers: 0 }).mode).toBe('ACTIVE');
  });
  it('promotes SHADOW only on precision and evidence quality both at the bar', () => {
    expect(modeDecision('SHADOW', { precision: 0.9, evidenceQuality: 0.9, screenedMembers: 20 }).mode).toBe('ACTIVE');
    expect(modeDecision('SHADOW', { precision: 0.9, evidenceQuality: 0.5, screenedMembers: 20 }).mode).toBe('SHADOW');
    expect(modeDecision('SHADOW', { precision: 0.7, evidenceQuality: 1, screenedMembers: 20 }).mode).toBe('SHADOW');
  });
  it('returns a degraded ACTIVE rule to SHADOW', () => {
    const decision = modeDecision('ACTIVE', { precision: 0.4, evidenceQuality: 1, screenedMembers: 20 });
    expect(decision.mode).toBe('SHADOW');
    expect(decision.reason).toMatch(/demoted/);
    expect(modeDecision('ACTIVE', { precision: 0.7, evidenceQuality: 1, screenedMembers: 20 }).mode).toBe('ACTIVE');
  });
});

async function screen(itemId: string, verdict: 'KEEP' | 'DROP' | 'UNSURE') {
  for (const model of ['m1', 'm2']) {
    await getDb().run(
      `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
       VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
      [`cr-${itemId}-${model}`, `h-${itemId}`, itemId, model, JSON.stringify({ verdict, window: 'SHORT', deliverable: 'DATASET', need: 'x', payer: 'y', reason: 'z' }), now.toISOString()],
    );
  }
}

const SHADOW_DEMAND: Detector = { ...REPEATED_DEMAND, id: 'TEST_DEMAND', version: 1 };

async function seedDemand(count: number) {
  const orgs = Array.from({ length: count }, (_, i) => `Employer ${String.fromCharCode(65 + i)}${i}`);
  await insertFeedItems(
    'remoteok',
    orgs.map((org, i) => ({ externalId: `x${i}`, url: `https://remoteok.test/x${i}`, title: 'Data Analyst', body: null, organization: org, publishedAt: daysAgo(1 + (i % 5)) })),
  );
  return getDb().all<{ id: string; organization: string }>(`SELECT id, organization FROM feed_items WHERE source = 'remoteok' ORDER BY external_id`);
}

describe('readings from rows, and promotion through runDetectors', () => {
  it('a SHADOW rule with confirmed members is promoted; its detections are stored ACTIVE under its version', async () => {
    const items = await seedDemand(PROMOTION_MIN_SCREENED + 2);
    // First pass: no screen yet, too little evidence — the rule stays SHADOW and covers nothing.
    const first = await runDetectors({ now, detectors: [SHADOW_DEMAND] });
    expect(first[0]).toMatchObject({ mode: 'SHADOW', signals: 1, covered: 0 });
    expect(first[0]!.modeReason).toMatch(/under the/);
    for (const item of items) await screen(item.id, 'KEEP');
    const reading = await ruleReading(SHADOW_DEMAND, now);
    expect(reading).toMatchObject({ members: items.length, screenedMembers: items.length, confirmed: items.length, falseJoins: 0, precision: 1, evidenceQuality: 1 });
    const second = await runDetectors({ now, detectors: [SHADOW_DEMAND] });
    expect(second[0]!.mode).toBe('ACTIVE');
    const rows = await getDb().all<{ mode: string; rule_version: number }>(`SELECT mode, rule_version FROM feed_detections WHERE rule_id = 'TEST_DEMAND'`);
    expect(rows.every((row) => row.rule_version === 1)).toBe(true);
    expect(rows.some((row) => row.mode === 'ACTIVE')).toBe(true);
  });

  it('members the screen drops are false joins and hold the rule in SHADOW; an UNSURE is no verdict', async () => {
    const items = await seedDemand(PROMOTION_MIN_SCREENED + 2);
    await runDetectors({ now, detectors: [SHADOW_DEMAND] });
    for (const [i, item] of items.entries()) await screen(item.id, i === 0 ? 'UNSURE' : i % 2 ? 'DROP' : 'KEEP');
    const reading = await ruleReading(SHADOW_DEMAND, now);
    expect(reading.screenedMembers).toBe(items.length - 1);
    expect(reading.falseJoins).toBeGreaterThan(0);
    expect(reading.confirmed + reading.falseJoins).toBe(reading.screenedMembers);
    const pass = await runDetectors({ now, detectors: [SHADOW_DEMAND] });
    expect(pass[0]!.mode).toBe('SHADOW');
  });

  it('a version change is a new reading; the earlier version keeps its rows', async () => {
    await seedDemand(4);
    await runDetectors({ now, detectors: [SHADOW_DEMAND] });
    const v2: Detector = { ...SHADOW_DEMAND, version: 2 };
    const reading = await ruleReading(v2, now);
    expect(reading).toMatchObject({ rule: 'TEST_DEMAND@2', detections: 0 });
    await runDetectors({ now, detectors: [v2] });
    const versions = await getDb().all<{ rule_version: number }>(`SELECT DISTINCT rule_version FROM feed_detections WHERE rule_id = 'TEST_DEMAND' ORDER BY rule_version`);
    expect(versions.map((one) => one.rule_version)).toEqual([1, 2]);
  });

  it('`rules` recomputes only the named rule', async () => {
    await seedDemand(4);
    const reports = await runDetectors({ now, detectors: [SHADOW_DEMAND, CONCENTRATED_HIRING], rules: ['TEST_DEMAND'] });
    expect(reports.map((one) => one.rule)).toEqual(['TEST_DEMAND@1']);
  });
});

/**
 * F7: a rule that keeps missing what the independent screen keeps is proposed
 * for a new version through Factory — registered with the improvement loop,
 * which owns turning a weakness into a Factory objective — and nothing about
 * the rule itself changes at run time.
 */
describe('repeated misses become a Factory proposal', () => {
  // Recognises only the first three records of a family it knows; the rest are misses.
  const NARROW: Detector = {
    id: 'TEST_NARROW',
    version: 1,
    label: 'test narrow family rule',
    mode: 'SHADOW',
    sources: ['remoteok'],
    lookbackMs: 14 * DAY,
    detect(records) {
      const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 3);
      if (sorted.length === 0) return [];
      return [{
        groupKey: 'narrow', label: 'narrow', entityKey: null, entityName: null,
        category: jobFamily('Data Analyst')!.key,
        windowFrom: daysAgo(10), windowTo: now.toISOString(),
        memberIds: sorted.map((one) => one.id), memberTitles: sorted.map((one) => one.title),
        sourceUrls: sorted.map((one) => one.url), qualifiers: [], hypothesis: null, deliverable: null,
      }];
    },
  };

  it('misses the screen kept are counted with samples, and enough of them register one candidate owned by the detectors', async () => {
    const items = await seedDemand(3 + RULE_MISS_PROPOSAL_MIN + 1);
    await runDetectors({ now, detectors: [NARROW] });
    for (const item of items) await screen(item.id, 'KEEP');

    const reading = await ruleReading(NARROW, now);
    expect(reading.members).toBe(3);
    expect(reading.misses).toBe(items.length - 3);
    expect(reading.missedSamples.length).toBeGreaterThan(0);
    expect(reading.missedSamples[0]).toMatch(/Data Analyst — https:\/\/remoteok\.test\//);

    const pass = await runDetectors({ now, detectors: [NARROW] });
    expect(pass[0]!.proposed).toBe(ruleMissKey(NARROW));
    // The rule's own mode is untouched by the proposal: it is still decided by its readings.
    expect(pass[0]!.mode).toBe('SHADOW');

    const again = await runDetectors({ now, detectors: [NARROW] });
    expect(again[0]!.proposed).toBe(ruleMissKey(NARROW));
    const candidates = (await listCandidates()).filter((one) => one.weaknessKey.startsWith(ruleMissKey(NARROW)));
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.kind).toBe('DETECTOR_MISSES');
    expect(candidate.ownerComponent).toBe('server/services/feeds/detectors.ts');
    expect(candidate.problem).toMatch(/starts in SHADOW/);
    expect(candidate.frequency).toBe(reading.misses);
    expect(candidate.evidence['mutationScope']).toEqual(['server/services/feeds/**', 'tests/**']);
    expect(candidate.evidence['detectorProposal']).toMatchObject({ rule: 'TEST_NARROW@1', misses: reading.misses });
    expect((candidate.evidence['samples'] as string[]).length).toBeGreaterThan(0);
  });

  it('a rule below the miss bar proposes nothing', async () => {
    const items = await seedDemand(3 + RULE_MISS_PROPOSAL_MIN - 1);
    await runDetectors({ now, detectors: [NARROW] });
    for (const item of items) await screen(item.id, 'KEEP');
    const pass = await runDetectors({ now, detectors: [NARROW] });
    expect(pass[0]!.proposed).toBeNull();
    expect((await listCandidates()).filter((one) => one.weaknessKey.startsWith(ruleMissKey(NARROW)))).toHaveLength(0);
  });

  it('the weakness is pure, keyed by version, and severe when misses outnumber confirmations', () => {
    const base = { rule: 'X@1', detections: 1, members: 3, screenedMembers: 3, confirmed: 3, falseJoins: 0, precision: null, evidenceQuality: 1, missedSamples: ['a — u'] };
    expect(ruleMissWeakness({ id: 'X', version: 1, label: 'x' }, { ...base, misses: RULE_MISS_PROPOSAL_MIN - 1 })).toBeNull();
    const severe = ruleMissWeakness({ id: 'X', version: 1, label: 'x' }, { ...base, misses: RULE_MISS_PROPOSAL_MIN });
    expect(severe).toMatchObject({ key: 'DETECTOR_MISSES:X@1', severity: 'HIGH', samples: ['a — u'] });
    const outweighed = ruleMissWeakness({ id: 'X', version: 2, label: 'x' }, { ...base, confirmed: 20, misses: RULE_MISS_PROPOSAL_MIN });
    expect(outweighed).toMatchObject({ key: 'DETECTOR_MISSES:X@2', severity: 'MEDIUM' });
  });
});
