/**
 * The goal tick sends what its portfolio could not establish (CAUSAL-14-4,
 * CAUSAL-14-7; review F2-2).
 *
 * `evaluateGoalPortfolio` names two kinds of decision-critical gap: the
 * causal graph's `decisionUnknowns` (each labelled research or an authorized
 * action) and the best combination's missing market history. Before, both
 * were only appended as text to `GoalPortfolio.missing`, and only a person
 * POSTing to `routes/causal.ts` ever handed one to an owner — so the
 * autonomous goal tick computed where each unknown should go and sent none.
 *
 * This is the tick's hand-off, through the owners that already exist and
 * nothing else (§10.3):
 *
 *   - every decision unknown goes through `sendNeeds` (services/quant/needs.ts),
 *     whose key is built from the graph's identity — here the goal and the
 *     opening, never anything a caller sent (invariant 27) — and the unknown's
 *     own wording, so the next tick reads the open row back;
 *   - every history gap of an opening in the best combination goes through
 *     `requestMarketHistory`, keyed per opening and kind as it already is.
 *
 * Idempotent by those keys: a goal read every thirty minutes raises each need
 * once. An owner's refusal is counted and returned, never dropped and never
 * counted as sent.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { sendNeeds, type Need } from '../quant/needs.ts';
import { requestMarketHistory } from '../quant/history.ts';
import type { DecisionUnknown, DemandEstimate, GoalPortfolio, RestructureEvidence, RestructureMechanism, UnpricedPopulation } from './portfolio.ts';
import { claimsAnsweringScope } from '../../repos/research.ts';
import type { ResearchClaim } from '../../domain/types.ts';
import { timingOfText } from '../cash/paymentTiming.ts';
import { GOAL_PRICE_KEY_PREFIX, GOAL_PRICE_SCOPE_PREFIX, goalPriceSubject } from './goalWork.ts';
import { namesABuyerPopulation } from '../../domain/industry.ts';

/**
 * Asking a counterparty is contacting the buyer: the commercial authority an
 * action-routed unknown needs, so one grant is found across every need it blocks.
 */
export const COUNTERPARTY_PERMISSION = 'CONTACT_BUYER';

export interface PortfolioNeedsDeps {
  sendNeeds?: typeof sendNeeds;
  requestMarketHistory?: typeof requestMarketHistory;
  getOpportunity?: typeof getOpportunity;
}

export interface PortfolioNeedsSent {
  /** Needs an owner now holds (new or read back). */
  sent: number;
  /** Of those, the ones this call wrote. */
  created: number;
  /** History gaps handed to research. */
  historyRequested: number;
  /** Refusals from an owner, with their reasons. */
  refused: string[];
}

/** The graph a decision unknown belongs to: the goal's view of one opening. */
export function goalGraphScope(goalId: string, opportunityId: string): string {
  return `goal:${goalId}:opening:${opportunityId}`;
}

/** A decision unknown in the shape the needs owner takes. */
export function needOf(one: DecisionUnknown): Need {
  return one.sendTo === 'research'
    ? { subject: one.unknown, question: `What is ${one.unknown}?`, route: 'RESEARCH', permissions: [] }
    : { subject: one.unknown, question: `Ask the counterparty ${one.unknown}`, route: 'AUTHORIZED_ACTION', permissions: [COUNTERPARTY_PERMISSION] };
}

/**
 * Hand a goal portfolio's decision unknowns and the best combination's
 * missing market history to their owners.
 */
export async function sendPortfolioNeeds(
  input: {
    goalId: string;
    projectId: string;
    portfolio: GoalPortfolio | null;
    /**
     * The reading's unpriced populations, its lead's first (`unpricedForPlan`):
     * sent even when no portfolio was evaluated. Absent, the portfolio's own.
     */
    unpriced?: readonly UnpricedPopulation[] | null;
    actorRef?: string;
  },
  deps: PortfolioNeedsDeps = {},
): Promise<PortfolioNeedsSent> {
  const send = deps.sendNeeds ?? sendNeeds;
  const request = deps.requestMarketHistory ?? requestMarketHistory;
  const read = deps.getOpportunity ?? getOpportunity;
  const actorRef = input.actorRef ?? 'BRAIN';
  const out: PortfolioNeedsSent = { sent: 0, created: 0, historyRequested: 0, refused: [] };
  const portfolio = input.portfolio;
  /*
   * What the plan could not price, sent first and with or without a
   * portfolio: production, 2026-11-19, a goal whose arrangements were all
   * unpriced evaluated no portfolio, so its populations — the plan's lead
   * among them — were never asked about, and nothing could ever price them.
   */
  await sendPriceNeeds(input.unpriced ?? portfolio?.unpriced ?? [], input.projectId, actorRef, send, out);
  if (!portfolio) return out;
  await sendRestructureNeeds(portfolio, input.goalId, input.projectId, actorRef, send, out);

  const byOpening = new Map<string, DecisionUnknown[]>();
  for (const one of portfolio.causal?.decisionUnknowns ?? []) {
    const list = byOpening.get(one.opportunityId) ?? [];
    list.push(one);
    byOpening.set(one.opportunityId, list);
  }
  for (const [opportunityId, unknowns] of byOpening) {
    const delivered = await send({
      projectId: input.projectId,
      actorRef,
      graphScope: goalGraphScope(input.goalId, opportunityId),
      needs: unknowns.map(needOf),
    });
    for (const one of delivered) {
      if (one.sent) {
        out.sent += 1;
        if (one.created) out.created += 1;
      } else out.refused.push(`${one.subject}: ${one.reason}`);
    }
  }

  /*
   * The inputs whose uncertainty most limits the plan's fifth-percentile reach
   * (Q2-6, 2026-11-14), each a targeted research question naming the input,
   * the evidence it has and what would narrow it — not generic bid/win
   * history. Keyed by the opening and the input, never the figures, so a
   * re-read raises nothing new.
   */
  for (const one of (portfolio.assurance?.limitingInputs ?? []).slice(0, 3)) {
    const opportunityId = one.opportunityIds[0];
    if (!opportunityId) continue;
    const delivered = await send({
      projectId: input.projectId,
      actorRef,
      graphScope: goalGraphScope(input.goalId, opportunityId),
      needs: [{ subject: `the ${one.input} the plan rests on`, question: one.need.slice(0, 900), route: 'RESEARCH', permissions: [] }],
    });
    for (const d of delivered) {
      if (d.sent) {
        out.sent += 1;
        if (d.created) out.created += 1;
      } else out.refused.push(`${d.subject}: ${d.reason}`);
    }
  }

  // The history the best combination lacks is what assurance.researchNeeds names.
  const best = new Set(portfolio.best?.members.map((one) => one.opportunityId) ?? []);
  for (const history of portfolio.marketHistory ?? []) {
    if (!best.has(history.opportunityId) || history.gaps.length === 0) continue;
    const opportunity = await read(history.opportunityId);
    // An estimate of a constructed arrangement has no opening row yet; its research is the construction's.
    if (!opportunity || opportunity.projectId !== input.projectId) continue;
    const result = await request({ projectId: input.projectId, actorRef, opportunity, history });
    out.historyRequested += result.requested.length;
    out.sent += result.requested.length;
    for (const one of result.refused) out.refused.push(`market history ${one.kind} for ${opportunity.id}: ${one.reason}`);
  }
  return out;
}

/*
 * What the plan could not price at all: the buyer populations whose designs
 * were refused for want of a price (production 2026-11-19, ~304 of 307 per
 * goal). One question per population, keyed by the project and the
 * population — a price filed for those buyers prices every design over
 * them, whichever goal asked — and at most `PRICE_ASKS_PER_READ` new ones a
 * read, walking past those already open so a population nobody can price
 * never holds the rest back.
 */
async function sendPriceNeeds(
  unpriced: readonly UnpricedPopulation[],
  projectId: string,
  actorRef: string,
  send: NonNullable<PortfolioNeedsDeps['sendNeeds']>,
  out: PortfolioNeedsSent,
): Promise<void> {
  let priceAsked = 0;
  for (const one of unpriced) {
    if (priceAsked >= PRICE_ASKS_PER_READ) break;
    // A price slot is spent only on buyers a list could be built of; a record field or a sentence's leftovers names nobody to price.
    if (!namesABuyerPopulation(one.buyer)) {
      out.refused.push(`${one.buyer}: not a buyer population, so nobody to price`);
      continue;
    }
    const delivered = await send({ projectId, actorRef, graphScope: priceScope(one.population), keyPrefix: GOAL_PRICE_KEY_PREFIX, needs: [priceNeedOf(one)] });
    for (const d of delivered) {
      if (d.sent) {
        out.sent += 1;
        if (d.created) {
          out.created += 1;
          priceAsked += 1;
        }
      } else out.refused.push(`${d.subject}: ${d.reason}`);
    }
  }
}

/** At most this many new restructuring questions are sent per plan read; the rest wait for the next read. */
export const RESTRUCTURE_ASKS_PER_READ = 3;

/**
 * A held-out opening's restructuring as research needs (owner, 2026-11-20:
 * an infeasible structure is reconsidered through "customer prepayment,
 * deposits, alternative fulfillment, supplier terms, staged delivery …
 * different transaction roles", each with "a defensible mechanism"). One need
 * per mechanism `restructuringOf` judged open and decision-relevant, each
 * naming the exposure it must fall below. Keyed by the goal's view of the
 * opening and the mechanism, never the figures, so a re-read raises nothing
 * new and a moved estimate raises no second question. Openings that could
 * bring in most go first; an opening too small to change the plan carries no
 * mechanisms and is asked nothing. At most `RESTRUCTURE_ASKS_PER_READ` new
 * ones a read, walking past those already open.
 */
async function sendRestructureNeeds(
  portfolio: GoalPortfolio,
  goalId: string,
  projectId: string,
  actorRef: string,
  send: NonNullable<PortfolioNeedsDeps['sendNeeds']>,
  out: PortfolioNeedsSent,
): Promise<void> {
  const held = (portfolio.demand ?? [])
    .filter((d) => d.heldOut && !d.refused && d.restructure?.material && d.restructure.mechanisms.length > 0)
    .sort((a, b) => b.restructure!.potential - a.restructure!.potential || (a.opportunityId < b.opportunityId ? -1 : 1));
  let asked = 0;
  for (const d of held) {
    for (const m of restructureNeedsOf(d)) {
      if (asked >= RESTRUCTURE_ASKS_PER_READ) return;
      const delivered = await send({ projectId, actorRef, graphScope: goalGraphScope(goalId, d.opportunityId), needs: [m] });
      for (const one of delivered) {
        if (one.sent) {
          out.sent += 1;
          if (one.created) {
            out.created += 1;
            asked += 1;
          }
        } else out.refused.push(`${one.subject}: ${one.reason}`);
      }
    }
  }
}

/** A mechanism as a restructuring question's subject names it: `supplier terms` for SUPPLIER_TERMS. */
const mechanismWords = (m: RestructureMechanism): string => m.toLowerCase().replace(/_/g, ' ');

/** A held-out opening's restructuring mechanisms in the shape the needs owner takes: the subject names the mechanism, never a figure. */
export function restructureNeedsOf(d: Pick<DemandEstimate, 'title' | 'restructure'>): Need[] {
  return (d.restructure?.mechanisms ?? []).map((m) => ({
    subject: `whether "${d.title.slice(0, 120)}" can be restructured within the goal's limit: ${mechanismWords(m.mechanism)}`,
    question: m.question.slice(0, 900),
    route: 'RESEARCH',
    permissions: [],
  }));
}

/**
 * The opening and mechanism a goal's restructuring question asked about, read
 * back from the idea `sendNeeds` opened for it: its statement starts `For
 * causal graph goal:<goal>:opening:<opening>,` (`goalGraphScope`) and its
 * question is one `restructuringOf` wrote. The mechanism is read from the
 * title's last words (`restructureNeedsOf`), or — where a long title cut them
 * off — from the question's own opening words. Null when the idea is not that
 * question: then nothing is read from its answers.
 */
export function restructureQuestionOf(goalId: string, idea: { title: string; statement: string }): { opportunityId: string; mechanism: RestructureMechanism } | null {
  const scope = `For causal graph ${goalGraphScope(goalId, '')}`;
  if (!idea.statement.startsWith(scope) || !idea.title.startsWith('Causal unknown: whether "')) return null;
  const rest = idea.statement.slice(scope.length);
  const marker = ', establish from sourced evidence: ';
  const at = rest.indexOf(marker);
  const opportunityId = at > 0 ? rest.slice(0, at).trim() : '';
  if (!opportunityId) return null;
  const question = rest.slice(at + marker.length);
  const named = /can be restructured within the goal's limit: ([a-z ]+)$/.exec(idea.title)?.[1];
  const byTitle = RESTRUCTURE_MECHANISMS.find((m) => mechanismWords(m) === named);
  const byQuestion = RESTRUCTURE_MECHANISMS.find((m) => RESTRUCTURE_QUESTION_START[m].test(question));
  const mechanism = byTitle ?? byQuestion;
  return mechanism ? { opportunityId, mechanism } : null;
}

const RESTRUCTURE_MECHANISMS: readonly RestructureMechanism[] = ['PREPAYMENT', 'SUPPLIER_TERMS', 'STAGED_DELIVERY', 'BROKER_ROLE', 'CHEAPER_FULFILMENT'];

/** How each of `restructuringOf`'s questions begins. */
const RESTRUCTURE_QUESTION_START: Record<RestructureMechanism, RegExp> = {
  PREPAYMENT: /^Do buyers of ".*" pay a deposit or prepay before it is delivered/s,
  SUPPLIER_TERMS: /^Do suppliers of what ".*" delivers extend payment terms/s,
  STAGED_DELIVERY: /^Is ".*" bought and billed in stages/s,
  BROKER_ROLE: /^Would whoever fulfils ".*" pay a referral or broker commission/s,
  CHEAPER_FULFILMENT: /^Is there a published way to fulfil ".*" for less/s,
};

/** Words that say a mechanism is not open to a new account, or is open only conditionally: such an answer establishes nothing. */
const NOT_OPEN = /\b(not|no|never|none|don't|doesn't|won't|cannot|can't|rarely|seldom|unlikely|only (?:after|once|for|to|with)|established (?:accounts?|customers?|credit)|after \d+ (?:months?|years?|orders?)|credit (?:check|history|application) (?:is )?required)\b/i;

/** Supplier payment terms a text states, in days: "net 30", "net-60", "30-day terms", "terms of 45 days". */
const SUPPLIER_TERM_DAYS = /\bnet[\s-]*(\d{1,3})\b|\b(\d{1,3})[\s-]*days?\s+(?:payment\s+|credit\s+|trade\s+|invoice\s+)?terms\b|\bterms\s+of\s+(\d{1,3})\s+days\b/i;

/**
 * What one claim answering a restructuring question establishes for its
 * mechanism, or why it establishes nothing. Every gate holds (invariant 39):
 * the claim is accepted, carries a source URL, states the figure the
 * mechanism needs as a finite positive number, and says nothing that closes
 * the mechanism to a new account. PREPAYMENT reads the claim as payment
 * timing (`timingOfText`): a stated share before delivery, never arrears and
 * never a deposit with no share. SUPPLIER_TERMS reads stated net days. The
 * other mechanisms establish nothing yet. Pure.
 */
export function restructureAnswerOf(claim: Pick<ResearchClaim, 'id' | 'claim' | 'accepted' | 'sourceUrl'>, mechanism: RestructureMechanism): RestructureEvidence | { refused: string } {
  if (!claim.accepted) return { refused: 'claim is not gated (accepted)' };
  if (!claim.sourceUrl) return { refused: 'claim has no source URL' };
  const text = claim.claim.trim();
  if (NOT_OPEN.test(text)) return { refused: 'the claim states the mechanism is closed, or open only on a condition' };
  const base = { mechanism, claimId: claim.id, sourceUrl: claim.sourceUrl, basis: text };
  if (mechanism === 'PREPAYMENT') {
    const timing = timingOfText(text, `claim ${claim.id}`);
    if (timing.timing !== 'PREPAID') return { refused: `the claim does not state payment before delivery (${timing.timing})` };
    const share = timing.share ?? null;
    if (share === null || !Number.isFinite(share) || share <= 0 || share > 1) return { refused: 'the claim states no share of the price paid before delivery' };
    return { ...base, share };
  }
  if (mechanism === 'SUPPLIER_TERMS') {
    const m = SUPPLIER_TERM_DAYS.exec(text);
    const days = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
    if (!Number.isFinite(days) || days <= 0) return { refused: 'the claim states no supplier payment terms in days' };
    return { ...base, termDays: days };
  }
  return { refused: `an answer about ${mechanismWords(mechanism)} is not yet read as a figure the plan can use` };
}

/**
 * The accepted, sourced answers to this goal's restructuring questions, by
 * the opening each question named (§93): claim → orchestration → mission →
 * the idea the question opened (`claimsAnsweringScope`), and the opening and
 * mechanism are the question's own (`restructureQuestionOf`), never the
 * researcher's. The plan reads them on its next portfolio read
 * (`PlannedOpening.restructureEvidence`, `evidencedRestructuring`).
 */
export async function restructureEvidenceOf(
  projectId: string,
  goalId: string,
  deps: { claimsAnsweringScope?: typeof claimsAnsweringScope } = {},
): Promise<Map<string, RestructureEvidence[]>> {
  const read = deps.claimsAnsweringScope ?? claimsAnsweringScope;
  const out = new Map<string, RestructureEvidence[]>();
  for (const { claim, idea } of await read(projectId, goalGraphScope(goalId, ''))) {
    const asked = restructureQuestionOf(goalId, idea);
    if (!asked) continue;
    const answer = restructureAnswerOf(claim, asked.mechanism);
    if ('refused' in answer) continue;
    const list = out.get(asked.opportunityId) ?? [];
    list.push(answer);
    out.set(asked.opportunityId, list);
  }
  return out;
}

/** At most this many new price questions are sent per plan read; the rest wait for the next read. */
export const PRICE_ASKS_PER_READ = 3;

/** The scope a population's price question is keyed in: the project's buyers, not one goal's graph. */
export function priceScope(population: string): string {
  return `${GOAL_PRICE_SCOPE_PREFIX}${population}`;
}

/**
 * A refused population's price as a research need: the construction's own
 * one-figure question (`nextInputQuestion`), which names the buyers, the
 * deliverable and the fact its answer files, and asks how they pay it.
 *
 * The qualifier is pinned to the buyers' exact name (production 2026-11-20:
 * ten accepted goal-price fragments, 16 declared `price_per_unit` claims, no
 * fact — researchers wrote sentences such as "GitHub Inc is the payer" into
 * `structural_qualifier`). The back-fill files an answer to this question
 * against the population the question names whatever the qualifier says
 * (`judgeUnitEconomic`); the pinned name keeps the claim legible on its own.
 */
export function priceNeedOf(one: UnpricedPopulation): Need {
  return {
    subject: goalPriceSubject(one.buyer),
    question:
      `${one.question} For each price, also say by what payment mechanism these buyers pay it (per purchase, subscription, retainer, deposit or prepayment, commission or revenue share) and when the money moves. ` +
      `Set structural_qualifier to exactly "${one.buyer}" — the buyers' name and nothing else: no sentence, no seller, no plan name, no source. ` +
      `${one.designs} design(s) Brain constructed for these buyers wait on this one figure.`,
    route: 'RESEARCH',
    permissions: [],
  };
}

/** At most this many of the adopted plan's own questions are sent per plan read (C-9). */
export const PLAN_QUESTIONS_PER_READ = 3;

/** The graph the adopted plan's own questions belong to: the goal's plan, not one opening. */
export function goalPlanScope(goalId: string): string {
  return `goal:${goalId}:plan`;
}

/**
 * Send the adopted plan's own questions (C-9): the conditions the plan needs
 * outside today's evidence, the ones that swing it most, and the reply rate it
 * needs — the `plan:` entries of the reading's research priority that are not
 * about one opening (those reach `researchGoalPaths`), decided RESEARCH_FIRST,
 * largest value first. Through `sendNeeds`, keyed by the goal's plan scope and
 * the condition, never its number, so a re-read raises nothing new and a
 * figure that moves does not raise a second question.
 */
export async function sendPlanQuestions(
  input: { goalId: string; projectId: string; priority: ReadonlyArray<{ variable: string; opportunityId: string | null; decision: string; value: number; reason: string }>; actorRef?: string; max?: number },
  deps: Pick<PortfolioNeedsDeps, 'sendNeeds'> = {},
): Promise<PortfolioNeedsSent> {
  const send = deps.sendNeeds ?? sendNeeds;
  const out: PortfolioNeedsSent = { sent: 0, created: 0, historyRequested: 0, refused: [] };
  const top = input.priority
    // An assumed change is measured by executing its step (its kill criterion), not by research.
    .filter((one) => one.variable.startsWith('plan:') && !one.variable.startsWith('plan:change:') && one.opportunityId === null && one.decision === 'RESEARCH_FIRST')
    .sort((a, b) => b.value - a.value)
    .slice(0, input.max ?? PLAN_QUESTIONS_PER_READ);
  if (top.length === 0) return out;
  const needs: Need[] = top.map((one) => {
    const condition = one.variable.slice('plan:'.length);
    return {
      subject: `the goal plan's condition "${condition}"`,
      question: `What published evidence shows how ${condition} behaves for buyers and offers like this plan's? The plan's reading: ${one.reason}`.slice(0, 900),
      route: 'RESEARCH',
      permissions: [],
    };
  });
  const delivered = await send({ projectId: input.projectId, actorRef: input.actorRef ?? 'BRAIN', graphScope: goalPlanScope(input.goalId), needs });
  for (const one of delivered) {
    if (one.sent) {
      out.sent += 1;
      if (one.created) out.created += 1;
    } else out.refused.push(`${one.subject}: ${one.reason}`);
  }
  return out;
}
