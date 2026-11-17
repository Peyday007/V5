/**
 * RES-15-5 repair, episode 3. Probe r01.res-15-5 failed five times on
 * 2026-11-17 on one and the same decision, whose fingerprint begins
 * `{"shares":[0.033,0.2,0.03,0.577,0.161],"lanes":[...]` — with no leading
 * `held`. `allocationFingerprint` has led with `held` since the F1 repair, and
 * the probe reports the NEWEST measured row that fails, so that production
 * reading shows two things at once: the failing row was written by the older
 * recorder, and every measured row newer than it already showed its cost
 * counted once. These tests pin that the current recorder only writes rows
 * that hold over production-shaped windows (jobs serving several purposes,
 * uneven yield, lanes with remedies being measured), that the probe's failure
 * on such history is exactly the legacy row, and that the decision row and the
 * briefing now say so — legacy versus current, and how many ordinary decision
 * rows remain before the legacy row leaves the probe's 50-row window — without
 * deleting, editing or superseding any history row (§5, R3-1).
 */
import { describe, expect, it } from 'vitest';
import { summarizeResearchYield, type PurposeKey, type ResearchYieldReading, type YieldJob, type YieldOutput } from '../server/services/goals/researchYield.ts';
import { ALLOCATION_AUDIT_ROWS, probeWindowStanding, reallocateResearch, withMeasuredReasons, type ResearchAllocationPorts } from '../server/services/goals/tick.ts';
import { decideResearchAllocation, type AllocationInput } from '../server/services/goals/researchAllocation.ts';
import { researchBriefingFrom } from '../server/services/goals/briefing.ts';
import { yieldAllocationHolds } from '../server/services/factory/program/release01/researchGoalProbe.ts';
import type { GoalView } from '../server/services/goals/model.ts';

const DAY = 86_400_000;
const START = Date.parse('2026-11-10T00:00:00.000Z');

/** The failing row exactly as the probe reported it on production: a pre-F1 fingerprint. */
const LEGACY_FINGERPRINT = JSON.stringify({
  shares: [0.033, 0.2, 0.03, 0.577, 0.161],
  lanes: [
    '(no job on record):MEASURING_REMEDY',
    'bin:claude-routine:MEASURING_REMEDY',
    'free-lane:auto:MEASURING_REMEDY',
    'free-lane:runpod/Qwen/Qwen3-4B-AWQ:MEASURING_REMEDY',
    'free-lane:runpod/openai/gpt-oss-120b:MEASURING_REMEDY',
  ],
  capacity: [],
});
const legacyRow = {
  fingerprint: LEGACY_FINGERPRINT,
  held: false,
  shares: { BROAD_DISCOVERY: 0.033, TRANSACTION_ROUTES: 0.2, OPERATING_SUPPORT: 0.03, SELF_IMPROVEMENT: 0.577, FORWARD_EXPLORATION: 0.161 },
  changes: [],
  costCountedOnce: { holds: false, totalJobMs: null, purposeJobMs: null },
};

const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as GoalView;

const LANES = ['free-lane:runpod/Qwen/Qwen3-4B-AWQ', 'free-lane:runpod/openai/gpt-oss-120b', 'free-lane:auto', 'bin:claude-routine'];
const SETS: PurposeKey[][] = [
  ['SELF_IMPROVEMENT'],
  ['BROAD_DISCOVERY', 'FORWARD_EXPLORATION'],
  ['TRANSACTION_ROUTES', 'BROAD_DISCOVERY', 'SELF_IMPROVEMENT'],
  ['OPERATING_SUPPORT', 'TRANSACTION_ROUTES'],
  ['FORWARD_EXPLORATION'],
  ['UNATTRIBUTED'],
];

/** A production-shaped day: odd durations, three-way splits, money on some jobs, uneven useful output. */
function day(n: number): ResearchYieldReading {
  const since = START + n * DAY;
  const jobs: YieldJob[] = [];
  const outputs: YieldOutput[] = [];
  for (let i = 0; i < 97; i += 1) {
    const purposes = SETS[(i + n) % SETS.length]!;
    const lane = LANES[i % LANES.length]!;
    jobs.push({
      id: `d${n}j${i}`, lane, purposes, basis: ['row'], startMs: since + i * 731_003, durationMs: 1_000 + ((i * 7_919 + n * 104_729) % 900_001) + 0.1 * (i % 3),
      queueWaitMs: i % 5 === 0 ? null : i * 1_013, outcome: i % 11 === 0 ? 'FAILED' : 'COMPLETED', failureCause: i % 11 === 0 ? 'timeout' : null,
      rateLimited: i % 22 === 0, costMinor: lane.startsWith('bin:') ? 333 + (i % 7) / 3 : null,
    });
    if (i % (3 + n) === 0) outputs.push({ kind: i % 2 ? 'PACKET_FILED' : 'QUALIFIED_POSITION', id: `d${n}o${i}`, lane, purposes });
    outputs.push({ kind: 'ACCEPTED_CLAIM', id: `d${n}c${i}`, lane, purposes, source: i % 4 ? 'SECONDARY' : 'PRIMARY' });
  }
  return summarizeResearchYield({ since: new Date(since).toISOString(), until: new Date(since + DAY).toISOString(), jobs, outputs });
}

/** Ports over an append-only row list holding the legacy row first, read back newest first like production. */
function productionPorts() {
  const rows: { detail: Record<string, unknown>; at: string }[] = [{ detail: legacyRow, at: new Date(START).toISOString() }];
  let n = 0;
  const p: ResearchAllocationPorts = {
    readYield: async () => day(n),
    appliedRemedies: async () => [],
    lastDecision: async () => rows.at(-1) ?? null,
    recentDecisions: async (limit) => [...rows].reverse().slice(0, limit),
    recordDecision: async (_s, detail) => { rows.push({ detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>, at: new Date(START + (n + 1) * DAY).toISOString() }); },
  };
  return { p, rows, next: () => { n += 1; }, at: () => new Date(START + (n + 1) * DAY + 3_600_000).toISOString() };
}

describe('RES-15-5 episode 3: the failing row is the legacy recorder, and the current recorder holds', () => {
  it('every row the current recorder writes over production-shaped windows holds, and each change has a reason', async () => {
    const { p, rows, next, at } = productionPorts();
    for (let i = 0; i < 6; i += 1) {
      await reallocateResearch({ goals: [goal], now: at() }, p);
      next();
    }
    const written = rows.slice(1).map((r) => r.detail);
    expect(written.length).toBeGreaterThanOrEqual(6);
    for (const d of written) {
      expect(String(d.fingerprint).startsWith('{"held"')).toBe(true);
      expect(d.heldForCost).toBe(false);
      expect((d.costCountedOnce as { holds: unknown }).holds).toBe(true);
      for (const c of d.changes as { reasons: unknown[] }[]) expect(c.reasons.length).toBeGreaterThan(0);
    }
    // The current recorder's rows on their own never fail the owner's probe.
    expect(yieldAllocationHolds([...written].reverse()).ok).not.toBe(false);
    // With the legacy row still in the window, the probe fails on exactly that row — the production reading.
    const r = yieldAllocationHolds([...rows].reverse().map((x) => x.detail));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe(`decision ${LEGACY_FINGERPRINT} does not show its cost counted once`);
    // And nothing was removed or rewritten to get there.
    expect(rows[0]!.detail).toEqual(legacyRow);
  });

  it('the newest decision row says the failures are legacy-only and when they leave the checked window', async () => {
    const { p, rows, next, at } = productionPorts();
    for (let i = 0; i < 3; i += 1) {
      await reallocateResearch({ goals: [goal], now: at() }, p);
      next();
    }
    const newest = rows.at(-1)!;
    const audit = newest.detail.priorCostFailures as { failing: number; standing: ReturnType<typeof probeWindowStanding>; earliest: { recorder: string } };
    expect(audit.failing).toBe(1);
    expect(audit.earliest.recorder).toBe('BEFORE_HELD_IN_FINGERPRINT');
    expect(audit.standing.currentRecorderFailing).toBe(0);
    expect(audit.standing.failingByRecorder.BEFORE_HELD_IN_FINGERPRINT).toBe(1);
    expect(audit.standing.newestFailingRecorder).toBe('BEFORE_HELD_IN_FINGERPRINT');
    // Read before the newest row was written: the legacy row sat behind the rows before it.
    expect(audit.standing.rowsUntilClear).toBe(ALLOCATION_AUDIT_ROWS - (rows.length - 2));
    const b = researchBriefingFrom(newest.detail, newest.at)!;
    expect(b.costCountedOnce).toMatchObject({ holds: true, earlierFailures: 1 });
    expect(b.costStanding).toMatchObject({ legacyFailures: 1, currentFailures: 0 });
    expect(b.line).toMatch(/written by an earlier recorder, none by the current one/);
    expect(b.line).toMatch(/leave the checked window after \d+ more decision/);
  });
});

describe('probeWindowStanding', () => {
  const ok = (fp = '{"held":false}') => ({ detail: { fingerprint: fp, held: false, costCountedOnce: { holds: true } }, at: 'x' });
  const bad = (fp: string) => ({ detail: { fingerprint: fp, held: false, costCountedOnce: { holds: false } }, at: 'x' });
  const held = { detail: { fingerprint: '{"held":true}', held: true }, at: 'x' };

  it('counts failures by recorder and the rows until the newest failing one leaves', () => {
    const s = probeWindowStanding([ok(), held, bad('{"shares":[1]}'), ok(), bad('{"shares":[2]}')]);
    expect(s.failingByRecorder).toEqual({ HELD_IN_FINGERPRINT: 0, BEFORE_HELD_IN_FINGERPRINT: 2 });
    expect(s.currentRecorderFailing).toBe(0);
    expect(s.newestFailingIndex).toBe(2);
    expect(s.rowsUntilClear).toBe(ALLOCATION_AUDIT_ROWS - 2);
  });

  it('names a current-recorder failure as one, and ignores rows beyond the probe window', () => {
    const s = probeWindowStanding([ok(), bad('{"held":false,"shares":[]}')]);
    expect(s.currentRecorderFailing).toBe(1);
    expect(s.newestFailingRecorder).toBe('HELD_IN_FINGERPRINT');
    const beyond = probeWindowStanding([ok(), ok(), bad('{"shares":[]}')], 2);
    expect(beyond).toMatchObject({ rowsRead: 2, newestFailingIndex: null, rowsUntilClear: 0 });
  });

  it('is clear when nothing fails', () => {
    expect(probeWindowStanding([ok(), held])).toMatchObject({ newestFailingIndex: null, rowsUntilClear: 0, currentRecorderFailing: 0 });
  });
});

describe('a share that moves only by renormalization still carries its measured reason', () => {
  // SELF_IMPROVEMENT sits within 5% of the measured average, so the allocator named no reason for it,
  // yet its share moves because BROAD_DISCOVERY and FORWARD_EXPLORATION moved theirs.
  const input = {
    currentShares: { BROAD_DISCOVERY: 0.1, TRANSACTION_ROUTES: 0.5, OPERATING_SUPPORT: 0.1, SELF_IMPROVEMENT: 0.2, FORWARD_EXPLORATION: 0.1 },
    purposes: [
      { purpose: 'BROAD_DISCOVERY', usefulResults: 40, cost: 10 },
      { purpose: 'TRANSACTION_ROUTES', usefulResults: 10, cost: 10 },
      { purpose: 'OPERATING_SUPPORT', usefulResults: 30, cost: 10 },
      { purpose: 'SELF_IMPROVEMENT', usefulResults: 25, cost: 10 },
      { purpose: 'FORWARD_EXPLORATION', usefulResults: 25, cost: 10 },
    ],
    urgentCommercialGoal: false,
  } as unknown as AllocationInput;

  it('the allocator alone records a reasonless change, which the probe would fail', () => {
    const raw = decideResearchAllocation(input);
    const silent = raw.changes.filter((c) => c.reasons.length === 0);
    expect(silent.length).toBeGreaterThan(0);
    expect(yieldAllocationHolds([{ fingerprint: 'raw', held: false, changes: raw.changes, costCountedOnce: { holds: true } }]).ok).toBe(false);
  });

  it('the recorded decision names the measured reason for every change and passes the probe', () => {
    const fixed = withMeasuredReasons(decideResearchAllocation(input), input);
    expect(fixed.changes.length).toBeGreaterThan(0);
    for (const c of fixed.changes) expect(c.reasons.length).toBeGreaterThan(0);
    const self = fixed.changes.find((c) => c.purpose === 'SELF_IMPROVEMENT');
    expect(self!.reasons[0]).toMatch(/0\.96× the measured average; moved only as the other purposes/);
    expect(yieldAllocationHolds([{ fingerprint: 'fixed', held: false, changes: fixed.changes, costCountedOnce: { holds: true } }]).ok).toBe(true);
  });

  it('leaves a decision whose changes all have reasons untouched', () => {
    const d = { held: false, shares: input.currentShares, changes: [{ purpose: 'BROAD_DISCOVERY', from: 0.2, to: 0.25, reasons: ['x'] }], laneActions: [], capacity: [], notes: [] } as never;
    expect(withMeasuredReasons(d, input)).toBe(d);
  });
});
