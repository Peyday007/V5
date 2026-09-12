/**
 * The Fleet, as one question with an answer.
 *
 * §14: *how much usable Brain power exists right now, where is it going, and
 * what should change?* Everything here is read from the rows Steps 10 and 11
 * already write — `fleet_accounts`, `fleet_routines`, `fleet_policy` and
 * `bin_events` — and the two rules that shape it are the ones those steps paid
 * for.
 *
 * **Provisioned, usable and measured are three different numbers.** A target
 * somebody configured, a capacity the surfaces can actually serve, and a
 * throughput Brain has observed are not each other, and reporting one as
 * another is how a fleet gets sized on a fiction. Each carries its own evidence
 * label, and a ceiling nobody has observed reads `UNKNOWN` and stays `UNKNOWN`.
 *
 * **Causality comes from recorded events, never from elapsed time.** "Explain
 * why this is slow" joins the chain a bin actually walked — ready, intent,
 * routed, sent, arrived, assigned, completed — and names the *gap* that is
 * largest. An explanation derived from a clock, or from a worker's account of
 * itself, would be a guess with a confident voice.
 */
import { listAccounts, listRoutines, currentPolicy, policyHistory } from '../../repos/fleet.ts';
import { getDb } from '../../db/database.ts';
import { workloadProfile } from '../dispatch/profiles.ts';
import type { FleetAccount, FleetRoutine } from '../../domain/types.ts';

/** How well grounded a number is. The same vocabulary the ledger already uses. */
export type Evidence = 'MEASURED' | 'INFERRED' | 'UNKNOWN' | 'PROVIDER_ENFORCED';

export interface CapacityReading {
  value: number | null;
  evidence: Evidence;
  /** What this number is, in a person's words. Never an enum. */
  explanation: string;
}

export interface SurfaceReading {
  routineId: string;
  name: string;
  accountId: string;
  accountName: string;
  state: string;
  /** Plain words for the state, so the enum never reaches a person. */
  stateLabel: string;
  /** Whether this surface can be fired at all right now, and why not. */
  usable: boolean;
  reason: string | null;
  /**
   * What actually refused, in the provider's own words, as the dispatcher
   * recorded it when it took this surface out of routing.
   *
   * Present only at technical depth, and null far more often than not. It
   * exists because the category alone is not an answer: `state_reason` was
   * written on every quarantine from the day that rule shipped and read by
   * nothing, so an operator looking at a fleet with no usable surface could
   * see *that* it was held back and nowhere at all *why*. A refusal that
   * names nothing is the defect §23 and §26 both already record, one row
   * along — and an escalation whose remedy is "correct the secret" is not a
   * remedy while the thing to correct is invisible.
   */
  recordedReason: string | null;
  capabilities: string[];
  /** Present only at technical depth: the raw identifiers. */
  workerId: string | null;
  consecutiveFailures: number;
  consecutiveNoShows: number;
  retryAt: string | null;
}

export interface FleetView {
  /** What somebody configured. A request, not a fact. */
  provisioned: CapacityReading;
  /** What the surfaces can actually serve right now. */
  usable: CapacityReading;
  /** What Brain has observed itself doing. */
  measured: CapacityReading;

  surfaces: SurfaceReading[];
  accounts: { id: string; name: string; state: string; declaredPlan: string | null }[];

  active: number;
  available: number;
  cooling: number;
  unhealthy: number;

  /** What is waiting, and whether the fleet can fit it. */
  backlog: { ready: number; leased: number; needsHuman: number };
  fits: boolean | null;

  /** The material bottleneck, from the ledger rather than from an impression. */
  bottleneck: string;
  bottleneckExplanation: string;

  /** What adding capacity would change — said honestly, or not said. */
  ifWeAddedCapacity: string;

  /** The policy in force, and the last few changes, so a revert has a target. */
  policy: {
    target: number | null;
    paused: boolean;
    boostTarget: number | null;
    boostUntil: string | null;
    version: number | null;
  };
  recentPolicyChanges: {
    version: number;
    target: number;
    actor: string;
    reason: string;
    at: string;
  }[];
}

const STATE_WORDS: Record<string, string> = {
  ENABLED: 'Healthy',
  DRAINING: 'Finishing what it has',
  UNAVAILABLE: 'Unavailable',
  QUARANTINED: 'Held back',
  RETIRED: 'Retired',
};

/**
 * Whether a surface can be fired, and the reason when it cannot.
 *
 * The four refusals §23 quarantines by name — a missing secret, an absent
 * account, a paused surface, a surface still inside its backoff — are named
 * separately, because they send an operator to four different places. A single
 * "unavailable" would send them to none of them.
 *
 * **The sentence here is the category, never the evidence.** What actually
 * refused the fire is `fleet_routines.state_reason`, written by the dispatcher
 * at the moment it took the surface out of routing — and it is returned
 * separately, because the two answer different questions for different
 * readers. "Held back after a refusal that needs fixing" is what a person is
 * owed; the provider's own words are what an operator needs in order to fix
 * it, and §14 says technical detail is what a caller is *owed* rather than
 * what it asks for.
 */
export function usability(
  routine: FleetRoutine,
  account: FleetAccount | undefined,
  now: string,
): { usable: boolean; reason: string | null; recorded: string | null } {
  const recorded = routine.stateReason?.trim() || null;
  if (!account) {
    return { usable: false, reason: 'Its account is not registered.', recorded };
  }
  if (account.state !== 'ENABLED') {
    return {
      usable: false,
      reason: `Its account is ${STATE_WORDS[account.state] ?? account.state}.`,
      recorded,
    };
  }
  if (routine.state === 'QUARANTINED') {
    return { usable: false, reason: 'Held back after a refusal that needs fixing.', recorded };
  }
  if (routine.state !== 'ENABLED') {
    return { usable: false, reason: STATE_WORDS[routine.state] ?? routine.state, recorded };
  }
  if (!routine.tokenSecretName) {
    return { usable: false, reason: 'No deployment secret is recorded for it.', recorded };
  }
  if (routine.retryAt && routine.retryAt > now) {
    return {
      usable: false,
      reason: 'Waiting out a provider refusal before it is fired again.',
      recorded,
    };
  }
  return { usable: true, reason: null, recorded: null };
}

/**
 * The whole fleet, in one read.
 *
 * `depth` is what a caller is owed rather than what it asks for: raw worker,
 * token and session identifiers are technical detail (§14), and this returns
 * them only when the caller is entitled to them. The decision is made by the
 * route from `decideProjectAccess`, never here — this only honours it.
 */
export async function fleetView(input: {
  includeTechnical: boolean;
  projectId?: string | null;
  now?: string;
}): Promise<FleetView> {
  const now = input.now ?? new Date().toISOString();
  const [accounts, routines, policy, history] = await Promise.all([
    listAccounts(),
    listRoutines(),
    currentPolicy('FLEET', null),
    policyHistory('FLEET', null, 5),
  ]);

  const byAccount = new Map(accounts.map((account) => [account.id, account]));
  const surfaces: SurfaceReading[] = routines.map((routine) => {
    const account = byAccount.get(routine.accountId);
    const { usable, reason, recorded } = usability(routine, account, now);
    return {
      routineId: routine.id,
      name: routine.name,
      accountId: routine.accountId,
      accountName: account?.name ?? 'unregistered',
      state: routine.state,
      stateLabel: STATE_WORDS[routine.state] ?? routine.state,
      usable,
      reason,
      // The provider's own words are technical detail, so they travel with the
      // raw identifiers rather than with the plain sentence beside them.
      recordedReason: input.includeTechnical ? recorded : null,
      capabilities: routine.capabilities,
      // Raw identifiers are technical detail. Null is "you are not told",
      // which is different from "there is none".
      workerId: input.includeTechnical ? routine.workerId : null,
      consecutiveFailures: routine.consecutiveFailures,
      consecutiveNoShows: routine.consecutiveNoShows,
      retryAt: routine.retryAt,
    };
  });

  const usableCount = surfaces.filter((surface) => surface.usable).length;
  const cooling = surfaces.filter(
    (surface) => !surface.usable && surface.retryAt !== null && surface.retryAt > now,
  ).length;
  const unhealthy = surfaces.filter(
    (surface) => surface.state === 'QUARANTINED' || surface.state === 'UNAVAILABLE',
  ).length;

  const backlog = await backlogCounts(input.projectId ?? null);
  const profile = await workloadProfile({ projectId: input.projectId ?? null });

  /*
   * Active surfaces, from leases rather than from a count of anything else.
   *
   * A bin that is `LEASED` has a worker on it right now. That is the only
   * observation here that is a fact about the present; everything else about
   * "how busy is the fleet" is arithmetic over the past.
   */
  const active = backlog.leased;

  return {
    provisioned: {
      value: policy?.target ?? null,
      evidence: policy ? 'MEASURED' : 'UNKNOWN',
      explanation: policy
        ? 'How many things a person has said may run at once.'
        : 'Nobody has set a target, so the dispatcher uses its built-in default.',
    },
    usable: {
      value: usableCount,
      evidence: 'MEASURED',
      explanation:
        'Surfaces that could be fired right now — registered, healthy, with a secret, and not waiting out a refusal.',
    },
    measured: {
      value: profile.activations,
      // The ledger's own class, not a re-derivation: a throughput nobody has
      // observed must stay UNKNOWN rather than becoming a confident zero.
      evidence: profile.evidence === 'MEASURED' ? 'MEASURED' : profile.evidence === 'PROVIDER_ENFORCED' ? 'PROVIDER_ENFORCED' : 'UNKNOWN',
      explanation: 'Activations Brain has actually recorded, over the window it can see.',
    },

    surfaces,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      state: account.state,
      declaredPlan: account.declaredPlanPower,
    })),

    active,
    available: Math.max(0, usableCount - active),
    cooling,
    unhealthy,

    backlog,
    /*
     * Whether the backlog fits.
     *
     * Null rather than a guess when there is no observed throughput: "can the
     * fleet handle this" without a measurement is exactly the kind of confident
     * arithmetic §23 forbids. With no usable surface the answer is a definite
     * no, which is a fact rather than a projection.
     */
    fits: usableCount === 0 ? false : backlog.ready === 0 ? true : null,

    bottleneck: profile.bottleneck,
    bottleneckExplanation: explainBottleneck(profile.bottleneck, usableCount, backlog.ready),
    ifWeAddedCapacity: capacityAdvice({
      bottleneck: profile.bottleneck,
      usable: usableCount,
      ready: backlog.ready,
    }),

    policy: {
      target: policy?.target ?? null,
      paused: policy?.paused ?? false,
      boostTarget: policy?.boostTarget ?? null,
      boostUntil: policy?.boostUntil ?? null,
      version: policy?.version ?? null,
    },
    recentPolicyChanges: history.map((entry) => ({
      version: entry.version,
      target: entry.target,
      actor: entry.actor,
      reason: entry.reason,
      at: entry.createdAt,
    })),
  };
}

async function backlogCounts(
  projectId: string | null,
): Promise<{ ready: number; leased: number; needsHuman: number }> {
  const rows = await getDb().all<{ state: string; n: number }>(
    projectId
      ? `SELECT state, COUNT(*) AS n FROM bins WHERE project_id = ? GROUP BY state`
      : `SELECT state, COUNT(*) AS n FROM bins GROUP BY state`,
    projectId ? [projectId] : [],
  );
  const by = new Map(rows.map((row) => [row.state, Number(row.n)]));
  return {
    ready: by.get('READY') ?? 0,
    leased: by.get('LEASED') ?? 0,
    needsHuman: by.get('NEEDS_HUMAN') ?? 0,
  };
}

function explainBottleneck(bottleneck: string, usable: number, ready: number): string {
  switch (bottleneck) {
    case 'PROVIDER_CEILING':
      return 'A provider is refusing fires. More surfaces on the same account will not help; a different account would.';
    case 'FLEET_TARGET':
      return 'The configured target is the limit, not the provider. Raising it is a policy change, not a deployment.';
    case 'WORKER_HEALTH':
      return 'Surfaces are being refused or are not turning up. Fix the surface before adding another.';
    case 'NO_WORK':
      return ready === 0
        ? 'There is nothing waiting. The fleet is idle because the backlog is empty, not because it is limited.'
        : 'Nothing has been dispatched recently.';
    default:
      return usable === 0
        ? 'There is no healthy surface to fire, so nothing can run at all.'
        : 'Nothing is currently limiting throughput that Brain can see.';
  }
}

function capacityAdvice(input: {
  bottleneck: string;
  usable: number;
  ready: number;
}): string {
  if (input.usable === 0) {
    return 'Registering one healthy surface would take the fleet from nothing to running.';
  }
  if (input.bottleneck === 'PROVIDER_CEILING') {
    return 'Another Routine on the same account would be refused the same way. Capacity means another account.';
  }
  if (input.bottleneck === 'FLEET_TARGET') {
    return 'Raising the target would use surfaces that already exist — no new account is needed.';
  }
  if (input.ready === 0) {
    return 'Nothing is waiting, so more capacity would change nothing today.';
  }
  // §23's rule: never infer capacity from account count.
  return 'Brain has not measured what another surface would add. A calibration run in the Capability Lab would answer it.';
}

/* ==========================================================================
 * Why is this slow?
 * ========================================================================== */

/** One recorded step in a bin's life, in the order it happened. */
export interface TraceStep {
  event: string;
  label: string;
  at: string;
  /** Milliseconds since the previous recorded step. Null for the first. */
  sincePreviousMs: number | null;
}

export interface SlownessExplanation {
  binId: string;
  steps: TraceStep[];
  /**
   * The largest recorded gap, and what it was.
   *
   * Named from the two events either side of it, so the answer is a fact about
   * the chain rather than an inference from the total. When there are fewer
   * than two events there is no gap to name, and the answer says so.
   */
  largestGap: { from: string; to: string; ms: number; meaning: string } | null;
  /** What could not be determined, rather than a guess to fill the hole. */
  unknowns: string[];
}

const EVENT_WORDS: Record<string, string> = {
  BIN_CREATED: 'Written',
  BIN_READY: 'Ready to be handed out',
  DISPATCH_INTENT: 'Brain decided to fire a worker',
  DISPATCH_ROUTED: 'A surface was chosen',
  DISPATCH_SENT: 'The worker was fired',
  DISPATCH_DEFERRED: 'The fire was put off',
  DISPATCH_UNROUTED: 'No surface could take it',
  BIN_ASSIGNED: 'A worker took it',
  BIN_TAKEOVER: 'Another worker took over an expired lease',
  BIN_ASSIGNMENT_REFUSED: 'A worker was refused it',
  BIN_HEARTBEAT: 'The worker checked in',
  BIN_CHECKPOINT: 'Progress was saved',
  BIN_COMPLETION_REFUSED: 'A completion was refused',
  BIN_LEASE_EXPIRED: 'The lease ran out',
  BIN_RELEASED: 'The worker let it go',
  BIN_REOPENED: 'It was offered again',
  BIN_TERMINAL: 'It finished',
  PROVIDER_ALLOWANCE: 'The provider refused on allowance',
};

/**
 * What each gap *means*, from the pair of events around it.
 *
 * This is the difference between "it took an hour" and "it waited an hour for
 * a person to authorize it", and §14 asks for exactly that separation:
 * authority wait, refusal backoff, provider throttle and unknown attribution
 * are four different answers with four different remedies.
 */
export function meaningOfGap(from: string, to: string): string {
  if (from === 'BIN_READY' && to === 'DISPATCH_INTENT') {
    return 'Waiting for the dispatcher to notice it.';
  }
  if (from === 'DISPATCH_INTENT' && to === 'DISPATCH_SENT') {
    return 'Waiting for a surface with room.';
  }
  if (from === 'DISPATCH_SENT' && (to === 'BIN_ASSIGNED' || to === 'BIN_TAKEOVER')) {
    return 'Waiting for the fired worker to arrive and take it.';
  }
  if (from === 'DISPATCH_DEFERRED') {
    return 'Deliberately put off after a refusal, waiting out its backoff.';
  }
  if (from === 'BIN_ASSIGNMENT_REFUSED') {
    return 'Refused to a worker that was not eligible, waiting for a different session.';
  }
  if (from === 'BIN_ASSIGNED' || from === 'BIN_TAKEOVER') {
    return 'The worker was doing the work.';
  }
  if (from === 'BIN_LEASE_EXPIRED') {
    return 'Nobody was holding it after a lease lapsed.';
  }
  return 'Between two recorded events; Brain does not attribute this gap.';
}

/**
 * Why one piece of work took as long as it did.
 *
 * Reads the bin's own events in order. Nothing here consults a clock to decide
 * what happened, and nothing consults a worker's account of itself — the chain
 * is Brain's own record, which is the only thing that can be checked.
 */
export async function explainSlowness(binId: string): Promise<SlownessExplanation> {
  const rows = await getDb().all<{ event_type: string; at: string }>(
    `SELECT event_type, at FROM bin_events WHERE bin_id = ? ORDER BY at, id LIMIT 500`,
    [binId],
  );

  const steps: TraceStep[] = [];
  let previous: { event: string; at: string } | null = null;
  let largest: { from: string; to: string; ms: number; meaning: string } | null = null;

  for (const row of rows) {
    const ms = previous ? Date.parse(row.at) - Date.parse(previous.at) : null;
    steps.push({
      event: row.event_type,
      label: EVENT_WORDS[row.event_type] ?? row.event_type,
      at: row.at,
      sincePreviousMs: ms,
    });
    if (previous && ms !== null && (largest === null || ms > largest.ms)) {
      largest = {
        from: previous.event,
        to: row.event_type,
        ms,
        meaning: meaningOfGap(previous.event, row.event_type),
      };
    }
    previous = { event: row.event_type, at: row.at };
  }

  const unknowns: string[] = [];
  if (rows.length === 0) unknowns.push('No events were recorded for this work at all.');
  if (!rows.some((row) => row.event_type === 'DISPATCH_SENT')) {
    unknowns.push('No worker was ever fired for it, so nothing can be said about provider time.');
  }
  if (!rows.some((row) => row.event_type === 'BIN_ASSIGNED' || row.event_type === 'BIN_TAKEOVER')) {
    unknowns.push('No worker ever took it, so execution time is not observable.');
  }

  return { binId, steps, largestGap: largest, unknowns };
}
