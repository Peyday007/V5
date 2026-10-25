/**
 * The work register's door.
 *
 * ---------------------------------------------------------------------------
 * Who may do what
 * ---------------------------------------------------------------------------
 *
 * Every route calls `requirePerson`, so a **worker principal is refused by
 * type** — reads included. §22's split says a machine cannot create its own
 * work, and a register is precisely a statement about what work exists; a
 * worker that could write one could describe work nobody asked for and have it
 * read back as the plan.
 *
 * Scope is settled before the query, never filtered after. The projects a
 * caller may read come from `decideProjectAccess` — the same module every other
 * route resolves through, because a second place that works out access is how a
 * second and weaker security model appears. A Brain-wide workstream (one with
 * no project) is readable by anybody who may read the register at all: it is
 * about the platform rather than about somebody's private operation.
 *
 * Writing a workstream into a project requires `WRITE` on that project, decided
 * the same way. There is no register policy module and there must never be one.
 *
 * ---------------------------------------------------------------------------
 * What reading does
 * ---------------------------------------------------------------------------
 *
 * Nothing. No enqueue, no claim, no fire, no campaign, no credential. The view
 * reads `workstreams`, `workstream_links` and the rows those point at, and
 * derives the rest on the way out.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  pathId,
  requiredEnum,
  requiredString,
  optionalString,
  optionalRecord,
  requirePerson,
} from './helpers.ts';
import {
  LINK_KINDS,
  LINK_RELATIONS,
  WORKSTREAM_PURPOSES,
  type LinkKind,
  type LinkRelation,
  type WorkstreamPurpose,
} from '../domain/register.ts';
import {
  archiveWorkstream,
  createWorkstream,
  getWorkstream,
  linkWorkstream,
  listLinks,
  listWorkstreamEvents,
  recordWorkstreamEvent,
  supersedeLink,
  updateWorkstream,
} from '../repos/register.ts';
import { assembleRegister, viewOf } from '../services/register/view.ts';
import { ATTESTATION_DETAIL_KEYS } from '../services/register/resolve.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import { listProjects } from '../repos/projects.ts';
import type { Principal } from '../domain/types.ts';

export const registerRouter: Router = Router();

/**
 * A caller's own `detail` object, with the fields an attestation reading
 * depends on removed.
 *
 * `readAttested` in `services/register/resolve.ts` trusts `detail.attestedBy`,
 * `detail.attestedAt`, `detail.merged`, `detail.verifiedLive` and
 * `detail.state` as a fact somebody or something observed and recorded. This
 * route accepts a request body from any authenticated person with WRITE, so
 * passing those fields through verbatim would let that caller name any
 * attester — including `pull-request-merge-observation`, the name Brain's own
 * forge observation uses — at any timestamp, and have the register read
 * VERIFIED_LIVE or MERGED on the strength of it. §43 says an attestation names
 * who and when; it must never say whoever and whenever the caller typed.
 *
 * Brain's own writers (`attestCampaignPullRequest`,
 * `observeCampaignPullRequestMerge`) call `linkWorkstream` directly and never
 * pass through this route, so they are untouched by this stripping.
 */
function stripAttestation(detail: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...detail };
  for (const key of ATTESTATION_DETAIL_KEYS) {
    delete clean[key];
  }
  return clean;
}

/**
 * The projects this caller may read, from the policy module.
 *
 * A copy of `search.ts`'s helper on purpose rather than an import: both are
 * three lines over `decideProjectAccess`, and the thing that must not be
 * duplicated is the *decision*, which neither of them makes.
 */
async function readableProjectIds(principal: Principal): Promise<string[]> {
  const all = await listProjects();
  return all
    .filter((project) => decideProjectAccess(principal, project.id, 'READ').allowed)
    .map((project) => project.id);
}

/**
 * May this caller write a workstream filed under this project?
 *
 * A workstream with no project is Brain-wide and needs no project decision —
 * it is about the platform. One filed under a project is a statement about that
 * project's work, so it takes `WRITE` there.
 *
 * The refusal is a 404 with the same body a missing project gives (invariant
 * 23): a distinguishable refusal is an oracle for enumerating a Brain you have
 * no access to.
 */
async function authorizeWrite(principal: Principal, projectId: string | null): Promise<void> {
  if (projectId === null) return;
  if (!decideProjectAccess(principal, projectId, 'WRITE').allowed) {
    throw notFound('No such project.');
  }
}

/** The whole view, in one read. §29's one-projection rule at a new surface. */
registerRouter.get(
  '/register',
  handler(async (req) => {
    const principal = requirePerson();
    const includeArchived = req.query.archived === 'true';
    return await assembleRegister({
      projectIds: await readableProjectIds(principal),
      includeArchived,
    });
  }),
);

registerRouter.post(
  '/register/workstreams',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);

    const projectId = optionalString(body.projectId, 'projectId') ?? null;
    await authorizeWrite(principal, projectId);

    const workstream = await createWorkstream({
      projectId,
      title: requiredString(body.title, 'title'),
      intent: requiredString(body.intent, 'intent'),
      purpose: requiredEnum<WorkstreamPurpose>(
        body.purpose,
        WORKSTREAM_PURPOSES as readonly WorkstreamPurpose[],
        'purpose',
      ),
      createdByUserId: principal.id,
    });
    await recordWorkstreamEvent({
      workstreamId: workstream.id,
      kind: 'WORKSTREAM_OPENED',
      summary: `Opened as ${workstream.purpose}.`,
      actorRef: `person:${principal.id}`,
    });

    /*
     * Links may arrive with the workstream, so filing something the register
     * derived as unaccounted-for is one action rather than two. It is the same
     * writer as the link route below — `linkWorkstream` — because a second
     * place that records a link is a second place to get the guard wrong.
     */
    const incoming = Array.isArray(body.links) ? body.links : [];
    const links = [];
    for (const [index, entry] of incoming.entries()) {
      if (!entry || typeof entry !== 'object') {
        throw badRequest(`"links[${index}]" must be an object.`);
      }
      const one = entry as Record<string, unknown>;
      links.push(
        await linkWorkstream({
          workstreamId: workstream.id,
          kind: requiredEnum<LinkKind>(one.kind, LINK_KINDS as readonly LinkKind[], `links[${index}].kind`),
          ref: requiredString(one.ref, `links[${index}].ref`),
          relation: requiredEnum<LinkRelation>(
            one.relation,
            LINK_RELATIONS as readonly LinkRelation[],
            `links[${index}].relation`,
          ),
          label: optionalString(one.label, `links[${index}].label`) ?? null,
          detail: stripAttestation(optionalRecord(one.detail, `links[${index}].detail`) ?? {}),
          recordedBy: 'PERSON',
          recordedByUserId: principal.id,
        }),
      );
    }

    return { workstream, links };
  }),
);

/** One workstream, with every link read live. */
registerRouter.get(
  '/register/workstreams/:workstreamId',
  handler(async (req) => {
    const principal = requirePerson();
    const workstream = await requireReadable(principal, pathId(req, 'workstreamId'));
    const links = await listLinks(workstream.id, { includeSuperseded: true });
    const live = links.filter((one) => one.supersededAt === null);
    return {
      workstream: await viewOf(workstream, live),
      /*
       * Corrections are returned beside the live links rather than instead of
       * them. §5 at a register: what a workstream used to point at is how a
       * later reader tells a correction from an accident.
       */
      corrections: links.filter((one) => one.supersededAt !== null),
      events: await listWorkstreamEvents(workstream.id),
    };
  }),
);

registerRouter.patch(
  '/register/workstreams/:workstreamId',
  handler(async (req) => {
    const principal = requirePerson();
    const workstream = await requireReadable(principal, pathId(req, 'workstreamId'));
    await authorizeWrite(principal, workstream.projectId);
    const body = bodyOf(req);

    const projectId =
      body.projectId === undefined ? undefined : (optionalString(body.projectId, 'projectId') ?? null);
    if (projectId !== undefined) await authorizeWrite(principal, projectId);

    const updated = await updateWorkstream(workstream.id, {
      title: optionalString(body.title, 'title'),
      intent: optionalString(body.intent, 'intent'),
      purpose:
        body.purpose === undefined
          ? undefined
          : requiredEnum<WorkstreamPurpose>(
              body.purpose,
              WORKSTREAM_PURPOSES as readonly WorkstreamPurpose[],
              'purpose',
            ),
      projectId,
    });
    if (!updated) throw notFound('No such workstream.');
    await recordWorkstreamEvent({
      workstreamId: updated.id,
      kind: 'WORKSTREAM_AMENDED',
      summary: 'A person changed what this workstream says it is.',
      actorRef: `person:${principal.id}`,
    });
    return { workstream: updated };
  }),
);

registerRouter.post(
  '/register/workstreams/:workstreamId/links',
  handler(async (req) => {
    const principal = requirePerson();
    const workstream = await requireReadable(principal, pathId(req, 'workstreamId'));
    await authorizeWrite(principal, workstream.projectId);
    const body = bodyOf(req);

    const link = await linkWorkstream({
      workstreamId: workstream.id,
      kind: requiredEnum<LinkKind>(body.kind, LINK_KINDS as readonly LinkKind[], 'kind'),
      ref: requiredString(body.ref, 'ref'),
      relation: requiredEnum<LinkRelation>(
        body.relation,
        LINK_RELATIONS as readonly LinkRelation[],
        'relation',
      ),
      label: optionalString(body.label, 'label') ?? null,
      detail: stripAttestation(optionalRecord(body.detail, 'detail') ?? {}),
      recordedBy: 'PERSON',
      recordedByUserId: principal.id,
    });
    await recordWorkstreamEvent({
      workstreamId: workstream.id,
      kind: 'LINK_RECORDED',
      summary: `${link.kind} ${link.ref} linked as ${link.relation}.`,
      detail: { linkId: link.id },
      actorRef: `person:${principal.id}`,
    });
    return { link };
  }),
);

/**
 * Correct a link.
 *
 * A correction, never a delete: the row stays with its reason, so the register
 * can tell somebody what it used to believe and why that changed. The guard is
 * on the link still being live, in the statement that makes the change, so two
 * people correcting one link produce one correction.
 */
registerRouter.post(
  '/register/workstreams/:workstreamId/links/:linkId/supersede',
  handler(async (req) => {
    const principal = requirePerson();
    const workstream = await requireReadable(principal, pathId(req, 'workstreamId'));
    await authorizeWrite(principal, workstream.projectId);
    const linkId = pathId(req, 'linkId');
    const reason = requiredString(bodyOf(req).reason, 'reason');

    const links = await listLinks(workstream.id, { includeSuperseded: true });
    if (!links.some((one) => one.id === linkId)) throw notFound('No such link.');

    const superseded = await supersedeLink(linkId, reason);
    if (superseded) {
      await recordWorkstreamEvent({
        workstreamId: workstream.id,
        kind: 'LINK_SUPERSEDED',
        summary: reason,
        detail: { linkId },
        actorRef: `person:${principal.id}`,
      });
    }
    return { superseded, linkId };
  }),
);

registerRouter.post(
  '/register/workstreams/:workstreamId/archive',
  handler(async (req) => {
    const principal = requirePerson();
    const workstream = await requireReadable(principal, pathId(req, 'workstreamId'));
    await authorizeWrite(principal, workstream.projectId);
    const reason = requiredString(bodyOf(req).reason, 'reason');
    const archived = await archiveWorkstream(workstream.id, reason);
    if (!archived) throw notFound('No such workstream.');
    await recordWorkstreamEvent({
      workstreamId: workstream.id,
      kind: 'WORKSTREAM_ARCHIVED',
      summary: reason,
      actorRef: `person:${principal.id}`,
    });
    return { workstream: archived };
  }),
);

/**
 * Resolve a workstream this caller may read, or refuse as a miss.
 *
 * Absent and forbidden are one answer with one body, which is invariant 23 at
 * this door.
 */
async function requireReadable(principal: Principal, id: string) {
  const workstream = await getWorkstream(id);
  if (!workstream) throw notFound('No such workstream.');
  if (workstream.projectId !== null) {
    if (!decideProjectAccess(principal, workstream.projectId, 'READ').allowed) {
      throw notFound('No such workstream.');
    }
  }
  return workstream;
}
