/**
 * Cash Mode's door.
 *
 * Every route here resolves through `requireProject`, which is
 * `decideProjectAccess` against the authenticated principal, so absent and
 * forbidden are the same 404 **with the same body** — invariant 23 at a new
 * door, where the thing being hidden is somebody else's private operation and
 * even its existence is information.
 *
 * Every handler additionally calls `requirePerson`. A worker is already refused
 * at every write by `MISSING_SCOPE` and at the two ADMIN routes by level; this
 * refuses it by *type*, at the reads as well, because no membership
 * configuration turns a machine into a person and a sprint's money is the last
 * place to find that out. Two independent guards, because a guard on one
 * entrance is not a guard.
 *
 * There is **no cash policy module and there must never be one.** Which level
 * each of these needs is declared in `services/identity/policy.ts` beside every
 * other route, for §21's reason: a second security model is a second thing to
 * keep correct, and it is always the weaker one that decides.
 *
 * The handlers are thin on purpose. Every decision below is made in
 * `services/cash/`; these resolve the project, hand over the principal, and
 * turn a refusal into a status.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  conflict,
  handler,
  notFound,
  optionalInteger,
  optionalNumber,
  optionalString,
  optionalStringArray,
  pathId,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import { getCashMode, listCashEventsFor } from '../repos/cashMode.ts';
import {
  createAuthority,
  getCommitment,
  liveAuthority,
  releaseCommitment,
  revokeAuthority,
  settleCommitment,
} from '../repos/cashAuthority.ts';
import { getNeed, getOpportunity } from '../repos/cashPortfolio.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
  describeAuthority,
  isCommercialAction,
} from '../services/cash/authority.ts';
import { evidenceCard } from '../services/cash/card.ts';
import {
  DEFAULT_CASH_ENVELOPE,
  DEFAULT_HORIZON_DAYS,
  SELECTABLE_CASH_ENVELOPES,
  activate,
  setLifecycle,
} from '../services/cash/lifecycle.ts';
import {
  advance,
  archiveOpportunity,
  beginExecution,
  capture,
  commitSpend,
  decline,
  exhaust,
  fillCard,
  markReady,
  recordMoneyEvent,
  reoffer,
} from '../services/cash/opportunities.ts';
import { closeNeed, raiseNeed } from '../services/cash/needs.ts';
import { cashView } from '../services/cash/view.ts';
import { recordCashEvent } from '../repos/cashMode.ts';
import {
  CASH_MECHANISMS,
  CASH_MODE_STATES,
  CASH_MONEY_KINDS,
  type CashMoneyKind,
} from '../domain/types.ts';
import type { Outcome } from '../services/cash/opportunities.ts';

export const cashRouter: Router = Router();

/** A service refusal becomes a 422: the request was understood and refused. */
function taken<T>(outcome: Outcome<T>): { value: T; message: string } {
  if (!outcome.ok) throw unprocessable(outcome.reason);
  return { value: outcome.value, message: outcome.message };
}

/**
 * An opportunity, resolved through its own project's guard.
 *
 * The project comes from the row rather than from the path, so an id a caller
 * guessed is refused with the same 404 a missing one gives — a route that took
 * both would let somebody confirm an opportunity exists by pairing it with a
 * project they can read.
 */
async function requireOpportunity(id: string) {
  const opportunity = await getOpportunity(id);
  if (!opportunity) throw notFound('No opportunity with that id.');
  await requireProject(opportunity.projectId);
  return opportunity;
}

/* --------------------------------------------------------------------------
 * The section itself
 * ------------------------------------------------------------------------ */

/**
 * One person's whole private Cash section, in one read.
 *
 * §29's rule: one projection answers every surface. The client renders this and
 * derives nothing of its own, so two screens cannot disagree about one sprint.
 */
cashRouter.get(
  '/projects/:projectId/cash',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const view = await cashView({ projectId: project.id });
    return {
      ...view,
      // The contract travels down with the view rather than being restated in
      // the client, so what a person is offered and what the server accepts are
      // one object — §24's manifest lesson.
      vocabulary: {
        mechanisms: CASH_MECHANISMS,
        moneyKinds: CASH_MONEY_KINDS,
        commercialActions: COMMERCIAL_ACTIONS,
        neverAuthorizable: ALWAYS_PROHIBITED_COMMERCIAL,
        lifecycleStates: CASH_MODE_STATES,
        envelopes: SELECTABLE_CASH_ENVELOPES,
        defaultEnvelope: DEFAULT_CASH_ENVELOPE,
        defaultHorizonDays: DEFAULT_HORIZON_DAYS,
      },
    };
  }),
);

/**
 * Activate the section, or move its lifecycle.
 *
 * ADMIN, which is the level a membership change already carries, because
 * turning a sprint on for a project is a decision *about* the operation rather
 * than work inside it. A worker is refused by level and again by type.
 */
cashRouter.post(
  '/projects/:projectId/cash/mode',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const to = optionalString(body['state'], 'state');
    if (to !== undefined) {
      if (!(CASH_MODE_STATES as readonly string[]).includes(to)) {
        throw badRequest(`"state" must be one of: ${CASH_MODE_STATES.join(', ')}.`);
      }
      const outcome = await setLifecycle({
        projectId: project.id,
        to: to as (typeof CASH_MODE_STATES)[number],
        actorUserId: principal.id,
        reason: requiredString(body['reason'], 'reason'),
      });
      if (!outcome.ok) throw unprocessable(outcome.reason);
      return { mode: outcome.mode, changed: outcome.changed, message: outcome.message };
    }

    const outcome = await activate({
      projectId: project.id,
      // Whose sprint this is. Defaults to the person activating it; naming
      // somebody else is how an administrator sets a project up for its owner.
      ownerUserId: optionalString(body['ownerUserId'], 'ownerUserId') ?? principal.id,
      actorUserId: principal.id,
      objective: requiredString(body['objective'], 'objective'),
      horizonDays: optionalInteger(body['horizonDays'], 'horizonDays', { min: 1, max: 365 }),
      envelopeId: optionalString(body['envelopeId'], 'envelopeId'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { mode: outcome.mode, changed: outcome.changed, message: outcome.message };
  }),
);

/* --------------------------------------------------------------------------
 * The commercial authority
 *
 * The one decision Brain cannot make for itself and cannot proceed without.
 * ADMIN plus `requirePerson`, which is a *stronger* pair than the deleted
 * operator console's administrator-plus-same-origin: a worker principal is
 * refused here by type, and a machine that could grant itself a spending
 * ceiling is exactly what §22's split forbids.
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/authority',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const mode = await getCashMode(project.id);
    if (!mode) {
      throw unprocessable(
        'Activate Cash Mode for this project first. A spending ceiling with no sprint to spend ' +
          'it in is a permission nobody asked for.',
      );
    }

    const existing = await liveAuthority(project.id);
    if (existing) {
      throw conflict(
        'A commercial authority is already live here. Two would make "the limits you set" ' +
          'ambiguous, so change one by withdrawing it and making a new one deliberately. ' +
          'Withdrawing keeps every commitment and every money record.',
      );
    }

    const actions = optionalStringArray(body['allowedActions'], 'allowedActions') ?? [];
    if (actions.length === 0) {
      throw badRequest(
        `"allowedActions" needs at least one of: ${COMMERCIAL_ACTIONS.join(', ')}. A grant that ` +
          'authorizes nothing is not a grant.',
      );
    }
    for (const action of actions) {
      if (isCommercialAction(action)) continue;
      // An unknown field refuses the whole grant rather than being dropped:
      // `proposal.ts`'s rule, at the surface that spends money.
      throw badRequest(
        `"${action}" is not a commercial action this Brain knows how to authorize. The set is ` +
          `fixed in code: ${COMMERCIAL_ACTIONS.join(', ')}.`,
      );
    }

    const maxCommittedCents = optionalInteger(body['maxCommittedCents'], 'maxCommittedCents', {
      min: 0,
    });
    const maxPerActionCents = optionalInteger(body['maxPerActionCents'], 'maxPerActionCents', {
      min: 0,
    });
    if (maxCommittedCents === undefined || maxPerActionCents === undefined) {
      throw badRequest(
        '"maxCommittedCents" and "maxPerActionCents" are both required. Money is the one thing ' +
          'in this Brain that is genuinely scarce, so its ceilings are not optional and have no ' +
          'default.',
      );
    }
    if (maxPerActionCents > maxCommittedCents) {
      throw badRequest(
        'A single commitment cannot be larger than everything that may be committed at once.',
      );
    }

    const authority = await createAuthority({
      projectId: project.id,
      ownerUserId: mode.ownerUserId,
      createdByUserId: principal.id,
      name: optionalString(body['name'], 'name') ?? 'Cash Mode commercial authority',
      allowedActions: actions,
      // Unioned in rather than trusted to the caller, so a grant written by a
      // script or a future screen cannot omit one by forgetting.
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents,
      maxPerActionCents,
      maxConcurrent: optionalInteger(body['maxConcurrent'], 'maxConcurrent', { min: 0, max: 100 }) ?? 3,
      currency: optionalString(body['currency'], 'currency') ?? 'USD',
      expiresAt: optionalString(body['expiresAt'], 'expiresAt') ?? null,
    });

    await recordCashEvent({
      projectId: project.id,
      kind: 'CASH_AUTHORITY_GRANTED',
      actorRef: principal.id,
      summary: 'A standing commercial authority was granted.',
      detail: {
        allowedActions: actions,
        maxCommittedCents,
        maxPerActionCents,
        maxConcurrent: authority.maxConcurrent,
        expiresAt: authority.expiresAt,
      },
    });

    return { authority, lines: describeAuthority(authority) };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/authority/:authorityId/withdraw',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const authorityId = pathId(req, 'authorityId');
    const reason = requiredString(bodyOf(req)['reason'], 'reason');

    const live = await liveAuthority(project.id);
    if (!live || live.id !== authorityId) {
      // Not "that grant belongs to another project": a grant this caller cannot
      // reach is one that does not exist, in the same words.
      throw notFound('No commercial authority with that id.');
    }

    const revoked = await revokeAuthority({ authorityId, actorUserId: principal.id, reason });
    if (!revoked) throw conflict('That authority has already been withdrawn.');

    await recordCashEvent({
      projectId: project.id,
      kind: 'CASH_AUTHORITY_WITHDRAWN',
      actorRef: principal.id,
      summary: 'The standing commercial authority was withdrawn.',
      detail: { reason, authorityId },
    });
    return {
      withdrawn: true,
      message:
        'Withdrawn. Every commitment, money entry and opportunity is exactly as it was; what ' +
        'stops is new commercial action.',
    };
  }),
);

/* --------------------------------------------------------------------------
 * The portfolio
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/opportunities',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const mode = await getCashMode(project.id);
    const { value, message } = taken(
      await capture({
        projectId: project.id,
        actorRef: principal.id,
        ownerUserId: mode?.ownerUserId ?? principal.id,
        title: requiredString(body['title'], 'title'),
        mechanism: requiredString(body['mechanism'], 'mechanism'),
        currency: optionalString(body['currency'], 'currency') ?? 'USD',
        industry: optionalString(body['industry'], 'industry') ?? null,
        source: optionalString(body['source'], 'source') ?? null,
        candidateId: optionalString(body['candidateId'], 'candidateId') ?? null,
        externalRecordId: optionalString(body['externalRecordId'], 'externalRecordId') ?? null,
        expiresAt: optionalString(body['expiresAt'], 'expiresAt') ?? null,
        expiryReason: optionalString(body['expiryReason'], 'expiryReason') ?? null,
        dependsOnId: optionalString(body['dependsOnId'], 'dependsOnId') ?? null,
        duplicateOfId: optionalString(body['duplicateOfId'], 'duplicateOfId') ?? null,
        requiredCapabilities:
          optionalStringArray(body['requiredCapabilities'], 'requiredCapabilities') ?? [],
        nextAction: optionalString(body['nextAction'], 'nextAction') ?? null,
        stopRule: optionalString(body['stopRule'], 'stopRule') ?? null,
      }),
    );
    return { opportunity: value, card: evidenceCard(value), message };
  }),
);

cashRouter.get(
  '/cash/opportunities/:opportunityId',
  handler(async (req) => {
    requirePerson();
    const opportunity = await requireOpportunity(pathId(req, 'opportunityId'));
    return {
      opportunity,
      card: evidenceCard(opportunity),
      history: await listCashEventsFor(opportunity.id, 50),
    };
  }),
);

cashRouter.patch(
  '/cash/opportunities/:opportunityId',
  handler(async (req) => {
    const principal = requirePerson();
    const opportunity = await requireOpportunity(pathId(req, 'opportunityId'));
    const { value, message } = taken(
      await fillCard({
        opportunityId: opportunity.id,
        actorRef: principal.id,
        patch: bodyOf(req),
      }),
    );
    return { opportunity: value, card: evidenceCard(value), message };
  }),
);

/**
 * Every lifecycle move an opportunity has, behind one route.
 *
 * One route rather than seven because they share the whole of their guard —
 * resolve, authorize, hand to the service — and differ only in which named
 * transition runs. The `action` is matched exactly against a closed set; an
 * unknown one is refused rather than being treated as the nearest match.
 */
cashRouter.post(
  '/cash/opportunities/:opportunityId/:action',
  handler(async (req) => {
    const principal = requirePerson();
    const opportunity = await requireOpportunity(pathId(req, 'opportunityId'));
    const action = pathId(req, 'action');
    const body = bodyOf(req);

    switch (action) {
      case 'ready': {
        const { value, message } = taken(
          await markReady({ opportunityId: opportunity.id, actorRef: principal.id }),
        );
        return { opportunity: value, message };
      }
      case 'execute': {
        const { value, message } = taken(
          await beginExecution({ opportunityId: opportunity.id, actorRef: principal.id }),
        );
        return { opportunity: value, message };
      }
      case 'deliver':
      case 'collect': {
        const { value, message } = taken(
          await advance({
            opportunityId: opportunity.id,
            to: action === 'deliver' ? 'DELIVERING' : 'COLLECTED',
            actorRef: principal.id,
            outcome: optionalString(body['outcome'], 'outcome') ?? null,
          }),
        );
        return { opportunity: value, message };
      }
      case 'decline': {
        const { value, message } = taken(
          await decline({
            opportunityId: opportunity.id,
            actorUserId: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      case 'reoffer': {
        // Both ends are authorized: the source through `requireOpportunity`
        // above, the destination here. A person who may read one operation may
        // not push work into another they have no part in.
        const toProject = await requireProject(requiredString(body['toProjectId'], 'toProjectId'));
        const destination = await getCashMode(toProject.id);
        if (!destination) {
          throw unprocessable('That operation is not running Cash Mode, so it takes no openings.');
        }
        const { value, message } = taken(
          await reoffer({
            opportunityId: opportunity.id,
            toProjectId: toProject.id,
            toOwnerUserId: destination.ownerUserId,
            actorUserId: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      case 'exhaust': {
        const { value, message } = taken(
          await exhaust({
            opportunityId: opportunity.id,
            actorRef: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      case 'archive': {
        const { value, message } = taken(
          await archiveOpportunity({
            opportunityId: opportunity.id,
            actorRef: principal.id,
            reason: requiredString(body['reason'], 'reason'),
          }),
        );
        return { opportunity: value, message };
      }
      default:
        throw notFound('No such route.');
    }
  }),
);

/* --------------------------------------------------------------------------
 * Money
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/money',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const kind = requiredString(body['kind'], 'kind');
    if (!(CASH_MONEY_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(`"kind" must be one of: ${CASH_MONEY_KINDS.join(', ')}.`);
    }
    const amountCents = optionalInteger(body['amountCents'], 'amountCents', { min: 1 });
    if (amountCents === undefined) throw badRequest('"amountCents" is required.');

    const { value, message } = taken(
      await recordMoneyEvent({
        projectId: project.id,
        opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
        kind: kind as CashMoneyKind,
        amountCents,
        currency: optionalString(body['currency'], 'currency') ?? 'USD',
        verifiedReference: optionalString(body['verifiedReference'], 'verifiedReference') ?? null,
        fundsAvailableAt: optionalString(body['fundsAvailableAt'], 'fundsAvailableAt') ?? null,
        occurredAt: optionalString(body['occurredAt'], 'occurredAt'),
        note: optionalString(body['note'], 'note') ?? null,
        actorRef: principal.id,
      }),
    );
    return { entry: value, message };
  }),
);

cashRouter.post(
  '/projects/:projectId/cash/commitments',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const amountCents = optionalInteger(body['amountCents'], 'amountCents', { min: 1 });
    if (amountCents === undefined) throw badRequest('"amountCents" is required.');

    const { value, message } = taken(
      await commitSpend({
        projectId: project.id,
        opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
        action: requiredString(body['action'], 'action'),
        amountCents,
        purpose: requiredString(body['purpose'], 'purpose'),
        expectedResult: requiredString(body['expectedResult'], 'expectedResult'),
        stopCondition: requiredString(body['stopCondition'], 'stopCondition'),
        // The key is the caller's, and it names *this* decision. It never
        // reaches the scope: which project and which grant a commitment lands
        // against come from the authenticated request, so a key is not a way to
        // spend somebody else's ceiling.
        idempotencyKey: requiredString(body['idempotencyKey'], 'idempotencyKey'),
        actorRef: principal.id,
      }),
    );
    return { commitment: value, message };
  }),
);

/**
 * A commitment is finished: the spend happened, or it is not going to.
 *
 * Both are a person's statement about the world. Nothing here frees a hold on a
 * timer — §20's rule that a timeout is not evidence, at the one table where
 * being wrong hands back money that may already have gone.
 */
cashRouter.post(
  '/cash/commitments/:commitmentId/:action',
  handler(async (req) => {
    const principal = requirePerson();
    const commitment = await getCommitment(pathId(req, 'commitmentId'));
    if (!commitment) throw notFound('No commitment with that id.');
    await requireProject(commitment.projectId);
    const action = pathId(req, 'action');

    if (action === 'settle') {
      if (!(await settleCommitment(commitment.id))) {
        throw conflict(`That commitment is already ${commitment.state.toLowerCase()}.`);
      }
      await recordCashEvent({
        projectId: commitment.projectId,
        opportunityId: commitment.opportunityId,
        kind: 'CASH_COMMITMENT_SETTLED',
        actorRef: principal.id,
        summary: `The ${commitment.amountCents}-cent commitment was spent.`,
        detail: { commitmentId: commitment.id },
      });
      return { settled: true, message: 'Settled. The ceiling has that much room again.' };
    }
    if (action === 'release') {
      const reason = requiredString(bodyOf(req)['reason'], 'reason');
      if (!(await releaseCommitment({ commitmentId: commitment.id, reason }))) {
        throw conflict(`That commitment is already ${commitment.state.toLowerCase()}.`);
      }
      await recordCashEvent({
        projectId: commitment.projectId,
        opportunityId: commitment.opportunityId,
        kind: 'CASH_COMMITMENT_RELEASED',
        actorRef: principal.id,
        summary: 'A commitment was released without being spent.',
        detail: { commitmentId: commitment.id, reason },
      });
      return { released: true, message: 'Released. Nothing was spent.' };
    }
    throw notFound('No such route.');
  }),
);

/* --------------------------------------------------------------------------
 * Needs
 * ------------------------------------------------------------------------ */

cashRouter.post(
  '/projects/:projectId/cash/needs',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const { value, message } = taken(
      await raiseNeed({
        projectId: project.id,
        opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
        actorRef: principal.id,
        blockedAction: requiredString(body['blockedAction'], 'blockedAction'),
        whyItMatters: requiredString(body['whyItMatters'], 'whyItMatters'),
        recommendedPath: requiredString(body['recommendedPath'], 'recommendedPath'),
        expectedCostCents:
          optionalNumber(body['expectedCostCents'], 'expectedCostCents', { min: 0 }) ?? null,
        setupEffort: requiredString(body['setupEffort'], 'setupEffort'),
        nextStep: requiredString(body['nextStep'], 'nextStep'),
      }),
    );
    return { need: value, message };
  }),
);

cashRouter.post(
  '/cash/needs/:needId/close',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);
    const to = optionalString(body['to'], 'to') ?? 'RESOLVED';
    if (to !== 'RESOLVED' && to !== 'WITHDRAWN') {
      throw badRequest('"to" is RESOLVED or WITHDRAWN.');
    }
    // Resolved through the need's own project, so a guessed id is refused with
    // the same 404 a missing one gives.
    const need = await getNeed(pathId(req, 'needId'));
    if (!need) throw notFound('No need with that id.');
    await requireProject(need.projectId);

    const { value, message } = taken(
      await closeNeed({
        needId: need.id,
        to,
        resolution: requiredString(body['resolution'], 'resolution'),
        actorUserId: principal.id,
      }),
    );
    return { need: value, message };
  }),
);
