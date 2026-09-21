/**
 * Bringing a person in with a device, and getting them back in after losing one.
 *
 * ---------------------------------------------------------------------------
 * What the link is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * An administrator decides who is being invited and what they will be called,
 * and the slot is created with that decision on it. The link is bound to that
 * slot. So the person opening it chooses neither their identity nor their
 * authority — exactly the property `invitations.ts` already has, and for the
 * same reason: a link that let its holder pick a role would be a way to grant
 * yourself access.
 *
 * The token is shown once at issue and stored as a prefix and a sha-256 digest.
 * It is found by the indexed prefix and compared in constant time, and it is
 * spent by a **single guarded UPDATE** carrying every condition that makes it
 * valid — unused, unrevoked, unexpired. Two requests holding one intercepted
 * link cannot both come away with a device registered.
 *
 * ---------------------------------------------------------------------------
 * No email, no password, and no way back to either
 * ---------------------------------------------------------------------------
 *
 * A member slot is created with no address and no verifier. There is nothing to
 * send a reset to and nothing to compare a password against, which is what
 * makes "passkey-only" a property of the row rather than a policy somebody
 * could forget to apply.
 *
 * Recovery is therefore an administrator issuing a second link, and issuing one
 * **retires the lost credential in the same operation**. A recovery that left
 * the old device live would be a second way in beside the one that was lost,
 * which is the opposite of recovering from a loss.
 *
 * Absent, malformed, expired, spent and revoked are **one refusal with one
 * body**, naming the remedy rather than the reason — invariant 23 at a door
 * where the thing being refused is a secret somebody may be holding perfectly
 * legitimately.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso } from '../../repos/util.ts';
import {
  addPasskey,
  countLivePasskeys,
  createEnrollment,
  enrollmentByPrefix,
  getEnrollment,
  revokeAllPasskeys,
  revokeEnrollment,
  revokeEnrollmentsForUser,
  spendEnrollment,
} from '../../repos/passkeys.ts';
import {
  createCredentiallessUser,
  getUser,
  recordIdentityEvent,
  revokeSessionsForUser,
  setUserPin,
  clearUserPin,
  signInNameTaken,
} from '../../repos/identity.ts';
import { constantTimeEquals, digestSecret, generateInvitationToken, parseInvitationToken } from './secrets.ts';
import type { MemberEnrollment, User } from '../../domain/types.ts';

/**
 * How long a link lives.
 *
 * Short, because it is sent through a channel Brain does not control and its
 * whole value to somebody else is the window before it is used. Long enough
 * that a person in another timezone can open it after a night's sleep.
 */
export const ENROLLMENT_TTL_MS = 48 * 60 * 60 * 1000;

/** One refusal for every way a link can fail to be usable. */
export const LINK_REFUSED =
  'This enrollment link cannot be used. Ask the person who sent it for a new one.';

/**
 * A name that would not be this person's alone.
 *
 * Its own class so the route can answer 422 — *understood, and refused on its
 * merits* — rather than the 500 a bare `Error` would become. An administrator
 * being told to pick another name is an ordinary outcome, not a fault.
 */
export class NameAlreadyInUseError extends Error {}

/**
 * A first link asked for by somebody who is not on their first link.
 *
 * Its own class so the route answers 422 rather than the 500 a bare `Error`
 * becomes, and so the sentence can name recovery — which is the operation they
 * actually want.
 */
export class AlreadyHasCredentialError extends Error {}

export interface IssuedLink {
  enrollmentId: string;
  userId: string;
  displayName: string;
  /** Shown once. Never stored, never recoverable, never logged. */
  token: string;
  expiresAt: string;
}

/**
 * Create a member slot with no credential of any kind, and a link to fill it.
 *
 * The slot is a real `users` row from the start rather than something that
 * springs into existence on acceptance, so the administrator can see who they
 * have invited, revoke before use, and reissue — and so a half-finished
 * enrollment is a visible slot rather than nothing at all.
 */
export async function createMemberSlot(input: {
  displayName: string;
  issuedByUserId: string;
}): Promise<IssuedLink> {
  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw new Error('A member needs a name to be shown as.');

  /*
   * The name is the credential's other half, so it has to be theirs alone.
   *
   * A member enrolled from a link holds no address, so this name is the only
   * thing they can type at the sign-in screen — and `getPinCredentialByIdentity`
   * refuses a name two live accounts answer to, with the same sentence a wrong
   * PIN gets. Issuing a second slot under a name somebody already signs in with
   * therefore locks **both** of them out, silently, and the likeliest way to do
   * it is the most ordinary one: re-inviting somebody whose first link expired.
   *
   * Refused here, where it is cheap and where the person choosing the name is
   * the person who can choose another. The sentence names the remedy rather
   * than the row, because the remedy is the only part they can act on.
   */
  if (await signInNameTaken(displayName)) {
    throw new NameAlreadyInUseError(
      'Somebody already signs in with that name. Give this person a name that tells them ' +
        'apart — a surname, or an initial — because the name is how they sign in.',
    );
  }

  /*
   * Not `createUser`, which requires an email and a password. This is the row
   * shape that makes the whole feature true: no address to reset, no verifier
   * to compare, so there is no password login to disable later. It is written
   * by `createCredentiallessUser` rather than here, because the project
   * invitation produces the same shape and two copies of one `INSERT` is how
   * they come to differ.
   */
  const slot = await createCredentiallessUser({
    email: null,
    displayName,
    createdByType: 'HUMAN',
    createdById: input.issuedByUserId,
  });
  const id = slot.id;

  const link = await issueEnrollmentLink({
    userId: id,
    displayName,
    kind: 'ENROLLMENT',
    issuedByUserId: input.issuedByUserId,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.issuedByUserId,
    action: 'CREATE_MEMBER_SLOT',
    targetType: 'USER',
    targetId: id,
    projectId: null,
    result: 'SUCCESS',
    // The enrollment's id. Never the token, never the prefix.
    metadata: { enrollmentId: link.enrollmentId, displayName },
  });

  return link;
}

/**
 * A link for a person who already has a slot.
 *
 * Exported because the project invitation needs exactly this and nothing else:
 * it has just made the slot itself, and what it owes the person standing in
 * front of it is the one link that turns a slot into an account they can use.
 */
export async function issueEnrollmentLink(input: {
  userId: string;
  displayName: string;
  kind: MemberEnrollment['kind'];
  issuedByUserId: string;
}): Promise<IssuedLink> {
  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
  const enrollment = await createEnrollment({
    userId: input.userId,
    displayName: input.displayName,
    kind: input.kind,
    tokenPrefix: token.prefix,
    tokenDigest: token.digest,
    issuedByUserId: input.issuedByUserId,
    expiresAt,
  });
  return {
    enrollmentId: enrollment.id,
    userId: input.userId,
    displayName: input.displayName,
    token: token.plaintext,
    expiresAt,
  };
}

/**
 * A second link for somebody who lost their device.
 *
 * Retiring every live credential first is the load-bearing half. A recovery
 * link issued beside a credential that still works is not a recovery, it is a
 * second door — and if the device was lost because somebody else has it, the
 * whole point is that it stops working.
 */
/**
 * Another link for a slot that has never been filled.
 *
 * ---------------------------------------------------------------------------
 * The gap this closes, which the uniqueness guard turned from awkward to
 * blocking
 * ---------------------------------------------------------------------------
 *
 * A member slot whose link expired, or was withdrawn, or was simply never
 * opened, holds no credential and no live enrollment. `createMemberSlot` makes
 * a *new row*, `issueRecovery` is for somebody who had something and lost it,
 * and nothing issued a second first link — so the administrator's only route
 * was to invite that person again, which made a second account under the same
 * name and left two rows where there is one person.
 *
 * That was always wrong and it was survivable, because the duplicate resolved
 * by luck. It is not survivable now: §43's guard refuses the second invitation
 * outright, correctly, and without this there is no third thing to try. An
 * escalation whose only remedy is refused is stuck rather than waiting, so the
 * remedy has to exist before the refusal is an improvement.
 *
 * It is **not** recovery and must not be called that. Recovery retires what
 * somebody is holding, which is right when a device may be in the wrong hands
 * and wrong — and frightening to read — for somebody who has never signed in
 * at all. This retires nothing, because there is nothing to retire: it is
 * refused outright for an account that holds any credential, and that refusal
 * is what keeps the two operations from becoming one with a flag.
 *
 * The previous outstanding link, if there is one, is withdrawn in the same
 * breath. Two live links for one slot is two ways in where the design says
 * one, and the person is about to be sent the newer one anyway.
 */
export async function reissueEnrollmentLink(input: {
  userId: string;
  issuedByUserId: string;
}): Promise<IssuedLink> {
  const user = await getUser(input.userId);
  if (!user) throw new Error('No such member.');

  /*
   * Any credential at all, and this is refused.
   *
   * A PIN, a password or a live device each mean this person has a way in, and
   * handing out a fresh first link to somebody who does is a second way in
   * that nobody asked for. Their remedy is recovery, which retires what they
   * hold first — which is the whole difference between the two.
   */
  const live = await countLivePasskeys(input.userId);
  if (user.pinUpdatedAt !== null || user.passwordUpdatedAt !== null || live > 0) {
    throw new AlreadyHasCredentialError(
      'That person already has a way to sign in. Use a recovery link instead — it takes what ' +
        'they are holding out of service first.',
    );
  }

  const withdrawn = await revokeEnrollmentsForUser(input.userId, 'Replaced by a newer link.');

  const link = await issueEnrollmentLink({
    userId: user.id,
    displayName: user.displayName,
    kind: 'ENROLLMENT',
    issuedByUserId: input.issuedByUserId,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.issuedByUserId,
    action: 'REISSUE_ENROLLMENT',
    targetType: 'USER',
    targetId: user.id,
    projectId: null,
    result: 'SUCCESS',
    // The enrollment's id and how many stale ones went with it. Never a token.
    metadata: { enrollmentId: link.enrollmentId, withdrew: String(withdrawn) },
  });

  return link;
}

export async function issueRecovery(input: {
  userId: string;
  reason: string;
  issuedByUserId: string;
}): Promise<IssuedLink> {
  const user = await getUser(input.userId);
  if (!user) throw new Error('No such member.');

  const retired = await revokeAllPasskeys({
    userId: input.userId,
    reason: input.reason,
    byUserId: input.issuedByUserId,
  });

  /*
   * And the PIN, which is the credential this Brain actually signs people in
   * with — so leaving it was leaving the door open while retiring the lock
   * nobody was using.
   *
   * `recoveryContract.ts` is where the classes a recovery must retire are
   * declared, and this is one of the three readers of that list. The reason it
   * had to become a list is that the original failure was *forgetting*: 078
   * added a credential class and nothing came back to this function, so the
   * recovery went on being correct about passkeys and silently incomplete
   * about the thing that opens the door. A class added to `CREDENTIAL_CLASSES`
   * and not retired here fails `tests/recoveryContract.test.ts`.
   *
   * It is retired **before** the link is issued, for the same ordering reason
   * the passkeys are: §32's rule is that a recovery stops the old credential
   * working *now* rather than when the replacement is redeemed, and an
   * unredeemed link otherwise leaves the old PIN live indefinitely.
   */
  const pinRetired = await clearUserPin(input.userId);

  /*
   * And every session those devices opened.
   *
   * Retiring the credentials and leaving the sessions is half a recovery: a
   * device session now lasts thirty days, so a lost phone with an open tab on
   * it would go on being signed in for weeks after the credential it holds
   * stopped working. All of them rather than the ones a device is recorded
   * against, because this is the case where nothing about what that person
   * holds can be trusted, and because the sessions written before a device was
   * recorded at all name none.
   */
  const endedSessions = await revokeSessionsForUser(input.userId, null);

  const link = await issueEnrollmentLink({
    userId: user.id,
    displayName: user.displayName,
    kind: 'RECOVERY',
    issuedByUserId: input.issuedByUserId,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.issuedByUserId,
    action: 'ISSUE_RECOVERY',
    targetType: 'USER',
    targetId: user.id,
    projectId: null,
    result: 'SUCCESS',
    metadata: {
      enrollmentId: link.enrollmentId,
      retiredCredentials: String(retired),
      // What was actually taken away, so an audit row can answer "was this
      // account still reachable afterwards" rather than only "a link was sent".
      retiredPin: String(pinRetired),
      endedSessions: String(endedSessions),
    },
  });

  return link;
}

export async function withdrawLink(input: {
  enrollmentId: string;
  reason: string;
  actorUserId: string;
}): Promise<boolean> {
  const done = await revokeEnrollment({ id: input.enrollmentId, reason: input.reason });
  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actorUserId,
    action: 'REVOKE_ENROLLMENT',
    targetType: 'USER',
    targetId: (await getEnrollment(input.enrollmentId))?.userId ?? input.enrollmentId,
    projectId: null,
    result: done ? 'SUCCESS' : 'DENIED',
    metadata: { enrollmentId: input.enrollmentId },
  });
  return done;
}

/**
 * Find the live enrollment a presented token names, or null.
 *
 * Null covers malformed, unknown, revoked, spent and expired without
 * distinguishing them, because the caller must not either.
 */
async function liveEnrollmentFor(token: unknown): Promise<MemberEnrollment | null> {
  if (typeof token !== 'string') return null;
  const parsed = parseInvitationToken(token);
  if (!parsed) return null;
  const enrollment = await enrollmentByPrefix(parsed.prefix);
  if (!enrollment) return null;
  if (!constantTimeEquals(enrollment.tokenDigest, digestSecret(parsed.secret))) return null;
  if (enrollment.usedAt || enrollment.revokedAt) return null;
  if (enrollment.expiresAt <= nowIso()) return null;
  return enrollment;
}

export type PreviewOutcome =
  | { ok: true; displayName: string; kind: MemberEnrollment['kind']; expiresAt: string }
  | { ok: false; reason: string };

/**
 * What the person is shown before they commit a device.
 *
 * The display name and nothing else: not the email (there is none), not the
 * role, not who issued it, not which other members exist. Enough to tell them
 * they have the right link, and nothing that would make an intercepted link a
 * reconnaissance tool.
 */
export async function previewEnrollment(token: unknown): Promise<PreviewOutcome> {
  const enrollment = await liveEnrollmentFor(token);
  if (!enrollment) return { ok: false, reason: LINK_REFUSED };
  return {
    ok: true,
    displayName: enrollment.displayName,
    kind: enrollment.kind,
    expiresAt: enrollment.expiresAt,
  };
}

/**
 * Spend the link and set a PIN, which is the ordinary way a member joins now.
 *
 * The same guarded spend as `completeEnrollment`, in the same order and for the
 * same reason: the claim comes first, so a second request holding one
 * intercepted link finds nothing to spend, and a crash between the two costs
 * the link rather than leaving it live beside a working credential.
 *
 * It exists because the device half could not be relied on. A member whose
 * browser refuses WebAuthn — which is the condition that locked the owner out
 * of this Brain — had no way to finish joining at all, and a journey whose last
 * step can be refused with no alternative is one that strands people.
 * Registering a device is still offered and is still optional.
 */
export async function completeEnrollmentWithPin(input: {
  token: unknown;
  pinVerifier: string;
}): Promise<CompleteOutcome> {
  const enrollment = await liveEnrollmentFor(input.token);
  if (!enrollment) return { ok: false, reason: LINK_REFUSED };

  if (!(await spendEnrollment({ id: enrollment.id, now: nowIso() }))) {
    return { ok: false, reason: LINK_REFUSED };
  }

  /*
   * No session is kept, because there is none yet: this is the link being
   * exchanged for a credential, and the route opens the session afterwards.
   * Passing `null` means any session the slot somehow held is ended, which is
   * the right answer for a recovery — the point of one is that what came
   * before stops working.
   */
  await setUserPin(enrollment.userId, input.pinVerifier, { keepSessionId: null });

  const user = await getUser(enrollment.userId);
  if (!user) return { ok: false, reason: LINK_REFUSED };

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: user.id,
    action: 'ENROLL_PIN',
    targetType: 'USER',
    targetId: user.id,
    projectId: null,
    result: 'SUCCESS',
    // The enrollment, never the PIN and never its verifier.
    metadata: { enrollmentId: enrollment.id, kind: enrollment.kind },
  });

  return { ok: true, user, passkeyId: null };
}

export type CompleteOutcome =
  /** `passkeyId` is null when the link was spent on a PIN rather than a device. */
  | { ok: true; user: User; passkeyId: string | null }
  | { ok: false; reason: string };

/**
 * Spend the link and register the device, in that order.
 *
 * The spend comes first and is a guarded UPDATE, so a second request holding
 * the same link finds nothing to spend. Registering after the claim means a
 * crash between them costs the link rather than leaving it live beside a
 * registered credential — the same way round `resolveMessage` and
 * `claimWriteback` put it, and for the same reason.
 */
export async function completeEnrollment(input: {
  token: unknown;
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  label: string;
}): Promise<CompleteOutcome> {
  const enrollment = await liveEnrollmentFor(input.token);
  if (!enrollment) return { ok: false, reason: LINK_REFUSED };

  if (!(await spendEnrollment({ id: enrollment.id, now: nowIso() }))) {
    return { ok: false, reason: LINK_REFUSED };
  }

  const passkey = await addPasskey({
    userId: enrollment.userId,
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    algorithm: input.algorithm,
    signCount: input.signCount,
    label: input.label,
    originKind: enrollment.kind === 'RECOVERY' ? 'RECOVERY' : 'ENROLLMENT',
  });
  if (!passkey) {
    /*
     * The credential is already registered somewhere. The link is spent and
     * stays spent: it was used, and telling the holder which account holds that
     * credential would be the oracle invariant 23 exists to prevent.
     */
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: enrollment.userId,
      action: 'ENROLL_PASSKEY',
      targetType: 'USER',
      targetId: enrollment.userId,
      projectId: null,
      result: 'DENIED',
      metadata: { enrollmentId: enrollment.id, category: 'CREDENTIAL_ALREADY_REGISTERED' },
    });
    return { ok: false, reason: LINK_REFUSED };
  }

  const user = await getUser(enrollment.userId);
  if (!user) return { ok: false, reason: LINK_REFUSED };

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: user.id,
    action: 'ENROLL_PASSKEY',
    targetType: 'USER',
    targetId: user.id,
    projectId: null,
    result: 'SUCCESS',
    metadata: { enrollmentId: enrollment.id, kind: enrollment.kind, passkeyId: passkey.id },
  });

  return { ok: true, user, passkeyId: passkey.id };
}
