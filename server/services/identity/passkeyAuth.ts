/**
 * Signing in with a device, and adding another one.
 *
 * The relying party is derived from the request rather than configured, the
 * same way `issuerFor` derives the OAuth issuer and for the same reason: a
 * hard-coded origin is wrong in exactly the environments that matter, and a
 * WebAuthn credential is bound to the origin it was made for — so getting this
 * from configuration would mean a credential that silently stops working when
 * the deployment moves.
 *
 * Challenges are server-side rows, taken once. A challenge held in a cookie or
 * echoed back by the client is a number the caller supplies, which is the one
 * property every compare-and-swap in this codebase exists to avoid.
 */
import {
  livePasskeyByCredential,
  notePasskeyUsed,
  rememberChallenge,
  takeChallenge,
} from '../../repos/passkeys.ts';
import { getUser, recordIdentityEvent } from '../../repos/identity.ts';
import { nowIso } from '../../repos/util.ts';
import { SUPPORTED_ALGORITHMS, bufferToBase64url, verifyAssertion } from './webauthn.ts';
import { randomBytes } from 'node:crypto';
import type { User } from '../../domain/types.ts';

/** Long enough for a person to find their phone, short enough to be useless later. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** One refusal, whatever went wrong. */
export const SIGN_IN_REFUSED = 'That did not sign you in. Try again, or ask for a recovery link.';

export interface RelyingParty {
  /** The bare hostname. A credential is bound to this. */
  id: string;
  /** The full origin, scheme included. Compared byte for byte. */
  origin: string;
}

/**
 * The relying party for this request.
 *
 * Refuses anything that is not a plain https origin, because a credential made
 * against one is only usable against the same one — and a Brain reached over a
 * proxy that rewrote the host would otherwise register credentials nobody can
 * ever use again.
 */
export function relyingPartyFrom(issuer: string): RelyingParty | null {
  try {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
    return { id: url.hostname, origin: url.origin };
  } catch {
    return null;
  }
}

function newChallenge(): string {
  return bufferToBase64url(randomBytes(32));
}

/** What the browser needs to create a credential. Records the challenge first. */
export async function registrationOptions(input: {
  /**
   * What the authenticator stores as the user handle. The Brain's own id for a
   * member adding a device; for an enrollment it is deliberately *not* the
   * slot's id, which must not reach a browser before the link is spent.
   */
  userHandle: string;
  displayName: string;
  rp: RelyingParty;
  /**
   * The account this challenge belongs to, or null during enrollment.
   *
   * Null rather than a made-up string because the column is a real foreign key:
   * a challenge either names an account that exists or names none, and the link
   * is what binds an enrollment anyway.
   */
  boundTo: string | null;
}): Promise<Record<string, unknown>> {
  const challenge = newChallenge();
  await rememberChallenge({
    challenge,
    purpose: 'REGISTER',
    userId: input.boundTo,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });
  return {
    challenge,
    rp: { id: input.rp.id, name: 'Brain' },
    user: {
      // The Brain's own id, never an email — there is not one.
      id: Buffer.from(input.userHandle, 'utf8').toString('base64url'),
      name: input.displayName,
      displayName: input.displayName,
    },
    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    /*
     * A platform authenticator that verifies the person, and a resident key so
     * signing in needs no identifier typed first. `attestation: none` because
     * which make of device it is, is not this Brain's business.
     */
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    attestation: 'none',
    timeout: CHALLENGE_TTL_MS,
  };
}

/** What the browser needs to sign in. No credential list: the passkey names itself. */
export async function authenticationOptions(rp: RelyingParty): Promise<Record<string, unknown>> {
  const challenge = newChallenge();
  await rememberChallenge({
    challenge,
    purpose: 'AUTHENTICATE',
    userId: null,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });
  return {
    challenge,
    rpId: rp.id,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  };
}

export type SignInOutcome =
  /** The device that answered, so the session can record what opened it. */
  | { ok: true; user: User; passkeyId: string }
  | { ok: false; reason: string };

/**
 * Verify an assertion and say who it was.
 *
 * Every failure returns the same sentence. Which condition failed — unknown
 * credential, stale challenge, bad signature, disabled account — is recorded as
 * a *category* on the audit row and never told to the caller, because the
 * difference between "no such credential" and "that credential is disabled" is
 * an oracle.
 */
export async function signInWithPasskey(input: {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  challenge: string;
  rp: RelyingParty;
}): Promise<SignInOutcome> {
  const now = nowIso();

  /*
   * Taken before anything is verified, so one intercepted assertion cannot be
   * replayed even against a signature that would otherwise check out.
   */
  if (!(await takeChallenge({ challenge: input.challenge, purpose: 'AUTHENTICATE', now }))) {
    await denied('UNKNOWN_OR_STALE_CHALLENGE', null);
    return { ok: false, reason: SIGN_IN_REFUSED };
  }

  const passkey = await livePasskeyByCredential(input.credentialId);
  if (!passkey) {
    await denied('NO_SUCH_CREDENTIAL', null);
    return { ok: false, reason: SIGN_IN_REFUSED };
  }

  const verified = verifyAssertion({
    clientDataJSON: input.clientDataJSON,
    authenticatorData: input.authenticatorData,
    signature: input.signature,
    expectedChallenge: input.challenge,
    expectedOrigin: input.rp.origin,
    expectedRpId: input.rp.id,
    storedPublicKey: passkey.publicKey,
    storedAlgorithm: passkey.algorithm,
    storedSignCount: passkey.signCount,
  });
  if (!verified.ok) {
    await denied('ASSERTION_REFUSED', passkey.userId);
    return { ok: false, reason: SIGN_IN_REFUSED };
  }

  const user = await getUser(passkey.userId);
  if (!user || user.disabledAt) {
    await denied('ACCOUNT_UNAVAILABLE', passkey.userId);
    return { ok: false, reason: SIGN_IN_REFUSED };
  }

  await notePasskeyUsed({ id: passkey.id, signCount: verified.value.signCount });
  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: user.id,
    action: 'PASSKEY_SIGN_IN',
    targetType: 'USER',
    targetId: user.id,
    projectId: null,
    result: 'SUCCESS',
    metadata: { passkeyId: passkey.id },
  });
  return { ok: true, user, passkeyId: passkey.id };
}

async function denied(category: string, userId: string | null): Promise<void> {
  await recordIdentityEvent({
    actorType: userId ? 'HUMAN' : 'ANONYMOUS',
    actorId: userId,
    action: 'PASSKEY_SIGN_IN',
    targetType: 'USER',
    targetId: userId ?? 'unknown',
    projectId: null,
    result: 'DENIED',
    // The category, never what was presented. §17's rule about denial records.
    metadata: { category },
  });
}
