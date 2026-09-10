/**
 * A connected site's whole lifecycle, as one decision a person can take.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a form
 * ---------------------------------------------------------------------------
 *
 * Connecting a site used to be three screens on the operator console: create a
 * worker, grant it a project *and pick which of two jobs it does*, then issue a
 * credential. Every one of those is a decision that was already settled — the
 * site is Deal Dispatch, the project is the one being connected, the scope set
 * is `SITE_CONNECTOR_SCOPES` — except the one in the middle, which had a wrong
 * answer that fails *silently*: a site granted the research set is refused by
 * every connector route with the same 404 a missing project gives, which is
 * invariant 23 behaving exactly as designed and telling nobody anything.
 *
 * So none of it is asked. `connectSite` makes or reuses the identity, applies
 * the fixed scope set, issues the credential, and reports what it did. The one
 * thing it cannot do is put the credential where the site will read it, because
 * Brain holds no authorization to that deployment — that transfer is the single
 * manual step, and it is manual for a reason a person can check rather than
 * because a form was left behind.
 *
 * ---------------------------------------------------------------------------
 * Connected is a reading, never a claim
 * ---------------------------------------------------------------------------
 *
 * §18's rule, at this boundary: having issued a credential is not the same fact
 * as the site having used it. `verified` is `credential.lastUsedAt`, which is
 * written by the authenticator when a request actually authenticated, and the
 * record and command counts come from rows the site itself caused. A site that
 * holds a credential nobody has presented reads `AWAITING_FIRST_CALL`, and that
 * is the honest answer rather than a hopeful one.
 *
 * Nothing here is a second authorization model. Every mutation is called from a
 * route behind `requirePerson` and `decideProjectAccess`, which refuses a worker
 * principal by type — a machine that could issue itself a site credential is
 * precisely what §22 was protecting against, and this is a stronger guard than
 * the console's administrator check because it is the same one the rest of the
 * surface is already tested for.
 */
import { EXTERNAL_SOURCE_SYSTEMS, SITE_CONNECTOR_SCOPES } from '../../domain/types.ts';
import {
  createWorker,
  getMembership,
  getWorker,
  getWorkerByName,
  grantMembership,
  issueWorkerCredential,
  listCredentials,
  recordIdentityEvent,
  revokeCredentialsForWorker,
  revokeMembership,
  setWorkerStatus,
} from '../../repos/identity.ts';
import {
  countExternalRecords,
  listExternalRecords,
  listRejections,
} from '../../repos/externalRecords.ts';
import type {
  ExternalSourceSystem,
  User,
  WorkerScope,
} from '../../domain/types.ts';

/* ------------------------------------------------------------------------ *
 * What a site is, in code
 * ------------------------------------------------------------------------ */

/**
 * One entry per site Brain knows how to be a window for.
 *
 * The worker name is derived here and nowhere else. It used to be typed into a
 * form, which meant two Brains could disagree about what Deal Dispatch's worker
 * is called and a repair could quietly make a second identity beside the first.
 */
export interface SiteDefinition {
  system: ExternalSourceSystem;
  /** What a person calls it. */
  name: string;
  /** The canonical worker name. Lower case letters, digits and hyphens. */
  workerName: string;
  /** The path segment the site's own connector uses. */
  slug: string;
  /** What the site is, in one sentence, for somebody who has not met it. */
  description: string;
  /** The variables the site needs, named so the instruction is exact. */
  variables: { url: string; token: string; project: string };
}

export const SITE_DEFINITIONS: Record<ExternalSourceSystem, SiteDefinition> = {
  DEAL_DISPATCH: {
    system: 'DEAL_DISPATCH',
    name: 'Deal Dispatch',
    workerName: 'deal-dispatch',
    slug: 'deal-dispatch',
    description:
      'The opportunity site. It registers its own records with Brain, shows what Brain ' +
      'makes of them, and can ask Brain to research one further.',
    variables: { url: 'BRAIN_URL', token: 'BRAIN_TOKEN', project: 'BRAIN_PROJECT_ID' },
  },
};

export function siteDefinitions(): SiteDefinition[] {
  return EXTERNAL_SOURCE_SYSTEMS.map((system) => SITE_DEFINITIONS[system]);
}

export function isKnownSite(value: string): value is ExternalSourceSystem {
  const normalized = value.replace(/-/g, '_').toUpperCase();
  return (EXTERNAL_SOURCE_SYSTEMS as readonly string[]).includes(normalized);
}

export function siteFor(value: string): SiteDefinition {
  const normalized = value.replace(/-/g, '_').toUpperCase();
  if (!isKnownSite(normalized)) throw new UnknownSite(value);
  return SITE_DEFINITIONS[normalized as ExternalSourceSystem];
}

export class UnknownSite extends Error {
  constructor(value: string) {
    super(`No site called ${value}.`);
    this.name = 'UnknownSite';
  }
}

/* ------------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------------ */

/**
 * The five answers, and each one has a different next step.
 *
 * `NOT_CONNECTED` and `AWAITING_FIRST_CALL` are deliberately different: the
 * first means nothing has been issued, the second means Brain's half is done
 * and the credential has not reached the site yet. Collapsing them would leave
 * a person pressing Connect again against a Brain that was already ready.
 */
export type SiteConnectionState =
  | 'NOT_CONNECTED'
  | 'AWAITING_FIRST_CALL'
  | 'CONNECTED'
  | 'NEEDS_REPAIR'
  | 'DISCONNECTED';

export interface SiteStatus {
  system: ExternalSourceSystem;
  name: string;
  slug: string;
  description: string;
  variables: SiteDefinition['variables'];
  state: SiteConnectionState;
  /** One sentence saying what that state means here. Composed by the server. */
  stateReason: string;
  /** The identity, by name and id. Never a credential. */
  workerName: string;
  workerId: string | null;
  /** Whether the membership carries exactly the site scope set. */
  scopes: WorkerScope[] | null;
  scopesCorrect: boolean;
  liveCredentials: number;
  /** When a credential of this site last authenticated a request. */
  lastUsedAt: string | null;
  /** What the site has actually done, from rows it caused. */
  records: number;
  rejections: number;
  lastDeliveryAt: string | null;
  lastCommandAt: string | null;
}

function wanted(): string {
  return [...SITE_CONNECTOR_SCOPES].slice().sort().join(',');
}

async function statusOf(projectId: string, site: SiteDefinition): Promise<SiteStatus> {
  const worker = await getWorkerByName(site.workerName);
  const membership = worker ? await getMembership(projectId, 'WORKER', worker.id) : null;
  const live = membership && !membership.revokedAt ? membership : null;
  const scopes = live ? [...live.scopes] : null;
  const scopesCorrect = scopes !== null && scopes.slice().sort().join(',') === wanted();

  const credentials = worker ? await listCredentials(worker.id) : [];
  const liveCredentials = credentials.filter((credential) => !credential.revokedAt);
  const lastUsedAt = liveCredentials
    .map((credential) => credential.lastUsedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1) ?? null;

  const records = await countExternalRecords({ projectId, sourceSystem: site.system });
  const rejections = (await listRejections({ projectId, limit: 200 })).filter(
    (rejection) => rejection.sourceSystem === site.system,
  ).length;

  /*
   * The two timestamps come from the records themselves rather than from a
   * counter, so they cannot drift from what the site actually did. `updated_at`
   * only moves when a delivery changed something (§25: identical content is not
   * a write), which is exactly what "last delivery" should mean.
   */
  const recent = await listExternalRecords({
    projectId,
    sourceSystem: site.system,
    limit: 500,
  });
  const lastDeliveryAt = recent.map((r) => r.updatedAt).sort().at(-1) ?? null;
  const lastCommandAt =
    recent
      .map((r) => r.commandedAt)
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1) ?? null;

  const disabled = worker !== null && worker.disabledAt !== null;
  const state: SiteConnectionState = (() => {
    if (!worker || (!live && liveCredentials.length === 0 && records === 0)) return 'NOT_CONNECTED';
    if (disabled || !live) return 'DISCONNECTED';
    if (!scopesCorrect) return 'NEEDS_REPAIR';
    if (liveCredentials.length === 0) return 'DISCONNECTED';
    if (!lastUsedAt) return 'AWAITING_FIRST_CALL';
    return 'CONNECTED';
  })();

  const stateReason = ((): string => {
    switch (state) {
      case 'NOT_CONNECTED':
        return `${site.name} has never been connected to this project.`;
      case 'AWAITING_FIRST_CALL':
        return `Brain is ready and ${site.name} has not called yet. It will once ${site.variables.token} reaches it.`;
      case 'CONNECTED':
        return `${site.name} last authenticated at ${lastUsedAt}. Brain holds ${records} of its records.`;
      case 'NEEDS_REPAIR':
        return `${site.name}'s access does not carry the right permissions, so every call it makes is refused. Reconnecting repairs it.`;
      case 'DISCONNECTED':
        return `${site.name} was connected and cannot reach Brain now. Brain still holds ${records} of its records.`;
    }
  })();

  return {
    system: site.system,
    name: site.name,
    slug: site.slug,
    description: site.description,
    variables: site.variables,
    state,
    stateReason,
    workerName: site.workerName,
    workerId: worker?.id ?? null,
    scopes,
    scopesCorrect,
    liveCredentials: liveCredentials.length,
    lastUsedAt,
    records,
    rejections,
    lastDeliveryAt,
    lastCommandAt,
  };
}

/** Every site Brain knows about, with what it is doing on this project. */
export async function listConnectedSites(projectId: string): Promise<SiteStatus[]> {
  const out: SiteStatus[] = [];
  for (const site of siteDefinitions()) out.push(await statusOf(projectId, site));
  return out;
}

export async function siteStatus(
  projectId: string,
  system: ExternalSourceSystem,
): Promise<SiteStatus> {
  return await statusOf(projectId, SITE_DEFINITIONS[system]);
}

/* ------------------------------------------------------------------------ *
 * The one action
 * ------------------------------------------------------------------------ */

export interface ConnectResult {
  status: SiteStatus;
  /**
   * Shown exactly once, in this response, and never stored anywhere in a form
   * it can be recovered from. Not persisted, not logged, not in any event row.
   */
  secret: string;
  /** What actually happened, so the interface can say it rather than guess. */
  createdIdentity: boolean;
  repairedScopes: boolean;
  revokedCredentials: number;
  /** The exact instruction for the one step Brain cannot take itself. */
  instruction: {
    reason: string;
    variables: { name: string; value: string | null; secret: boolean }[];
  };
}

/**
 * Connect a site, or rotate what it holds. One call, and it is idempotent about
 * identity while never being idempotent about a secret.
 *
 * The identity is made or reused; the scope set is written from the constant
 * every time, which is what makes this a repair as well as a setup; every
 * existing credential is revoked and exactly one is issued, so "connect again"
 * and "rotate" are the same operation and there is never more than one live
 * credential to reason about.
 *
 * Revoking first is deliberate. Two live credentials would mean a site that
 * silently kept working on the old one after somebody rotated because they
 * believed the old one was compromised.
 */
export async function connectSite(input: {
  projectId: string;
  system: ExternalSourceSystem;
  actor: User;
  brainUrl: string | null;
}): Promise<ConnectResult> {
  const site = SITE_DEFINITIONS[input.system];
  const before = await statusOf(input.projectId, site);

  const existing = await getWorkerByName(site.workerName);
  const worker =
    existing ??
    (await createWorker({
      name: site.workerName,
      displayName: site.name,
      workerType: 'MCP',
      description: null,
      createdByType: 'HUMAN',
      createdById: input.actor.id,
    }));

  // A site that was disconnected is reconnected by the same action. An
  // archived worker is refused by `setWorkerStatus` rather than resurrected,
  // which is the rule that module already enforces and not one to work around.
  if (existing && existing.disabledAt && !existing.archived) {
    await setWorkerStatus(worker.id, 'ACTIVE');
  }

  await grantMembership({
    projectId: input.projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: [...SITE_CONNECTOR_SCOPES],
    grantedByType: 'HUMAN',
    grantedById: input.actor.id,
  });

  const live = (await listCredentials(worker.id)).filter((c) => !c.revokedAt);
  const revoked = await revokeCredentialsForWorker(
    worker.id,
    'Replaced when the site was connected again.',
  );

  const issued = await issueWorkerCredential({
    workerId: worker.id,
    issuedByType: 'HUMAN',
    issuedById: input.actor.id,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actor.id,
    action: 'CONNECT_SITE',
    targetType: 'WORKER',
    targetId: worker.id,
    projectId: input.projectId,
    result: 'SUCCESS',
    // The site, the project, the scope set and the credential *id*. Never the
    // credential, and never anything it could be reconstructed from.
    metadata: {
      projectId: input.projectId,
      system: site.system,
      scopes: wanted(),
      credentialId: issued.credential.id,
      revoked,
      createdIdentity: existing === null,
    },
  });

  const status = await statusOf(input.projectId, site);
  return {
    status,
    secret: issued.plaintext,
    createdIdentity: existing === null,
    repairedScopes: before.workerId !== null && !before.scopesCorrect,
    revokedCredentials: revoked,
    instruction: {
      reason:
        `Brain holds no authorization to ${site.name}'s deployment, so it cannot install this ` +
        'itself. Paste the value into the site and save it nowhere else — it is shown once and ' +
        'is not recoverable afterwards by anyone, including an administrator.',
      variables: [
        { name: site.variables.url, value: input.brainUrl, secret: false },
        { name: site.variables.token, value: null, secret: true },
        { name: site.variables.project, value: input.projectId, secret: false },
      ],
    },
  };
}

/**
 * Take it away.
 *
 * Revoking is not deleting. The worker keeps its row, the membership is marked
 * revoked rather than removed, every credential keeps its digest and its
 * history, and every record the site ever delivered stays exactly where it is —
 * §5, and §25's rule that Brain owns what Brain derives. What changes is that
 * nothing the site presents authenticates any more.
 */
export async function disconnectSite(input: {
  projectId: string;
  system: ExternalSourceSystem;
  actor: User;
  reason: string | null;
}): Promise<SiteStatus> {
  const site = SITE_DEFINITIONS[input.system];
  const worker = await getWorkerByName(site.workerName);
  if (!worker) return await statusOf(input.projectId, site);

  const revoked = await revokeCredentialsForWorker(
    worker.id,
    input.reason ?? 'The site was disconnected.',
  );
  await revokeMembership(input.projectId, 'WORKER', worker.id);

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actor.id,
    action: 'DISCONNECT_SITE',
    targetType: 'WORKER',
    targetId: worker.id,
    projectId: input.projectId,
    result: 'SUCCESS',
    metadata: {
      system: site.system,
      revoked,
      reason: input.reason,
    },
  });

  return await statusOf(input.projectId, site);
}
