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

import type { CategoryReading } from './readiness.ts';
import type { AcquisitionCandidate } from '../../domain/types.ts';

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

/* ------------------------------------------------------------------------- */
/* A real venture's stages, from the ladder's rows                            */
/* ------------------------------------------------------------------------- */

/**
 * The stages of entering one category, derived from what the ladder has
 * recorded about it, and nothing else. Pure.
 *
 * Every stage stands on a row:
 * - each capital requirement established under the scenario the reading
 *   prices (the cheapest fully priced one, otherwise the smallest one anything
 *   was found for) is a stage, priced from its published high figure or
 *   withheld when no figure is published;
 * - each required capability nobody holds is a stage, with the acquisition
 *   candidates recorded as supplying it as BUY alternatives (unpriced, because
 *   no candidate row carries a price, so an alternative never reads as
 *   feasible on figures nobody published);
 * - each entry barrier established is a stage of its own, because a barrier is
 *   a thing to obtain and never an amount (`readiness.ts`).
 *
 * The rows state no dependency between two requirements, so none is invented:
 * they share the first layer and may run in parallel. What they all feed is
 * the entry decision, which depends on every one of them and is the owner's to
 * take, because entering commits money (invariant 38). Missing demand or
 * distribution evidence is carried on that decision as an unknown, so a
 * venture with none never reads as feasible (invariant 39).
 */
/**
 * Whether a certification figure pays for the barrier on record.
 *
 * One rule, read by the venture path here and by the institutional plan
 * (`institutionReading.ventureFactsFor`), so the two never disagree about the
 * same rows: when exactly one entry barrier is established, a published
 * CERTIFICATION_AND_APPROVAL figure is what obtaining it costs. With several
 * barriers no row says which one the figure pays for, so none is priced by it
 * and nothing is guessed (invariant 39).
 */
export function certificationPricesBarrier(barrierCount: number): boolean {
  return barrierCount === 1;
}

export function stagesFromReading(
  reading: CategoryReading,
  candidates: readonly AcquisitionCandidate[] = [],
): VentureStage[] {
  const subject = reading.path.join(' → ') || reading.categoryId;
  const scenario = reading.capital.cheapestFullyPriced ?? reading.capital.scenarios[0] ?? null;
  const stages: VentureStage[] = [];
  const barriers = reading.evidence.against.filter((one) => one.kind === 'ENTRY_BARRIER');
  const entries = scenario ? [...scenario.priced, ...scenario.unpriced] : [];
  /*
   * A certification figure that prices the one barrier on record is that
   * barrier's budget, not a second, unlinked stage. Before, the barrier stage
   * was always unpriced, so a category with any barrier withheld its total and
   * read UNDETERMINED for ever — capital arriving could never make it
   * FEASIBLE, and the reconsideration never fired — while the institutional
   * plan had already tied the same figure to the same barrier.
   */
  const certification = certificationPricesBarrier(barriers.length)
    ? entries.filter((entry) => entry.requirement === 'CERTIFICATION_AND_APPROVAL')
    : [];

  for (const entry of entries) {
    if (certification.includes(entry)) continue;
    const budget: Money | null =
      entry.amountHighMinor !== null && entry.currency !== null ? { currency: entry.currency, amountMinor: entry.amountHighMinor } : null;
    const requirement = entry.requirement.toLowerCase().replace(/_/g, ' ');
    stages.push({
      key: `capital:${entry.requirement}`,
      title: `${requirement} for ${subject}`,
      dependsOn: [],
      decision: `Commit to the ${requirement} the ${entry.scenario.toLowerCase().replace(/_/g, ' ')} scenario requires`,
      resource: budget ? `${budget.amountMinor} ${budget.currency} (minor units), published ${entry.asOf}` : 'an amount nobody has published',
      artifact: entry.statement,
      actor: 'Brain prepares; the owner commits the money',
      budget,
      evidence: [entry.sourceClaimId],
      completion: `The ${requirement} is in place and recorded`,
    });
  }

  for (const gap of reading.missing) {
    const capability = gap.capability;
    const supplying = candidates.filter((one) => one.capabilityId === capability.id && one.setAsideAt === null);
    stages.push({
      key: `capability:${capability.id}`,
      title: `Hold ${capability.name}`,
      dependsOn: [],
      decision: `Develop ${capability.name}, or obtain it from someone who holds it`,
      resource: gap.taughtBy.length > 0 ? `taught by ${gap.taughtBy.map((one) => one.name).join(', ')}` : 'no category on the ladder teaches it yet',
      artifact: `A person's record that this company holds ${capability.name}`,
      actor: 'the owner, who alone records a capability as held',
      budget: null,
      evidence: capability.sourceClaimId ? [capability.sourceClaimId] : [],
      completion: `${capability.name} is recorded as held`,
      requiresCapabilityIds: [capability.id],
      alternatives: supplying.map((one) => ({
        mode: 'BUY' as const,
        actor: one.name,
        budget: null,
        requiresCapabilityIds: [],
        evidence: [one.sourceClaimId],
      })),
    });
  }

  // The barrier's price, when a certification figure pays for it: every such row priced and in one currency, else withheld.
  const fees = certification.map((entry) =>
    entry.amountHighMinor !== null && entry.currency !== null ? { currency: entry.currency, amountMinor: entry.amountHighMinor } : null,
  );
  const fee: Money | null =
    fees.length > 0 && fees.every((one) => one !== null && one.currency === fees[0]!.currency)
      ? { currency: fees[0]!.currency, amountMinor: fees.reduce((sum, one) => sum + one!.amountMinor, 0) }
      : null;
  for (const barrier of barriers) {
    stages.push({
      key: `barrier:${barrier.id}`,
      title: `Obtain ${barrier.subject}`,
      dependsOn: [],
      decision: `Pursue ${barrier.subject}, or find a holder of it to work through`,
      resource: fee
        ? `${fee.amountMinor} ${fee.currency} (minor units), the certification and approval figure published ${certification.map((one) => one.asOf).join(', ')}`
        : certification.length > 0
          ? 'the certification and approval figure on record is not fully published'
          : 'whatever the issuing body requires; not an amount on record',
      artifact: barrier.statement,
      actor: 'Brain prepares; the owner or the holder applies',
      budget: fee,
      evidence: [barrier.sourceClaimId, ...certification.map((one) => one.sourceClaimId)],
      completion: `${barrier.subject} is obtained and recorded`,
    });
  }

  const unknowns: string[] = [];
  if (reading.evidence.demand.length === 0) unknowns.push(`no demand evidence is on record for ${subject}`);
  if (reading.evidence.distribution.length === 0) unknowns.push(`no distribution channel is on record for ${subject}`);
  const currency = stages.find((one) => one.budget)?.budget?.currency ?? null;
  stages.push({
    key: 'enter',
    title: `Enter ${subject}`,
    dependsOn: stages.map((one) => one.key),
    decision: `Enter ${subject} on what the prerequisite stages established, change the strategy, or stop`,
    resource: 'the artifacts of every prerequisite stage',
    artifact: 'A recorded entry decision with the evidence it rests on',
    actor: 'the owner, on Brain’s recommendation',
    budget: currency ? { currency, amountMinor: 0 } : null,
    evidence: [...reading.evidence.demand, ...reading.evidence.distribution].map((one) => one.sourceClaimId),
    completion: 'The entry decision is recorded',
    unknowns,
  });
  return stages;
}
