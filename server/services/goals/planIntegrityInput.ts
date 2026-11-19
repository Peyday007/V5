/**
 * The slice of a plan reading its integrity check reads (`planIntegrity`),
 * derived from the reading's own fields — never guessed from its prose. Pure.
 *
 * The step metadata (`PlanStep.arrangement`) and the lead (`PlanReading.lead`)
 * are written where the steps and the lead are built (`arrangementSteps`,
 * `readGoalPlan`), so what the check reads is what the planner did.
 */
import type { IntegrityLeadPrice, IntegrityMember, PlanIntegrityInput } from '../../domain/planIntegrity.ts';
import type { ConstructedArrangement } from '../cash/construct.ts';
import { ARRANGEMENT_ID_PREFIX, COMPARABLE_SPREAD_MAX, type ModelledOpportunity } from '../cash/goalScenario.ts';
import type { PlanReading } from './plan.ts';
import { BUYER_FUNDED, type GoalPortfolio } from './portfolio.ts';

/** The constructed arrangement a plan leads with, as its reading carries it. */
export interface PlanLead {
  arrangementKey: string;
  buyers: string;
  /** The buyer population's reference (`demand.ref`): what `reading.unpriced` names. */
  population: string;
  price: IntegrityLeadPrice;
  /** Whether the arrangement is inside the goal's own scope (`GoalModel.arrangementsInScope`); true when the model read no scope. */
  inScope: boolean;
}

/**
 * How the leading arrangement's price was read: from the model that scored
 * it, else from the arrangement's own value. A sweep across other buyers'
 * prices (provenance UNKNOWN, tier MECHANISM) is COMPARABLE, with the spread
 * of the prices it was swept over (its p90/p10, `sweptOverOtherPrices`).
 */
export function leadPrice(a: Pick<ConstructedArrangement, 'value' | 'unknownParts'>, modelled: Pick<ModelledOpportunity, 'price' | 'priceVariable'> | null): IntegrityLeadPrice {
  if (modelled?.priceVariable) return { basis: 'VARIABLE', spread: null };
  const price = modelled?.price ?? null;
  const inf = price?.inferred ?? null;
  if (price && price.provenance === 'UNKNOWN' && inf?.tier === 'MECHANISM') {
    return { basis: 'COMPARABLE', spread: inf.p10 > 0 ? inf.p90 / inf.p10 : null };
  }
  const held = price !== null && (price.value !== null || price.high !== null || inf !== null);
  if (held) return { basis: 'OWN', spread: null };
  const unknown = a.value.tier === 'UNKNOWN' || a.unknownParts.includes('value') || !(a.value.p90 > 0);
  return { basis: unknown ? 'UNPRICED' : 'OWN', spread: null };
}

/** The reading's lead: the arrangement `leadingArrangement` chose, with its price as read. */
export function leadOf(lead: ConstructedArrangement | null, modelled: ModelledOpportunity | null, inScope: readonly string[] | null = null): PlanLead | null {
  if (!lead) return null;
  return { arrangementKey: lead.key, buyers: lead.demand.name, population: lead.demand.ref, price: leadPrice(lead, modelled), inScope: inScope === null || inScope.includes(lead.key) };
}

type IntegrityReading = Pick<PlanReading, 'acceptance' | 'steps' | 'summary' | 'nextTest' | 'unpriced' | 'lead'> & {
  portfolio: ({ best: { members: { opportunityId: string }[] } | null } & Partial<Pick<GoalPortfolio, 'demand' | 'limits'>>) | null;
  reconstruction?: PlanReading['reconstruction'];
};

/**
 * The lead's members as the reading's portfolio modelled them: the lowest
 * figure the model holds each ties up at its start (`DemandEstimate.capitalHeld`),
 * and the cash structure that carries it — the portfolio's own, or, for a
 * reconstructed candidate, the buyer-funded change its reconstruction made
 * (an assumption it states). A member the portfolio did not read holds no figure.
 */
export function leadMembersOf(reading: Pick<IntegrityReading, 'acceptance' | 'portfolio' | 'reconstruction'>, ids: readonly string[]): IntegrityMember[] {
  const demand = new Map((reading.portfolio?.demand ?? []).map((d) => [d.opportunityId, d]));
  const reconstructed = reading.acceptance.candidate?.source === 'RECONSTRUCTED';
  const buyerFunded = reconstructed && (reading.reconstruction?.best?.changes ?? []).some((c) => c.op === 'capital:prepaid-fulfilment');
  return ids.map((id) => {
    const d = demand.get(id);
    return {
      title: d?.title ?? 'an opening',
      capitalLow: d?.capitalHeld?.low ?? null,
      cashStructure: d?.cashStructure ?? (buyerFunded ? BUYER_FUNDED : null),
      // The baseline's entered figure speaks for its own members; a reconstruction read them in its own evaluation.
      capitalEntered: reconstructed ? null : (d?.capitalAtStart ?? null),
      unestablishedCostLow: d?.costHeld && !d.costHeld.own ? d.costHeld.low : null,
    };
  });
}

/** The ids the plan names as its lead: its candidate, else its accepted plan, else its best combination (as `leadingArrangement` reads them). */
export function leadIdsOf(reading: Pick<IntegrityReading, 'acceptance' | 'portfolio'>): string[] {
  const candidate = reading.acceptance.candidate?.opportunityIds ?? [];
  if (candidate.length > 0) return [...candidate];
  const accepted = reading.acceptance.accepted?.opportunityIds ?? [];
  if (accepted.length > 0) return [...accepted];
  return (reading.portfolio?.best?.members ?? []).map((m) => m.opportunityId);
}

/** The integrity check's input, from a real plan reading. */
export function integrityInput(reading: IntegrityReading): PlanIntegrityInput {
  const a = reading.acceptance;
  const texts: { where: string; text: string }[] = [
    { where: 'the summary', text: reading.summary },
    { where: "the acceptance's sentence", text: a.sentence },
    ...(a.candidate ? [{ where: "the candidate's label", text: a.candidate.label }] : []),
    ...(a.accepted ? [{ where: "the accepted plan's label", text: a.accepted.label }] : []),
    ...(reading.nextTest ? [{ where: 'the next test', text: reading.nextTest.test }] : []),
  ];
  const leadIds = leadIdsOf(reading);
  const limits = reading.portfolio?.limits;
  return {
    leadIds,
    arrangementIdPrefix: ARRANGEMENT_ID_PREFIX,
    steps: reading.steps.map((s) => ({
      order: s.order,
      label: s.label,
      detail: s.detail,
      cost: s.cost,
      startDay: s.startDay,
      dependsOn: s.dependsOn,
      kind: s.kind ?? 'EXECUTE',
      arrangementKey: s.arrangement?.key ?? null,
      // An arrangement's step carries its stage with the arrangement; a reconstruction's or a sale's carries it alone.
      stage: s.arrangement?.stage ?? s.stage?.stage ?? null,
      costSource: s.arrangement?.costSource ?? s.stage?.costSource ?? null,
      unscheduled: s.arrangement?.unscheduled ?? s.stage?.unscheduled ?? null,
    })),
    lead: reading.lead ?? null,
    unpriced: reading.unpriced ?? [],
    texts,
    spreadMax: COMPARABLE_SPREAD_MAX,
    limits: limits ? { capitalCeiling: limits.capitalCeiling ?? null, beforeProof: limits.perArrangement, spendCeiling: limits.spendCeiling } : null,
    members: leadMembersOf(reading, leadIds),
  };
}

/**
 * The release check's lines for one goal (`goals.ts check`): one OK line, or
 * one VIOLATED line per violation. Reach is the accepted probability, else the
 * candidate's reach, as a percentage; `n/a` when the reading holds none. Pure.
 */
export function integrityLines(goalId: string, reading: Pick<PlanReading, 'acceptance' | 'integrity'>): { ok: boolean; lines: string[] } {
  const status = reading.acceptance.status;
  const violations = reading.integrity ?? [];
  if (violations.length > 0) return { ok: false, lines: violations.map((v) => `INTEGRITY ${goalId} VIOLATED ${status} ${v.rule}: ${v.detail.replace(/\s+/g, ' ')}`) };
  const reach = reading.acceptance.probability?.value ?? reading.acceptance.candidate?.reach ?? null;
  return { ok: true, lines: [`INTEGRITY ${goalId} OK ${status} reach ${reach === null ? 'n/a' : `${Math.round(reach * 1000) / 10}%`}`] };
}
