/**
 * The grader's observation of a plan an app session authored (server/services/planning/sessionPlanning.ts),
 * so the completion specification grades a session's revision with the same `grade` it grades the
 * planner's reading with (docs/COMPLETION-SPEC.md). Only structured fields of the revision are read —
 * its stance, its per-opening chain judgement, its members, steps, cash, constraints and what its tests
 * resolve — never its prose. The goal's scope and target are Brain's own reading of the goal (the
 * planner run the session's check recorded), never the session's.
 *
 * Capabilities are read from the executor record Brain attaches to every step at submission
 * (`stepExecutor` over the live inventory). A Brain step without one is observed as performing
 * through an undeclared capability, so a missing record fails the check rather than disabling it.
 *
 * One difference from `observe` on a planner reading, stated rather than hidden:
 *   - a CONDITIONAL plan is observed as NO_PLAN at the verdict level (the planner's own stance calls a
 *     plan executable only once its close rate is measured), and the owner-usable level reads its
 *     members' missing links exactly as it reads the planner's.
 */
import type { PlanRevisionInput } from '../../server/domain/sessionPlanning.ts';
import type { BrainRunSummary } from '../../server/services/planning/sessionPlanning.ts';
import type { Constraint, Link } from './case.ts';
import type { ObservedExecution, ObservedMember, ObservedPlan, ObservedStep } from './grade.ts';

const UNESTABLISHED_FOR: Partial<Record<Link, string[]>> = {
  OFFER_AND_PRICE: ['price'],
  ECONOMICS: ['directCost'],
  SETTLES_IN_TIME: ['daysToCash'],
};
const TRANSACT: ReadonlySet<string> = new Set(['REACHABLE_BUYER', 'OFFER_AND_PRICE', 'FULFILMENT']);
const FEASIBLE: ReadonlySet<string> = new Set(['REACHABLE_BUYER', 'FULFILMENT', 'SETTLES_IN_TIME']);
const STAGE: Record<string, string | null> = { REACH: 'REACH', OFFER: 'OFFER', SELL: 'OFFER', ORDER: 'ORDER', DELIVER: 'DELIVER', COLLECT: 'COLLECT', RESEARCH: null, TEST: null, OTHER: null };

export function observeSession(r: PlanRevisionInput, brain: Pick<BrainRunSummary, 'scope' | 'openings' | 'excluded'>, keyOf: (opportunityId: string) => string): ObservedPlan {
  const scope = brain.scope;
  const daysLeft = scope?.daysLeft ?? null;
  const missing: Record<string, Link[]> = {};
  for (const c of r.chain ?? []) missing[keyOf(c.opportunityId)] = c.missing as Link[];
  const memberIds = r.strategy.opportunityIds;
  const byId = new Map((r.members ?? []).map((m) => [m.opportunityId, m]));
  const executable = r.stance === 'EXECUTABLE';
  const members: ObservedMember[] = memberIds.map((id) => {
    const m = byId.get(id);
    const links = missing[keyOf(id)] ?? [];
    return {
      key: keyOf(id),
      unestablished: links.flatMap((l) => UNESTABLISHED_FOR[l] ?? []),
      capitalLow: m?.capital ?? null,
      cashStructure: false,
      deals: m?.deals ?? null,
      dealsCounted: executable ? (m?.deals ?? null) : null,
    };
  });
  const named = new Set<Link>();
  for (const id of memberIds.length ? memberIds : (r.chain ?? []).map((c) => c.opportunityId)) for (const l of missing[keyOf(id)] ?? []) named.add(l);
  const constraints = (r.constraints ?? []).map((k) => k.constraint as Constraint);
  const settles = (e: PlanRevisionInput['cash'][number]) => e.settlesDay ?? e.day;
  const collectAfterDeadline = daysLeft !== null && (r.steps.some((s) => s.kind === 'COLLECT' && s.day !== null && s.day > daysLeft) || r.cash.some((e) => e.kind === 'RECEIPT' && settles(e) > daysLeft));

  const order = new Map(r.steps.map((s, i) => [s.id, i + 1]));
  const memberKeys = memberIds.map(keyOf);
  const steps: ObservedStep[] = r.steps.map((s, i) => {
    const stage = STAGE[s.kind] ?? null;
    const performer = s.performer === null ? null : s.performer === 'BRAIN' ? 'BRAIN' : s.performer === 'OWNER' ? 'OWNER' : 'PROVIDER';
    const operation = s.kind === 'REACH' ? 'REACH_BUYERS' : s.kind === 'OFFER' || s.kind === 'SELL' ? 'SEND_OFFER' : s.kind === 'DELIVER' ? (performer === 'BRAIN' ? 'BRAIN_PRODUCES' : 'SUPPLIER_DELIVERS') : s.kind === 'COLLECT' ? 'COLLECT_PAYMENT' : s.kind === 'ORDER' ? 'PAY_SUPPLIER' : null;
    const absent: string[] = [];
    if (s.evidence.length === 0) absent.push('evidence');
    if (stage === 'OFFER' && typeof s.priceCents !== 'number') absent.push('price');
    if (performer === 'OWNER' && typeof s.ownerHours !== 'number') absent.push('hours');
    return {
      order: i + 1,
      label: s.label,
      kind: s.kind === 'RESEARCH' ? 'RESEARCH' : s.kind === 'TEST' ? 'VALIDATE' : 'EXECUTE',
      stage,
      costSource: s.costCents === null ? null : 'SESSION',
      unscheduled: s.day === null ? 'UNSCHEDULED' : daysLeft !== null && s.day > daysLeft ? 'AFTER_DEADLINE' : null,
      cost: s.costCents === null ? null : s.costCents / 100,
      startDay: s.day === null ? null : { low: s.day, high: s.day },
      dependsOn: s.dependsOn ? (order.get(s.dependsOn) ?? null) : null,
      requires: [],
      basis: s.evidence.join(', '),
      performer,
      operation,
      does: s.label,
      routine: s.executor ? s.executor.routine : performer === 'OWNER',
      capabilities: s.executor ? s.executor.capabilities : performer === 'BRAIN' ? [{ id: 'UNRECORDED', state: 'NOT_DECLARED' }] : [],
      pays: s.kind === 'ORDER',
      members: memberKeys,
      absent,
      price: typeof s.priceCents === 'number' ? s.priceCents / 100 : null,
    };
  });
  const economics: ObservedExecution['economics'] = {};
  for (const m of r.members ?? []) {
    economics[keyOf(m.opportunityId)] = {
      price: m.price === null ? null : { low: m.price, high: m.price },
      cost: m.directCost === null ? null : { low: m.directCost, high: m.directCost },
    };
  }
  const considered = [...new Set([...(r.chain ?? []).map((c) => keyOf(c.opportunityId)), ...memberKeys])];
  const excluded = [...new Set((r.excluded ?? []).map((x) => keyOf(x.opportunityId)))];
  const execution: ObservedExecution = {
    steps,
    daysLeft,
    hoursCeiling: scope?.hoursCeiling ?? null,
    strategies: (r.strategy.title.trim() ? 1 : 0) + r.alternatives.length,
    considered,
    excluded,
    resolves: (r.resolves ?? []) as Link[],
    relax: (r.constraints ?? []).filter((k) => k.suggestion.trim()).map((k) => k.constraint as Constraint),
    researchFirst: r.quantities.filter((q) => q.status === 'UNKNOWN' && q.needs).length,
    economics,
  };
  const counted = r.stance === 'NO_PLAN' ? [] : memberKeys;
  const priceHeld: Record<string, number> = {};
  const dealsModelled: Record<string, number> = {};
  for (const m of r.members ?? []) {
    const key = keyOf(m.opportunityId);
    if (m.price !== null && !(missing[key] ?? []).includes('OFFER_AND_PRICE')) priceHeld[key] = m.price;
    if (m.deals !== null) dealsModelled[key] = m.deals;
  }
  return {
    stance: executable ? 'EXECUTABLE' : 'NO_PLAN',
    status: r.stance,
    verdict: null,
    infeasible: r.stance === 'NO_PLAN' && constraints.length ? constraints : null,
    broken: constraints,
    members,
    missing,
    named: [...named],
    collectAfterDeadline,
    scope: { industry: scope?.industry ?? null, recurring: scope?.recurring ?? null, hoursPerWeek: scope?.hoursPerWeek ?? null },
    targetCents: scope?.targetCents ?? 0,
    gate: null,
    execution,
    mechanism: {
      counted,
      priceHeld,
      dealsModelled,
      reach: r.reach?.value ?? null,
      untransactable: memberKeys.filter((k) => (missing[k] ?? []).some((l) => TRANSACT.has(l))),
      infeasible: memberKeys.filter((k) => (missing[k] ?? []).some((l) => FEASIBLE.has(l))),
      certified: r.reach?.presentedAs === 'PROBABILITY' && r.reach.value > 0,
      adverse: null,
      pathwayP10: null,
      gap: (scope?.targetCents ?? 0) / 100,
    },
  };
}
