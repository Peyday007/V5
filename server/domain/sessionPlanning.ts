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
  kind: 'SPEND' | 'FEE' | 'COMMIT' | 'RELEASE' | 'RECEIPT' | 'REFUND';
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
  validation: { proof: string; stop: string[]; continue: string[] } | null;
  noPlan: { decisiveGap: string; resolution: string } | null;
  /** A simulated chance of reaching the target, and whether it is calibrated against resolved outcomes. */
  reach: { value: number; calibrated: boolean; presentedAs: 'PROBABILITY' | 'COVERAGE' } | null;
  /** Answers to the previous review's findings, when revising after REVISE. */
  answers: { finding: string; resolution: string }[];
  /**
   * The session's own judgement of each opening it weighed: the chain links (`CHAIN_LINKS`:
   * REACHABLE_BUYER, CURRENT_DEMAND, OFFER_AND_PRICE, CONVERSION, MARKET_VOLUME, FULFILMENT,
   * ECONOMICS, SETTLES_IN_TIME) the evidence does not establish. Structured so a grader reads
   * it, never the prose.
   */
  chain?: { opportunityId: string; missing: string[] }[];
  /** Openings set aside, each with why. */
  excluded?: { opportunityId: string; why: string }[];
  /** The deals the strategy counts per member, at the price and direct cost it was judged on (major units). */
  members?: { opportunityId: string; deals: number | null; price: number | null; directCost: number | null; capital: number | null }[];
  /** The chain links the plan's validation test or research measures (what would resolve the unknowns). */
  resolves?: string[];
  /** Constraints (DEADLINE, CAPITAL, TARGET, OWNER_HOURS) the session finds rule every plan out, with the relaxation it suggests. */
  constraints?: { constraint: string; suggestion: string }[];
  /** Set by the transport when the payload arrived incomplete. */
  truncated?: boolean;
}

/** The chain links a cash plan rests on (the planner's `CHAIN_LINKS`). */
export const CHAIN_LINKS = ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE', 'CONVERSION', 'MARKET_VOLUME', 'FULFILMENT', 'ECONOMICS', 'SETTLES_IN_TIME'] as const;
export const PLAN_CONSTRAINTS = ['DEADLINE', 'CAPITAL', 'TARGET', 'OWNER_HOURS'] as const;

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
  for (const d of days) {
    const out = entries.filter((e) => (e.kind === 'SPEND' || e.kind === 'FEE') && e.day <= d).reduce((s, e) => s + e.amountCents, 0)
      + entries.filter((e) => e.kind === 'REFUND' && e.day <= d).reduce((s, e) => s + e.amountCents, 0);
    const settled = entries.filter((e) => e.kind === 'RECEIPT' && (e.settlesDay ?? e.day) <= d).reduce((s, e) => s + e.amountCents, 0);
    // Committed but unspent money is exposure too: it is owed whether or not it has left yet.
    const committedBy = Math.max(0, entries.filter((e) => e.kind === 'COMMIT' && e.day <= d).reduce((s, e) => s + e.amountCents, 0) - entries.filter((e) => e.kind === 'RELEASE' && e.day <= d).reduce((s, e) => s + e.amountCents, 0));
    const exposure = out - settled + committedBy;
    maxExposure = Math.max(maxExposure, exposure);
    const cash = capital - exposure;
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
    for (const id of r.strategy.opportunityIds) if (brain && !brain.admittedOpportunityIds.includes(id)) add('OPPORTUNITY_NOT_ADMITTED', `opening ${id} was never admitted to this goal; submit it as a route first`, id);
  }

  // Every step's cost reconciled to the ledger: each costed step paid or committed exactly by the
  // outflows linked to it, every outflow linked to a step. An omitted expense, an unlinked
  // commitment and a cost counted twice are each refused, so the caps below read the whole cost.
  if (r.stance !== 'NO_PLAN' || r.steps.length) {
    const stepIds = new Set(r.steps.map((s) => s.id));
    const linked = new Map<string, number>();
    for (const e of r.cash) {
      if (e.kind === 'RECEIPT' || e.kind === 'REFUND') continue;
      if (!e.stepId) { add('CASH_UNLINKED', `outflow "${e.label}" (${e.kind} ${e.amountCents / 100}) names no step whose cost or obligation it pays`, `day ${e.day}`); continue; }
      if (!stepIds.has(e.stepId)) { add('CASH_UNLINKED', `outflow "${e.label}" names step ${e.stepId}, which the plan does not have`, `day ${e.day}`); continue; }
      linked.set(e.stepId, (linked.get(e.stepId) ?? 0) + (e.kind === 'RELEASE' ? -e.amountCents : e.amountCents));
    }
    for (const s of r.steps) {
      const paid = linked.get(s.id) ?? 0;
      if (s.costCents === null) continue;
      if (s.costCents > 0 && paid === 0) add('STEP_COST_UNRECONCILED', `the step costs ${s.costCents / 100} but no cash entry pays or commits it: the expense is omitted from the ledger`, s.id);
      else if (paid !== s.costCents) add('STEP_COST_UNRECONCILED', `the step costs ${s.costCents / 100} but its linked outflows total ${paid / 100}${paid > s.costCents ? ': counted twice' : ': part of it is omitted'}`, s.id);
    }
    const stepCost = r.steps.reduce((sum, s) => sum + (s.costCents ?? 0), 0);
    if (t.totalSpendCapCents !== null && stepCost > t.totalSpendCapCents) add('TOTAL_SPEND_OVER', `the steps cost ${stepCost / 100} in all, over the ${t.totalSpendCapCents / 100} total-spend cap, whatever the cash sequence states`);
    if (t.exposureCapCents !== null && t.exposureCapCents === 0 && stepCost > 0 && !r.cash.some((e) => e.kind === 'RECEIPT')) add('EXPOSURE_OVER', `the steps cost ${stepCost / 100} with no receipt to fund them under a zero exposure cap`);
  }

  // Owner work: every owner step states its hours, and the total fits what the goal allows.
  // Unstated allowance is none: the owner does no routine work the objective gives no hours for.
  {
    const ownerSteps = r.steps.filter((s) => s.performer === 'OWNER');
    for (const s of ownerSteps) if (typeof s.ownerHours !== 'number' || !Number.isFinite(s.ownerHours) || s.ownerHours < 0) add('STEP_FIELD_ABSENT', 'an owner step must state its owner hours', s.id);
    const hours = ownerSteps.reduce((sum, s) => sum + (typeof s.ownerHours === 'number' ? s.ownerHours : 0), 0);
    const weeks = t.windowDays !== null ? t.windowDays / 7 : null;
    const allowed = t.ownerHoursPerWeek !== null && weeks !== null ? t.ownerHoursPerWeek * weeks : (brain?.hoursCeiling ?? null);
    if (hours > 0 && (allowed === null || hours > allowed + 1e-9)) {
      add('OWNER_HOURS_OVER', `the plan gives the owner ${hours} hours; the goal allows ${allowed === null ? 'none (no owner hours stated)' : `${Math.round(allowed * 10) / 10} over the window`}`, null);
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
