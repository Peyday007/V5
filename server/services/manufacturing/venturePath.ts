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
import type { AcquisitionCandidate, MachineCapitalRequirement } from '../../domain/types.ts';

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
  /** The original's blocking challenges this alternative removes, by kind. */
  resolves?: ChallengeKind[];
  stages: VentureStage[];
  path: Extract<VenturePath, { ok: true }>;
  verdict: VentureVerdict;
}

const MAX_SUBSTITUTION_VARIANTS = 64;

const BLOCKING: ReadonlySet<ChallengeKind> = new Set(['CAPABILITY_NOT_HELD', 'CAPITAL_EXCEEDED', 'ECONOMICALLY_WEAK']);

function blockersOf(verdict: VentureVerdict): ChallengeKind[] {
  return [...new Set(verdict.challenges.filter((c) => BLOCKING.has(c.kind)).map((c) => c.kind))];
}

/**
 * The blocking challenges a substitution removes from an INFEASIBLE original,
 * or null when it is not a material improvement: it leaves a blocker, or it
 * rests on an unknown the original did not (an unpriced stage the original
 * priced, or any other unknown not already named on the original).
 */
function resolvedBlockers(
  base: VentureVerdict,
  original: Extract<VenturePath, { ok: true }>,
  verdict: VentureVerdict,
  path: Extract<VenturePath, { ok: true }>,
): ChallengeKind[] | null {
  if (base.feasibility !== 'INFEASIBLE' || verdict.feasibility !== 'UNDETERMINED') return null;
  if (verdict.challenges.some((c) => BLOCKING.has(c.kind))) return null;
  const wasUnpriced = new Set(original.unpriced);
  for (const c of verdict.challenges) {
    if (c.kind === 'UNPRICED_STAGE') {
      if (!path.unpriced.every((key) => wasUnpriced.has(key))) return null;
      continue;
    }
    if (!base.challenges.some((b) => b.kind === c.kind && b.detail === c.detail)) return null;
  }
  return blockersOf(base);
}

/**
 * Materially different alternatives to a weak or infeasible venture. Pure.
 *
 * Substitutions come only from alternatives the stages carry as evidence; the
 * validate-first variant funds the largest dependency-closed prefix the capital
 * covers and ends at a decision whether to proceed. The original is never
 * discarded by this call.
 *
 * A substitution is returned when it is FEASIBLE, or when it removes every
 * challenge that makes the original INFEASIBLE (capital beyond what is
 * deployable, a capability not held, a return that does not cover the cost)
 * and leaves only unknowns the original already had. The second kind is the
 * one real rows produce: no row states a venture's expected return and no
 * acquisition candidate carries a price, so requiring FEASIBLE dropped every
 * rent, contract, partner, license or buy alternative before anyone saw it.
 * Its verdict stays UNDETERMINED and names those unknowns — a shared unknown
 * never becomes a favourable assumption (invariant 39), and an alternative
 * that adds an unknown of its own (an unpriced stage the original had priced)
 * is still refused, because swapping a known cost for a blank is not a
 * cheaper plan.
 */
export function alternativesFor(
  stages: readonly VentureStage[],
  situation: ResourceSituation,
  economics: VentureEconomics = { expectedReturn: null },
): VentureAlternative[] {
  const out: VentureAlternative[] = [];
  const original = buildVenturePath(stages);
  const base = original.ok ? challengeVenture(original, situation, economics) : null;
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
    const resolves = base && original.ok ? resolvedBlockers(base, original, verdict, path) : null;
    if (verdict.feasibility !== 'FEASIBLE' && resolves === null) continue;
    const differs = stages.flatMap((stage, i) => (combo[i] ? [`${stage.key}: ${stage.mode ?? 'BUILD'} → ${combo[i]!.mode} via ${combo[i]!.actor}`] : []));
    out.push({ kind: 'SUBSTITUTED', differs, stages: variant, path, verdict, resolves: resolves ?? (base ? blockersOf(base) : []) });
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
      /*
       * A stage resting on a fact nobody has established is never funded, and
       * so nothing that consumes it is either (its dependency is not chosen).
       * Funding it would make the unknown look settled and let money be
       * committed downstream of it — tooling or a facility before any demand
       * is on record (invariant 39).
       */
      if ((stage.unknowns ?? []).length > 0) continue;
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
  // The funded prefix is judged on its own unknowns too, never on affordability alone.
  const resting = path.nodes.filter((n) => (n.unknowns ?? []).length > 0);
  if (resting.length > 0) {
    verdict.challenges.push({
      kind: 'BUILT_ON_UNKNOWNS',
      detail: `${resting.length} funded stage(s) rest on facts nobody has established: ${resting.flatMap((n) => n.unknowns ?? []).join('; ')}`,
      stages: resting.map((n) => n.key),
    });
    verdict.feasibility = 'UNDETERMINED';
  }
  if (verdict.feasibility !== 'FEASIBLE') return null;
  const dropped = stages.filter((s) => !chosen.includes(s)).map((s) => s.key);
  return { kind: 'VALIDATE_FIRST', differs: [`funds ${chosen.map((c) => c.key).join(', ')} first; defers ${dropped.join(', ')}`], stages: variant, path, verdict };
}

/* ------------------------------------------------------------------------- */
/* A real venture's stages, from the ladder's rows                            */
/* ------------------------------------------------------------------------- */

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

/**
 * The stages of entering one category, derived from what the ladder has
 * recorded about it, and ordered by what each stage actually consumes. Pure.
 *
 * Two kinds of stage, and neither invents a figure:
 * - stages that stand on a row: each capital requirement established under the
 *   scenario the reading prices (priced from its published high figure, or
 *   withheld), each required capability nobody holds (with the acquisition
 *   candidates on record as BUY alternatives, unpriced because no candidate row
 *   carries a price), and each entry barrier (priced by a certification figure
 *   only when `certificationPricesBarrier` says so);
 * - the decisions and gates every venture passes through: market research,
 *   positioning, specification, unit economics, validation, pricing, channel,
 *   production readiness, the entry decision, launch and scale. They commit no
 *   capital of their own (Brain does the work, or the gate is reached when its
 *   prerequisites are), so they are priced at zero in the venture's currency
 *   and withheld when no currency is on record; what they spend is priced on
 *   the row-backed stages they depend on. Missing demand or distribution
 *   evidence is an unknown on the stage that reads it, so a venture with none
 *   never reads as feasible (invariant 39).
 *
 * The order is not a stored sequence: each stage names the stages whose output
 * it consumes (`CONSUMES` for capital), and only stages that exist for this
 * category are depended on, so the graph's layers emerge from the rows. Money
 * is committed only after unit economics; tooling, stock and certification
 * follow a validated design; production needs every capability, tool, part and
 * barrier it uses; entry needs production and a channel; launch and scale
 * follow the owner's entry decision, because entering commits money
 * (invariant 38).
 */
/** What each capital requirement's commitment consumes, as stage keys; absent keys are ignored. */
const CONSUMES: Readonly<Record<MachineCapitalRequirement, readonly string[]>> = {
  ENGINEERING_AND_DEVELOPMENT: ['unit-economics'],
  INTELLECTUAL_PROPERTY_OR_LICENCE: ['unit-economics'],
  SUPPLIER_ONBOARDING: ['unit-economics'],
  FACILITY: ['unit-economics'],
  TEST_AND_VALIDATION: ['validation'],
  TOOLING_AND_EQUIPMENT: ['validation', 'capital:TEST_AND_VALIDATION'],
  CERTIFICATION_AND_APPROVAL: ['validation', 'capital:TEST_AND_VALIDATION'],
  INVENTORY_AND_PARTS: ['validation', 'capital:TEST_AND_VALIDATION', 'capital:SUPPLIER_ONBOARDING'],
  DISTRIBUTION_AND_SERVICE_NETWORK: ['pricing'],
  WORKING_CAPITAL: ['pricing'],
};

export function stagesFromReading(
  reading: CategoryReading,
  candidates: readonly AcquisitionCandidate[] = [],
): VentureStage[] {
  const subject = reading.path.join(' → ') || reading.categoryId;
  const scenario = reading.capital.cheapestFullyPriced ?? reading.capital.scenarios[0] ?? null;
  const barriers = reading.evidence.against.filter((one) => one.kind === 'ENTRY_BARRIER');
  const incumbents = reading.evidence.against.filter((one) => one.kind === 'INCUMBENT_WEAKNESS');
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
  const committed = entries.filter((entry) => !certification.includes(entry));
  const currency = entries.find((entry) => entry.amountHighMinor !== null && entry.currency !== null)?.currency ?? null;
  // A decision or gate commits no capital of its own; with no currency on record nothing can be priced, so it is withheld.
  const nothing: Money | null = currency ? { currency, amountMinor: 0 } : null;
  const capitalKey = (requirement: string) => `capital:${requirement}`;
  const capabilityKeys = reading.missing.map((gap) => `capability:${gap.capability.id}`);
  const barrierKeys = barriers.map((barrier) => `barrier:${barrier.id}`);
  const capitalKeys = committed.map((entry) => capitalKey(entry.requirement));

  const stages: VentureStage[] = [];
  const gate = (stage: Omit<VentureStage, 'budget'>): void => {
    stages.push({ ...stage, budget: nothing });
  };

  gate({
    key: 'market-research',
    title: `Market research for ${subject}`,
    dependsOn: [],
    decision: `Whether buyers for ${subject} exist in numbers worth serving`,
    resource: 'Brain’s research allowance; no capital is committed',
    artifact: 'The demand evidence on record for the category',
    actor: 'Brain',
    evidence: reading.evidence.demand.map((one) => one.sourceClaimId),
    completion: 'Demand evidence is recorded against the category',
    unknowns: reading.evidence.demand.length === 0 ? [`no demand evidence is on record for ${subject}`] : [],
  });
  gate({
    key: 'positioning',
    title: `Position against what is on the market for ${subject}`,
    dependsOn: ['market-research'],
    decision: 'Which buyers to serve and which weakness of the incumbents to answer',
    resource: 'the demand evidence and the incumbent weaknesses on record',
    artifact: 'A recorded positioning',
    actor: 'Brain',
    evidence: incumbents.map((one) => one.sourceClaimId),
    completion: 'The positioning is recorded with the evidence it rests on',
  });
  gate({
    key: 'specification',
    title: `Specify the product for ${subject}`,
    dependsOn: ['positioning'],
    decision: 'What the product must do, which capabilities it needs and what is bought in',
    resource: 'the positioning, the capability requirements and the bought-in components on record',
    artifact: 'A product specification',
    actor: 'Brain',
    evidence: [
      ...[...reading.missing.map((gap) => gap.capability), ...reading.held].flatMap((one) => (one.sourceClaimId ? [one.sourceClaimId] : [])),
      ...reading.evidence.boughtIn.map((one) => one.sourceClaimId),
    ],
    completion: 'The specification is recorded',
  });
  gate({
    key: 'unit-economics',
    title: `Unit economics for ${subject}`,
    dependsOn: ['specification'],
    decision: 'Whether the specified product can be made and sold at a margin, before any money is committed',
    resource: 'the published capital figures and the specification',
    artifact: 'A unit-economics reading',
    actor: 'Brain',
    evidence: entries.map((one) => one.sourceClaimId),
    completion: 'The unit economics are recorded',
  });

  const has = new Set<string>(['market-research', 'positioning', 'specification', 'unit-economics', 'validation', 'pricing', 'channel', 'production', 'enter', 'launch', ...capitalKeys, ...capabilityKeys, ...barrierKeys]);
  const present = (keys: readonly string[]): string[] => [...new Set(keys.filter((key) => has.has(key)))];

  for (const entry of committed) {
    const budget: Money | null =
      entry.amountHighMinor !== null && entry.currency !== null ? { currency: entry.currency, amountMinor: entry.amountHighMinor } : null;
    const requirement = entry.requirement.toLowerCase().replace(/_/g, ' ');
    stages.push({
      key: capitalKey(entry.requirement),
      title: `${requirement} for ${subject}`,
      dependsOn: present(CONSUMES[entry.requirement] ?? ['unit-economics']),
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
      // The specification is what says the product needs it.
      dependsOn: ['specification'],
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

  gate({
    key: 'validation',
    title: `Prototype and validate the design for ${subject}`,
    // A prototype is built to the specification, once its economics hold, with whatever engineering and rights it needs.
    dependsOn: present(['specification', 'unit-economics', ...['ENGINEERING_AND_DEVELOPMENT', 'INTELLECTUAL_PROPERTY_OR_LICENCE'].map(capitalKey)]),
    decision: 'Whether the prototype meets the specification, or the design changes',
    resource: 'the artifacts of the specification, engineering and licensing stages; their spending is priced on those stages',
    artifact: 'A recorded validation of the design',
    actor: 'Brain, with whoever builds the prototype',
    evidence: [],
    completion: 'The design is recorded as validated',
  });

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
      /*
       * What is certified is the product: a certification-priced barrier is
       * obtained for the validated design, after its testing. A barrier no
       * figure ties to certification still needs the specified offering it
       * applies to, and no more is assumed.
       */
      dependsOn: certification.length > 0 ? present(['validation', capitalKey('TEST_AND_VALIDATION')]) : ['specification'],
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

  gate({
    key: 'pricing',
    title: `Price ${subject}`,
    dependsOn: ['positioning', 'unit-economics'],
    decision: 'The price, on the positioning and the unit economics',
    resource: 'the positioning and the unit-economics reading',
    artifact: 'A recorded price',
    actor: 'Brain recommends; the owner sets it',
    evidence: [],
    completion: 'The price is recorded',
  });
  gate({
    key: 'channel',
    title: `Establish a channel for ${subject}`,
    dependsOn: present(['pricing', capitalKey('DISTRIBUTION_AND_SERVICE_NETWORK')]),
    decision: 'Which channel sells and services the product, on what terms',
    resource: 'the distribution channels on record and the price',
    artifact: 'A recorded channel arrangement',
    actor: 'Brain prepares; the owner agrees terms',
    evidence: reading.evidence.distribution.map((one) => one.sourceClaimId),
    completion: 'A channel is recorded for the product',
    unknowns: reading.evidence.distribution.length === 0 ? [`no distribution channel is on record for ${subject}`] : [],
  });
  gate({
    key: 'production',
    title: `Ready production of ${subject}`,
    dependsOn: present([
      'validation',
      ...['TOOLING_AND_EQUIPMENT', 'FACILITY', 'SUPPLIER_ONBOARDING', 'INVENTORY_AND_PARTS', 'CERTIFICATION_AND_APPROVAL', 'TEST_AND_VALIDATION'].map(capitalKey),
      ...capabilityKeys,
      ...barrierKeys,
    ]),
    decision: 'Whether production can start with the tools, parts, capabilities and approvals in place',
    resource: 'the artifacts of every production prerequisite; their spending is priced on those stages',
    artifact: 'A recorded production-readiness check',
    actor: 'Brain',
    evidence: [],
    completion: 'Production readiness is recorded',
  });
  gate({
    key: 'enter',
    title: `Enter ${subject}`,
    // Every capital, capability and barrier stage reaches the decision through production, the channel or working capital.
    dependsOn: present(['production', 'channel', capitalKey('WORKING_CAPITAL')]),
    decision: `Enter ${subject} on what the prerequisite stages established, change the strategy, or stop`,
    resource: 'the artifacts of every prerequisite stage',
    artifact: 'A recorded entry decision with the evidence it rests on',
    actor: 'the owner, on Brain’s recommendation',
    evidence: [...reading.evidence.demand, ...reading.evidence.distribution].map((one) => one.sourceClaimId),
    completion: 'The entry decision is recorded',
  });
  gate({
    key: 'launch',
    title: `Launch ${subject}`,
    dependsOn: ['enter'],
    decision: 'Release the first units through the channel',
    resource: 'the production run and the channel the entry decision committed',
    artifact: 'A recorded launch',
    actor: 'Brain operates; the owner approves',
    evidence: [],
    completion: 'The first sales are recorded',
  });
  gate({
    key: 'scale',
    title: `Scale ${subject}`,
    dependsOn: ['launch'],
    decision: 'Grow volume, financing and service on what launch established, or hold',
    resource: 'the launch results; any new money is a new commitment the owner makes',
    artifact: 'A recorded scaling decision',
    actor: 'the owner, on Brain’s recommendation',
    evidence: [],
    completion: 'The scaling decision is recorded',
  });
  return stages;
}
