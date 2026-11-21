/**
 * The planningReliability suite's case format (docs/COMPLETION-SPEC.md §5). Public
 * cases are `cases.ts`; hidden cases arrive from Brain's database in exactly this
 * JSON shape (`npm run evolution -- hidden`, `brain_operator_add_hidden_case`).
 *
 * A case is an objective in the owner's words, the openings research has filed
 * for it (each with exactly the evidence it carries), and a rubric written from
 * the arithmetic and the evidence — never from what the planner answers today:
 *
 *   EXECUTABLE_PLAN — a defensible executable plan exists on this evidence, inside
 *                     the objective's constraints; refusing it is a failure.
 *   NO_PLAN         — no executable plan is established yet, and the conclusion
 *                     counts only when it names the decisive blocker: the
 *                     constraint arithmetic rules out (INFEASIBLE), or the link
 *                     of the chain whose evidence is missing or contradicted
 *                     (MISSING_EVIDENCE).
 */
export const EXPECTED_VERDICTS = ['EXECUTABLE_PLAN', 'NO_PLAN'] as const;
export type ExpectedVerdict = (typeof EXPECTED_VERDICTS)[number];

/** The links of a cash plan's causal chain, as the planner checks them (`CHAIN_LINKS`, goals/plan.ts). */
export const LINKS = ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE', 'CONVERSION', 'MARKET_VOLUME', 'FULFILMENT', 'ECONOMICS', 'SETTLES_IN_TIME'] as const;
export type Link = (typeof LINKS)[number];

/** The objective's constraints a conclusion may find rule every plan out. */
export const CONSTRAINTS = ['DEADLINE', 'CAPITAL', 'TARGET', 'OWNER_HOURS'] as const;
export type Constraint = (typeof CONSTRAINTS)[number];

/** Who does the work of one deal. */
export const PERFORMERS = ['BRAIN', 'SUBCONTRACTOR', 'OWNER', 'NOBODY'] as const;
export type Performer = (typeof PERFORMERS)[number];

/**
 * What a measured conversion counts against: the denominator the evidence was taken
 * on. A landing page's paid pre-orders are counted against VISITORS; a service
 * business's wins against the QUOTES it sent, its bookings against PROPOSALS or ad
 * CLICKS, a tender's awards against BIDS, an outreach play's agreements against the
 * CONTACTS asked, and a marketplace's or association's orders against its MEMBERS.
 */
export const CONVERSION_UNITS = ['VISITORS', 'QUOTES', 'PROPOSALS', 'BIDS', 'CLICKS', 'CONTACTS', 'MEMBERS'] as const;
export type ConversionUnit = (typeof CONVERSION_UNITS)[number];

/**
 * An opening's measured conversion: `paid` commitments out of `of`, counted in `unit`
 * (VISITORS when absent). `{ paid, visitors }` is the format's first spelling and
 * still reads, as VISITORS.
 */
export type Conversion =
  | { paid: number; of: number; unit?: ConversionUnit }
  | { paid: number; visitors: number };

/** The conversion's count, denominator and unit, whichever spelling the case used. */
export function conversionCounts(c: Conversion): { paid: number; of: number; unit: ConversionUnit } {
  if ('of' in c) return { paid: c.paid, of: c.of, unit: c.unit ?? 'VISITORS' };
  return { paid: c.paid, of: c.visitors, unit: 'VISITORS' };
}

/**
 * The sentence the world records on the card's `conversionRates` field, in the unit's
 * own words — the evidence as research would file it, never restated as visitors. A
 * VISITORS conversion reads exactly as every case did before units existed.
 */
export function conversionSentence(c: Conversion): string {
  const { paid, of, unit } = conversionCounts(c);
  const n = (x: number) => x.toLocaleString('en-US');
  switch (unit) {
    case 'VISITORS': return `${paid} paid pre-orders from ${of} unique visitors`;
    case 'QUOTES': return `${n(paid)} wins from ${n(of)} quotes`;
    case 'PROPOSALS': return `${n(paid)} bookings from ${n(of)} proposals`;
    case 'BIDS': return `${n(paid)} contracts won from ${n(of)} bids`;
    case 'CLICKS': return `${n(paid)} bookings from ${n(of)} clicks`;
    case 'CONTACTS': return `${n(paid)} agreements from ${n(of)} contacts`;
    case 'MEMBERS': return `${n(paid)} orders from ${n(of)} members`;
  }
}

/** The coverage dimensions every case is tagged with (spec §4). */
export interface CaseDimensions {
  capital: 'none' | 'small' | 'large';
  target: 'small' | 'medium' | 'large' | 'out-of-reach';
  deadline: 'short' | 'long';
  industry: string;
  mechanism: string;
  autonomy: 'unlimited' | 'owner-hours-limited';
  /** The chain link whose evidence is missing, or 'none'. */
  missingEvidence: Link | 'none';
  contradictoryEvidence: boolean;
  objectiveChanged: boolean;
}

/**
 * One opening research filed, with exactly the evidence it carries. Every figure is
 * USD. A field left out is a fact nobody established (the planner sweeps it); a
 * figure given is sourced evidence unless its basis says a person only said so.
 */
export interface OpeningFixture {
  /** The case's own name for it; the rubric names openings by this. */
  key: string;
  title: string;
  /** A `CASH_MECHANISMS` value. */
  mechanism: string;
  industry: string;
  /** Who pays; null when nobody established it. Defaults to `<industry> buyers`. */
  payer?: string | null;
  /** How the buyer is reached; null when nobody established it. */
  channel?: string | null;
  /** Days since a dated buying signal was observed; null when there is none. Defaults to 3. */
  signalDaysAgo?: number | null;
  offer?: string;
  /** The price of one deal (a month of it when `monthly`). */
  price: number;
  /** EVIDENCE: a source shows buyers pay it. PERSON: somebody only said so. */
  priceBasis?: 'EVIDENCE' | 'PERSON';
  /** A second sourced price that contradicts the first: the record states this figure as the evidenced price. */
  priceContradiction?: number;
  monthly?: boolean;
  /** Direct cost of one deal; null or absent when nobody established it. */
  cost?: number | null;
  /** Money tied up before it pays. Defaults to 0 (established). */
  capital?: number;
  /** Days from start to usable cash; null or absent when nobody established it. */
  daysToCash?: number | null;
  /** Hours of work one deal takes. */
  hours?: number;
  performer: Performer;
  /** The named fulfiller when SUBCONTRACTOR. */
  subcontractor?: string;
  /** A sentence on how many buyers exist and how often they buy (makes it repeatable). */
  volume?: string | null;
  /** EVIDENCE (default): a source states it. ESTIMATE: Brain's own estimate, which establishes nothing. */
  volumeBasis?: 'EVIDENCE' | 'ESTIMATE';
  /** This offer's own measured commitments, counted in their real unit (VISITORS when absent). */
  conversion?: Conversion | null;
  /** Written buyer acceptances already held, USD each. */
  agreements?: number[];
}

export interface Rubric {
  verdict: ExpectedVerdict;
  /**
   * NO_PLAN only: the decisive blocker the conclusion must name.
   *
   *   INFEASIBLE        — a constraint of the objective rules every plan out. Named when the
   *                       planner's infeasibility conclusion relaxes it, a strategy reports it
   *                       broken, or (when `links` is given) the planner names the chain link
   *                       that carries it (a capital limit is the ECONOMICS link's).
   *   MISSING_EVIDENCE  — the evidence of one of `links` is missing or contradicted; named when
   *                       the planner judges that link missing (on `opening`, when given).
   */
  blocker?:
    | { kind: 'INFEASIBLE'; constraints: Constraint[]; links?: Link[] }
    | { kind: 'MISSING_EVIDENCE'; links: Link[]; opening?: string };
  /** Openings a correct plan may not use: out of scope, over a limit, unsound, contested. */
  mustNotUse?: string[];
  /** The most one member may tie up (USD), when the objective sets it. */
  capitalMax?: number | null;
  /** Owner hours the plan's members may take in all (the objective's hours over its window). */
  ownerHoursMax?: number | null;
  /** The economics bound: a member's direct cost may be at most this share of its price. Default 1 (a positive margin). */
  maxCostShare?: number;
  /** With `changedObjective`: the target (USD) the changed words state, which the plan must be read against. */
  targetAfterChange?: number;
}

export interface PlanningCase {
  id: string;
  /** Unfamiliar industry or mechanism, not used by the existing transfer fixtures. */
  heldOut: boolean;
  /** What is being tested, and why the rubric's answer is the correct one. */
  description: string;
  dimensions: CaseDimensions;
  /** The objective in the owner's words, as a goal is created from them. */
  objective: string;
  /**
   * The objective changed mid-plan: the plan is read once on `objective`, the goal's
   * objective is changed to these words through `changeObjective`, and the second
   * reading is graded against the rubric (which is written for the changed objective).
   */
  changedObjective?: string;
  openings: OpeningFixture[];
  expect: Rubric;
}

const VERDICTS = new Set<string>(EXPECTED_VERDICTS);
const LINK_SET = new Set<string>(LINKS);
const CONSTRAINT_SET = new Set<string>(CONSTRAINTS);
const PERFORMER_SET = new Set<string>(PERFORMERS);
const UNIT_SET = new Set<string>(CONVERSION_UNITS);

function conversionProblem(key: string, c: unknown): string | null {
  if (c === undefined || c === null) return null;
  if (typeof c !== 'object') return `opening ${key} has a conversion that is not an object`;
  const v = c as { paid?: unknown; of?: unknown; visitors?: unknown; unit?: unknown };
  const of = v.of ?? v.visitors;
  if (typeof v.paid !== 'number' || !(v.paid >= 0) || typeof of !== 'number' || !(of > 0) || v.paid > of) return `opening ${key} has a conversion without paid ≤ of`;
  if (v.unit !== undefined && (typeof v.unit !== 'string' || !UNIT_SET.has(v.unit))) return `opening ${key} has an unknown conversion unit`;
  if (v.unit !== undefined && v.of === undefined) return `opening ${key} states a conversion unit without "of"`;
  return null;
}

/** Why a value is not a case, or null when it is. A malformed hidden case fails; it is never skipped. */
export function caseProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not an object';
  const c = value as Partial<PlanningCase>;
  if (typeof c.id !== 'string' || !c.id) return 'no id';
  if (typeof c.objective !== 'string' || !c.objective.trim()) return 'no objective';
  if (c.changedObjective !== undefined && (typeof c.changedObjective !== 'string' || !c.changedObjective.trim())) return 'changedObjective is not words';
  if (!Array.isArray(c.openings)) return 'openings is not a list';
  const keys = new Set<string>();
  for (const o of c.openings) {
    if (!o || typeof o !== 'object' || typeof o.key !== 'string' || typeof o.title !== 'string') return 'an opening has no key or title';
    if (keys.has(o.key)) return `opening key ${o.key} repeats`;
    keys.add(o.key);
    if (typeof o.price !== 'number' || !(o.price > 0)) return `opening ${o.key} has no price`;
    if (!PERFORMER_SET.has(o.performer)) return `opening ${o.key} has an unknown performer`;
    if (typeof o.mechanism !== 'string' || typeof o.industry !== 'string') return `opening ${o.key} has no mechanism or industry`;
    const conversion = conversionProblem(o.key, o.conversion);
    if (conversion) return conversion;
  }
  const e = c.expect;
  if (!e || !VERDICTS.has(e.verdict)) return 'expect.verdict is neither EXECUTABLE_PLAN nor NO_PLAN';
  if (e.verdict === 'NO_PLAN') {
    const b = e.blocker;
    if (!b) return 'a NO_PLAN rubric names no blocker';
    if (b.kind === 'INFEASIBLE' && (!Array.isArray(b.constraints) || !b.constraints.length || b.constraints.some((x) => !CONSTRAINT_SET.has(x)))) return 'unknown infeasible constraint';
    if (b.kind === 'INFEASIBLE' && b.links !== undefined && (!Array.isArray(b.links) || b.links.some((x) => !LINK_SET.has(x)))) return 'unknown alternative link';
    if (b.kind === 'MISSING_EVIDENCE' && (!Array.isArray(b.links) || !b.links.length || b.links.some((x) => !LINK_SET.has(x)))) return 'unknown missing link';
    if (b.kind !== 'INFEASIBLE' && b.kind !== 'MISSING_EVIDENCE') return 'unknown blocker kind';
    if (b.kind === 'MISSING_EVIDENCE' && b.opening !== undefined && !keys.has(b.opening)) return 'the blocker names an opening the case does not hold';
  }
  for (const k of e.mustNotUse ?? []) if (!keys.has(k)) return `mustNotUse names ${k}, which the case does not hold`;
  if (!c.dimensions || typeof c.dimensions !== 'object') return 'no dimensions';
  return null;
}
