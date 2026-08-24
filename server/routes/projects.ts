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

projectsRouter.get(
  '/',
  handler(async () => ({ projects: await listProjects() })),
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
  }),
);
