/**
 * The goal-to-plan path for an app-hosted planning session (Opus in the owner's Claude app).
 *
 * The session reasons and revises; Brain supplies its machinery (route admission, the real
 * planner `readGoalPlan`, plan integrity, cash accounting) and keeps the record. This module is
 * the pure part: the goal contract the session plans against, the plan revision it submits, the
 * digests that bind context, calculations, review and final output to one revision, and the
 * checks whose concrete failures are returned to the author for revision.
 *
 * Rules this module enforces (build brief, 2026-11-26):
 *   - the owner's words travel with the interpreted fields; a changed objective invalidates every
 *     revision built on the old one;
 *   - total spending, pre-proof spending and working-capital exposure are separate limits, each
 *     checked; committed (not yet spent) obligations count; customer receipts never raise a limit;
 *   - an unknown stays unknown (null) — never 0, 0.5 or 1 — and a plan resting on one is at most
 *     CONDITIONAL;
 *   - a simulated reach is never presented as a known chance unless calibrated;
 *   - evidence about one buyer population is not transferred to another;
 *   - a truncated or failed result, or an unavailable reviewer, never certifies anything.
 *
 * Pure: no database, no model call, no clock (callers pass dates).
 */
import { createHash } from 'node:crypto';
import type { PlanExecutor } from './planReady.ts';

export type { PlanExecutor } from './planReady.ts';

/** Canonical JSON: keys sorted at every level, so one content always has one digest. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 24);
}

// ------------------------------------------------------------------------------- goal contract

/** What the session interpreted from the owner's words. Every money figure is in cents; null = the owner set none. */
export interface ContractTerms {
  targetCents: number;
  currency: string;
  /** What counts toward the target, in the owner's sense: collected customer payments, settled cash, profit… */
  metric: string;
  /** The execution window in days (the clock starts with commercial execution), or null when a calendar date governs. */
  windowDays: number | null;
  /** All spending in the window, including spending funded by customer receipts. */
  totalSpendCapCents: number | null;
  /** Cumulative spending before proof of demand, across every attempt and route. */
  preProofSpendCapCents: number | null;
  /** Owner money that may be out of pocket at any moment (working-capital exposure). */
  exposureCapCents: number | null;
  /** The owner's own proof-of-demand condition, in words; null when none was stated (then proof is not "first payment" by default). */
  proofCondition: string | null;
  ownerHoursPerWeek: number | null;
  ownerPhysicalWork: 'FORBIDDEN' | 'ALLOWED' | 'UNSTATED';
  /** Openings, sectors or assets the plan may not use. */
  exclusions: string[];
  /** Sources the owner said are not evidence (e.g. his own campaign history as demand evidence). */
  evidenceExclusions: string[];
}

export interface GoalContract {
  goalId: string;
  /** The owner's words, verbatim, and where they came from. */
  words: string;
  source: { kind: 'OWNER_MESSAGE' | 'GOAL_RECORD'; ref: string; at: string };
  terms: ContractTerms;
  /** Why an interpreted term differs from the stored goal record, per term; a difference without one is refused. */
  explanations: Partial<Record<keyof ContractTerms, string>>;
  version: number;
  digest: string;
}

/** What the stored goal record says, read through Brain's target reader (no re-parsing of words here). */
export interface StoredGoalTerms {
  targetCents: number | null;
  currency: string | null;
  windowDays: number | null;
  capitalCeilingCents: number | null;
  capitalBeforeProofCents: number | null;
  hoursCeiling: number | null;
}

export function contractDigest(c: Pick<GoalContract, 'goalId' | 'words' | 'terms'>): string {
  return digestOf({ goalId: c.goalId, words: c.words, terms: c.terms });
}

/**
 * Differences between the session's reading and the goal record that nobody explained. The
 * record is Brain's own reading of the owner's words; a disagreement is either explained (the
 * owner said something the record cannot hold, e.g. "$2,000 total spending" next to a $300
 * pre-proof ceiling) or refused.
 */
export function contractMismatches(terms: ContractTerms, stored: StoredGoalTerms, explanations: GoalContract['explanations']): string[] {
  const out: string[] = [];
  const check = (key: keyof ContractTerms, mine: number | string | null, theirs: number | string | null, label: string) => {
    if (theirs === null || mine === theirs) return;
    if ((explanations[key] ?? '').trim()) return;
    out.push(`${label}: the contract says ${mine ?? 'none'}, the stored goal says ${theirs}; explain the difference or correct it`);
  };
  check('targetCents', terms.targetCents, stored.targetCents, 'target');
  check('currency', terms.currency, stored.currency, 'currency');
  check('windowDays', terms.windowDays, stored.windowDays, 'window');
  check('preProofSpendCapCents', terms.preProofSpendCapCents, stored.capitalBeforeProofCents, 'pre-proof spending cap');
  // The record's single capital ceiling may hold either the total-spend cap or the exposure cap; it must equal one of them.
  if (stored.capitalCeilingCents !== null && stored.capitalCeilingCents !== terms.totalSpendCapCents && stored.capitalCeilingCents !== terms.exposureCapCents
    && !(explanations.totalSpendCapCents ?? explanations.exposureCapCents ?? '').trim()) {
    out.push(`capital: the stored goal's ceiling ${stored.capitalCeilingCents} matches neither the total-spend cap ${terms.totalSpendCapCents} nor the exposure cap ${terms.exposureCapCents}; explain or correct`);
  }
  if (!Number.isFinite(terms.targetCents) || terms.targetCents <= 0) out.push('target: must be a positive amount');
  for (const [key, v] of [['totalSpendCapCents', terms.totalSpendCapCents], ['preProofSpendCapCents', terms.preProofSpendCapCents], ['exposureCapCents', terms.exposureCapCents]] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) out.push(`${key}: must be a non-negative amount or null`);
  }
  if (terms.totalSpendCapCents !== null && terms.preProofSpendCapCents !== null && terms.preProofSpendCapCents > terms.totalSpendCapCents) {
    out.push('the pre-proof cap exceeds the total-spend cap; the pre-proof allowance is part of the total');
  }
  return out;
}

// ------------------------------------------------------------------------------- plan revision

export type Stance = 'EXECUTABLE' | 'CONDITIONAL' | 'NO_PLAN';
export type StepKind = 'REACH' | 'OFFER' | 'SELL' | 'ORDER' | 'DELIVER' | 'COLLECT' | 'RESEARCH' | 'TEST' | 'OTHER';
export type EvidenceStatus = 'EVIDENCED' | 'ESTIMATE' | 'ASSUMED' | 'UNKNOWN';

export interface PlanStepInput {
  id: string;
  kind: StepKind;
  label: string;
  /** Who performs it: BRAIN, a named provider, or OWNER; null = nobody established. */
  performer: string | null;
  /** Cents; null = unknown. */
  costCents: number | null;
  /** Day of the window (0 = execution start); null = unscheduled. */
  day: number | null;
  dependsOn: string | null;
  evidence: string[];
  ownerHours?: number | null;
  /** The price the step offers or sells at (cents), when it offers one. */
  priceCents?: number | null;
  /**
   * The step's executor as Brain reads it (`stepExecutor` over the live capability inventory):
   * filled by Brain at submission, never taken from the session, so a check never runs on a
   * capability the session merely asserted. Absent only on a revision built outside Brain.
   */
  executor?: StepExecutorRecord | null;
}

/** Brain's executor record for one session step: the operation, who performs it, and each capability with its state. */
export interface StepExecutorRecord {
  operation: string;
  performedBy: 'BRAIN' | 'PROVIDER' | 'OWNER' | 'NOT_ESTABLISHED';
  provider: string | null;
  capabilities: { id: string; state: string }[];
  routine: boolean;
}

/** One money movement of the plan's cash sequence, in cents. */
export interface CashEntryInput {
  day: number;
  /**
   * FUNDING is the owner's own money advanced into the plan (a float): it is not revenue, not a
   * customer receipt and never repaid as a refund. It raises the cash available, and it leaves
   * exposure untouched, because the owner's money is still at risk until receipts settle.
   */
  kind: 'SPEND' | 'FEE' | 'COMMIT' | 'RELEASE' | 'RECEIPT' | 'REFUND' | 'FUNDING';
  amountCents: number;
  label: string;
  /** RECEIPT only: the day the money reaches the bank. */
  settlesDay?: number | null;
  /**
   * The step whose cost or obligation this outflow pays (SPEND, FEE), commits (COMMIT) or
   * releases (RELEASE). Every outflow names one, and every costed step is paid exactly by its
   * linked outflows: nothing omitted, nothing counted twice.
   */
  stepId?: string | null;
}

export interface QuantityInput {
  name: string;
  status: EvidenceStatus;
  /** null whenever the status is UNKNOWN; a figure there is refused. */
  value: number | null;
  unit: string;
  /** Which source ids support it (EVIDENCED/ESTIMATE). */
  sources: string[];
  /** What would establish it: the research question or live test. */
  needs: string | null;
}

export interface SourceInput {
  id: string;
  url: string;
  /** ISO date the figure describes or was published. */
  dated: string | null;
  claim: string;
  /** The population or market the source measures. */
  population: string;
  /** Whether that population is the plan's actual buyer; false means it may not support this buyer's demand. */
  matchesBuyer: boolean;
  /** The opening the source is about, when it is about one (its provenance for an opening the session discovered). */
  opportunityId?: string;
}

export interface PlanRevisionInput {
  goalId: string;
  contractDigest: string;
  parentRevisionId: string | null;
  stance: Stance;
  strategy: { title: string; opportunityIds: string[]; why: string };
  alternatives: { title: string; why: string }[];
  steps: PlanStepInput[];
  cash: CashEntryInput[];
  /** Day at the END of which the proof condition is evaluated; entries on or before it are pre-proof. Null: proof is not part of this plan. */
  proofDay: number | null;
  quantities: QuantityInput[];
  sources: SourceInput[];
  /**
   * A conditional plan's live test. `decides` names the chain link(s) whose measurement decides whether the plan goes
   * on — the decisive missing evidence of COMPLETION-SPEC §2(B) — each one the test measures (in `resolves`).
   */
  validation: {
    proof: string; stop: string[]; continue: string[]; decides?: string[];
    /**
     * When the test measures CONVERSION: the pass threshold as a ratio (`paid` sales from `of` contacts) and `reach`, the
     * contacts the plan reaches inside the window if it continues (the test's included). A test that passes exactly at
     * its threshold must carry the deals the target needs over that reach, or passing it proves nothing about the goal.
     */
    threshold?: { paid: number; of: number; reach: number };
  } | null;
  /** decisiveLinks: the chain links the decisive gap is about (structured, so the gap, the chain and `resolves` can be checked to agree). */
  noPlan: { decisiveGap: string; resolution: string; decisiveLinks?: string[] } | null;
  /** A simulated chance of reaching the target, and whether it is calibrated against resolved outcomes. */
  reach: { value: number; calibrated: boolean; presentedAs: 'PROBABILITY' | 'COVERAGE' } | null;
  /**
   * Answers to the previous review's findings, when revising after REVISE. A reviewer's proposed
   * condition (`ReviewCondition`, by its index) is answered with a decision and the records it was
   * checked against: a card fact field of that opening, or `brain:<LINK>` for Brain's link basis.
   */
  answers: { finding: string; resolution: string; condition?: number; decision?: 'ACCEPTED' | 'REBUTTED'; records?: string[] }[];
  /**
   * The session's own judgement of each opening it weighed: the chain links (`CHAIN_LINKS`:
   * REACHABLE_BUYER, CURRENT_DEMAND, OFFER_AND_PRICE, CONVERSION, MARKET_VOLUME, FULFILMENT,
   * ECONOMICS, SETTLES_IN_TIME) the evidence does not establish. Structured so a grader reads
   * it, never the prose.
   */
  chain?: { opportunityId: string; missing: string[] }[];
  /** Openings set aside, each with why. */
  excluded?: { opportunityId: string; why: string }[];
  /**
   * The arithmetic per opening (major units): for an executable plan, the deals the strategy counts per member; for a
   * no-plan or conditional result, every opening it weighs — the deals needed to carry the target at its price, the
   * direct cost, the capital one cycle ties up, and the window day its cash settles. A figure is null exactly where the
   * link it rests on is unestablished (price: OFFER_AND_PRICE, capital: ECONOMICS, settlesDay: SETTLES_IN_TIME): an
   * unknown stays unknown, and a known figure is never left out.
   */
  members?: { opportunityId: string; deals: number | null; price: number | null; directCost: number | null; capital: number | null; settlesDay?: number | null; /** Owner hours the deals take in all, when the goal limits them. */ ownerHours?: number | null; /** The most deals the evidence supports from this payer population (1 for one organisation's single order); deals never exceed it. */ dealsMax?: number | null }[];
  /** The chain links the plan's validation test or research measures (what would resolve the unknowns). */
  resolves?: string[];
  /** Where the session's chain judgement differs from Brain's planner (BrainFacts.links): the link and the evidence-based reason. */
  disagreements?: { opportunityId: string; link: string; reason: string }[];
  /**
   * Constraints (DEADLINE, CAPITAL, TARGET, OWNER_HOURS) the session finds rule every plan out, with the relaxation it
   * suggests. A constraint is arithmetic on established figures: `basis` cites, per opening whose binding link fails,
   * the card's EVIDENCE fact that fixes the figure (`CONSTRAINT_INPUTS`). Missing evidence is a gap, never a ceiling.
   */
  constraints?: { constraint: string; suggestion: string; basis?: { opportunityId: string; field: string }[] }[];
  /** Set by the transport when the payload arrived incomplete. */
  truncated?: boolean;
}

/** The chain links a cash plan rests on (the planner's `CHAIN_LINKS`). */
export const CHAIN_LINKS = ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE', 'CONVERSION', 'MARKET_VOLUME', 'FULFILMENT', 'ECONOMICS', 'SETTLES_IN_TIME'] as const;
const LINKS = { type: 'array', items: { type: 'string', enum: [...CHAIN_LINKS] } } as const;
const num = { type: ['number', 'null'] } as const;
/** The revision's JSON schema: stated to the caller by the submit tool, and enforced by `shapeProblems` before any check. */
export const REVISION_SCHEMA = {
  type: 'object',
  description: 'One plan revision for the goal. Read brain_planning_context first: it names the contract digest and every opening id to account for.',
  required: ['goalId', 'contractDigest', 'stance', 'strategy', 'chain'],
  properties: {
    goalId: { type: 'string' },
    contractDigest: { type: 'string', description: 'The current contract digest from brain_planning_context.' },
    parentRevisionId: { type: ['string', 'null'], description: 'The revision this one revises (after a REVISE review), else null.' },
    stance: { type: 'string', enum: ['EXECUTABLE', 'CONDITIONAL', 'NO_PLAN'] },
    strategy: {
      type: 'object', required: ['title', 'opportunityIds', 'why'],
      properties: { title: { type: 'string' }, opportunityIds: { type: 'array', items: { type: 'string' }, description: 'The openings the plan executes (empty for NO_PLAN).' }, why: { type: 'string' } },
    },
    alternatives: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } } } },
    chain: {
      type: 'array', description: 'Every opening weighed, with the chain links its evidence does not establish (empty when all are).',
      items: { type: 'object', required: ['opportunityId', 'missing'], properties: { opportunityId: { type: 'string' }, missing: LINKS } },
    },
    excluded: { type: 'array', items: { type: 'object', required: ['opportunityId', 'why'], properties: { opportunityId: { type: 'string' }, why: { type: 'string' } } } },
    members: {
      type: 'array',
      items: { type: 'object', required: ['opportunityId'], properties: { opportunityId: { type: 'string' }, deals: num, price: num, directCost: num, capital: num, settlesDay: num, ownerHours: { type: ['number', 'null'], description: 'Owner hours the deals take in all; required when the goal limits owner hours.' }, dealsMax: { type: ['number', 'null'], description: 'The most deals the evidence supports from this payer population (1 for one organisation\'s single order).' } } },
    },
    steps: {
      type: 'array',
      items: { type: 'object', required: ['id', 'kind', 'evidence'], properties: { evidence: { type: 'array', items: { type: 'string' }, description: 'The quantity names or source ids the step rests on.' }, ownerHours: num, id: { type: 'string' }, kind: { type: 'string', enum: ['REACH', 'OFFER', 'SELL', 'ORDER', 'DELIVER', 'COLLECT', 'RESEARCH', 'TEST', 'OTHER'] }, label: { type: 'string' }, performer: { type: ['string', 'null'] }, costCents: num, day: num, dependsOn: { type: ['string', 'null'] } } },
    },
    cash: {
      type: 'array',
      items: { type: 'object', required: ['day', 'kind', 'amountCents'], properties: { day: { type: 'number' }, kind: { type: 'string', enum: ['SPEND', 'FEE', 'COMMIT', 'RELEASE', 'RECEIPT', 'REFUND', 'FUNDING'] }, amountCents: { type: 'number' }, label: { type: 'string' }, stepId: { type: ['string', 'null'], description: 'the id of the step whose cost or obligation this outflow pays; every SPEND, FEE and COMMIT names one' } } },
    },
    proofDay: num,
    quantities: {
      type: 'array',
      items: { type: 'object', required: ['name', 'status', 'sources'], properties: { name: { type: 'string' }, status: { type: 'string', enum: ['EVIDENCED', 'ESTIMATE', 'ASSUMED', 'UNKNOWN'] }, value: num, unit: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } }, needs: { type: ['string', 'null'] } } },
    },
    sources: {
      type: 'array',
      items: { type: 'object', required: ['id', 'url'], properties: { id: { type: 'string' }, url: { type: 'string' }, dated: { type: ['string', 'null'] }, claim: { type: 'string' }, population: { type: 'string' }, matchesBuyer: { type: 'boolean' }, opportunityId: { type: ['string', 'null'] } } },
    },
    validation: {
      type: ['object', 'null'], required: ['proof', 'stop'],
      properties: {
        proof: { type: 'string' }, stop: { type: 'array', items: { type: 'string' } }, continue: { type: 'array', items: { type: 'string' } }, decides: LINKS,
        threshold: { type: 'object', required: ['paid', 'of', 'reach'], properties: { paid: { type: 'number' }, of: { type: 'number' }, reach: { type: 'number' } } },
      },
    },
    noPlan: { type: ['object', 'null'], required: ['decisiveGap', 'resolution'], properties: { decisiveGap: { type: 'string' }, resolution: { type: 'string' }, decisiveLinks: LINKS } },
    reach: { type: ['object', 'null'], properties: { value: { type: 'number' }, calibrated: { type: 'boolean' }, presentedAs: { type: 'string', enum: ['PROBABILITY', 'COVERAGE'] } } },
    resolves: LINKS,
    answers: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, resolution: { type: 'string' }, condition: { type: 'number' }, decision: { type: 'string', enum: ['ACCEPTED', 'REBUTTED'] }, records: { type: 'array', items: { type: 'string' } } } } },
    disagreements: { type: 'array', items: { type: 'object', required: ['opportunityId', 'link'], properties: { opportunityId: { type: 'string' }, link: { type: 'string' }, reason: { type: 'string' } } } },
    constraints: { type: 'array', items: { type: 'object', required: ['constraint'], properties: { constraint: { type: 'string', enum: ['DEADLINE', 'CAPITAL', 'TARGET', 'OWNER_HOURS'] }, suggestion: { type: 'string' }, basis: { type: 'array', items: { type: 'object', properties: { opportunityId: { type: 'string' }, field: { type: 'string' } } } } } } },
  },
} as const;

export const PLAN_CONSTRAINTS = ['DEADLINE', 'CAPITAL', 'TARGET', 'OWNER_HOURS'] as const;

/**
 * What each constraint's arithmetic rests on: the link whose established figure makes it bind, and the links that must
 * be established for the arithmetic to mean anything. A target ceiling is buyers × price: with the buyers or the price
 * unknown, nothing caps what the opening could bring, so the gap is evidence to find, not a limit.
 */
export const CONSTRAINT_INPUTS: Record<(typeof PLAN_CONSTRAINTS)[number], { binds: string; needs: string[] }> = {
  TARGET: { binds: 'MARKET_VOLUME', needs: ['OFFER_AND_PRICE'] },
  DEADLINE: { binds: 'SETTLES_IN_TIME', needs: [] },
  CAPITAL: { binds: 'ECONOMICS', needs: [] },
  OWNER_HOURS: { binds: 'FULFILMENT', needs: [] },
};

/**
 * A condition a reviewer proposes: that a chain link of an opening is not established. It names its support — a card
 * fact of that opening that shows the link unestablished (EVIDENCE), or a prerequisite the card does not hold
 * (MISSING_PREREQUISITE: a field no EVIDENCE fact carries) — and why it changes the decision.
 */
export interface ReviewCondition {
  opportunityId: string;
  link: string;
  basis: 'EVIDENCE' | 'MISSING_PREREQUISITE';
  field: string;
  why: string;
  /**
   * Against an OFFER_AND_PRICE link Brain's planner establishes from an evidenced price: which defect the spec recognises
   * the record shows (COMPLETION-SPEC §2–§3) — the price is only a person's word, another record contradicts it, or it
   * is not a payment for this deliverable. Without one the condition contradicts Brain's evidence on no stated ground.
   */
  defect?: 'PERSON_WORD' | 'CONTRADICTED' | 'NOT_A_PURCHASE';
  /** With NOT_A_PURCHASE: which payment the figure is instead (COMPLETION-SPEC §3 NON_PURCHASE_PRICE). */
  nonPurchase?: (typeof NON_PURCHASE_KINDS)[number];
}

export const PRICE_DEFECTS = ['PERSON_WORD', 'CONTRADICTED', 'NOT_A_PURCHASE'] as const;
/** What a figure that is not a payment for the deliverable is instead (COMPLETION-SPEC §3), plus a wage for the owner's own hours. A comparable offer's current price is none of them. */
export const NON_PURCHASE_KINDS = ['REWARD', 'BOUNTY', 'GRANT', 'PRIZE', 'REBATE', 'SETTLEMENT', 'WAGE', 'ANOTHER_BUYERS_CLAIM'] as const;

export type CardFacts = Record<string, { field: string; kind: string }[]>;

/** Why a proposed condition may not be recorded: each must name its supporting record or a genuinely absent prerequisite. */
export function conditionProblems(conditions: ReviewCondition[], revision: Pick<PlanRevisionInput, 'strategy' | 'chain'>, facts: CardFacts, established: Record<string, string[]> = {}): string[] {
  const out: string[] = [];
  const openings = new Set([...revision.strategy.opportunityIds, ...(revision.chain ?? []).map((c) => c.opportunityId)]);
  conditions.forEach((c, i) => {
    const at = `condition ${i} (${c.link} on ${c.opportunityId})`;
    if (!(CHAIN_LINKS as readonly string[]).includes(c.link)) out.push(`${at}: "${c.link}" is not a chain link (${CHAIN_LINKS.join(', ')})`);
    if (!openings.has(c.opportunityId)) out.push(`${at}: the revision does not weigh that opening`);
    if (!c.why?.trim()) out.push(`${at}: state why it changes the decision`);
    const card = facts[c.opportunityId] ?? [];
    if (c.basis === 'EVIDENCE' && !card.some((f) => f.field === c.field)) out.push(`${at}: the card holds no fact "${c.field}"; cite the record that shows the link unestablished (${card.map((f) => f.field).join(', ') || 'none'})`);
    else if (c.basis === 'MISSING_PREREQUISITE' && card.some((f) => f.field === c.field && f.kind === 'EVIDENCE')) out.push(`${at}: "${c.field}" is on the card as evidence, so it is not missing; cite it as EVIDENCE and say what in it leaves the link unestablished`);
    else if (c.basis !== 'EVIDENCE' && c.basis !== 'MISSING_PREREQUISITE') out.push(`${at}: basis must be EVIDENCE or MISSING_PREREQUISITE`);
    /*
     * A price Brain's planner establishes is objected to on a defect the spec names, or not at all (acceptance run 12:
     * a reviewer held three evidenced prices — a current comparable listing, with this offer's measured paid conversion —
     * unestablished as "what other sellers ask", Brain's planner had them established, and the plans went conditional).
     */
    if (c.link === 'OFFER_AND_PRICE' && c.basis === 'EVIDENCE' && (established[c.opportunityId] ?? []).includes('OFFER_AND_PRICE') && !(c.defect && (PRICE_DEFECTS as readonly string[]).includes(c.defect))) {
      out.push(`${at}: Brain's planner establishes this opening's price from the card's evidence; a condition against it names the defect the record shows (defect: ${PRICE_DEFECTS.join(' | ')} — only a person's word, contradicted by another record, or not a payment for this deliverable), or the price stands`);
    } else if (c.link === 'OFFER_AND_PRICE' && c.defect === 'NOT_A_PURCHASE' && (established[c.opportunityId] ?? []).includes('OFFER_AND_PRICE') && !(c.nonPurchase && (NON_PURCHASE_KINDS as readonly string[]).includes(c.nonPurchase))) {
      /*
       * Run 15 (fleet-1, a01/a04/a06): with a defect required, a reviewer labelled current listing prices of directly
       * comparable offers NOT_A_PURCHASE ("what someone else asks") and the plans went conditional. The spec's
       * non-purchases are payments of another kind; a comparable offer's price is an evidenced price (§2).
       */
      out.push(`${at}: NOT_A_PURCHASE names what the figure is instead (nonPurchase: ${NON_PURCHASE_KINDS.join(' | ')}); a directly comparable offer's current price is an evidenced price, not a non-purchase, so without one the price stands`);
    }
  });
  return out;
}

export interface PlanRevision extends PlanRevisionInput {
  revisionId: string;
  digest: string;
  author: PlanExecutor;
  createdAt: string;
}

export function revisionDigest(r: PlanRevisionInput): string {
  const { truncated: _t, ...content } = r;
  return digestOf(content);
}

// -------------------------------------------------------------------------------------- checks

export type CheckCode =
  | 'STALE_CONTRACT'
  | 'INCOMPLETE_OUTPUT'
  | 'CHAIN_STEP_MISSING'
  | 'STEP_FIELD_ABSENT'
  | 'TOTAL_SPEND_OVER'
  | 'PRE_PROOF_SPEND_OVER'
  | 'EXPOSURE_OVER'
  | 'CASH_SHORTFALL'
  | 'COLLECTION_AFTER_DEADLINE'
  | 'TARGET_NOT_CARRIED'
  | 'UNKNOWN_FILLED'
  | 'UNKNOWN_IN_EXECUTABLE'
  | 'EVIDENCE_TRANSFER'
  | 'STALE_SOURCE'
  | 'SOURCE_UNREFERENCED'
  | 'REACH_UNCALIBRATED'
  | 'NO_PLAN_UNJUSTIFIED'
  | 'CONDITIONAL_WITHOUT_VALIDATION'
  | 'OPPORTUNITY_NOT_ADMITTED'
  | 'STEP_COST_UNRECONCILED'
  | 'CASH_UNLINKED'
  | 'OWNER_HOURS_OVER'
  | 'PERFORMER_MISMATCH'
  | 'FULFILMENT_UNESTABLISHED'
  | 'CAPABILITY_NOT_HELD'
  | 'CAPABILITY_UNREAD'
  | 'CHAIN_DISAGREEMENT_UNSTATED'
  | 'RESOLUTION_UNNAMED'
  | 'CONSTRAINT_FROM_MISSING_EVIDENCE'
  | 'REVIEW_CONDITION_UNANSWERED'
  | 'EXCLUSION_DISPUTE_UNSTATED'
  | 'CONDITIONAL_DECISIVE_UNNAMED'
  | 'DISCOVERY_UNSOURCED'
  | 'OPENING_UNACCOUNTED'
  | 'ARITHMETIC_UNSTATED'
  | 'PROOF_INSUFFICIENT'
  | 'REJECTED_EVIDENCE_USED'
  | 'WAGE_AS_PRICE'
  | 'BRAIN_CHECK_FAILED';

export interface CheckProblem {
  code: CheckCode;
  detail: string;
  /** The step, quantity, source or day the problem is about, so the author can revise exactly that. */
  at: string | null;
}

/** What Brain's own machinery returned for this goal (the service fills it from `readGoalPlan` and plan integrity). */
export interface BrainFacts {
  /** Opening ids the goal holds (admitted routes and filed openings). */
  admittedOpportunityIds: string[];
  /** Plan-integrity violations Brain's planner reported on its reading. */
  integrity: { rule: string; detail: string }[];
  /** Whether the planner call completed; false when it failed or timed out. */
  completed: boolean;
  error: string | null;
  /** Per opening: who its own record says fulfils it (`recordFulfiller`), and the deliverable capability's state when Brain does. */
  fulfilment?: Record<string, { by: 'BRAIN' | 'PROVIDER' | 'OWNER' | 'NOBODY'; name: string | null; capability: string | null; capabilityState: string | null }>;
  /** The owner hours the stored goal allows over its window, or null when it states none. */
  hoursCeiling?: number | null;
  /** Per opening: Brain's planner's judgement of each chain link and the basis that decides it. */
  links?: Record<string, { link: string; ok: boolean; basis: string }[]>;
  /** Per opening: the card's facts (field and kind) the records a constraint or an answer cites must be among. */
  facts?: CardFacts;
  /** The conditions the last REVISE review of this revision's parent proposed, each to be answered against the records. */
  reviewConditions?: ReviewCondition[];
  /** Openings Brain's planner set aside, with its reason: a plan that builds on one states why the exclusion is wrong. */
  excluded?: Record<string, string>;
  /** Openings this goal's own sessions proposed as routes (session discovery), whose provenance is the session's sources. */
  discovered?: string[];
  /** Source URLs of claims Brain's evidence gate rejected on this goal (and accepted on none), each with its reason. */
  rejectedSources?: Record<string, string>;
  /** Openings whose card states their revenue as hourly pay (`wageWording`), read with `fulfilment` for WAGE_AS_PRICE. */
  wagePriced?: string[];
  /** The openings a revision must account for (the goal's own and those weighed); absent, every admitted one. */
  accountFor?: string[];
}

/** Whether a card's revenue text describes hourly pay for labour (a wage) rather than a price for an offer. */
export function wageWording(text: string): boolean {
  const pay = /\b(pay|pays|paid|earn|earns|earnings|wage|wages|salary|compensation)\b/i;
  const hourly = /(per hour|an hour|\/\s?hr\b|\/\s?hour\b|\bhourly\b)/i;
  return pay.test(text) && hourly.test(text);
}

/** The cash sequence, day by day, with every limit's running figure. Exported so the author can read it back. */
export interface CashTrace {
  totalSpentCents: number;
  committedOpenCents: number;
  preProofCents: number;
  /** Peak of spent plus committed-but-unspent money, less settled receipts. */
  maxExposureCents: number;
  minCashCents: number;
  minCashDay: number | null;
  collectedCents: number;
  collectedInWindowCents: number;
  refundsCents: number;
  /** The owner's own money advanced (FUNDING): not revenue, never in collected or net. */
  ownerFundedCents: number;
  netCents: number;
}

export function cashTrace(r: Pick<PlanRevisionInput, 'cash' | 'proofDay'>, terms: Pick<ContractTerms, 'windowDays' | 'exposureCapCents' | 'totalSpendCapCents'>): CashTrace {
  const entries = [...r.cash].sort((a, b) => a.day - b.day);
  let spent = 0, committed = 0, pre = 0, collected = 0, inWindow = 0, refunds = 0;
  for (const e of entries) {
    const amt = e.amountCents;
    if (e.kind === 'SPEND' || e.kind === 'FEE') {
      spent += amt;
      if (r.proofDay === null || e.day <= r.proofDay) pre += amt;
    } else if (e.kind === 'COMMIT') {
      committed += amt;
      if (r.proofDay === null || e.day <= r.proofDay) pre += amt;
    } else if (e.kind === 'RELEASE') {
      committed = Math.max(0, committed - amt);
      if (r.proofDay === null || e.day <= r.proofDay) pre = Math.max(0, pre - amt);
    } else if (e.kind === 'RECEIPT') {
      collected += amt;
      if (terms.windowDays === null || e.day <= terms.windowDays) inWindow += amt;
    } else if (e.kind === 'REFUND') {
      refunds += amt;
      inWindow -= amt;
    }
  }
  // Out-of-pocket by day: money spent so far minus receipts that have SETTLED by that day.
  const days = [...new Set(entries.flatMap((e) => [e.day, ...(e.kind === 'RECEIPT' && e.settlesDay != null ? [e.settlesDay] : [])]))].sort((a, b) => a - b);
  let maxExposure = 0, minCash = Number.POSITIVE_INFINITY, minDay: number | null = null;
  const capital = terms.exposureCapCents ?? terms.totalSpendCapCents ?? 0;
  const funded = entries.filter((e) => e.kind === 'FUNDING').reduce((s, e) => s + e.amountCents, 0);
  for (const d of days) {
    const out = entries.filter((e) => (e.kind === 'SPEND' || e.kind === 'FEE') && e.day <= d).reduce((s, e) => s + e.amountCents, 0)
      + entries.filter((e) => e.kind === 'REFUND' && e.day <= d).reduce((s, e) => s + e.amountCents, 0);
    const settled = entries.filter((e) => e.kind === 'RECEIPT' && (e.settlesDay ?? e.day) <= d).reduce((s, e) => s + e.amountCents, 0);
    // Committed but unspent money is exposure too: it is owed whether or not it has left yet.
    const committedBy = Math.max(0, entries.filter((e) => e.kind === 'COMMIT' && e.day <= d).reduce((s, e) => s + e.amountCents, 0) - entries.filter((e) => e.kind === 'RELEASE' && e.day <= d).reduce((s, e) => s + e.amountCents, 0));
    const exposure = out - settled + committedBy;
    maxExposure = Math.max(maxExposure, exposure);
    // The owner's advance is available from the day it is made; it never counts as collected.
    const cash = capital + entries.filter((e) => e.kind === 'FUNDING' && e.day <= d).reduce((s, e) => s + e.amountCents, 0) - exposure;
    if (cash < minCash) { minCash = cash; minDay = d; }
  }
  return {
    totalSpentCents: spent,
    committedOpenCents: committed,
    preProofCents: pre,
    maxExposureCents: maxExposure,
    minCashCents: Number.isFinite(minCash) ? minCash : capital,
    minCashDay: minDay,
    collectedCents: collected,
    collectedInWindowCents: inWindow,
    refundsCents: refunds,
    ownerFundedCents: funded,
    netCents: collected - refunds - spent,
  };
}

const CHAIN: { need: StepKind[]; label: string }[] = [
  { need: ['REACH', 'OFFER', 'SELL'], label: 'reaching buyers (REACH/OFFER/SELL)' },
  { need: ['DELIVER'], label: 'fulfilment (DELIVER)' },
  { need: ['COLLECT'], label: 'collecting payment (COLLECT)' },
];

/** Every problem with a revision against its contract. An empty list is a revision that passes Brain's checks. */
export function checkRevision(contract: GoalContract, r: PlanRevisionInput, brain: BrainFacts | null, today: string): CheckProblem[] {
  const p: CheckProblem[] = [];
  const add = (code: CheckCode, detail: string, at: string | null = null) => p.push({ code, detail, at });
  const t = contract.terms;
  if (r.truncated) add('INCOMPLETE_OUTPUT', 'the submission arrived truncated; nothing in it is checked or certified', null);
  if (r.contractDigest !== contract.digest) add('STALE_CONTRACT', `the revision was built on contract ${r.contractDigest}; the current contract is ${contract.digest} (v${contract.version}). Rebuild it on the current objective.`);
  if (brain && !brain.completed) add('BRAIN_CHECK_FAILED', `Brain's planner did not complete (${brain.error ?? 'no result'}); the revision cannot be certified on a missing calculation`);
  for (const v of brain?.integrity ?? []) add('BRAIN_CHECK_FAILED', `Brain plan integrity ${v.rule}: ${v.detail}`);

  // The structured chain judgement: closed vocabulary, and an executable plan's members carry no missing link.
  for (const c of r.chain ?? []) {
    for (const l of c.missing) if (!(CHAIN_LINKS as readonly string[]).includes(l)) add('INCOMPLETE_OUTPUT', `"${l}" is not a chain link (${CHAIN_LINKS.join(', ')})`, c.opportunityId);
    if (r.stance === 'EXECUTABLE' && r.strategy.opportunityIds.includes(c.opportunityId) && c.missing.length) {
      add('UNKNOWN_IN_EXECUTABLE', `the plan's member ${c.opportunityId} is missing ${c.missing.join(', ')}; the plan is at most CONDITIONAL`, c.opportunityId);
    }
  }
  for (const k of r.constraints ?? []) if (!(PLAN_CONSTRAINTS as readonly string[]).includes(k.constraint)) add('INCOMPLETE_OUTPUT', `"${k.constraint}" is not a constraint (${PLAN_CONSTRAINTS.join(', ')})`, null);

  // The session's chain judgement against Brain's: a difference in either direction carries its evidence-based reason,
  // so a link Brain establishes is never silently dropped and one Brain finds unestablished is never silently assumed.
  const stated = (id: string, link: string) => (r.disagreements ?? []).some((d) => d.opportunityId === id && d.link === link && d.reason.trim().length > 0);
  for (const c of r.chain ?? []) {
    const theirs = brain?.links?.[c.opportunityId];
    if (!theirs?.length) continue;
    for (const l of theirs) {
      const mineMissing = c.missing.includes(l.link);
      if (l.ok && mineMissing && !stated(c.opportunityId, l.link)) add('CHAIN_DISAGREEMENT_UNSTATED', `you mark ${l.link} missing on ${c.opportunityId}, but Brain's planner establishes it ("${l.basis}"); state why the evidence does not support it in \`disagreements\`, or remove it from the chain`, c.opportunityId);
      if (!l.ok && !mineMissing && !stated(c.opportunityId, l.link)) add('CHAIN_DISAGREEMENT_UNSTATED', `you treat ${l.link} as established on ${c.opportunityId}, but Brain's planner does not ("${l.basis}"); state the evidence that establishes it in \`disagreements\`, or mark it missing`, c.opportunityId);
    }
  }

  // What would resolve the plan's unknowns names them: a no-plan's decisive gap is stated as chain links, marked missing,
  // and measured by `resolves`; a conditional plan's test measures every link its members are missing.
  const missingAnywhere = new Set((r.chain ?? []).flatMap((c) => c.missing));
  const resolves = new Set(r.resolves ?? []);
  if (r.stance === 'NO_PLAN' && !(r.constraints ?? []).length) {
    const decisive = r.noPlan?.decisiveLinks ?? [];
    if (!decisive.length) add('RESOLUTION_UNNAMED', 'a no-plan result must name its decisive gap as chain links (noPlan.decisiveLinks), not only in prose');
    for (const l of decisive) {
      if (!(CHAIN_LINKS as readonly string[]).includes(l)) add('INCOMPLETE_OUTPUT', `decisive link "${l}" is not a chain link`, null);
      else {
        if (!missingAnywhere.has(l)) add('RESOLUTION_UNNAMED', `the decisive gap names ${l}, but no opening's chain marks it missing`, null);
        if (!resolves.has(l)) add('RESOLUTION_UNNAMED', `the decisive gap is ${l}, but \`resolves\` names no measurement or research of it`, null);
      }
    }
  }
  // A constraint is arithmetic on established figures, never on missing evidence: its inputs are established on every
  // opening weighed, and where its binding link fails, the card's evidence that fixes the figure is cited.
  if (r.stance === 'NO_PLAN') {
    for (const k of r.constraints ?? []) {
      const inputs = CONSTRAINT_INPUTS[k.constraint as keyof typeof CONSTRAINT_INPUTS];
      if (!inputs) continue;
      for (const c of r.chain ?? []) {
        for (const l of inputs.needs) if (c.missing.includes(l)) add('CONSTRAINT_FROM_MISSING_EVIDENCE', `${k.constraint} is arithmetic on ${[inputs.binds, ...inputs.needs].join(' and ')}, but ${c.opportunityId}'s ${l} is not established; an unknown sets no ceiling. Name it as a decisive gap (noPlan.decisiveLinks) to research, not as a limit`, c.opportunityId);
        // TARGET's binding figure is a counted market, checked below whatever the chain says.
        if (!c.missing.includes(inputs.binds) || k.constraint === 'TARGET') continue;
        const card = brain?.facts?.[c.opportunityId];
        const cited = (k.basis ?? []).filter((b) => b.opportunityId === c.opportunityId);
        const evidenced = cited.some((b) => (card ?? []).some((f) => f.field === b.field && f.kind === 'EVIDENCE'));
        if (!evidenced) add('CONSTRAINT_FROM_MISSING_EVIDENCE', `${k.constraint} needs the established figure that makes ${c.opportunityId}'s ${inputs.binds} fall short: cite the card's EVIDENCE fact in the constraint's \`basis\`${cited.length ? ` ("${cited.map((b) => b.field).join(', ')}" is not one)` : ''}. Without one, ${inputs.binds} is unknown, a gap to research rather than a limit`, c.opportunityId);
      }
      /*
       * TARGET says the market cannot carry the target, so it rests on a counted market: an EVIDENCE fact that counts
       * the buyers (buyerVolume). The openings the world happens to hold are not the market — one known buyer with one
       * request is not a population that ends at one (acceptance run 2026-11-27, ac-15: a $12,000 target declared out
       * of reach because the only opening was one company's $3,500 RFQ, while nothing counted the other buyers).
       */
      // Whether or not a chain marks MARKET_VOLUME missing: citing the price or the payer is not counting the market
      // (run 7, ag-11: one transit authority's one $6,000 order, MARKET_VOLUME marked missing, `price` and `payer` cited).
      if (k.constraint === 'TARGET') {
        const counted = (k.basis ?? []).some((b) => b.field === 'buyerVolume' && (brain?.facts?.[b.opportunityId] ?? []).some((f) => f.field === 'buyerVolume' && f.kind === 'EVIDENCE'));
        if (!counted) add('CONSTRAINT_FROM_MISSING_EVIDENCE', `TARGET says the market cannot carry the target, so it needs a counted market: cite an opening's EVIDENCE buyerVolume fact in its \`basis\`. Nothing here counts the buyers — the openings on file are not the whole market — so MARKET_VOLUME is unknown: name it as a decisive gap (noPlan.decisiveLinks) with research or a test that counts the market, not as a limit`, null);
      }
    }
  }

  // An opening Brain's planner excluded is built on only with a stated reason the exclusion is wrong (link EXCLUSION in
  // `disagreements`), read against its card the context now shows — never silently, and never refused unread.
  for (const id of r.strategy.opportunityIds) {
    const why = brain?.excluded?.[id];
    if (why && !(r.disagreements ?? []).some((x) => x.opportunityId === id && x.link === 'EXCLUSION' && x.reason.trim().length > 0)) {
      add('EXCLUSION_DISPUTE_UNSTATED', `Brain's planner excluded ${id} ("${why.slice(0, 200)}"); to build on it, state in \`disagreements\` (link EXCLUSION) why the exclusion is wrong, from its card`, id);
    }
  }

  // A reviewer's proposed condition is answered against the records before it is accepted or rebutted.
  (brain?.reviewConditions ?? []).forEach((k, i) => {
    const a = r.answers.find((x) => x.condition === i);
    const at = `reviewer condition ${i} (${k.link} on ${k.opportunityId}: ${k.why})`;
    if (!a || (a.decision !== 'ACCEPTED' && a.decision !== 'REBUTTED')) {
      add('REVIEW_CONDITION_UNANSWERED', `${at} has no answer with a decision; answer it with \`condition: ${i}\`, \`decision\` ACCEPTED or REBUTTED, and the \`records\` you checked it against`, k.opportunityId);
      return;
    }
    const known = new Set((brain?.facts?.[k.opportunityId] ?? []).map((f) => f.field));
    if (!(a.records ?? []).some((x) => known.has(x) || x === `brain:${k.link}`)) add('REVIEW_CONDITION_UNANSWERED', `${at} is ${a.decision.toLowerCase()} without a record it was checked against: name a card fact field of ${k.opportunityId} (${[...known].join(', ') || 'none'}) or brain:${k.link}`, k.opportunityId);
    const marked = (r.chain ?? []).find((c) => c.opportunityId === k.opportunityId)?.missing.includes(k.link) ?? false;
    if (a.decision === 'ACCEPTED' && !marked) add('REVIEW_CONDITION_UNANSWERED', `${at} is accepted, but the chain does not mark ${k.link} missing on ${k.opportunityId}`, k.opportunityId);
    if (a.decision === 'REBUTTED' && marked) add('REVIEW_CONDITION_UNANSWERED', `${at} is rebutted, but the chain still marks ${k.link} missing on ${k.opportunityId}`, k.opportunityId);
  });

  if (r.stance === 'CONDITIONAL') {
    for (const c of r.chain ?? []) {
      if (!r.strategy.opportunityIds.includes(c.opportunityId)) continue;
      for (const l of c.missing) if (!resolves.has(l)) add('RESOLUTION_UNNAMED', `the plan's member ${c.opportunityId} is missing ${l}, but its validation (\`resolves\`) does not measure it`, c.opportunityId);
    }
  }

  /*
   * A limitation's test may not sell what nobody is shown able to deliver: measuring CONVERSION takes real buyers'
   * orders or deposits, so on an opening whose FULFILMENT is unestablished the test measures FULFILMENT too — who
   * delivers, in what hours or capacity — or it creates obligations it may not be able to keep (acceptance run 10,
   * am-03: a test winning freelance awards for owner-built sites while the owner's ability and hours were unknown).
   */
  if (r.stance !== 'EXECUTABLE' && resolves.has('CONVERSION') && !resolves.has('FULFILMENT')) {
    for (const c of r.chain ?? []) {
      if (c.missing.includes('CONVERSION') && c.missing.includes('FULFILMENT') && !(r.excluded ?? []).some((x) => x.opportunityId === c.opportunityId)) {
        add('FULFILMENT_UNESTABLISHED', `the test measures CONVERSION by selling ${c.opportunityId}, whose FULFILMENT is not established: it would take buyers' orders before anyone is shown able to deliver them. Measure FULFILMENT in the same test (\`resolves\`: who delivers, in what hours or capacity), or measure conversion without taking paid work`, c.opportunityId);
      }
    }
  }

  /*
   * A no-plan or conditional result shows its arithmetic per opening, so the decisive gap is read from figures rather
   * than asserted: deals needed at the opening's price, the capital one cycle ties up, and when its cash settles
   * (run 10, am-03: four openings, deal counts for one, no settlement timing and no capital check against the cap).
   * A figure is null exactly where its link is unestablished, so an unknown is kept and a known figure is never dropped.
   */
  if (r.stance !== 'EXECUTABLE') {
    const set = new Set((r.excluded ?? []).map((x) => x.opportunityId));
    for (const c of r.chain ?? []) {
      if (set.has(c.opportunityId)) continue;
      const m = (r.members ?? []).find((x) => x.opportunityId === c.opportunityId);
      const missing = (l: string) => c.missing.includes(l);
      if (!m) { add('ARITHMETIC_UNSTATED', `state ${c.opportunityId}'s arithmetic in \`members\`: deals needed to carry the target at its price, direct cost, capital one cycle ties up, and the day its cash settles (null where the link is unestablished)`, c.opportunityId); continue; }
      const gaps: string[] = [];
      if (m.price === null && !missing('OFFER_AND_PRICE')) gaps.push('price is null but OFFER_AND_PRICE is established');
      if (m.price !== null && m.deals === null) gaps.push(`deals is null at a price of ${m.price}: the deals needed are target / price`);
      /*
       * An opening's deals are what it would take to carry the target alone, or what its payer population can give
       * (run 15, av-04: the rule asked one organisation's single $2,400 order for 2 deals). A capped opening states
       * dealsMax, never more deals than it; the strategy's members together carry the target.
       */
      const capped = typeof m.dealsMax === 'number' && m.deals !== null && m.deals >= m.dealsMax;
      if (typeof m.dealsMax === 'number' && m.deals !== null && m.deals > m.dealsMax) gaps.push(`${m.deals} deals exceed the ${m.dealsMax} its payer population supports (dealsMax)`);
      if (m.price !== null && m.deals !== null && !capped && !r.strategy.opportunityIds.includes(c.opportunityId) && m.deals * m.price * 100 < t.targetCents - 0.5) gaps.push(`${m.deals} deals at ${m.price} do not carry the ${t.targetCents / 100} target (or state dealsMax when its payers can give no more)`);
      if (m.capital === null && !missing('ECONOMICS')) gaps.push('capital is null but ECONOMICS is established');
      if (m.settlesDay === undefined) gaps.push('settlesDay is not stated (null if SETTLES_IN_TIME is unestablished)');
      else if (m.settlesDay === null && !missing('SETTLES_IN_TIME')) gaps.push('settlesDay is null but SETTLES_IN_TIME is established');
      // Run 13, as-02: under an owner-hours limit, two of three openings gave no owner hours, so none could be compared with it.
      if (brain?.hoursCeiling != null) {
        if (m.ownerHours === undefined) gaps.push(`ownerHours is not stated: the goal allows ${brain.hoursCeiling} owner hours (null if FULFILMENT is unestablished)`);
        else if (m.ownerHours === null && !missing('FULFILMENT')) gaps.push('ownerHours is null but FULFILMENT is established');
      }
      if (gaps.length) add('ARITHMETIC_UNSTATED', `${c.opportunityId}'s arithmetic: ${gaps.join('; ')}`, c.opportunityId);
    }
    const strat = (r.members ?? []).filter((m) => r.strategy.opportunityIds.includes(m.opportunityId) && !set.has(m.opportunityId));
    const priced = strat.filter((m) => m.price !== null && m.deals !== null);
    if (strat.length && priced.length === strat.length) {
      const sum = priced.reduce((x, m) => x + (m.deals ?? 0) * (m.price ?? 0) * 100, 0);
      if (sum < t.targetCents - 0.5) add('ARITHMETIC_UNSTATED', `the strategy's members bring ${Math.round(sum) / 100} at their deals and prices, under the ${t.targetCents / 100} target`, null);
    }
  }

  /*
   * Every opening the goal holds is accounted for in structured fields — weighed in `chain`, built on, or set aside in
   * `excluded` with its reason — so an opening an objective change put out of scope is excluded, not silently dropped
   * or named only in prose (run 10, al-08: the bowling opening, out of scope after the change, appeared nowhere).
   */
  /*
   * Evidence Brain's gate rejected is not evidence (run 13, as-02: a count the gate rejected for its population was
   * marked EVIDENCED and argued from). A quantity is EVIDENCED only on a source the gate did not reject; one resting on
   * nothing but rejected sources is an ESTIMATE or UNKNOWN until accepted evidence replaces it.
   */
  if (brain?.rejectedSources && Object.keys(brain.rejectedSources).length) {
    const url = new Map(r.sources.map((s) => [s.id, s.url]));
    for (const q of r.quantities) {
      if (q.status !== 'EVIDENCED' || q.sources.length === 0) continue;
      const urls = q.sources.map((id) => url.get(id) ?? '').filter(Boolean);
      const rejected = urls.filter((u) => brain.rejectedSources![u] !== undefined);
      if (rejected.length && rejected.length === urls.length) {
        add('REJECTED_EVIDENCE_USED', `${q.name} is marked EVIDENCED on ${rejected.join(', ')}, which Brain's evidence gate rejected (${rejected.map((u) => brain.rejectedSources![u]).join('; ')}): mark it ESTIMATE or UNKNOWN, or cite evidence the gate accepted`, q.name);
      }
    }
  }

  if (brain) {
    const accounted = new Set([...r.strategy.opportunityIds, ...(r.chain ?? []).map((c) => c.opportunityId), ...(r.excluded ?? []).map((x) => x.opportunityId)]);
    for (const id of brain.accountFor ?? brain.admittedOpportunityIds) if (!accounted.has(id)) add('OPENING_UNACCOUNTED', `opening ${id} is on this goal but the revision neither weighs it (\`chain\`) nor sets it aside (\`excluded\` with why, e.g. outside the objective's scope)`, id);
  }

  // Stance-specific completeness.
  if (r.stance === 'NO_PLAN') {
    if (!r.noPlan || !r.noPlan.decisiveGap.trim() || !r.noPlan.resolution.trim()) add('NO_PLAN_UNJUSTIFIED', 'a no-plan result must name the decisive gap the evidence decides and an actionable resolution');
    if (r.alternatives.length === 0) add('NO_PLAN_UNJUSTIFIED', 'a no-plan result must show the alternatives it compared');
  } else {
    if (!r.strategy.title.trim() || r.strategy.opportunityIds.length === 0) add('INCOMPLETE_OUTPUT', 'the plan names no strategy or no admitted opening');
    for (const c of CHAIN) if (!r.steps.some((s) => c.need.includes(s.kind))) add('CHAIN_STEP_MISSING', `no step for ${c.label}`);
    const supplierCost = r.steps.some((s) => s.kind === 'DELIVER' && s.performer !== null && s.performer !== 'BRAIN' && s.performer !== 'OWNER' && (s.costCents === null || s.costCents > 0));
    // The supplier is paid by an ORDER step, or by the delivery step itself when its cost is the payment (completion spec §3a).
    const paidByDelivery = r.steps.some((s) => s.kind === 'DELIVER' && s.performer !== null && s.performer !== 'BRAIN' && s.performer !== 'OWNER' && (s.costCents ?? 0) > 0);
    if (supplierCost && !paidByDelivery && !r.steps.some((s) => s.kind === 'ORDER')) add('CHAIN_STEP_MISSING', 'a subcontracted delivery has a cost but no step pays the supplier (an ORDER step, or the delivery step carrying the payment)');
    for (const s of r.steps) {
      if (s.performer === null) add('STEP_FIELD_ABSENT', 'nobody performs this step', s.id);
      if (s.day === null) add('STEP_FIELD_ABSENT', 'the step has no day', s.id);
      if (['ORDER', 'DELIVER', 'COLLECT'].includes(s.kind) && !s.dependsOn) add('STEP_FIELD_ABSENT', 'an order, delivery or collection step must name what it follows', s.id);
      if (s.evidence.length === 0) add('STEP_FIELD_ABSENT', 'the step names no evidence or quantity it rests on', s.id);
      if (s.costCents === null && r.stance === 'EXECUTABLE') add('UNKNOWN_IN_EXECUTABLE', 'the step cost is unknown; a plan resting on an unknown cost is CONDITIONAL, not EXECUTABLE', s.id);
      if (s.costCents !== null && (!Number.isFinite(s.costCents) || s.costCents < 0)) add('STEP_FIELD_ABSENT', 'the step cost must be a non-negative number or null (unknown)', s.id);
      if (t.ownerPhysicalWork === 'FORBIDDEN' && s.performer === 'OWNER' && /deliver|install|drop|ship|visit|drive|on[- ]site/i.test(`${s.label} ${s.kind}`)) add('STEP_FIELD_ABSENT', 'the owner may do no physical work; this step gives it to the owner', s.id);
    }
    if (r.stance === 'CONDITIONAL' && (!r.validation || !r.validation.proof.trim() || r.validation.stop.length === 0)) add('CONDITIONAL_WITHOUT_VALIDATION', 'a conditional plan must state the proof condition it tests and when it stops');
    /*
     * A conditional plan is a "no executable plan yet" with a test (COMPLETION-SPEC §2(B)): it names the decisive missing
     * evidence — the link whose measurement decides whether the plan goes on — not a list of everything unknown
     * (acceptance run 2026-11-27: four discovery plans charted every link missing and singled out none).
     */
    if (r.stance === 'CONDITIONAL' && r.validation) {
      const decides = r.validation.decides ?? [];
      const missingAnywhere = new Set((r.chain ?? []).flatMap((c) => c.missing));
      if (decides.length === 0) add('CONDITIONAL_DECISIVE_UNNAMED', 'name in `validation.decides` the chain link(s) whose measurement decides whether this plan goes on (the decisive missing evidence), not every unknown');
      for (const l of decides) {
        if (!(CHAIN_LINKS as readonly string[]).includes(l)) add('CONDITIONAL_DECISIVE_UNNAMED', `\`validation.decides\` names ${l}, which is not a chain link`);
        else if (!missingAnywhere.has(l)) add('CONDITIONAL_DECISIVE_UNNAMED', `\`validation.decides\` names ${l}, but no opening's chain marks it missing`);
        else if (!(r.resolves ?? []).includes(l)) add('CONDITIONAL_DECISIVE_UNNAMED', `\`validation.decides\` names ${l}, but \`resolves\` says the test does not measure it`);
      }
    }
    /*
     * A conversion test proves the goal only if passing it at its threshold carries the target: the threshold's rate
     * over the contacts the plan reaches must give the deals the members need (acceptance run 11: three discovery plans
     * set 1 paid in 150-200 contacts as proof while continuing to too few contacts for the 3-7 sales the target needed;
     * run 9, ak-03, the same). Stated as a ratio, so the arithmetic is Brain's, not prose.
     */
    if (r.stance === 'CONDITIONAL' && r.validation && (r.validation.decides ?? []).includes('CONVERSION')) {
      const th = r.validation.threshold;
      const needed = (r.members ?? []).filter((m) => r.strategy.opportunityIds.includes(m.opportunityId)).reduce((sum, m) => sum + (m.deals ?? 0), 0);
      if (!th || !(th.of > 0) || !(th.paid >= 0) || !(th.reach >= 0)) {
        add('PROOF_INSUFFICIENT', 'the test decides CONVERSION: state `validation.threshold` — the pass threshold as `paid` sales from `of` contacts, and `reach`, the contacts the plan reaches in the window if it continues — so Brain can check that passing it carries the target');
      } else if (needed > 0 && (th.paid / th.of) * th.reach < needed - 1e-9) {
        add('PROOF_INSUFFICIENT', `a test passing exactly at its threshold (${th.paid} paid from ${th.of}) yields ${Math.round((th.paid / th.of) * th.reach * 10) / 10} sales over the ${th.reach} contacts the plan reaches, under the ${needed} its members need for the target: raise the threshold to at least ${Math.ceil((needed * th.of) / th.reach)} from ${th.of}, or reach more contacts inside the window`);
      }
    }
    for (const id of r.strategy.opportunityIds) if (brain && !brain.admittedOpportunityIds.includes(id)) add('OPPORTUNITY_NOT_ADMITTED', `opening ${id} was never admitted to this goal; submit it as a route first`, id);
  }

  /*
   * An opening the session discovered is a hypothesis whose only provenance is what the session found: the plan cites,
   * for each it builds on, a public source about that opening (a URL outside Brain), so the owner can see where the
   * opportunity came from. A card link back into Brain is circular (acceptance run 2026-11-27, discovery worlds).
   */
  // Every discovered opening the plan weighs, not only the one it builds on: alternatives left as uncited categories
  // ("Upwork hourly work") are not discovered opportunities (run 7: three discovery plans cited one opening only).
  for (const id of [...new Set([...r.strategy.opportunityIds, ...(r.chain ?? []).map((c) => c.opportunityId)])]) {
    if (!brain?.discovered?.includes(id)) continue;
    const cited = r.sources.some((x) => x.opportunityId === id && /^https?:\/\//i.test(x.url) && !/^https?:\/\/brain\.local\b/i.test(x.url));
    if (!cited) add('DISCOVERY_UNSOURCED', `opening ${id} was discovered by this session: cite in \`sources\` (with \`opportunityId\`) the public page(s) that show it exists — the buyers, the offer or the request — not Brain's own card`, id);
  }

  // Every step's cost reconciled to the ledger: each costed step paid or committed exactly by the
  // outflows linked to it, every outflow linked to a step. An omitted expense, an unlinked
  // commitment and a cost counted twice are each refused, so the caps below read the whole cost.
  if (r.stance !== 'NO_PLAN' || r.steps.length) {
    const stepIds = new Set(r.steps.map((s) => s.id));
    const linked = new Map<string, number>();
    for (const e of r.cash) {
      if (e.kind === 'RECEIPT' || e.kind === 'REFUND' || e.kind === 'FUNDING') continue;
      if (!e.stepId) { add('CASH_UNLINKED', `outflow "${e.label}" (${e.kind} ${e.amountCents / 100}) names no step whose cost or obligation it pays (set its stepId)`, `day ${e.day}`); continue; }
      if (!stepIds.has(e.stepId)) { add('CASH_UNLINKED', `outflow "${e.label}" names step ${e.stepId}, which the plan does not have`, `day ${e.day}`); continue; }
      linked.set(e.stepId, (linked.get(e.stepId) ?? 0) + (e.kind === 'RELEASE' ? -e.amountCents : e.amountCents));
    }
    for (const s of r.steps) {
      const paid = linked.get(s.id) ?? 0;
      if (s.costCents === null) continue;
      if (s.costCents > 0 && paid === 0) add('STEP_COST_UNRECONCILED', `the step costs ${s.costCents / 100} but no cash entry pays or commits it: the expense is omitted from the ledger (a cash outflow with stepId ${s.id})`, s.id);
      else if (paid !== s.costCents) add('STEP_COST_UNRECONCILED', `the step costs ${s.costCents / 100} but its linked outflows total ${paid / 100}${paid > s.costCents ? ': counted twice' : ': part of it is omitted'}`, s.id);
    }
    const stepCost = r.steps.reduce((sum, s) => sum + (s.costCents ?? 0), 0);
    if (t.totalSpendCapCents !== null && stepCost > t.totalSpendCapCents) add('TOTAL_SPEND_OVER', `the steps cost ${stepCost / 100} in all, over the ${t.totalSpendCapCents / 100} total-spend cap, whatever the cash sequence states`);
    if (t.exposureCapCents !== null && t.exposureCapCents === 0 && stepCost > 0 && !r.cash.some((e) => e.kind === 'RECEIPT')) add('EXPOSURE_OVER', `the steps cost ${stepCost / 100} with no receipt to fund them under a zero exposure cap`);
  }

  // Owner work: every owner step states its hours, and the total fits what the goal allows. An unstated allowance is
  // UNKNOWN — never zero (which refused n14's plan in the 2026-11-27 frozen run) and never unlimited: a plan that
  // needs owner hours the goal does not state rests on that unknown, so it is at most CONDITIONAL on the owner saying
  // how many hours they can give. A stated allowance, zero included, is a limit.
  {
    const ownerSteps = r.steps.filter((s) => s.performer === 'OWNER');
    for (const s of ownerSteps) if (typeof s.ownerHours !== 'number' || !Number.isFinite(s.ownerHours) || s.ownerHours < 0) add('STEP_FIELD_ABSENT', 'an owner step must state its owner hours', s.id);
    const hours = ownerSteps.reduce((sum, s) => sum + (typeof s.ownerHours === 'number' ? s.ownerHours : 0), 0);
    const weeks = t.windowDays !== null ? t.windowDays / 7 : null;
    const allowed = t.ownerHoursPerWeek !== null && weeks !== null ? t.ownerHoursPerWeek * weeks : (brain?.hoursCeiling ?? null);
    if (hours > 0 && allowed === null && r.stance === 'EXECUTABLE') {
      add('UNKNOWN_IN_EXECUTABLE', `the plan gives the owner ${hours} hours and the goal states no owner hours: the owner's availability is unknown, so the plan is at most CONDITIONAL until the owner says how many hours they can give`, null);
    }
    if (hours > 0 && allowed !== null && hours > allowed + 1e-9) {
      add('OWNER_HOURS_OVER', `the plan gives the owner ${hours} hours; the goal allows ${Math.round(allowed * 10) / 10} over the window`, null);
    }
    // A weekly allowance binds each week, not only the total (run 14, au-03: 3.5 owner hours in week 1 against "2
    // hours a week, no more", inside the window's 6).
    if (t.ownerHoursPerWeek !== null) {
      const byWeek = new Map<number, number>();
      for (const s of ownerSteps) if (typeof s.ownerHours === 'number' && typeof s.day === 'number') byWeek.set(Math.floor(s.day / 7), (byWeek.get(Math.floor(s.day / 7)) ?? 0) + s.ownerHours);
      for (const [w, h] of [...byWeek].sort((a, b) => a[0] - b[0])) {
        if (h > t.ownerHoursPerWeek + 1e-9) add('OWNER_HOURS_OVER', `week ${w + 1} (days ${w * 7}-${w * 7 + 6}) gives the owner ${Math.round(h * 10) / 10} hours; the goal allows ${t.ownerHoursPerWeek} a week`, null);
      }
    }
  }

  /*
   * Pay for the owner's own hours is a wage, not a price a buyer pays for an offer (COMPLETION-SPEC §3; run 14,
   * au-01: a platform's published hourly pay for work the owner performs was the plan's only "price"). An opening
   * whose revenue is hourly pay and whose work is the owner's is set aside or shown to be a sale, never built on.
   */
  for (const id of r.strategy.opportunityIds) {
    if (brain?.wagePriced?.includes(id) && brain.fulfilment?.[id]?.by === 'OWNER') {
      add('WAGE_AS_PRICE', `${id}'s revenue is hourly pay for work the owner performs — a wage, not a price a buyer pays for an offer; set it aside (\`excluded\`) or build on an opening with a purchase price`, id);
    }
  }

  // Fulfilment: each delivery is performed by whoever the opening's own record says fulfils it,
  // and a Brain delivery needs the deliverable capability Brain actually holds.
  if (r.stance !== 'NO_PLAN') {
    const performerClass = (p: string | null) => (p === null ? null : p === 'BRAIN' ? 'BRAIN' : p === 'OWNER' ? 'OWNER' : 'PROVIDER');
    for (const s of r.steps.filter((one) => one.kind === 'DELIVER')) {
      for (const id of r.strategy.opportunityIds) {
        const f = brain?.fulfilment?.[id];
        if (!f) continue;
        if (f.by === 'NOBODY') { add('FULFILMENT_UNESTABLISHED', `nobody is established to fulfil ${id}; a plan cannot deliver it`, s.id); continue; }
        const mine = performerClass(s.performer);
        if (mine !== f.by) add('PERFORMER_MISMATCH', `${id} is fulfilled by ${f.by === 'PROVIDER' ? `the provider ${f.name}` : f.by.toLowerCase()} on its own record; this step gives it to ${mine === 'PROVIDER' ? s.performer : (mine ?? 'nobody').toLowerCase()}`, s.id);
      }
    }
    // Capabilities as Brain reads them: a missing record is never a pass.
    for (const s of r.steps) {
      if (s.performer !== 'BRAIN') continue;
      if (!s.executor) { add('CAPABILITY_UNREAD', 'Brain has no executor record for this step, so whether it holds the capability is unread', s.id); continue; }
      const missing = s.executor.capabilities.filter((c) => c.state === 'NOT_DECLARED');
      if (missing.length) add('CAPABILITY_NOT_HELD', `Brain performs this step through ${missing.map((c) => c.id).join(', ')}, which it does not hold`, s.id);
    }
  }

  // Money: every limit separately, commitments included, receipts never raising a limit.
  for (const e of r.cash) if (!Number.isFinite(e.amountCents) || e.amountCents < 0) add('STEP_FIELD_ABSENT', `cash entry "${e.label}" needs a non-negative amount`, `day ${e.day}`);
  const trace = cashTrace(r, t);
  const spendAndCommitted = trace.totalSpentCents + trace.committedOpenCents;
  if (t.totalSpendCapCents !== null && spendAndCommitted > t.totalSpendCapCents) {
    add('TOTAL_SPEND_OVER', `spending ${trace.totalSpentCents / 100} plus open commitments ${trace.committedOpenCents / 100} exceeds the ${t.totalSpendCapCents / 100} total-spend cap (receipts do not raise it)`);
  }
  if (t.preProofSpendCapCents !== null && r.proofDay !== null && trace.preProofCents > t.preProofSpendCapCents) {
    add('PRE_PROOF_SPEND_OVER', `spending and commitments before proof (day ${r.proofDay}) reach ${trace.preProofCents / 100}, over the ${t.preProofSpendCapCents / 100} pre-proof cap`);
  }
  if (t.preProofSpendCapCents !== null && r.proofDay === null && r.stance !== 'NO_PLAN') add('PRE_PROOF_SPEND_OVER', 'the contract has a pre-proof cap but the plan states no proof day, so nothing separates pre-proof spending');
  if (t.exposureCapCents !== null && trace.maxExposureCents > t.exposureCapCents) add('EXPOSURE_OVER', `out-of-pocket reaches ${trace.maxExposureCents / 100}, over the ${t.exposureCapCents / 100} exposure cap`);
  if (trace.minCashCents < 0) add('CASH_SHORTFALL', `cash goes to ${trace.minCashCents / 100} on day ${trace.minCashDay}: final profit does not cover an interim shortfall`, trace.minCashDay === null ? null : `day ${trace.minCashDay}`);
  for (const e of r.cash) if (e.kind === 'RECEIPT' && t.windowDays !== null && e.day > t.windowDays) add('COLLECTION_AFTER_DEADLINE', `"${e.label}" is collected on day ${e.day}, after the ${t.windowDays}-day window`, `day ${e.day}`);
  if (r.stance === 'EXECUTABLE' && trace.collectedInWindowCents < t.targetCents) add('TARGET_NOT_CARRIED', `the plan collects ${trace.collectedInWindowCents / 100} net of refunds in the window, under the ${t.targetCents / 100} target; it can only be CONDITIONAL or NO_PLAN`);

  // Unknowns, evidence relevance, dates and calibration.
  const sources = new Map(r.sources.map((s) => [s.id, s]));
  for (const q of r.quantities) {
    if (q.status === 'UNKNOWN' && q.value !== null) add('UNKNOWN_FILLED', `"${q.name}" is UNKNOWN but carries the figure ${q.value}; an unknown is null`, q.name);
    if (q.status !== 'UNKNOWN' && q.value !== null && !Number.isFinite(q.value)) add('UNKNOWN_FILLED', `"${q.name}" has a non-finite value`, q.name);
    if (q.status === 'UNKNOWN' && !(q.needs ?? '').trim()) add('UNKNOWN_FILLED', `"${q.name}" is unknown and names no research or test that would establish it`, q.name);
    if ((q.status === 'UNKNOWN' || q.status === 'ASSUMED') && r.stance === 'EXECUTABLE') add('UNKNOWN_IN_EXECUTABLE', `"${q.name}" is ${q.status}; the plan is at most CONDITIONAL`, q.name);
    if (q.status === 'EVIDENCED' && q.sources.length === 0) add('SOURCE_UNREFERENCED', `"${q.name}" is called EVIDENCED but cites no source`, q.name);
    for (const sid of q.sources) {
      const s = sources.get(sid);
      if (!s) { add('SOURCE_UNREFERENCED', `"${q.name}" cites source ${sid}, which the revision does not list`, q.name); continue; }
      if (!s.matchesBuyer && /demand|conversion|buyer|order|close|reply|uptake/i.test(q.name)) {
        add('EVIDENCE_TRANSFER', `"${q.name}" rests on ${s.id}, which measures ${s.population}, not this plan's buyer; refuse the transfer or mark the quantity UNKNOWN`, q.name);
      }
      // An old source may be historical context; presented as current evidence it is stale.
      if (q.status === 'EVIDENCED' && s.dated && Date.parse(s.dated) < Date.parse(today) - 3 * 365 * 86_400_000) add('STALE_SOURCE', `${s.id} is dated ${s.dated}, over three years old; restate it as historical context or find current evidence`, s.id);
    }
  }
  if (r.reach && r.reach.presentedAs === 'PROBABILITY' && !r.reach.calibrated) add('REACH_UNCALIBRATED', `a simulated reach of ${r.reach.value} is presented as a probability without calibration against resolved outcomes; present it as coverage of stated ranges`);
  return p;
}

/** The stance a revision may carry, given its problems; the session's stance is never upgraded by Brain. */
export function certifiable(problems: readonly CheckProblem[]): boolean {
  return problems.length === 0;
}
