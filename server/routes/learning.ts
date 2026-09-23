/**
 * The learning kernel's door: what Brain learned, and the three things a person
 * can do about it.
 *
 * Reading is any project member's (the default READ): which of Brain's
 * decisions changed because of what happened, and on what evidence, is exactly
 * what somebody working on the project needs to be able to check.
 *
 * The writes are ADMIN plus `requirePerson`, and they are decisions *about*
 * Brain's judgement rather than work inside it:
 *
 * * **correct** — withdraw or reinstate a lesson or a single outcome. Nothing is
 *   deleted; the next decision stops (or resumes) using it, and every decision
 *   that already used it is flagged as resting on a withdrawn lesson.
 * * **decide a capability** — take a proposal's route, or decline it. Taking
 *   IMPLEMENT with a repository submits the composed objective to the Software
 *   Factory as a change request, which still needs its own approval on Build —
 *   this route cannot approve or start a campaign.
 * * **record that a change is live** — the instant verification counts from.
 *
 * A worker principal is refused at every write by type: a machine that could
 * withdraw the lesson slowing it down, or declare its own fix verified, is
 * precisely what §22 keeps a worker out of.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalString,
  pathId,
  requiredEnum,
  requiredString,
  requirePerson,
  requireProject,
  unprocessable,
} from './helpers.ts';
import { learningView } from '../services/learning/view.ts';
import { capabilityProposals } from '../services/learning/capability.ts';
import { deriveLessons } from '../services/learning/lessons.ts';
import {
  listCorrections,
  listOutcomes,
  recordCapabilityDecision,
  recordCorrection,
} from '../repos/learning.ts';
import { CAPABILITY_ROUTES } from '../domain/learning.ts';
import { ContractError, submitObjective } from '../services/factory/contract.ts';

export const learningRouter: Router = Router();

learningRouter.get(
  '/projects/:projectId/learning',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return learningView(project.id);
  }),
);

learningRouter.post(
  '/projects/:projectId/learning/corrections',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const targetKind = requiredEnum(body['targetKind'], ['LESSON', 'OUTCOME'] as const, 'targetKind');
    const targetKey = requiredString(body['targetKey'], 'targetKey');
    const action = requiredEnum(body['action'], ['WITHDRAW', 'REINSTATE'] as const, 'action');
    const reason = requiredString(body['reason'], 'reason');

    // The target must exist in this project, or the correction would be a
    // sentence about nothing — and an id from another project must read the
    // same as an invented one.
    if (targetKind === 'LESSON') {
      const lessons = deriveLessons({
        outcomes: await listOutcomes(project.id),
        corrections: await listCorrections(project.id),
      });
      if (!lessons.some((lesson) => lesson.key === targetKey)) throw notFound('No lesson with that key.');
    } else {
      const outcomes = await listOutcomes(project.id);
      if (!outcomes.some((outcome) => outcome.id === targetKey)) throw notFound('No outcome with that id.');
    }

    const correction = await recordCorrection({
      projectId: project.id,
      targetKind,
      targetKey,
      action,
      reason,
      decidedById: principal.id,
      authorityChannel: 'BROWSER',
    });
    return {
      correction,
      message:
        action === 'WITHDRAW'
          ? 'Withdrawn. The next decision stops using it, and every decision that already did is ' +
            'marked as resting on a withdrawn lesson. Nothing it rested on was deleted.'
          : 'Reinstated. The next decision may use it again if it still clears its floor.',
    };
  }),
);

learningRouter.post(
  '/projects/:projectId/learning/capabilities/decide',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const blockerKey = requiredString(body['blockerKey'], 'blockerKey');
    const route = requiredEnum(body['route'], CAPABILITY_ROUTES, 'route');
    const reason = requiredString(body['reason'], 'reason');
    const repository = optionalString(body['repository'], 'repository');

    const proposal = (await capabilityProposals(project.id)).find((one) => one.blockerKey === blockerKey);
    if (!proposal) throw notFound('No capability proposal with that key.');
    if (repository && route !== 'IMPLEMENT') {
      throw badRequest('A repository is only meaningful when the route is IMPLEMENT.');
    }

    let changeRequestId: string | null = null;
    if (route === 'IMPLEMENT' && repository) {
      if (!proposal.objective) {
        throw unprocessable('This proposal has no factory objective to submit.');
      }
      const result = await submitObjective({
        projectId: project.id,
        ...proposal.objective,
        repositoryRemote: repository,
      }).catch((error: unknown) => {
        if (error instanceof ContractError) throw unprocessable(error.message, error.detail);
        throw error;
      });
      changeRequestId = result.changeRequest.id;
    }

    const decision = await recordCapabilityDecision({
      projectId: project.id,
      blockerKey,
      route,
      reason,
      changeRequestId,
      decidedById: principal.id,
      authorityChannel: 'BROWSER',
    });
    return {
      decision,
      message: changeRequestId
        ? `Recorded, and submitted to the Software Factory as ${changeRequestId}. It still needs ` +
          'its own approval on Build before any work starts.'
        : 'Recorded.',
    };
  }),
);

learningRouter.post(
  '/projects/:projectId/learning/capabilities/landed',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const blockerKey = requiredString(body['blockerKey'], 'blockerKey');
    const reason = requiredString(body['reason'], 'reason');
    const at = optionalString(body['landedAt'], 'landedAt') ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(at))) throw badRequest('`landedAt` is not a timestamp.');

    const proposal = (await capabilityProposals(project.id)).find((one) => one.blockerKey === blockerKey);
    if (!proposal) throw notFound('No capability proposal with that key.');
    const approved = [...proposal.decisions].reverse().find((one) => one.route !== 'DECLINE');
    if (!approved) {
      throw unprocessable('Nothing has been approved for this proposal, so nothing can have landed.');
    }
    const decision = await recordCapabilityDecision({
      projectId: project.id,
      blockerKey,
      route: approved.route,
      reason,
      changeRequestId: approved.changeRequestId,
      landedAt: new Date(at).toISOString(),
      decidedById: principal.id,
      authorityChannel: 'BROWSER',
    });
    return {
      decision,
      message:
        'Recorded. Verification now reads only attempts launched after this instant; nobody is ' +
        'asked whether it worked.',
    };
  }),
);
