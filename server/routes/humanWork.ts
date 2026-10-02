/**
 * Getting work done through people: the project's door and the assignee's.
 *
 * Two doors, two authorizations, and neither substitutes for the other.
 *
 * **The project door** resolves through `requireProject`, so absent and
 * forbidden are one 404 with one body. Opening work, deciding money, recording
 * a payment, accepting a result and stopping work are ADMIN; finding
 * candidates, preparing terms, recording that an ask went out, posting
 * updates, handing in and reviewing are WRITE — the coordinator's level. The
 * levels are declared in `services/identity/policy.ts` beside every other
 * route; there is no human-work policy module and there must never be one.
 *
 * **The assignee door** is not project-scoped at all, on purpose. Somebody
 * engaged for one task needs that task and nothing else, so they are given no
 * membership: what they may see is decided by one comparison — the
 * engagement's `assignee_user_id` against the authenticated principal — and an
 * assignment that is not theirs is the same 404 as one that does not exist.
 *
 * Every handler calls `requirePerson`: a machine is refused by type. Engaging
 * a person is the last place a worker credential should reach.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalInteger,
  optionalNumber,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import { currentPrincipal } from '../services/identity/context.ts';
import { engagementsForAssignee, getCandidate, getEngagement, getOrder } from '../repos/humanWork.ts';
import { designateCoordinator, openWorkOrder } from '../services/humanwork/order.ts';
import { addWorkCandidate, setAside } from '../services/humanwork/candidates.ts';
import {
  answerInvitation,
  attestAcceptance,
  prepareEngagement,
  recordInvitationSent,
  requestEngagementDecision,
  withdrawEngagement,
} from '../services/humanwork/engage.ts';
import {
  acceptResult,
  cancelWork,
  postUpdate,
  recordCost,
  reviewCondition,
  submitDeliverable,
} from '../services/humanwork/deliver.ts';
import { assignmentView, humanWorkView, orderView } from '../services/humanwork/view.ts';
import type { Checked } from '../services/humanwork/vocabulary.ts';
import type { HumanWorkRelationship, QuoteSource, ReviewVerdict } from '../domain/types.ts';

export const humanWorkRouter = Router();

function unwrap<T>(result: Checked<T>): T {
  if (!result.ok) throw unprocessable(result.reason);
  return result.value;
}

/** What a control may be offered for, decided by the server — never the control. */
function capabilities(projectId: string) {
  const principal = currentPrincipal();
  const administers = decideProjectAccess(principal, projectId, 'ADMIN').allowed;
  const coordinates = decideProjectAccess(principal, projectId, 'WRITE').allowed;
  return {
    mayOpenAndDecide: administers,
    mayCoordinate: coordinates,
    because: administers
      ? null
      : coordinates
        ? 'Opening work, committing money, accepting a result and stopping work are decisions an administrator of this project makes. You can coordinate delivery.'
        : 'You can read how work done by people is going here.',
  };
}

async function orderIn(projectId: string, orderId: string) {
  const order = await getOrder(orderId);
  if (!order || order.projectId !== projectId) throw notFound('No work order with that id.');
  return order;
}

async function engagementIn(projectId: string, engagementId: string) {
  const engagement = await getEngagement(engagementId);
  if (!engagement || engagement.projectId !== projectId) throw notFound('No engagement with that id.');
  return engagement;
}

/* ---------------------------------------------------------------- reading */

humanWorkRouter.get(
  '/projects/:projectId/human-work',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { ...(await humanWorkView(project.id)), capabilities: capabilities(project.id) };
  }),
);

/* ---------------------------------------------------------- step 1: open */

humanWorkRouter.post(
  '/projects/:projectId/human-work/orders',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const result = unwrap(
      await openWorkOrder({
        projectId: project.id,
        taskId: requiredString(body['taskId'], 'taskId'),
        title: requiredString(body['title'], 'title'),
        work: requiredString(body['work'], 'work'),
        whyPerson: optionalString(body['whyPerson'], 'whyPerson') ?? null,
        brainPrepares: body['brainPrepares'],
        deliverables: body['deliverables'],
        acceptance: body['acceptance'],
        sharedContext: body['sharedContext'],
        accessRequired: body['accessRequired'],
        dueBy: optionalString(body['dueBy'], 'dueBy') ?? null,
        budgetCents: optionalInteger(body['budgetCents'], 'budgetCents', { min: 0 }) ?? null,
        currency: optionalString(body['currency'], 'currency') ?? null,
        coordinatorUserId: optionalString(body['coordinatorUserId'], 'coordinatorUserId') ?? null,
        actorRef: principal.id,
      }),
    );
    return { order: result.order, created: result.created, view: await orderView(result.order) };
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/orders/:orderId/coordinator',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const order = await orderIn(project.id, pathId(req, 'orderId'));
    const userId = optionalString(bodyOf(req)['userId'], 'userId') ?? null;
    return unwrap(await designateCoordinator({ orderId: order.id, userId, actorRef: principal.id }));
  }),
);

/* ------------------------------------------------------ step 2: find people */

humanWorkRouter.post(
  '/projects/:projectId/human-work/orders/:orderId/candidates',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const order = await orderIn(project.id, pathId(req, 'orderId'));
    const body = bodyOf(req);
    const relationship = requiredString(body['relationship'], 'relationship') as HumanWorkRelationship;
    const result = unwrap(
      await addWorkCandidate({
        orderId: order.id,
        relationship,
        displayName: optionalString(body['displayName'], 'displayName') ?? null,
        kind: body['kind'] === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON',
        userId: optionalString(body['userId'], 'userId') ?? null,
        sourceClaimId: optionalString(body['sourceClaimId'], 'sourceClaimId') ?? null,
        competence: body['competence'],
        location: optionalString(body['location'], 'location') ?? null,
        availability: optionalString(body['availability'], 'availability') ?? null,
        quoteCents: optionalInteger(body['quoteCents'], 'quoteCents', { min: 0 }) ?? null,
        quoteBasis: optionalString(body['quoteBasis'], 'quoteBasis') ?? null,
        quoteCurrency: optionalString(body['quoteCurrency'], 'quoteCurrency') ?? null,
        quoteSource: (optionalString(body['quoteSource'], 'quoteSource') ?? null) as QuoteSource | null,
        uncertainties: body['uncertainties'],
        contactChannel: optionalString(body['contactChannel'], 'contactChannel') ?? null,
        actorRef: principal.id,
      }),
    );
    return result;
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/candidates/:candidateId/set-aside',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const candidate = await getCandidate(pathId(req, 'candidateId'));
    if (!candidate || candidate.projectId !== project.id) throw notFound('No candidate with that id.');
    unwrap(await setAside({ candidateId: candidate.id, reason: requiredString(bodyOf(req)['reason'], 'reason'), actorRef: principal.id }));
    return { ok: true };
  }),
);

/* --------------------------------------------------- step 3: engagement */

humanWorkRouter.post(
  '/projects/:projectId/human-work/orders/:orderId/engagements',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const order = await orderIn(project.id, pathId(req, 'orderId'));
    const body = bodyOf(req);
    const engagement = unwrap(
      await prepareEngagement({
        orderId: order.id,
        candidateId: requiredString(body['candidateId'], 'candidateId'),
        terms: body['terms'],
        actorRef: principal.id,
      }),
    );
    // Putting the decision in front of the administrator is the default: terms
    // prepared and not asked about are terms nobody is waiting on.
    const decision = body['askForDecision'] === false
      ? null
      : unwrap(await requestEngagementDecision({ engagementId: engagement.id, actorRef: principal.id }));
    return { engagement, decisionRequestId: decision?.id ?? null };
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/request-decision',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    return unwrap(await requestEngagementDecision({ engagementId: engagement.id, actorRef: principal.id }));
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/invitation-sent',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    const body = bodyOf(req);
    return unwrap(
      await recordInvitationSent({
        engagementId: engagement.id,
        channel: requiredString(body['channel'], 'channel'),
        reference: optionalString(body['reference'], 'reference') ?? null,
        actorRef: principal.id,
      }),
    );
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/attest-acceptance',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    return unwrap(
      await attestAcceptance({
        engagementId: engagement.id,
        evidence: requiredString(bodyOf(req)['evidence'], 'evidence'),
        actorRef: principal.id,
      }),
    );
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/withdraw',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    return unwrap(
      await withdrawEngagement({
        engagementId: engagement.id,
        reason: requiredString(bodyOf(req)['reason'], 'reason'),
        actorRef: principal.id,
      }),
    );
  }),
);

/* ---------------------------------------------------- step 4: coordinate */

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/updates',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    const body = bodyOf(req);
    unwrap(
      await postUpdate({
        engagementId: engagement.id,
        kind: requiredString(body['kind'], 'kind'),
        text: requiredString(body['text'], 'text'),
        as: 'PERSON',
        userId: principal.id,
      }),
    );
    return { ok: true };
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/deliverables',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    const body = bodyOf(req);
    return unwrap(
      await submitDeliverable({
        engagementId: engagement.id,
        description: requiredString(body['description'], 'description'),
        documentId: optionalString(body['documentId'], 'documentId') ?? null,
        reference: optionalString(body['reference'], 'reference') ?? null,
        as: 'COORDINATOR',
        userId: principal.id,
      }),
    );
  }),
);

/* --------------------------------------------------- step 5: verify, close */

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/reviews',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    const body = bodyOf(req);
    const verdict = requiredString(body['verdict'], 'verdict') as ReviewVerdict;
    return unwrap(
      await reviewCondition({
        engagementId: engagement.id,
        criterionKey: requiredString(body['criterionKey'], 'criterionKey'),
        verdict,
        note: requiredString(body['note'], 'note'),
        repair: optionalString(body['repair'], 'repair') ?? null,
        reviewerUserId: principal.id,
      }),
    );
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/engagements/:engagementId/costs',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const engagement = await engagementIn(project.id, pathId(req, 'engagementId'));
    const body = bodyOf(req);
    const kind = requiredString(body['kind'], 'kind');
    if (kind !== 'INCURRED' && kind !== 'PAID') throw badRequest('kind must be INCURRED or PAID.');
    const key = req.header('Idempotency-Key') ?? requiredString(body['idempotencyKey'], 'idempotencyKey');
    return unwrap(
      await recordCost({
        engagementId: engagement.id,
        kind,
        amountCents: optionalInteger(body['amountCents'], 'amountCents', { min: 0 }) ?? 0,
        hours: optionalNumber(body['hours'], 'hours', { min: 0 }) ?? null,
        reference: optionalString(body['reference'], 'reference') ?? null,
        note: optionalString(body['note'], 'note') ?? null,
        idempotencyKey: key,
        userId: principal.id,
      }),
    );
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/orders/:orderId/accept',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const order = await orderIn(project.id, pathId(req, 'orderId'));
    return unwrap(
      await acceptResult({
        orderId: order.id,
        actor: 'PERSON',
        userId: principal.id,
        note: optionalString(bodyOf(req)['note'], 'note') ?? null,
      }),
    );
  }),
);

humanWorkRouter.post(
  '/projects/:projectId/human-work/orders/:orderId/cancel',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const order = await orderIn(project.id, pathId(req, 'orderId'));
    return unwrap(await cancelWork({ orderId: order.id, reason: requiredString(bodyOf(req)['reason'], 'reason'), userId: principal.id }));
  }),
);

/* ---------------------------------------------- the person doing the work */

async function mine(engagementId: string, userId: string) {
  const engagement = await getEngagement(engagementId);
  // The same sentence whether it does not exist or is somebody else's.
  if (!engagement || engagement.assigneeUserId !== userId) throw notFound('No assignment with that id.');
  // An assignment is visible to its assignee from the moment it reaches them.
  if (['PROPOSED', 'APPROVED', 'REFUSED_BY_OWNER'].includes(engagement.state)) {
    throw notFound('No assignment with that id.');
  }
  return engagement;
}

humanWorkRouter.get(
  '/assignments',
  handler(async () => {
    const principal = requirePerson();
    const all = await engagementsForAssignee(principal.id);
    const visible = all.filter((one) => !['PROPOSED', 'APPROVED', 'REFUSED_BY_OWNER'].includes(one.state));
    const views = [];
    for (const engagement of visible) {
      const view = await assignmentView(engagement, principal.id);
      if (view) views.push(view);
    }
    return { assignments: views };
  }),
);

humanWorkRouter.get(
  '/assignments/:engagementId',
  handler(async (req) => {
    const principal = requirePerson();
    const engagement = await mine(pathId(req, 'engagementId'), principal.id);
    const view = await assignmentView(engagement, principal.id);
    if (!view) throw notFound('No assignment with that id.');
    return view;
  }),
);

humanWorkRouter.post(
  '/assignments/:engagementId/answer',
  handler(async (req) => {
    const principal = requirePerson();
    const engagement = await mine(pathId(req, 'engagementId'), principal.id);
    const body = bodyOf(req);
    const accept = body['accept'];
    if (typeof accept !== 'boolean') throw badRequest('"accept" must be true or false.');
    unwrap(
      await answerInvitation({
        engagementId: engagement.id,
        userId: principal.id,
        accept,
        note: optionalString(body['note'], 'note') ?? null,
      }),
    );
    return assignmentView((await getEngagement(engagement.id))!, principal.id);
  }),
);

humanWorkRouter.post(
  '/assignments/:engagementId/updates',
  handler(async (req) => {
    const principal = requirePerson();
    const engagement = await mine(pathId(req, 'engagementId'), principal.id);
    const body = bodyOf(req);
    unwrap(
      await postUpdate({
        engagementId: engagement.id,
        kind: requiredString(body['kind'], 'kind'),
        text: requiredString(body['text'], 'text'),
        as: 'ASSIGNEE',
        userId: principal.id,
      }),
    );
    return assignmentView((await getEngagement(engagement.id))!, principal.id);
  }),
);

humanWorkRouter.post(
  '/assignments/:engagementId/deliverables',
  handler(async (req) => {
    const principal = requirePerson();
    const engagement = await mine(pathId(req, 'engagementId'), principal.id);
    const body = bodyOf(req);
    // An assignee holds no membership, so they cannot register a document in
    // the project; they hand in a reference, and a coordinator registers the
    // file if one is needed.
    unwrap(
      await submitDeliverable({
        engagementId: engagement.id,
        description: requiredString(body['description'], 'description'),
        documentId: null,
        reference: requiredString(body['reference'], 'reference'),
        as: 'ASSIGNEE',
        userId: principal.id,
      }),
    );
    return assignmentView((await getEngagement(engagement.id))!, principal.id);
  }),
);
