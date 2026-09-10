/**
 * The door a connected site comes in through.
 *
 * Five routes, all project-scoped, all resolved through `requireProject` — so
 * the authorization decision is `services/identity/policy.ts` and nothing else,
 * exactly as it is for every other project-scoped resource. There is no connect
 * policy module and there must never be one, for §21's reason: a second
 * security model is always the weaker of the two.
 *
 * ---------------------------------------------------------------------------
 * The refusal
 * ---------------------------------------------------------------------------
 *
 * A project this caller may not reach, a source system this Brain does not
 * speak, and a record that was never registered are all the same 404 with the
 * same body. That is invariant 23 at a new boundary: a site that could tell
 * "forbidden" from "absent" could enumerate a Brain it has no access to by
 * feeding it ids.
 *
 * ---------------------------------------------------------------------------
 * The idempotency key is derived, and a supplied one is refused
 * ---------------------------------------------------------------------------
 *
 * The command's logical key is the record and the command — both of which are
 * in the path, both of which the server already holds. So the server builds it
 * and a caller-supplied `Idempotency-Key` is refused rather than ignored: a
 * caller who sent one believes it is what makes their retry safe, and quietly
 * dropping it would leave them with the belief and not the property (§20). The
 * property is there either way; it is just not theirs to name.
 */
import { Router } from 'express';
import {
  EXTERNAL_COMMANDS,
  type ExternalCommand,
  type ExternalSourceSystem,
} from '../domain/types.ts';
import { currentContext, currentPrincipal } from '../services/identity/context.ts';
import { recordIdentityEvent } from '../repos/identity.ts';
import { listRejections } from '../repos/externalRecords.ts';
import {
  BatchTooLarge,
  UnknownRecord,
  projectionFor,
  projectionsSince,
  runCommand,
  syncRecords,
} from '../services/connect/service.ts';
import { commandKeyOf, isSourceSystem } from '../services/connect/contract.ts';
import type { ExternalProjection } from '../services/connect/projection.ts';
import { runIdempotentRequest, IDEMPOTENCY_HEADER } from '../services/effects/http.ts';
import type { OperationNamespace } from '../services/effects/engine.ts';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalInteger,
  optionalString,
  pathId,
  queryOf,
  requireProject,
} from './helpers.ts';

export const connectRouter: Router = Router();

/**
 * One command from one site is one intent, whoever presented the credential.
 *
 * `PROJECT` scope rather than `PRINCIPAL`: two people on the site pressing the
 * same button mean one request, and if the site's credential is ever rotated
 * mid-flight the retry must still land on the original operation rather than
 * starting a second one.
 */
const COMMAND_NAMESPACE: OperationNamespace = {
  name: 'connect.command',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'STANDARD',
};

/** The refusal, byte-identical wherever it is thrown. */
function refuse(): never {
  throw notFound('No record with that id.');
}

function sourceSystemOf(req: { params: Record<string, string> }): ExternalSourceSystem {
  const raw = req.params['sourceSystem'];
  // Uppercased before matching, because a site's own spelling of itself in a
  // URL is a cosmetic choice and refusing `deal-dispatch` would be a trap.
  const normalized = typeof raw === 'string' ? raw.replace(/-/g, '_').toUpperCase() : '';
  if (!isSourceSystem(normalized)) refuse();
  return normalized;
}

async function audit(input: {
  action: string;
  projectId: string;
  targetId: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const principal = currentPrincipal();
  const context = currentContext();
  try {
    await recordIdentityEvent({
      actorType: principal ? principal.type : 'ANONYMOUS',
      actorId: principal?.id ?? null,
      credentialId: principal?.credentialId ?? null,
      action: input.action,
      targetType: 'EXTERNAL_RECORD',
      targetId: input.targetId,
      projectId: input.projectId,
      result: input.result,
      requestId: context?.requestId ?? null,
      metadata: input.metadata ?? {},
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
  } catch {
    /* an unwritable audit row must not change the outcome it was recording */
  }
}

/* -------------------------------------------------------------------------- */
/* Registering what the site holds                                            */
/* -------------------------------------------------------------------------- */

connectRouter.post(
  '/projects/:projectId/connect/:sourceSystem/records',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const sourceSystem = sourceSystemOf(req);
    const body = bodyOf(req);

    const records = body['records'];
    if (!Array.isArray(records)) {
      throw badRequest('"records" must be an array.');
    }

    try {
      const report = await syncRecords({
        projectId: project.id,
        sourceSystem,
        records,
      });
      await audit({
        action: 'EXTERNAL_SYNC',
        projectId: project.id,
        targetId: null,
        result: 'SUCCESS',
        metadata: {
          sourceSystem,
          imported: report.imported,
          updated: report.updated,
          unchanged: report.unchanged,
          stale: report.stale,
          rejected: report.rejected.length,
        },
      });
      return report;
    } catch (error) {
      if (error instanceof BatchTooLarge) throw badRequest(error.message);
      throw error;
    }
  }),
);

/* -------------------------------------------------------------------------- */
/* What Brain makes of it                                                     */
/* -------------------------------------------------------------------------- */

connectRouter.get(
  '/projects/:projectId/connect/:sourceSystem/records',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const sourceSystem = sourceSystemOf(req);
    const query = queryOf(req);
    return await projectionsSince({
      projectId: project.id,
      sourceSystem,
      since: optionalString(query['since'], 'since') ?? null,
      limit: optionalInteger(query['limit'], 'limit', { min: 1, max: 200 }),
    });
  }),
);

connectRouter.get(
  '/projects/:projectId/connect/:sourceSystem/records/:sourceRecordId',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const sourceSystem = sourceSystemOf(req);
    const projection = await projectionFor({
      projectId: project.id,
      sourceSystem,
      sourceRecordId: pathId(req, 'sourceRecordId'),
    });
    if (!projection) refuse();
    return { record: projection };
  }),
);

connectRouter.get(
  '/projects/:projectId/connect/:sourceSystem/rejections',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    sourceSystemOf(req);
    return { rejections: await listRejections({ projectId: project.id }) };
  }),
);

/* -------------------------------------------------------------------------- */
/* One typed command from a person on the site                                */
/* -------------------------------------------------------------------------- */

connectRouter.post(
  '/projects/:projectId/connect/:sourceSystem/records/:sourceRecordId/commands',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const sourceSystem = sourceSystemOf(req);
    const sourceRecordId = pathId(req, 'sourceRecordId');
    const body = bodyOf(req);

    if (req.header(IDEMPOTENCY_HEADER) !== undefined) {
      throw badRequest(
        'This route derives its own idempotency key from the record and the command, ' +
          'so an Idempotency-Key header is refused rather than ignored. Retrying the same ' +
          'command is already one command.',
      );
    }

    const raw = body['command'];
    if (!(EXTERNAL_COMMANDS as readonly unknown[]).includes(raw)) {
      throw badRequest(
        `"command" must be one of: ${EXTERNAL_COMMANDS.join(', ')}.`,
      );
    }
    const command = raw as ExternalCommand;

    const principal = currentPrincipal();
    const key = commandKeyOf(sourceSystem, sourceRecordId, command);

    try {
      const reply = await runIdempotentRequest<{ record: ExternalProjection }>(
        {
          namespace: COMMAND_NAMESPACE,
          projectId: project.id,
          key,
          // The semantic input, and nothing else. No actor label, no clock, no
          // request id: a fingerprint that moved between attempts would make a
          // retry look like a different request and refuse it (§20).
          payload: { sourceSystem, sourceRecordId, command },
          principalType: principal ? principal.type : 'SYSTEM',
          principalId: principal?.id ?? 'system',
          correlationId: currentContext()?.requestId ?? null,
          /*
           * A replay re-reads and re-authorizes rather than replaying a stored
           * body. `requireProject` above has already decided this caller may
           * reach the project; this reads the record through the same path any
           * other read would take, so a caller who has since lost access gets
           * nothing.
           */
          replay: async () => {
            const projection = await projectionFor({
              projectId: project.id,
              sourceSystem,
              sourceRecordId,
            });
            if (!projection) return null;
            return { record: projection };
          },
        },
        async () => {
          const result = await runCommand({
            projectId: project.id,
            sourceSystem,
            sourceRecordId,
            command,
            actor: body['actor'],
          });
          await audit({
            action: 'EXTERNAL_COMMAND',
            projectId: project.id,
            targetId: result.projection.brainId,
            result: 'SUCCESS',
            metadata: { sourceSystem, sourceRecordId, command },
          });
          return {
            resultRef: result.projection.brainId,
            resultSummary: command,
            value: { record: result.projection },
          };
        },
      );

      return {
        record: reply.value.record,
        // True when this request did not perform the command because an
        // equivalent one already had. The site renders the same thing either
        // way; it is here so the difference is provable rather than assumed.
        replayed: reply.replayed,
        operationId: reply.operationId,
      };
    } catch (error) {
      if (error instanceof UnknownRecord) refuse();
      throw error;
    }
  }),
);
