/**
 * The door to a deliverable: its record, its files, and asking for a revision.
 *
 * Every route resolves the deliverable's project through `authorizeProject`,
 * so a deliverable in a project the caller may not read is the same 404, with
 * the same body, as one that does not exist — invariant 23 at a new door. The
 * storage key comes from the version row, never from the request.
 *
 * A version is addressed by its number and never changes, so its URL is
 * permanent: the link delivered in a conversation opens the same bytes next
 * month, after the worker session that built it is long gone. The current
 * version has its own address beside it, which moves when a later one passes.
 */
import { Router } from 'express';
import { getStorage } from '../services/storage/index.ts';
import { ObjectNotFoundError } from '../services/storage/types.ts';
import { getDeliverable, getVersion, getVersionByNumber, requestCorrection } from '../repos/deliverables.ts';
import { recordEvent } from '../repos/events.ts';
import { deliverablesForProject, viewOfDeliverable } from '../services/russell/deliverable.ts';
import { authorizeProject, badRequest, handler, notFound, pathId, requirePerson, requireProject } from './helpers.ts';
import type { Deliverable, DeliverableVersion } from '../domain/deliverables.ts';

export const deliverablesRouter = Router();

async function requireDeliverable(id: string): Promise<Deliverable> {
  const d = await getDeliverable(id);
  if (!d) throw notFound('No deliverable with that id.');
  await authorizeProject(d.projectId, 'deliverable');
  return d;
}

function attachment(filename: string): string {
  const fallback = filename.replace(/[^\u0020-\u007E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function versionNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw notFound('No deliverable with that id.');
  return n;
}

async function stream(res: import('express').Response, next: import('express').NextFunction, version: DeliverableVersion, key: string, contentType: string, disposition: string): Promise<void> {
  let object: Awaited<ReturnType<ReturnType<typeof getStorage>['openRead']>>;
  try {
    object = await getStorage().openRead(key);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw notFound(`The file for version ${version.versionNumber} is no longer in the store (expected ${key}).`);
    }
    throw error;
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', disposition);
  if (object.size > 0) res.setHeader('Content-Length', String(object.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A version's bytes never change, but a revoked membership must still be
  // re-checked on the next request, so nothing is cached.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Brain-File-Sha256', version.fileHash);
  object.stream.on('error', (error) => {
    if (res.headersSent) res.destroy(error);
    else next(error);
  });
  object.stream.pipe(res);
}

deliverablesRouter.get(
  '/projects/:projectId/deliverables',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return { deliverables: await deliverablesForProject(project.id) };
  }),
);

deliverablesRouter.get(
  '/deliverables/:deliverableId',
  handler(async (req) => {
    const d = await requireDeliverable(pathId(req, 'deliverableId'));
    return { deliverable: await viewOfDeliverable(d, true) };
  }),
);

deliverablesRouter.get(
  '/deliverables/:deliverableId/file',
  handler(async (req, res, next) => {
    const d = await requireDeliverable(pathId(req, 'deliverableId'));
    const version = d.currentVersionId ? await getVersion(d.currentVersionId) : null;
    if (!version) throw notFound('This deliverable has no version that has passed its checks yet.');
    await stream(res, next, version, version.storageKey, version.contentType, attachment(version.filename));
    return undefined;
  }),
);

deliverablesRouter.get(
  '/deliverables/:deliverableId/versions/:versionNumber/file',
  handler(async (req, res, next) => {
    const d = await requireDeliverable(pathId(req, 'deliverableId'));
    const version = await getVersionByNumber(d.id, versionNumber(pathId(req, 'versionNumber')));
    if (!version) throw notFound('No deliverable with that id.');
    await stream(res, next, version, version.storageKey, version.contentType, attachment(version.filename));
    return undefined;
  }),
);

deliverablesRouter.get(
  '/deliverables/:deliverableId/versions/:versionNumber/preview',
  handler(async (req, res, next) => {
    const d = await requireDeliverable(pathId(req, 'deliverableId'));
    const version = await getVersionByNumber(d.id, versionNumber(pathId(req, 'versionNumber')));
    if (!version || !version.previewKey) throw notFound('No deliverable with that id.');
    // The preview is HTML Brain rendered from the file. It is served inert:
    // no script, no network, nothing but its own inline styles.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    await stream(res, next, version, version.previewKey, 'text/html; charset=utf-8', 'inline; filename="preview.html"');
    return undefined;
  }),
);

/**
 * Ask for a revision from outside the conversation.
 *
 * The same effect the Russell action has — a correction recorded for the next
 * build to take — for a person looking at the deliverable rather than talking
 * about it. A person only: a worker cannot ask for its own work to be redone.
 */
deliverablesRouter.post(
  '/deliverables/:deliverableId/revise',
  handler(async (req) => {
    const principal = requirePerson();
    const d = await requireDeliverable(pathId(req, 'deliverableId'));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const correction = typeof body['correction'] === 'string' ? body['correction'].trim() : '';
    if (correction.length < 8 || correction.length > 3000) {
      throw badRequest('Say what should change, in 8 to 3000 characters.');
    }
    await requestCorrection(d.id, correction);
    await recordEvent({
      projectId: d.projectId,
      entityType: 'deliverable',
      entityId: d.id,
      eventType: 'DELIVERABLE_REVISION_REQUESTED',
      payload: { by: principal.id, correction: correction.slice(0, 500), via: 'route' },
    });
    return { deliverable: await viewOfDeliverable((await getDeliverable(d.id))!, true) };
  }),
);
