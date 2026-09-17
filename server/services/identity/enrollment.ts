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
  createEnrollment,
  enrollmentByPrefix,
  getEnrollment,
  revokeAllPasskeys,
  revokeEnrollment,
  spendEnrollment,
} from '../../repos/passkeys.ts';
import { getUser, recordIdentityEvent } from '../../repos/identity.ts';
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

  const id = newId('usr');
  const at = nowIso();
  /*
   * Written directly rather than through `createUser`, which requires an email
   * and a password. Those columns are nullable now and this is the row shape
   * that makes the whole feature true: no address to reset, no verifier to
   * compare, so there is no password login to disable later.
   */
  await getDb().run(
    `INSERT INTO users (id, email, display_name, password_algorithm, password_verifier,
                        password_updated_at, must_change_password, is_brain_admin, disabled_at,
                        created_by_type, created_by_id, created_at, updated_at)
     VALUES (?, NULL, ?, NULL, NULL, NULL, 0, 0, NULL, 'HUMAN', ?, ?, ?)`,
    [id, displayName, input.issuedByUserId, at, at],
  );

  const link = await issueLink({
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

async function issueLink(input: {
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

  const link = await issueLink({
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
    metadata: { enrollmentId: link.enrollmentId, retiredCredentials: String(retired) },
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

export type CompleteOutcome =
  | { ok: true; user: User; passkeyId: string }
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
