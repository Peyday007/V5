/**
 * Identities, credentials, and the decisions made about them.
 *
 * These run in process against a real database — SQLite by default, real
 * Postgres when `BRAIN_TEST_DATABASE_URL` is set — because the properties being
 * checked are properties of stored state. "The database contains no plaintext
 * credential" is not a claim a mock can support; it is a claim about a table.
 *
 * The HTTP side of the same threat model is in `authorization.test.ts`, against
 * a real server over a real socket. Both exist because they can fail
 * separately: a correct policy reached by no route protects nothing, and a
 * guarded route calling a wrong policy protects nothing either.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  countEnabledBrainAdmins,
  createUser,
  createSession,
  createWorker,
  findCredentialByPrefix,
  findLiveSession,
  getPasswordVerifierByEmail,
  getUser,
  getWorker,
  grantMembership,
  issueWorkerCredential,
  listCredentials,
  listIdentityEvents,
  listMembershipsForPrincipal,
  recordIdentityEvent,
  revokeCredential,
  revokeMembership,
  revokeSession,
  setUserDisabled,
  setUserPassword,
  setWorkerStatus,
} from '../server/repos/identity.ts';
import {
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  generateSessionToken,
  generateWorkerCredential,
  hashPassword,
  parseWorkerCredential,
  verifyPassword,
} from '../server/services/identity/secrets.ts';
import {
  decideBrainAdmin,
  decideProjectAccess,
  requirementFor,
  roleAtLeast,
  visibleProjectIds,
} from '../server/services/identity/policy.ts';
import { bootstrapFirstAdmin } from '../server/services/identity/bootstrap.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});
afterEach(teardown);

const PASSWORD = 'a-perfectly-fine-password';

async function aPerson(options: { admin?: boolean; email?: string } = {}) {
  return await createUser({
    email: options.email ?? `person-${Math.random().toString(36).slice(2)}@example.invalid`,
    displayName: 'A Person',
    password: PASSWORD,
    isBrainAdmin: options.admin ?? false,
  });
}

function principalFor(
  user: { id: string; email: string; displayName: string; isBrainAdmin: boolean },
  memberships: ProjectMembership[],
): Principal {
  return {
    type: 'HUMAN',
    id: user.id,
    handle: user.email,
    displayName: user.displayName,
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships,
    requestId: 'req_test',
  };
}

function workerPrincipal(
  worker: { id: string; name: string; displayName: string },
  memberships: ProjectMembership[],
): Principal {
  return {
    type: 'WORKER',
    id: worker.id,
    handle: worker.name,
    displayName: worker.displayName,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'wcr_test',
    authMethod: 'WORKER_BEARER',
    memberships,
    requestId: 'req_test',
  };
}

// ---------------------------------------------------------------------------

describe('passwords', () => {
  it('never stores anything a password can be recovered from', async () => {
    const user = await aPerson();
    const found = await getPasswordVerifierByEmail(user.email);
    expect(found).not.toBeNull();
    expect(found!.verifier).not.toContain(PASSWORD);
    expect(found!.verifier.startsWith('scrypt$')).toBe(true);

    // And the whole row, not just the column we happened to look at.
    const row = await getDb().get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [
      user.id,
    ]);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it('verifies the right one and refuses everything else', async () => {
    const verifier = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, verifier)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, verifier)).toBe(false);
    expect(await verifyPassword(PASSWORD.slice(0, -1), verifier)).toBe(false);
    expect(await verifyPassword('', verifier)).toBe(false);
  });

  it('returns false rather than throwing on a corrupt verifier', async () => {
    // A corrupt row must be indistinguishable from a wrong password: a thrown
    // error would answer a question the refusal is designed not to answer.
    for (const broken of ['', 'nonsense', 'scrypt$', 'scrypt$N=x,r=y,p=z$aa$bb', 'bcrypt$a$b$c']) {
      expect(await verifyPassword(PASSWORD, broken), broken).toBe(false);
    }
  });

  it('refuses a password too short to be worth hashing, without repeating it', async () => {
    let thrown: unknown = null;
    try {
      await hashPassword('short1');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WeakPasswordError);
    expect((thrown as Error).message).toContain(String(MIN_PASSWORD_LENGTH));
    expect((thrown as Error).message).not.toContain('short1');
  });

  it('ends every other session when it changes', async () => {
    const user = await aPerson();
    const first = generateSessionToken();
    const second = generateSessionToken();
    const kept = await createSession({ userId: user.id, secret: first.secret, ttlMs: 60_000 });
    await createSession({ userId: user.id, secret: second.secret, ttlMs: 60_000 });

    await setUserPassword(user.id, 'a-brand-new-password', { keepSessionId: kept.sessionId });

    expect(await findLiveSession(first.secret)).not.toBeNull();
    expect(await findLiveSession(second.secret)).toBeNull();
  });
});

describe('sessions', () => {
  it('stores a digest, not the cookie', async () => {
    const user = await aPerson();
    const token = generateSessionToken();
    await createSession({ userId: user.id, secret: token.secret, ttlMs: 60_000 });

    const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM user_sessions');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token.secret);
  });

  it('refuses an expired one, and a revoked one, and one that never existed', async () => {
    const user = await aPerson();
    const live = generateSessionToken();
    const expired = generateSessionToken();
    const revoked = generateSessionToken();

    await createSession({ userId: user.id, secret: live.secret, ttlMs: 60_000 });
    await createSession({ userId: user.id, secret: expired.secret, ttlMs: -1_000 });
    const toRevoke = await createSession({ userId: user.id, secret: revoked.secret, ttlMs: 60_000 });
    await revokeSession(toRevoke.sessionId);

    expect(await findLiveSession(live.secret)).not.toBeNull();
    expect(await findLiveSession(expired.secret)).toBeNull();
    expect(await findLiveSession(revoked.secret)).toBeNull();
    expect(await findLiveSession(generateSessionToken().secret)).toBeNull();
  });

  it('ends every session the moment somebody is disabled', async () => {
    const user = await aPerson();
    const token = generateSessionToken();
    await createSession({ userId: user.id, secret: token.secret, ttlMs: 60_000 });

    await setUserDisabled(user.id, true);

    // Not "expires soon": gone now. A disabled account that keeps reading until
    // its session lapses is not a disabled account.
    expect(await findLiveSession(token.secret)).toBeNull();
    expect((await getUser(user.id))!.disabled).toBe(true);
  });
});

describe('worker credentials', () => {
  it('is shown once, stored never', async () => {
    const admin = await aPerson({ admin: true });
    const worker = await createWorker({
      name: 'test-worker',
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    const issued = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
    });

    expect(issued.plaintext.startsWith('brnw_')).toBe(true);
    // The whole table, serialized, does not contain the credential.
    const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM worker_credentials');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(issued.plaintext);
    expect(dump).not.toContain(issued.plaintext.split('.')[1]);
    // The prefix is present, because it is the part that is safe to show.
    expect(dump).toContain(issued.credential.prefix);
  });

  it('hands an administrator metadata and nothing else', async () => {
    const admin = await aPerson({ admin: true });
    const worker = await createWorker({
      name: 'listed-worker',
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    const issued = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
    });

    const listed = await listCredentials(worker.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(issued.plaintext);
    expect(listed[0]!.prefix).toBe(issued.credential.prefix);
    expect(listed[0]!.active).toBe(true);
  });

  it('recognises its own format and refuses everything else', () => {
    const generated = generateWorkerCredential();
    const parsed = parseWorkerCredential(generated.plaintext);
    expect(parsed?.prefix).toBe(generated.prefix);

    for (const malformed of [
      '',
      'brnw_',
      'brnw_short.secret',
      'brnw_0011223344556677',
      `${generated.prefix}.`,
      `not_a_marker.${generated.plaintext.split('.')[1]}`,
      `brnw_zzzzzzzzzzzzzzzz.${generated.plaintext.split('.')[1]}`,
      `${generated.prefix}.has spaces in it`,
    ]) {
      expect(parseWorkerCredential(malformed), malformed).toBeNull();
    }
  });

  it('stops working the moment it is revoked, and stays stopped', async () => {
    const admin = await aPerson({ admin: true });
    const worker = await createWorker({
      name: 'revoked-worker',
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    const issued = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
    });

    expect((await findCredentialByPrefix(issued.credential.prefix))!.revokedAt).toBeNull();
    await revokeCredential(issued.credential.id, 'REVOKED_BY_ADMIN');
    const after = await findCredentialByPrefix(issued.credential.prefix);
    expect(after!.revokedAt).not.toBeNull();

    // Revocation is a stored fact, not a cache: it is still true when the row is
    // read again, which is what makes it survive a restart or a second instance.
    const reread = await getDb().get<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM worker_credentials WHERE id = ?',
      [issued.credential.id],
    );
    expect(reread!.revoked_at).not.toBeNull();
  });

  it('revokes every credential when the worker itself is disabled', async () => {
    const admin = await aPerson({ admin: true });
    const worker = await createWorker({
      name: 'disabled-worker',
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    const a = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
    });
    const b = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
    });

    await setWorkerStatus(worker.id, 'DISABLED');

    expect((await getWorker(worker.id))!.disabled).toBe(true);
    for (const credential of [a, b]) {
      expect((await findCredentialByPrefix(credential.credential.prefix))!.revokedAt).not.toBeNull();
    }
  });

  it('rotates without leaving a gap', async () => {
    const admin = await aPerson({ admin: true });
    const worker = await createWorker({
      name: 'rotating-worker',
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    const first = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
    });
    // The new one exists before the old one stops: a rotation that revoked first
    // would break whatever the worker is doing at that moment.
    const second = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
      rotatedFrom: first.credential.id,
    });
    expect((await findCredentialByPrefix(first.credential.prefix))!.revokedAt).toBeNull();

    await revokeCredential(first.credential.id, 'ROTATED');
    expect((await findCredentialByPrefix(first.credential.prefix))!.revokedAt).not.toBeNull();
    expect((await findCredentialByPrefix(second.credential.prefix))!.revokedAt).toBeNull();
    expect(second.credential.rotatedFrom).toBe(first.credential.id);
    expect(second.plaintext).not.toBe(first.plaintext);
  });
});

describe('the authorization decision', () => {
  it('refuses a principal that is not there at all', () => {
    const decision = decideProjectAccess(null, fixture.project.id, 'READ');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('NO_CREDENTIALS');
    expect(decideBrainAdmin(null).allowed).toBe(false);
  });

  it('orders roles the way the names imply', () => {
    expect(roleAtLeast('OWNER', 'VIEWER')).toBe(true);
    expect(roleAtLeast('ADMIN', 'MEMBER')).toBe(true);
    expect(roleAtLeast('VIEWER', 'MEMBER')).toBe(false);
    expect(roleAtLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(roleAtLeast(null, 'VIEWER')).toBe(false);
  });

  it('lets a viewer read and refuses them everything else', async () => {
    const user = await aPerson();
    const membership = await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'VIEWER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const principal = principalFor(user, [membership]);

    expect(decideProjectAccess(principal, fixture.project.id, 'READ').allowed).toBe(true);
    expect(decideProjectAccess(principal, fixture.project.id, 'WRITE').reason).toBe(
      'INSUFFICIENT_ROLE',
    );
    expect(decideProjectAccess(principal, fixture.project.id, 'ADMIN').reason).toBe(
      'INSUFFICIENT_ROLE',
    );
  });

  it('refuses a member of one project everything about another', async () => {
    const user = await aPerson();
    const membership = await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'OWNER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const principal = principalFor(user, [membership]);

    expect(decideProjectAccess(principal, 'prj_somebody_elses', 'READ').reason).toBe('NOT_A_MEMBER');
    expect(decideProjectAccess(principal, 'prj_somebody_elses', 'WRITE').reason).toBe(
      'NOT_A_MEMBER',
    );
  });

  it('will not let a project administrator administer the Brain', async () => {
    const user = await aPerson();
    const membership = await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'OWNER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const principal = principalFor(user, [membership]);
    expect(decideProjectAccess(principal, fixture.project.id, 'ADMIN').allowed).toBe(true);
    // Owning a project is not owning the installation.
    expect(decideBrainAdmin(principal).reason).toBe('NOT_BRAIN_ADMIN');
  });

  it('gives a worker only the verbs its scopes name', async () => {
    const admin = await aPerson({ admin: true });
    const worker = await createWorker({
      name: 'scoped-worker',
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    const membership = await grantMembership({
      projectId: fixture.project.id,
      principalType: 'WORKER',
      principalId: worker.id,
      scopes: ['project:read', 'research:read'],
      grantedByType: 'HUMAN',
      grantedById: admin.id,
    });
    const principal = workerPrincipal(worker, [membership]);

    expect(decideProjectAccess(principal, fixture.project.id, 'READ').allowed).toBe(true);
    expect(
      decideProjectAccess(principal, fixture.project.id, 'READ', 'research:read').allowed,
    ).toBe(true);
    // Not granted, so refused — even though it is a read.
    expect(
      decideProjectAccess(principal, fixture.project.id, 'READ', 'documents:read').reason,
    ).toBe('MISSING_SCOPE');
    // A write with no scope named is refused rather than allowed on membership.
    expect(decideProjectAccess(principal, fixture.project.id, 'WRITE').reason).toBe('MISSING_SCOPE');
  });

  it('never lets a worker administer anything, whatever it holds', async () => {
    const admin = await aPerson({ admin: true });
    const worker = await createWorker({
      name: 'ambitious-worker',
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    const membership = await grantMembership({
      projectId: fixture.project.id,
      principalType: 'WORKER',
      principalId: worker.id,
      // Everything there is.
      scopes: [
        'project:read',
        'documents:read',
        'research:read',
        'research:write',
        'research:propose',
        'claims:write',
        'sources:write',
        'contradictions:write',
        'checkpoints:write',
        'blockers:report',
        'work:complete',
      ],
      grantedByType: 'HUMAN',
      grantedById: admin.id,
    });
    const principal = workerPrincipal(worker, [membership]);

    expect(decideProjectAccess(principal, fixture.project.id, 'ADMIN').allowed).toBe(false);
    expect(decideBrainAdmin(principal).allowed).toBe(false);
  });

  it('stops permitting the moment a membership is revoked', async () => {
    const user = await aPerson();
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'MEMBER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    expect(await listMembershipsForPrincipal('HUMAN', user.id)).toHaveLength(1);

    await revokeMembership(fixture.project.id, 'HUMAN', user.id);

    // Memberships are read on every request rather than baked into a token, so
    // this is what the next request sees — no new sign-in involved.
    const after = await listMembershipsForPrincipal('HUMAN', user.id);
    expect(after).toHaveLength(0);
    expect(decideProjectAccess(principalFor(user, after), fixture.project.id, 'READ').reason).toBe(
      'NOT_A_MEMBER',
    );
  });

  it('shows a listing only what the caller may see', async () => {
    const user = await aPerson();
    const membership = await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'VIEWER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const all = [fixture.project.id, 'prj_other_one', 'prj_another'];

    expect(visibleProjectIds(principalFor(user, [membership]), all)).toEqual([fixture.project.id]);
    expect(visibleProjectIds(null, all)).toEqual([]);

    const admin = await aPerson({ admin: true });
    expect(visibleProjectIds(principalFor(admin, []), all)).toEqual(all);
  });
});

describe('what each route asks for', () => {
  it('reads are READ and everything else is WRITE, by default', () => {
    expect(requirementFor('GET', '/api/projects/prj_1').level).toBe('READ');
    expect(requirementFor('POST', '/api/layers/lay_1/freeze').level).toBe('WRITE');
    expect(requirementFor('PATCH', '/api/documents/doc_1').level).toBe('WRITE');
    expect(requirementFor('DELETE', '/api/anything').level).toBe('WRITE');
  });

  it('tightens the ones that change who can do what', () => {
    expect(requirementFor('PATCH', '/api/projects/prj_1').level).toBe('ADMIN');
    expect(requirementFor('POST', '/api/projects/prj_1/members').level).toBe('ADMIN');
  });

  it('names the scope for the operations a worker is expected to perform', () => {
    expect(requirementFor('GET', '/api/documents/doc_1/file').scope).toBe('documents:read');
    expect(requirementFor('POST', '/api/runs/run_1/complete').scope).toBe('work:complete');
    expect(requirementFor('POST', '/api/runs/run_1/fail').scope).toBe('blockers:report');
    // And leaves everything else without one, which is what refuses a worker.
    expect(requirementFor('POST', '/api/layers/lay_1/freeze').scope).toBeUndefined();
  });
});

describe('recovering an account nobody ever managed to use', () => {
  const ENV = ['BRAIN_BOOTSTRAP_ADMIN_EMAIL', 'BRAIN_BOOTSTRAP_ADMIN_PASSWORD'] as const;
  let saved: Record<string, string | undefined> = {};

  function withBootstrap(email: string, password: string): void {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.BRAIN_BOOTSTRAP_ADMIN_EMAIL = email;
    process.env.BRAIN_BOOTSTRAP_ADMIN_PASSWORD = password;
  }
  function restore(): void {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it('resets a bootstrapped account that never finished setup, and lets it straight in', async () => {
    // The lockout this exists for: the password that reached the person was not
    // the password that reached the database, and the Brain's only account is
    // the one nobody can sign in to.
    const stranded = await createUser({
      email: 'stranded@example.invalid',
      displayName: 'Stranded',
      password: 'a-password-nobody-has',
      isBrainAdmin: true,
      mustChangePassword: true,
    });

    withBootstrap('stranded@example.invalid', 'the-operator-chose-this');
    try {
      const outcome = await bootstrapFirstAdmin();
      expect(outcome.reset).toBe(true);
      expect(outcome.created).toBe(false);
    } finally {
      restore();
    }

    const found = await getPasswordVerifierByEmail('stranded@example.invalid');
    expect(await verifyPassword('the-operator-chose-this', found!.verifier)).toBe(true);
    expect(await verifyPassword('a-password-nobody-has', found!.verifier)).toBe(false);
    // And no second gate on the way back in: the owner just chose this one.
    expect((await getUser(stranded.id))!.mustChangePassword).toBe(false);
  });

  it('will not touch an account somebody is actually using', async () => {
    // The condition that keeps this from being a back door. Once a real password
    // has been chosen, the path is closed for good.
    const inUse = await createUser({
      email: 'inuse@example.invalid',
      displayName: 'In Use',
      password: 'chosen-by-its-owner',
      isBrainAdmin: true,
      mustChangePassword: false,
    });

    withBootstrap('inuse@example.invalid', 'an-attempted-takeover');
    try {
      const outcome = await bootstrapFirstAdmin();
      expect(outcome.reset).toBe(false);
      expect(outcome.created).toBe(false);
    } finally {
      restore();
    }

    const found = await getPasswordVerifierByEmail('inuse@example.invalid');
    expect(await verifyPassword('chosen-by-its-owner', found!.verifier)).toBe(true);
    expect(await verifyPassword('an-attempted-takeover', found!.verifier)).toBe(false);
    expect((await getUser(inUse.id))!.mustChangePassword).toBe(false);
  });

  it('still refuses a reset password that is too short', async () => {
    await createUser({
      email: 'short@example.invalid',
      displayName: 'Short',
      password: 'a-real-password-here',
      isBrainAdmin: true,
      mustChangePassword: true,
    });
    withBootstrap('short@example.invalid', 'tiny');
    try {
      const outcome = await bootstrapFirstAdmin();
      expect(outcome.reset).toBe(false);
      expect(outcome.reason).toMatch(/at least 12 characters/i);
      expect(outcome.reason).not.toContain('tiny');
    } finally {
      restore();
    }
  });
});

describe('the last administrator', () => {
  it('is counted rather than assumed', async () => {
    const first = await aPerson({ admin: true });
    expect(await countEnabledBrainAdmins(first.id)).toBe(0);

    const second = await aPerson({ admin: true });
    expect(await countEnabledBrainAdmins(first.id)).toBe(1);

    await setUserDisabled(second.id, true);
    // A disabled administrator cannot administer, so it does not count as one.
    expect(await countEnabledBrainAdmins(first.id)).toBe(0);
  });
});

describe('the identity audit', () => {
  it('records a denial without recording what was tried', async () => {
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'AUTHENTICATE',
      result: 'DENIED',
      reason: 'INVALID_CREDENTIALS',
      requestId: 'req_1',
    });
    const events = await listIdentityEvents({ action: 'AUTHENTICATE' });
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('INVALID_CREDENTIALS');
    // A category, not the value. Nothing in the row distinguishes "no such
    // account" from "wrong password", which is the whole point of the category.
    expect(JSON.stringify(events[0])).not.toContain(PASSWORD);
  });

  it('survives the project it mentions', async () => {
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: 'usr_someone',
      action: 'GRANT_MEMBERSHIP',
      projectId: fixture.project.id,
      result: 'SUCCESS',
    });
    await getDb().run('DELETE FROM projects WHERE id = ?', [fixture.project.id]);

    // No foreign key, deliberately: the record of who was given access to a
    // project is most interesting exactly when the project has gone.
    const events = await listIdentityEvents({ action: 'GRANT_MEMBERSHIP' });
    expect(events).toHaveLength(1);
    expect(events[0]!.projectId).toBe(fixture.project.id);
  });
});

describe('two administrators acting at once', () => {
  it('produce one membership, not two', async () => {
    const user = await aPerson();
    const grant = (role: 'MEMBER' | 'VIEWER'): Promise<ProjectMembership> =>
      grantMembership({
        projectId: fixture.project.id,
        principalType: 'HUMAN',
        principalId: user.id,
        role,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
      });

    await Promise.all([grant('MEMBER'), grant('VIEWER'), grant('MEMBER')]);

    // Enforced by the database rather than by the code that writes it: the
    // unique triple is what makes the outcome one row whatever the interleaving.
    const rows = await getDb().all<Record<string, unknown>>(
      'SELECT * FROM project_memberships WHERE project_id = ? AND principal_id = ?',
      [fixture.project.id, user.id],
    );
    expect(rows).toHaveLength(1);
    const memberships = await listMembershipsForPrincipal('HUMAN', user.id);
    expect(memberships).toHaveLength(1);
    // Whichever won, it is one deterministic role rather than two disagreeing rows.
    expect(['MEMBER', 'VIEWER']).toContain(memberships[0]!.role);
  });

  it('re-granting a revoked membership restores it without duplicating it', async () => {
    const user = await aPerson();
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'MEMBER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    await revokeMembership(fixture.project.id, 'HUMAN', user.id);
    const restored = await grantMembership({
      projectId: fixture.project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'ADMIN',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });

    expect(restored.active).toBe(true);
    expect(restored.role).toBe('ADMIN');
    const rows = await getDb().all(
      'SELECT * FROM project_memberships WHERE project_id = ? AND principal_id = ?',
      [fixture.project.id, user.id],
    );
    expect(rows).toHaveLength(1);
  });
});
