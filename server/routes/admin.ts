/**
 * Administering identities.
 *
 * Everything under `/api/admin` requires a Brain administrator, enforced once
 * by a router-level guard rather than route by route — the failure mode of
 * per-route checks is the one route somebody forgot, and here that route would
 * be "create a user".
 *
 * Three rules the operations below all keep:
 *
 *   * **A stored credential is never returned.** Issuing one hands back
 *     plaintext exactly once; every listing afterwards shows a prefix and dates.
 *   * **The last administrator cannot be removed.** Not as a courtesy — a Brain
 *     with no enabled administrator has no way to grant anybody the right to fix
 *     it, and the only remedy left is the direct database access this whole step
 *     exists to make unnecessary.
 *   * **Every mutation is audited**, with the acting administrator, the target,
 *     and never the secret.
 *
 * This is not the fleet UI. It creates identities and credentials; it says
 * nothing about what a worker is doing, because in Step 4 a worker does not do
 * anything yet.
 */
import { Router } from 'express';
import type { Request } from 'express';
import {
  PROJECT_ROLES,
  WORKER_SCOPES,
  type ActorType,
  type ProjectRole,
  type WorkerScope,
} from '../domain/types.ts';
import {
  countEnabledBrainAdmins,
  createUser,
  createWorker,
  getUser,
  getWorker,
  getWorkerByName,
  getUserByEmail,
  getCredential,
  grantMembership,
  issueWorkerCredential,
  listCredentials,
  listIdentityEvents,
  listMembershipsForProject,
  listUsers,
  listWorkers,
  normalizeWorkerName,
  recordIdentityEvent,
  revokeCredential,
  revokeMembership,
  setBrainAdmin,
  setUserDisabled,
  setUserPassword,
  setWorkerStatus,
} from '../repos/identity.ts';
import { WeakPasswordError } from '../services/identity/secrets.ts';
import { currentContext, currentPrincipal } from '../services/identity/context.ts';
import { recordEvent } from '../repos/events.ts';
import {
  badRequest,
  bodyOf,
  brainAdminOnly,
  conflict,
  handler,
  notFound,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  pathId,
  requireProject,
  requiredString,
} from './helpers.ts';

export const adminRouter = Router();

adminRouter.use(brainAdminOnly());

function actor(): { type: ActorType; id: string } {
  const principal = currentPrincipal();
  // The guard above guarantees a principal; this is the belt to its braces, and
  // SYSTEM is the identity with no authority rather than one with all of it.
  return principal ? { type: principal.type, id: principal.id } : { type: 'SYSTEM', id: 'system' };
}

async function audit(
  req: Request,
  input: {
    action: string;
    targetType: string;
    targetId: string | null;
    projectId?: string | null;
    result?: 'SUCCESS' | 'DENIED' | 'FAILED';
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const who = actor();
  const context = currentContext();
  try {
    await recordIdentityEvent({
      actorType: who.type,
      actorId: who.id,
      credentialId: currentPrincipal()?.credentialId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      projectId: input.projectId ?? null,
      result: input.result ?? 'SUCCESS',
      requestId: context?.requestId ?? null,
      metadata: input.metadata ?? {},
      userAgent: req.header('user-agent') ?? null,
      remoteAddr: req.ip ?? null,
    });
  } catch (error) {
    // Unlike a denial, an administrative mutation losing its audit row is
    // serious: invariant 3 says no important action without an event. Loud, and
    // the operation still stands, because rolling back a completed grant on an
    // audit failure would leave the two disagreeing in the other direction.
    console.error('[brain] identity audit could not be written:', error);
  }
}

function readRole(value: unknown, field = 'role'): ProjectRole {
  const raw = requiredString(value, field).toUpperCase();
  const match = PROJECT_ROLES.find((role) => role === raw);
  if (!match) {
    throw badRequest(`"${raw}" is not a role. Expected one of: ${PROJECT_ROLES.join(', ')}.`);
  }
  return match;
}

function readScopes(value: unknown): WorkerScope[] {
  const raw = optionalStringArray(value, 'scopes') ?? [];
  const allowed = new Set<string>(WORKER_SCOPES);
  const out: WorkerScope[] = [];
  for (const entry of raw) {
    if (!allowed.has(entry)) {
      throw badRequest(
        `"${entry}" is not a scope. Expected some of: ${WORKER_SCOPES.join(', ')}.`,
      );
    }
    if (!out.includes(entry as WorkerScope)) out.push(entry as WorkerScope);
  }
  return out;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

adminRouter.get(
  '/users',
  handler(async () => ({ users: await listUsers() })),
);

adminRouter.post(
  '/users',
  handler(async (req) => {
    const body = bodyOf(req);
    const email = requiredString(body['email'], 'email');
    const displayName = requiredString(body['displayName'], 'displayName');
    const password = requiredString(body['password'], 'password');
    const isBrainAdmin = optionalBoolean(body['isBrainAdmin'], 'isBrainAdmin') ?? false;

    // Checked rather than caught: a unique-constraint violation would be a 500
    // with a database sentence in it, and this is a thing an administrator does
    // by hand and gets wrong by hand.
    if (await getUserByEmail(email)) {
      throw conflict(`Somebody already uses ${email.toLowerCase()}.`);
    }

    const who = actor();
    let user;
    try {
      user = await createUser({
        email,
        displayName,
        password,
        isBrainAdmin,
        // Whoever created this account knows the password they typed, so it is
        // temporary by construction. It stops being usable for anything else
        // the moment the person signs in.
        mustChangePassword: true,
        createdByType: who.type,
        createdById: who.id,
      });
    } catch (error) {
      if (error instanceof WeakPasswordError) throw badRequest(error.message);
      throw error;
    }

    await audit(req, {
      action: 'CREATE_USER',
      targetType: 'USER',
      targetId: user.id,
      metadata: { email: user.email, isBrainAdmin },
    });
    return { user };
  }),
);

adminRouter.post(
  '/users/:userId/disabled',
  handler(async (req) => {
    const userId = pathId(req, 'userId');
    const body = bodyOf(req);
    const disabled = optionalBoolean(body['disabled'], 'disabled');
    if (disabled === undefined) throw badRequest('"disabled" must be true or false.');

    const user = await getUser(userId);
    if (!user) throw notFound(`No user with id "${userId}".`);

    if (disabled && user.isBrainAdmin && (await countEnabledBrainAdmins(user.id)) === 0) {
      throw conflict(
        'That is the last enabled Brain administrator. Promote somebody else first — a Brain ' +
          'with no administrator cannot grant anyone the right to become one.',
      );
    }

    const updated = await setUserDisabled(userId, disabled);
    await audit(req, {
      action: disabled ? 'DISABLE_USER' : 'ENABLE_USER',
      targetType: 'USER',
      targetId: userId,
      metadata: { email: user.email },
    });
    return { user: updated };
  }),
);

adminRouter.post(
  '/users/:userId/brain-admin',
  handler(async (req) => {
    const userId = pathId(req, 'userId');
    const isAdmin = optionalBoolean(bodyOf(req)['isBrainAdmin'], 'isBrainAdmin');
    if (isAdmin === undefined) throw badRequest('"isBrainAdmin" must be true or false.');

    const user = await getUser(userId);
    if (!user) throw notFound(`No user with id "${userId}".`);
    if (!isAdmin && user.isBrainAdmin && (await countEnabledBrainAdmins(user.id)) === 0) {
      throw conflict('That is the last enabled Brain administrator.');
    }

    const updated = await setBrainAdmin(userId, isAdmin);
    await audit(req, {
      action: isAdmin ? 'GRANT_BRAIN_ADMIN' : 'REVOKE_BRAIN_ADMIN',
      targetType: 'USER',
      targetId: userId,
      metadata: { email: user.email },
    });
    return { user: updated };
  }),
);

/**
 * Reset somebody's password without knowing their old one.
 *
 * An administrator can already grant themselves anything, so this adds no
 * authority — what it adds is a recovery path that does not involve the
 * database. The new password is temporary by construction and every session
 * that person held is ended.
 */
adminRouter.post(
  '/users/:userId/password',
  handler(async (req) => {
    const userId = pathId(req, 'userId');
    const password = requiredString(bodyOf(req)['password'], 'password');
    const user = await getUser(userId);
    if (!user) throw notFound(`No user with id "${userId}".`);

    try {
      await setUserPassword(userId, password, { mustChangePassword: true });
    } catch (error) {
      if (error instanceof WeakPasswordError) throw badRequest(error.message);
      throw error;
    }
    await audit(req, {
      action: 'RESET_PASSWORD',
      targetType: 'USER',
      targetId: userId,
      metadata: { email: user.email },
    });
    return { user: await getUser(userId) };
  }),
);

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

adminRouter.get(
  '/workers',
  handler(async () => {
    const workers = await listWorkers();
    return {
      workers: await Promise.all(
        workers.map(async (worker) => ({
          ...worker,
          // Metadata only. There is no shape in this response, at any depth,
          // from which a credential could be reconstructed.
          credentials: await listCredentials(worker.id),
        })),
      ),
    };
  }),
);

adminRouter.post(
  '/workers',
  handler(async (req) => {
    const body = bodyOf(req);
    const name = normalizeWorkerName(requiredString(body['name'], 'name'));
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) {
      throw badRequest(
        'A worker name is 2–64 characters of lowercase letters, digits, dot, dash or underscore.',
      );
    }
    if (await getWorkerByName(name)) throw conflict(`A worker called "${name}" already exists.`);

    const who = actor();
    const worker = await createWorker({
      name,
      displayName: optionalString(body['displayName'], 'displayName') ?? name,
      workerType: optionalString(body['workerType'], 'workerType') ?? 'GENERIC',
      description: optionalString(body['description'], 'description') ?? null,
      createdByType: who.type,
      createdById: who.id,
    });
    await audit(req, {
      action: 'CREATE_WORKER',
      targetType: 'WORKER',
      targetId: worker.id,
      metadata: { name: worker.name },
    });
    return { worker };
  }),
);

adminRouter.post(
  '/workers/:workerId/disabled',
  handler(async (req) => {
    const workerId = pathId(req, 'workerId');
    const disabled = optionalBoolean(bodyOf(req)['disabled'], 'disabled');
    if (disabled === undefined) throw badRequest('"disabled" must be true or false.');
    const worker = await getWorker(workerId);
    if (!worker) throw notFound(`No worker with id "${workerId}".`);

    const updated = await setWorkerStatus(workerId, disabled ? 'DISABLED' : 'ACTIVE');
    await audit(req, {
      action: disabled ? 'DISABLE_WORKER' : 'ENABLE_WORKER',
      targetType: 'WORKER',
      targetId: workerId,
      metadata: { name: worker.name },
    });
    return { worker: updated };
  }),
);

/**
 * Issue a credential.
 *
 * `rotate: true` issues the new one and revokes the named old one, in that
 * order, so the worker is never without a working credential in between. An
 * overlap is offered instead — `revokeAfter: false` leaves the old one alive
 * until it is revoked explicitly — because rotating a credential a running job
 * is using should not require stopping the job.
 */
adminRouter.post(
  '/workers/:workerId/credentials',
  handler(async (req) => {
    const workerId = pathId(req, 'workerId');
    const worker = await getWorker(workerId);
    if (!worker) throw notFound(`No worker with id "${workerId}".`);
    if (worker.disabled) {
      throw conflict(
        `${worker.name} is disabled. Enable it before issuing a credential, or the credential ` +
          'would be refused the moment it was used.',
      );
    }

    const body = bodyOf(req);
    const expiresInDays = body['expiresInDays'];
    let expiresAt: string | null = null;
    if (expiresInDays !== undefined && expiresInDays !== null) {
      const days = Number(expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        throw badRequest('"expiresInDays" must be a positive number of days, at most 3650.');
      }
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }

    const rotatedFrom = optionalString(body['rotatedFrom'], 'rotatedFrom') ?? null;
    if (rotatedFrom) {
      const previous = await getCredential(rotatedFrom);
      if (!previous || previous.workerId !== workerId) {
        throw badRequest('"rotatedFrom" must be a credential belonging to this worker.');
      }
    }

    const who = actor();
    const issued = await issueWorkerCredential({
      workerId,
      expiresAt,
      issuedByType: who.type,
      issuedById: who.id,
      rotatedFrom,
    });

    // Revoked *after* the new one exists, so rotation never leaves a gap.
    const revokeAfter = optionalBoolean(body['revokeAfter'], 'revokeAfter') ?? true;
    let revoked: string | null = null;
    if (rotatedFrom && revokeAfter) {
      await revokeCredential(rotatedFrom, 'ROTATED');
      revoked = rotatedFrom;
    }

    await audit(req, {
      action: rotatedFrom ? 'ROTATE_CREDENTIAL' : 'ISSUE_CREDENTIAL',
      targetType: 'WORKER_CREDENTIAL',
      targetId: issued.credential.id,
      metadata: {
        worker: worker.name,
        // The prefix, which identifies the credential without being it.
        prefix: issued.credential.prefix,
        expiresAt,
        rotatedFrom,
        revokedPrevious: revoked,
      },
    });

    return {
      credential: issued.credential,
      // The only response in this application that contains a usable credential.
      // It is not stored anywhere and cannot be retrieved again.
      secret: issued.plaintext,
      warning:
        'This is the only time this credential is shown. Store it now; it cannot be recovered.',
    };
  }),
);

adminRouter.post(
  '/workers/:workerId/credentials/:credentialId/revoke',
  handler(async (req) => {
    const workerId = pathId(req, 'workerId');
    const credentialId = pathId(req, 'credentialId');
    const credential = await getCredential(credentialId);
    if (!credential || credential.workerId !== workerId) {
      throw notFound(`No credential with id "${credentialId}" for that worker.`);
    }
    const updated = await revokeCredential(credentialId, 'REVOKED_BY_ADMIN');
    await audit(req, {
      action: 'REVOKE_CREDENTIAL',
      targetType: 'WORKER_CREDENTIAL',
      targetId: credentialId,
      metadata: { prefix: credential.prefix },
    });
    return { credential: updated };
  }),
);

// ---------------------------------------------------------------------------
// Project membership
// ---------------------------------------------------------------------------

adminRouter.get(
  '/projects/:projectId/members',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return {
      projectId: project.id,
      members: await listMembershipsForProject(project.id, { includeRevoked: true }),
    };
  }),
);

/**
 * Grant access.
 *
 * Idempotent by construction: the repository upserts against the unique triple,
 * so an administrator clicking twice, or two administrators granting at once,
 * produce one membership with one deterministic role rather than a race.
 */
adminRouter.post(
  '/projects/:projectId/members',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const principalType = requiredString(body['principalType'], 'principalType').toUpperCase();
    const principalId = requiredString(body['principalId'], 'principalId');

    if (principalType !== 'HUMAN' && principalType !== 'WORKER') {
      throw badRequest('"principalType" must be HUMAN or WORKER.');
    }

    // The principal has to exist. Granting access to an id nobody holds writes a
    // row that means nothing and hides a typo until somebody wonders why they
    // still cannot see the project.
    if (principalType === 'HUMAN') {
      if (!(await getUser(principalId))) throw notFound(`No user with id "${principalId}".`);
    } else if (!(await getWorker(principalId))) {
      throw notFound(`No worker with id "${principalId}".`);
    }

    const role = principalType === 'HUMAN' ? readRole(body['role']) : null;
    const scopes = principalType === 'WORKER' ? readScopes(body['scopes']) : [];
    if (principalType === 'WORKER' && scopes.length === 0) {
      throw badRequest(
        'A worker needs at least one scope. Membership says which project; scopes say what it may do.',
      );
    }

    const who = actor();
    const membership = await grantMembership({
      projectId: project.id,
      principalType,
      principalId,
      role,
      scopes,
      grantedByType: who.type,
      grantedById: who.id,
    });

    await audit(req, {
      action: 'GRANT_MEMBERSHIP',
      targetType: principalType,
      targetId: principalId,
      projectId: project.id,
      metadata: { role, scopes },
    });
    // The project's own history should show who was let into it, so this is one
    // of the few actions that writes to both logs.
    await recordEvent({
      projectId: project.id,
      entityType: principalType === 'HUMAN' ? 'USER' : 'WORKER',
      entityId: principalId,
      eventType: 'ACCESS_GRANTED',
      payload: { role, scopes, by: who.id, byType: who.type },
    });

    return { membership };
  }),
);

adminRouter.delete(
  '/projects/:projectId/members/:principalType/:principalId',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const principalType = pathId(req, 'principalType').toUpperCase();
    const principalId = pathId(req, 'principalId');
    if (principalType !== 'HUMAN' && principalType !== 'WORKER') {
      throw badRequest('The principal type must be HUMAN or WORKER.');
    }

    const removed = await revokeMembership(project.id, principalType, principalId);
    await audit(req, {
      action: 'REVOKE_MEMBERSHIP',
      targetType: principalType,
      targetId: principalId,
      projectId: project.id,
      result: removed ? 'SUCCESS' : 'FAILED',
    });
    if (removed) {
      await recordEvent({
        projectId: project.id,
        entityType: principalType === 'HUMAN' ? 'USER' : 'WORKER',
        entityId: principalId,
        eventType: 'ACCESS_REVOKED',
        payload: { by: actor().id, byType: actor().type },
      });
    }
    // Revocation takes effect on the very next request: memberships are read
    // fresh during authentication, never cached into a token.
    return { revoked: removed };
  }),
);

// ---------------------------------------------------------------------------
// The identity audit
// ---------------------------------------------------------------------------

adminRouter.get(
  '/identity-events',
  handler(async (req) => {
    const query = req.query as Record<string, unknown>;
    return {
      events: await listIdentityEvents({
        ...(typeof query['actorId'] === 'string' ? { actorId: query['actorId'] } : {}),
        ...(typeof query['projectId'] === 'string' ? { projectId: query['projectId'] } : {}),
        ...(typeof query['action'] === 'string' ? { action: query['action'] } : {}),
        limit: Number(query['limit'] ?? 200),
      }),
    };
  }),
);
