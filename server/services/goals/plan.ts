/**
 * Whether Brain may recommend a plan for a goal — an evidence gate, not an
 * adjective.
 *
 * For each strategy the scenario adapter composed, the gate walks the causal
 * chain a cash plan rests on and asks, from rows, whether each link is
 * established:
 *
 *   reachable buyer → current demand → offer and price → conversion →
 *   fulfilment → economics within the limits → cash settled before the deadline
 *
 * A link counts only when a row establishes it — a gated claim, a recorded
 * agreement, this Brain's own measured outcomes, a capability Brain has proved.
 * A model's prose, a long research report or a confident sentence counts for
 * nothing, so a weak plan cannot pass by being described better.
 *
 * Three verdicts:
 *
 *   * `NOT_VIABLE` — a hard limit fails on a known number (more money tied up
 *     than the ceiling, cash that settles after the deadline, a price under its
 *     cost), or the strategy cannot reach the target even in the best tested
 *     case.
 *   * `NEEDS_EVIDENCE` — a link is missing. The verdict names the first missing
 *     link in chain order and the cheapest test that would settle it, and who
 *     can run that test today. A sweep that looks good is not evidence.
 *   * `RECOMMENDABLE` — every link is established *and* a conservative reading
 *     of the established numbers (lowest measured agreement rate, lowest
 *     price, highest cost, slowest settlement) still reaches the target inside
 *     the limits.
 *
 * A numeric chance of success is reported only from this Brain's own record of
 * how earlier recommended goal plans turned out, with its sample and a Wilson
 * interval, and only once that record is large enough. Otherwise there is no
 * number — never one composed from assumptions.
 */
import { getDb } from '../../db/database.ts';
import { newId } from '../../repos/util.ts';
import { getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent } from '../../repos/register.ts';
import { readCapabilities } from '../cash/capabilities.ts';
import { checkCommercialAuthority } from '../cash/authority.ts';
import { composeGoalModel, wilson, type ModelledOpportunity } from '../cash/goalScenario.ts';
import { readTarget, type TargetReading } from './target.ts';
import { compileModel, canonicalJson, sha256 } from '../scenario/model.ts';
import { getScenarioModel } from '../../repos/scenario.ts';
import { runModel, saveModel } from '../scenario/service.ts';
import { runIsolated, ScenarioBusyError } from '../scenario/isolate.ts';
import type { ScenarioResult } from '../../domain/scenario.ts';
import type { Workstream } from '../../domain/register.ts';

export const PLAN_VERDICTS = ['RECOMMENDABLE', 'NEEDS_EVIDENCE', 'NOT_VIABLE'] as const;
export type PlanVerdict = (typeof PLAN_VERDICTS)[number];

/** The links of a cash plan's causal chain, in the order they are checked. */
export const CHAIN_LINKS = ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE', 'CONVERSION', 'FULFILMENT', 'ECONOMICS', 'SETTLES_IN_TIME'] as const;
export type ChainLink = (typeof CHAIN_LINKS)[number];

export const CHAIN_LABEL: Record<ChainLink, string> = {
  REACHABLE_BUYER: 'a buyer we can actually reach',
  CURRENT_DEMAND: 'a dated sign they need it now',
  OFFER_AND_PRICE: 'an offer and a price',
  CONVERSION: 'buyers who have actually agreed to it',
  FULFILMENT: 'proof Brain can deliver it',
  ECONOMICS: 'known costs and money tied up, inside the limits',
  SETTLES_IN_TIME: 'cash that settles before the deadline',
};

/**
 * The policy a recommendation is held to. Configurable by code review only —
 * a plan cannot lower the bar it is judged against.
 */
export const RECOMMENDATION_POLICY = {
  /** A buying signal older than this is not "now". */
  demandFreshDays: 30,
  /** Earlier recommended goal plans needed before Brain quotes a success rate. */
  minPlanOutcomes: 10,
  /** The lower bound of that rate a quoted chance must clear to be called likely. */
  likelyLowerBound: 0.5,
} as const;

export interface LinkCheck {
  link: ChainLink;
  ok: boolean;
  /** The row or rule that establishes it, or what is missing. */
  basis: string;
}

export interface NextTest {
  link: ChainLink;
  /** What would settle it, in plain words. */
  test: string;
  /** Who can do it today. */
  by: 'BRAIN' | 'PERSON';
  /** When a person is needed, exactly what for. */
  blocker: string | null;
}

export interface StrategyReading {
  key: string;
  label: string;
  verdict: PlanVerdict;
  opportunityIds: string[];
  links: LinkCheck[];
  constraintsFailed: string[];
  /** Coverage of tested conditions, never a probability unless the run says so. */
  sweep: { goalMetShare: number | null; settledP50: number | null; settledP90: number | null; infeasibleShare: number | null; probabilistic: boolean };
  /** The conservative settled figure, when every input it needs is established. */
  conservativeSettled: number | null;
  nextTest: NextTest | null;
}

export interface PlanReading {
  goalId: string;
  verdict: PlanVerdict;
  /** Why, in one sentence. */
  summary: string;
  chosen: string | null;
  strategies: StrategyReading[];
  nextTest: NextTest | null;
  /** The scenario run this rests on, when one ran. */
  scenarioModelId: string | null;
  scenarioRunId: string | null;
  basisNote: string | null;
  /** What the model left out, and why. */
  excluded: { opportunityId: string; title: string; reason: string }[];
  /** Only from this Brain's own record of earlier recommended plans. */
  measuredChance: { estimate: number; lowerBound: number; upperBound: number; sampleSize: number; cohort: string } | null;
  target: TargetReading;
  refusal: string | null;
}

const DAY = 86_400_000;

function linkChecks(one: ModelledOpportunity, deals: number, target: TargetReading, capabilities: Map<string, string>, now: Date): LinkCheck[] {
  const o = one.opportunity;
  const fresh = o.signalObservedAt && now.getTime() - Date.parse(o.signalObservedAt) <= RECOMMENDATION_POLICY.demandFreshDays * DAY;
  const caps = o.requiredCapabilities;
  const allPresent = caps.length > 0 && caps.every((id) => capabilities.get(id) === 'PRESENT');
  const established = (input: { provenance: string }) => input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL';
  return [
    { link: 'REACHABLE_BUYER', ok: !!o.reachableChannel && !!o.payer, basis: o.reachableChannel ? `reach: ${o.reachableChannel.slice(0, 80)}` : 'nobody has established how to reach the buyer' },
    { link: 'CURRENT_DEMAND', ok: !!(o.buyingSignal && fresh), basis: o.buyingSignal ? (fresh ? `signal dated ${o.signalObservedAt!.slice(0, 10)}` : 'the buying signal is undated or older than the policy allows') : 'no buying signal recorded' },
    { link: 'OFFER_AND_PRICE', ok: !!o.offerScope && one.price.value !== null, basis: one.price.value !== null ? `price ${one.price.value} ${target.currency} (${one.price.provenance})` : 'no single price on the card' },
    {
      link: 'CONVERSION',
      ok: deals === 0 ? one.agreed : one.close.provenance === 'HISTORICAL',
      basis:
        deals === 0
          ? one.agreed ? `buyers have agreed to ${one.agreedValue} ${target.currency}` : 'nothing agreed and no buyers offered'
          : one.close.provenance === 'HISTORICAL'
            ? one.close.note
            : `${deals} new buyer(s) would be offered and nobody knows how many would agree${one.agreed ? ` (one agreement of ${one.agreedValue} is recorded)` : ''}`,
    },
    { link: 'FULFILMENT', ok: allPresent && one.hours.value !== null, basis: allPresent ? (one.hours.value !== null ? `Brain has proved: ${caps.join(', ')}` : 'deliverable is proved but the hours are unknown') : caps.length ? `not proved: ${caps.filter((id) => capabilities.get(id) !== 'PRESENT').join(', ')}` : 'nobody has said what Brain would deliver' },
    {
      link: 'ECONOMICS',
      ok: one.directCost.value !== null && one.capital.value !== null && established(one.directCost) && one.capital.value !== null,
      basis: one.directCost.value !== null && one.capital.value !== null ? `cost ${one.directCost.value}, tied up ${one.capital.value}` : 'costs or money tied up are not established',
    },
    {
      link: 'SETTLES_IN_TIME',
      ok: one.daysToCash.value !== null && target.daysLeft !== null && one.daysToCash.value <= target.daysLeft && established(one.daysToCash),
      basis: one.daysToCash.value !== null ? `${one.daysToCash.value} days to usable cash against ${target.daysLeft} left` : 'nobody has established when the money would settle',
    },
  ];
}

async function nextTestFor(link: ChainLink, one: ModelledOpportunity, projectId: string): Promise<NextTest> {
  const title = one.opportunity.title.slice(0, 80);
  switch (link) {
    case 'CONVERSION': {
      const contact = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER' });
      const message = (await readCapabilities(['SEND_A_MESSAGE']))[0];
      const test = `A bounded offer test for "${title}": send the offer to a few reachable buyers and count who agrees. Fewer agreements than the plan needs downgrades it.`;
      if (!contact.ok) return { link, test, by: 'PERSON', blocker: `Brain has no standing permission to contact buyers here (${contact.reason}). Grant CONTACT_BUYER under the commercial authority to let it run this test.` };
      if (message?.state !== 'PRESENT') return { link, test, by: 'PERSON', blocker: 'No message provider is connected, so Brain cannot send the offer. Connect one.' };
      return { link, test, by: 'BRAIN', blocker: null };
    }
    case 'FULFILMENT':
      return { link, test: `Prove Brain can produce what "${title}" needs, on a real sample, and record the hours.`, by: 'BRAIN', blocker: null };
    case 'REACHABLE_BUYER':
      return { link, test: `Find a published, permitted way to reach the buyer for "${title}".`, by: 'BRAIN', blocker: null };
    case 'CURRENT_DEMAND':
      return { link, test: `Find a dated sign from the last ${RECOMMENDATION_POLICY.demandFreshDays} days that the buyer for "${title}" needs it now.`, by: 'BRAIN', blocker: null };
    case 'OFFER_AND_PRICE':
      return { link, test: `Establish the offer and one price for "${title}" from what buyers pay today.`, by: 'BRAIN', blocker: null };
    case 'ECONOMICS':
      return { link, test: `Establish the direct cost and money tied up for "${title}" from published figures.`, by: 'BRAIN', blocker: null };
    case 'SETTLES_IN_TIME':
      return { link, test: `Establish when money for "${title}" would actually settle (payment terms and payout timing).`, by: 'BRAIN', blocker: null };
  }
}

/** The conservative settled figure for a strategy, or null when an input it needs is unknown. */
function conservative(members: { one: ModelledOpportunity; deals: number }[], target: TargetReading): { settled: number | null; exposure: number | null; labour: number | null } {
  let settled = 0;
  let exposure = 0;
  let labour = 0;
  for (const { one, deals } of members) {
    const close = deals === 0 ? 0 : one.close.provenance === 'HISTORICAL' ? one.close.low : null;
    const price = one.price.value ?? one.price.low;
    const days = one.daysToCash.value;
    const cost = one.directCost.value;
    const capital = one.capital.value;
    const hours = one.hours.value;
    if (close === null || price === null || days === null || cost === null || capital === null || hours === null) return { settled: null, exposure: null, labour: null };
    const won = deals * close;
    settled += days <= (target.daysLeft ?? 0) ? one.agreedValue + won * price : 0;
    exposure += deals * capital;
    labour += won * hours;
  }
  return { settled, exposure, labour };
}

function sweepOf(result: ScenarioResult | null, key: string): StrategyReading['sweep'] {
  const s = result?.strategies.find((one) => one.key === key);
  if (!result || !s) return { goalMetShare: null, settledP50: null, settledP90: null, infeasibleShare: null, probabilistic: false };
  return {
    goalMetShare: s.metrics['goal_met']?.mean ?? null,
    settledP50: s.metrics['settled']?.p50 ?? null,
    settledP90: s.metrics['settled']?.p90 ?? null,
    infeasibleShare: s.evaluated ? s.infeasible / s.evaluated : null,
    probabilistic: result.probabilistic,
  };
}

/** This Brain's record of earlier recommended goal plans: achieved in time, out of all that ended. */
export async function measuredPlanChance(): Promise<PlanReading['measuredChance']> {
  const rows = await getDb().all<{ kind: string }>(
    `SELECT o.kind FROM goal_outcomes o JOIN goal_plan_readings r ON r.id = o.reading_id WHERE r.verdict = 'RECOMMENDABLE'`,
  );
  if (rows.length < RECOMMENDATION_POLICY.minPlanOutcomes) return null;
  const achieved = rows.filter((one) => one.kind === 'ACHIEVED').length;
  const bounds = wilson(achieved, rows.length);
  return { estimate: achieved / rows.length, lowerBound: bounds.low, upperBound: bounds.high, sampleSize: rows.length, cohort: 'goal plans this Brain recommended, and how they ended' };
}

/**
 * Read a goal's plan: compose the model from rows, run the existing engine,
 * and apply the gate. Writes nothing unless `persist` is set, and then only the
 * scenario model and run (through the scenario service) and an append-only
 * reading when the conclusion changed.
 */
export async function readGoalPlan(input: { goalId: string; now?: Date; persist?: boolean; evaluations?: number }): Promise<PlanReading | null> {
  const now = input.now ?? new Date();
  const goal = await getWorkstream(input.goalId);
  if (!goal) return null;
  const target = await readTarget(goal, now);
  if (!target) return null;
  const model = await composeGoalModel({ goal, target, now });
  const measuredChance = await measuredPlanChance();
  const base = { goalId: goal.id, target, excluded: model.excluded, measuredChance };
  if (model.refusal) {
    const reading: PlanReading = {
      ...base,
      verdict: target.achieved ? 'RECOMMENDABLE' : 'NEEDS_EVIDENCE',
      summary: model.refusal,
      chosen: null,
      strategies: [],
      nextTest: target.achieved
        ? null
        : { link: 'OFFER_AND_PRICE', test: 'Qualify at least one opening: establish who pays, an offer and a price, so there is a plan to judge.', by: 'BRAIN', blocker: null },
      scenarioModelId: null,
      scenarioRunId: null,
      basisNote: null,
      refusal: model.refusal,
    };
    if (input.persist) await persistReading(goal, reading, null);
    return reading;
  }

  // Run the existing engine. Stored and versioned when persisting.
  const options = { seed: parseInt(sha256(goal.id).slice(0, 8), 16) >>> 0, evaluations: input.evaluations ?? 20_000 };
  let result: ScenarioResult | null = null;
  let scenarioModelId: string | null = null;
  let scenarioRunId: string | null = null;
  const owner = goal.ownerUserId ?? goal.createdByUserId;
  if (input.persist && owner) {
    const definitionHash = compileModel(model.definition).hash;
    const last = await latestReading(goal.id);
    const lastModel = last?.scenario_model_id ? await getScenarioModel(last.scenario_model_id) : null;
    const saved = lastModel && lastModel.definitionHash === definitionHash ? lastModel : await saveModel({ projectId: target.projectId, definition: model.definition, createdById: owner });
    const run = await runModel({ model: saved, options, label: `goal ${goal.id}`, createdById: owner });
    scenarioModelId = saved.id;
    scenarioRunId = run.id;
    result = run.result ?? null;
  } else {
    result = await runIsolated(model.definition, options);
  }

  const capabilities = new Map((await readCapabilities([...new Set(model.included.flatMap((one) => one.opportunity.requiredCapabilities)), 'SEND_A_MESSAGE'])).map((one) => [one.id, one.state]));
  const strategies: StrategyReading[] = [];
  for (const spec of model.definition.strategies) {
    const members = model.included
      .map((one) => ({ one, deals: Number(spec.set[`o${one.index}_n`] ?? 0) }))
      .filter((member) => member.deals > 0 || member.one.agreedValue > 0);
    const links = CHAIN_LINKS.map((link) => {
      const checks = members.map(({ one, deals }) => linkChecks(one, deals, target, capabilities, now).find((check) => check.link === link)!);
      return { link, ok: checks.every((check) => check.ok), basis: checks.map((check) => check.basis).join(' | ') };
    });
    const constraintsFailed: string[] = [];
    for (const { one, deals } of members) {
      if (one.capital.value !== null && one.capital.provenance !== 'UNKNOWN') {
        const ceiling = target.capitalCeilingCents;
        if (ceiling !== null && deals * one.capital.value > ceiling / 100) constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" ties up ${deals * one.capital.value} ${target.currency}, more than the ${ceiling / 100} ceiling`);
      }
      if (one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && target.daysLeft !== null && one.daysToCash.value > target.daysLeft) {
        constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" settles in ${one.daysToCash.value} days, after the ${target.daysLeft} left`);
      }
      if (one.price.value !== null && one.directCost.value !== null && one.directCost.provenance !== 'UNKNOWN' && one.price.value <= one.directCost.value) {
        constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" costs at least what it pays`);
      }
      if (one.opportunity.expiresAt && Date.parse(one.opportunity.expiresAt) < now.getTime()) constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" closed on ${one.opportunity.expiresAt.slice(0, 10)}`);
    }
    const sweep = sweepOf(result, spec.key);
    // The best case is computed from established numbers only — every offered
    // buyer agreeing — never from the bounds a sweep happened to test.
    const best = members.reduce((sum, { one, deals }) => {
      const late = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && target.daysLeft !== null && one.daysToCash.value > target.daysLeft;
      return sum + (late ? 0 : one.agreedValue + deals * (one.price.high ?? one.price.value ?? 0));
    }, 0);
    if (best < target.remainingCents / 100) {
      constraintsFailed.push(`cannot reach the ${target.remainingCents / 100} ${target.currency} still needed even if every buyer it offers to agreed (at most ${Math.round(best)})`);
    }
    if (sweep.infeasibleShare === 1) constraintsFailed.push('breaks the money or hours limit in every tested case');
    const cons = conservative(members, target);
    const missing = links.find((one) => !one.ok);
    let verdict: PlanVerdict;
    if (constraintsFailed.length > 0) verdict = 'NOT_VIABLE';
    else if (missing) verdict = 'NEEDS_EVIDENCE';
    else if (
      cons.settled !== null && cons.settled >= target.remainingCents / 100 &&
      (target.capitalCeilingCents === null || (cons.exposure ?? Infinity) <= target.capitalCeilingCents / 100) &&
      (target.hoursCeiling === null || (cons.labour ?? Infinity) <= target.hoursCeiling)
    ) verdict = 'RECOMMENDABLE';
    else verdict = 'NEEDS_EVIDENCE';
    let nextTest: NextTest | null = null;
    if (verdict === 'NEEDS_EVIDENCE') {
      if (missing) {
        const member = members.find(({ one, deals }) => !linkChecks(one, deals, target, capabilities, now).find((check) => check.link === missing.link)!.ok)!;
        nextTest = await nextTestFor(missing.link, member.one, target.projectId);
      } else {
        nextTest = { link: 'CONVERSION', test: 'Every link is established, but the cautious numbers fall short of the target: add a second opening or more buyers and test again.', by: 'BRAIN', blocker: null };
      }
    }
    strategies.push({
      key: spec.key,
      label: spec.label,
      verdict,
      opportunityIds: members.map(({ one }) => one.opportunity.id),
      links,
      constraintsFailed,
      sweep,
      conservativeSettled: cons.settled,
      nextTest,
    });
  }

  const rank = (s: StrategyReading) => (s.verdict === 'RECOMMENDABLE' ? 0 : s.verdict === 'NEEDS_EVIDENCE' ? 1 : 2);
  const ordered = [...strategies].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.conservativeSettled ?? -1) - (a.conservativeSettled ?? -1) ||
      a.links.filter((one) => !one.ok).length - b.links.filter((one) => !one.ok).length ||
      (b.sweep.goalMetShare ?? 0) - (a.sweep.goalMetShare ?? 0),
  );
  const chosen = ordered[0] ?? null;
  const verdict: PlanVerdict = chosen?.verdict ?? 'NEEDS_EVIDENCE';
  const summary =
    verdict === 'RECOMMENDABLE'
      ? `"${chosen!.label}" is recommendable: every link is established and the cautious numbers reach the target inside the limits.`
      : verdict === 'NOT_VIABLE'
        ? `No modelled strategy can work under the current limits: ${chosen?.constraintsFailed[0] ?? 'every one fails a limit'}.`
        : `Not yet proven. The closest plan is "${chosen?.label}", and what it is missing first is ${CHAIN_LABEL[chosen!.nextTest!.link]}.`;
  const reading: PlanReading = {
    ...base,
    verdict,
    summary,
    chosen: chosen?.key ?? null,
    strategies,
    nextTest: chosen?.nextTest ?? null,
    scenarioModelId,
    scenarioRunId,
    basisNote: result?.basisNote ?? null,
    refusal: null,
  };
  if (input.persist) await persistReading(goal, reading, chosen);
  return reading;
}

interface ReadingRow {
  id: string;
  workstream_id: string;
  digest: string;
  scenario_model_id: string | null;
  scenario_run_id: string | null;
  verdict: string;
  chosen_strategy: string | null;
  strategies: string;
  next_test: string | null;
  forecast: string | null;
  created_at: string;
}

export async function latestReading(goalId: string): Promise<ReadingRow | null> {
  return (await getDb().get<ReadingRow>(
    'SELECT * FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [goalId],
  )) ?? null;
}

export async function listReadings(goalId: string): Promise<ReadingRow[]> {
  return await getDb().all<ReadingRow>('SELECT * FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at ASC, id ASC', [goalId]);
}

/** Append a reading when its conclusion differs from the last; link a recommended plan's work to the goal. */
async function persistReading(goal: Workstream, reading: PlanReading, chosen: StrategyReading | null): Promise<void> {
  const summary = {
    verdict: reading.verdict,
    chosen: reading.chosen,
    strategies: reading.strategies.map((one) => ({ key: one.key, verdict: one.verdict, missing: one.links.filter((link) => !link.ok).map((link) => link.link), failed: one.constraintsFailed })),
    next: reading.nextTest,
    refusal: reading.refusal,
  };
  const digest = sha256(canonicalJson(summary));
  const last = await latestReading(goal.id);
  if (last && last.digest === digest) return;
  const forecast = chosen
    ? { conservativeSettled: chosen.conservativeSettled, sweep: chosen.sweep, remainingCents: reading.target.remainingCents, daysLeft: reading.target.daysLeft }
    : null;
  await getDb().run(
    `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('gpr'),
      goal.id,
      digest,
      reading.scenarioModelId,
      reading.scenarioRunId,
      reading.verdict,
      reading.chosen,
      JSON.stringify(reading.strategies),
      reading.nextTest ? JSON.stringify(reading.nextTest) : null,
      forecast ? JSON.stringify(forecast) : null,
      new Date().toISOString(),
    ],
  );
  await recordWorkstreamEvent({
    workstreamId: goal.id,
    kind: 'GOAL_PLAN_READ',
    summary: reading.summary.slice(0, 400),
    actorRef: 'BRAIN',
  });
  // A recommended plan's opportunities become work this goal pursues, so the
  // goal tick holds and prioritizes them. Execution itself stays with the
  // existing commercial authority and its effects.
  if (reading.verdict === 'RECOMMENDABLE' && chosen) {
    const links = await listLinks(goal.id);
    for (const opportunityId of chosen.opportunityIds) {
      if (links.some((one) => one.kind === 'OPPORTUNITY' && one.ref === opportunityId && one.relation === 'PURSUES')) continue;
      await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: opportunityId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
    }
  }
}

/**
 * What actually happened, against the reading in force: written once when the
 * target is reached or the due date passes. Failures stay in the record —
 * they are half of what any later success rate is computed from.
 */
export async function recordGoalOutcome(goalId: string, now: Date = new Date()): Promise<'ACHIEVED' | 'MISSED' | null> {
  const goal = await getWorkstream(goalId);
  if (!goal?.target) return null;
  const target = await readTarget(goal, now);
  if (!target) return null;
  const due = goal.dueAt ? Date.parse(goal.dueAt) : null;
  const kind = target.achieved && (due === null || now.getTime() <= due) ? 'ACHIEVED' : due !== null && now.getTime() > due ? (target.achieved ? 'ACHIEVED' : 'MISSED') : null;
  if (!kind) return null;
  const reading = (await getDb().get<{ id: string }>(
    'SELECT id FROM goal_plan_readings WHERE workstream_id = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [goal.id, now.toISOString()],
  )) ?? null;
  if (!reading) return null;
  const result = await getDb().run(
    `INSERT INTO goal_outcomes (id, workstream_id, reading_id, kind, achieved_cents, target_cents, detail, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reading_id, kind) DO NOTHING`,
    [newId('gou'), goal.id, reading.id, kind, target.achievedCents, target.targetCents, JSON.stringify({ metric: target.metric, notCounted: target.notCounted }), now.toISOString()],
  );
  return (result.changes ?? 0) > 0 ? kind : null;
}

/** The tick's pass: re-read every targeted goal's plan at most this often. */
export const PLAN_REFRESH_MS = 30 * 60_000;

export async function advanceGoalPlans(now: Date = new Date()): Promise<{ read: number; outcomes: number; busy: boolean }> {
  const goals = await getDb().all<{ id: string }>(
    `SELECT id FROM workstreams WHERE target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL`,
  );
  let read = 0;
  let outcomes = 0;
  for (const { id } of goals) {
    if (await recordGoalOutcome(id, now)) outcomes += 1;
    const last = await getDb().get<{ at: string | null }>(
      `SELECT MAX(created_at) AS at FROM goal_plan_readings WHERE workstream_id = ?`,
      [id],
    );
    const lastRun = await getDb().get<{ at: string | null }>(
      `SELECT MAX(r.started_at) AS at FROM scenario_runs r JOIN goal_plan_readings g ON g.scenario_model_id = r.model_id WHERE g.workstream_id = ?`,
      [id],
    );
    const since = [last?.at, lastRun?.at].filter((one): one is string => !!one).reduce((max, at) => Math.max(max, Date.parse(at)), 0);
    if (since && now.getTime() - since < PLAN_REFRESH_MS) continue;
    try {
      await readGoalPlan({ goalId: id, now, persist: true });
      read += 1;
    } catch (error) {
      if (error instanceof ScenarioBusyError) return { read, outcomes, busy: true };
      throw error;
    }
  }
  return { read, outcomes, busy: false };
}
