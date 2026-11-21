/**
 * CAP-25-2 / S-0362, finding F3: the allocator must be able to compare another
 * LLM job with another non-LLM algorithm. The ALGORITHM option is priced from
 * the detector rule versions that were actually added (`feed_detections`), and
 * a free-lane slot — which runs model calls — is never the non-LLM side.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import {
  ALGORITHM_ADDITION_LOOKBACK_MS,
  additionOptions,
  algorithmOption,
  allocateMarginal,
  isModelCapacity,
  readAlgorithmAdditions,
  readStageLimit,
  type AlgorithmAddition,
} from '../server/services/freeLane/stageLimit.ts';
import type { StageCapacityReport } from '../server/services/freeLane/stageCapacity.ts';

const ok = (value: number) => ({ measured: true as const, value });
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const add = (over: Partial<AlgorithmAddition> = {}): AlgorithmAddition => ({
  ruleId: 'r', ruleVersion: 1, mode: 'ACTIVE', addedAt: hoursAgo(10), leads: 20, bytes: 1024 ** 3, ...over,
});

describe('algorithmOption', () => {
  it('measures the gain of a recently added ACTIVE rule from its own leads per hour since it was added', () => {
    const o = algorithmOption({ additions: [add(), add({ ruleId: 's', addedAt: hoursAgo(20), leads: 10 })], nowMs: NOW, storagePerGbMonth: 7.2 });
    expect(o.kind).toBe('ALGORITHM');
    expect(o.id).toBe('added: r@1, s@1');
    // r: 20 leads / 10 h = 2/h; s: 10 / 20 = 0.5/h; mean 1.25/h.
    expect(o.gain).toEqual(ok(1.25));
    // 1 GB at $7.2/GB-month is $0.01/h per rule.
    expect(o.cost).toEqual(ok(0.01));
    expect(isModelCapacity(o)).toBe(false);
  });

  it('never assumes code is free: unpriced storage leaves the cost unmeasured', () => {
    const o = algorithmOption({ additions: [add()], nowMs: NOW, storagePerGbMonth: null });
    expect(o.gain.measured).toBe(true);
    expect(o.cost.measured).toBe(false);
  });

  it('a SHADOW rule, an old rule, or no rule is not a measured addition', () => {
    expect(algorithmOption({ additions: [add({ mode: 'SHADOW' })], nowMs: NOW, storagePerGbMonth: 1 }).gain.measured).toBe(false);
    const old = hoursAgo(ALGORITHM_ADDITION_LOOKBACK_MS / 3_600_000 + 1);
    expect(algorithmOption({ additions: [add({ addedAt: old })], nowMs: NOW, storagePerGbMonth: 1 }).gain.measured).toBe(false);
    expect(algorithmOption({ additions: [], nowMs: NOW, storagePerGbMonth: 1 }).gain.measured).toBe(false);
    expect(algorithmOption(null).gain.measured).toBe(false);
  });
});

describe('the allocator compares an LLM job with a measured algorithm (finding F3)', () => {
  const report = {
    stages: [{ stage: 'model-interpretation', itemsProcessedPerHour: ok(10), acceptedPerHour: 4, incrementalDollars: ok(12) }],
    constrained: { stage: 'model-interpretation', basis: 'b', expectedGain: { measured: true, value: { acceptedFactsPerHour: 1, dollars: 2 } }, recommendation: 'r' },
  } as unknown as StageCapacityReport;

  it('a free-lane slot is model capacity: LLM job vs slot alone is not an LLM-vs-non-LLM comparison', () => {
    const opts = additionOptions(report, [], 6);
    expect(opts.find((o) => o.kind === 'WORKER')!.modelCapacity).toBe(true);
    expect(allocateMarginal(opts).comparedLlmWithNonLlm).toBe(false);
    expect(allocateMarginal([
      { kind: 'LLM_JOB', id: 'llm', gain: ok(1), cost: ok(1) },
      { kind: 'WORKER', id: 'slot', modelCapacity: true, gain: ok(1), cost: ok(1) },
    ]).comparedLlmWithNonLlm).toBe(false);
  });

  it('with a priced rule addition, the algorithm is measured, compared, and chosen when it adds more per dollar', () => {
    const opts = additionOptions(report, [], 6, { additions: [add()], nowMs: NOW, storagePerGbMonth: 7.2 });
    const a = allocateMarginal(opts);
    expect(a.comparedLlmWithNonLlm).toBe(true);
    expect(a.chosen!.kind).toBe('ALGORITHM');
    expect(a.unmeasured.map((u) => u.kind)).not.toContain('ALGORITHM');
  });

  it('an LLM job still wins when the added rule produced little', () => {
    const opts = additionOptions(report, [], 6, { additions: [add({ leads: 0 })], nowMs: NOW, storagePerGbMonth: 7.2 });
    const a = allocateMarginal(opts);
    expect(a.comparedLlmWithNonLlm).toBe(true);
    expect(a.chosen!.kind).toBe('LLM_JOB');
  });

  it('a tie prefers the option that needs no model call, and a slot does not', () => {
    const a = allocateMarginal([
      { kind: 'WORKER', id: 'slot', modelCapacity: true, gain: ok(2), cost: ok(1) },
      { kind: 'ALGORITHM', id: 'rule', gain: ok(2), cost: ok(1) },
    ]);
    expect(a.chosen!.kind).toBe('ALGORITHM');
    expect(a.ranked.map((r) => r.kind)).toEqual(['ALGORITHM', 'WORKER']);
  });
});

describe('readAlgorithmAdditions (rows)', () => {
  beforeEach(async () => { await freshProject(); });

  const detection = async (ruleId: string, version: number, mode: string, at: string, lead: boolean) => {
    await getDb().run(
      `INSERT INTO feed_detections (id, rule_id, rule_version, group_key, label, window_from, window_to, member_ids, source_urls, qualifiers, mode, detected_at, updated_at, lead_item_id)
       VALUES (?, ?, ?, ?, 'l', ?, ?, '[]', '[]', '{}', ?, ?, ?, ?)`,
      [newId('det'), ruleId, version, newId('g'), at, at, mode, at, at, lead ? newId('item') : null],
    );
  };

  it('reads each rule version first detected in the lookback, with its leads and bytes, and the stage-limit reading prices it', async () => {
    await detection('fresh', 2, 'ACTIVE', hoursAgo(4), true);
    await detection('fresh', 2, 'ACTIVE', hoursAgo(2), true);
    await detection('fresh', 2, 'ACTIVE', hoursAgo(1), false);
    await detection('shadow', 1, 'SHADOW', hoursAgo(3), false);
    await detection('old', 1, 'ACTIVE', hoursAgo(24 * 30), true);
    await detection('old', 1, 'ACTIVE', hoursAgo(1), true);
    const rows = await readAlgorithmAdditions(NOW);
    const byRule = new Map(rows.map((r) => [r.ruleId, r]));
    expect([...byRule.keys()].sort()).toEqual(['fresh', 'shadow']);
    expect(byRule.get('fresh')).toMatchObject({ ruleVersion: 2, mode: 'ACTIVE', leads: 2, addedAt: hoursAgo(4) });
    expect(byRule.get('fresh')!.bytes).toBeGreaterThan(0);
    expect(byRule.get('shadow')!.mode).toBe('SHADOW');

    const report = await readStageLimit({ now: NOW });
    const algo = [...report.allocation.ranked, ...report.allocation.unmeasured].find((o) => o.kind === 'ALGORITHM')!;
    expect(algo.id).toBe('added: fresh@2');
  });
});
