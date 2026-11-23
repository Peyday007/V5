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
  /**
   * What the price's source says, in its own words, filed as the card's price evidence
   * (absent: the bare figure, `$<price>`). It is how a case states what the money is —
   * a buyer's purchase price, a commission, or a reward, grant or prize paid the other
   * way — so the planner must read the evidence, never a label the case hands it. It
   * must restate the card's figure (`price`), or it reads as a contradicting price.
   */
  priceEvidence?: string;
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
  /**
   * Openings whose evidenced figure is not money the payer pays for the deliverable: a
   * reward, bounty, grant, prize, rebate, reimbursement, settlement, donation, stipend or
   * wage — paid for something else, or the other way. A correct reading never counts it
   * as an established price in its candidate (`NON_PURCHASE_PRICE`).
   */
  notAPurchasePrice?: string[];
  /**
   * The most deals an opening's payer(s) can make inside the window, from the evidence —
   * 1 for one named organisation's one procurement. A reading whose candidate models more
   * is sweeping one payer as a population (`PAYER_POPULATION_INFLATED`).
   */
  payerDealsMax?: Record<string, number>;
}

/**
 * One change to the case's world after a plan was read (adaptation). Each is applied to
 * the same goal and the same openings through the write path production uses for it
 * (`applyChange`, world.ts), and the plan is read again after it.
 *
 *   OBJECTIVE              — the owner restates the objective in words (`changeObjective`): its
 *                            amount, deadline and limits move with the words. `changedObjective`
 *                            is exactly one of these.
 *   TARGET                 — the target becomes `amount` USD (`setTarget`; limits kept).
 *   DEADLINE               — the goal is now due `days` days after the change (`setTerms`).
 *   CAPITAL                — the owner's starting capital is now `capital` USD: the most the
 *                            goal may tie up (`setTargetLimits`, capital ceiling).
 *   CONSTRAINT             — a limit is added (`limit` a number: USD for CAPITAL, total hours for
 *                            OWNER_HOURS) or removed (`limit` null) (`setTargetLimits`).
 *   BUYER_UNAVAILABLE      — the opening's buyer is gone: the opening is archived with the reason
 *                            (`archiveOpportunity`). A correct plan no longer uses it.
 *   SUPPLIER_COST          — the opening's direct cost per deal is now `cost` USD (a new quote,
 *                            recorded as the card's directCosts evidence).
 *   DAYS_TO_CASH           — the opening now takes `days` days to usable cash (timeToFirstCash
 *                            evidence).
 *   CONTRADICTING_EVIDENCE — a new source states `value` for the opening's `field`, contradicting
 *                            the figure the card carries (today: `price`, as `priceContradiction`
 *                            files it).
 */
export const CHANGE_KINDS = ['OBJECTIVE', 'TARGET', 'DEADLINE', 'CAPITAL', 'CONSTRAINT', 'BUYER_UNAVAILABLE', 'SUPPLIER_COST', 'DAYS_TO_CASH', 'CONTRADICTING_EVIDENCE'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The limits a CONSTRAINT change adds or removes. */
export const CHANGEABLE_CONSTRAINTS = ['CAPITAL', 'OWNER_HOURS'] as const;
/** The figures a CONTRADICTING_EVIDENCE change can contradict. */
export const CONTRADICTABLE_FIELDS = ['price'] as const;

export type WorldChange =
  | { kind: 'OBJECTIVE'; objective: string }
  | { kind: 'TARGET'; amount: number }
  | { kind: 'DEADLINE'; days: number }
  | { kind: 'CAPITAL'; capital: number }
  | { kind: 'CONSTRAINT'; constraint: (typeof CHANGEABLE_CONSTRAINTS)[number]; limit: number | null }
  | { kind: 'BUYER_UNAVAILABLE'; opening: string; reason?: string }
  | { kind: 'SUPPLIER_COST'; opening: string; cost: number }
  | { kind: 'DAYS_TO_CASH'; opening: string; days: number }
  | { kind: 'CONTRADICTING_EVIDENCE'; opening: string; field: (typeof CONTRADICTABLE_FIELDS)[number]; value: number };

/**
 * One step of an adaptation case: a change, then a re-read. `expect` is the rubric for the
 * reading after this change; the last step takes none — the case's own `expect` is the
 * final reading's rubric, exactly as it is for a `changedObjective` case. A middle step
 * without `expect` is applied and read, and not graded.
 */
export interface ChangeStep {
  change: WorldChange;
  expect?: Rubric;
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
   * Exactly `changes: [{ change: { kind: 'OBJECTIVE', objective: <these words> } }]`.
   */
  changedObjective?: string;
  /**
   * Adaptation: changes applied in order to the same world after the first plan is read,
   * each followed by a re-read (`changeSteps`, `caseAtStep`). Not together with `changedObjective`.
   */
  changes?: ChangeStep[];
  /** With `changes`: the rubric for the first reading, before any change. Ungraded when absent. */
  expectInitial?: Rubric;
  openings: OpeningFixture[];
  /** The rubric of the final reading: after the last change, or the only reading when nothing changes. */
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
  const rubric = rubricProblem(e, keys);
  if (rubric) return rubric;
  if (c.changes !== undefined) {
    if (c.changedObjective !== undefined) return 'changedObjective and changes are both given; state the objective change as a change';
    if (!Array.isArray(c.changes) || !c.changes.length) return 'changes is not a non-empty list';
    for (const [i, step] of c.changes.entries()) {
      if (!step || typeof step !== 'object') return `change ${i + 1} is not an object`;
      const change = changeProblem(step.change, keys);
      if (change) return `change ${i + 1}: ${change}`;
      if (step.expect !== undefined) {
        if (i === c.changes.length - 1) return `change ${i + 1} is the last; its rubric is the case's own expect`;
        const r = rubricProblem(step.expect, keys);
        if (r) return `change ${i + 1}: ${r}`;
      }
    }
  }
  if (c.expectInitial !== undefined) {
    if (c.changes === undefined) return 'expectInitial is given without changes';
    const r = rubricProblem(c.expectInitial, keys);
    if (r) return `expectInitial: ${r}`;
  }
  if (!c.dimensions || typeof c.dimensions !== 'object') return 'no dimensions';
  return null;
}

function rubricProblem(e: Rubric | undefined, keys: Set<string>): string | null {
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
  if (e.notAPurchasePrice !== undefined && !Array.isArray(e.notAPurchasePrice)) return 'notAPurchasePrice is not a list';
  for (const k of e.notAPurchasePrice ?? []) if (!keys.has(k)) return `notAPurchasePrice names ${k}, which the case does not hold`;
  if (e.payerDealsMax !== undefined) {
    if (!e.payerDealsMax || typeof e.payerDealsMax !== 'object' || Array.isArray(e.payerDealsMax)) return 'payerDealsMax is not a map of opening to deals';
    for (const [k, n] of Object.entries(e.payerDealsMax)) {
      if (!keys.has(k)) return `payerDealsMax names ${k}, which the case does not hold`;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return `payerDealsMax for ${k} is not a whole number of deals`;
    }
  }
  return null;
}

const CHANGE_KIND_SET = new Set<string>(CHANGE_KINDS);
const isAmount = (x: unknown, min = 0): x is number => typeof x === 'number' && Number.isFinite(x) && x > min;

/** Why a value is not a change this format states, or null when it is one. */
export function changeProblem(value: unknown, keys: ReadonlySet<string>): string | null {
  if (!value || typeof value !== 'object') return 'no change';
  const ch = value as Record<string, unknown>;
  if (typeof ch['kind'] !== 'string' || !CHANGE_KIND_SET.has(ch['kind'])) return `unknown change kind ${String(ch['kind'])}`;
  const opening = () => (typeof ch['opening'] === 'string' && keys.has(ch['opening']) ? null : `names opening ${String(ch['opening'])}, which the case does not hold`);
  switch (ch['kind'] as ChangeKind) {
    case 'OBJECTIVE':
      return typeof ch['objective'] === 'string' && ch['objective'].trim() ? null : 'the objective is not words';
    case 'TARGET':
      return isAmount(ch['amount']) ? null : 'the target is not a positive amount';
    case 'DEADLINE':
      return isAmount(ch['days']) && Number.isInteger(ch['days']) ? null : 'days is not a positive whole number';
    case 'CAPITAL':
      return typeof ch['capital'] === 'number' && Number.isFinite(ch['capital']) && ch['capital'] >= 0 ? null : 'capital is not an amount';
    case 'CONSTRAINT':
      if (!(CHANGEABLE_CONSTRAINTS as readonly unknown[]).includes(ch['constraint'])) return `a constraint change names ${String(ch['constraint'])}, not ${CHANGEABLE_CONSTRAINTS.join(' or ')}`;
      return ch['limit'] === null || (typeof ch['limit'] === 'number' && Number.isFinite(ch['limit']) && ch['limit'] >= 0) ? null : 'limit is neither a figure nor null (removed)';
    case 'BUYER_UNAVAILABLE':
      return opening() ?? (ch['reason'] === undefined || (typeof ch['reason'] === 'string' && ch['reason'].trim()) ? null : 'the reason is not words');
    case 'SUPPLIER_COST':
      return opening() ?? (typeof ch['cost'] === 'number' && Number.isFinite(ch['cost']) && ch['cost'] >= 0 ? null : 'cost is not an amount');
    case 'DAYS_TO_CASH':
      return opening() ?? (isAmount(ch['days']) ? null : 'days is not positive');
    case 'CONTRADICTING_EVIDENCE':
      if (!(CONTRADICTABLE_FIELDS as readonly unknown[]).includes(ch['field'])) return `contradicting evidence on ${String(ch['field'])}, not ${CONTRADICTABLE_FIELDS.join(' or ')}`;
      return opening() ?? (isAmount(ch['value']) ? null : 'the contradicting value is not a positive amount');
  }
}

/** The case's changes, in order: `changes`, or the one objective change `changedObjective` states, or none. */
export function changeSteps(c: Pick<PlanningCase, 'changedObjective' | 'changes'>): ChangeStep[] {
  if (c.changes?.length) return c.changes;
  if (c.changedObjective) return [{ change: { kind: 'OBJECTIVE', objective: c.changedObjective } }];
  return [];
}

/** Changes that move the goal's own terms (what it counts, by when, with what), as opposed to the world's openings. */
const GOAL_CHANGES: ReadonlySet<ChangeKind> = new Set(['OBJECTIVE', 'TARGET', 'DEADLINE', 'CAPITAL', 'CONSTRAINT']);

/**
 * The case as it stands after its first `step` changes (0: before any), in the shape the
 * grader already judges: the objective's current words, the openings' current evidence,
 * and that step's rubric. `grade(caseAtStep(c, k), observe(readings[k]))` judges reading k.
 *
 *  - A goal change sets `changedObjective` (to the words now in force), so a failure to
 *    follow it is the grader's OBJECTIVE_CHANGE_IGNORED; a TARGET change also states the
 *    target the reading must carry (`targetAfterChange`, unless the rubric gives one).
 *  - An opening change rewrites that opening's fixture (cost, days to cash, contradicting
 *    price), and a buyer that became unavailable joins the rubric's `mustNotUse`.
 *  - `changes`/`expectInitial` are removed, so the result reads as a single-reading case.
 *
 * Returns null for a step with no rubric (a middle step left ungraded, or the first
 * reading without `expectInitial`), or a step past the end.
 */
export function caseAtStep(c: PlanningCase, step: number): PlanningCase | null {
  const steps = changeSteps(c);
  if (step < 0 || step > steps.length) return null;
  const rubric = step === 0 ? (steps.length ? (c.expectInitial ?? null) : c.expect) : step === steps.length ? c.expect : (steps[step - 1]!.expect ?? null);
  if (!rubric) return null;
  let words = c.objective;
  let goalChanged = false;
  let target: number | undefined;
  const unavailable: string[] = [];
  const openings = c.openings.map((o) => ({ ...o }));
  const fixture = (key: string) => openings.find((o) => o.key === key)!;
  for (const { change } of steps.slice(0, step)) {
    if (GOAL_CHANGES.has(change.kind)) goalChanged = true;
    switch (change.kind) {
      case 'OBJECTIVE':
        words = change.objective;
        target = undefined;
        break;
      case 'TARGET':
        target = change.amount;
        break;
      case 'BUYER_UNAVAILABLE':
        unavailable.push(change.opening);
        break;
      case 'SUPPLIER_COST':
        fixture(change.opening).cost = change.cost;
        break;
      case 'DAYS_TO_CASH':
        fixture(change.opening).daysToCash = change.days;
        break;
      case 'CONTRADICTING_EVIDENCE':
        fixture(change.opening).priceContradiction = change.value;
        break;
      default:
        break;
    }
  }
  const expect: Rubric = { ...rubric };
  if (unavailable.length) expect.mustNotUse = [...new Set([...(rubric.mustNotUse ?? []), ...unavailable])];
  if (target !== undefined && expect.targetAfterChange === undefined) expect.targetAfterChange = target;
  const { changes: _changes, expectInitial: _initial, changedObjective: _changed, ...rest } = c;
  return { ...rest, openings, expect, ...(goalChanged ? { changedObjective: words } : {}) };
}
