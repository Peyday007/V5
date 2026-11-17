/**
 * Where the recorded fallback structures reach the work (FALL-37-1/2/3/6).
 *
 * `fallbackPlanReading.ts`, `fallbackIndependence.ts` and
 * `fallbackPreparation.ts` record the project's acquisition fallback plan, the
 * independence of its paths by common cause, and the order its backups are
 * prepared in, on every cash-knowledge refresh. Recording them was not acting
 * on them: nothing read them back, so a failed primary path left every goal
 * plan reading the funnel of a path that no longer delivers.
 *
 * This is the reading that acts. `switchDecision` takes the three records and
 * the ledger's failure/recovery rows (`ledger.ts readFailureRecoveries`, each
 * on the path it happened on, so a former primary's failure is never read as
 * the current primary's) and
 * answers one question: is the project's acquisition dependency running on its
 * primary, or has it failed, and if so which substitute does the plan now run
 * on? A substitute is taken only when
 *
 *   - the plan reads it eligible and it is validated or reserved (a located
 *     substitute is not capacity, and is never promoted because the primary
 *     failed),
 *   - the independence reading's next action for it is SWITCH (an unknown
 *     external confirmation is reconciled first, never switched blindly),
 *   - it shares no common cause with the primary (a path on the same failed
 *     account fails with it: that is one correlated failure, not a backup),
 *   - it has no unrecovered failure of its own on the ledger,
 *
 * and among those it follows the recorded preparation order, so the backups
 * prepared first are the ones switched to first.
 *
 * The switch's consequence is the chain's own re-derived funnel for that
 * failure mode (`fallbacks.ts switchTo`): the substitute's measured
 * responders over the prospects it reached. `knowledge.ts` carries the
 * decision on `CashKnowledge.fallbackDecision` and enters that rate as the
 * project's own measured `respond` observation, so every goal plan built on
 * the knowledge (`cash/goalScenario.ts`, `goals/portfolio.ts`) recalculates
 * its target portfolio on the path the dependency actually runs on.
 *
 * It sends, buys and commits nothing: it is a reading of records, and the
 * switch it describes is the planning model's, inside the outreach authority
 * the plan's eligibility already checked.
 */
import type { FailureRecoveryRecord } from './ledger.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import {
  FALLBACK_SWITCH_EVENT,
  SWITCH_TRIED_PREFIX,
  failedPathOf,
  openPathFailures,
  openPrimaryFailures,
  triedFor,
  type ContactResult,
  type SwitchDecisionRecord,
} from './fallbackPlanReading.ts';
import type { MeasuredPath, ProjectFallbackPlanRecord } from './fallbackPlanReading.ts';
import type { AcquisitionPath, ProjectIndependenceRecord } from './fallbackIndependence.ts';
import type { FallbackPreparationRecord } from './fallbackPreparation.ts';
import type { ChainReplacement } from './fallbacks.ts';
import type { Figure } from './graph.ts';

export interface FallbackSwitchDecision {
  dependency: string;
  /** PRIMARY: no open failure. SWITCHED: failed, and the plan runs on `replacement`. NO_REPLACEMENT: failed, nothing qualifies. */
  state: 'PRIMARY' | 'SWITCHED' | 'NO_REPLACEMENT';
  primaryPath: string;
  /** The open failure that triggered the switch, when there is one. */
  failure: { occurrence: string; failureMode: string; recovered: boolean | null } | null;
  /** The substitute key the plan now runs on. */
  replacement: string | null;
  /** The replacement's re-derived funnel: responders out of prospects reached. Null when either is unknown. */
  funnel: { responders: number; prospectsReached: number; source: string } | null;
  /** Each substitute considered and not taken, with why. */
  passedOver: { substitute: string; because: string[] }[];
  /** The order substitutes were considered in, and where it came from. */
  order: { keys: string[]; from: 'PREPARATION' | 'PLAN' };
  because: string;
}

const known = (f: Figure | undefined | null): f is Figure & { value: number } =>
  !!f && f.status !== 'UNKNOWN' && typeof f.value === 'number' && Number.isFinite(f.value);

/**
 * The switch the recorded structures call for. Pure: everything it reads is
 * passed in, and it is null when no fallback plan is on record.
 */
export function switchDecision(input: {
  plan: ProjectFallbackPlanRecord | null;
  independence: ProjectIndependenceRecord | null;
  preparation: FallbackPreparationRecord | null;
  failures: readonly FailureRecoveryRecord[];
  /**
   * The failure occurrences whose own path's rows show recovery
   * (`ownPathRecoveries`). A failure the dependency recovered from by
   * switching is still its path's failure until these say so; without them a
   * switch-settled failure reads as recovered.
   */
  ownRecovered?: ReadonlySet<string>;
}): FallbackSwitchDecision | null {
  const record = input.plan;
  if (!record) return null;
  const { plan, chains } = record;
  const primaryPath = chains[0]?.primaryPath ?? plan.dependency;
  const modeKeys = new Set(plan.failureModes.map((m) => m.key));
  // A failure belongs to the path it happened on: only the current primary's own open failures switch the plan.
  const open = openPrimaryFailures(input.failures, plan.dependency, primaryPath, input.ownRecovered).filter((f) => modeKeys.has(f.failureMode));
  const failure = open[open.length - 1] ?? null;

  const planOrder = plan.substitutes.map((s) => s.key);
  const prepared = (input.preparation?.ranked ?? [])
    .filter((r) => r.dependency === plan.dependency)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.substitute)
    .filter((key) => planOrder.includes(key));
  const order = prepared.length > 0
    ? { keys: [...new Set([...prepared, ...planOrder])], from: 'PREPARATION' as const }
    : { keys: planOrder, from: 'PLAN' as const };

  const base = { dependency: plan.dependency, primaryPath, order };
  if (!failure) {
    return { ...base, state: 'PRIMARY', failure: null, replacement: null, funnel: null, passedOver: [], because: `no unrecovered failure of ${plan.dependency} is on the ledger; the plan runs on its primary` };
  }

  const mode = plan.failureModes.find((m) => m.key === failure.failureMode)!;
  const chain = chains.find((c) => c.failureCondition === mode.condition) ?? null;
  const actionOf = new Map((input.independence?.dependency.key === plan.dependency ? input.independence.actions : []).map((a) => [a.key, a]));
  const passedOver: FallbackSwitchDecision['passedOver'] = [];
  let chosen: { key: string; link: ChainReplacement | null } | null = null;
  for (const key of order.keys) {
    const reading = plan.substitutes.find((s) => s.key === key);
    if (!reading) continue;
    const why: string[] = [];
    if (!reading.eligible) why.push(`not eligible: ${reading.ineligibleBecause.join('; ') || 'the plan reads it ineligible'}`);
    if (reading.readiness === 'LOCATED') why.push('only located: a possible substitute is not available capacity');
    if (reading.sharedWithPrimary.length > 0) why.push(`shares ${reading.sharedWithPrimary.join(', ')} with the failed primary, so it fails with it`);
    const own = openPathFailures(input.failures, plan.dependency, key, input.ownRecovered);
    if (own.length > 0) why.push(`has an unrecovered failure of its own (${own.map((f) => `${f.failureMode}, ${f.occurrence}`).join('; ')}), so it is not a working path to switch to`);
    const action = actionOf.get(key);
    if (!action) why.push('no independence reading on record judges switching to it');
    else if (action.action !== 'SWITCH') why.push(`independence reading says ${action.action}: ${action.because.join('; ')}`);
    if (why.length > 0) {
      passedOver.push({ substitute: key, because: why });
      continue;
    }
    chosen = { key, link: chain?.replacements.find((r) => r.substitute === key) ?? null };
    break;
  }
  const failed = { occurrence: failure.occurrence, failureMode: failure.failureMode, recovered: failure.recovered };
  if (!chosen) {
    return { ...base, state: 'NO_REPLACEMENT', failure: failed, replacement: null, funnel: null, passedOver, because: `${primaryPath} failed (${failure.failureMode}) and no substitute qualifies; the plan cannot run on a backup` };
  }
  const after = chosen.link?.impact?.after ?? {};
  const responders = after['responders'];
  const reached = after['prospectsReached'];
  const funnel = known(responders) && known(reached) && reached.value > 0
    ? { responders: responders.value, prospectsReached: reached.value, source: `fallback chain of ${plan.dependency} recorded ${record.at}, failure mode ${failure.failureMode}, switch to ${chosen.key}` }
    : null;
  return {
    ...base,
    state: 'SWITCHED',
    failure: failed,
    replacement: chosen.key,
    funnel,
    passedOver,
    because: `${primaryPath} failed (${failure.failureMode}, ${failure.occurrence}); the plan runs on ${chosen.key}` + (funnel ? `, ${Math.round(funnel.responders)} responder(s) of ${Math.round(funnel.prospectsReached)} prospect(s) reached` : ', whose funnel is not measured'),
  };
}

/** What a decision on an open failure tried, in words, in order. Empty for a plan running on its primary. Pure. */
export function triedOf(decision: FallbackSwitchDecision): string[] {
  if (decision.state === 'PRIMARY' || !decision.failure) return [];
  const passed = decision.passedOver.map((p) => `passed over ${p.substitute}: ${p.because.join('; ')}`);
  const head = decision.state === 'SWITCHED'
    ? `${SWITCH_TRIED_PREFIX}${decision.dependency} from ${decision.primaryPath} to ${decision.replacement} (order from ${decision.order.from.toLowerCase()})`
    : `no substitute of ${decision.dependency} qualified to replace ${decision.primaryPath}`;
  return [head, ...passed];
}

/**
 * The decision as the ledger keeps it, or null when there is nothing to keep
 * (a plan on its primary tried nothing). Pure.
 */
export function decisionRecord(decision: FallbackSwitchDecision, at: string): SwitchDecisionRecord | null {
  if (decision.state === 'PRIMARY' || !decision.failure) return null;
  return {
    occurrence: decision.failure.occurrence,
    dependency: decision.dependency,
    state: decision.state,
    primaryPath: decision.primaryPath,
    replacement: decision.replacement,
    tried: triedOf(decision),
    at,
  };
}

/**
 * Whether a switch worked, read from the substitute's own rows — the
 * verification its plan names (`recoveryVerification`: the path records new
 * contact results after the switch): the first result written after the
 * switch was decided that is good for the failed mode (delivered, for a
 * channel that stopped delivering; an answer, for prospects that stopped
 * answering). Null while no such result is on record. Pure.
 */
export function switchVerification(failureMode: string, switchedAt: string, results: readonly ContactResult[]): ContactResult | null {
  const after = Date.parse(switchedAt);
  const good = failureMode === 'prospects-stop-answering'
    ? (r: ContactResult) => r.result !== 'CONTACT_UNDELIVERABLE' && r.result !== 'BUYER_SILENT'
    : (r: ContactResult) => r.result !== 'CONTACT_UNDELIVERABLE';
  return results.find((r) => Date.parse(r.at) > after && good(r)) ?? null;
}

const DAY_MS = 86_400_000;

/**
 * Keep what Brain tried and whether it worked (FALL-37-4, S-0500, S-0506):
 * record the decision when it changes, and once the switched-to path's own
 * rows verify the switch, settle the failure — recovered, with the switch and
 * every substitute passed over as what was tried, the verifying result, and
 * the days from the failure's record to that result as the time lost. A
 * failure no path names is the dependency's as a whole and is never settled
 * here: it has no rows of its own to say its path came back. Writes only
 * through the ledger's writers.
 */
export async function keepSwitchOutcome(
  projectId: string,
  decision: FallbackSwitchDecision | null,
  input: {
    failures: readonly FailureRecoveryRecord[];
    decisions: readonly SwitchDecisionRecord[];
    paths: readonly MeasuredPath[];
    results: (path: AcquisitionPath) => Promise<ContactResult[]>;
    record?: typeof recordBinEvent;
    now?: () => Date;
  },
): Promise<{ decisionWritten: boolean; settled: string | null }> {
  if (!decision || decision.state === 'PRIMARY' || !decision.failure) return { decisionWritten: false, settled: null };
  const now = (input.now?.() ?? new Date()).toISOString();
  const kept = decisionRecord(decision, now)!;
  const same = (d: SwitchDecisionRecord) => d.occurrence === kept.occurrence && d.state === kept.state && d.replacement === kept.replacement && JSON.stringify(d.tried) === JSON.stringify(kept.tried);
  const prior = input.decisions.find(same);
  let decisionWritten = false;
  if (!prior) {
    await (input.record ?? recordBinEvent)({
      eventType: FALLBACK_SWITCH_EVENT,
      projectId,
      workloadClass: 'fallback-switch',
      outcome: kept.state,
      reason: kept.tried[0]!.slice(0, 480),
      evidenceClass: 'MEASURED',
      measures: { switchDecision: kept },
    });
    decisionWritten = true;
  }
  if (decision.state !== 'SWITCHED' || !decision.replacement) return { decisionWritten, settled: null };
  const failure = input.failures.find((f) => f.occurrence === decision.failure!.occurrence);
  if (!failure || failure.recovered !== null || failedPathOf(failure) === null) return { decisionWritten, settled: null };
  const switchedAt = (prior ?? input.decisions.find((d) => d.occurrence === kept.occurrence && d.state === 'SWITCHED' && d.replacement === kept.replacement) ?? kept).at;
  const path = input.paths.find((p) => `${p.mechanism} @ ${p.channel}` === decision.replacement);
  if (!path) return { decisionWritten, settled: null };
  const verified = switchVerification(failure.failureMode, switchedAt, await input.results(path));
  if (!verified) return { decisionWritten, settled: null };
  const { recordFailureRecovery } = await import('./ledger.ts');
  const lost = (Date.parse(verified.at) - Date.parse(failure.at)) / DAY_MS;
  const { detectionTimely: _timely, at: _at, ...base } = failure;
  await recordFailureRecovery(
    {
      ...base,
      tried: [
        ...new Set([...failure.tried, ...triedFor(failure.occurrence, [...input.decisions, kept])]),
        `recovery verified: ${decision.replacement} recorded result ${verified.id} (${verified.result}) at ${verified.at}, after the switch`,
      ],
      recovered: true,
      timeLostDays: Number.isFinite(lost) ? Math.max(0, lost) : null,
    },
    { projectId, caller: 'fallback-switch', read: async () => input.failures as FailureRecoveryRecord[], ...(input.record ? { record: input.record } : {}) },
  );
  return { decisionWritten, settled: failure.occurrence };
}

/** Reads the three records and the failures, and decides. Null when no plan is on record. */
export async function readSwitchDecision(projectId: string): Promise<FallbackSwitchDecision | null> {
  const [reading, { readProjectIndependence }, { readFallbackPreparation }, { readFailureRecoveries }] = await Promise.all([
    import('./fallbackPlanReading.ts'),
    import('./fallbackIndependence.ts'),
    import('./fallbackPreparation.ts'),
    import('./ledger.ts'),
  ]);
  const [plan, independence, preparation, failures, decisions, paths] = await Promise.all([
    reading.readProjectFallbackPlan(projectId),
    readProjectIndependence(projectId),
    readFallbackPreparation(projectId),
    readFailureRecoveries(projectId),
    reading.readSwitchDecisionRecords(projectId),
    reading.readMeasuredPaths(projectId),
  ]);
  if (!plan) return null;
  const results = (p: AcquisitionPath) => reading.readContactResults(projectId, p);
  const ownRecovered = await reading.ownPathRecoveries(projectId, plan.plan.dependency, paths, results);
  const decision = switchDecision({ plan, independence, preparation, failures, ownRecovered });
  // What Brain tried is kept, and a switch its substitute's rows verify settles the failure. Its own catch:
  // keeping the record never stops the decision a plan reads.
  await keepSwitchOutcome(projectId, decision, { failures, decisions, paths, results }).catch((error: unknown) => {
    console.warn(`[quant] fallback switch outcome unrecorded for ${projectId}: ${String((error as Error)?.message ?? error)}`);
  });
  return decision;
}
