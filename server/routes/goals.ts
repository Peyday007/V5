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
import { getWorkstream, linkWorkstream, listLinks, listWorkstreamEvents, recordWorkstreamEvent } from '../repos/register.ts';
import { snapshotHistory } from '../repos/goals.ts';
import { getMembership } from '../repos/identity.ts';
import { listProjects } from '../repos/projects.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import { goalBriefing } from '../services/goals/briefing.ts';
import { assembleGoals } from '../services/goals/model.ts';
import { cancel, changeObjective, pause, reinstate, resume, setTerms } from '../services/goals/decide.ts';
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
    if (otherId === goal.id) throw badRequest('A goal cannot depend on itself.');
    const other = await requireGoal(principal, otherId, 'READ');

    // Walk what the other goal depends on; reaching this goal is a cycle.
    const seen = new Set<string>();
    const queue = [other.id];
    while (queue.length) {
      const next = queue.shift()!;
      if (next === goal.id) throw badRequest('That would make the two goals wait on each other for ever.');
      if (seen.has(next)) continue;
      seen.add(next);
      for (const link of await listLinks(next)) {
        if (link.kind === 'WORKSTREAM' && link.relation === 'DEPENDS_ON') queue.push(link.ref);
      }
    }

    const link = await linkWorkstream({
      workstreamId: goal.id,
      kind: 'WORKSTREAM',
      ref: other.id,
      relation: 'DEPENDS_ON',
      label: other.title,
      recordedBy: 'PERSON',
      recordedByUserId: principal.id,
    });
    await recordWorkstreamEvent({
      workstreamId: goal.id,
      kind: 'GOAL_DEPENDENCY_SET',
      summary: `Waits on "${other.title}" until it completes.`,
      detail: { dependsOn: other.id, linkId: link.id },
      actorRef: actor(principal),
    });
    return {
      link,
      consequence:
        'Until that goal completes, Brain holds this goal’s live bins so capacity goes to work that can move; it releases them on the first tick after the other goal completes.',
    };
  }),
);
