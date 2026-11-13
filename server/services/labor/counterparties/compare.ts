/**
 * Choosing a primary and an alternative fulfiller, and saying how much of the
 * comparison is established.
 *
 * Cost, capacity and timing are compared only where they are VERIFIED. A
 * candidate whose price is pending is not cheaper than one whose price is
 * verified, and a candidate whose capacity is unknown does not have enough: an
 * unknown never ranks higher, and every compared figure names the facts still
 * missing. Pure, lexicographic and unweighted — a score needs weights nobody
 * chose (`allocate.ts` and `portfolio.ts` settled this).
 *
 * Ranking order, each rule only breaking the tie of the one above:
 *   1. the stage reached on the ladder (further is better);
 *   2. how many of cost, capacity and timing are verified;
 *   3. verified cost, lower first;
 *   4. verified lead time, shorter first;
 *   5. id, so the result is deterministic.
 *
 * A candidate is ineligible, not merely lower, when its verified capacity is
 * short of the commitment, its geography is verified outside the commitment's,
 * or the commitment needs a human operator and the candidate has none.
 * Geography is a label on the candidate; nothing here knows where the owner is.
 */
import {
  factFor,
  effectiveStatus,
  humanRequirementReading,
  readLadder,
  stageIndex,
  type Counterparty,
  type HumanRequirement,
  type LadderReading,
  type MissingFact,
  type Stage,
} from './ladder.ts';

export interface Commitment {
  id: string;
  /** Units of capacity the commitment needs from one counterparty. */
  capacityUnits: number;
  /** Acceptable geographies as labels; absent means any. */
  geographies?: readonly string[];
  humanRequirement?: HumanRequirement | null;
}

export type FigureName = 'cost' | 'capacity' | 'timing';

const FIGURE_DIMENSION: Readonly<Record<FigureName, string>> = { cost: 'price', capacity: 'availableCapacity', timing: 'leadTime' };

export interface Figure {
  name: FigureName;
  /** The number, only when the fact is VERIFIED. A pending number is shown in `claimed`, never here. */
  value: number | null;
  claimed: number | null;
  status: 'VERIFIED' | 'PENDING' | 'UNKNOWN';
  missing: MissingFact[];
}

export interface CandidateReading {
  counterpartyId: string;
  kind: string;
  geography: string | null;
  ladder: LadderReading;
  stage: Stage | null;
  figures: Record<FigureName, Figure>;
  verifiedFigures: number;
  eligible: boolean;
  /** Why it is ineligible; empty when eligible. */
  reasons: string[];
  /** Things not yet known that bear on the choice, as tasks. */
  open: string[];
  human: ReturnType<typeof humanRequirementReading>;
}

export interface Comparison {
  commitmentId: string;
  primary: CandidateReading | null;
  alternative: CandidateReading | null;
  ranked: CandidateReading[];
  ineligible: CandidateReading[];
  /** Present when the commitment needs a person or role Brain cannot be. */
  humanRequirement: HumanRequirement | null;
  /** True when a person or role is required, whatever the candidates say. */
  needsHumanOperator: boolean;
}

function figureOf(counterparty: Counterparty, name: FigureName): Figure {
  const dimension = FIGURE_DIMENSION[name];
  const fact = factFor(counterparty.facts, dimension);
  const numeric = fact && typeof fact.value === 'number' && Number.isFinite(fact.value) ? fact.value : null;
  if (!fact) return { name, value: null, claimed: null, status: 'UNKNOWN', missing: [{ dimension, state: 'ABSENT' }] };
  const status = effectiveStatus(fact);
  if (status === 'VERIFIED' && numeric !== null) return { name, value: numeric, claimed: numeric, status: 'VERIFIED', missing: [] };
  // A verified fact that states no number is not a figure to compare.
  if (status === 'VERIFIED') return { name, value: null, claimed: null, status: 'UNKNOWN', missing: [{ dimension, state: 'UNKNOWN' }] };
  const state = status === 'UNKNOWN' || status === 'NOT_APPLICABLE' ? 'UNKNOWN' : 'PENDING';
  return { name, value: null, claimed: numeric, status: state, missing: [{ dimension, state }] };
}

export function readCandidate(counterparty: Counterparty, commitment: Commitment): CandidateReading {
  const ladder = readLadder(counterparty);
  const figures = { cost: figureOf(counterparty, 'cost'), capacity: figureOf(counterparty, 'capacity'), timing: figureOf(counterparty, 'timing') };
  const human = humanRequirementReading(commitment.humanRequirement, counterparty);
  const reasons: string[] = [];
  if (figures.capacity.value !== null && figures.capacity.value < commitment.capacityUnits) {
    reasons.push(`verified capacity ${figures.capacity.value} is below the ${commitment.capacityUnits} the commitment needs`);
  }
  const geography = counterparty.geography ?? null;
  if (commitment.geographies && commitment.geographies.length > 0 && geography !== null) {
    const geographyFact = factFor(counterparty.facts, 'geography');
    const verified = geographyFact ? effectiveStatus(geographyFact) === 'VERIFIED' : false;
    if (verified && !commitment.geographies.includes(geography)) reasons.push(`verified geography ${geography} is outside the commitment's`);
  }
  if (human.required && human.satisfied === false) reasons.push('the commitment needs a human operator or role and this counterparty names none');
  const open: string[] = [];
  for (const figure of Object.values(figures)) for (const m of figure.missing) open.push(`${figure.name}: ${m.dimension} is ${m.state.toLowerCase()}`);
  if (commitment.geographies && commitment.geographies.length > 0 && geography === null) open.push('geography: not stated');
  return {
    counterpartyId: counterparty.id,
    kind: counterparty.kind,
    geography,
    ladder,
    stage: ladder.stage,
    figures,
    verifiedFigures: Object.values(figures).filter((f) => f.status === 'VERIFIED').length,
    eligible: reasons.length === 0,
    reasons,
    open,
    human,
  };
}

const worst = Number.POSITIVE_INFINITY;

function order(a: CandidateReading, b: CandidateReading): number {
  return (
    stageIndex(b.stage) - stageIndex(a.stage) ||
    b.verifiedFigures - a.verifiedFigures ||
    (a.figures.cost.value ?? worst) - (b.figures.cost.value ?? worst) ||
    (a.figures.timing.value ?? worst) - (b.figures.timing.value ?? worst) ||
    a.counterpartyId.localeCompare(b.counterpartyId)
  );
}

export function compareFulfillers(commitment: Commitment, candidates: readonly Counterparty[]): Comparison {
  const readings = candidates.map((candidate) => readCandidate(candidate, commitment));
  const ranked = readings.filter((r) => r.eligible).sort(order);
  return {
    commitmentId: commitment.id,
    primary: ranked[0] ?? null,
    alternative: ranked[1] ?? null,
    ranked,
    ineligible: readings.filter((r) => !r.eligible),
    humanRequirement: commitment.humanRequirement ?? null,
    needsHumanOperator: Boolean(commitment.humanRequirement),
  };
}
