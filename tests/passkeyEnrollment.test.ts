/**
 * Enrolling a member with a passkey, and the gate the count feeds.
 *
 * These are properties of stored state, so they run against a real database —
 * SQLite by default, Postgres when `BRAIN_TEST_DATABASE_URL` is set. "The link
 * cannot be used twice" is a claim about one guarded `UPDATE`, and a mock that
 * agreed with it would be agreeing with the test rather than with the database.
 *
 * The three properties worth naming, because each of them is the whole point of
 * a link rather than a password:
 *
 * **A link is spent once.** Two requests holding the same intercepted token
 * produce one passkey, and the loser is told the same sentence a fabricated
 * token gets.
 *
 * **A link is bound to its slot.** The display name, the account, and every
 * effect come from the enrollment's own row. Nothing the holder sends decides
 * who they turn out to be.
 *
 * **Recovery is not a second door.** Issuing one retires what was there, so a
 * device somebody else is holding stops working at the moment the replacement
 * is issued rather than at the moment the replacement is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject, teardown } from './helpers.ts';
import { authenticator } from './helpers/authenticator.ts';
import {
  LINK_REFUSED,
  completeEnrollment,
  createMemberSlot,
  issueRecovery,
  previewEnrollment,
  withdrawLink,
} from '../server/services/identity/enrollment.ts';
import {
  countLivePasskeys,
  listEnrollments,
  listPasskeys,
  livePasskeyByCredential,
} from '../server/repos/passkeys.ts';
import {
  createUser,
  getPasswordVerifierByEmail,
  getUser,
  listIdentityEvents,
} from '../server/repos/identity.ts';
import { cashReadiness } from '../server/services/cash/readiness.ts';
import { verifyRegistration } from '../server/services/identity/webauthn.ts';

const RP_ID = 'brain.test.invalid';
const ORIGIN = `https://${RP_ID}`;

let adminId = '';

beforeEach(async () => {
  await freshProject();
  const admin = await createUser({
    email: 'root@example.invalid',
    displayName: 'The owner',
    password: 'owner-password-000001',
    isBrainAdmin: true,
  });
  adminId = admin.id;
});

afterEach(async () => {
  await teardown();
});

/** Turn a link into a registered device, the way the route does. */
async function enrol(token: string, options: { credentialId?: string; challenge?: string } = {}) {
  const challenge = options.challenge ?? `challenge-${Math.random().toString(36).slice(2)}`;
  const device = authenticator({ rpId: RP_ID, ...(options.credentialId ? { credentialId: options.credentialId } : {}) });
  const verified = verifyRegistration({
    ...device.register(challenge),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error('unreachable');
  const outcome = await completeEnrollment({
    token,
    credentialId: verified.value.credentialId,
    publicKey: verified.value.publicKey,
    algorithm: verified.value.algorithm,
    signCount: verified.value.signCount,
    label: 'A phone',
  });
  return { outcome, device };
}

describe('a member slot', () => {
  it('is a real account from the start, with no address and no password', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    const user = await getUser(link.userId);
    expect(user).not.toBeNull();
    expect(user!.displayName).toBe('Second person');
    expect(user!.email).toBeNull();
    expect(user!.passwordUpdatedAt).toBeNull();
    expect(user!.mustChangePassword).toBe(false);
  });

  it('stores no token, only a digest and a prefix', async () => {
    const link = await createMemberSlot({ displayName: 'Third person', issuedByUserId: adminId });
    const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM member_enrollments');
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(link.token);
    // Nor does anything else in the identity audit.
    const events = await listIdentityEvents({ limit: 50 });
    expect(JSON.stringify(events)).not.toContain(link.token);
  });

  it('shows the person the name it was created for, and nothing else', async () => {
    const link = await createMemberSlot({ displayName: 'Fourth person', issuedByUserId: adminId });
    const preview = await previewEnrollment(link.token);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.displayName).toBe('Fourth person');
    expect(preview.kind).toBe('ENROLLMENT');
    // No user id, no email, no role, no project: an intercepted link is not a
    // reconnaissance tool.
    expect(Object.keys(preview).sort()).toEqual(['displayName', 'expiresAt', 'kind', 'ok']);
  });
});

describe('spending a link', () => {
  it('registers the device against its own slot and marks the person ready', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    const { outcome, device } = await enrol(link.token);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.user.id).toBe(link.userId);

    const stored = await livePasskeyByCredential(device.credentialId);
    expect(stored?.userId).toBe(link.userId);
    expect(stored?.originKind).toBe('ENROLLMENT');
    expect(await countLivePasskeys(link.userId)).toBe(1);
  });

  it('cannot be done twice with the same link', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    const first = await enrol(link.token, { credentialId: 'device-one-0000000' });
    expect(first.outcome.ok).toBe(true);

    const second = await enrol(link.token, { credentialId: 'device-two-0000000' });
    expect(second.outcome.ok).toBe(false);
    if (second.outcome.ok) return;
    expect(second.outcome.reason).toBe(LINK_REFUSED);
    expect(await countLivePasskeys(link.userId)).toBe(1);
  });

  it('gives a fabricated, a withdrawn and a spent link one identical sentence', async () => {
    const spent = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    await enrol(spent.token, { credentialId: 'device-one-0000000' });

    const withdrawn = await createMemberSlot({ displayName: 'Third person', issuedByUserId: adminId });
    expect(
      await withdrawLink({
        enrollmentId: withdrawn.enrollmentId,
        reason: 'Sent to the wrong person.',
        actorUserId: adminId,
      }),
    ).toBe(true);

    const answers = await Promise.all([
      previewEnrollment('inv_notatokenatall_000000000000'),
      previewEnrollment(spent.token),
      previewEnrollment(withdrawn.token),
      previewEnrollment(null),
      previewEnrollment(42),
    ]);
    for (const answer of answers) {
      expect(answer.ok).toBe(false);
      if (answer.ok) continue;
      expect(answer.reason).toBe(LINK_REFUSED);
    }
  });

  it('refuses one that has expired, without deleting it', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    await getDb().run('UPDATE member_enrollments SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      link.enrollmentId,
    ]);
    const preview = await previewEnrollment(link.token);
    expect(preview.ok).toBe(false);
    const { outcome } = await enrol(link.token);
    expect(outcome.ok).toBe(false);
    expect(await countLivePasskeys(link.userId)).toBe(0);
    // The row is still there: an administrator must be able to see that a link
    // was issued and ran out rather than that nothing ever happened.
    expect((await listEnrollments()).some((one) => one.id === link.enrollmentId)).toBe(true);
  });

  it('refuses a device that is already registered, and keeps the link spent', async () => {
    const first = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    await enrol(first.token, { credentialId: 'shared-device-00000' });

    const second = await createMemberSlot({ displayName: 'Third person', issuedByUserId: adminId });
    const { outcome } = await enrol(second.token, { credentialId: 'shared-device-00000' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The same sentence. Which account holds that credential is exactly what a
    // caller must not learn.
    expect(outcome.reason).toBe(LINK_REFUSED);
    expect(await countLivePasskeys(second.userId)).toBe(0);
    const spent = (await listEnrollments()).find((one) => one.id === second.enrollmentId);
    expect(spent?.usedAt).not.toBeNull();
  });
});

describe('recovery', () => {
  it('retires what was there before it issues the replacement', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    const { device } = await enrol(link.token, { credentialId: 'lost-device-000000' });
    expect(await countLivePasskeys(link.userId)).toBe(1);

    const recovery = await issueRecovery({
      userId: link.userId,
      reason: 'Phone lost on a train.',
      issuedByUserId: adminId,
    });

    // The lost device is out of service *now*, not when the link is used.
    expect(await countLivePasskeys(link.userId)).toBe(0);
    expect(await livePasskeyByCredential(device.credentialId)).toBeNull();

    // And the revoked row is kept, with its reason: §5, nothing destroys history.
    const all = await listPasskeys(link.userId);
    expect(all).toHaveLength(1);
    expect(all[0]!.revokedAt).not.toBeNull();
    expect(all[0]!.revokedReason).toBe('Phone lost on a train.');

    const { outcome } = await enrol(recovery.token, { credentialId: 'new-device-0000000' });
    expect(outcome.ok).toBe(true);
    expect(await countLivePasskeys(link.userId)).toBe(1);
    expect((await listPasskeys(link.userId)).find((one) => !one.revokedAt)?.originKind).toBe(
      'RECOVERY',
    );
  });

  it('is audited, carrying the enrollment id and never the token', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    await enrol(link.token);
    const recovery = await issueRecovery({
      userId: link.userId,
      reason: 'Device replaced.',
      issuedByUserId: adminId,
    });
    const events = await listIdentityEvents({ limit: 50 });
    const actions = events.map((event) => event.action);
    expect(actions).toContain('CREATE_MEMBER_SLOT');
    expect(actions).toContain('ENROLL_PASSKEY');
    expect(actions).toContain('ISSUE_RECOVERY');
    expect(JSON.stringify(events)).not.toContain(recovery.token);
    expect(JSON.stringify(events)).toContain(recovery.enrollmentId);
  });
});

describe('a passkey-only account', () => {
  it('cannot be reached by the password path at all', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    await enrol(link.token);
    // There is no address to ask about, and asking about the display name — the
    // only string a caller could have — finds nothing.
    expect(await getPasswordVerifierByEmail('Second person')).toBeNull();
    expect(await getPasswordVerifierByEmail('')).toBeNull();
  });
});

describe('the readiness gate', () => {
  it('counts a member only once they hold a live passkey', async () => {
    const before = await cashReadiness();
    // The owner has a password rather than a passkey, so they are not READY here
    // either: the count is "can this person sign in with a passkey", not "does
    // an account exist".
    expect(before.members.rows.find((row) => row.userId === adminId)?.state).toBe('NOT_INVITED');

    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    const invited = await cashReadiness();
    expect(invited.members.rows.find((row) => row.userId === link.userId)?.state).toBe('INVITED');
    expect(invited.members.ready).toBe(before.members.ready);

    await enrol(link.token);
    const after = await cashReadiness();
    expect(after.members.rows.find((row) => row.userId === link.userId)?.state).toBe('READY');
    expect(after.members.ready).toBe(before.members.ready + 1);
  });

  /*
   * The denominator is how many member slots exist, not a constant.
   *
   * `REQUIRED_MEMBERS` was four, written when the intended topology was four
   * people with one account each, and it was never a measurement of anything. A
   * page rendering `1 / 4` invited a reader to conclude three quarters of the
   * team was missing from a Brain that had two members. It gates nothing either
   * way — §32 withdrew the lock — so what is left is a count that has to be
   * true.
   */
  it('counts members against the slots that exist rather than a constant', async () => {
    const reading = await cashReadiness();
    expect(reading.members.total).toBe(reading.members.rows.length);
    expect(reading.members.ready).toBeLessThanOrEqual(reading.members.total);
  });

  it('never reports a capacity surface as healthy on configuration alone', async () => {
    const reading = await cashReadiness();
    // No fleet rows at all in a fresh Brain, so the honest answer is zero — not
    // a count of what could be registered.
    expect(reading.capacity.proven).toBe(0);
    expect(reading.capacity.eligibleNow).toBe(0);
    expect(reading.capacity.surfaces.every((row) => row.health !== 'HEALTHY')).toBe(true);
  });

  it('says nothing private about anybody', async () => {
    const link = await createMemberSlot({ displayName: 'Second person', issuedByUserId: adminId });
    await enrol(link.token);
    const reading = await cashReadiness();
    const row = reading.members.rows.find((one) => one.userId === link.userId)!;
    // A name and a state. No address, no credential, no device label, no count
    // of what they can reach.
    expect(Object.keys(row).sort()).toEqual(['displayName', 'state', 'userId']);
  });
});
