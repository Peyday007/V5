/**
 * Preparing a connected site's identity without a browser.
 *
 * The failure this exists to prevent is silent and expensive to diagnose: a
 * site granted `CONNECTOR_SCOPES` instead of `SITE_CONNECTOR_SCOPES` gets the
 * same 404 from every connector route that a missing project gives — invariant
 * 23 working exactly as designed, and telling the operator nothing. So the
 * scope set is taken from the constant rather than from whoever is looking at a
 * form, and these are the ways that could still go wrong.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { CONNECTOR_SCOPES, SITE_CONNECTOR_SCOPES } from '../server/domain/types.ts';
import {
  createUser,
  createWorker,
  getMembership,
  getWorkerByName,
  grantMembership,
  issueWorkerCredential,
  listIdentityEvents,
} from '../server/repos/identity.ts';
import {
  BadSiteName,
  NoSuchProject,
  prepareConnectedSite,
  readConnectedSite,
} from '../server/services/identity/connectSite.ts';
import type { Project, User } from '../server/domain/types.ts';

async function anAdministrator(): Promise<User> {
  return await createUser({
    email: `admin-${Math.random().toString(36).slice(2)}@example.invalid`,
    displayName: 'An Administrator',
    password: 'a-password-nobody-has',
    isBrainAdmin: true,
  });
}

async function scenario(): Promise<{ project: Project; admin: User }> {
  const fixture = await freshProject();
  return { project: fixture.project, admin: await anAdministrator() };
}

describe('preparing a connected site', () => {
  it('creates the worker and grants the site scope set', async () => {
    const { project, admin } = await scenario();

    const report = await prepareConnectedSite({
      projectRef: project.id,
      siteName: 'deal-dispatch',
      admin,
    });

    expect(report.workerCreated).toBe(true);
    expect(report.workerId).toBeTruthy();
    expect(report.scopes?.slice().sort()).toEqual([...SITE_CONNECTOR_SCOPES].sort());
    // The set a research connector gets is a different set, and getting this
    // wrong is the whole reason the choice is not a form field.
    expect(report.scopes?.slice().sort()).not.toEqual([...CONNECTOR_SCOPES].sort());

    const membership = await getMembership(project.id, 'WORKER', report.workerId!);
    expect(membership?.revokedAt).toBeNull();
    expect(membership?.scopes.slice().sort()).toEqual([...SITE_CONNECTOR_SCOPES].sort());
  });

  it('is idempotent, and writes one audit row rather than one per look', async () => {
    const { project, admin } = await scenario();

    const first = await prepareConnectedSite({ projectRef: project.id, siteName: 'deal-dispatch', admin });
    const second = await prepareConnectedSite({ projectRef: project.id, siteName: 'deal-dispatch', admin });
    const third = await readConnectedSite(project.id, 'deal-dispatch');

    expect(second.workerId).toBe(first.workerId);
    expect(second.workerCreated).toBe(false);
    expect(third.scopes?.slice().sort()).toEqual([...SITE_CONNECTOR_SCOPES].sort());

    const grants = (await listIdentityEvents({ limit: 200 })).filter(
      (event) => event.action === 'GRANT_MEMBERSHIP' && event.targetId === first.workerId,
    );
    expect(grants).toHaveLength(1);
  });

  it('repairs a site that was granted the research set by hand', async () => {
    const { project, admin } = await scenario();
    const worker = await createWorker({
      name: 'deal-dispatch',
      displayName: 'deal-dispatch',
      workerType: 'MCP',
      description: null,
      createdByType: 'HUMAN',
      createdById: admin.id,
    });
    await grantMembership({
      projectId: project.id,
      principalType: 'WORKER',
      principalId: worker.id,
      role: null,
      scopes: [...CONNECTOR_SCOPES],
      grantedByType: 'HUMAN',
      grantedById: admin.id,
    });

    const report = await prepareConnectedSite({ projectRef: project.id, siteName: 'deal-dispatch', admin });

    expect(report.workerCreated).toBe(false);
    expect(report.scopes?.slice().sort()).toEqual([...SITE_CONNECTOR_SCOPES].sort());
    const grants = (await listIdentityEvents({ limit: 200 })).filter(
      (event) => event.action === 'GRANT_MEMBERSHIP' && event.targetId === worker.id,
    );
    // The repair is a change, so it is recorded — and it names what it replaced.
    expect(grants).toHaveLength(1);
    expect(String(grants[0]?.metadata?.['previousScopes'])).toContain('project:read');
  });

  it('reports credentials by count and never carries one', async () => {
    const { project, admin } = await scenario();
    const prepared = await prepareConnectedSite({ projectRef: project.id, siteName: 'deal-dispatch', admin });
    expect(prepared.liveCredentials).toBe(0);

    const issued = await issueWorkerCredential({
      workerId: prepared.workerId!,
      issuedByType: 'HUMAN',
      issuedById: admin.id,
    });

    const after = await readConnectedSite(project.id, 'deal-dispatch');
    expect(after.liveCredentials).toBe(1);
    expect(after.everUsed).toBe(false);
    // The report is a shape a log may hold. Nothing in it is the secret.
    expect(JSON.stringify(after)).not.toContain(issued.plaintext);
  });

  it('refuses a project it cannot find, and a name the console would refuse', async () => {
    const { admin } = await scenario();
    await expect(
      prepareConnectedSite({ projectRef: 'prj_not_a_project', siteName: 'deal-dispatch', admin }),
    ).rejects.toBeInstanceOf(NoSuchProject);
    await expect(
      prepareConnectedSite({ projectRef: 'prj_not_a_project', siteName: 'Deal Dispatch', admin }),
    ).rejects.toBeInstanceOf(BadSiteName);
  });

  it('reads a site that does not exist yet without creating one', async () => {
    const { project } = await scenario();
    const report = await readConnectedSite(project.id, 'deal-dispatch');
    expect(report.workerId).toBeNull();
    expect(report.scopes).toBeNull();
    expect(await getWorkerByName('deal-dispatch')).toBeNull();
  });
});
