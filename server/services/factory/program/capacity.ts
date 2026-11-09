/**
 * What the Factory can actually do in an hour, read from rows over a window.
 *
 * `throughput.ts` answers this for one campaign; a program needs it across every
 * campaign at once, because the question a large specification raises is not
 * "how fast was that campaign" but "where does the Factory's time go, and would
 * more workers, better scheduling, other models or a bigger server change it".
 * Every figure says what it was measured from, and a figure nothing measured is
 * null rather than zero (§2 of FACTORY.md).
 *
 * The recommendation is derived from the same numbers and names the bottleneck:
 * idle capacity beside ready work is a scheduling defect to fix first; queue
 * time with every usable surface busy is a worker shortage; refusals by the
 * provider are a rate limit no server buys away. Brain's own server is not on
 * the critical path of a hosted campaign — the work runs in remote sessions — so
 * a larger server is never recommended without a measured server-side delay.
 */
import { getDb } from '../../../db/database.ts';

export interface BinTimeline {
  binId: string;
  kind: string;
  campaignId: string | null;
  readyAt: string | null;
  assignedAt: string[];
  terminalAt: string | null;
  terminalOutcome: string | null;
  leaseExpiries: number;
  noShows: number;
}

export interface Stat {
  samples: number;
  averageMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
}

export interface CapacityReading {
  window: { since: string; until: string; hours: number };
  workers: { registered: number | null; usable: number | null; inFlightNow: number | null; admissionLimit: number | null; basis: string };
  concurrency: { peak: number; average: number | null; basis: string };
  queueDelay: Stat;
  stageDurations: Record<string, Stat>;
  planningMs: Stat;
  codingMs: Stat;
  integrationAndReviewMs: Stat;
  repairMs: Stat;
  releaseMs: Stat;
  completed: { bins: number; campaigns: number; unitsIntegrated: number; perHour: number | null; campaignsPerHour: number | null };
  requirements: { verified: number; perHour: number | null };
  idle: { readyBinsNow: number | null; idleEvents: number; idleMs: number | null; basis: string };
  failures: { binsFailed: number; leaseExpiries: number; noShows: number; dedupedSubmissions: number; supersededUnits: number; releaseFailures: number };
  bottleneck: 'SCHEDULING' | 'WORKERS' | 'PROVIDER_LIMITS' | 'RELEASE' | 'WORK_ITSELF' | 'NO_DATA';
  recommendation: string[];
}

function stat(values: number[]): Stat {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return { samples: 0, averageMs: null, medianMs: null, maxMs: null };
  const sum = clean.reduce((a, b) => a + b, 0);
  return {
    samples: clean.length,
    averageMs: Math.round(sum / clean.length),
    medianMs: clean[Math.floor(clean.length / 2)]!,
    maxMs: clean[clean.length - 1]!,
  };
}

const ms = (a: string | null | undefined, b: string | null | undefined): number | null =>
  a && b ? Date.parse(b) - Date.parse(a) : null;

/** Peak and time-averaged overlap of [start, end) intervals inside a window. */
export function overlap(intervals: Array<[number, number]>, windowMs: number): { peak: number; average: number | null } {
  const points: Array<[number, number]> = [];
  let busy = 0;
  for (const [start, end] of intervals) {
    if (!(end > start)) continue;
    points.push([start, 1], [end, -1]);
    busy += end - start;
  }
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of points) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return { peak, average: windowMs > 0 ? Math.round((busy / windowMs) * 100) / 100 : null };
}

export interface CapacityInput {
  since: string;
  until: string;
  bins: BinTimeline[];
  repairUnits: Array<{ createdAt: string; integratedAt: string | null }>;
  releaseRuns: Array<{ createdAt: string; finishedAt: string | null; state: string }>;
  campaignsCompleted: number;
  unitsIntegrated: number;
  requirementsVerified: number;
  dedupedSubmissions: number;
  supersededUnits: number;
  idleEvents: Array<{ kind: string; at: string }>;
  fleet: { registered: number; usable: number; inFlight: number; admissionLimit: number } | null;
  readyBinsNow: number | null;
}

export function computeCapacity(input: CapacityInput): CapacityReading {
  const windowMs = Date.parse(input.until) - Date.parse(input.since);
  const hours = Math.max(windowMs / 3_600_000, 1 / 60);
  const work = (bin: BinTimeline): number | null => ms(bin.assignedAt.at(-1), bin.terminalAt);
  const byKind = new Map<string, number[]>();
  for (const bin of input.bins) {
    const w = work(bin);
    if (w !== null && bin.terminalOutcome === 'COMPLETE') byKind.set(bin.kind, [...(byKind.get(bin.kind) ?? []), w]);
  }
  const stageDurations = Object.fromEntries([...byKind].map(([k, v]) => [k, stat(v)]));
  const intervals: Array<[number, number]> = input.bins
    .filter((b) => b.assignedAt.length > 0)
    .map((b) => [Date.parse(b.assignedAt[0]!), Date.parse(b.terminalAt ?? input.until)]);
  const concurrency = overlap(intervals, windowMs);
  const queue = stat(input.bins.map((b) => ms(b.readyAt, b.assignedAt[0])).filter((v): v is number => v !== null));
  const completedBins = input.bins.filter((b) => b.terminalOutcome === 'COMPLETE').length;
  const failedBins = input.bins.filter((b) => b.terminalOutcome && b.terminalOutcome !== 'COMPLETE').length;

  let idleMs = 0;
  let openedAt: number | null = null;
  for (const event of [...input.idleEvents].sort((a, b) => a.at.localeCompare(b.at))) {
    if (event.kind === 'FACTORY_IDLE_STARTED') openedAt = Date.parse(event.at);
    if (event.kind === 'FACTORY_IDLE_ENDED' && openedAt !== null) {
      idleMs += Date.parse(event.at) - openedAt;
      openedAt = null;
    }
  }
  if (openedAt !== null) idleMs += Date.parse(input.until) - openedAt;

  const noShows = input.bins.reduce((n, b) => n + b.noShows, 0);
  const leaseExpiries = input.bins.reduce((n, b) => n + b.leaseExpiries, 0);
  const releases = input.releaseRuns.filter((r) => r.state === 'LIVE');
  const reading: CapacityReading = {
    window: { since: input.since, until: input.until, hours: Math.round(hours * 100) / 100 },
    workers: input.fleet
      ? { registered: input.fleet.registered, usable: input.fleet.usable, inFlightNow: input.fleet.inFlight, admissionLimit: input.fleet.admissionLimit, basis: 'fleet snapshot (routines that may take factory work) and the line’s admission policy, now' }
      : { registered: null, usable: null, inFlightNow: null, admissionLimit: null, basis: 'no fleet snapshot was available' },
    concurrency: { ...concurrency, basis: 'factory bins overlapping between first assignment and terminal, in the window' },
    queueDelay: queue,
    stageDurations,
    planningMs: stat(byKind.get('FACTORY_PLAN') ?? []),
    codingMs: stat(byKind.get('FACTORY_UNITS') ?? []),
    integrationAndReviewMs: stat([...(byKind.get('FACTORY_INTEGRATE') ?? []), ...(byKind.get('FACTORY_REVIEW') ?? [])]),
    repairMs: stat(input.repairUnits.map((u) => ms(u.createdAt, u.integratedAt)).filter((v): v is number => v !== null)),
    releaseMs: stat(releases.map((r) => ms(r.createdAt, r.finishedAt)).filter((v): v is number => v !== null)),
    completed: {
      bins: completedBins,
      campaigns: input.campaignsCompleted,
      unitsIntegrated: input.unitsIntegrated,
      perHour: Math.round((input.unitsIntegrated / hours) * 100) / 100,
      campaignsPerHour: Math.round((input.campaignsCompleted / hours) * 100) / 100,
    },
    requirements: { verified: input.requirementsVerified, perHour: Math.round((input.requirementsVerified / hours) * 100) / 100 },
    idle: { readyBinsNow: input.readyBinsNow, idleEvents: input.idleEvents.length, idleMs, basis: 'FACTORY_IDLE_STARTED/ENDED on the ledger: executable work, free capacity and nothing running' },
    failures: {
      binsFailed: failedBins,
      leaseExpiries,
      noShows,
      dedupedSubmissions: input.dedupedSubmissions,
      supersededUnits: input.supersededUnits,
      releaseFailures: input.releaseRuns.filter((r) => r.state === 'FAILED' || r.state === 'ROLLED_BACK').length,
    },
    bottleneck: 'NO_DATA',
    recommendation: [],
  };
  return { ...reading, ...recommend(reading, windowMs) };
}

function recommend(r: CapacityReading, windowMs: number): Pick<CapacityReading, 'bottleneck' | 'recommendation'> {
  const out: string[] = [];
  if (r.completed.bins === 0 && r.queueDelay.samples === 0) {
    return { bottleneck: 'NO_DATA', recommendation: ['No factory work ran in this window; nothing to diagnose. Widen the window.'] };
  }
  const idleShare = windowMs > 0 && r.idle.idleMs !== null ? r.idle.idleMs / windowMs : 0;
  const workMedian = r.codingMs.medianMs ?? r.planningMs.medianMs ?? null;
  const queueMedian = r.queueDelay.medianMs;
  const saturated = r.workers.usable !== null && r.workers.usable > 0 && r.concurrency.peak >= r.workers.usable;
  const providerShare = (r.failures.noShows + r.failures.leaseExpiries) / Math.max(1, r.completed.bins + r.failures.binsFailed);
  let bottleneck: CapacityReading['bottleneck'] = 'WORK_ITSELF';
  if (idleShare > 0.1) {
    bottleneck = 'SCHEDULING';
    out.push(`Idle capacity beside ready work for ${Math.round(idleShare * 100)}% of the window: a scheduling defect. Fix dispatch before adding workers or compute.`);
  } else if (providerShare > 0.25) {
    bottleneck = 'PROVIDER_LIMITS';
    out.push(`${Math.round(providerShare * 100)}% of factory stages hit a no-show or an expired lease: sessions did not arrive or did not finish. More workers on the same provider account add more refusals; spreading work across accounts or models would.`);
  } else if (queueMedian !== null && workMedian !== null && queueMedian > workMedian && saturated) {
    bottleneck = 'WORKERS';
    out.push(`Median queue ${Math.round(queueMedian / 60_000)} min exceeds median coding ${Math.round(workMedian / 60_000)} min with every usable surface busy at peak: additional workers would raise throughput roughly in proportion until the admission limit (${r.workers.admissionLimit ?? '?'}).`);
  } else if (r.releaseMs.medianMs !== null && workMedian !== null && r.releaseMs.medianMs > 4 * (workMedian + (r.integrationAndReviewMs.medianMs ?? 0) + (r.planningMs.medianMs ?? 0))) {
    // Release (merge → deploy → verify) is serial per objective and dwarfs building it.
    bottleneck = 'RELEASE';
    out.push(`A release takes a median ${Math.round(r.releaseMs.medianMs / 60_000)} min against ${Math.round((workMedian + (r.integrationAndReviewMs.medianMs ?? 0) + (r.planningMs.medianMs ?? 0)) / 60_000)} min to plan, code, integrate and review: the deploy pipeline, not workers or compute, bounds objectives per hour. Batching several campaigns' merges into one deploy, or a faster deploy test job, raises throughput; more workers would not.`);
  } else {
    out.push('Time is spent doing the work itself, not waiting for a worker or a slot: more workers or a bigger server would not materially raise throughput. Larger gains come from smaller campaigns (more parallel units) and faster review/repair cycles.');
  }
  if (r.workers.registered !== null && r.workers.usable !== null && r.workers.usable < r.workers.registered) {
    out.push(`Only ${r.workers.usable} of ${r.workers.registered} registered factory surfaces are usable now; restoring the others costs nothing and raises the concurrency ceiling (peak observed ${r.concurrency.peak}).`);
  }
  out.push('Brain’s server runs ticks and reads, not the work; no server-side delay is on a stage’s critical path in these rows, so a larger server is not indicated.');
  if (r.failures.dedupedSubmissions > 0) out.push(`${r.failures.dedupedSubmissions} duplicate submission(s) were absorbed by the submission key — no duplicate campaign ran.`);
  return { bottleneck, recommendation: out };
}

/** Read the window's rows. */
export async function readCapacity(input: { sinceHours: number; now?: Date }): Promise<CapacityReading> {
  const until = (input.now ?? new Date()).toISOString();
  const since = new Date(Date.parse(until) - input.sinceHours * 3_600_000).toISOString();
  const db = getDb();
  const bins = await db.all<{ id: string; kind: string; factory_campaign_id: string | null }>(
    `SELECT id, kind, factory_campaign_id FROM bins WHERE kind LIKE 'FACTORY_%' AND created_at >= ? ORDER BY created_at`,
    [since],
  );
  const events = bins.length
    ? await db.all<{ bin_id: string; event_type: string; at: string; outcome: string | null }>(
        `SELECT e.bin_id, e.event_type, e.at, e.outcome FROM bin_events e
           JOIN bins b ON b.id = e.bin_id
          WHERE b.kind LIKE 'FACTORY_%' AND b.created_at >= ?
          ORDER BY e.at`,
        [since],
      )
    : [];
  const timelines = new Map<string, BinTimeline>(
    bins.map((b) => [b.id, { binId: b.id, kind: b.kind, campaignId: b.factory_campaign_id, readyAt: null, assignedAt: [], terminalAt: null, terminalOutcome: null, leaseExpiries: 0, noShows: 0 }]),
  );
  for (const e of events) {
    const t = timelines.get(e.bin_id);
    if (!t) continue;
    if (e.event_type === 'BIN_READY' && !t.readyAt) t.readyAt = e.at;
    if (e.event_type === 'BIN_ASSIGNED' || e.event_type === 'BIN_TAKEOVER') t.assignedAt.push(e.at);
    if (e.event_type === 'BIN_TERMINAL') {
      t.terminalAt = e.at;
      t.terminalOutcome = e.outcome;
    }
    if (e.event_type === 'BIN_LEASE_EXPIRED') t.leaseExpiries += 1;
    if (e.event_type.endsWith('NO_SHOW')) t.noShows += 1;
  }
  const count = async (sql: string, params: unknown[]): Promise<number> =>
    Number((await db.get<{ n: number }>(sql, params as never))?.n ?? 0);
  const repairUnits = await db.all<{ created_at: string; updated_at: string; state: string }>(
    `SELECT created_at, updated_at, state FROM factory_work_units WHERE kind = 'REPAIR' AND created_at >= ?`,
    [since],
  );
  const releaseRuns = await db.all<{ created_at: string; finished_at: string | null; state: string }>(
    `SELECT created_at, finished_at, state FROM factory_release_runs WHERE created_at >= ?`,
    [since],
  );
  const idleEvents = await db.all<{ kind: string; at: string }>(
    `SELECT kind, at FROM factory_events WHERE kind IN ('FACTORY_IDLE_STARTED', 'FACTORY_IDLE_ENDED') AND at >= ? ORDER BY at`,
    [since],
  );
  let fleet: CapacityInput['fleet'] = null;
  let readyBinsNow: number | null = null;
  try {
    const { fleetSnapshot } = await import('../../dispatch/candidates.ts');
    const { surfaceIneligibility } = await import('../../dispatch/router.ts');
    const { currentAdmissionPolicy } = await import('../../../repos/factoryLine.ts');
    const snapshot = await fleetSnapshot(new Date(until));
    const factoryCapable = snapshot.candidates.filter((c) => c.routine.capabilities.includes('repository'));
    fleet = {
      registered: factoryCapable.length,
      usable: factoryCapable.filter((c) => surfaceIneligibility(c) === null).length,
      inFlight: snapshot.factoryInFlight,
      admissionLimit: (await currentAdmissionPolicy()).maxActive,
    };
    readyBinsNow = await count(`SELECT COUNT(*) AS n FROM bins WHERE kind LIKE 'FACTORY_%' AND state = 'READY'`, []);
  } catch {
    fleet = null;
  }
  return computeCapacity({
    since,
    until,
    bins: [...timelines.values()],
    repairUnits: repairUnits.map((u) => ({ createdAt: u.created_at, integratedAt: u.state === 'INTEGRATED' ? u.updated_at : null })),
    releaseRuns: releaseRuns.map((r) => ({ createdAt: r.created_at, finishedAt: r.finished_at, state: r.state })),
    campaignsCompleted: await count(`SELECT COUNT(*) AS n FROM factory_campaigns WHERE state = 'COMPLETE' AND finished_at >= ?`, [since]),
    unitsIntegrated: await count(`SELECT COUNT(*) AS n FROM factory_work_units WHERE state = 'INTEGRATED' AND updated_at >= ?`, [since]),
    requirementsVerified: await count(`SELECT COUNT(DISTINCT program_id || ':' || requirement_key) AS n FROM factory_program_verifications WHERE outcome = 'PASS' AND at >= ?`, [since]),
    dedupedSubmissions: await count(`SELECT COUNT(*) AS n FROM factory_events WHERE kind = 'CHANGE_REQUEST_DEDUPED' AND at >= ?`, [since]),
    supersededUnits: await count(`SELECT COUNT(*) AS n FROM factory_work_units WHERE state = 'SUPERSEDED' AND updated_at >= ?`, [since]),
    idleEvents,
    fleet,
    readyBinsNow,
  });
}
