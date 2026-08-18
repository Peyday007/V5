/**
 * Dependency checker (section 11).
 *
 * This is the guard that stands in front of every synthesis run. A source
 * packet only reads `7 / 7 READY` when every required document really exists,
 * is finished, and its artifact is still on disk.
 *
 * Invariants 8 and 9 are the reason this module never trusts a single source:
 * a row in `documents` is not proof that a file exists, and a file on disk is
 * not proof that a document is registered. A registered document whose file
 * vanished is reported as *inconsistent* — never as present — so the user is
 * told what is actually wrong instead of being silently blocked.
 */
import type {
  Dependency,
  DependencyCheckItem,
  DependencyCheckResult,
  DependencyType,
  Document,
  DocumentStatus,
} from '../domain/types.ts';
import { normalizeName } from '../domain/naming.ts';
import { getDb } from '../db/database.ts';
import {
  createDependency,
  deleteDependenciesForRun,
  linkDependencyToDocument,
  listDependenciesForDocument,
  listDependenciesForRun,
  resolveProjectDependencies,
} from '../repos/dependencies.ts';
import { findDocumentByCanonicalName, getDocument } from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { listLayers } from '../repos/layers.ts';
import { getRun } from '../repos/runs.ts';
import { fileExists } from './storage.ts';

/** Document statuses that count as "finished work" for a source packet. */
const USABLE_STATUSES: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>(['COMPLETE', 'FROZEN']);

export interface DocumentPresence {
  /** Registered, finished, and the physical artifact is on disk. */
  present: boolean;
  /** The row claims an artifact but the file is not there (invariant 9). */
  fileMissing: boolean;
  status: DocumentStatus | null;
}

/**
 * The single definition of "this document is really here", shared by the
 * dependency checker and the state engine so the two can never disagree.
 */
export function documentPresence(document: Document | null | undefined): DocumentPresence {
  if (!document) return { present: false, fileMissing: false, status: null };
  const statusUsable = USABLE_STATUSES.has(document.status);
  const onDisk = fileExists(document.filesystemPath);
  // A path was recorded, or the status claims a finished artifact: either way
  // the platform promised a file, so its absence is an inconsistency.
  const claimsArtifact = Boolean(document.filesystemPath) || statusUsable;
  return {
    present: statusUsable && onDisk,
    fileMissing: claimsArtifact && !onDisk,
    status: document.status,
  };
}

/** Trim, drop blanks, and collapse case-insensitive duplicates keeping first spelling. */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = (raw ?? '').trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Best-effort owning layer for a canonical name such as `Discovery Logic v1G`,
 * used so a dependency on a document that does not exist yet still points at
 * the layer that has to produce it.
 */
function inferRequiredLayerId(projectId: string, canonicalName: string): string | null {
  const target = normalizeName(canonicalName);
  let bestId: string | null = null;
  let bestLength = 0;
  for (const layer of listLayers(projectId)) {
    const prefix = normalizeName(layer.name);
    if (!prefix || !target.startsWith(prefix)) continue;
    if (prefix.length > bestLength) {
      bestLength = prefix.length;
      bestId = layer.id;
    }
  }
  return bestId;
}

function evaluate(
  projectId: string,
  canonicalName: string,
  required: boolean,
  dependencyType: DependencyType,
  linkedDocumentId: string | null,
): DependencyCheckItem {
  // The canonical name is authoritative; the stored link is only a cache of a
  // previous resolution and may point at a row that has since been renamed.
  const document =
    findDocumentByCanonicalName(projectId, canonicalName) ??
    (linkedDocumentId ? getDocument(linkedDocumentId) : null);
  const presence = documentPresence(document);
  return {
    canonicalName,
    documentId: document?.id ?? null,
    required,
    dependencyType,
    present: presence.present,
    fileMissing: presence.fileMissing,
    status: presence.status,
  };
}

/**
 * `presentCount / requiredCount READY` — the exact string the UI prints next to
 * a source packet. `ready` answers "may this run start?"; `blocked` is wider and
 * also trips on an optional document whose file disappeared.
 */
function summarize(items: DependencyCheckItem[]): DependencyCheckResult {
  const requiredItems = items.filter((item) => item.required);
  const presentItems = requiredItems.filter((item) => item.present);
  const missing = requiredItems.filter((item) => !item.present).map((item) => item.canonicalName);
  const inconsistent = items.filter((item) => item.fileMissing).map((item) => item.canonicalName);
  const requiredCount = requiredItems.length;
  const presentCount = presentItems.length;
  return {
    items,
    requiredCount,
    presentCount,
    missing,
    inconsistent,
    ready: presentCount === requiredCount,
    blocked: missing.length > 0 || inconsistent.length > 0,
    summary: `${presentCount} / ${requiredCount} READY`,
  };
}

function checkDependencyRows(projectId: string, rows: Dependency[]): DependencyCheckResult {
  return summarize(
    rows.map((row) =>
      evaluate(
        projectId,
        row.requiredCanonicalName,
        row.required,
        row.dependencyType,
        row.requiredDocumentId,
      ),
    ),
  );
}

/** Source-packet status for a run, e.g. before letting a synthesis start. */
export function checkRunDependencies(runId: string): DependencyCheckResult {
  const run = getRun(runId);
  if (!run) throw new Error(`Cannot check dependencies: unknown run ${runId}`);
  return checkDependencyRows(run.projectId, listDependenciesForRun(runId));
}

/** Source-packet status for a document (its inputs, not its dependents). */
export function checkDocumentDependencies(documentId: string): DependencyCheckResult {
  const document = getDocument(documentId);
  if (!document) throw new Error(`Cannot check dependencies: unknown document ${documentId}`);
  return checkDependencyRows(document.projectId, listDependenciesForDocument(documentId));
}

/**
 * Check a set of canonical names before any run row exists — used by the prompt
 * preview so the user sees `6 / 7 READY` before committing to a run.
 */
export function checkCanonicalNames(
  projectId: string,
  requiredCanonicalNames: string[],
): DependencyCheckResult {
  return summarize(
    uniqueNames(requiredCanonicalNames).map((name) =>
      evaluate(projectId, name, true, 'SOURCE_PACKET', null),
    ),
  );
}

/**
 * Replace a run's dependency rows with exactly this set. Idempotent: calling it
 * twice with the same names leaves the original rows (and their ids) alone, so
 * re-compiling a prompt does not churn the dependency table.
 */
export function setRunDependencies(
  runId: string,
  requiredCanonicalNames: string[],
  options: { dependencyType?: DependencyType; required?: boolean } = {},
): Dependency[] {
  const run = getRun(runId);
  if (!run) throw new Error(`Cannot set dependencies: unknown run ${runId}`);
  const dependencyType: DependencyType = options.dependencyType ?? 'SOURCE_PACKET';
  const required = options.required ?? true;
  const names = uniqueNames(requiredCanonicalNames);

  const db = getDb();
  return db.transaction(() => {
    const existing = listDependenciesForRun(runId);
    const unchanged =
      existing.length === names.length &&
      existing.every(
        (row, index) =>
          normalizeName(row.requiredCanonicalName) === normalizeName(names[index] ?? '') &&
          row.dependencyType === dependencyType &&
          row.required === required,
      );
    if (unchanged) {
      // Still re-point the resolution links: documents may have arrived since.
      return existing.map((row) => relinkDependency(row));
    }

    deleteDependenciesForRun(runId);
    return names.map((canonicalName) => {
      const document = findDocumentByCanonicalName(run.projectId, canonicalName);
      const presence = documentPresence(document);
      return createDependency({
        projectId: run.projectId,
        dependentRunId: runId,
        requiredCanonicalName: canonicalName,
        requiredDocumentId: presence.present ? (document?.id ?? null) : null,
        requiredLayerId: document?.layerId ?? inferRequiredLayerId(run.projectId, canonicalName),
        dependencyType,
        required,
      });
    });
  });
}

/** Re-read a dependency's resolution without rewriting its identity. */
function relinkDependency(row: Dependency): Dependency {
  const document = findDocumentByCanonicalName(row.projectId, row.requiredCanonicalName);
  const presence = documentPresence(document);
  const shouldBe = presence.present ? (document?.id ?? null) : null;
  if (shouldBe === row.requiredDocumentId) return row;
  linkDependencyToDocument(row.id, shouldBe);
  return { ...row, requiredDocumentId: shouldBe };
}

/**
 * Re-link every dependency in the project against current reality and record
 * what changed. Called from `recomputeProject`, which is why importing one PDF
 * can unblock a synthesis three layers away without anyone asking it to.
 */
export function refreshProjectDependencies(projectId: string): {
  resolved: string[];
  broken: string[];
} {
  const db = getDb();
  return db.transaction(() => {
    const changes = resolveProjectDependencies(projectId);
    for (const canonicalName of changes.resolved) {
      recordEvent({
        projectId,
        layerId: inferRequiredLayerId(projectId, canonicalName),
        entityType: 'DEPENDENCY',
        eventType: 'DEPENDENCY_RESOLVED',
        payload: { canonicalName },
      });
    }
    for (const canonicalName of changes.broken) {
      recordEvent({
        projectId,
        layerId: inferRequiredLayerId(projectId, canonicalName),
        entityType: 'DEPENDENCY',
        eventType: 'DEPENDENCY_MISSING',
        payload: { canonicalName },
      });
    }
    return changes;
  });
}
