import type { MagicColor, MagicFormat, NumberLabel, PriceStatus } from '../../../domain/magicTypes.ts';
import type { RuleCard, ValidationIssue } from '../rules/validate.ts';
import type { Role } from '../analysis/tags.ts';

/** A real catalog card with the facts the rules, the analysis and the budget need. */
export interface OptCard extends RuleCard {
  manaCost?: string;
  cmc?: number;
  producedMana?: ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[];
  entersTapped?: boolean;
  colorIdentity: MagicColor[];
  /** Integer USD cents for the exact printing chosen; null when no price is known. */
  priceCents: number | null;
  priceStatus: PriceStatus | null;
}

export interface DeckLine {
  zone: 'commander' | 'main' | 'sideboard';
  quantity: number;
  card: OptCard;
}

export const OBJECTIVES = [
  'consistency', 'earlyDevelopment', 'threatsAnswered', 'survival',
  'independentClosing', 'pointsPotential', 'price', 'preferenceMatch',
] as const;
export type Objective = (typeof OBJECTIVES)[number];
export type Weights = Record<Objective, number>;

export interface OptimizeConstraints {
  /** Names that may never be cut. */
  protectedNames?: string[];
  /** Names that may never be added. */
  excludedNames?: string[];
  /** Ceiling on the money spent on additions, in cents. */
  priceCeilingCents?: number | null;
  /** When true, only copies already owned may be added. */
  ownedOnly?: boolean;
  /** Copies owned, by card name; a deck's own cards count as owned. */
  owned?: Record<string, number>;
}

export interface OptimizeInput {
  format: MagicFormat;
  deck: DeckLine[];
  pool: OptCard[];
  analysisDate: string;
  constraints?: OptimizeConstraints;
  weights?: Partial<Weights>;
  preferredRoles?: Role[];
  opponents?: number;
  beamWidth?: number;
  maxSwaps?: number;
  /** Cap on swaps scored per search level; the order they are tried in is fixed. */
  maxScoredPerLevel?: number;
  topN?: number;
}

export interface ScoreComponent {
  name: string;
  value: number;
  label: NumberLabel;
}

export interface ObjectiveScore {
  value: number;
  label: NumberLabel;
  components: ScoreComponent[];
  uncertainty: string;
}

export interface Swap {
  cut: string;
  add: string;
  addPriceCents: number | null;
}

export interface ScoredBuild {
  key: string;
  swaps: Swap[];
  /** Cents spent on added copies beyond those already owned. */
  costCents: number;
  objectives: Record<Objective, ObjectiveScore>;
  /** Weighted sum of the objectives: a HEURISTIC_SCORE, never a win rate. */
  composite: { value: number; label: NumberLabel; note: string };
  /** Objective by objective, this build minus the unchanged baseline. */
  vsBaseline: Record<Objective, number>;
}

export interface UpgradeRanking {
  swap: Swap;
  gain: number;
  costCents: number;
  /** Composite gain (price excluded) per dollar; null when the swap is free. */
  gainPerDollar: number | null;
  free: boolean;
}

export interface OptimizeResult {
  format: MagicFormat;
  baseline: {
    valid: boolean;
    issues: ValidationIssue[];
    build: ScoredBuild;
  };
  candidates: ScoredBuild[];
  frontier: ScoredBuild[];
  upgrades: UpgradeRanking[];
  recommended: ScoredBuild;
  comparison: string;
  weights: Weights;
  searched: { scored: number; rejected: number; levels: number };
  notes: string[];
}
