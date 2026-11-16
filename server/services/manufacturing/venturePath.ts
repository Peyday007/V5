/**
 * A venture as a connected, revisable path, and whether it can be walked with
 * what this company has now (VENT-24-2).
 *
 * ---------------------------------------------------------------------------
 * The order is the dependencies, and nothing else
 * ---------------------------------------------------------------------------
 *
 * Market research, positioning, specification, feasibility, unit economics,
 * prototype, sourcing, production, pricing, channel, service, launch,
 * financing, scale — the specification lists them, and listing them in that
 * order would be the stored sequence the manufacturing directive refuses
 * (`priority.ts`). So the builder takes whatever stages the venture names, with
 * their declared dependencies, and derives the order: every stage whose
 * dependencies are done shares a layer and can run in parallel, and a cycle is
 * refused by name rather than broken arbitrarily.
 *
 * ---------------------------------------------------------------------------
 * A challenge is named, and a weak plan is rebuilt rather than dropped
 * ---------------------------------------------------------------------------
 *
 * A budget beyond deployable capital, a stage that needs a capability nobody
 * holds, and a plan whose outcome rests on unknowns are each a named challenge.
 * An unknown never makes a venture feasible (invariant 39): a total with an
 * unpriced stage is withheld, as `capital.ts` withholds one. When the original
 * strategy fails, the builder composes materially different alternatives from
 * the alternatives the stages themselves carry (contract it, partner for it,
 * license it) and a validate-first variant that funds only the dependency-closed
 * prefix the capital covers. It never discards the venture (invariant 47).
 *
 * Pure. The kernel re-reads capital and held capabilities from rows on every
 * tick and hands them in (`kernel.ts`), which is what makes a venture that was
 * out of reach become reachable without anybody restating it.
 */

export type StageMode = 'BUILD' | 'CONTRACT' | 'PARTNER' | 'LICENSE' | 'BUY';

export interface Money {
  currency: string;
  amountMinor: number;
}

/** One way of doing a stage other than the planned one, as the evidence states it. */
export interface StageAlternative {
  mode: StageMode;
  actor: string;
  /** Null when no figure is published: the alternative is then never feasible on its own figures. */
  budget: Money | null;
  requiresCapabilityIds: string[];
  evidence: string[];
}

export interface VentureStage {
  key: string;
  title: string;
  dependsOn: string[];
  decision: string;
  resource: string;
  artifact: string;
  actor: string;
  mode?: StageMode;
  /** Null when no figure is published. Never read as zero. */
  budget: Money | null;
  evidence: string[];
  completion: string;
  requiresCapabilityIds?: string[];
  /** Facts the stage's outcome rests on that nobody has established. */
  unknowns?: string[];
  alternatives?: StageAlternative[];
}

export interface VentureNode extends Omit<VentureStage, 'budget' | 'mode'> {
  mode: StageMode;
  layer: number;
  budget: { state: 'PRICED'; money: Money } | { state: 'WITHHELD'; because: string };
}

export type VenturePath =
  | { ok: true; layers: string[][]; nodes: VentureNode[]; total: Money | null; unpriced: string[] }
  | { ok: false; refused: 'CYCLE' | 'UNKNOWN_DEPENDENCY' | 'DUPLICATE_STAGE'; detail: string; stages: string[] };

/** Order a venture's stages by their declared dependencies. Pure. */
export function buildVenturePath(stages: readonly VentureStage[]): VenturePath {
  const byKey = new Map<string, VentureStage>();
  for (const stage of stages) {
    if (byKey.has(stage.key)) return { ok: false, refused: 'DUPLICATE_STAGE', detail: `stage ${stage.key} is named twice`, stages: [stage.key] };
    byKey.set(stage.key, stage);
  }
  for (const stage of stages) {
    const missing = stage.dependsOn.filter((dep) => !byKey.has(dep));
    if (missing.length > 0) {
      return { ok: false, refused: 'UNKNOWN_DEPENDENCY', detail: `stage ${stage.key} depends on ${missing.join(', ')}, which the venture does not name`, stages: [stage.key, ...missing] };
    }
  }

  const layerOf = new Map<string, number>();
  const layers: string[][] = [];
  let remaining = stages.map((s) => s.key);
  while (remaining.length > 0) {
    const ready = remaining.filter((key) => byKey.get(key)!.dependsOn.every((dep) => layerOf.has(dep)));
    if (ready.length === 0) {
      const cycle = findCycle(remaining, byKey);
      return { ok: false, refused: 'CYCLE', detail: `the stages depend on each other in a cycle: ${cycle.join(' → ')}`, stages: cycle };
    }
    for (const key of ready) layerOf.set(key, layers.length);
    layers.push(ready);
    remaining = remaining.filter((key) => !layerOf.has(key));
  }

  const nodes: VentureNode[] = stages.map((stage) => ({
    ...stage,
    mode: stage.mode ?? 'BUILD',
    layer: layerOf.get(stage.key)!,
    budget: stage.budget
      ? { state: 'PRICED', money: stage.budget }
      : { state: 'WITHHELD', because: `no published figure for "${stage.title}", so no total may include it` },
  }));
  const unpriced = nodes.filter((n) => n.budget.state === 'WITHHELD').map((n) => n.key);
  return { ok: true, layers, nodes, total: unpriced.length > 0 ? null : sumMoney(nodes.map((n) => (n.budget as { money: Money }).money)), unpriced };
}

function findCycle(keys: readonly string[], byKey: ReadonlyMap<string, VentureStage>): string[] {
  const inSet = new Set(keys);
  const state = new Map<string, 'VISITING' | 'DONE'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    state.set(key, 'VISITING');
    stack.push(key);
    for (const dep of byKey.get(key)!.dependsOn) {
      if (!inSet.has(dep)) continue;
      if (state.get(dep) === 'VISITING') return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, 'DONE');
    return null;
  };
  for (const key of keys) {
    if (state.has(key)) continue;
    const found = visit(key);
    if (found) return found;
  }
  return [...keys];
}

/** Sum amounts of one currency; null when the currencies differ, because a mixed sum is not a figure. */
function sumMoney(items: readonly Money[]): Money | null {
  if (items.length === 0) return null;
  const currency = items[0]!.currency;
  if (items.some((m) => m.currency !== currency)) return null;
  return { currency, amountMinor: items.reduce((a, m) => a + m.amountMinor, 0) };
}

/* ------------------------------------------------------------------------- */
/* Challenges                                                                 */
/* ------------------------------------------------------------------------- */

export type ChallengeKind = 'CAPITAL_EXCEEDED' | 'CAPITAL_UNKNOWN' | 'CAPABILITY_NOT_HELD' | 'UNPRICED_STAGE' | 'BUILT_ON_UNKNOWNS' | 'ECONOMICALLY_WEAK';

export interface Challenge {
  kind: ChallengeKind;
  detail: string;
  stages: string[];
}

export type Feasibility = 'FEASIBLE' | 'INFEASIBLE' | 'UNDETERMINED';

export interface ResourceSituation {
  /** Deployable capital in one currency, read from the money ledger; null when it could not be read. */
  available: Money | null;
  heldCapabilityIds: ReadonlySet<string>;
}

/**
 * The resource reading one venture shares with the kernel's per-category one,
 * so a category and a full path cannot disagree about what "affordable" means.
 */
export function assessResources(input: {
  budget: Money | null;
  missingCapabilities: { id: string; stage: string }[];
  situation: ResourceSituation;
}): { feasibility: Feasibility; challenges: Challenge[] } {
  const challenges: Challenge[] = [];
  for (const gap of input.missingCapabilities) {
    challenges.push({ kind: 'CAPABILITY_NOT_HELD', detail: `${gap.stage} needs capability ${gap.id}, which this company does not hold`, stages: [gap.stage] });
  }
  const { available } = input.situation;
  if (input.budget === null) {
    challenges.push({ kind: 'UNPRICED_STAGE', detail: 'what it costs is not fully published, so affordability cannot be read', stages: [] });
  } else if (available === null || available.currency !== input.budget.currency) {
    challenges.push({ kind: 'CAPITAL_UNKNOWN', detail: `deployable capital in ${input.budget.currency} could not be read`, stages: [] });
  } else if (input.budget.amountMinor > available.amountMinor) {
    challenges.push({
      kind: 'CAPITAL_EXCEEDED',
      detail: `needs ${input.budget.amountMinor} and ${available.amountMinor} ${available.currency} (minor units) is deployable`,
      stages: [],
    });
  }
  const blocking = challenges.some((c) => c.kind === 'CAPABILITY_NOT_HELD' || c.kind === 'CAPITAL_EXCEEDED');
  const unknown = challenges.some((c) => c.kind === 'UNPRICED_STAGE' || c.kind === 'CAPITAL_UNKNOWN');
  return { feasibility: blocking ? 'INFEASIBLE' : unknown ? 'UNDETERMINED' : 'FEASIBLE', challenges };
}

export interface VentureEconomics {
  /** What the venture is expected to return over the horizon, when established. */
  expectedReturn: Money | null;
}

export interface VentureVerdict {
  feasibility: Feasibility;
  challenges: Challenge[];
}

/** Challenge one built path against the resources and economics in hand. Pure. */
export function challengeVenture(
  path: Extract<VenturePath, { ok: true }>,
  situation: ResourceSituation,
  economics: VentureEconomics = { expectedReturn: null },
): VentureVerdict {
  const missing = path.nodes.flatMap((n) =>
    (n.requiresCapabilityIds ?? []).filter((id) => !situation.heldCapabilityIds.has(id)).map((id) => ({ id, stage: n.key })),
  );
  const { challenges } = assessResources({ budget: path.total, missingCapabilities: missing, situation });
  const resting = path.nodes.filter((n) => (n.unknowns ?? []).length > 0);
  if (resting.length > 0) {
    challenges.push({
      kind: 'BUILT_ON_UNKNOWNS',
      detail: `${resting.length} stage(s) rest on facts nobody has established: ${resting.flatMap((n) => n.unknowns ?? []).join('; ')}`,
      stages: resting.map((n) => n.key),
    });
  }
  if (economics.expectedReturn === null) {
    challenges.push({ kind: 'BUILT_ON_UNKNOWNS', detail: 'the expected return is not established', stages: [] });
  } else if (path.total && economics.expectedReturn.currency === path.total.currency && economics.expectedReturn.amountMinor <= path.total.amountMinor) {
    challenges.push({
      kind: 'ECONOMICALLY_WEAK',
      detail: `expected return ${economics.expectedReturn.amountMinor} does not exceed the cost ${path.total.amountMinor} ${path.total.currency}`,
      stages: [],
    });
  }
  const blocking = challenges.some((c) => c.kind === 'CAPABILITY_NOT_HELD' || c.kind === 'CAPITAL_EXCEEDED' || c.kind === 'ECONOMICALLY_WEAK');
  const unknown = challenges.some((c) => c.kind === 'UNPRICED_STAGE' || c.kind === 'CAPITAL_UNKNOWN' || c.kind === 'BUILT_ON_UNKNOWNS');
  return { feasibility: blocking ? 'INFEASIBLE' : unknown ? 'UNDETERMINED' : 'FEASIBLE', challenges };
}

/* ------------------------------------------------------------------------- */
/* Alternatives                                                               */
/* ------------------------------------------------------------------------- */

export interface VentureAlternative {
  kind: 'SUBSTITUTED' | 'VALIDATE_FIRST';
  /** What differs from the original, stage by stage. */
  differs: string[];
  stages: VentureStage[];
  path: Extract<VenturePath, { ok: true }>;
  verdict: VentureVerdict;
}

const MAX_SUBSTITUTION_VARIANTS = 64;

/**
 * Materially different alternatives to a weak or infeasible venture. Pure.
 *
 * Substitutions come only from alternatives the stages carry as evidence; the
 * validate-first variant funds the largest dependency-closed prefix the capital
 * covers and ends at a decision whether to proceed. Only FEASIBLE ones are
 * returned, and the original is never discarded by this call.
 */
export function alternativesFor(
  stages: readonly VentureStage[],
  situation: ResourceSituation,
  economics: VentureEconomics = { expectedReturn: null },
): VentureAlternative[] {
  const out: VentureAlternative[] = [];
  const options = stages.map((s) => [null, ...(s.alternatives ?? [])] as (StageAlternative | null)[]);
  let combos: (StageAlternative | null)[][] = [[]];
  for (const choice of options) {
    combos = combos.flatMap((prefix) => choice.map((alt) => [...prefix, alt]));
    if (combos.length > MAX_SUBSTITUTION_VARIANTS) combos = combos.slice(0, MAX_SUBSTITUTION_VARIANTS);
  }
  for (const combo of combos) {
    if (combo.every((alt) => alt === null)) continue;
    const variant = stages.map((stage, i) => {
      const alt = combo[i];
      if (!alt) return stage;
      return {
        ...stage,
        mode: alt.mode,
        actor: alt.actor,
        budget: alt.budget,
        requiresCapabilityIds: alt.requiresCapabilityIds,
        evidence: alt.evidence,
        alternatives: [],
      };
    });
    const path = buildVenturePath(variant);
    if (!path.ok) continue;
    const verdict = challengeVenture(path, situation, economics);
    if (verdict.feasibility !== 'FEASIBLE') continue;
    const differs = stages.flatMap((stage, i) => (combo[i] ? [`${stage.key}: ${stage.mode ?? 'BUILD'} → ${combo[i]!.mode} via ${combo[i]!.actor}`] : []));
    out.push({ kind: 'SUBSTITUTED', differs, stages: variant, path, verdict });
  }

  const first = validateFirst(stages, situation);
  if (first) out.push(first);
  return out;
}

function validateFirst(stages: readonly VentureStage[], situation: ResourceSituation): VentureAlternative | null {
  const full = buildVenturePath(stages);
  if (!full.ok || !situation.available) return null;
  const chosen: VentureStage[] = [];
  let spent = 0;
  for (const layer of full.layers) {
    for (const key of layer) {
      const stage = stages.find((s) => s.key === key)!;
      if (!stage.dependsOn.every((dep) => chosen.some((c) => c.key === dep))) continue;
      if (!stage.budget || stage.budget.currency !== situation.available.currency) continue;
      if ((stage.requiresCapabilityIds ?? []).some((id) => !situation.heldCapabilityIds.has(id))) continue;
      if (spent + stage.budget.amountMinor > situation.available.amountMinor) continue;
      chosen.push(stage);
      spent += stage.budget.amountMinor;
    }
  }
  if (chosen.length === 0 || chosen.length === stages.length) return null;
  const gate: VentureStage = {
    key: 'decide-to-proceed',
    title: 'Decide whether to proceed on what validation established',
    dependsOn: chosen.filter((c) => !chosen.some((d) => d.dependsOn.includes(c.key))).map((c) => c.key),
    decision: 'Proceed, change the strategy, or stop, on the evidence the funded stages produced',
    resource: 'The artifacts of the funded stages',
    artifact: 'A recorded decision',
    actor: 'Brain, within the programme grant',
    budget: { currency: situation.available.currency, amountMinor: 0 },
    evidence: chosen.flatMap((c) => c.evidence),
    completion: 'The decision is recorded with the evidence it rests on',
  };
  const variant = [...chosen, gate];
  const path = buildVenturePath(variant);
  if (!path.ok) return null;
  const verdict = assessResources({ budget: path.total, missingCapabilities: [], situation });
  if (verdict.feasibility !== 'FEASIBLE') return null;
  const dropped = stages.filter((s) => !chosen.includes(s)).map((s) => s.key);
  return { kind: 'VALIDATE_FIRST', differs: [`funds ${chosen.map((c) => c.key).join(', ')} first; defers ${dropped.join(', ')}`], stages: variant, path, verdict };
}
