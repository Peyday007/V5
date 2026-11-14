/**
 * What research capacity measures right now, for the allocation decision's
 * capacity verdicts (RES-15-5: "if the queue contains qualified useful jobs and
 * measured machine limits cause delay, add/repurpose capacity as justified by
 * the bottleneck and incremental cost").
 *
 * The yield window only says what jobs that already ran did. Whether capacity is
 * the constraint is a question about jobs that have NOT started: how many
 * qualified jobs are claimable and waiting now, how long they have waited, and
 * whether every slot that could take them is busy. Those are read from the owner
 * of the slots — the free-lane controller (§86) — and from the queue rows; this
 * module adds no scheduler and changes nothing. Anything it cannot measure is
 * null, never assumed (invariant 39).
 */
import { getDb } from '../../db/database.ts';
import type { BottleneckResource } from './researchAllocation.ts';
import { modelOfReason } from './researchYield.ts';

/** One lane's capacity as measured at one moment. */
export interface LaneCapacityMeasurement {
  lane: string;
  resource: BottleneckResource;
  /** Qualified, claimable jobs waiting now that this lane could take (its share of a shared queue). */
  qualifiedQueued: number;
  /** Median time those waiting jobs have waited since they became claimable; null when none is waiting. */
  queueWaitMs: number | null;
  /** Every slot that could take a waiting job was busy at the controller's last step. */
  saturated: boolean;
  /** Slots the controller may still add before its ceiling or its database share. */
  quotaHeadroom: number | null;
  /** Money one more slot costs; null when not established. */
  incrementalCostPerUnit: number | null;
  /** Share of the lane's recent calls that succeeded, 0–1; null when it made none. */
  reliability: number | null;
  ownedByAnotherWorker: boolean;
  basis: string;
}

/** The controller's last step, in the shape this reader needs. */
export interface ControlSnapshot {
  models: { model: string; target: number; busy: number; window: { ok: number; content: number; transient: number } }[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Per free-lane model: its lane, the shared queue's share and wait, whether the
 * lane is saturated and how much headroom its controller has. Pure.
 *
 * The free lane's slots take any model's work when their own is empty
 * (spillover), so the queue is waiting on slot capacity only when every model's
 * slots are busy; one idle slot anywhere means the delay is not a machine limit.
 * One more slot is another concurrent call on a free model, or on a GPU pod that
 * is billed by the hour whatever its concurrency, so its incremental money cost
 * is zero — up to the controller's own ceiling, which is the headroom.
 */
export function freeLaneCapacity(input: {
  control: ControlSnapshot | null;
  waiting: number;
  waitsMs: number[];
  ceilingOf: (model: string) => number;
  isGpu: (model: string) => boolean;
  dbShare: number | null;
}): LaneCapacityMeasurement[] {
  const models = input.control?.models ?? [];
  if (models.length === 0) return [];
  const saturated = models.every((m) => m.target >= 1 && m.busy >= m.target);
  const queuedShare = input.waiting > 0 ? Math.ceil(input.waiting / models.length) : 0;
  const wait = median(input.waitsMs);
  return models.map((m) => {
    const ceiling = Math.min(input.ceilingOf(m.model), input.dbShare ?? Number.POSITIVE_INFINITY);
    const samples = m.window.ok + m.window.content + m.window.transient;
    return {
      lane: `free-lane:${modelOfReason(`model ${m.model}`)}`,
      resource: input.isGpu(m.model) ? 'GPU' : 'WORKER',
      qualifiedQueued: queuedShare,
      queueWaitMs: input.waiting > 0 ? wait : null,
      saturated,
      quotaHeadroom: Math.max(0, Math.floor(ceiling - m.target)),
      incrementalCostPerUnit: 0,
      reliability: samples > 0 ? m.window.ok / samples : null,
      ownedByAnotherWorker: false,
      basis: `${m.busy} of ${m.target} slot(s) busy; ${input.waiting} qualified job(s) claimable; controller ceiling ${Number.isFinite(ceiling) ? ceiling : 'none'}`,
    };
  });
}

/** How long each claimable commercial free-lane job has waited since it became claimable. */
export async function claimableResearchWaits(nowMs: number): Promise<number[]> {
  const now = new Date(nowMs).toISOString();
  const rows = await getDb().all<{ available_at: string | null; created_at: string | null }>(
    `SELECT w.available_at, w.created_at FROM work_items w
      WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.attempt_count < w.max_attempts
        AND w.work_type IN ('RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT')
        AND EXISTS (SELECT 1 FROM bins b
                     WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
                       AND b.purpose IN ('PLAY_RESEARCH', 'GRUNT'))`,
    [now],
  );
  const out: number[] = [];
  for (const r of rows) {
    const from = Date.parse(r.available_at ?? r.created_at ?? '');
    if (Number.isFinite(from)) out.push(Math.max(0, nowMs - from));
  }
  return out;
}

/** The production reading: the free-lane controller's last step and the queue rows. Reads only. */
export async function measuredLaneCapacity(nowMs = Date.now()): Promise<LaneCapacityMeasurement[]> {
  const lane = await import('../freeLane/capacity.ts');
  const { isRunpodSlot } = await import('../cheap/runpod.ts');
  const control = lane.lastControlReading();
  if (!control || control.models.length === 0) return [];
  const [waiting, waitsMs] = await Promise.all([lane.waitingNow(), claimableResearchWaits(nowMs)]);
  return freeLaneCapacity({
    control,
    waiting,
    waitsMs,
    ceilingOf: (model) => (isRunpodSlot(model) ? lane.gpuCeiling() : lane.SAFETY_CEILING),
    isGpu: isRunpodSlot,
    dbShare: lane.slotShare(control.models.length),
  });
}
