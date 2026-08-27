/**
 * Project-level API.
 *
 * This is where the user's core question — "what should I do next?" — is
 * answered, and where documents enter the platform. Every mutating route ends
 * with `recomputeProject`, so the response already carries the state the UI
 * needs to re-render and nobody has to remember to refresh anything.
 */
import { Router } from 'express';
import type {
  DocumentScope,
  DocumentType,
  ImportResult,
  ProjectStatus,
  ReconcileIssue,
  VersionPolicy,
} from '../domain/types.ts';
import {
  DEFAULT_VERSION_POLICY,
  DOCUMENT_SCOPES,
  DOCUMENT_TYPES,
  PROJECT_STATUSES,
} from '../domain/types.ts';
import { isValidVersion, normalizeVersion } from '../domain/version.ts';
import { listDocuments } from '../repos/documents.ts';
import { listEvents, recordEvent } from '../repos/events.ts';
import { listLayers } from '../repos/layers.ts';
import { listProjects, updateProject } from '../repos/projects.ts';
import { listRuns } from '../repos/runs.ts';
import {
  importFile,
  importProjectSource,
  importProjectSourceFromFile,
  resolveImport,
} from '../services/importer.ts';
import { resolveStoredFile } from '../services/storage.ts';
import { toDataRelative } from '../env.ts';
import { ingestSource } from '../services/sources/ingest.ts';
import {
  importReport,
  processArchiveImport,
  startArchiveImport,
} from '../services/archive/import.ts';
import { listImportJobs } from '../repos/imports.ts';
import { optionalBoolean } from './helpers.ts';
import { currentContext } from '../services/identity/context.ts';
import { idempotencyKeyOf, runIdempotentRequest } from '../services/effects/http.ts';
import type { OperationNamespace } from '../services/effects/engine.ts';
import { hashBuffer } from '../services/storage.ts';
import { getDocument } from '../repos/documents.ts';

/**
 * Importing is scoped to the project.
 *
 * Two people uploading the same file into the same layer mean one document, not
 * two — the existing content-hash duplicate check already believed that, and
 * this makes it true under concurrency rather than only in sequence.
 */
const IMPORT_NAMESPACE: OperationNamespace = {
  name: 'documents.import',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'EXTENDED',
};

/**
 * What an import returns, originally or on replay.
 *
 * The two differ on purpose. An original execution reports what the import
 * *did*; a replay reports what currently *exists*. Pretending a replay can
 * produce the first would mean inventing an account of an import nobody
 * watched.
 */
interface ImportReply {
  results?: ImportResult[];
  documents?: unknown[];
  plan: unknown;
}
import { currentPrincipal } from '../services/identity/context.ts';
import { visibleProjectIds } from '../services/identity/policy.ts';
import { buildPlan } from '../services/planner.ts';
import { applyReconcileFix, scanAndReconcile } from '../services/reconcile.ts';
import { recomputeProject } from '../services/stateEngine.ts';
import { writeProjectState } from '../services/runtimeState.ts';
import {
  badRequest,
  bodyOf,
  handler,
  optionalEnum,
  optionalInteger,
  optionalRecord,
  optionalString,
  nullableString,
  pathId,
  queryOf,
  requireLayerOfProject,
  requireProject,
  requiredString,
  uploadManyFiles,
  uploadedFiles,
} from './helpers.ts';

export const projectsRouter = Router();

/** The four states scan & reconcile can report; kept in sync with ReconcileIssue. */
const RECONCILE_KINDS: readonly ReconcileIssue['kind'][] = [
  'UNREGISTERED_FILE',
  'MISSING_PHYSICAL_FILE',
  'CHECKSUM_CHANGED',
  'ORPHANED_DOCUMENT',
];

/** Versions are parsed, not trusted: `v1g` is fine, `chapter two` is a 400. */
function parseVersion(value: unknown, field: string): string | undefined {
  const raw = optionalString(value, field);
  if (raw === undefined) return undefined;
  if (!isValidVersion(raw)) {
    throw badRequest(
      `"${raw}" is not a version this project understands. Expected something like v1, v1G or v3.1.`,
    );
  }
  return normalizeVersion(raw);
}

/**
 * A partial version policy merged onto the project's current one, so a client
 * can change the synthesis version without restating the whole policy.
 */
function mergeVersionPolicy(value: unknown, current: VersionPolicy): VersionPolicy | undefined {
  const patch = optionalRecord(value, 'versionPolicy');
  if (patch === undefined) return undefined;
  const base: VersionPolicy = { ...DEFAULT_VERSION_POLICY, ...current };

  const foundationVersion = parseVersion(patch['foundationVersion'], 'versionPolicy.foundationVersion');
  const synthesisVersion = parseVersion(patch['synthesisVersion'], 'versionPolicy.synthesisVersion');
  const branch = optionalString(patch['expansionStartBranch'], 'versionPolicy.expansionStartBranch');
  if (branch !== undefined && !/^[A-Za-z]{1,2}$/.test(branch)) {
    throw badRequest(
      `"${branch}" is not a valid expansion start branch. Expected one or two letters, e.g. B.`,
    );
  }
  const synthesisWave = optionalInteger(patch['synthesisWave'], 'versionPolicy.synthesisWave', {
    min: 1,
    max: 99,
  });
  const maxAutoRedos = optionalInteger(patch['maxAutoRedos'], 'versionPolicy.maxAutoRedos', {
    min: 0,
    max: 20,
  });

  return {
    foundationVersion: foundationVersion ?? base.foundationVersion,
    expansionStartBranch: branch ? branch.toUpperCase() : base.expansionStartBranch,
    synthesisVersion: synthesisVersion ?? base.synthesisVersion,
    synthesisWave: synthesisWave ?? base.synthesisWave,
    maxAutoRedos: maxAutoRedos ?? base.maxAutoRedos,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The projects this caller may see — filtered, not refused.
 *
 * Filtering rather than a 403 is the point: somebody with access to one project
 * out of five should be shown one project, and should not be able to tell that
 * there are four others. The count of what exists is itself information, and
 * "you have no access to this list" would leak that the list is non-empty.
 */
projectsRouter.get(
  '/',
  handler(async () => {
    const all = await listProjects();
    const visible = new Set(visibleProjectIds(currentPrincipal(), all.map((p) => p.id)));
    return { projects: all.filter((project) => visible.has(project.id)) };
  }),
);

projectsRouter.get(
  '/:projectId',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    // One planner pass produces both the buckets and the per-layer snapshots,
    // so the two can never disagree inside a single response.
    const plan = await buildPlan(project.id);
    return { project, layers: await listLayers(project.id), state: plan.layers, plan };
  }),
);

projectsRouter.get(
  '/:projectId/plan',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return { plan: await buildPlan(project.id) };
  }),
);

projectsRouter.get(
  '/:projectId/next-action',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const plan = await buildPlan(project.id);
    return { action: plan.nextBestAction, text: plan.nextBestActionText };
  }),
);

projectsRouter.get(
  '/:projectId/events',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const limit = optionalInteger(queryOf(req)['limit'], 'limit', { min: 1, max: 2000 }) ?? 200;
    return { events: await listEvents(project.id, limit) };
  }),
);

projectsRouter.get(
  '/:projectId/documents',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return { documents: await listDocuments(project.id) };
  }),
);

projectsRouter.get(
  '/:projectId/runs',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return { runs: await listRuns(project.id) };
  }),
);

projectsRouter.get(
  '/:projectId/runtime-state',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    // Regenerated rather than read back: the endpoint and the file on disk must
    // agree, and a stale snapshot is exactly the failure mode this file exists
    // to prevent.
    return writeProjectState(project.id);
  }),
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

projectsRouter.patch(
  '/:projectId',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const name = optionalString(body['name'], 'name');
    const description = 'description' in body ? nullableString(body['description'], 'description') : undefined;
    const northStar = 'northStar' in body ? nullableString(body['northStar'], 'northStar') : undefined;
    const currentWave = optionalInteger(body['currentWave'], 'currentWave', { min: 1, max: 99 });
    const status = optionalEnum<ProjectStatus>(body['status'], PROJECT_STATUSES, 'status');
    const versionPolicy = mergeVersionPolicy(body['versionPolicy'], project.versionPolicy);
    const settings = optionalRecord(body['settings'], 'settings');

    const updated =
      await updateProject(project.id, {
        name,
        description,
        northStar,
        currentWave,
        status,
        versionPolicy,
        settings,
      }) ?? project;

    // Invariant 3. The version policy in particular decides every layer's
    // canonical target name and the redo cap, so changing it silently would
    // leave the whole project reinterpreted with nothing in history saying why.
    const changes: Record<string, unknown> = {};
    if (name !== undefined) changes['name'] = { from: project.name, to: updated.name };
    if (description !== undefined) {
      changes['description'] = { from: project.description, to: updated.description };
    }
    if (northStar !== undefined) changes['northStar'] = { from: project.northStar, to: updated.northStar };
    if (currentWave !== undefined) changes['currentWave'] = { from: project.currentWave, to: updated.currentWave };
    if (status !== undefined) changes['status'] = { from: project.status, to: updated.status };
    if (versionPolicy !== undefined) {
      changes['versionPolicy'] = { from: project.versionPolicy, to: updated.versionPolicy };
    }
    if (settings !== undefined) changes['settings'] = { from: project.settings, to: updated.settings };
    if (Object.keys(changes).length > 0) {
      await recordEvent({
        projectId: project.id,
        entityType: 'PROJECT',
        entityId: project.id,
        eventType: 'USER_CORRECTION',
        payload: changes,
      });
    }

    // A changed version policy changes what every layer is waiting for.
    await recomputeProject(updated.id);
    return { project: await requireProject(updated.id) };
  }),
);

projectsRouter.post(
  '/:projectId/recompute',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    await recomputeProject(project.id);
    return { plan: await buildPlan(project.id) };
  }),
);

projectsRouter.post(
  '/:projectId/reconcile',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return { report: await scanAndReconcile(project.id) };
  }),
);

projectsRouter.post(
  '/:projectId/reconcile/fix',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const kind = optionalEnum<ReconcileIssue['kind']>(body['kind'], RECONCILE_KINDS, 'kind');
    if (!kind) {
      throw badRequest(`"kind" is required. Expected one of: ${RECONCILE_KINDS.join(', ')}.`);
    }

    const layerId = optionalString(body['layerId'], 'layerId');
    if (layerId) await requireLayerOfProject(layerId, project.id);

    const outcome = await applyReconcileFix({
      projectId: project.id,
      kind,
      path: optionalString(body['path'], 'path') ?? null,
      documentId: optionalString(body['documentId'], 'documentId') ?? null,
      layerId: layerId ?? null,
      version: parseVersion(body['version'], 'version') ?? null,
      documentType: optionalEnum<DocumentType>(body['documentType'], DOCUMENT_TYPES, 'documentType') ?? null,
    });

    await recomputeProject(project.id);
    return {
      ok: outcome.ok,
      message: outcome.message,
      report: outcome.report,
      plan: await buildPlan(project.id),
    };
  }),
);

projectsRouter.post(
  '/:projectId/import/resolve',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const relativePath = requiredString(body['relativePath'], 'relativePath');
    const layer = await requireLayerOfProject(requiredString(body['layerId'], 'layerId'), project.id);
    const version = parseVersion(body['version'], 'version');
    if (!version) throw badRequest('"version" is required to file a document, e.g. v1G.');
    const documentType = optionalEnum<DocumentType>(
      body['documentType'],
      DOCUMENT_TYPES,
      'documentType',
    );
    if (!documentType) {
      throw badRequest(`"documentType" is required. Expected one of: ${DOCUMENT_TYPES.join(', ')}.`);
    }

    const result = await resolveImport({
      projectId: project.id,
      relativePath,
      layerId: layer.id,
      version,
      documentType,
      notes: nullableString(body['notes'], 'notes') ?? null,
    });

    await recomputeProject(project.id);
    return { result, plan: await buildPlan(project.id) };
  }),
);

/**
 * Import a project-wide source: a transcript, a working log, anything that spans
 * layers rather than belonging to one.
 *
 * Separate from the ordinary import because the question it asks is different.
 * Ordinary import asks which layer this belongs to and stores the file
 * unregistered when the filename cannot say. A project source has no single
 * layer, so it is registered with none and read immediately; the layers it
 * touches are proposed from its contents.
 */
projectsRouter.post(
  '/:projectId/import-source',
  uploadManyFiles,
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const files = uploadedFiles(req);
    if (files.length === 0) {
      throw badRequest(
        'No files were uploaded. Send them as multipart/form-data under the field name "files".',
      );
    }
    const body = bodyOf(req);
    const scope =
      optionalEnum<DocumentScope>(body['scope'], DOCUMENT_SCOPES, 'scope') ??
      'PROJECT_MASTER_TRANSCRIPT';

    const results = [];
    for (const file of files) {
      const imported = await importProjectSource({
        projectId: project.id,
        originalFilename: file.originalname,
        contents: file.buffer,
        scope,
      });
      // Reading it is the point; an import that only stored the file is the
      // failure this endpoint exists to correct.
      const report = imported.documentId
        ? await ingestSource({ documentId: imported.documentId, scope })
        : null;
      results.push({ import: imported, report });
    }

    await recomputeProject(project.id);
    return { results, plan: await buildPlan(project.id) };
  }),
);

/**
 * Read an already-stored file that was never registered.
 *
 * Requirement 14: everything sitting in `_unfiled` from before this existed can
 * be picked up and understood without re-uploading it.
 */
projectsRouter.post(
  '/:projectId/reprocess-unfiled',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const relativePath = requiredString(body['relativePath'], 'relativePath');
    const scope =
      optionalEnum<DocumentScope>(body['scope'], DOCUMENT_SCOPES, 'scope') ??
      'PROJECT_MASTER_TRANSCRIPT';

    // Confinement: the same rule as every other path that takes one from a
    // request. A stored file is inside this project's documents or it is not
    // ours to read. The path is accepted in either of the two forms the user
    // could reasonably have: from the data root, or from the documents folder.
    const absolute = await resolveStoredFile(project.slug, relativePath);

    const imported = await importProjectSourceFromFile({
      projectId: project.id,
      relativePath: toDataRelative(absolute),
      scope,
    });
    const report = imported.documentId
      ? await ingestSource({ documentId: imported.documentId, scope })
      : null;

    await recomputeProject(project.id);
    return { import: imported, report, plan: await buildPlan(project.id) };
  }),
);

/**
 * Import an existing research archive from a folder on this machine.
 *
 * Discovery happens now and returns immediately; the reading happens on the
 * job. A folder of forty documents takes minutes, and a request that waited for
 * it would time out with the user unable to tell what had been imported.
 */
projectsRouter.post(
  '/:projectId/archive-import',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const folder = requiredString(body['folder'], 'folder');
    const scope = optionalEnum<DocumentScope>(body['scope'], DOCUMENT_SCOPES, 'scope');
    const start = optionalBoolean(body['start'], 'start') ?? true;

    const job = await startArchiveImport({
      projectId: project.id,
      folder,
      ...(scope ? { scope } : {}),
    });
    if (start && job.status === 'QUEUED') void processArchiveImport(job.id);
    return importReport(job.id);
  }),
);

projectsRouter.get(
  '/:projectId/archive-imports',
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    return { jobs: await listImportJobs(project.id) };
  }),
);

projectsRouter.post(
  '/:projectId/import',
  uploadManyFiles,
  handler(async (req) => {
    const project = await requireProject(pathId(req, 'projectId'));
    const files = uploadedFiles(req);
    if (files.length === 0) {
      throw badRequest(
        'No files were uploaded. Send them as multipart/form-data under the field name "files".',
      );
    }

    const body = bodyOf(req);
    const layerIdField = optionalString(body['layerId'], 'layerId');
    const layer = layerIdField ? await requireLayerOfProject(layerIdField, project.id) : null;
    const version = parseVersion(body['version'], 'version') ?? null;
    const documentType =
      optionalEnum<DocumentType>(body['documentType'], DOCUMENT_TYPES, 'documentType') ?? null;

    // Every file is stored even when it cannot be filed confidently (invariant 8:
    // storing is not registering), so one ambiguous name never loses an upload.
    const doImport = async (): Promise<ImportReply> => {
      const results: ImportResult[] = await Promise.all(
        files.map((file) =>
          importFile({
            projectId: project.id,
            originalFilename: file.originalname,
            contents: file.buffer,
            layerId: layer?.id ?? null,
            version,
            documentType,
          }),
        ),
      );
      await recomputeProject(project.id);
      return { results, plan: await buildPlan(project.id) };
    };

    const key = idempotencyKeyOf(req);
    if (!key) return await doImport();

    // A database-plus-Storage effect. The fingerprint is over the *content* of
    // every file rather than its name or its upload order, so the same bytes
    // filed the same way are the same operation however the browser retried —
    // and two different documents can never collide onto one key.
    const principal = currentPrincipal();
    const reply = await runIdempotentRequest<ImportReply>(
      {
        namespace: IMPORT_NAMESPACE,
        projectId: project.id,
        key,
        payload: {
          files: files
            .map((file) => ({
              name: file.originalname,
              digest: hashBuffer(file.buffer),
              bytes: file.buffer.length,
            }))
            // Sorted, because "the same two files" is the same import whichever
            // order multipart happened to deliver them in.
            .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)),
          layerId: layer?.id ?? null,
          version,
          documentType,
        },
        principalType: principal ? principal.type : 'SYSTEM',
        principalId: principal?.id ?? 'system',
        correlationId: currentContext()?.requestId ?? null,
        // Re-read the documents this import produced, through the project the
        // caller is authorized for. A stored response body would have made this
        // check impossible, which is why none is stored.
        // A replay returns the *documents*, re-read and re-authorized — not a
        // reconstructed ImportResult. An ImportResult carries what happened
        // during the import (the inference, the stored path, whether anything
        // was superseded), and that is not recoverable from the documents
        // afterwards. Fabricating those fields to make the shape match would be
        // inventing an account of an import nobody watched. The client learns
        // it is a replay and gets the canonical records instead.
        replay: async (operation) => {
          if (!operation.resultRef) return null;
          const ids = operation.resultRef.split(',').filter(Boolean);
          const found = await Promise.all(ids.map((id) => getDocument(id)));
          const visible = found.filter(
            (document) => document !== null && document.projectId === project.id,
          );
          if (visible.length !== ids.length) return null;
          return { documents: visible, plan: await buildPlan(project.id) };
        },
      },
      async () => {
        const produced = await doImport();
        return {
          // The canonical records this produced, so a replay re-reads them
          // rather than replaying a body.
          resultRef: (produced.results ?? [])
            .map((result) => (result as { document?: { id?: string } }).document?.id ?? '')
            .filter(Boolean)
            .join(','),
          resultStatus: 200,
          value: produced,
        };
      },
    );
    return { ...reply.value, replayed: reply.replayed, operationId: reply.operationId };
  }),
);
