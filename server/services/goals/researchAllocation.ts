/**
 * How research capacity is shared between the purposes research serves, and
 * what to change when a lane under-delivers (RES-07, RES-15-5).
 *
 * Brain researches for at least five purposes, and they draw on the same
 * finite compute, model, verification and human-authorization capacity:
 *
 *  1. BROAD_DISCOVERY      — broad economic discovery;
 *  2. TRANSACTION_ROUTES   — turning promising arrangements into transaction routes
 *                            (the urgent commercial goal's deal development);
 *  3. OPERATING_SUPPORT    — optimizing and supporting businesses already operating;
 *  4. SELF_IMPROVEMENT     — capability improvement, provider/worker reliability and
 *                            engineering repair (system health);
 *  5. FORWARD_EXPLORATION  — forward-looking strategic exploration and future goals.
 *
 * This module is the decision, and only the decision: pure, no database, no
 * clock, no queue. Its caller reads the measurements from existing production
 * instrumentation (`researchYield.ts`, the free-lane controller, the fleet
 * rows) and applies the result through the owners that already exist; it is
 * not a scheduler and does not store anything (§10.3, §20.4, invariant 45).
 *
 * The rules:
 *
 *  - Shares move toward marginal useful outcome per unit of cost, impending
 *    deadlines and expected decision value, and away from purposes whose work
 *    cannot be consumed because a measured bottleneck holds it — at most
 *    `MAX_STEP` per purpose per decision, so new evidence moves resources
 *    without whiplash and a later decision can move them back.
 *  - Floors always hold: exploration (BROAD_DISCOVERY + FORWARD_EXPLORATION)
 *    keeps `EXPLORATION_FLOOR`, system health (SELF_IMPROVEMENT) keeps
 *    `SYSTEM_HEALTH_FLOOR`, the urgent commercial goal (TRANSACTION_ROUTES)
 *    keeps `COMMERCIAL_FLOOR` while one is open, and every purpose keeps
 *    `MIN_PURPOSE_SHARE`. No single objective takes everything.
 *  - A purpose with no measurement holds its share, and with no measurement at
 *    all every share holds and the result says so. An unknown is never a
 *    favourable assumption (invariant 39).
 *  - A lane that produces many claims but almost no actionable buyer, price or
 *    fulfilment link is given a change of question design, then of evidence
 *    sources, then of model routing — skipping any already tried — before any
 *    limit is raised for it.
 *  - Capacity is added or repurposed only when qualified jobs are waiting and a
 *    measured machine limit causes the delay, naming the bottleneck and its
 *    incremental cost, and never past the provider's quota headroom, below
 *    real measured reliability, or onto capacity another worker owns.
 *
 * Lanes are free strings the caller names. No category, industry or example
 * is a whitelist here (R01-A1, §18.1).
 */

export const RESEARCH_PURPOSES = [
  'BROAD_DISCOVERY',
  'TRANSACTION_ROUTES',
  'OPERATING_SUPPORT',
  'SELF_IMPROVEMENT',
  'FORWARD_EXPLORATION',
] as const;
export type ResearchPurpose = (typeof RESEARCH_PURPOSES)[number];

/** Exploration purposes; together they keep `EXPLORATION_FLOOR`. */
export const EXPLORATION_PURPOSES: readonly ResearchPurpose[] = ['BROAD_DISCOVERY', 'FORWARD_EXPLORATION'];
/** Combined share exploration never drops below. */
export const EXPLORATION_FLOOR = 0.15;
/** Share system health (SELF_IMPROVEMENT) never drops below. */
export const SYSTEM_HEALTH_FLOOR = 0.1;
/** Share the urgent commercial goal (TRANSACTION_ROUTES) keeps while one is open. */
export const COMMERCIAL_FLOOR = 0.2;
/** Share no purpose drops below, so every one can still produce the evidence that would move it back. */
export const MIN_PURPOSE_SHARE = 0.03;
/** Largest change to one purpose's share in one decision (before floors are restored). */
export const MAX_STEP = 0.1;
/** A change smaller than this is not reported as a change. */
export const CHANGE_EPSILON = 0.005;
/** A deadline within this many days pulls share toward its purpose, more strongly the nearer it is. */
export const DEADLINE_HORIZON_DAYS = 14;
/** Largest multiplier a deadline applies (at zero days). */
export const DEADLINE_WEIGHT = 1;
/** Largest multiplier decision value applies (to the purpose with the highest value). */
export const DECISION_VALUE_WEIGHT = 0.5;
/** Multiplier on a purpose whose added work cannot be consumed because a measured bottleneck holds it. */
export const BOTTLENECK_PENALTY = 0.5;
/** A lane needs at least this many claims in the window before its actionability is judged. */
export const MIN_CLAIMS_FOR_ACTIONABILITY = 20;
/** Actionable links per claim below which a lane is low-actionability. */
export const ACTIONABILITY_FLOOR = 0.1;
/** Remedies for a low-actionability lane, in the order they are tried. */
export const LANE_REMEDIES = ['QUESTION_DESIGN', 'EVIDENCE_SOURCES', 'MODEL_ROUTING'] as const;
export type LaneRemedy = (typeof LANE_REMEDIES)[number];
/** Measured reliability (0–1) below which capacity on a resource is not added. */
export const MIN_RELIABILITY = 0.8;
/** Queue wait of qualified jobs at or above which a delay is a measured constraint. */
export const QUEUE_WAIT_CONSTRAINT_MS = 15 * 60_000;
/** Most capacity units one decision adds to one lane. */
export const MAX_CAPACITY_STEP = 4;

export type BottleneckResource = 'MODEL_RATE_LIMIT' | 'PROVIDER_QUOTA' | 'GPU' | 'WORKER' | 'VERIFICATION' | 'HUMAN_AUTHORIZATION';

/** What one purpose produced in the window. Null is "not measured", never zero. */
export interface PurposeMeasurement {
  purpose: ResearchPurpose;
  /** Useful results attributed to the purpose (accepted openings, positions, offers, paid transactions, repairs landed). */
  usefulResults: number | null;
  /** Resource cost attributed to the purpose, each job's cost counted once (see `attributeJobCosts`). */
  cost: number | null;
  /** Expected decision value of the purpose's next unit of research, any non-negative scale shared by all purposes. */
  decisionValue?: number | null;
  /** Days to the nearest deadline that depends on this purpose's research. */
  nearestDeadlineDays?: number | null;
}

/** One lane's yield in the window. */
export interface LaneMeasurement {
  lane: string;
  purposes: ResearchPurpose[];
  claims: number | null;
  /** Claims that link to an actionable buyer, price or fulfilment. */
  actionableLinks: number | null;
  /** Remedies already applied to this lane and not yet shown to work. */
  triedRemedies?: LaneRemedy[];
}

/** A measured constraint on a lane's throughput. */
export interface BottleneckMeasurement {
  lane: string;
  purposes: ResearchPurpose[];
  resource: BottleneckResource | null;
  /** Qualified, useful jobs waiting on this lane. */
  qualifiedQueued: number | null;
  /** Measured queue wait of those jobs. */
  queueWaitMs: number | null;
  /** Whether the delay is attributed to a measured machine limit (rate-limit, quota, GPU, worker slots). */
  measuredMachineLimit: boolean;
  /** Units of capacity the provider's quota still allows. */
  quotaHeadroom: number | null;
  /** Measured success rate of the resource, 0–1. */
  reliability: number | null;
  /** The capacity that could be added is owned by another worker. */
  ownedByAnotherWorker: boolean;
  /** Incremental cost of one more unit of capacity. */
  incrementalCostPerUnit: number | null;
}

export interface AllocationInput {
  /** The shares in force now; missing purposes read as zero, and the whole is normalized. */
  currentShares: Partial<Record<ResearchPurpose, number>>;
  purposes: PurposeMeasurement[];
  lanes?: LaneMeasurement[];
  bottlenecks?: BottleneckMeasurement[];
  /** An urgent commercial goal is open, so TRANSACTION_ROUTES keeps `COMMERCIAL_FLOOR`. */
  urgentCommercialGoal: boolean;
}

export interface ShareChange {
  purpose: ResearchPurpose;
  from: number;
  to: number;
  reasons: string[];
}

export type LaneAction =
  | { lane: string; kind: 'CHANGE_QUESTION_DESIGN' | 'CHANGE_EVIDENCE_SOURCES' | 'CHANGE_MODEL_ROUTING'; remedy: LaneRemedy; limitRaiseAllowed: false; reason: string }
  | { lane: string; kind: 'REMEDIES_EXHAUSTED'; remedy: null; limitRaiseAllowed: true; reason: string };

export type CapacityDecision =
  | { lane: string; kind: 'ADD_CAPACITY'; resource: BottleneckResource; units: number; incrementalCost: number; reason: string }
  | { lane: string; kind: 'NO_CAPACITY'; resource: BottleneckResource | null; units: 0; incrementalCost: 0; reason: string };

export interface AllocationDecision {
  /** Every share held because nothing was measured. */
  held: boolean;
  shares: Record<ResearchPurpose, number>;
  changes: ShareChange[];
  laneActions: LaneAction[];
  capacity: CapacityDecision[];
  notes: string[];
}

const zeroShares = (): Record<ResearchPurpose, number> =>
  Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, 0])) as Record<ResearchPurpose, number>;

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The shares in force, normalized; equal shares when nothing usable is given. */
export function normalizeShares(current: Partial<Record<ResearchPurpose, number>>): Record<ResearchPurpose, number> {
  const out = zeroShares();
  let total = 0;
  for (const p of RESEARCH_PURPOSES) {
    const v = current[p];
    out[p] = known(v) && v > 0 ? v : 0;
    total += out[p];
  }
  if (total <= 0) {
    for (const p of RESEARCH_PURPOSES) out[p] = 1 / RESEARCH_PURPOSES.length;
    return out;
  }
  for (const p of RESEARCH_PURPOSES) out[p] /= total;
  return out;
}

/** The per-purpose minimum shares for this decision, exploration group floor included. */
function floorsFor(shares: Record<ResearchPurpose, number>, urgentCommercialGoal: boolean): Record<ResearchPurpose, number> {
  const f = zeroShares();
  for (const p of RESEARCH_PURPOSES) f[p] = MIN_PURPOSE_SHARE;
  f.SELF_IMPROVEMENT = Math.max(f.SELF_IMPROVEMENT, SYSTEM_HEALTH_FLOOR);
  if (urgentCommercialGoal) f.TRANSACTION_ROUTES = Math.max(f.TRANSACTION_ROUTES, COMMERCIAL_FLOOR);
  const exploreMin = EXPLORATION_PURPOSES.reduce((s, p) => s + f[p], 0);
  if (exploreMin < EXPLORATION_FLOOR) {
    const extra = EXPLORATION_FLOOR - exploreMin;
    const weight = EXPLORATION_PURPOSES.reduce((s, p) => s + shares[p], 0);
    for (const p of EXPLORATION_PURPOSES) {
      f[p] += weight > 0 ? (extra * shares[p]) / weight : extra / EXPLORATION_PURPOSES.length;
    }
  }
  return f;
}

/**
 * Restore every floor: each purpose gets its floor, and what remains is shared
 * in proportion to how far each was above its own floor. Sums to one, and no
 * purpose ends below its floor whatever the input.
 */
export function enforceFloors(shares: Record<ResearchPurpose, number>, urgentCommercialGoal: boolean): Record<ResearchPurpose, number> {
  const s = normalizeShares(shares);
  const f = floorsFor(s, urgentCommercialGoal);
  // Raise each purpose below its floor, then take the deficit from those above
  // theirs in proportion to how far above they are. Identity when every floor holds.
  const out = zeroShares();
  let over = -1;
  let excessTotal = 0;
  for (const p of RESEARCH_PURPOSES) {
    out[p] = Math.max(s[p], f[p]);
    over += out[p];
    excessTotal += out[p] - f[p];
  }
  if (over > 0 && excessTotal > 0) {
    const take = Math.min(over, excessTotal);
    for (const p of RESEARCH_PURPOSES) out[p] -= (take * (out[p] - f[p])) / excessTotal;
  }
  return out;
}

/** A purpose's marginal useful outcome per unit of cost; null when not measured. */
function marginalYield(m: PurposeMeasurement | undefined): number | null {
  if (!m || !known(m.usefulResults) || !known(m.cost) || m.cost <= 0 || m.usefulResults < 0) return null;
  return m.usefulResults / m.cost;
}

/**
 * The next shares for the five purposes, the lane remedies, and the capacity
 * decisions, each with its reason.
 */
export function decideResearchAllocation(input: AllocationInput): AllocationDecision {
  const current = normalizeShares(input.currentShares);
  const byPurpose = new Map(input.purposes.map((m) => [m.purpose, m]));
  const notes: string[] = [];
  const reasons = new Map<ResearchPurpose, string[]>(RESEARCH_PURPOSES.map((p) => [p, []]));

  const capacity = decideCapacity(input.bottlenecks ?? [], input.lanes ?? []);
  const laneActions = decideLaneActions(input.lanes ?? []);

  const yields = new Map<ResearchPurpose, number>();
  for (const p of RESEARCH_PURPOSES) {
    const y = marginalYield(byPurpose.get(p));
    if (y !== null) yields.set(p, y);
  }
  const deadlines = RESEARCH_PURPOSES.filter((p) => known(byPurpose.get(p)?.nearestDeadlineDays));
  const values = RESEARCH_PURPOSES.filter((p) => known(byPurpose.get(p)?.decisionValue));

  if (yields.size === 0 && deadlines.length === 0 && values.length === 0) {
    const shares = enforceFloors(current, input.urgentCommercialGoal);
    notes.push('No purpose has a measured yield, deadline or decision value in this window, so every share holds; an unmeasured purpose is never assumed to be doing well.');
    const changes = diff(current, shares, new Map(RESEARCH_PURPOSES.map((p) => [p, ['restored to its floor']])));
    return { held: true, shares, changes, laneActions, capacity, notes };
  }

  // Score each purpose; an unmeasured component is neutral (1), never a boost.
  const meanYield = yields.size > 0 ? [...yields.values()].reduce((s, v) => s + v, 0) / yields.size : 0;
  const maxValue = Math.max(0, ...values.map((p) => byPurpose.get(p)!.decisionValue as number));
  const blocked = bottleneckedPurposes(input.bottlenecks ?? [], capacity);
  const score = new Map<ResearchPurpose, number>();
  for (const p of RESEARCH_PURPOSES) {
    const m = byPurpose.get(p);
    let s = 1;
    const y = yields.get(p);
    if (y !== undefined && meanYield > 0) {
      const rel = y / meanYield;
      s *= rel;
      if (rel > 1.05) reasons.get(p)!.push(`useful results per unit cost ${rel.toFixed(2)}× the measured average`);
      else if (rel < 0.95) reasons.get(p)!.push(`useful results per unit cost ${rel.toFixed(2)}× the measured average`);
    } else if (y !== undefined && meanYield === 0) {
      reasons.get(p)!.push('no measured purpose produced a useful result this window');
    } else {
      reasons.get(p)!.push('yield not measured this window, so its share is not raised for yield');
    }
    const d = m?.nearestDeadlineDays;
    if (known(d) && d <= DEADLINE_HORIZON_DAYS) {
      const pull = 1 + (DEADLINE_WEIGHT * (DEADLINE_HORIZON_DAYS - Math.max(0, d))) / DEADLINE_HORIZON_DAYS;
      s *= pull;
      reasons.get(p)!.push(`a deadline in ${Math.max(0, Math.round(d))} day(s)`);
    }
    const v = m?.decisionValue;
    if (known(v) && maxValue > 0 && v > 0) {
      s *= 1 + (DECISION_VALUE_WEIGHT * v) / maxValue;
      reasons.get(p)!.push(`expected decision value ${(v / maxValue).toFixed(2)} of the highest`);
    }
    const why = blocked.get(p);
    if (why) {
      s *= BOTTLENECK_PENALTY;
      reasons.get(p)!.push(why);
    }
    score.set(p, Math.max(0, s));
  }

  // Desired share ∝ current share × score, renormalized, then stepped and floored.
  let weighted = 0;
  for (const p of RESEARCH_PURPOSES) weighted += current[p] * score.get(p)!;
  const desired = zeroShares();
  let largest = 0;
  for (const p of RESEARCH_PURPOSES) {
    desired[p] = weighted > 0 ? (current[p] * score.get(p)!) / weighted : current[p];
    largest = Math.max(largest, Math.abs(desired[p] - current[p]));
  }
  // Scale the whole move so no purpose moves more than MAX_STEP; the result still sums to one.
  const t = largest > MAX_STEP ? MAX_STEP / largest : 1;
  const stepped = zeroShares();
  for (const p of RESEARCH_PURPOSES) stepped[p] = current[p] + t * (desired[p] - current[p]);
  const shares = enforceFloors(stepped, input.urgentCommercialGoal);
  const f = floorsFor(stepped, input.urgentCommercialGoal);
  for (const p of RESEARCH_PURPOSES) {
    if (Math.abs(shares[p] - f[p]) < 1e-9) reasons.get(p)!.push('held at its protected floor');
  }
  if (input.urgentCommercialGoal) notes.push(`The urgent commercial goal keeps at least ${pct(COMMERCIAL_FLOOR)} for transaction routes.`);
  notes.push(`Exploration keeps at least ${pct(EXPLORATION_FLOOR)} and system health at least ${pct(SYSTEM_HEALTH_FLOOR)}.`);
  return { held: false, shares, changes: diff(current, shares, reasons), laneActions, capacity, notes };
}

function diff(from: Record<ResearchPurpose, number>, to: Record<ResearchPurpose, number>, reasons: Map<ResearchPurpose, string[]>): ShareChange[] {
  const out: ShareChange[] = [];
  for (const p of RESEARCH_PURPOSES) {
    if (Math.abs(to[p] - from[p]) >= CHANGE_EPSILON) {
      out.push({ purpose: p, from: from[p], to: to[p], reasons: reasons.get(p) ?? [] });
    }
  }
  return out;
}

/** Purposes whose extra work a bottleneck would hold, where no capacity can be added for it. */
function bottleneckedPurposes(bottlenecks: BottleneckMeasurement[], capacity: CapacityDecision[]): Map<ResearchPurpose, string> {
  const out = new Map<ResearchPurpose, string>();
  for (const b of bottlenecks) {
    if (!isMeasuredConstraint(b)) continue;
    const added = capacity.some((c) => c.lane === b.lane && c.kind === 'ADD_CAPACITY');
    if (added) continue;
    for (const p of b.purposes) {
      if (!out.has(p)) out.set(p, `lane ${b.lane} is held by a measured ${b.resource ?? 'machine'} limit no capacity can be added for, so more share would wait in the queue`);
    }
  }
  return out;
}

function isMeasuredConstraint(b: BottleneckMeasurement): boolean {
  return b.measuredMachineLimit && b.resource !== null && known(b.qualifiedQueued) && b.qualifiedQueued > 0 && known(b.queueWaitMs) && b.queueWaitMs >= QUEUE_WAIT_CONSTRAINT_MS;
}

/** Whether a lane yields many claims but few actionable links. */
export function isLowActionability(lane: LaneMeasurement): boolean {
  return known(lane.claims) && known(lane.actionableLinks) && lane.claims >= MIN_CLAIMS_FOR_ACTIONABILITY && lane.actionableLinks / lane.claims < ACTIONABILITY_FLOOR;
}

const REMEDY_KIND: Record<LaneRemedy, 'CHANGE_QUESTION_DESIGN' | 'CHANGE_EVIDENCE_SOURCES' | 'CHANGE_MODEL_ROUTING'> = {
  QUESTION_DESIGN: 'CHANGE_QUESTION_DESIGN',
  EVIDENCE_SOURCES: 'CHANGE_EVIDENCE_SOURCES',
  MODEL_ROUTING: 'CHANGE_MODEL_ROUTING',
};

/** For each low-actionability lane, the next remedy not yet tried — before any limit raise. */
export function decideLaneActions(lanes: LaneMeasurement[]): LaneAction[] {
  const out: LaneAction[] = [];
  for (const lane of lanes) {
    if (!isLowActionability(lane)) continue;
    const tried = new Set(lane.triedRemedies ?? []);
    const next = LANE_REMEDIES.find((r) => !tried.has(r));
    const evidence = `${lane.actionableLinks} actionable buyer/price/fulfilment link(s) from ${lane.claims} claims`;
    if (next) {
      out.push({ lane: lane.lane, kind: REMEDY_KIND[next], remedy: next, limitRaiseAllowed: false, reason: `${evidence}; change ${next.toLowerCase().replace('_', ' ')} before raising this lane's job limit` });
    } else {
      out.push({ lane: lane.lane, kind: 'REMEDIES_EXHAUSTED', remedy: null, limitRaiseAllowed: true, reason: `${evidence} after question design, evidence sources and model routing were all changed; a limit raise may now be justified only by a measured bottleneck` });
    }
  }
  return out;
}

/** Capacity to add or repurpose, only for a measured constraint with qualified work waiting. */
export function decideCapacity(bottlenecks: BottleneckMeasurement[], lanes: LaneMeasurement[] = []): CapacityDecision[] {
  const out: CapacityDecision[] = [];
  const pendingRemedy = new Set(decideLaneActions(lanes).filter((a) => !a.limitRaiseAllowed).map((a) => a.lane));
  for (const b of bottlenecks) {
    const no = (reason: string): CapacityDecision => ({ lane: b.lane, kind: 'NO_CAPACITY', resource: b.resource, units: 0, incrementalCost: 0, reason });
    if (!known(b.qualifiedQueued) || b.qualifiedQueued <= 0) { out.push(no('no qualified useful job is measured waiting')); continue; }
    if (!b.measuredMachineLimit || b.resource === null) { out.push(no('the delay is not attributed to a measured machine limit')); continue; }
    if (!known(b.queueWaitMs) || b.queueWaitMs < QUEUE_WAIT_CONSTRAINT_MS) { out.push(no('queue wait is not measured above the constraint threshold')); continue; }
    if (pendingRemedy.has(b.lane)) { out.push(no('the lane yields few actionable links; its question design, sources or routing change comes before more capacity')); continue; }
    if (b.ownedByAnotherWorker) { out.push(no(`the ${b.resource} capacity belongs to another worker`)); continue; }
    if (!known(b.reliability)) { out.push(no(`the ${b.resource}'s reliability is not measured`)); continue; }
    if (b.reliability < MIN_RELIABILITY) { out.push(no(`the ${b.resource}'s measured reliability ${pct(b.reliability)} is below ${pct(MIN_RELIABILITY)}`)); continue; }
    if (!known(b.quotaHeadroom) || b.quotaHeadroom < 1) { out.push(no(`the ${b.resource} has no measured quota headroom`)); continue; }
    if (!known(b.incrementalCostPerUnit) || b.incrementalCostPerUnit < 0) { out.push(no(`the incremental cost of more ${b.resource} capacity is not measured`)); continue; }
    const units = Math.max(1, Math.min(MAX_CAPACITY_STEP, Math.floor(b.quotaHeadroom), Math.ceil(b.qualifiedQueued)));
    const cost = units * b.incrementalCostPerUnit;
    out.push({
      lane: b.lane,
      kind: 'ADD_CAPACITY',
      resource: b.resource,
      units,
      incrementalCost: cost,
      reason: `${b.qualifiedQueued} qualified job(s) waited ${Math.round(b.queueWaitMs / 60_000)} min on a measured ${b.resource} limit; add ${units} unit(s) within quota headroom ${b.quotaHeadroom} at incremental cost ${cost}`,
    });
  }
  return out;
}

/** One research job as instrumentation records it. */
export interface ResearchJobRecord {
  id: string;
  lane: string;
  /** Every purpose the job contributes to; at least one. */
  purposes: ResearchPurpose[];
  /** The job's actual resource cost. */
  cost: number;
  submittedAt: string;
  completedAt?: string | null;
  acceptedClaims?: number;
  actionableLinks?: number;
  usefulResults?: number;
}

export interface CostAttribution {
  /** Each job's cost, counted once. */
  totalCost: number;
  /** Per purpose: the share of each job's cost attributed to it. Sums to `totalCost`. */
  byPurpose: Record<ResearchPurpose, number>;
  /** Per purpose: jobs that contributed to it (a job counts toward every purpose it served). */
  jobsByPurpose: Record<ResearchPurpose, number>;
}

/**
 * Attribute resource cost to purposes. A job may contribute to several, but
 * its cost is split between them, so the purposes sum to the jobs' actual cost.
 */
export function attributeJobCosts(jobs: ResearchJobRecord[]): CostAttribution {
  const byPurpose = zeroShares();
  const jobsByPurpose = zeroShares();
  const seen = new Set<string>();
  let totalCost = 0;
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const cost = known(job.cost) && job.cost > 0 ? job.cost : 0;
    const purposes = [...new Set(job.purposes)].filter((p) => (RESEARCH_PURPOSES as readonly string[]).includes(p));
    if (purposes.length === 0) continue;
    totalCost += cost;
    for (const p of purposes) {
      byPurpose[p] += cost / purposes.length;
      jobsByPurpose[p] += 1;
    }
  }
  return { totalCost, byPurpose, jobsByPurpose };
}

export interface LaneWindowYield {
  lane: string;
  submissions: number;
  completions: number;
  acceptedClaims: number;
  actionableLinks: number;
  usefulResults: number;
  cost: number;
  /** Null when nothing useful was produced: there is no cost per useful result to state. */
  costPerUsefulResult: number | null;
}

/**
 * Per-lane yield over one window [from, to), each job counted once. Jobs
 * submitted outside the window are not in it, so successive windows are
 * consistent and comparable.
 */
export function laneYieldForWindow(jobs: ResearchJobRecord[], window: { from: string; to: string }): LaneWindowYield[] {
  const lanes = new Map<string, LaneWindowYield>();
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    if (!(job.submittedAt >= window.from && job.submittedAt < window.to)) continue;
    seen.add(job.id);
    const row = lanes.get(job.lane) ?? { lane: job.lane, submissions: 0, completions: 0, acceptedClaims: 0, actionableLinks: 0, usefulResults: 0, cost: 0, costPerUsefulResult: null };
    row.submissions += 1;
    if (job.completedAt) row.completions += 1;
    row.acceptedClaims += job.acceptedClaims ?? 0;
    row.actionableLinks += job.actionableLinks ?? 0;
    row.usefulResults += job.usefulResults ?? 0;
    row.cost += known(job.cost) && job.cost > 0 ? job.cost : 0;
    lanes.set(job.lane, row);
  }
  for (const row of lanes.values()) row.costPerUsefulResult = row.usefulResults > 0 ? row.cost / row.usefulResults : null;
  return [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
}

/* ------------------------------------------------------------------------- */
/* Applying the decision to the work (RES-07)                                  */
/* ------------------------------------------------------------------------- */

/**
 * A decided share moves capacity only through the lever the dispatcher and
 * the assigner already read: a live bin's priority (`ORDER BY priority DESC`).
 * The goals tick is its one writer, so the decision is applied there, every
 * pass, from the newest recorded `GOAL_RESEARCH_REALLOCATED` decision.
 *
 * A purpose whose decided share is at least `SHARE_GAP_FOR_SHIFT` above the
 * share it actually received in the window is under-served and its bins go one
 * step up; one that far above its decided share goes one step down. A purpose
 * below a protected floor — exploration, system health, the urgent commercial
 * goal — always goes up, whatever the gap says, so the floors bind the work and
 * not only the record. A held decision (nothing measured) moves nothing.
 */
export const SHARE_GAP_FOR_SHIFT = 0.05;
export type PriorityShift = -1 | 0 | 1;

export interface SharesInForce {
  /** The decided shares. */
  shares: Record<ResearchPurpose, number>;
  /** The shares the window actually gave each purpose (its job time), normalized. */
  observed: Record<ResearchPurpose, number>;
  held: boolean;
  urgentCommercialGoal: boolean;
}

/** Which purposes sit below a protected floor in what they actually received. Pure. */
export function purposesBelowFloor(f: SharesInForce): ResearchPurpose[] {
  if (f.held) return [];
  const out: ResearchPurpose[] = [];
  if (EXPLORATION_PURPOSES.reduce((s, p) => s + f.observed[p], 0) < EXPLORATION_FLOOR - 1e-9) out.push(...EXPLORATION_PURPOSES);
  if (f.observed.SELF_IMPROVEMENT < SYSTEM_HEALTH_FLOOR - 1e-9) out.push('SELF_IMPROVEMENT');
  if (f.urgentCommercialGoal && f.observed.TRANSACTION_ROUTES < COMMERCIAL_FLOOR - 1e-9) out.push('TRANSACTION_ROUTES');
  return out;
}

/** The priority step each purpose's bins take under the decision in force. Pure. */
export function purposePriorityShifts(f: SharesInForce): Record<ResearchPurpose, PriorityShift> {
  const out = Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, 0])) as Record<ResearchPurpose, PriorityShift>;
  if (f.held) return out;
  for (const p of RESEARCH_PURPOSES) {
    const gap = f.shares[p] - f.observed[p];
    if (gap >= SHARE_GAP_FOR_SHIFT) out[p] = 1;
    else if (gap <= -SHARE_GAP_FOR_SHIFT) out[p] = -1;
  }
  for (const p of purposesBelowFloor(f)) out[p] = 1;
  return out;
}

/**
 * One bin's step: the largest among the purposes it serves, so a bin that also
 * serves an under-served purpose is never pushed down for the other. A bin no
 * row attributes takes no step. Pure.
 */
export function binPriorityShift(purposes: readonly string[], shifts: Record<ResearchPurpose, PriorityShift>): PriorityShift {
  const known = purposes.filter((p): p is ResearchPurpose => (RESEARCH_PURPOSES as readonly string[]).includes(p));
  if (known.length === 0) return 0;
  return Math.max(...known.map((p) => shifts[p])) as PriorityShift;
}
