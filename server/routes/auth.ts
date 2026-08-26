/**
 * Signing in, signing out, and changing a password.
 *
 * The only routes in the application that can be reached without credentials,
 * which is why they are the only ones written to give nothing away. Every
 * refusal here is the same refusal: a wrong password, an unknown address, a
 * disabled account and an expired session all produce one sentence and one
 * status code. The differences between them are exactly what somebody probing
 * would like to learn, and there is no benefit to a legitimate user in being
 * told which of the four it was — they will try the same thing either way.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { recordIdentityEvent } from '../repos/identity.ts';
import {
  countLiveSessions,
  createSession,
  getPasswordVerifierByEmail,
  getUser,
  revokeSession,
  setUserPassword,
} from '../repos/identity.ts';
import {
  SESSION_TTL_MS,
  clearedSessionCookie,
  isSecureRequest,
  sessionCookie,
} from '../services/identity/authenticate.ts';
import {
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  generateSessionToken,
  verifyPassword,
} from '../services/identity/secrets.ts';
import { currentContext, currentPrincipal } from '../services/identity/context.ts';
import { activeDatabaseConfig } from '../db/database.ts';
import { HttpError, badRequest, bodyOf, handler, requiredString } from './helpers.ts';

export const authRouter = Router();

/** One sentence for every way of failing to sign in. */
const REFUSED = 'Those credentials were not accepted.';

// ---------------------------------------------------------------------------
// A modest brake on guessing
// ---------------------------------------------------------------------------
//
// scrypt already costs an attacker ~60ms per attempt, which is most of the
// defence. This adds a short lockout after repeated failures so that a
// determined script is slowed by more than CPU alone.
//
// It is per-instance and in-memory, and that limitation is real rather than
// hidden: with several Brains running it brakes each of them separately. That is
// acceptable now because there is exactly one instance by design (see
// docs/ROADMAP.md — a second is Step 5's atomic claiming and Step 11's fleet),
// and a shared counter would be a distributed-state problem this step has no
// business solving.

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; firstAt: number }>();

function attemptKey(req: Request, email: string): string {
  return `${req.ip ?? 'unknown'}|${email}`;
}

function throttled(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

/** For tests, which need a clean slate between cases rather than a real clock. */
export function resetLoginThrottle(): void {
  attempts.clear();
}

// ---------------------------------------------------------------------------

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  isBrainAdmin: boolean;
  mustChangePassword: boolean;
}): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: user.mustChangePassword,
  };
}

async function audit(
  req: Request,
  input: {
    action: string;
    result: 'SUCCESS' | 'DENIED' | 'FAILED';
    actorId?: string | null;
    actorType?: 'HUMAN' | 'ANONYMOUS';
    credentialId?: string | null;
    reason?: import('../domain/types.ts').DenialReason | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const context = currentContext();
  try {
    await recordIdentityEvent({
      actorType: input.actorType ?? 'ANONYMOUS',
      actorId: input.actorId ?? null,
      credentialId: input.credentialId ?? null,
      action: input.action,
      targetType: 'USER',
      targetId: input.actorId ?? null,
      result: input.result,
      reason: input.reason ?? null,
      requestId: context?.requestId ?? null,
      metadata: input.metadata ?? {},
      userAgent: req.header('user-agent') ?? null,
      remoteAddr: req.ip ?? null,
    });
  } catch {
    /* the audit must not decide whether somebody can sign in */
  }
}

/**
 * Is this connection safe to put a session cookie on?
 *
 * A cloud-backed Brain has a public URL, and issuing a session over plaintext
 * there would put the credential on the wire for anybody on the path. Refused
 * rather than downgraded, which is the same rule the storage layer already
 * applies to sending a service-role key over http.
 *
 * Local development over http is exempt, because the alternative is a
 * certificate on localhost that everybody works around.
 */
function transportIsAcceptable(req: Request): boolean {
  if (isSecureRequest(req)) return true;
  return (activeDatabaseConfig()?.provider ?? 'sqlite') !== 'postgres';
}

/**
 * Who am I? Public, and says nothing when the answer is nobody.
 *
 * The client asks this on load to decide between the app and a sign-in form, so
 * it has to be reachable without credentials — and therefore has to be careful:
 * it reports the principal the request already proved, and never looks anything
 * up on the strength of what was asked.
 */
authRouter.get(
  '/auth/session',
  handler(async () => {
    const principal = currentPrincipal();
    if (!principal || principal.type !== 'HUMAN') return { authenticated: false, user: null };
    const user = await getUser(principal.id);
    return user ? { authenticated: true, user: publicUser(user) } : { authenticated: false, user: null };
  }),
);

authRouter.post('/auth/login', (req: Request, res: Response) => {
  void (async (): Promise<void> => {
    try {
      const body = bodyOf(req);
      const email = requiredString(body['email'], 'email').toLowerCase();
      const password = requiredString(body['password'], 'password');

      if (!transportIsAcceptable(req)) {
        await audit(req, { action: 'SIGN_IN', result: 'DENIED', reason: 'UNSAFE_TRANSPORT' });
        res.status(400).json({
          error:
            'This Brain will not issue a session over an unencrypted connection. Use https.',
        });
        return;
      }

      const key = attemptKey(req, email);
      if (throttled(key)) {
        await audit(req, {
          action: 'SIGN_IN',
          result: 'DENIED',
          reason: 'INVALID_CREDENTIALS',
          metadata: { throttled: true },
        });
        res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
        return;
      }

      const found = await getPasswordVerifierByEmail(email);
      // The password is verified even when there is no such user, against a
      // verifier that cannot match. Skipping it would make an unknown address
      // answer measurably faster than a known one, which is a way to enumerate
      // who has an account here.
      const verifierToTest =
        found?.verifier ?? 'scrypt$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';
      const matches = await verifyPassword(password, verifierToTest);

      if (!found || !matches || found.user.disabled) {
        recordFailure(key);
        await audit(req, {
          action: 'SIGN_IN',
          result: 'DENIED',
          actorId: found?.user.id ?? null,
          reason: found?.user.disabled ? 'PRINCIPAL_DISABLED' : 'INVALID_CREDENTIALS',
          metadata: { attempted: email },
        });
        res.status(401).json({ error: REFUSED });
        return;
      }

      clearFailures(key);
      const token = generateSessionToken();
      const session = await createSession({
        userId: found.user.id,
        secret: token.secret,
        ttlMs: SESSION_TTL_MS,
        userAgent: req.header('user-agent') ?? null,
        ip: req.ip ?? null,
      });

      await audit(req, {
        action: 'SIGN_IN',
        result: 'SUCCESS',
        actorType: 'HUMAN',
        actorId: found.user.id,
        credentialId: session.sessionId,
      });

      res.setHeader(
        'Set-Cookie',
        sessionCookie(token.secret, {
          secure: isSecureRequest(req),
          maxAgeMs: SESSION_TTL_MS,
        }),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ user: publicUser(found.user), expiresAt: session.expiresAt });
    } catch (error) {
      // A validation failure from `requiredString` already knows its status and
      // already says something safe; anything else does not get to explain
      // itself, because inside authentication an unexpected error is exactly
      // where a message would leak how the check works.
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('[brain] sign-in failed:', error);
      // Fail closed: an error inside authentication is a refusal, not a pass.
      res.status(503).json({ error: 'Sign-in is unavailable right now.' });
    }
  })();
});

authRouter.post(
  '/auth/logout',
  handler(async (req, res) => {
    const principal = currentPrincipal();
    if (principal && principal.authMethod === 'SESSION_COOKIE') {
      await revokeSession(principal.credentialId);
      await audit(req, {
        action: 'SIGN_OUT',
        result: 'SUCCESS',
        actorType: 'HUMAN',
        actorId: principal.id,
        credentialId: principal.credentialId,
      });
    }
    res.setHeader('Set-Cookie', clearedSessionCookie({ secure: isSecureRequest(req) }));
    res.setHeader('Cache-Control', 'no-store');
    return { ok: true };
  }),
);

/** The principal as the server sees it, for the client's own bookkeeping. */
authRouter.get(
  '/auth/me',
  handler(async () => {
    const principal = currentPrincipal();
    if (!principal) throw badRequest('Not signed in.');
    return {
      principal: {
        type: principal.type,
        id: principal.id,
        handle: principal.handle,
        displayName: principal.displayName,
        isBrainAdmin: principal.isBrainAdmin,
        mustChangePassword: principal.mustChangePassword,
        authMethod: principal.authMethod,
        memberships: principal.memberships.map((m) => ({
          projectId: m.projectId,
          role: m.role,
          scopes: m.scopes,
        })),
      },
      liveSessions:
        principal.type === 'HUMAN' ? await countLiveSessions(principal.id) : 0,
    };
  }),
);

/**
 * Change a password.
 *
 * The current one is required even though the caller is already signed in: a
 * session left open on a shared machine should not be enough to lock its owner
 * out of their own Brain.
 *
 * Every other session that person holds ends here — that is the point of
 * changing it — and this one survives, because being signed out of the tab you
 * just used is confusing enough that people avoid the operation.
 */
authRouter.post(
  '/auth/password',
  handler(async (req) => {
    const principal = currentPrincipal();
    if (!principal || principal.type !== 'HUMAN') throw badRequest('Not signed in.');

    const body = bodyOf(req);
    const currentPassword = requiredString(body['currentPassword'], 'currentPassword');
    const newPassword = requiredString(body['newPassword'], 'newPassword');

    const found = await getPasswordVerifierByEmail(principal.handle);
    if (!found || !(await verifyPassword(currentPassword, found.verifier))) {
      await audit(req, {
        action: 'CHANGE_PASSWORD',
        result: 'DENIED',
        actorType: 'HUMAN',
        actorId: principal.id,
        credentialId: principal.credentialId,
        reason: 'INVALID_CREDENTIALS',
      });
      throw badRequest(REFUSED);
    }
    if (newPassword === currentPassword) {
      throw badRequest('The new password must be different from the current one.');
    }

    try {
      await setUserPassword(principal.id, newPassword, {
        mustChangePassword: false,
        keepSessionId: principal.credentialId,
      });
    } catch (error) {
      if (error instanceof WeakPasswordError) throw badRequest(error.message);
      throw error;
    }

    await audit(req, {
      action: 'CHANGE_PASSWORD',
      result: 'SUCCESS',
      actorType: 'HUMAN',
      actorId: principal.id,
      credentialId: principal.credentialId,
      metadata: { minimumLength: MIN_PASSWORD_LENGTH },
    });
    return { ok: true };
  }),
);
