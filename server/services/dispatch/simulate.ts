/**
 * What a bigger fleet would do, from traces of the fleet we have.
 *
 * The alternative is provisioning fifty Routines and burning a subscription
 * allowance to rediscover a number the rows already imply, which is explicitly
 * not worth doing. So this replays measured activation costs through a
 * scheduler and reports what falls out.
 *
 * Two properties are the whole point:
 *
 *   - **Deterministic.** Same trace, same configuration, same answer, every
 *     time. There is no clock and no random source in here; anything that
 *     varies between runs would make the output an opinion.
 *
 *   - **Labelled.** Every result carries `simulated: true` and the trace it
 *     came from. Step 10's hardest-won lesson is that a number which cannot be
 *     traced to rows gets quoted later as though it could, so a simulated
 *     throughput must be structurally impossible to mistake for an observed
 *     one — not merely rendered in a different colour.
 */

/** One activation's measured cost, taken from `bin_events`. */
export interface TraceSample {
  /** How long the activation ran, milliseconds. */
  durationMs: number;
  /** How many bins it drained before asking for nothing more. */
  binsDrained: number;
}

export interface SimAccount {
  name: string;
  /** Routines under this account. More fire surface, same allowance. */
  routines: number;
  /**
   * Activations this account may run concurrently, or null for unknown.
   * Unknown is a real answer: Step 10 measured a fire ceiling and never
   * measured a subscription allowance, and the simulation must be able to say
   * so rather than substituting a number.
   */
  concurrency: number | null;
  /** Fires per hour the provider accepts before refusing, when observed. */
  firesPerHour: number | null;
  /** Simulated outage: this account serves nothing. */
  unavailable?: boolean;
  /** Simulated exhaustion: refuses after this many fires, then resets. */
  exhaustAfter?: number | null;
  resetAfterMs?: number | null;
}

export interface SimConfig {
  label: string;
  accounts: SimAccount[];
  /** Bins waiting at t=0. */
  queueDepth: number;
  /** Ceiling on concurrent activations across the whole fleet, or null. */
  fleetTarget: number | null;
  horizonMs: number;
}

export interface SimResult {
  /** Never absent, never false. A simulated result says so in its own shape. */
  simulated: true;
  label: string;
  traceId: string;
  binsCompleted: number;
  binsRemaining: number;
  activations: number;
  refusals: number;
  wallClockMs: number;
  /** Per account, so an outage or an exhaustion is visible rather than averaged. */
  perAccount: { name: string; activations: number; bins: number; refusals: number }[];
  /** Facts the simulation could not model, named rather than defaulted. */
  unknowns: string[];
}

/**
 * A stable identifier for a trace, so a result can be tied to its input.
 *
 * Content-addressed rather than random: replaying the same samples in the same
 * order gives the same id, which is what makes "deterministic from the same
 * trace" checkable rather than asserted.
 */
export function traceId(samples: TraceSample[]): string {
  let hash = 0;
  for (const sample of samples) {
    hash = (hash * 31 + sample.durationMs) | 0;
    hash = (hash * 31 + sample.binsDrained) | 0;
  }
  return `trace_${(hash >>> 0).toString(16).padStart(8, '0')}_${samples.length}`;
}

/**
 * Run the fleet forward.
 *
 * A discrete event loop over activation slots. Each account has as many slots
 * as its concurrency allows, each slot takes one sample from the trace in
 * order — cycling, so a short trace still drives a long horizon — and drains
 * that many bins.
 *
 * The trace is consumed by index rather than sampled randomly, which is what
 * makes the result reproducible. It also means the answer is honest about its
 * own resolution: a three-sample trace models three distinct activation costs
 * repeated, and the `unknowns` list says so.
 */
export function simulate(config: SimConfig, samples: TraceSample[]): SimResult {
  const unknowns: string[] = [];
  if (samples.length === 0) {
    return {
      simulated: true,
      label: config.label,
      traceId: traceId(samples),
      binsCompleted: 0,
      binsRemaining: config.queueDepth,
      activations: 0,
      refusals: 0,
      wallClockMs: 0,
      perAccount: config.accounts.map((a) => ({ name: a.name, activations: 0, bins: 0, refusals: 0 })),
      unknowns: ['No measured activations to replay. Nothing can be simulated from an empty trace.'],
    };
  }
  if (samples.length < 5) {
    unknowns.push(
      `Only ${samples.length} measured activation(s) in the trace, so the cost distribution is ` +
        'that many points repeated rather than a distribution.',
    );
  }

  const perAccount = config.accounts.map((a) => ({
    name: a.name,
    activations: 0,
    bins: 0,
    refusals: 0,
  }));

  for (const [index, account] of config.accounts.entries()) {
    if (account.concurrency === null) {
      unknowns.push(
        `Account "${account.name}" has no measured concurrency, so its ${account.routines} ` +
          'Routine(s) are modelled as one activation each — a floor, not an estimate.',
      );
    }
    if (account.firesPerHour === null && !account.unavailable) {
      unknowns.push(
        `Account "${account.name}" has no observed fire ceiling. The simulation does not ` +
          'invent one, so its refusals are only those explicitly configured.',
      );
    }
    void index;
  }

  let queue = config.queueDepth;
  let clock = 0;
  let activations = 0;
  let refusals = 0;
  let sampleIndex = 0;
  const firesByAccount = new Map<string, number>();
  const resetAt = new Map<string, number>();

  // Slots: one per concurrent activation the fleet may hold at once.
  const slots: { accountIndex: number; freeAt: number }[] = [];
  for (const [accountIndex, account] of config.accounts.entries()) {
    if (account.unavailable) continue;
    const perRoutine = account.concurrency ?? 1;
    const total = Math.max(1, perRoutine);
    for (let i = 0; i < total; i += 1) slots.push({ accountIndex, freeAt: 0 });
  }
  if (config.fleetTarget !== null && slots.length > config.fleetTarget) {
    slots.length = config.fleetTarget;
  }
  if (slots.length === 0) {
    unknowns.push('Every account is unavailable, so the fleet has no capacity at all.');
  }

  while (queue > 0 && clock <= config.horizonMs && slots.length > 0) {
    slots.sort((a, b) => a.freeAt - b.freeAt || a.accountIndex - b.accountIndex);
    const slot = slots[0]!;
    clock = Math.max(clock, slot.freeAt);
    if (clock > config.horizonMs) break;

    const account = config.accounts[slot.accountIndex]!;
    const fired = firesByAccount.get(account.name) ?? 0;

    // Exhaustion, and the reset that ends it. Modelled explicitly because
    // Step 10 observed both: rung 30 refused everything, and the fleet resumed
    // by itself when the window reopened.
    const resets = resetAt.get(account.name) ?? 0;
    if (account.exhaustAfter != null && fired >= account.exhaustAfter && clock < resets) {
      refusals += 1;
      perAccount[slot.accountIndex]!.refusals += 1;
      slot.freeAt = resets;
      continue;
    }
    if (account.exhaustAfter != null && fired >= account.exhaustAfter && clock >= resets) {
      firesByAccount.set(account.name, 0);
      resetAt.set(account.name, clock + (account.resetAfterMs ?? 5 * 60 * 60_000));
    }

    const sample = samples[sampleIndex % samples.length]!;
    sampleIndex += 1;

    const drained = Math.min(queue, Math.max(1, sample.binsDrained));
    queue -= drained;
    activations += 1;
    firesByAccount.set(account.name, (firesByAccount.get(account.name) ?? 0) + 1);
    perAccount[slot.accountIndex]!.activations += 1;
    perAccount[slot.accountIndex]!.bins += drained;
    slot.freeAt = clock + Math.max(1, sample.durationMs);
  }

  return {
    simulated: true,
    label: config.label,
    traceId: traceId(samples),
    binsCompleted: config.queueDepth - queue,
    binsRemaining: queue,
    activations,
    refusals,
    wallClockMs: clock,
    perAccount,
    unknowns,
  };
}

/** The reference fleet sizes Step 11 is asked to model. */
export const REFERENCE_SIZES = [5, 10, 20, 30, 50] as const;

/** A uniform fleet of N single-Routine accounts, for the reference curve. */
export function referenceFleet(workers: number, queueDepth: number, horizonMs: number): SimConfig {
  return {
    label: `${workers} workers (reference)`,
    accounts: Array.from({ length: workers }, (_, i) => ({
      name: `sim-account-${i + 1}`,
      routines: 1,
      concurrency: 1,
      firesPerHour: null,
    })),
    queueDepth,
    fleetTarget: null,
    horizonMs,
  };
}
