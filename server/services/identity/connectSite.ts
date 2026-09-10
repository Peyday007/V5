/**
 * The two rows a connected site needs before it can hold a credential.
 *
 * §25: a site is authenticated by a credential Brain issued it and authorized
 * by `policy.ts` against one project and one scope set. The scope set is the
 * part with a wrong answer in it — grant a site `CONNECTOR_SCOPES` and every
 * connector call is refused with the same 404 a missing project gives, which is
 * invariant 23 behaving exactly as designed and telling nobody anything.
 *
 * So the choice is made here, once, from a constant, rather than by whoever is
 * looking at a form. The operator console calls the same repositories with the
 * same set; this is the entrance that works when there is no browser.
 *
 * It deliberately stops short of a credential. That belongs to the console,
 * which renders it into one response and never stores it — a credential is
 * shown once at issue and is not recoverable afterwards by anyone.
 */
import { SITE_CONNECTOR_SCOPES } from '../../domain/types.ts';
import {
  createWorker,
  getMembership,
  getWorkerByName,
  grantMembership,
  listCredentials,
  recordIdentityEvent,
} from '../../repos/identity.ts';
import { getProject, getProjectBySlug } from '../../repos/projects.ts';
import type { Project, User } from '../../domain/types.ts';

export interface ConnectedSiteReport {
  siteName: string;
  workerId: string | null;
  workerCreated: boolean;
  project: Project;
  scopes: string[] | null;
  liveCredentials: number;
  revokedCredentials: number;
  everUsed: boolean;
}

export class NoSuchProject extends Error {}
export class BadSiteName extends Error {}

/** Lower case letters, digits and hyphens — the same shape the console demands. */
export function isCanonicalSiteName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

async function resolveProject(ref: string): Promise<Project> {
  const project = (await getProject(ref)) ?? (await getProjectBySlug(ref));
  if (!project) throw new NoSuchProject(`No project ${ref}.`);
  return project;
}

/** What exists right now. Writes nothing, so it is safe on a Brain you are only inspecting. */
export async function readConnectedSite(
  projectRef: string,
  siteName: string,
): Promise<ConnectedSiteReport> {
  if (!isCanonicalSiteName(siteName)) throw new BadSiteName(siteName);
  const project = await resolveProject(projectRef);
  const worker = await getWorkerByName(siteName);
  const membership = worker ? await getMembership(project.id, 'WORKER', worker.id) : null;
  const credentials = worker ? await listCredentials(worker.id) : [];
  const live = credentials.filter((credential) => !credential.revokedAt);
  return {
    siteName,
    workerId: worker?.id ?? null,
    workerCreated: false,
    project,
    scopes: membership && !membership.revokedAt ? [...membership.scopes] : null,
    liveCredentials: live.length,
    revokedCredentials: credentials.length - live.length,
    everUsed: live.some((credential) => credential.lastUsedAt !== null),
  };
}

/**
 * Make both rows, idempotently.
 *
 * The membership upsert rewrites the scopes to the site set every time, which
 * is what makes this a repair as well as a setup: a site granted the research
 * set once is fixed by running it again. The identity event is written only
 * when something actually changed, because an append-only audit that gains a
 * row every time somebody looks is an audit nobody reads.
 */
export async function prepareConnectedSite(input: {
  projectRef: string;
  siteName: string;
  admin: User;
}): Promise<ConnectedSiteReport> {
  if (!isCanonicalSiteName(input.siteName)) throw new BadSiteName(input.siteName);
  const project = await resolveProject(input.projectRef);

  const existing = await getWorkerByName(input.siteName);
  const worker =
    existing ??
    (await createWorker({
      name: input.siteName,
      displayName: input.siteName,
      workerType: 'MCP',
      description: null,
      createdByType: 'HUMAN',
      createdById: input.admin.id,
    }));

  const before = await getMembership(project.id, 'WORKER', worker.id);
  const beforeScopes =
    before && !before.revokedAt ? [...before.scopes].sort().join(',') : null;
  const wanted = [...SITE_CONNECTOR_SCOPES].sort().join(',');

  await grantMembership({
    projectId: project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: [...SITE_CONNECTOR_SCOPES],
    grantedByType: 'HUMAN',
    grantedById: input.admin.id,
  });

  if (!existing || beforeScopes !== wanted) {
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: input.admin.id,
      action: 'GRANT_MEMBERSHIP',
      targetType: 'WORKER',
      targetId: worker.id,
      result: 'SUCCESS',
      // The scope set and the project, never a credential.
      metadata: {
        projectId: project.id,
        kind: 'SITE',
        scopes: wanted,
        previousScopes: beforeScopes,
      },
    });
  }

  const report = await readConnectedSite(project.id, input.siteName);
  return { ...report, workerCreated: existing === null };
}
