/**
 * The goals door: the briefing across goals, one goal with its evidence, and
 * the decisions a person makes about a goal.
 *
 * The same guard as the register it sits on (§43): every route is
 * `requirePerson`, so a worker is refused by type — a machine that could pause,
 * reprioritize or cancel somebody's goals would be deciding how capacity is
 * spent, which §22's split reserves to a person. Scope is settled before the
 * query through `decideProjectAccess`, and absent and forbidden are one 404
 * with one body (invariant 23). There is no goals policy module and there must
 * never be one.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  nullableString,
  optionalEnum,
  optionalString,
  pathId,
  requiredString,
  requirePerson,
} from './helpers.ts';
import { GOAL_COMMITMENTS, type GoalCommitment } from '../domain/goals.ts';
import { getWorkstream, listWorkstreamEvents } from '../repos/register.ts';
import { snapshotHistory } from '../repos/goals.ts';
import { getMembership } from '../repos/identity.ts';
import { listProjects } from '../repos/projects.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import { goalBriefing } from '../services/goals/briefing.ts';
import { assembleGoals } from '../services/goals/model.ts';
import { cancel, changeObjective, pause, reinstate, resume, setDependency, setTerms } from '../services/goals/decide.ts';
import { goalConstruction, seedGoalIndustry } from '../services/industry/construction/service.ts';
import type { IntentOverrides } from '../services/industry/construction/intent.ts';
import { CONTROL_TARGETS, FACT_KEY_LIST, FACT_STATUSES, isFactKey, type ControlTarget, type FactStatus } from '../domain/construction.ts';
import { recordConstructionFact } from '../repos/construction.ts';
import { recordWorkstreamEvent } from '../repos/register.ts';
import { optionalBoolean, optionalNumber, optionalStringArray } from './helpers.ts';
import type { Principal } from '../domain/types.ts';

export const goalsRouter: Router = Router();

async function readableProjectIds(principal: Principal): Promise<string[]> {
  const all = await listProjects();
  return all
    .filter((project) => decideProjectAccess(principal, project.id, 'READ').allowed)
    .map((project) => project.id);
}

const MISSING = 'No such goal.';

async function requireGoal(principal: Principal, id: string, level: 'READ' | 'WRITE') {
  const goal = await getWorkstream(id);
  if (!goal) throw notFound(MISSING);
  if (goal.projectId !== null && !decideProjectAccess(principal, goal.projectId, level).allowed) {
    throw notFound(MISSING);
  }
  return goal;
}

function actor(principal: Principal): string {
  return `person:${principal.id}`;
}

/** Everything across goals, in one read. */
goalsRouter.get(
  '/goals',
  handler(async () => {
    const principal = requirePerson();
    return await goalBriefing(await readableProjectIds(principal));
  }),
);

/** One goal, with its history and every move of its priority. */
goalsRouter.get(
  '/goals/:goalId',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'READ');
    const snapshot = await assembleGoals({
      projectIds: await readableProjectIds(principal),
      includeArchived: true,
      onlyArchivedGoal: goal.id,
    });
    const view = snapshot.goals.find((one) => one.id === goal.id);
    if (!view) throw notFound(MISSING);
    return {
      goal: view,
      events: await listWorkstreamEvents(goal.id, 100),
      priorityHistory: await snapshotHistory(goal.id),
    };
  }),
);

goalsRouter.post(
  '/goals/:goalId/pause',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    return await pause(goal.id, requiredString(bodyOf(req).reason, 'reason'), actor(principal));
  }),
);

goalsRouter.post(
  '/goals/:goalId/resume',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    return await resume(goal.id, actor(principal));
  }),
);

goalsRouter.post(
  '/goals/:goalId/cancel',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    return await cancel(goal.id, requiredString(bodyOf(req).reason, 'reason'), actor(principal));
  }),
);

goalsRouter.post(
  '/goals/:goalId/reinstate',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    return await reinstate(goal.id, actor(principal));
  }),
);

/**
 * What the goal is for, whose it is, when it is due and who it is owed to.
 *
 * An owner must be a member of the goal's project: naming somebody who cannot
 * read the goal as its owner would put their name on work they cannot see.
 */
goalsRouter.patch(
  '/goals/:goalId/terms',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    const body = bodyOf(req);
    const ownerUserId = nullableString(body.ownerUserId, 'ownerUserId');
    if (ownerUserId && goal.projectId) {
      const membership = await getMembership(goal.projectId, 'HUMAN', ownerUserId);
      if (!membership) throw badRequest('That person is not a member of this goal’s project.');
    }
    const dueAt = nullableString(body.dueAt, 'dueAt');
    if (dueAt && !Number.isFinite(Date.parse(dueAt))) throw badRequest('"dueAt" must be a date.');
    return await setTerms(
      goal.id,
      {
        outcome: nullableString(body.outcome, 'outcome'),
        ownerUserId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : dueAt,
        commitment: optionalEnum<GoalCommitment>(body.commitment, GOAL_COMMITMENTS as readonly GoalCommitment[], 'commitment'),
      },
      actor(principal),
    );
  }),
);

goalsRouter.post(
  '/goals/:goalId/objective',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    const body = bodyOf(req);
    return await changeObjective(
      goal.id,
      { intent: optionalString(body.intent, 'intent'), outcome: nullableString(body.outcome, 'outcome') },
      actor(principal),
    );
  }),
);

/**
 * Declare that this goal cannot finish before another one does.
 *
 * The other goal must be one the caller may read — a dependency on a goal you
 * cannot see is a statement about work you have no standing to describe — and
 * the declaration is refused when it would close a cycle, because two goals
 * each waiting on the other would hold each other's work for ever.
 */
goalsRouter.post(
  '/goals/:goalId/depends-on',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    const otherId = requiredString(bodyOf(req).goalId, 'goalId');
    const other = await requireGoal(principal, otherId, 'READ');
    const made = await setDependency(goal.id, other.id, { actorRef: actor(principal), userId: principal.id });
    if (!made.ok) throw badRequest(made.reason ?? 'That dependency cannot be declared.');
    return {
      link: made.link,
      consequence: made.consequence,
    };
  }),
);

/* --------------------------------------------------------------------------
 * Industry construction (§92)
 *
 * Reading a goal's construction is any reader's: the operator's intent, the
 * industry model, every constructed business and its economics, the staged
 * strategy, the decision and the first transaction. It spends nothing and
 * changes no goal. Replanning is the same read with a person's overrides
 * (capital, urgency, risk, control, ambition) and changes nothing either.
 * Recording what operating taught — a quoted price, an accepted rate, payment
 * terms — and seeding the industry on the map are WRITE, and each records an
 * event on the goal.
 * ------------------------------------------------------------------------ */

function overridesFrom(body: Record<string, unknown>): IntentOverrides {
  const o: IntentOverrides = {};
  const low = optionalNumber(body.capitalLow, 'capitalLow', { min: 0 });
  const high = optionalNumber(body.capitalHigh, 'capitalHigh', { min: 0 });
  if (low !== undefined || high !== undefined) o.capital = { low: low ?? high!, high: high ?? low! };
  const urgency = optionalEnum(body.urgency, ['IMMEDIATE', 'SOON', 'PATIENT'] as const, 'urgency');
  if (urgency) o.urgency = urgency;
  const risk = optionalEnum(body.riskTolerance, ['LOW', 'MEDIUM', 'HIGH'] as const, 'riskTolerance');
  if (risk) o.riskTolerance = risk;
  const appetite = optionalEnum(body.capitalAppetite, ['LIGHT', 'HEAVY'] as const, 'capitalAppetite');
  if (appetite) o.capitalAppetite = appetite;
  const scale = optionalEnum(body.scale, ['LARGE', 'MODEST'] as const, 'scale');
  if (scale) o.scale = scale;
  const durable = optionalBoolean(body.durable, 'durable');
  if (durable !== undefined) o.durable = durable;
  const control = optionalStringArray(body.control, 'control');
  if (control) {
    const bad = control.find((c) => !(CONTROL_TARGETS as readonly string[]).includes(c.toUpperCase()));
    if (bad) throw badRequest(`"${bad}" is not a kind of control. Expected: ${CONTROL_TARGETS.join(', ')}.`);
    o.control = control.map((c) => c.toUpperCase() as ControlTarget);
  }
  const industry = optionalString(body.industry, 'industry');
  if (industry) o.industry = industry;
  const geography = optionalString(body.geography, 'geography');
  if (geography) o.geography = geography;
  return o;
}

goalsRouter.get(
  '/goals/:goalId/construction',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'READ');
    const read = await goalConstruction(goal.id);
    if (!read) throw notFound(MISSING);
    return { construction: read.construction, evidence: read.evidenceLayers };
  }),
);

/** Replan: the same construction under a person's overrides, or for exploratory words. Writes nothing unless `seed`. */
goalsRouter.post(
  '/goals/:goalId/construction',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);
    const seed = optionalBoolean(body.seed, 'seed') === true;
    const goal = await requireGoal(principal, pathId(req, 'goalId'), seed ? 'WRITE' : 'READ');
    const read = await goalConstruction(goal.id, { overrides: overridesFrom(body), intent: optionalString(body.intent, 'intent') ?? null });
    if (!read) throw notFound(MISSING);
    let seeded: { created: boolean; nodeId: string } | null = null;
    if (seed && read.construction.intent.industry) {
      seeded = await seedGoalIndustry(goal, read.construction.intent.industry, actor(principal));
      if (seeded?.created) {
        await recordWorkstreamEvent({ workstreamId: goal.id, kind: 'INDUSTRY_SEEDED', summary: `${read.construction.intent.industry} was put on the industry map for research.`, detail: { nodeId: seeded.nodeId }, actorRef: actor(principal) });
      }
    }
    return { construction: read.construction, evidence: read.evidenceLayers, seeded };
  }),
);

/** Record what operating taught: it answers ahead of every published figure and the construction re-derives from it. */
goalsRouter.post(
  '/goals/:goalId/construction/facts',
  handler(async (req) => {
    const principal = requirePerson();
    const goal = await requireGoal(principal, pathId(req, 'goalId'), 'WRITE');
    const body = bodyOf(req);
    const key = requiredString(body.key, 'key');
    if (!isFactKey(key)) throw badRequest(`"${key}" is not a fact this construction prices. Expected one of: ${FACT_KEY_LIST.join(', ')}.`);
    const low = optionalNumber(body.low, 'low', { min: 0 });
    const high = optionalNumber(body.high, 'high', { min: 0 }) ?? low;
    if (low === undefined || high === undefined) throw badRequest('"low" (and optionally "high") is required.');
    const status = (optionalEnum(body.status, FACT_STATUSES as readonly FactStatus[], 'status') ?? 'OBSERVED') as FactStatus;
    const fact = await recordConstructionFact({
      projectId: goal.projectId,
      workstreamId: goal.id,
      fact: {
        key,
        segment: optionalString(body.segment, 'segment') ?? null,
        low,
        high,
        status,
        measures: requiredString(body.measures, 'measures'),
        sourceTitle: optionalString(body.sourceTitle, 'sourceTitle') ?? `recorded by ${actor(principal)}`,
        sourceUrl: optionalString(body.sourceUrl, 'sourceUrl') ?? null,
      },
      recordedBy: actor(principal),
    });
    await recordWorkstreamEvent({ workstreamId: goal.id, kind: 'CONSTRUCTION_FACT_RECORDED', summary: `${status.toLowerCase()} ${key}${fact.segment ? ` (${fact.segment})` : ''}: ${fact.low}–${fact.high}`, detail: { factId: fact.id }, actorRef: actor(principal) });
    const read = await goalConstruction(goal.id);
    return { fact, construction: read?.construction ?? null };
  }),
);
