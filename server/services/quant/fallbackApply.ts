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
 * the ledger's failure/recovery rows (`ledger.ts readFailureRecoveries`) and
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
import type { ProjectFallbackPlanRecord } from './fallbackPlanReading.ts';
import type { ProjectIndependenceRecord } from './fallbackIndependence.ts';
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
}): FallbackSwitchDecision | null {
  const record = input.plan;
  if (!record) return null;
  const { plan, chains } = record;
  const primaryPath = chains[0]?.primaryPath ?? plan.dependency;
  const modeKeys = new Set(plan.failureModes.map((m) => m.key));
  const open = input.failures.filter((f) => f.dependency === plan.dependency && f.recovered !== true && modeKeys.has(f.failureMode));
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

/** Reads the three records and the failures, and decides. Null when no plan is on record. */
export async function readSwitchDecision(projectId: string): Promise<FallbackSwitchDecision | null> {
  const [{ readProjectFallbackPlan }, { readProjectIndependence }, { readFallbackPreparation }, { readFailureRecoveries }] = await Promise.all([
    import('./fallbackPlanReading.ts'),
    import('./fallbackIndependence.ts'),
    import('./fallbackPreparation.ts'),
    import('./ledger.ts'),
  ]);
  const [plan, independence, preparation, failures] = await Promise.all([
    readProjectFallbackPlan(projectId),
    readProjectIndependence(projectId),
    readFallbackPreparation(projectId),
    readFailureRecoveries(projectId),
  ]);
  return switchDecision({ plan, independence, preparation, failures });
}
