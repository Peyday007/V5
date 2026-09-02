/**
 * What one idea actually cost, read from rows.
 *
 * Step 12's Fleet and Capability Lab will test thresholds and recommend
 * changes. It cannot do that from prose, and it must not do it from numbers
 * Brain computed once and stored — a stored verdict cannot be re-derived when
 * the rule changes. So this is a *query*, not a table: it reads the events and
 * the packet rows that already exist and attributes them.
 *
 * The one thing it adds beyond arithmetic is the bottleneck classification,
 * and that is deliberately coarse. "Which of four things was this run waiting
 * on" is a question a person can act on; a precise number nobody can change is
 * not.
 */
import { getDb } from '../../db/database.ts';
import type { CapacityEvidence } from '../../domain/types.ts';

export interface WorkloadProfile {
  scope: { projectId: string | null; orchestrationId: string | null };
  workloadClass: string | null;
  /** Which policy was in force, so a before/after comparison has a pivot. */
  policyVersion: number | null;

  binsPlanned: number;
  binsCompleted: number;
  activations: number;
  routedDecisions: number;
  providerRefusals: number;
  completionRefusals: number;
  takeovers: number;
  unrouted: number;

  /** Milliseconds, when the events allow it. Null when they do not. */
  medianActivationMs: number | null;
  totalWallClockMs: number | null;

  perAccount: { accountId: string | null; activations: number; refusals: number }[];

  bottleneck: 'PROVIDER_CEILING' | 'FLEET_TARGET' | 'WORKER_HEALTH' | 'NO_WORK' | 'NONE';
  /** How well grounded the numbers above are. */
  evidence: CapacityEvidence;
  unknowns: string[];
}

interface EventRow {
  event_type: string;
  account_id: string | null;
  routine_id: string | null;
  outcome: string | null;
  duration_ms: number | null;
  at: string;
}

/**
 * Profile one project or packet.
 *
 * Scoped rather than global on purpose: Step 12's tester compares one idea
 * before and after a change, and a fleet-wide average would hide exactly the
 * difference it is looking for.
 */
export async function workloadProfile(scope: {
  projectId?: string | null;
  orchestrationId?: string | null;
  workloadClass?: string | null;
}): Promise<WorkloadProfile> {
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (scope.projectId) {
    where.push('project_id = ?');
    params.push(scope.projectId);
  }
  if (scope.orchestrationId) {
    where.push('orchestration_id = ?');
    params.push(scope.orchestrationId);
  }
  if (scope.workloadClass) {
    where.push('workload_class = ?');
    params.push(scope.workloadClass);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const events = await db.all<EventRow>(
    `SELECT event_type, account_id, routine_id, outcome, duration_ms, at
       FROM bin_events ${clause} ORDER BY at`,
    params,
  );

  const count = (type: string): number => events.filter((e) => e.event_type === type).length;

  const durations = events
    .filter((e) => e.event_type === 'BIN_TERMINAL' && e.duration_ms !== null)
    .map((e) => Number(e.duration_ms))
    .sort((a, b) => a - b);

  const perAccountMap = new Map<string | null, { activations: number; refusals: number }>();
  for (const event of events) {
    if (event.event_type !== 'DISPATCH_SENT' && event.event_type !== 'PROVIDER_ALLOWANCE') continue;
    const key = event.account_id;
    const entry = perAccountMap.get(key) ?? { activations: 0, refusals: 0 };
    if (event.event_type === 'DISPATCH_SENT') entry.activations += 1;
    else entry.refusals += 1;
    perAccountMap.set(key, entry);
  }

  const providerRefusals = count('PROVIDER_ALLOWANCE');
  const completionRefusals = count('BIN_COMPLETION_REFUSED');
  const takeovers = count('BIN_TAKEOVER');
  const unrouted = count('DISPATCH_UNROUTED');
  const activations = count('DISPATCH_SENT');
  const binsCompleted = count('BIN_COMPLETION_ACCEPTED');
  const binsPlanned = count('BIN_READY');

  const unknowns: string[] = [];
  if (events.length === 0) unknowns.push('No events in scope; nothing here is measured.');
  if (durations.length === 0) {
    unknowns.push('No activation carried a duration, so timing is unknown rather than zero.');
  }

  // Bottleneck, in the order a person would act on them. A provider ceiling
  // outranks a fleet target because raising the target against a wall spends
  // the budget to be refused; both outrank health, because an unhealthy surface
  // in a fleet that is not even trying to fire is not what is limiting it.
  const bottleneck: WorkloadProfile['bottleneck'] =
    providerRefusals > 0
      ? 'PROVIDER_CEILING'
      : unrouted > 0
        ? 'FLEET_TARGET'
        : takeovers > 0 || completionRefusals > 0
          ? 'WORKER_HEALTH'
          : activations === 0
            ? 'NO_WORK'
            : 'NONE';

  return {
    scope: { projectId: scope.projectId ?? null, orchestrationId: scope.orchestrationId ?? null },
    workloadClass: scope.workloadClass ?? null,
    policyVersion: null,
    binsPlanned,
    binsCompleted,
    activations,
    routedDecisions: count('DISPATCH_ROUTED'),
    providerRefusals,
    completionRefusals,
    takeovers,
    unrouted,
    medianActivationMs: durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null,
    totalWallClockMs:
      events.length >= 2
        ? Date.parse(events[events.length - 1]!.at) - Date.parse(events[0]!.at)
        : null,
    perAccount: [...perAccountMap.entries()].map(([accountId, v]) => ({ accountId, ...v })),
    bottleneck,
    // Everything above is counted from append-only rows the system wrote as it
    // happened. Nothing is modelled, so the class is MEASURED — except when
    // there is nothing to measure, which says so instead.
    evidence: events.length === 0 ? 'UNKNOWN' : 'MEASURED',
    unknowns,
  };
}

/** Activation samples for the simulator, taken from real completions. */
export async function activationTrace(limit = 200): Promise<
  { durationMs: number; binsDrained: number }[]
> {
  const rows = await getDb().all<{ session_ref: string | null; n: number; total: number | null }>(
    `SELECT session_ref, COUNT(*) AS n, SUM(duration_ms) AS total
       FROM bin_events
      WHERE event_type = 'BIN_COMPLETION_ACCEPTED' AND session_ref IS NOT NULL
      GROUP BY session_ref
      ORDER BY session_ref
      LIMIT ${Math.max(1, Math.min(1000, limit))}`,
  );
  return rows.map((row) => ({
    durationMs: Number(row.total ?? 0) || 60_000,
    binsDrained: Number(row.n) || 1,
  }));
}
