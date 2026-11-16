/**
 * The feasibility suite's case format. Public cases are `cases.ts`; hidden
 * cases arrive from Brain's database in exactly this JSON shape.
 *
 * Every case puts one opening (the subject) through one real judgement of the
 * plan machinery and states what a correct judgement is:
 *
 *   REFUSE — the machinery must not treat the subject as available: it is
 *            excluded, flagged, ineligible or not executable, because what
 *            would make it available is a hypothetical answer to a constraint.
 *   ACCEPT — a negative control: the constraint IS satisfied, and refusing the
 *            subject would be over-refusal.
 */
import type { GapKind } from '../../server/services/goals/pathways.ts';
import type { OpeningSpec } from '../spec.ts';

export const CASE_CLASSES = [
  /** One deal costs more than the money behind the plan, and nothing shows a buyer's money carrying it. */
  'UNFUNDED_DEAL',
  /** The buyer is assumed to pay before delivery with no stated terms showing it. */
  'PREPAYMENT_UNEVIDENCED',
  /** A capability nobody established (Brain's or a named fulfiller's) is assumed to deliver. */
  'CAPABILITY_NOT_HELD',
  /** An unknown condition is read as a favourable figure (invariant 39). */
  'UNKNOWN_AS_FAVOURABLE',
  /** A hard constraint — the deadline, the capital one arrangement may tie up — is relaxed. */
  'CONSTRAINT_RELAXED',
  /** An award won once is read as a repeating sale. */
  'AWARD_AS_REPEATABLE',
  /** A constructed estimate (§82) is read as an executable opening. */
  'ESTIMATE_AS_EXECUTABLE',
] as const;
export type CaseClass = (typeof CASE_CLASSES)[number];

export type Verdict = 'ACCEPT' | 'REFUSE';

/** Which real judgement is read, and what ACCEPT means for it. */
export type Judgement =
  /** `pathwayOf` (through `readPathways`): ACCEPT when the pathway is executable. */
  | { kind: 'pathway.executable' }
  /** ACCEPT when the pathway does NOT carry the gap. */
  | { kind: 'pathway.gap'; gap: GapKind }
  /** ACCEPT when the fact is published as established (a status other than UNKNOWN, with a value). */
  | { kind: 'pathway.established'; fact: 'net' | 'capacity' | 'conversion' | 'fulfiller' | 'daysToCash' | 'volume' | 'revenuePerDeal' }
  /** ACCEPT when the pathway's frequency reads as repeating. */
  | { kind: 'pathway.repeats' }
  /** `livingPortfolio`: ACCEPT when the subject is a member of the leading combination. */
  | { kind: 'portfolio.leading' }
  /** ACCEPT when the living portfolio lists the subject as executable. */
  | { kind: 'portfolio.executable' }
  /** `informationValue`: ACCEPT when an answer on the variable is said to be able to change the plan. */
  | { kind: 'information.changesPlan'; variable: 'price' | 'directCost' | 'conversion' | 'volume' | 'daysToCash' }
  /** `byCollectibility`: ACCEPT when the subject ranks at or above the comparator. */
  | { kind: 'rank.collectibility'; comparator: string }
  /** `prepaymentEligible`: ACCEPT when the financing lever may read the cost as paid from the buyer's money. */
  | { kind: 'prepayment' }
  /** `bestCaseReach`: ACCEPT when the opening is credited any reach. */
  | { kind: 'scenario.bestCaseReach' }
  /** `evaluateGoalPortfolio`: ACCEPT when the subject is not refused. */
  | { kind: 'engine.admitted' }
  /** ACCEPT when the subject is a member of the engine's best combination. */
  | { kind: 'engine.inBest' }
  /** ACCEPT when the subject settles cash inside the window: a member of the best combination, whose settled p90 > 0. */
  | { kind: 'engine.cash' }
  /** ACCEPT when the engine counts more than one deal for the subject (deals p90 > 1). */
  | { kind: 'engine.repeats' }
  /** ACCEPT when the engine does not list the named input as unestablished. */
  | { kind: 'engine.established'; input: string }
  /** ACCEPT when the engine calls the reading a probability. */
  | { kind: 'engine.probability' }
  /** `reconstructPlan`: ACCEPT when the strongest plan concluded with rests on the subject. */
  | { kind: 'reconstruction.best' }
  /** ACCEPT when the reconstruction tries the prepaid-fulfilment lever. */
  | { kind: 'reconstruction.prepaidLever' };

export interface CaseContext {
  remaining: number;
  daysLeft: number;
  capitalCeiling: number | null;
  /** The before-proof limit: what one arrangement may tie up. */
  beforeProof: number | null;
  perWeek: number | null;
  resources: string | null;
  permissionsMissing: string[];
  capabilities: { delivers: string[]; puzzleFormats: string[] } | null;
  required: number;
}

export interface FeasibilityCase {
  id: string;
  class: CaseClass;
  /** What is being tested, and why the expected judgement is the correct one. */
  description: string;
  context?: Partial<CaseContext>;
  subject: OpeningSpec;
  others?: OpeningSpec[];
  judgement: Judgement;
  expect: Verdict;
}

/** Brain's deliverables as the capability frame proves them, and the puzzle formats it generates (plan.ts brainCapabilities). */
export const DEFAULT_CAPABILITIES = {
  delivers: ['business document', 'spreadsheet', 'presentation', 'data operations', 'website', 'programming'],
  puzzleFormats: ['sudoku', 'word-search'],
};

/** The $10K goal's limits (production, 2026-11-15): $3,000 in all, $375 per arrangement before proof, 24 days left. */
export const DEFAULT_CONTEXT: CaseContext = {
  remaining: 10_000,
  daysLeft: 24,
  capitalCeiling: 3000,
  beforeProof: 375,
  perWeek: 750,
  resources: null,
  permissionsMissing: [],
  capabilities: DEFAULT_CAPABILITIES,
  required: 0.9,
};

const JUDGEMENTS = new Set<Judgement['kind']>([
  'pathway.executable', 'pathway.gap', 'pathway.established', 'pathway.repeats', 'portfolio.leading', 'portfolio.executable',
  'information.changesPlan', 'rank.collectibility', 'prepayment', 'scenario.bestCaseReach', 'engine.admitted', 'engine.inBest',
  'engine.cash', 'engine.repeats', 'engine.established', 'engine.probability', 'reconstruction.best', 'reconstruction.prepaidLever',
]);

/** Why a value is not a case, or null when it is. Hidden cases are checked before they run; a malformed one fails, it is not skipped. */
export function caseProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not an object';
  const c = value as Partial<FeasibilityCase>;
  if (typeof c.id !== 'string' || !c.id) return 'no id';
  if (!CASE_CLASSES.includes(c.class as CaseClass)) return `unknown class`;
  if (c.expect !== 'ACCEPT' && c.expect !== 'REFUSE') return 'expect is neither ACCEPT nor REFUSE';
  if (!c.judgement || !JUDGEMENTS.has(c.judgement.kind)) return 'unknown judgement';
  if (!c.subject || typeof c.subject.id !== 'string' || typeof c.subject.title !== 'string') return 'no subject';
  if (c.others !== undefined && !Array.isArray(c.others)) return 'others is not a list';
  return null;
}
