/**
 * The invitation row itself: single use, expiring, and spent by one statement.
 *
 * In process against a real database — SQLite by default, real Postgres when
 * `BRAIN_TEST_DATABASE_URL` is set — because every property here is a property
 * of stored state. "The database holds no recoverable token" is not a claim a
 * mock can support; it is a claim about a table. "Two requests carrying one link
 * cannot both win" is a claim about a `WHERE` clause.
 *
 * The HTTP half of the same threat model is `projectInvitationsHttp.test.ts`,
 * over a real socket. Both exist because they fail separately: a correct guard
 * reached by no route protects nothing, and a guarded route calling a wrong
 * repository protects nothing either.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createUser,
  createWorker,
  getMembership,
  grantMembership,
  listIdentityEvents,
  listMembershipsForPrincipal,
} from '../server/repos/identity.ts';
import {
  acceptProjectInvitation,
  createProjectInvitation,
  findLiveProjectInvitation,
  getProjectInvitation,
  listProjectInvitations,
  revokeProjectInvitation,
} from '../server/repos/projectInvitations.ts';
import {
  INVITATION_REFUSAL,
  acceptInvitation,
  inviteToProject,
  previewInvitation,
  withdrawInvitation,
} from '../server/services/identity/invitations.ts';
import {
  digestSecret,
  generateInvitationToken,
  parseInvitationToken,
} from '../server/services/identity/secrets.ts';
import { createProject } from '../server/repos/projects.ts';
import { WORKER_SCOPES } from '../server/domain/types.ts';
import type { Principal, User } from '../server/domain/types.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});
afterEach(teardown);

const ORIGIN = 'https://brain.invalid';

async function person(local: string, isBrainAdmin: boolean): Promise<User> {
  return createUser({
    email: `${local}@example.invalid`,
    displayName: `Test identity — ${local}`,
    password: 'a-generated-test-password-01',
    isBrainAdmin,
  });
}

async function principalFor(user: User): Promise<Principal> {
  return {
    type: 'HUMAN',
    id: user.id,
    handle: user.email,
    displayName: user.displayName,
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: user.mustChangePassword,
    credentialId: `test:${user.id}`,
    authMethod: 'SESSION_COOKIE',
    memberships: (await listMembershipsForPrincipal('HUMAN', user.id)).filter((m) => m.active),
    requestId: `test:${user.id}`,
  };
}

async function admin(): Promise<Principal> {
  const user = await person(`admin-${Math.random().toString(36).slice(2, 8)}`, true);
  await grantMembership({
    projectId: fixture.project.id,
    principalType: 'HUMAN',
    principalId: user.id,
    role: 'ADMIN',
    grantedByType: 'SYSTEM',
    grantedById: user.id,
  });
  return principalFor(user);
}

function tokenOf(url: string): string {
  return url.split('#')[1] ?? '';
}

describe('the invitation row', () => {
  it('stores a digest and never anything the token can be recovered from', async () => {
    const token = generateInvitationToken();
    const invitation = await createProjectInvitation({
      projectId: fixture.project.id,
      invitedEmail: 'Someone@Example.Invalid',
      role: 'MEMBER',
      tokenPrefix: token.prefix,
      tokenDigest: token.digest,
      invitedByUserId: (await person('issuer', true)).id,
    });

    const row = await getDb().get<Record<string, unknown>>(
      'SELECT * FROM project_invitations WHERE id = ?',
      [invitation.id],
    );
    const serialized = JSON.stringify(row);
    const parsed = parseInvitationToken(token.plaintext)!;
    expect(serialized).not.toContain(parsed.secret);
    expect(serialized).not.toContain(token.plaintext);
    // What is stored is the digest of the secret half, which is what makes the
    // lookup possible and the value unrecoverable.
    expect(row!['token_digest']).toBe(digestSecret(parsed.secret));
    // And the address is normalised once, so a lookup cannot miss on case.
    expect(invitation.invitedEmail).toBe('someone@example.invalid');
  });

  it('answers one way for unknown, wrong-secret, expired, spent and withdrawn', async () => {
    const issuer = await person('issuer-two', true);
    const live = generateInvitationToken();
    const good = await createProjectInvitation({
      projectId: fixture.project.id,
      invitedEmail: 'live@example.invalid',
      role: 'MEMBER',
      tokenPrefix: live.prefix,
      tokenDigest: live.digest,
      invitedByUserId: issuer.id,
    });
    const liveParsed = parseInvitationToken(live.plaintext)!;
    expect(await findLiveProjectInvitation(liveParsed.prefix, liveParsed.secret)).not.toBeNull();

    // Unknown prefix.
    expect(await findLiveProjectInvitation('brnv_0000000000000000', liveParsed.secret)).toBeNull();
    // Right prefix, wrong secret — the case a guess actually looks like.
    expect(await findLiveProjectInvitation(liveParsed.prefix, 'not-the-secret')).toBeNull();

    // Expired.
    const stale = generateInvitationToken();
    await createProjectInvitation({
      projectId: fixture.project.id,
      invitedEmail: 'stale@example.invalid',
      role: 'MEMBER',
      tokenPrefix: stale.prefix,
      tokenDigest: stale.digest,
      invitedByUserId: issuer.id,
      ttlMs: -1000,
    });
    const staleParsed = parseInvitationToken(stale.plaintext)!;
    expect(await findLiveProjectInvitation(staleParsed.prefix, staleParsed.secret)).toBeNull();

    // Spent.
    expect(await acceptProjectInvitation(good.id, issuer.id)).toBe(true);
    expect(await findLiveProjectInvitation(liveParsed.prefix, liveParsed.secret)).toBeNull();

    // Withdrawn.
    const withdrawn = generateInvitationToken();
    const gone = await createProjectInvitation({
      projectId: fixture.project.id,
      invitedEmail: 'gone@example.invalid',
      role: 'MEMBER',
      tokenPrefix: withdrawn.prefix,
      tokenDigest: withdrawn.digest,
      invitedByUserId: issuer.id,
    });
    await revokeProjectInvitation(gone.id, 'changed my mind');
    const goneParsed = parseInvitationToken(withdrawn.plaintext)!;
    expect(await findLiveProjectInvitation(goneParsed.prefix, goneParsed.secret)).toBeNull();
  });

  it('is spent exactly once, by the statement that checks it', async () => {
    const issuer = await person('issuer-three', true);
    const token = generateInvitationToken();
    const invitation = await createProjectInvitation({
      projectId: fixture.project.id,
      invitedEmail: 'once@example.invalid',
      role: 'VIEWER',
      tokenPrefix: token.prefix,
      tokenDigest: token.digest,
      invitedByUserId: issuer.id,
    });

    const [first, second] = await Promise.all([
      acceptProjectInvitation(invitation.id, issuer.id),
      acceptProjectInvitation(invitation.id, issuer.id),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    // Losing is an ordinary outcome, and it is also what a late withdrawal gets.
    expect(await revokeProjectInvitation(invitation.id, 'too late')).toBe(false);
    const after = await getProjectInvitation(invitation.id);
    expect(after!.acceptedAt).not.toBeNull();
    expect(after!.revokedAt).toBeNull();
  });

  it('orders its listing without a tiebreak only one dialect has', async () => {
    const issuer = await person('issuer-four', true);
    for (let i = 0; i < 3; i += 1) {
      const token = generateInvitationToken();
      await createProjectInvitation({
        projectId: fixture.project.id,
        invitedEmail: `ordered-${i}@example.invalid`,
        role: 'MEMBER',
        tokenPrefix: token.prefix,
        tokenDigest: token.digest,
        invitedByUserId: issuer.id,
      });
    }
    // The assertion that matters is that this statement runs at all on the
    // configured backend: `ORDER BY created_at DESC, id DESC` is sayable in both,
    // and a `rowid` tiebreak would throw here on Postgres.
    expect(await listProjectInvitations(fixture.project.id)).toHaveLength(3);
  });
});

describe('issuing an invitation', () => {
  it('refuses a worker by principal type, holding every scope', async () => {
    const worker = await createWorker({
      name: 'invitation-test-worker',
      displayName: 'A machine',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'WORKER',
      principalId: worker.id,
      role: null,
      scopes: [...WORKER_SCOPES],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const principal: Principal = {
      type: 'WORKER',
      id: worker.id,
      handle: worker.name,
      displayName: worker.displayName,
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'test:worker',
      authMethod: 'WORKER_BEARER',
      memberships: (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active),
      requestId: 'test:worker',
    };

    const outcome = await inviteToProject({
      principal,
      projectId: fixture.project.id,
      email: 'never@example.invalid',
      role: 'ADMIN',
      origin: ORIGIN,
    });
    expect(outcome.ok).toBe(false);
    // And it wrote nothing.
    expect(await listProjectInvitations(fixture.project.id)).toHaveLength(0);
  });

  it('refuses a member who does not administer the project, in a missing project’s words', async () => {
    const member = await person('ordinary-member', false);
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: member.id,
      role: 'MEMBER',
      grantedByType: 'SYSTEM',
      grantedById: member.id,
    });
    const outcome = await inviteToProject({
      principal: await principalFor(member),
      projectId: fixture.project.id,
      email: 'never@example.invalid',
      role: 'MEMBER',
      origin: ORIGIN,
    });
    expect(outcome).toEqual({ ok: false, reason: 'No project with that id.' });
    expect(await listProjectInvitations(fixture.project.id)).toHaveLength(0);
  });

  it('puts the token in the fragment and records only the invitation id', async () => {
    const issuer = await admin();
    const outcome = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: 'invited@example.invalid',
      role: undefined,
      origin: ORIGIN,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const url = outcome.issued.invitationUrl;
    const token = tokenOf(url);
    expect(token.length).toBeGreaterThan(40);
    // Everything a server would log is before the `#`, and the token is not in it.
    expect(url.split('#')[0]).toBe(`${ORIGIN}/invite`);
    expect(url.split('#')[0]).not.toContain(token);
    // Unsaid role means the prefilled default rather than a guess.
    expect(outcome.issued.invitation.role).toBe('MEMBER');

    const events = await listIdentityEvents({ projectId: fixture.project.id, limit: 50 });
    const issue = events.find((event) => event.action === 'INVITE_PERSON');
    expect(issue?.targetId).toBe(outcome.issued.invitation.id);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('replaces an unused invitation to the same address rather than accumulating', async () => {
    const issuer = await admin();
    const first = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: 'twice@example.invalid',
      role: 'MEMBER',
      origin: ORIGIN,
    });
    const second = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: 'twice@example.invalid',
      role: 'VIEWER',
      origin: ORIGIN,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.issued.replaced).toBe(1);

    // The old link is dead, and the new one is the only live offer.
    expect(await acceptInvitation({ token: tokenOf(first.issued.invitationUrl) })).toEqual({
      ok: false,
      reason: INVITATION_REFUSAL,
    });
    const live = (await listProjectInvitations(fixture.project.id)).filter(
      (entry) => entry.acceptedAt === null && entry.revokedAt === null,
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.role).toBe('VIEWER');
  });
});

describe('accepting an invitation', () => {
  it('creates the membership at the role the invitation named, never one the acceptor chose', async () => {
    const issuer = await admin();
    const invitee = await person('already-has-an-account', false);
    const issued = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: invitee.email,
      role: 'VIEWER',
      origin: ORIGIN,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    // A role and a Brain-administration flag in the body, which nothing reads.
    const outcome = await acceptInvitation({
      token: tokenOf(issued.issued.invitationUrl),
      ...({ role: 'OWNER', isBrainAdmin: true } as object),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.userId).toBe(invitee.id);
    expect(outcome.role).toBe('VIEWER');
    expect(outcome.createdAccount).toBe(false);
    // No session is handed out by accepting; signing in stays a separate act.
    expect(outcome.signInRequired).toBe(true);

    const membership = await getMembership(fixture.project.id, 'HUMAN', invitee.id);
    expect(membership?.role).toBe('VIEWER');
    expect(membership?.scopes).toEqual([]);
  });

  it('refuses a second redemption in the same words an unknown token gets', async () => {
    const issuer = await admin();
    const invitee = await person('accepts-once', false);
    const issued = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: invitee.email,
      role: 'MEMBER',
      origin: ORIGIN,
    });
    if (!issued.ok) throw new Error('the invitation was refused');
    const token = tokenOf(issued.issued.invitationUrl);

    expect((await acceptInvitation({ token })).ok).toBe(true);
    const again = await acceptInvitation({ token });
    const unknown = await acceptInvitation({
      token: 'brnv_0123456789abcdef.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(again).toEqual({ ok: false, reason: INVITATION_REFUSAL });
    expect(again).toEqual(unknown);
  });

  it('refuses an expired one identically, and the listing names its remedy', async () => {
    const issuer = await admin();
    const invitee = await person('too-late', false);
    const issued = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: invitee.email,
      role: 'MEMBER',
      origin: ORIGIN,
      ttlMs: -1000,
    });
    if (!issued.ok) throw new Error('the invitation was refused');

    expect(await acceptInvitation({ token: tokenOf(issued.issued.invitationUrl) })).toEqual({
      ok: false,
      reason: INVITATION_REFUSAL,
    });
    // The refusal names a remedy rather than a reason, which is the difference
    // between an answering transition and a dead end.
    expect(INVITATION_REFUSAL).toMatch(/send a new one/);
  });

  it('will not let a demoted inviter’s link in, because authority is read now', async () => {
    const issuer = await admin();
    const invitee = await person('invited-by-a-demoted-admin', false);
    const issued = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: invitee.email,
      role: 'MEMBER',
      origin: ORIGIN,
    });
    if (!issued.ok) throw new Error('the invitation was refused');

    // The link still exists; the authority behind it does not.
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: issuer.id,
      role: 'VIEWER',
      grantedByType: 'SYSTEM',
      grantedById: issuer.id,
    });
    const { setBrainAdmin } = await import('../server/repos/identity.ts');
    await setBrainAdmin(issuer.id, false);

    expect(await acceptInvitation({ token: tokenOf(issued.issued.invitationUrl) })).toEqual({
      ok: false,
      reason: INVITATION_REFUSAL,
    });
    expect(await getMembership(fixture.project.id, 'HUMAN', invitee.id)).toBeNull();
  });

  it('creates an account only when the inviter may authorize one, and keeps the link alive when not', async () => {
    // A project administrator who is not a Brain administrator.
    const projectAdmin = await person('project-admin-only', false);
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: projectAdmin.id,
      role: 'ADMIN',
      grantedByType: 'SYSTEM',
      grantedById: projectAdmin.id,
    });
    const issued = await inviteToProject({
      principal: await principalFor(projectAdmin),
      projectId: fixture.project.id,
      email: 'nobody-yet@example.invalid',
      role: 'MEMBER',
      origin: ORIGIN,
    });
    if (!issued.ok) throw new Error('the invitation was refused');
    const token = tokenOf(issued.issued.invitationUrl);

    const refused = await acceptInvitation({ token, password: 'a-generated-test-password-01' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/Brain administrator/);
    // The remedy is somebody making the account, so the link must survive it.
    const still = await getProjectInvitation(issued.issued.invitation.id);
    expect(still!.acceptedAt).toBeNull();
    expect(still!.revokedAt).toBeNull();
    // And the preview says the same thing rather than offering a button that
    // cannot work.
    const preview = await previewInvitation(token);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.preview.acceptable).toBe(false);
      expect(preview.preview.blockedReason).toMatch(/Brain administrator/);
    }

    const made = await createUser({
      email: 'nobody-yet@example.invalid',
      displayName: 'Made by an administrator',
      password: 'a-generated-test-password-02',
      isBrainAdmin: false,
    });
    const now = await acceptInvitation({ token });
    expect(now.ok).toBe(true);
    if (!now.ok) return;
    expect(now.userId).toBe(made.id);
    expect((await getMembership(fixture.project.id, 'HUMAN', made.id))?.role).toBe('MEMBER');
  });

  it('creates the account at the invited address, never at one the acceptor asked for', async () => {
    const issuer = await admin();
    const issued = await inviteToProject({
      principal: issuer,
      projectId: fixture.project.id,
      email: 'brand-new@example.invalid',
      role: 'MEMBER',
      origin: ORIGIN,
    });
    if (!issued.ok) throw new Error('the invitation was refused');

    const outcome = await acceptInvitation({
      token: tokenOf(issued.issued.invitationUrl),
      password: 'a-generated-test-password-03',
      displayName: 'A new collaborator',
      ...({ email: 'somebody-else@example.invalid', isBrainAdmin: true } as object),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.email).toBe('brand-new@example.invalid');
    expect(outcome.createdAccount).toBe(true);

    const { getUserByEmail } = await import('../server/repos/identity.ts');
    expect(await getUserByEmail('somebody-else@example.invalid')).toBeNull();
    const made = await getUserByEmail('brand-new@example.invalid');
    // A project invitation confers project membership, never Brain-wide power.
    expect(made!.isBrainAdmin).toBe(false);
  });

  it('records a denial as a category, with no email and no token in it', async () => {
    await acceptInvitation({ token: 'brnv_0123456789abcdef.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const denials = (await listIdentityEvents({ limit: 50 })).filter(
      (event) => event.action === 'ACCEPT_PROJECT_INVITATION' && event.result === 'DENIED',
    );
    expect(denials.length).toBeGreaterThan(0);
    for (const denial of denials) {
      expect(denial.reason).not.toBeNull();
      const metadata = JSON.stringify(denial.metadata);
      expect(metadata).not.toContain('@');
      expect(metadata).not.toContain('brnv_');
    }
  });
});

describe('withdrawing an invitation', () => {
  it('answers a guessed id and another project’s real id identically', async () => {
    const issuer = await admin();
    const guessed = await withdrawInvitation({
      principal: issuer,
      projectId: fixture.project.id,
      invitationId: 'pinv_thisdoesnotexistatall',
    });
    // A real invitation, on a real project, which this caller is not asking
    // about. The two answers must be the same object, not merely the same shape.
    const elsewhere = await createProject({
      name: 'Another project entirely',
      description: 'Created by the invitation test.',
    });
    const other = await createProjectInvitation({
      projectId: elsewhere.id,
      invitedEmail: 'elsewhere@example.invalid',
      role: 'MEMBER',
      tokenPrefix: generateInvitationToken().prefix,
      tokenDigest: 'a-digest',
      invitedByUserId: issuer.id,
    });

    const real = await withdrawInvitation({
      principal: issuer,
      projectId: fixture.project.id,
      invitationId: other.id,
    });
    expect(guessed.ok).toBe(false);
    expect(real).toEqual(guessed);
    // And it is still there: a refused withdrawal changes nothing.
    expect((await getProjectInvitation(other.id))!.revokedAt).toBeNull();
  });
});
