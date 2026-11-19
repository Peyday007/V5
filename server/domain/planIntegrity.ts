/**
 * The integrity of a commercial plan reading: the general rules every
 * confirmed planning failure broke, checked on the plan's own structure. Pure.
 *
 * Production plan reads, 2026-11-19, each failure and the rule it broke:
 *
 *   PAYER_IS_POPULATION      "GitHub", "Dutch cleaning company De Po…" and "the
 *                            production committee's investo…" were sold to as
 *                            buyer populations. The buyers a plan's steps sell
 *                            to name a population, never one organisation.
 *   LEAD_STEPS_AGREE         The plan led with cop_8015 (a Pennsylvania
 *                            opening) while its steps read "Reach GitHub" from
 *                            arr_53ae6fed770b. Steps built from an arrangement
 *                            are built from one inside the lead the plan names,
 *                            and inside the goal's own scope (transfer test:
 *                            a "developer tools" goal's steps read "Reach
 *                            Dental practices").
 *   NO_INTERNAL_KEYS         Steps read "focus:4", "price×2.50@SMALL_TICKET",
 *                            "referral-partner>arr_53ae6fed770b", "bundle". No
 *                            text a person reads carries an internal id or key.
 *   NO_FABRICATED_FIGURE     Every step cost 0 while the model held no cost. A
 *                            stage that commits money carries the model's
 *                            figure or null (unestablished), never a written 0.
 *   STEPS_SCHEDULED          Collect, Deliver and Renew had no day. Every step
 *                            that is not research has a day, follows a step
 *                            that has one, or names why it cannot be scheduled.
 *   PRICE_GROUNDED           A pooled $2,569 was swept over a 47× spread of
 *                            unrelated prices. A comparable price spans at most
 *                            `spreadMax`, or the price is unestablished.
 *   UNKNOWN_BECOMES_RESEARCH A goal with no portfolio raised no price research.
 *                            An unpriced lead population is in `unpriced`, the
 *                            list the goal tick sends as price research.
 *
 * Only what the reading proves is flagged. An unknown the plan states as an
 * unknown and sends to research is the honest state, never a violation; a
 * field the reading does not carry is not evidence of anything.
 */
import { namesABuyerPopulation } from './industry.ts';

export const PLAN_INTEGRITY_RULES = [
  'PAYER_IS_POPULATION',
  'LEAD_STEPS_AGREE',
  'NO_INTERNAL_KEYS',
  'NO_FABRICATED_FIGURE',
  'STEPS_SCHEDULED',
  'PRICE_GROUNDED',
  'UNKNOWN_BECOMES_RESEARCH',
] as const;
export type PlanIntegrityRule = (typeof PLAN_INTEGRITY_RULES)[number];

export interface PlanIntegrityViolation {
  rule: PlanIntegrityRule;
  detail: string;
}

/** The stage of a transaction a step built from a constructed arrangement is (`arrangementSteps`). */
export const ARRANGEMENT_STAGES = ['RESEARCH', 'REACH', 'SUPPLY_TERMS', 'OFFER', 'COLLECT', 'ORDER', 'DELIVER', 'REPEAT'] as const;
export type ArrangementStage = (typeof ARRANGEMENT_STAGES)[number];

/**
 * Where a step's cost comes from. MODEL — the figure the plan's model (or the
 * arrangement's stress test) holds for that stage; NOT_OWNERS — 0, because
 * the buyers, the supplier or an earlier order pays it; NOT_SPENT — 0, because
 * the stage moves no money (research, asking for terms); NONE_HELD — null,
 * the model holds no cost for the stage.
 */
export type StepCostSource = 'MODEL' | 'NOT_OWNERS' | 'NOT_SPENT' | 'NONE_HELD';

/** Why a step has no day, when its builder could not schedule it. */
export type UnscheduledReason = 'NO_MODEL_DAYS' | 'AFTER_DEADLINE' | 'TERMS_CONFLICT';

/** The stages that commit money or effort the model could price: a written 0 there is a figure, and needs a source. */
const MONEY_STAGES: ReadonlySet<ArrangementStage> = new Set(['REACH', 'OFFER', 'COLLECT', 'ORDER', 'DELIVER', 'REPEAT']);

export interface IntegrityStep {
  order: number;
  label: string;
  detail: string;
  cost: number | null;
  startDay: { low: number; high: number } | null;
  dependsOn: number | null;
  kind: 'RESEARCH' | 'VALIDATE' | 'EXECUTE';
  /** Set on a step built from a constructed arrangement. */
  arrangementKey?: string | null;
  stage?: ArrangementStage | null;
  costSource?: StepCostSource | null;
  unscheduled?: UnscheduledReason | null;
}

/** How the price of the arrangement a plan's steps sell was read. */
export interface IntegrityLeadPrice {
  /**
   * OWN — a figure for these buyers (evidence, their own reconstruction);
   * COMPARABLE — swept across other buyers' published prices; VARIABLE — the
   * price is the decision variable over an observed cost; UNPRICED — nothing
   * prices it, so the price is a research question.
   */
  basis: 'OWN' | 'COMPARABLE' | 'VARIABLE' | 'UNPRICED';
  /** p90/p10 of the comparable prices it was swept over (COMPARABLE only). */
  spread: number | null;
}

export interface PlanIntegrityInput {
  /** The ids the plan names as its lead: the acceptance's candidate (or accepted plan), else its best combination. */
  leadIds: readonly string[];
  /** The prefix a constructed arrangement's id carries in `leadIds` (`arr_`). */
  arrangementIdPrefix: string;
  steps: readonly IntegrityStep[];
  /** The constructed arrangement the plan leads with, when it has one. */
  lead: { arrangementKey: string; buyers: string; population: string; price: IntegrityLeadPrice; inScope?: boolean } | null;
  /** The populations the reading sends as price research (`reading.unpriced`). */
  unpriced: readonly { population: string }[];
  /** Other text a person reads: the summary, the acceptance's sentence and labels, the next test. */
  texts: readonly { where: string; text: string }[];
  /** The widest p90/p10 a comparable price may span (`COMPARABLE_SPREAD_MAX`). */
  spreadMax: number;
}

/**
 * Internal ids and keys a person must never read: an entity id (`arr_`, `cop_`,
 * `opp_`, `wst_` followed by its hex or word id), a reconstruction key
 * (`focus:4`), a price change key (`×2.50@SMALL_TICKET`), a partner key
 * (`>arr_…`). A closed set of shapes, never a reading of the prose.
 */
const INTERNAL_KEY: readonly { what: string; re: RegExp }[] = [
  { what: 'an internal id', re: /\b(?:arr|cop|opp|wst)_[0-9a-z]{4,}\b/i },
  { what: 'a reconstruction key', re: /\b[a-z][a-z-]*:\d+\b/ },
  { what: 'a price change key', re: /×\s*\d+(?:\.\d+)?\s*@/ },
  { what: 'a partner key', re: />\s*arr_/ },
];
/** A label that is a bare lower-case identifier ("bundle", "deposit", "referral-partner") is a key, not a title. */
const BARE_KEY_LABEL = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export function internalKeyIn(text: string): string | null {
  for (const one of INTERNAL_KEY) {
    const hit = one.re.exec(text);
    if (hit) return `${one.what} "${hit[0]}"`;
  }
  return null;
}

const clip = (text: string, n = 80) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function planIntegrity(input: PlanIntegrityInput): { violations: PlanIntegrityViolation[] } {
  const violations: PlanIntegrityViolation[] = [];
  const add = (rule: PlanIntegrityRule, detail: string) => violations.push({ rule, detail });
  const fromArrangement = input.steps.filter((s) => s.arrangementKey);
  const stepKeys = [...new Set(fromArrangement.map((s) => s.arrangementKey!))];
  const leadsSteps = !!input.lead && fromArrangement.length > 0 && stepKeys.includes(input.lead.arrangementKey);

  // PAYER_IS_POPULATION: the buyers the steps sell to.
  if (input.lead && leadsSteps && !namesABuyerPopulation(input.lead.buyers)) {
    add('PAYER_IS_POPULATION', `the steps sell to "${clip(input.lead.buyers)}", which names one organisation or no buyer, not a population`);
  }

  // LEAD_STEPS_AGREE: steps built from an arrangement come from one the plan names as its lead.
  const named = new Set(input.leadIds);
  for (const key of stepKeys) {
    if (input.lead && key !== input.lead.arrangementKey) add('LEAD_STEPS_AGREE', `steps are built from arrangement ${key}, not from the plan's leading arrangement ${input.lead.arrangementKey}`);
    else if (named.size > 0 && !named.has(`${input.arrangementIdPrefix}${key}`)) {
      add('LEAD_STEPS_AGREE', `steps are built from arrangement ${key}, which is not in the lead the plan names (${[...named].slice(0, 4).join(', ')})`);
    }
  }

  // A lead outside the goal's own scope (its one industry, its recurring unit) is no lead of this goal's.
  if (input.lead && leadsSteps && input.lead.inScope === false) {
    add('LEAD_STEPS_AGREE', `the steps sell "${clip(input.lead.buyers)}" (arrangement ${input.lead.arrangementKey}), which is outside the goal's own scope`);
  }

  // NO_INTERNAL_KEYS: every label and detail a person reads.
  for (const s of input.steps) {
    const hit = internalKeyIn(s.label) ?? internalKeyIn(s.detail);
    if (hit) add('NO_INTERNAL_KEYS', `step ${s.order} ("${clip(s.label, 60)}") carries ${hit}`);
    else if (BARE_KEY_LABEL.test(s.label.trim())) add('NO_INTERNAL_KEYS', `step ${s.order} is titled with the key "${s.label}"`);
  }
  for (const t of input.texts) {
    const hit = internalKeyIn(t.text);
    if (hit) add('NO_INTERNAL_KEYS', `${t.where} carries ${hit}`);
  }

  // NO_FABRICATED_FIGURE: a number on a stage that commits money needs a source.
  for (const s of fromArrangement) {
    if (s.cost === null) continue;
    const money = s.stage ? MONEY_STAGES.has(s.stage) : false;
    if (s.costSource === 'NONE_HELD' || (money && (!s.costSource || s.costSource === 'NOT_SPENT'))) {
      add('NO_FABRICATED_FIGURE', `step ${s.order} ("${clip(s.label, 60)}") states a cost of ${s.cost} that the model does not hold`);
    }
  }

  // STEPS_SCHEDULED: a day, a scheduled predecessor, or a stated reason why not.
  const byOrder = new Map(input.steps.map((s) => [s.order, s]));
  for (const s of input.steps) {
    if (s.kind === 'RESEARCH' || s.startDay || s.unscheduled) continue;
    const before = s.dependsOn !== null ? byOrder.get(s.dependsOn) : undefined;
    if (before?.startDay) continue;
    add('STEPS_SCHEDULED', `step ${s.order} ("${clip(s.label, 60)}") has no day, follows no scheduled step, and states no reason it cannot be scheduled`);
  }

  // PRICE_GROUNDED and UNKNOWN_BECOMES_RESEARCH: the price of the arrangement the steps sell.
  if (input.lead && leadsSteps) {
    const p = input.lead.price;
    if (p.basis === 'COMPARABLE' && p.spread !== null && p.spread > input.spreadMax * (1 + 1e-9)) {
      add('PRICE_GROUNDED', `the price of "${clip(input.lead.buyers)}" is swept across comparable prices spanning ${Math.round(p.spread * 10) / 10}×, wider than the ${input.spreadMax}× a comparable price may span`);
    }
    if (p.basis === 'UNPRICED' && !input.unpriced.some((u) => u.population === input.lead!.population)) {
      add('UNKNOWN_BECOMES_RESEARCH', `nothing prices "${clip(input.lead.buyers)}", and no price research is raised for that population`);
    }
  }
  return { violations };
}
