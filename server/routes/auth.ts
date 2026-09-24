/**
 * The password door, signing out, and changing a password.
 *
 * ---------------------------------------------------------------------------
 * This is no longer how a person signs in
 * ---------------------------------------------------------------------------
 *
 * `POST /api/auth/login` used to be *the* human door and is now the
 * break-glass one. A person signs in with a device, at
 * `/api/auth/passkey/verify`; nothing the ordinary client renders calls this
 * route, and the screen it used to live on has no address field and no password
 * field on it at all.
 *
 * What still arrives here, and why the route is not simply gone:
 *
 *   * **the hosted verification identities**, which `scripts/verify-hosted.ts`
 *     creates as `kind = 'SYSTEM'` on every deploy and signs in as over the
 *     real edge — machinery proving itself, with no device and never one;
 *   * **an account that has no working device yet**, which on the live Brain
 *     means the owner until the first time a passkey signs them in;
 *   * **an emergency**, when `BRAIN_BREAK_GLASS` is armed in the deployment's
 *     own secrets.
 *
 * `passwordDoor.ts` holds the rule that decides between them and the reasoning
 * behind it. Here there is one thing worth saying about *where* the check sits:
 * it is applied **after** the password has been verified, so a closed door and
 * a wrong password take the same time and produce the same body. Checking it
 * first would answer faster for an account that holds a device than for one
 * that does not, which is a way to learn who has enrolled.
 *
 * ---------------------------------------------------------------------------
 *
 * Every refusal here is the same refusal: a wrong password, an unknown address,
 * a disabled account, a closed door and an expired session all produce one
 * sentence and one status code. The differences between them are exactly what
 * somebody probing would like to learn, and there is no benefit to a legitimate
 * user in being told which of the five it was — they will try the same thing
 * either way.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { recordIdentityEvent } from '../repos/identity.ts';
import {
  clearPinThrottle,
  countLiveSessions,
  createSession,
  getPasswordVerifierByEmail,
  getPinCredentialByIdentity,
  getUser,
  readPinThrottle,
  recordPinFailure,
  revokeSession,
  setUserPassword,
  setUserPin,
} from '../repos/identity.ts';
import {
  DEVICE_SESSION_TTL_MS,
  PASSWORD_SESSION_TTL_MS,
  clearedSessionCookie,
  isSecureRequest,
  sessionCookie,
} from '../services/identity/authenticate.ts';
import {
  PASSWORD_DOOR_REFUSED,
  breakGlassArmed,
  passwordDoorOpenFor,
} from '../services/identity/passwordDoor.ts';
import {
  PIN_LENGTH,
  PIN_MALFORMED,
  PIN_REFUSED,
  UNMATCHABLE_PIN_VERIFIER,
  cooldownAfter,
  hashPin,
  isWellFormedPin,
  pinMatches,
} from '../services/identity/pin.ts';
import {
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  generateSessionToken,
  verifyPassword,
} from '../services/identity/secrets.ts';
import { currentContext, currentPrincipal } from '../services/identity/context.ts';
import { personName } from '../domain/personName.ts';
import { activeDatabaseConfig } from '../db/database.ts';
import { HttpError, badRequest, bodyOf, handler, requiredString } from './helpers.ts';
import { answerEscapedFailure } from './escape.ts';

export const authRouter = Router();

/**
 * One sentence for every way of failing to sign in.
 *
 * It lives in `passwordDoor.ts` now, beside the rule that produces most of the
 * refusals, so that a door that is closed and a password that is wrong cannot
 * drift into saying two different things.
 */
const REFUSED = PASSWORD_DOOR_REFUSED;

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
  email: string | null;
  displayName: string;
  isBrainAdmin: boolean;
  mustChangePassword: boolean;
  pinUpdatedAt?: string | null;
}): Record<string, unknown> {
  return {
    id: user.id,
    /*
     * The address stays, and it is not the identity.
     *
     * It is how this account signs in through the break-glass door and how a
     * person is contacted, so removing it would take a real fact off a screen
     * that has a reason to show it. What changed is that it is no longer what
     * the product *calls* anybody: `displayName` below is the name, and it is
     * never an address, whatever the row happens to hold.
     */
    email: user.email,
    displayName: personName(user),
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: user.mustChangePassword,
    /*
     * Whether a PIN exists, never the PIN and never its verifier.
     *
     * The recovery screen needs it to say *create* or *replace*, and the
     * client needs it to know whether signing in is possible yet. A boolean
     * rather than the timestamp: when it was set is nobody's business but the
     * account's, and this object is what a browser gets.
     */
    hasPin: (user.pinUpdatedAt ?? null) !== null,
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
  (async (): Promise<void> => {
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

      /*
       * The door, asked after the password rather than before it.
       *
       * An account that holds a working device does not get in here however
       * right its password is — and it is refused in the same words, with the
       * same status, after the same work, as one whose password was wrong. The
       * category is on the audit row, which is where a distinction belongs.
       */
      const doorOpen = found ? await passwordDoorOpenFor(found.user.id) : true;

      if (!found || !matches || found.user.disabled || !doorOpen) {
        recordFailure(key);
        await audit(req, {
          action: 'SIGN_IN',
          result: 'DENIED',
          actorId: found?.user.id ?? null,
          reason: found?.user.disabled ? 'PRINCIPAL_DISABLED' : 'INVALID_CREDENTIALS',
          metadata: {
            attempted: email,
            ...(found && matches && !found.user.disabled && !doorOpen
              ? { category: 'PASSWORD_DOOR_CLOSED' }
              : {}),
          },
        });
        res.status(401).json({ error: REFUSED });
        return;
      }

      clearFailures(key);
      const token = generateSessionToken();
      const session = await createSession({
        userId: found.user.id,
        secret: token.secret,
        ttlMs: PASSWORD_SESSION_TTL_MS,
        userAgent: req.header('user-agent') ?? null,
        ip: req.ip ?? null,
        // No device opened this one, and saying so is what keeps it out of
        // reach of a per-device revocation that could not honestly reach it.
        passkeyId: null,
      });

      await audit(req, {
        action: 'SIGN_IN',
        result: 'SUCCESS',
        actorType: 'HUMAN',
        actorId: found.user.id,
        credentialId: session.sessionId,
        // Which door, and whether the emergency switch was what opened it.
        // "Recovery use must be auditable" is this line.
        metadata: { door: 'PASSWORD', breakGlass: breakGlassArmed() },
      });

      res.setHeader(
        'Set-Cookie',
        sessionCookie(token.secret, {
          secure: isSecureRequest(req),
          maxAgeMs: PASSWORD_SESSION_TTL_MS,
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
  })().catch(answerEscapedFailure(res, 'auth'));
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

    // A passkey-only account has no address and no password, so there is
    // nothing here to change. It takes the same refusal a wrong current
    // password takes, for this file's own reason: the differences between the
    // ways of failing are what somebody probing would like to learn.
    const found = principal.handle
      ? await getPasswordVerifierByEmail(principal.handle)
      : null;
    /*
     * The same door, at the same account.
     *
     * Somebody whose device works does not get to set or rotate a password
     * from an ordinary session — which is a real property rather than tidiness:
     * without it, a session in the wrong hands could write a credential that
     * outlives every device revocation aimed at it. Rotating a break-glass
     * password is still possible, with break-glass armed, which is the same
     * deliberate act that makes it usable at all.
     */
    const doorOpen = await passwordDoorOpenFor(principal.id);
    if (!doorOpen || !found || !(await verifyPassword(currentPassword, found.verifier))) {
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

/* --------------------------------------------------------------- the PIN */

/**
 * Sign in with an identity and a six-digit PIN.
 *
 * This is the ordinary human door. It is on the guard's unauthenticated
 * allowlist for `/api/auth/login`'s exact reason — it is how a credential is
 * obtained — and it is written to give nothing away:
 *
 *   * **The work is the same whatever fails.** An unknown identity, an account
 *     with no PIN and a wrong PIN all run one scrypt verification, against the
 *     real verifier or against one that cannot match. Skipping it for the first
 *     two would make them answer measurably faster, which enumerates who has an
 *     account and who has set a PIN.
 *   * **The refusal is one body.** `PIN_REFUSED`, for all of them.
 *   * **A cooldown is the one thing it does say**, because that is a fact about
 *     this caller's own recent attempts rather than about the account, and
 *     somebody who has mistyped their own PIN four times is owed the reason
 *     they are being made to wait. It names no identity and no remaining count.
 *
 * The session it opens is the **persistent** one — thirty days, the same
 * `DEVICE_SESSION_TTL_MS` a passkey earns. The credential is different; how
 * long a person should stay signed in to their own Brain is not.
 */
authRouter.post('/auth/pin', (req: Request, res: Response) => {
  (async (): Promise<void> => {
    try {
      const body = bodyOf(req);
      const identity = requiredString(body['identity'], 'identity');
      const pin = body['pin'];

      if (!transportIsAcceptable(req)) {
        await audit(req, { action: 'PIN_SIGN_IN', result: 'DENIED', reason: 'UNSAFE_TRANSPORT' });
        res.status(400).json({
          error: 'This Brain will not issue a session over an unencrypted connection. Use https.',
        });
        return;
      }

      /*
       * Malformed is its own answer, and deliberately not the refusal.
       *
       * It reveals nothing — the rule is printed on the screen above the box —
       * and telling somebody who typed five digits that their PIN is wrong is
       * how they burn their own attempts on a typo.
       */
      if (!isWellFormedPin(pin)) {
        res.status(400).json({ error: PIN_MALFORMED });
        return;
      }

      const lookup = await getPinCredentialByIdentity(identity);
      const found = lookup.outcome === 'FOUND' ? lookup : null;

      /*
       * An identity two live accounts answer to.
       *
       * The caller is told nothing that a wrong PIN would not tell them, and
       * the same scrypt verification below runs against the unmatchable
       * verifier, so it costs the same and reveals the same. What is different
       * is the **audit row**: this is a condition only an administrator can
       * correct, and a category that could not name it would leave the one
       * reader who can fix it with nothing to read. `peopleReading` names it
       * too, on the surface where the rename lives.
       */
      if (lookup.outcome === 'AMBIGUOUS') {
        await pinMatches(pin, UNMATCHABLE_PIN_VERIFIER);
        await audit(req, {
          action: 'PIN_SIGN_IN',
          result: 'DENIED',
          reason: 'INVALID_CREDENTIALS',
          metadata: { category: 'AMBIGUOUS_IDENTITY', candidates: String(lookup.candidates) },
        });
        res.status(401).json({ error: PIN_REFUSED });
        return;
      }

      /*
       * The cooldown, read from rows — and answered in exactly the same words
       * as every other refusal.
       *
       * This used to answer `429` with a `retryAt`, and the reasoning beside
       * it was careful: that is a fact about *this caller's own recent
       * attempts*, it names no identity, and the test asserted the address
       * does not appear in the body. All of that was true, and it checked the
       * wrong thing. **The branch is reachable only when the identity
       * resolves**, so its mere existence says the account is real — and the
       * sign-in names in this Brain are people's first names. Three wrong
       * guesses separated a member from an invention, which is precisely the
       * enumeration `UNMATCHABLE_PIN_VERIFIER` and the single refusal sentence
       * exist to prevent. The constant's own doc says *one sentence for every
       * way of failing*, and this was a second one.
       *
       * The verification is spent anyway, which reverses the note that used to
       * be here about not spending the scrypt budget on a locked-out caller.
       * That protects nothing: an unknown identity already costs the same
       * ~60ms against the unmatchable verifier, so an attacker who wants to
       * burn CPU simply varies the name — while the saving made a locked-out
       * account answer *faster* than an unknown one, which is the same oracle
       * arriving as timing rather than as a status code.
       *
       * The distinction is kept where §32 says a distinction belongs: the
       * audit row, which an administrator reads and a caller never sees.
       */
      let coolingOff = false;
      if (found) {
        const throttle = await readPinThrottle(found.user.id);
        coolingOff =
          throttle.lockedUntil !== null && throttle.lockedUntil > new Date().toISOString();
      }

      const matches = await pinMatches(pin, found?.verifier ?? UNMATCHABLE_PIN_VERIFIER);

      if (coolingOff && found) {
        await audit(req, {
          action: 'PIN_SIGN_IN',
          result: 'DENIED',
          actorId: found.user.id,
          reason: 'INVALID_CREDENTIALS',
          metadata: { category: 'COOLDOWN' },
        });
        res.status(401).json({ error: PIN_REFUSED });
        return;
      }

      if (!found || !found.verifier || !matches || found.user.disabled) {
        if (found) await recordPinFailure(found.user.id, cooldownAfter);
        await audit(req, {
          action: 'PIN_SIGN_IN',
          result: 'DENIED',
          actorId: found?.user.id ?? null,
          reason: found?.user.disabled ? 'PRINCIPAL_DISABLED' : 'INVALID_CREDENTIALS',
          // The category, never what was typed. §17's rule about denial records.
          metadata: {
            category: !found
              ? 'NO_SUCH_IDENTITY'
              : found.user.disabled
                ? 'ACCOUNT_DISABLED'
                : !found.verifier
                  ? 'NO_PIN_SET'
                  : 'WRONG_PIN',
          },
        });
        res.status(401).json({ error: PIN_REFUSED });
        return;
      }

      await clearPinThrottle(found.user.id);
      const token = generateSessionToken();
      const session = await createSession({
        userId: found.user.id,
        secret: token.secret,
        ttlMs: DEVICE_SESSION_TTL_MS,
        userAgent: req.header('user-agent') ?? null,
        ip: req.ip ?? null,
        // No device opened this one. Null keeps it out of reach of a per-device
        // revocation that could not honestly reach it.
        passkeyId: null,
      });

      await audit(req, {
        action: 'PIN_SIGN_IN',
        result: 'SUCCESS',
        actorType: 'HUMAN',
        actorId: found.user.id,
        credentialId: session.sessionId,
      });

      res.setHeader(
        'Set-Cookie',
        sessionCookie(token.secret, {
          secure: isSecureRequest(req),
          maxAgeMs: DEVICE_SESSION_TTL_MS,
        }),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ user: publicUser(found.user), expiresAt: session.expiresAt });
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('[brain] PIN sign-in failed:', error);
      // Fail closed: an error inside authentication is a refusal, not a pass.
      res.status(503).json({ error: 'Sign-in is unavailable right now.' });
    }
  })().catch(answerEscapedFailure(res, 'auth'));
});

/**
 * Set or replace your own PIN.
 *
 * Authenticated, by whatever got the caller here — the recovery screen's
 * password session, or an ordinary PIN session changing it. It never takes an
 * identity from the body: the account is the principal, so there is no shape of
 * this request that could set somebody else's.
 *
 * Every other session that person holds ends, and the current one survives.
 * That is `setUserPassword`'s rule for `setUserPassword`'s reason: replacing a
 * credential is what somebody does when they think the old one may be in the
 * wrong hands, and being signed out of the tab you are typing in is the
 * friction that stops people doing it at all.
 */
authRouter.post(
  '/auth/pin/set',
  handler(async (req) => {
    const principal = currentPrincipal();
    if (!principal || principal.type !== 'HUMAN') throw badRequest('Not signed in.');

    const pin = bodyOf(req)['pin'];
    if (!isWellFormedPin(pin)) throw badRequest(PIN_MALFORMED);

    await setUserPin(principal.id, await hashPin(pin), {
      keepSessionId: principal.credentialId,
    });

    await audit(req, {
      action: 'SET_PIN',
      result: 'SUCCESS',
      actorType: 'HUMAN',
      actorId: principal.id,
      credentialId: principal.credentialId,
      // That it happened and when. Never the value, never its length beyond the
      // rule everybody already knows, and never the verifier.
      metadata: { digits: PIN_LENGTH },
    });
    return { ok: true };
  }),
);
