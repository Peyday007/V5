/**
 * Document import (section 7).
 *
 * The rules that matter, in order:
 *   1. The file is stored before anything else. Originals are never lost, never
 *      overwritten and never renamed out from under the user.
 *   2. A file on disk is not a registered document (invariant 8). When the
 *      platform cannot say with confidence what a file is, it parks it in
 *      `_unfiled` and asks — it does not guess a row into the database.
 *   3. Registering a document is a state change: dependencies are re-linked and
 *      every layer is recomputed inside this call, so uploading the one missing
 *      source document is all it takes for a blocked synthesis to become ready.
 */
import path from 'node:path';
import { getDb } from '../db/database.ts';
import { buildCanonicalName, buildNames, type CanonicalNames } from '../domain/naming.ts';
import { isValidVersion, normalizeVersion, versionSortKey, waveForVersion } from '../domain/version.ts';
import type {
  Document,
  DocumentScope,
  DocumentType,
  ImportResult,
  InferenceResult,
  Layer,
  Project,
} from '../domain/types.ts';
import {
  createDocument,
  findDocumentByCanonicalName,
  findDocumentByPath,
  listDocuments,
  updateDocument,
} from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { getLayer } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { nowIso } from '../repos/util.ts';
import { refreshProjectDependencies } from './dependencies.ts';
import {
  AUTO_REGISTER_CONFIDENCE,
  inferForProjectFile,
  inferFromFilename,
  unknownResult,
} from './inference.ts';
import { recomputeProject } from './stateEngine.ts';
import { enqueueExtraction } from './documents/queue.ts';

/** Where project-wide sources live, beside the per-layer folders. */
export const PROJECT_SOURCES_FOLDER = '_project-sources';
/** Project sources are not drafts of anything, so they sort outside versions. */
export const PROJECT_SOURCE_VERSION = 'source';
export const PROJECT_SOURCE_SORT = 'zzzz.source';
import {
  objectExists,
  objectSize,
  hashBuffer,
  hashObject,
  layerSlugFromPath,
  relocateFile,
  storeFile,
  type StoredFile,
  assertInsideProjectDocuments,
} from './storage.ts';

export interface ImportFileInput {
  projectId: string;
  originalFilename: string;
  contents: Buffer;
  layerId?: string | null;
  version?: string | null;
  documentType?: DocumentType | null;
  notes?: string | null;
}

export interface ResolveImportInput {
  projectId: string;
  relativePath: string;
  layerId: string;
  version: string;
  documentType: DocumentType;
  notes?: string | null;
}

export interface RegisterExistingFileInput {
  projectId: string;
  relativePath: string;
  layerId?: string | null;
  version?: string | null;
  documentType?: DocumentType | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function requireProject(projectId: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}

async function requireLayer(project: Project, layerId: string): Promise<Layer> {
  const layer = await getLayer(layerId);
  if (!layer || layer.projectId !== project.id) {
    throw new Error(`Layer ${layerId} does not belong to project ${project.name}.`);
  }
  return layer;
}

function extensionFor(filename: string): string {
  return /(\.[A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase() ?? '.pdf';
}

/** Duplicate detection is by content, not by name: the same PDF renamed is still the same PDF. */
async function findDocumentByHash(projectId: string, hash: string): Promise<Document | null> {
  const matches = (await listDocuments(projectId)).filter((document) => document.fileHash === hash);
  return matches.find((document) => objectExists(document.filesystemPath)) ?? matches[0] ?? null;
}

/**
 * A canonical name is a unique address, so a replacement cannot simply reuse it.
 * The previous document keeps its file and its history under a marked name and
 * points forward at its replacement.
 */
async function supersededNameFor(projectId: string, canonicalName: string): Promise<string> {
  for (let attempt = 1; attempt < 500; attempt += 1) {
    const candidate = `${canonicalName} (superseded ${attempt})`;
    if (!await findDocumentByCanonicalName(projectId, candidate)) return candidate;
  }
  return `${canonicalName} (superseded ${Date.now()})`;
}

function result(input: {
  filename: string;
  storedPath: string | null;
  inference: InferenceResult;
  documentId: string | null;
  registered: boolean;
  requiresConfirmation: boolean;
  message: string;
  duplicateOfDocumentId?: string | null;
}): ImportResult {
  return {
    filename: input.filename,
    storedPath: input.storedPath,
    inference: input.inference,
    documentId: input.documentId,
    registered: input.registered,
    requiresConfirmation: input.requiresConfirmation,
    message: input.message,
    duplicateOfDocumentId: input.duplicateOfDocumentId ?? null,
  };
}

/** The inference block returned to the caller, corrected by whatever the caller pinned. */
function resolvedInference(
  base: InferenceResult,
  layer: Layer | null,
  version: string | null,
  documentType: DocumentType | null,
  extraReasons: string[],
): InferenceResult {
  const layerId = layer?.id ?? null;
  const pinned = layerId !== base.layerId || version !== base.version;
  return {
    layerId,
    layerName: layer?.name ?? null,
    version,
    documentType: documentType ?? base.documentType,
    canonicalName: layer && version ? buildCanonicalName(layer.name, version) : null,
    wave: base.wave,
    confidence: pinned ? 1 : base.confidence,
    reasons: [...base.reasons, ...extraReasons],
    ambiguous: pinned ? false : base.ambiguous,
  };
}

interface RegistrationInput {
  project: Project;
  layer: Layer;
  version: string;
  documentType: DocumentType;
  names: CanonicalNames;
  stored: StoredFile;
  notes: string | null;
  origin: string;
  originalFilename: string;
}

interface Registration {
  document: Document;
  superseded: Document | null;
  /** The document was already expected (planned by a run) and this upload completed it. */
  filled: boolean;
}

/**
 * Create — or complete — the document row for an already-stored file.
 *
 * A canonical name is an address, so an upload that lands on one already in use
 * has two honest outcomes. If the existing document is only *expected* (a run
 * planned it and it has no file yet) this upload is the artifact it was waiting
 * for, and the row is completed in place so the run keeps pointing at it. If the
 * existing document already has a real file, that file and its history are kept
 * and the new upload supersedes it. Nothing is ever overwritten either way.
 * Invariant 3: every branch is recorded as an event.
 */
async function registerStoredDocument(input: RegistrationInput): Promise<Registration> {
  const { project, layer, names, stored } = input;
  return getDb().transaction<Registration>(async () => {
    const previous = await findDocumentByCanonicalName(project.id, names.canonicalName);

    if (previous && !(previous.filesystemPath && await objectExists(previous.filesystemPath))) {
      const filled =
        await updateDocument(previous.id, {
          layerId: layer.id,
          version: input.version,
          versionSort: versionSortKey(input.version),
          wave: waveForVersion(input.version, project.versionPolicy),
          documentType: input.documentType,
          status: 'COMPLETE',
          filename: stored.filename,
          filesystemPath: stored.relativePath,
          fileSize: stored.size,
          fileHash: stored.hash,
          fileMissing: false,
          conversationTitle: names.conversationTitle,
          notes: input.notes ?? undefined,
          importedAt: nowIso(),
        }) ?? previous;

      await recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'DOCUMENT',
        entityId: filled.id,
        eventType: 'DOCUMENT_COMPLETED',
        payload: {
          canonicalName: filled.canonicalName,
          previousStatus: previous.status,
          origin: input.origin,
        },
      });
      await recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'DOCUMENT',
        entityId: filled.id,
        eventType: 'DOCUMENT_IMPORTED',
        payload: {
          canonicalName: filled.canonicalName,
          originalFilename: input.originalFilename,
          storedPath: stored.relativePath,
          filename: stored.filename,
          fileHash: stored.hash,
          fileSize: stored.size,
          origin: input.origin,
          completedExpectedDocument: true,
          registered: true,
        },
      });
      return { document: filled, superseded: null, filled: true };
    }

    let superseded: Document | null = null;
    if (previous) {
      superseded =
        await updateDocument(previous.id, {
          canonicalName: await supersededNameFor(project.id, names.canonicalName),
          status: 'SUPERSEDED',
        }) ?? previous;
    }

    const document = await createDocument({
      projectId: project.id,
      layerId: layer.id,
      canonicalName: names.canonicalName,
      version: input.version,
      versionSort: versionSortKey(input.version),
      wave: waveForVersion(input.version, project.versionPolicy),
      documentType: input.documentType,
      status: 'COMPLETE',
      filename: stored.filename,
      filesystemPath: stored.relativePath,
      fileSize: stored.size,
      fileHash: stored.hash,
      conversationTitle: names.conversationTitle,
      parentDocumentId: superseded?.id ?? null,
      notes: input.notes,
      importedAt: nowIso(),
    });

    if (superseded) {
      await updateDocument(superseded.id, { supersededByDocumentId: document.id });
      await recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'DOCUMENT',
        entityId: superseded.id,
        eventType: 'DOCUMENT_SUPERSEDED',
        payload: {
          canonicalName: names.canonicalName,
          supersededBy: document.id,
          keptAs: superseded.canonicalName,
          keptFile: superseded.filesystemPath,
        },
      });
    }

    await recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'DOCUMENT',
      entityId: document.id,
      eventType: 'DOCUMENT_CREATED',
      payload: {
        canonicalName: document.canonicalName,
        version: document.version,
        documentType: document.documentType,
        origin: input.origin,
      },
    });
    await recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'DOCUMENT',
      entityId: document.id,
      eventType: 'DOCUMENT_IMPORTED',
      payload: {
        canonicalName: document.canonicalName,
        originalFilename: input.originalFilename,
        storedPath: stored.relativePath,
        filename: stored.filename,
        fileHash: stored.hash,
        fileSize: stored.size,
        origin: input.origin,
        registered: true,
      },
    });

    return { document, superseded, filled: false };
  });
}

/**
 * The whole point of importing inside the platform rather than copying a file
 * into a folder: state is recalculated immediately, so the planner's answer to
 * "what next?" changes the moment the missing document arrives.
 */
async function recomputeAfterRegistration(projectId: string): Promise<void> {
  await refreshProjectDependencies(projectId);
  await recomputeProject(projectId);
}

/**
 * Reading the document is queued rather than awaited: a fifty-page PDF takes
 * seconds and OCR can take minutes, and the import response should not wait for
 * either. The document reports QUEUED until the run finishes, so it is never
 * mistaken for readable evidence in the meantime.
 */
function scheduleExtraction(documentId: string | null): void {
  if (!documentId) return;
  void enqueueExtraction(documentId);
}

function describeRegistration(registration: Registration): string {
  if (registration.filled) return ' It completed the document that was already expected here.';
  return registration.superseded
    ? ` The previous version was kept as "${registration.superseded.canonicalName}" — nothing was overwritten.`
    : '';
}

// ---------------------------------------------------------------------------
// importFile
// ---------------------------------------------------------------------------

/**
 * Always stores the file. Registers it when the caller supplied the metadata or
 * the inference is confident enough; otherwise parks it in `_unfiled` and asks
 * for confirmation.
 */
/**
 * Register a file as a project-wide source rather than a layer document.
 *
 * The case this exists for is the master transcript. Ordinary import asks "which
 * layer is this?" and stores the file unregistered when the filename cannot
 * answer — which is how `conversation_transcript_best_effort.txt` ended up in
 * `_unfiled` with nothing read. A project source has no single layer by
 * definition, so it is registered with none, and the layers it touches are
 * discovered from its contents and proposed as links afterwards.
 *
 * It still becomes a real document: one row, one file, one extraction run, the
 * same provenance as everything else.
 */
export async function importProjectSource(input: {
  projectId: string;
  originalFilename: string;
  contents: Buffer;
  scope?: DocumentScope;
  notes?: string | null;
}): Promise<ImportResult> {
  const project = await requireProject(input.projectId);
  const originalFilename = path.basename((input.originalFilename || '').trim() || 'source.txt');
  const hash = hashBuffer(input.contents);

  const duplicate = await duplicateSource(project.id, originalFilename, hash);
  if (duplicate) return duplicate;

  const stored = await storeFile({
    projectSlug: project.slug,
    layerSlug: PROJECT_SOURCES_FOLDER,
    filename: originalFilename,
    contents: input.contents,
  });

  return registerProjectSource({
    project,
    originalFilename,
    stored,
    scope: input.scope ?? 'PROJECT_MASTER_TRANSCRIPT',
    notes: input.notes ?? null,
  });
}

/**
 * Adopt a file already sitting in the project tree as a project-wide source.
 *
 * The `_unfiled` case: a file was stored months ago and never registered, and
 * now somebody wants it read. It is MOVED rather than copied, exactly as
 * confirming an ordinary import does — the same bytes, under a folder that says
 * what they are. Copying would leave two identical files on disk and a permanent
 * "unregistered file" in every reconcile from then on.
 */
export async function importProjectSourceFromFile(input: {
  projectId: string;
  relativePath: string;
  scope?: DocumentScope;
  notes?: string | null;
}): Promise<ImportResult> {
  const project = await requireProject(input.projectId);
  // Adopting relocates the file, so the path is confined first — the data root
  // also holds the database, the backups and the runtime snapshot.
  assertInsideProjectDocuments(project.slug, input.relativePath);
  if (!await objectExists(input.relativePath)) {
    throw new Error(`There is no file at ${input.relativePath} to read.`);
  }

  const originalFilename = path.basename(input.relativePath);

  const existing = await findDocumentByPath(input.relativePath);
  if (existing) {
    return result({
      filename: originalFilename,
      storedPath: input.relativePath,
      inference: unknownResult('This file is already registered.'),
      documentId: existing.id,
      registered: false,
      requiresConfirmation: false,
      message: `"${originalFilename}" is already registered as ${existing.canonicalName}.`,
      duplicateOfDocumentId: existing.id,
    });
  }

  const hash = await hashObject(input.relativePath);
  const duplicate = await duplicateSource(project.id, originalFilename, hash);
  if (duplicate) return duplicate;

  const stored = await relocateFile(
    input.relativePath,
    project.slug,
    PROJECT_SOURCES_FOLDER,
    originalFilename,
  );

  return registerProjectSource({
    project,
    originalFilename,
    stored,
    scope: input.scope ?? 'PROJECT_MASTER_TRANSCRIPT',
    notes: input.notes ?? null,
  });
}

/** One file, one row: the same bytes are never registered twice. */
async function duplicateSource(projectId: string, filename: string, hash: string): Promise<ImportResult | null> {
  const duplicate = await findDocumentByHash(projectId, hash);
  if (!duplicate || !await objectExists(duplicate.filesystemPath)) return null;
  return result({
    filename,
    storedPath: duplicate.filesystemPath,
    inference: unknownResult('This file is already registered as a project source.'),
    documentId: duplicate.id,
    registered: false,
    requiresConfirmation: false,
    message: `"${filename}" is already registered as ${duplicate.canonicalName}.`,
    duplicateOfDocumentId: duplicate.id,
  });
}

/** The row a project-wide source gets: no layer, and no place in the version order. */
async function registerProjectSource(input: {
  project: Project;
  originalFilename: string;
  stored: StoredFile;
  scope: DocumentScope;
  notes: string | null;
}): Promise<ImportResult> {
  const { project, stored } = input;

  // A project source has no version in the layer sense — it is not the first or
  // second draft of anything. It sorts outside the version ordering rather than
  // pretending to a place inside it.
  const document = await createDocument({
    projectId: project.id,
    layerId: null,
    canonicalName: input.originalFilename.replace(/\.[A-Za-z0-9]+$/, ''),
    version: PROJECT_SOURCE_VERSION,
    versionSort: PROJECT_SOURCE_SORT,
    wave: null,
    documentType: 'REFERENCE',
    status: 'COMPLETE',
    filename: stored.filename,
    filesystemPath: stored.relativePath,
    fileSize: stored.size,
    fileHash: stored.hash,
    conversationTitle: null,
    origin: 'UPLOAD',
    notes: input.notes,
    importedAt: nowIso(),
  });
  await updateDocument(document.id, { scope: input.scope });

  await recordEvent({
    projectId: project.id,
    layerId: null,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'DOCUMENT_IMPORTED',
    payload: {
      scope: input.scope,
      originalFilename: input.originalFilename,
      fileHash: stored.hash,
      registered: true,
      projectSource: true,
    },
  });

  void enqueueExtraction(document.id);

  return result({
    filename: input.originalFilename,
    storedPath: stored.relativePath,
    inference: unknownResult(
      'Registered as a project-wide source. Its layers come from its contents, not its name.',
    ),
    documentId: document.id,
    registered: true,
    requiresConfirmation: false,
    message:
      `Registered "${input.originalFilename}" as a project source. Reading it now — the layers it ` +
      'touches will be proposed from what is inside it.',
  });
}

export async function importFile(input: ImportFileInput): Promise<ImportResult> {
  const project = await requireProject(input.projectId);
  const originalFilename = path.basename((input.originalFilename || '').trim() || 'document.pdf');
  const hash = hashBuffer(input.contents);
  const inference = await inferFromFilename(project.id, originalFilename);

  // --- content already known to the platform -------------------------------
  const duplicate = await findDocumentByHash(project.id, hash);
  if (duplicate && await objectExists(duplicate.filesystemPath)) {
    await recordEvent({
      projectId: project.id,
      layerId: duplicate.layerId,
      entityType: 'DOCUMENT',
      entityId: duplicate.id,
      eventType: 'DOCUMENT_IMPORTED',
      payload: { duplicate: true, originalFilename, fileHash: hash, registered: false },
    });
    return result({
      filename: originalFilename,
      storedPath: duplicate.filesystemPath,
      inference,
      documentId: duplicate.id,
      registered: false,
      requiresConfirmation: false,
      message:
        `This is byte-for-byte the document already registered as "${duplicate.canonicalName}", ` +
        'so nothing was added. No second copy was stored.',
      duplicateOfDocumentId: duplicate.id,
    });
  }

  if (duplicate) {
    // Same content as a document whose file went missing: this is a restore.
    const layer = duplicate.layerId ? await getLayer(duplicate.layerId) : null;
    const stored = await storeFile({
      projectSlug: project.slug,
      layerSlug: layer?.slug ?? null,
      filename: duplicate.filename ?? `${duplicate.canonicalName}${extensionFor(originalFilename)}`,
      contents: input.contents,
    });
    const restored =
      await updateDocument(duplicate.id, {
        filename: stored.filename,
        filesystemPath: stored.relativePath,
        fileSize: stored.size,
        fileHash: stored.hash,
        fileMissing: false,
      }) ?? duplicate;
    await recordEvent({
      projectId: project.id,
      layerId: restored.layerId,
      entityType: 'DOCUMENT',
      entityId: restored.id,
      eventType: 'DOCUMENT_FILE_RESTORED',
      payload: { canonicalName: restored.canonicalName, storedPath: stored.relativePath },
    });
    await recordEvent({
      projectId: project.id,
      layerId: restored.layerId,
      entityType: 'DOCUMENT',
      entityId: restored.id,
      eventType: 'DOCUMENT_IMPORTED',
      payload: {
        canonicalName: restored.canonicalName,
        originalFilename,
        storedPath: stored.relativePath,
        origin: 'RESTORE',
        registered: true,
      },
    });
    await recomputeAfterRegistration(project.id);
    scheduleExtraction(restored.id);
    return result({
      filename: originalFilename,
      storedPath: stored.relativePath,
      inference,
      documentId: restored.id,
      registered: true,
      requiresConfirmation: false,
      message: `Restored the missing file for "${restored.canonicalName}" from this upload.`,
    });
  }

  // --- decide where it belongs ---------------------------------------------
  const extraReasons: string[] = [];
  let explicitLayer: Layer | null = null;
  let explicitInvalid = false;
  if (input.layerId) {
    const candidate = await getLayer(input.layerId);
    if (candidate && candidate.projectId === project.id) {
      explicitLayer = candidate;
      extraReasons.push(`The layer "${candidate.name}" was supplied with the upload.`);
    } else {
      explicitInvalid = true;
      extraReasons.push(`The supplied layer id ${input.layerId} is not a layer of this project.`);
    }
  }

  let explicitVersion: string | null = null;
  if (input.version) {
    if (isValidVersion(input.version)) {
      explicitVersion = normalizeVersion(input.version);
      extraReasons.push(`The version ${explicitVersion} was supplied with the upload.`);
    } else {
      explicitInvalid = true;
      extraReasons.push(`"${input.version}" is not a version this project understands.`);
    }
  }

  const layer = explicitLayer ?? (inference.layerId ? await getLayer(inference.layerId) : null);
  const version = explicitVersion ?? inference.version;
  const documentType = input.documentType ?? inference.documentType ?? 'REFERENCE';
  const confidentEnough =
    inference.confidence >= AUTO_REGISTER_CONFIDENCE && inference.layerId !== null && inference.version !== null;

  // Four ways a file earns automatic filing: the caller specified it outright,
  // the name alone was read confidently, the caller pinned the layer and the name
  // supplied the version, or the caller pinned the version and the name clearly
  // named a layer. Anything else is a guess, and guesses get confirmed by a human.
  // (`layer`/`version` are re-tested below so TypeScript narrows them.)
  const canRegister =
    layer !== null &&
    version !== null &&
    !explicitInvalid &&
    ((explicitLayer !== null && explicitVersion !== null) ||
      confidentEnough ||
      (explicitLayer !== null && inference.version !== null) ||
      (explicitVersion !== null && inference.layerId !== null && inference.confidence >= 0.5));

  // --- not confident: store it, register nothing (invariant 8) --------------
  if (!layer || !version || !canRegister) {
    const stored = await storeFile({
      projectSlug: project.slug,
      layerSlug: null,
      filename: originalFilename,
      contents: input.contents,
    });
    const blocker = !layer
      ? 'I could not tell which layer this belongs to'
      : !version
        ? `I matched the layer "${layer.name}" but found no version such as "v1G" in the name`
        : explicitInvalid
          ? 'the details supplied with the upload did not check out'
          : `I am only ${Math.round(inference.confidence * 100)}% sure this is "${inference.canonicalName ?? `${layer.name} ${version}`}"`;
    const outcome = resolvedInference(inference, layer, version, documentType, [
      ...extraReasons,
      'Stored under _unfiled and left unregistered until a human confirms it.',
    ]);
    await recordEvent({
      projectId: project.id,
      entityType: 'FILE',
      entityId: null,
      eventType: 'DOCUMENT_IMPORTED',
      payload: {
        originalFilename,
        storedPath: stored.relativePath,
        registered: false,
        requiresConfirmation: true,
        confidence: inference.confidence,
        reasons: outcome.reasons,
      },
    });
    return result({
      filename: originalFilename,
      storedPath: stored.relativePath,
      inference: { ...outcome, confidence: inference.confidence, ambiguous: true },
      documentId: null,
      registered: false,
      requiresConfirmation: true,
      message:
        `Stored "${originalFilename}" in _unfiled but did not register it: ${blocker}. ` +
        'Confirm the layer and version and it will be filed.',
    });
  }

  const names = buildNames(layer.name, version, extensionFor(originalFilename));

  // A frozen canonical artifact is never replaced behind the user's back (invariant 6).
  const previous = await findDocumentByCanonicalName(project.id, names.canonicalName);
  if (previous && (previous.frozen || previous.isCanonical)) {
    const stored = await storeFile({
      projectSlug: project.slug,
      layerSlug: null,
      filename: originalFilename,
      contents: input.contents,
    });
    return result({
      filename: originalFilename,
      storedPath: stored.relativePath,
      inference: resolvedInference(inference, layer, version, documentType, extraReasons),
      documentId: null,
      registered: false,
      requiresConfirmation: true,
      message:
        `"${names.canonicalName}" is frozen as the canonical artifact of ${layer.name}. ` +
        `The upload is waiting in _unfiled — reopen the layer if it really should be replaced.`,
    });
  }

  const stored = await storeFile({
    projectSlug: project.slug,
    layerSlug: layer.slug,
    filename: names.filename,
    contents: input.contents,
  });
  const registration = await registerStoredDocument({
    project,
    layer,
    version,
    documentType,
    names,
    stored,
    notes: input.notes ?? null,
    origin: 'IMPORT',
    originalFilename,
  });
  const document = registration.document;
  await recomputeAfterRegistration(project.id);
  scheduleExtraction(document.id);

  return result({
    filename: originalFilename,
    storedPath: stored.relativePath,
    inference: resolvedInference(inference, layer, version, documentType, extraReasons),
    documentId: document.id,
    registered: true,
    requiresConfirmation: false,
    message:
      `Filed as "${document.canonicalName}" in ${layer.name} (${stored.filename}).` +
      describeRegistration(registration),
  });
}

// ---------------------------------------------------------------------------
// resolveImport
// ---------------------------------------------------------------------------

/**
 * The human's answer to an ambiguous import: move the parked file into its
 * layer folder under the platform-controlled filename and register it.
 */
export async function resolveImport(input: ResolveImportInput): Promise<ImportResult> {
  const project = await requireProject(input.projectId);
  const layer = await requireLayer(project, input.layerId);
  if (!isValidVersion(input.version)) {
    throw new Error(`"${input.version}" is not a version this project understands.`);
  }
  const version = normalizeVersion(input.version);
  // The caller supplies this path, and confirming an import MOVES the file.
  // Confine it to the project's own documents tree so nothing outside it — the
  // database included — can be relocated.
  assertInsideProjectDocuments(project.slug, input.relativePath);
  if (!await objectExists(input.relativePath)) {
    throw new Error(`There is no file at ${input.relativePath} to confirm.`);
  }

  const filename = path.basename(input.relativePath);
  const inference = await inferForProjectFile(project.id, project.slug, input.relativePath);
  const confirmed = resolvedInference(inference, layer, version, input.documentType, [
    `Confirmed by the user as "${layer.name} ${version}".`,
  ]);

  const alreadyRegistered = await findDocumentByPath(input.relativePath);
  if (alreadyRegistered) {
    return result({
      filename,
      storedPath: input.relativePath,
      inference: confirmed,
      documentId: alreadyRegistered.id,
      registered: true,
      requiresConfirmation: false,
      message: `That file is already registered as "${alreadyRegistered.canonicalName}".`,
    });
  }

  const hash = await hashObject(input.relativePath);
  const duplicate = await findDocumentByHash(project.id, hash);
  if (duplicate && await objectExists(duplicate.filesystemPath)) {
    return result({
      filename,
      storedPath: input.relativePath,
      inference: confirmed,
      documentId: duplicate.id,
      registered: false,
      requiresConfirmation: false,
      message:
        `That file is byte-for-byte "${duplicate.canonicalName}", which is already registered. ` +
        'It was left where it is rather than registered twice.',
      duplicateOfDocumentId: duplicate.id,
    });
  }

  const names = buildNames(layer.name, version, extensionFor(filename));
  const previous = await findDocumentByCanonicalName(project.id, names.canonicalName);
  if (previous && (previous.frozen || previous.isCanonical)) {
    return result({
      filename,
      storedPath: input.relativePath,
      inference: confirmed,
      documentId: null,
      registered: false,
      requiresConfirmation: true,
      message:
        `"${names.canonicalName}" is frozen as the canonical artifact of ${layer.name}. ` +
        'Reopen the layer before replacing it; the file has been left untouched.',
    });
  }

  const stored = await relocateFile(input.relativePath, project.slug, layer.slug, names.filename);
  const registration = await registerStoredDocument({
    project,
    layer,
    version,
    documentType: input.documentType,
    names,
    stored,
    notes: input.notes ?? null,
    origin: 'RESOLVE',
    originalFilename: filename,
  });
  const document = registration.document;
  await recomputeAfterRegistration(project.id);
  scheduleExtraction(document.id);

  return result({
    filename,
    storedPath: stored.relativePath,
    inference: confirmed,
    documentId: document.id,
    registered: true,
    requiresConfirmation: false,
    message:
      `Filed "${filename}" as "${document.canonicalName}" in ${layer.name} (${stored.filename}).` +
      describeRegistration(registration),
  });
}

// ---------------------------------------------------------------------------
// registerExistingFile
// ---------------------------------------------------------------------------

/**
 * Register a file that is already sitting in the project tree — the fix SCAN &
 * RECONCILE offers for a document someone dropped into a layer folder by hand.
 */
export async function registerExistingFile(input: RegisterExistingFileInput): Promise<ImportResult> {
  const project = await requireProject(input.projectId);
  // Same confinement as resolveImport: registering also relocates the file.
  assertInsideProjectDocuments(project.slug, input.relativePath);
  if (!await objectExists(input.relativePath)) {
    throw new Error(`There is no file at ${input.relativePath}.`);
  }
  const filename = path.basename(input.relativePath);
  const inference = await inferForProjectFile(project.id, project.slug, input.relativePath);

  const existing = await findDocumentByPath(input.relativePath);
  if (existing) {
    return result({
      filename,
      storedPath: input.relativePath,
      inference,
      documentId: existing.id,
      registered: true,
      requiresConfirmation: false,
      message: `Already registered as "${existing.canonicalName}".`,
    });
  }

  const hash = await hashObject(input.relativePath);
  const duplicate = await findDocumentByHash(project.id, hash);
  if (duplicate && await objectExists(duplicate.filesystemPath)) {
    return result({
      filename,
      storedPath: input.relativePath,
      inference,
      documentId: duplicate.id,
      registered: false,
      requiresConfirmation: false,
      message:
        `This file is a byte-for-byte copy of "${duplicate.canonicalName}". ` +
        'It was left in place rather than registered a second time.',
      duplicateOfDocumentId: duplicate.id,
    });
  }

  const extraReasons: string[] = [];
  let layer: Layer | null = null;
  if (input.layerId) {
    layer = await requireLayer(project, input.layerId);
    extraReasons.push(`The layer "${layer.name}" was chosen by the user.`);
  } else if (inference.layerId) {
    layer = await getLayer(inference.layerId);
  }

  let version: string | null = inference.version;
  if (input.version) {
    if (!isValidVersion(input.version)) {
      throw new Error(`"${input.version}" is not a version this project understands.`);
    }
    version = normalizeVersion(input.version);
    extraReasons.push(`The version ${version} was chosen by the user.`);
  }
  const documentType = input.documentType ?? inference.documentType ?? 'REFERENCE';
  const explicit = Boolean(input.layerId) || Boolean(input.version);

  if (!layer || !version || (!explicit && inference.confidence < AUTO_REGISTER_CONFIDENCE)) {
    const outcome = resolvedInference(inference, layer, version, documentType, [
      ...extraReasons,
      'Left exactly where it is until the layer and version are confirmed.',
    ]);
    return result({
      filename,
      storedPath: input.relativePath,
      inference: { ...outcome, confidence: explicit ? outcome.confidence : inference.confidence, ambiguous: true },
      documentId: null,
      registered: false,
      requiresConfirmation: true,
      message: !layer
        ? `Could not tell which layer "${filename}" belongs to. Choose one and it will be registered.`
        : !version
          ? `Could not find a version in "${filename}". Supply one and it will be registered as part of ${layer.name}.`
          : `Not confident enough to register "${filename}" as "${layer.name} ${version}". Confirm it first.`,
    });
  }

  const names = buildNames(layer.name, version, extensionFor(filename));
  const previous = await findDocumentByCanonicalName(project.id, names.canonicalName);
  if (previous && (previous.frozen || previous.isCanonical)) {
    return result({
      filename,
      storedPath: input.relativePath,
      inference: resolvedInference(inference, layer, version, documentType, extraReasons),
      documentId: null,
      registered: false,
      requiresConfirmation: true,
      message:
        `"${names.canonicalName}" is frozen as the canonical artifact of ${layer.name}, ` +
        'so this file was left untouched. Reopen the layer to replace it.',
    });
  }

  // Only move the file when it is not already in the right place under the right name.
  const inRightPlace =
    layerSlugFromPath(project.slug, input.relativePath) === layer.slug && filename === names.filename;
  const stored: StoredFile = inRightPlace
    ? {
        storageKey: input.relativePath,
        absolutePath: null,
        relativePath: input.relativePath,
        filename,
        size: (await objectSize(input.relativePath)) ?? 0,
        hash,
      }
    : await relocateFile(input.relativePath, project.slug, layer.slug, names.filename);

  const registration = await registerStoredDocument({
    project,
    layer,
    version,
    documentType,
    names,
    stored,
    notes: null,
    origin: 'RECONCILE',
    originalFilename: filename,
  });
  const document = registration.document;
  await recomputeAfterRegistration(project.id);
  scheduleExtraction(document.id);

  return result({
    filename,
    storedPath: stored.relativePath,
    inference: resolvedInference(inference, layer, version, documentType, extraReasons),
    documentId: document.id,
    registered: true,
    requiresConfirmation: false,
    message:
      `Registered "${filename}" as "${document.canonicalName}" in ${layer.name}.` +
      describeRegistration(registration),
  });
}
