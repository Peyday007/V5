/**
 * External actions' door (§51).
 *
 * Every route resolves through `requireProject` — `decideProjectAccess`
 * against the authenticated principal — so absent and forbidden are the same
 * 404 with the same body, and every handler calls `requirePerson`, so a worker
 * is refused by *type* as well as by level. Which level each write needs is
 * declared in `services/identity/policy.ts`, beside every other route: there
 * is no external-actions policy module and there must never be one.
 *
 * Nothing here accepts, returns or logs a credential. A connection is created
 * with the *name* of a deployment secret that Brain assigns; the value is set
 * in the deployment by an administrator and read only at the moment it is
 * used.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import { currentPrincipal } from '../services/identity/context.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import {
  checkConnection,
  connect,
  connectionsView,
  isExternalProvider,
  reconnect,
  revoke,
} from '../services/external/connections.ts';
import {
  approveAction,
  cancelAction,
  executeAction,
  isActionKind,
  prepareAction,
  readBack,
  resolveUncertain,
} from '../services/external/actions.ts';
import { getAction, getConnection, listActions, listExternalEvents } from '../repos/externalActions.ts';
import { readCapabilities } from '../services/cash/capabilities.ts';
import type { ExternalActionContent } from '../domain/types.ts';

export const externalRouter = Router();

const CAPABILITY_IDS = [
  'NOTIFY_OWNER',
  'SEND_A_MESSAGE',
  'ISSUE_AN_INVOICE',
  'TAKE_A_PAYMENT',
  'PUBLISH_A_LISTING',
  'SIGN_AN_AGREEMENT',
] as const;

externalRouter.get(
  '/projects/:projectId/external',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const administers = decideProjectAccess(currentPrincipal(), project.id, 'ADMIN').allowed;
    const readings = await readCapabilities([...CAPABILITY_IDS], project.id);
    return {
      project: { id: project.id, name: project.name },
      ...(await connectionsView(project.id)),
      capabilities: readings.map((one) => ({
        id: one.id,
        state: one.state,
        does: one.definition?.does ?? null,
        requires: one.definition?.requires ?? null,
        detail: one.detail,
      })),
      actions: await listActions(project.id, 50),
      history: await listExternalEvents(project.id, undefined, 50),
      can: {
        administer: administers,
        approve: administers,
        prepare: decideProjectAccess(currentPrincipal(), project.id, 'WRITE').allowed,
      },
    };
  }),
);

/* ------------------------------------------------------------------------- */
/* Connections                                                                */
/* ------------------------------------------------------------------------- */

async function connectionIn(projectId: string, id: string) {
  const connection = await getConnection(id);
  if (!connection || connection.projectId !== projectId) throw notFound('No connection with that id.');
  return connection;
}

externalRouter.post(
  '/projects/:projectId/external/connections',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const provider = requiredString(body['provider'], 'provider');
    if (!isExternalProvider(provider)) {
      throw badRequest(`"${provider}" is not a provider this Brain can act through.`);
    }
    // A value that looks like a credential is refused by name rather than
    // stored and ignored: there is no field here that holds one.
    for (const key of ['label', 'selfDestination', 'sender']) {
      const value = body[key];
      if (typeof value === 'string' && /^(re_|sk_|rk_|pk_)[A-Za-z0-9_]{8,}/.test(value.trim())) {
        throw unprocessable(
          'That looks like a credential. Brain never takes one here: set it as the named deployment secret instead.',
        );
      }
    }
    const result = await connect({
      projectId: project.id,
      provider,
      label: optionalString(body['label'], 'label') ?? null,
      selfDestination: optionalString(body['selfDestination'], 'selfDestination') ?? null,
      sender: optionalString(body['sender'], 'sender') ?? null,
      actorRef: principal.id,
    });
    return {
      connection: { id: result.connection.id, secretName: result.connection.secretName },
      created: result.created,
      message: result.created
        ? `Connected. Nothing can be sent yet: an administrator sets the deployment secret ${result.connection.secretName}, then presses Check.`
        : 'This provider was already connected on this project, so nothing changed.',
    };
  }),
);

externalRouter.post(
  '/projects/:projectId/external/connections/:connectionId/check',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const connection = await connectionIn(project.id, pathId(req, 'connectionId'));
    const reading = await checkConnection(connection.id, principal.id);
    return { state: reading?.state ?? null, says: reading?.says ?? null, nextStep: reading?.nextStep ?? null };
  }),
);

externalRouter.post(
  '/projects/:projectId/external/connections/:connectionId/revoke',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const connection = await connectionIn(project.id, pathId(req, 'connectionId'));
    const reason = requiredString(bodyOf(req)['reason'], 'reason');
    const moved = await revoke({ connectionId: connection.id, actorRef: principal.id, reason });
    return {
      revoked: moved,
      message: moved
        ? 'Revoked. Brain will not act through it. Delete or rotate the credential at the provider as well if it may have leaked; removing the deployment secret is an administrator step.'
        : 'It was already revoked.',
    };
  }),
);

externalRouter.post(
  '/projects/:projectId/external/connections/:connectionId/reconnect',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const connection = await connectionIn(project.id, pathId(req, 'connectionId'));
    const result = await reconnect({ connectionId: connection.id, actorRef: principal.id });
    if (!result) throw unprocessable('Only a revoked connection can be reconnected.');
    return {
      connection: { id: result.connection.id, secretName: result.connection.secretName },
      created: result.created,
      message: 'Reconnected as a new connection. It must be checked before anything reads it as available.',
    };
  }),
);

/* ------------------------------------------------------------------------- */
/* Actions                                                                    */
/* ------------------------------------------------------------------------- */

async function actionIn(projectId: string, id: string) {
  const action = await getAction(id);
  if (!action || action.projectId !== projectId) throw notFound('No action with that id.');
  return action;
}

function readContent(body: Record<string, unknown>): ExternalActionContent {
  const content: ExternalActionContent = {
    subject: optionalString(body['subject'], 'subject') ?? undefined,
    body: optionalString(body['body'], 'body') ?? undefined,
  };
  if (Array.isArray(body['lines'])) {
    content.lines = (body['lines'] as unknown[]).map((raw) => {
      const line = (raw ?? {}) as Record<string, unknown>;
      return {
        description: typeof line['description'] === 'string' ? line['description'] : '',
        amountCents: typeof line['amountCents'] === 'number' ? line['amountCents'] : NaN,
      };
    });
  }
  if (typeof body['daysUntilDue'] === 'number') content.daysUntilDue = body['daysUntilDue'];
  return content;
}

externalRouter.post(
  '/projects/:projectId/external/actions',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const kind = requiredString(body['kind'], 'kind');
    if (!isActionKind(kind)) throw badRequest(`"${kind}" is not an action this Brain performs.`);
    const prepared = await prepareAction({
      projectId: project.id,
      kind,
      destination: optionalString(body['destination'], 'destination') ?? null,
      content: readContent(body),
      currency: optionalString(body['currency'], 'currency') ?? null,
      opportunityId: optionalString(body['opportunityId'], 'opportunityId') ?? null,
      conversationId: optionalString(body['conversationId'], 'conversationId') ?? null,
      requestedByType: 'HUMAN',
      requestedBy: principal.id,
    });
    if (!prepared.ok) throw unprocessable(prepared.reason, { need: prepared.need });
    // A self-directed notification needs no approval and is sent now.
    const sent = !prepared.action.approvalRequired && prepared.created
      ? await executeAction(prepared.action.id)
      : null;
    return {
      action: (await getAction(prepared.action.id))!,
      created: prepared.created,
      message: prepared.action.approvalRequired
        ? 'Prepared. Nothing has been sent: it waits for an administrator to approve exactly this.'
        : sent
          ? `Sent: ${sent.state}.`
          : 'Already prepared.',
    };
  }),
);

externalRouter.post(
  '/projects/:projectId/external/actions/:actionId/approve',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const action = await actionIn(project.id, pathId(req, 'actionId'));
    const approved = await approveAction({ actionId: action.id, approverUserId: principal.id });
    if (!approved.ok) throw unprocessable(approved.reason, { need: approved.need });
    // Sent at once rather than on the next tick: the person is watching.
    const report = await executeAction(action.id);
    return { action: (await getAction(action.id))!, execution: report };
  }),
);

externalRouter.post(
  '/projects/:projectId/external/actions/:actionId/cancel',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const action = await actionIn(project.id, pathId(req, 'actionId'));
    const reason = optionalString(bodyOf(req)['reason'], 'reason') ?? 'cancelled by a person';
    const done = await cancelAction({ actionId: action.id, actorRef: principal.id, reason });
    if (!done.ok) throw unprocessable(done.reason);
    return { action: (await getAction(action.id))! };
  }),
);

externalRouter.post(
  '/projects/:projectId/external/actions/:actionId/resolve',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const action = await actionIn(project.id, pathId(req, 'actionId'));
    const body = bodyOf(req);
    const outcome = requiredString(body['outcome'], 'outcome');
    if (outcome !== 'HAPPENED' && outcome !== 'DID_NOT_HAPPEN') {
      throw badRequest('The outcome is HAPPENED or DID_NOT_HAPPEN.');
    }
    const done = await resolveUncertain({
      actionId: action.id,
      actorRef: principal.id,
      outcome,
      providerRef: optionalString(body['providerRef'], 'providerRef') ?? null,
      note: requiredString(body['note'], 'note'),
    });
    if (!done.ok) throw unprocessable(done.reason);
    return { action: (await getAction(action.id))! };
  }),
);

externalRouter.post(
  '/projects/:projectId/external/actions/:actionId/refresh',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const action = await actionIn(project.id, pathId(req, 'actionId'));
    await readBack(action.id);
    return { action: (await getAction(action.id))! };
  }),
);

externalRouter.get(
  '/projects/:projectId/external/actions/:actionId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const action = await actionIn(project.id, pathId(req, 'actionId'));
    return { action, history: await listExternalEvents(project.id, action.id) };
  }),
);
