import type { Archetype, DesignState, MagicColor, MagicFormat } from '../../../domain/magicTypes.ts';
import type { Role } from '../analysis/tags.ts';

export type Speed = 'fast' | 'medium' | 'slow';
export type Risk = 'consistency' | 'power' | 'balanced';
export type WinEngine = 'lifedrain' | 'combat' | 'combo' | 'tokens' | 'alt-win' | 'artifacts' | 'sacrifice';

export type HardConstraint =
  | { kind: 'format'; format: MagicFormat }
  | { kind: 'budget'; cents: number }
  | { kind: 'colors'; colors: MagicColor[] }
  | { kind: 'exclude'; name: string }
  | { kind: 'owned-only' };

/** Structured intent. Every field says whether it was stated or assumed. */
export interface DesignIntent {
  idea: string;
  revision: number;
  format: MagicFormat;
  primaryOutcome: 'win' | 'survive' | 'value' | 'unspecified';
  archetypes: Archetype[];
  speed: Speed | null;
  defensive: boolean;
  curve: 'high' | 'low' | null;
  earlyMana: boolean;
  winEngines: WinEngine[];
  /** Roles the person asked for; they steer the build and the optimizer's preference score. */
  secondaryPreferences: Role[];
  hardConstraints: HardConstraint[];
  /** Adjustable: nothing here is a rule, and each weight is one the person can move. */
  weights: { consistency: number; speed: number; interaction: number; closing: number };
  risk: Risk;
  collection: 'owned-only' | 'any';
  budgetCents: number | null;
  opponents: number;
  playstyle: string;
  assumptions: string[];
  /** Conflicts already resolved by a chosen alternative. */
  resolved: string[];
  history: { revision: number; utterance: string }[];
}

export interface Conflict {
  id: 'DEFENSIVE_VS_FAST_CLOSE' | 'DEFENSIVE_NO_CLOSER' | 'HIGH_CURVE_NO_EARLY_MANA';
  name: string;
  /** What the person pays for wanting both. */
  cost: string;
}

export interface Alternative {
  id: string;
  conflict: Conflict['id'];
  title: string;
  summary: string;
  tradeoffs: string[];
  patch: Partial<Pick<DesignIntent, 'speed' | 'defensive' | 'curve' | 'earlyMana' | 'risk'>> & {
    addWinEngines?: WinEngine[];
    addPreferences?: Role[];
    addArchetypes?: Archetype[];
  };
}

export interface Question {
  conflict: Conflict['id'];
  text: string;
  options: { id: string; title: string }[];
}

export interface DesignPlan {
  state: DesignState;
  intent: DesignIntent;
  conflicts: Conflict[];
  alternatives: Alternative[];
  /** At most one; null when proceeding on stated assumptions. */
  question: Question | null;
  /** Provisional assumptions made instead of asking. */
  assumptions: string[];
}
