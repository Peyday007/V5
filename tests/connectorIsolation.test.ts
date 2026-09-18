/**
 * One site, two private operations, two identities.
 *
 * ---------------------------------------------------------------------------
 * The defect, and why nothing would have found it
 * ---------------------------------------------------------------------------
 *
 * `connectSite` derived its worker from a single global name, so connecting the
 * same site to a second project reused one identity for both. Three things
 * followed and the third is the one that matters:
 *
 *   - `grantMembership` added the second project to that one worker, and a
 *     worker credential resolves the worker's memberships — so the credential
 *     the second site held authenticated against **both** projects;
 *   - `revokeCredentialsForWorker` is worker-wide, so connecting the second
 *     site revoked the first site's live credential and silently broke it;
 *   - and the refusal that would have caught a caller reaching across projects
 *     is invariant 23's 404, which by design tells nobody anything.
 *
 * A Brain with one site and one project never sees any of it. Four people each
 * connected to their own site is exactly the arrangement that does, and it is
 * the arrangement Cash Mode asks for.
 *
 * So this file is written from the four-operation shape rather than the
 * one-project one, which is the only shape the defect exists in.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, getMembership, listCredentials } from '../server/repos/identity.ts';
import {
  connectSite,
  disconnectSite,
  scopedWorkerName,
  SITE_DEFINITIONS,
  siteStatus,
} from '../server/services/connect/sites.ts';
import type { User } from '../server/domain/types.ts';

const SITE = SITE_DEFINITIONS.DEAL_DISPATCH;

let alice = '';
let bob = '';
let actor: User;

beforeEach(async () => {
  const fixture = await freshProject();
  alice = fixture.project.id;
  bob = (await createProject({ name: 'The second private operation' })).id;
  actor = await createUser({
    email: `connect-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Operator',
    password: 'correct horse battery staple',
  });
});

function connect(projectId: string) {
  return connectSite({
    projectId,
    system: 'DEAL_DISPATCH',
    actor,
    brainUrl: 'https://brain.example.invalid',
  });
}

describe('two operations, one site', () => {
  it('gives each project its own worker identity', async () => {
    const first = await connect(alice);
    const second = await connect(bob);

    expect(first.status.workerName).toBe(scopedWorkerName(SITE, alice));
    expect(second.status.workerName).toBe(scopedWorkerName(SITE, bob));
    expect(first.status.workerId).not.toBe(second.status.workerId);
  });

  it('does not let one operation’s identity reach the other’s project', async () => {
    const first = await connect(alice);
    const second = await connect(bob);

    // The whole of it. Each worker is a member of exactly one project, so the
    // credential each site holds resolves exactly one project's memberships.
    expect(await getMembership(bob, 'WORKER', first.status.workerId!)).toBeNull();
    expect(await getMembership(alice, 'WORKER', second.status.workerId!)).toBeNull();
    expect(await getMembership(alice, 'WORKER', first.status.workerId!)).not.toBeNull();
    expect(await getMembership(bob, 'WORKER', second.status.workerId!)).not.toBeNull();
  });

  it('does not revoke one operation’s credential by connecting the other', async () => {
    const first = await connect(alice);
    await connect(bob);

    const live = (await listCredentials(first.status.workerId!)).filter((c) => !c.revokedAt);
    expect(live.length).toBe(1);
    expect((await siteStatus(alice, 'DEAL_DISPATCH')).liveCredentials).toBe(1);
    expect((await siteStatus(bob, 'DEAL_DISPATCH')).liveCredentials).toBe(1);
  });

  it('still rotates within one operation, leaving exactly one live credential', async () => {
    const first = await connect(alice);
    const again = await connect(alice);

    expect(again.status.workerId).toBe(first.status.workerId);
    expect(again.createdIdentity).toBe(false);
    expect(again.revokedCredentials).toBe(1);
    expect(again.status.liveCredentials).toBe(1);
    expect(again.secret).not.toBe(first.secret);
  });

  it('disconnects one operation without touching the other', async () => {
    await connect(alice);
    const second = await connect(bob);

    const after = await disconnectSite({
      projectId: alice,
      system: 'DEAL_DISPATCH',
      actor,
      reason: 'Finished with it.',
    });
    /*
     * `NOT_CONNECTED` rather than `DISCONNECTED`, and that is existing
     * behaviour rather than something this change altered: with no live
     * membership, no live credential and no records the site has left nothing
     * behind to report, so the two answers genuinely collapse. What matters
     * here is the credential, which is checked directly.
     */
    expect(['DISCONNECTED', 'NOT_CONNECTED']).toContain(after.state);
    expect(after.liveCredentials).toBe(0);

    const other = await siteStatus(bob, 'DEAL_DISPATCH');
    expect(other.liveCredentials).toBe(1);
    expect(other.workerId).toBe(second.status.workerId);
    expect(await getMembership(bob, 'WORKER', second.status.workerId!)).not.toBeNull();
  });

  it('reports each operation independently, and neither as connected before it is', async () => {
    await connect(alice);
    const untouched = await siteStatus(bob, 'DEAL_DISPATCH');
    // Bob's operation has never connected this site. It must not read as
    // connected because somebody else's has.
    expect(untouched.state).toBe('NOT_CONNECTED');
    expect(untouched.workerId).toBeNull();
    expect(untouched.liveCredentials).toBe(0);
  });

  it('never reports a scoped connection as shared', async () => {
    const first = await connect(alice);
    expect(first.status.sharedIdentity).toBe(false);
    expect(first.retiredSharedIdentity).toBe(false);
  });
});

/**
 * A Brain that connected a site before the identity was scoped.
 *
 * The shared worker is real and the site is genuinely working, so reporting it
 * as NOT_CONNECTED would be a lie about a live connection. It is resolved —
 * but only where it holds a live membership, so it can never be found by a
 * project it was never connected to — and reconnecting retires its reach into
 * that project without breaking the others still on it.
 */
describe('a connection made before the identity was scoped', () => {
  async function legacyConnection(projectId: string): Promise<string> {
    const { createWorker, grantMembership, issueWorkerCredential } = await import(
      '../server/repos/identity.ts'
    );
    const worker = await createWorker({
      name: SITE.workerName,
      displayName: SITE.name,
      workerType: 'MCP',
      description: null,
      createdByType: 'HUMAN',
      createdById: actor.id,
    });
    await grantMembership({
      projectId,
      principalType: 'WORKER',
      principalId: worker.id,
      role: null,
      scopes: ['project:read', 'external:sync'],
      grantedByType: 'HUMAN',
      grantedById: actor.id,
    });
    await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'HUMAN',
      issuedById: actor.id,
    });
    return worker.id;
  }

  it('reads as connected, and says the identity is shared', async () => {
    const workerId = await legacyConnection(alice);
    const status = await siteStatus(alice, 'DEAL_DISPATCH');
    expect(status.workerId).toBe(workerId);
    expect(status.sharedIdentity).toBe(true);
    expect(status.state).toBe('AWAITING_FIRST_CALL');
  });

  it('is not found by a project it was never connected to', async () => {
    await legacyConnection(alice);
    const other = await siteStatus(bob, 'DEAL_DISPATCH');
    expect(other.workerId).toBeNull();
    expect(other.sharedIdentity).toBe(false);
    expect(other.state).toBe('NOT_CONNECTED');
  });

  it('retires the shared identity’s reach on reconnect, and says so', async () => {
    const legacyId = await legacyConnection(alice);
    const reconnected = await connect(alice);

    expect(reconnected.retiredSharedIdentity).toBe(true);
    expect(reconnected.status.sharedIdentity).toBe(false);
    expect(reconnected.status.workerId).not.toBe(legacyId);
    // Revoked rather than deleted — the row is the record that it was ever
    // granted, which is what makes the retirement auditable.
    const retired = await getMembership(alice, 'WORKER', legacyId);
    expect(retired!.revokedAt).not.toBeNull();
    expect(reconnected.instruction.reason).toContain('now has its own');
  });

  it('leaves the shared identity’s other projects working', async () => {
    /*
     * Its credentials are deliberately *not* revoked: they are worker-wide, and
     * revoking them would disconnect every other project on that identity as a
     * side effect of this one moving off it. Those projects move onto their own
     * identity when somebody reconnects them, which is the same one action.
     */
    const legacyId = await legacyConnection(alice);
    const { grantMembership } = await import('../server/repos/identity.ts');
    await grantMembership({
      projectId: bob,
      principalType: 'WORKER',
      principalId: legacyId,
      role: null,
      scopes: ['project:read', 'external:sync'],
      grantedByType: 'HUMAN',
      grantedById: actor.id,
    });

    await connect(alice);

    expect((await listCredentials(legacyId)).filter((c) => !c.revokedAt).length).toBe(1);
    expect(await getMembership(bob, 'WORKER', legacyId)).not.toBeNull();
    expect((await siteStatus(bob, 'DEAL_DISPATCH')).sharedIdentity).toBe(true);
  });
});
