/**
 * The passkey door: enrolling, signing in, and managing your own devices.
 *
 * Three groups of routes with three different guards, and the differences are
 * the design:
 *
 *   - **Enrollment** is unauthenticated, because an invited person holds no
 *     credential but the link in their hand — the same reasoning that puts
 *     `/api/auth/login` on the guard's allowlist. What protects it is the link:
 *     random, single-use, short-lived, bound to one slot, revocable, and spent
 *     by a guarded UPDATE.
 *   - **Signing in** is unauthenticated for the same reason and protected by
 *     the signature.
 *   - **Managing devices** is yours and only yours. A Brain administrator is
 *     deliberately not able to list or revoke somebody's passkeys through these
 *     routes; taking a lost device out of service is `issueRecovery`, which is
 *     audited and retires the credential as part of the recovery rather than as
 *     a quiet administrative act.
 *
 * Every refusal in the first two groups is one sentence with one body. Absent,
 * malformed, expired, spent, revoked, wrong signature and disabled account are
 * indistinguishable, because the difference between them is an oracle.
 */
import { Router, type Request, type Response } from 'express';
import { bodyOf, handler, optionalString, requirePerson, requiredString } from './helpers.ts';
import { badRequest, notFound, unprocessable } from './helpers.ts';
import { issuerFor } from './oauth.ts';
import {
  completeEnrollment,
  createMemberSlot,
  issueRecovery,
  previewEnrollment,
  withdrawLink,
  LINK_REFUSED,
} from '../services/identity/enrollment.ts';
import {
  SIGN_IN_REFUSED,
  authenticationOptions,
  registrationOptions,
  relyingPartyFrom,
  signInWithPasskey,
} from '../services/identity/passkeyAuth.ts';
import { verifyRegistration } from '../services/identity/webauthn.ts';
import {
  addPasskey,
  countLivePasskeys,
  getPasskey,
  listEnrollments,
  listPasskeys,
  revokePasskey,
  takeChallenge,
} from '../repos/passkeys.ts';
import {
  createSession,
  getUser,
  recordIdentityEvent,
  revokeSessionsForPasskey,
} from '../repos/identity.ts';
import { generateSessionToken } from '../services/identity/secrets.ts';
import {
  DEVICE_SESSION_TTL_MS,
  isSecureRequest,
  sessionCookie,
} from '../services/identity/authenticate.ts';
import { requireBrainAdmin } from './helpers.ts';
import { nowIso } from '../repos/util.ts';
import { cashReadiness } from '../services/cash/readiness.ts';

export const passkeyRouter: Router = Router();

function rpFor(req: Request) {
  const rp = relyingPartyFrom(issuerFor(req));
  if (!rp) throw unprocessable('This Brain is not reachable over a origin a passkey can be bound to.');
  return rp;
}

/**
 * Open a session for a device, and record which device opened it.
 *
 * The lifetime is `DEVICE_SESSION_TTL_MS` — thirty days, absolute, carried in
 * the cookie's `Max-Age` so it survives closing the browser. That file has the
 * reasoning; what matters here is the `passkeyId`, which is what lets revoking
 * one device end exactly the sessions that device opened and nothing else.
 */
function startSessionFor(res: Response, req: Request, userId: string, passkeyId: string | null) {
  return (async () => {
    const token = generateSessionToken();
    const session = await createSession({
      userId,
      secret: token.secret,
      ttlMs: DEVICE_SESSION_TTL_MS,
      userAgent: req.header('user-agent') ?? null,
      ip: req.ip ?? null,
      passkeyId,
    });
    res.setHeader(
      'Set-Cookie',
      sessionCookie(token.secret, {
        secure: isSecureRequest(req),
        maxAgeMs: DEVICE_SESSION_TTL_MS,
      }),
    );
    res.setHeader('Cache-Control', 'no-store');
    return session;
  })();
}

/* ------------------------------------------------------------- enrolling */

/** What the person sees before committing a device: their name, and nothing else. */
passkeyRouter.post(
  '/enroll/preview',
  handler(async (req) => {
    const outcome = await previewEnrollment(bodyOf(req)['token']);
    if (!outcome.ok) throw notFound(outcome.reason);
    return { displayName: outcome.displayName, kind: outcome.kind, expiresAt: outcome.expiresAt };
  }),
);

/**
 * The creation options for an invited person.
 *
 * The link is checked again here rather than trusted from the preview: a
 * preview proves somebody held a link a moment ago, and this is the request
 * that actually leads to a credential.
 */
passkeyRouter.post(
  '/enroll/options',
  handler(async (req) => {
    const token = bodyOf(req)['token'];
    const outcome = await previewEnrollment(token);
    if (!outcome.ok) throw notFound(outcome.reason);
    /*
     * The challenge is bound to no user id, because the slot's id must not
     * reach the browser before the link is spent — a preview that handed out an
     * internal identifier would make an intercepted link worth something.
     */
    return registrationOptions({
      userHandle: `enroll:${outcome.displayName}`,
      displayName: outcome.displayName,
      rp: rpFor(req),
      boundTo: null,
    });
  }),
);

/** Spend the link, register the device, and sign the person straight in. */
passkeyRouter.post('/enroll/complete', (req: Request, res: Response) => {
  void (async (): Promise<void> => {
    try {
      const body = bodyOf(req);
      const rp = rpFor(req);
      const challenge = requiredString(body['challenge'], 'challenge');

      if (!(await takeChallenge({ challenge, purpose: 'REGISTER', now: nowIso() }))) {
        res.status(404).json({ error: LINK_REFUSED });
        return;
      }

      const verified = verifyRegistration({
        clientDataJSON: requiredString(body['clientDataJSON'], 'clientDataJSON'),
        attestationObject: requiredString(body['attestationObject'], 'attestationObject'),
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRpId: rp.id,
      });
      if (!verified.ok) {
        res.status(404).json({ error: LINK_REFUSED });
        return;
      }

      const outcome = await completeEnrollment({
        token: body['token'],
        credentialId: verified.value.credentialId,
        publicKey: verified.value.publicKey,
        algorithm: verified.value.algorithm,
        signCount: verified.value.signCount,
        label: optionalString(body['label'], 'label') ?? 'This device',
      });
      if (!outcome.ok) {
        res.status(404).json({ error: outcome.reason });
        return;
      }

      await startSessionFor(res, req, outcome.user.id, outcome.passkeyId);
      res.json({
        user: { id: outcome.user.id, displayName: outcome.user.displayName },
        readiness: await cashReadiness(),
      });
    } catch {
      // Inside enrollment, an unexpected error does not get to explain itself.
      res.status(404).json({ error: LINK_REFUSED });
    }
  })();
});

/* ------------------------------------------------------------- signing in */

passkeyRouter.post(
  '/auth/passkey/options',
  handler(async (req) => authenticationOptions(rpFor(req))),
);

passkeyRouter.post('/auth/passkey/verify', (req: Request, res: Response) => {
  void (async (): Promise<void> => {
    try {
      const body = bodyOf(req);
      const outcome = await signInWithPasskey({
        credentialId: requiredString(body['credentialId'], 'credentialId'),
        clientDataJSON: requiredString(body['clientDataJSON'], 'clientDataJSON'),
        authenticatorData: requiredString(body['authenticatorData'], 'authenticatorData'),
        signature: requiredString(body['signature'], 'signature'),
        challenge: requiredString(body['challenge'], 'challenge'),
        rp: rpFor(req),
      });
      if (!outcome.ok) {
        res.status(401).json({ error: outcome.reason });
        return;
      }
      await startSessionFor(res, req, outcome.user.id, outcome.passkeyId);
      res.json({ user: { id: outcome.user.id, displayName: outcome.user.displayName } });
    } catch {
      res.status(401).json({ error: SIGN_IN_REFUSED });
    }
  })();
});

/* --------------------------------------------------- your own devices */

passkeyRouter.get(
  '/me/passkeys',
  handler(async () => {
    const principal = requirePerson();
    const keys = await listPasskeys(principal.id);
    return {
      passkeys: keys.map((key) => ({
        id: key.id,
        label: key.label,
        originKind: key.originKind,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
      })),
    };
  }),
);

/** Add another device to your own account. Signed in already, by definition. */
passkeyRouter.post(
  '/me/passkeys/options',
  handler(async (req) => {
    const principal = requirePerson();
    const user = await getUser(principal.id);
    if (!user) throw notFound('No such account.');
    return registrationOptions({
      userHandle: user.id,
      displayName: user.displayName,
      rp: rpFor(req),
      boundTo: user.id,
    });
  }),
);

passkeyRouter.post(
  '/me/passkeys',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);
    const rp = rpFor(req);
    const challenge = requiredString(body['challenge'], 'challenge');
    if (!(await takeChallenge({ challenge, purpose: 'REGISTER', now: nowIso() }))) {
      throw badRequest('That registration has expired. Start again.');
    }
    const verified = verifyRegistration({
      clientDataJSON: requiredString(body['clientDataJSON'], 'clientDataJSON'),
      attestationObject: requiredString(body['attestationObject'], 'attestationObject'),
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRpId: rp.id,
    });
    if (!verified.ok) throw badRequest('That device could not be registered.');

    const added = await addPasskey({
      userId: principal.id,
      credentialId: verified.value.credentialId,
      publicKey: verified.value.publicKey,
      algorithm: verified.value.algorithm,
      signCount: verified.value.signCount,
      label: optionalString(body['label'], 'label') ?? 'Another device',
      originKind: 'ADDED_DEVICE',
    });
    if (!added) throw badRequest('That device could not be registered.');

    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: principal.id,
      action: 'ADD_PASSKEY',
      targetType: 'USER',
      targetId: principal.id,
      projectId: null,
      result: 'SUCCESS',
      metadata: { passkeyId: added.id },
    });
    return { passkey: { id: added.id, label: added.label, createdAt: added.createdAt } };
  }),
);

/**
 * Revoke one of your own.
 *
 * Refuses the last live one. A person who revoked their only device would be
 * locked out and would need an administrator to issue a recovery — an
 * escalation with an answering transition, but an entirely avoidable one, and
 * §24's rule is that a control should not produce a state its own user cannot
 * resolve.
 */
passkeyRouter.post(
  '/me/passkeys/:id/revoke',
  handler(async (req) => {
    const principal = requirePerson();
    const id = requiredString(req.params['id'], 'id');
    const key = await getPasskey(id);
    // Somebody else's is a 404, the same answer one that does not exist gives.
    if (!key || key.userId !== principal.id) throw notFound('No such passkey.');

    if ((await countLivePasskeys(principal.id)) <= 1 && !key.revokedAt) {
      throw unprocessable(
        'This is your only registered device. Add another one first, or ask an administrator ' +
          'for a recovery link — revoking it would lock you out.',
      );
    }

    const done = await revokePasskey({
      id,
      reason: optionalString(bodyOf(req)['reason'], 'reason') ?? 'Revoked by its owner.',
      byUserId: principal.id,
    });
    /*
     * And the sessions that device opened, which is the half a revocation
     * would otherwise be missing. Retiring the credential and leaving its
     * session live means the retired device keeps working until the session
     * expires — thirty days, now that a device session is meant to last. The
     * person's other devices are untouched, because they are not what is being
     * taken out of service.
     */
    const endedSessions = done ? await revokeSessionsForPasskey(id) : 0;
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: principal.id,
      action: 'REVOKE_PASSKEY',
      targetType: 'USER',
      targetId: principal.id,
      projectId: null,
      result: done ? 'SUCCESS' : 'DENIED',
      metadata: { passkeyId: id, endedSessions: String(endedSessions) },
    });
    return { revoked: done };
  }),
);

/* ------------------------------------------------- administering members */

passkeyRouter.get(
  '/members',
  handler(async () => {
    requirePerson();
    await requireBrainAdmin();
    const enrollments = await listEnrollments();
    const now = nowIso();
    return {
      readiness: await cashReadiness(),
      links: enrollments.map((one) => ({
        id: one.id,
        userId: one.userId,
        displayName: one.displayName,
        kind: one.kind,
        state: one.revokedAt
          ? 'REVOKED'
          : one.usedAt
            ? 'USED'
            : one.expiresAt <= now
              ? 'EXPIRED'
              : 'LIVE',
        expiresAt: one.expiresAt,
      })),
    };
  }),
);

passkeyRouter.post(
  '/members',
  handler(async (req) => {
    const principal = requirePerson();
    await requireBrainAdmin();
    const link = await createMemberSlot({
      displayName: requiredString(bodyOf(req)['displayName'], 'displayName'),
      issuedByUserId: principal.id,
    });
    // Shown once. The token is not stored and cannot be read back.
    return { enrollment: link };
  }),
);

passkeyRouter.post(
  '/members/:userId/recovery',
  handler(async (req) => {
    const principal = requirePerson();
    await requireBrainAdmin();
    const link = await issueRecovery({
      userId: requiredString(req.params['userId'], 'userId'),
      reason: requiredString(bodyOf(req)['reason'], 'reason'),
      issuedByUserId: principal.id,
    });
    return { enrollment: link };
  }),
);

passkeyRouter.post(
  '/members/enrollments/:id/revoke',
  handler(async (req) => {
    const principal = requirePerson();
    await requireBrainAdmin();
    const done = await withdrawLink({
      enrollmentId: requiredString(req.params['id'], 'id'),
      reason: requiredString(bodyOf(req)['reason'], 'reason'),
      actorUserId: principal.id,
    });
    return { revoked: done };
  }),
);
