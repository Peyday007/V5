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
import { AsyncLocalStorage } from 'node:async_hooks';
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
  dependenciesDrifted,
  resolveProjectDependencies,
} from '../repos/dependencies.ts';
import { findDocumentByCanonicalName, findDocumentsByCanonicalNames, getDocument } from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { listLayers } from '../repos/layers.ts';
import { getRun } from '../repos/runs.ts';
import { objectExists, storageKeyOf} from './storage.ts';

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
export async function documentPresence(document: Document | null | undefined): Promise<DocumentPresence> {
  if (!document) return { present: false, fileMissing: false, status: null };
  const statusUsable = USABLE_STATUSES.has(document.status);
  const key = storageKeyOf(document);
  const onDisk = await objectExists(key);
  // A location was recorded, or the status claims a finished artifact: either
  // way the platform promised a file, so its absence is an inconsistency.
  const claimsArtifact = Boolean(key) || statusUsable;
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
async function inferRequiredLayerId(projectId: string, canonicalName: string): Promise<string | null> {
  const target = normalizeName(canonicalName);
  let bestId: string | null = null;
  let bestLength = 0;
  for (const layer of await listLayers(projectId)) {
    const prefix = normalizeName(layer.name);
    if (!prefix || !target.startsWith(prefix)) continue;
    if (prefix.length > bestLength) {
      bestLength = prefix.length;
      bestId = layer.id;
    }
  }
  return bestId;
}

/**
 * One recompute asks for the same few canonical names over and over: every
 * run not yet started, then every layer's active runs and unfinished
 * documents. Production, 2026-11-05 21:23–22:20Z: `findDocumentByCanonicalName`
 * ran 49 932 times in an hour (about 14 a second), the database's largest cost
 * by ~700×, and Brain shed load. Inside `withNameLookups` each (project, name)
 * is read once per pass; outside it every call reads current rows as before.
 * Only these read-only checks use it; the paths that write dependency rows
 * read the document themselves.
 */
const nameMemo = new AsyncLocalStorage<Map<string, Promise<Document | null>>>();

export function withNameLookups<T>(fn: () => Promise<T>): Promise<T> {
  if (nameMemo.getStore()) return fn();
  return nameMemo.run(new Map(), fn);
}

function memoKey(projectId: string, canonicalName: string): string {
  return `${projectId}\n${canonicalName.trim().toLowerCase()}`;
}

/**
 * Put every name a check is about to evaluate into the memo with one
 * statement, so the check's concurrent evaluations take one pooled connection
 * instead of one each (§61). Names already in the memo are not read again.
 */
function prefetchNames(projectId: string, names: readonly string[]): void {
  const memo = nameMemo.getStore();
  if (!memo) return;
  const missing = [...new Set(names)].filter((name) => !memo.has(memoKey(projectId, name)));
  if (missing.length === 0) return;
  const batch = findDocumentsByCanonicalNames(projectId, missing);
  for (const name of missing) {
    const key = memoKey(projectId, name);
    const hit = batch.then((found) => found.get(name) ?? null);
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
}

function documentNamed(projectId: string, canonicalName: string): Promise<Document | null> {
  prefetchNames(projectId, [canonicalName]);
  return nameMemo.getStore()!.get(memoKey(projectId, canonicalName))!;
}

async function evaluate(
  projectId: string,
  canonicalName: string,
  required: boolean,
  dependencyType: DependencyType,
  linkedDocumentId: string | null,
): Promise<DependencyCheckItem> {
  // The canonical name is authoritative; the stored link is only a cache of a
  // previous resolution and may point at a row that has since been renamed.
  const document =
    await documentNamed(projectId, canonicalName) ??
    (linkedDocumentId ? await getDocument(linkedDocumentId) : null);
  const presence = await documentPresence(document);
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

async function checkDependencyRows(
  projectId: string,
  rows: Dependency[],
): Promise<DependencyCheckResult> {
  return withNameLookups(() => checkDependencyRowsWithin(projectId, rows));
}

async function checkDependencyRowsWithin(
  projectId: string,
  rows: Dependency[],
): Promise<DependencyCheckResult> {
  prefetchNames(projectId, rows.map((row) => row.requiredCanonicalName));
  return summarize(
    await Promise.all(
      rows.map((row) =>
        evaluate(
          projectId,
          row.requiredCanonicalName,
          row.required,
          row.dependencyType,
          row.requiredDocumentId,
        ),
      ),
    ),
  );
}

/** A run's status against dependency rows already read. Used by the recompute. */
export async function checkRunDependencyRows(projectId: string, rows: Dependency[]): Promise<DependencyCheckResult> {
  return checkDependencyRows(projectId, rows);
}

/** Source-packet status for a run, e.g. before letting a synthesis start. */
export async function checkRunDependencies(runId: string): Promise<DependencyCheckResult> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Cannot check dependencies: unknown run ${runId}`);
  return checkDependencyRows(run.projectId, await listDependenciesForRun(runId));
}

/** Source-packet status for a document (its inputs, not its dependents). */
export async function checkDocumentDependencies(documentId: string): Promise<DependencyCheckResult> {
  const document = await getDocument(documentId);
  if (!document) throw new Error(`Cannot check dependencies: unknown document ${documentId}`);
  return checkDependencyRows(document.projectId, await listDependenciesForDocument(documentId));
}

/**
 * Check a set of canonical names before any run row exists — used by the prompt
 * preview so the user sees `6 / 7 READY` before committing to a run.
 */
export async function checkCanonicalNames(
  projectId: string,
  requiredCanonicalNames: string[],
): Promise<DependencyCheckResult> {
  const names = uniqueNames(requiredCanonicalNames);
  return withNameLookups(async () => {
    prefetchNames(projectId, names);
    return summarize(
      await Promise.all(names.map((name) => evaluate(projectId, name, true, 'SOURCE_PACKET', null))),
    );
  });
}

/**
 * Replace a run's dependency rows with exactly this set. Idempotent: calling it
 * twice with the same names leaves the original rows (and their ids) alone, so
 * re-compiling a prompt does not churn the dependency table.
 */
export async function setRunDependencies(
  runId: string,
  requiredCanonicalNames: string[],
  options: { dependencyType?: DependencyType; required?: boolean } = {},
): Promise<Dependency[]> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Cannot set dependencies: unknown run ${runId}`);
  const dependencyType: DependencyType = options.dependencyType ?? 'SOURCE_PACKET';
  const required = options.required ?? true;
  const names = uniqueNames(requiredCanonicalNames);

  /*
   * Everything this reads is read before the transaction opens (2026-11-06).
   *
   * It used to resolve each name inside the transaction — one lookup and one
   * storage existence check (an HTTPS request to the document store) per name,
   * all queued on the transaction's single connection. On production that held
   * the connection while the store answered, and the lookups queued behind one
   * another: the single-name documents lookup from here averaged 7.8 s (max
   * 15.5 s) and the dependency INSERT 15.5 s over 8 minutes, which alone put
   * the pool's pressure reading at SHEDDING and deferred Brain's optional work
   * with the database server idle. Now the names are read in one statement and
   * their presence asked once each, before; the transaction holds only the
   * rows it writes. A document arriving between the two is caught by the next
   * recompute's relink, exactly as one arriving after the commit always was.
   */
  const existingBefore = await listDependenciesForRun(runId);
  const documents = await findDocumentsByCanonicalNames(
    run.projectId,
    uniqueNames([...names, ...existingBefore.map((row) => row.requiredCanonicalName)]),
  );
  const resolve = async (canonicalName: string): Promise<{ document: Document | null; documentId: string | null }> => {
    const document = documents.has(canonicalName)
      ? (documents.get(canonicalName) ?? null)
      : await findDocumentByCanonicalName(run.projectId, canonicalName);
    const presence = await documentPresence(document);
    return { document, documentId: presence.present ? (document?.id ?? null) : null };
  };
  const resolved = new Map<string, { document: Document | null; documentId: string | null; layerId: string | null }>();
  // Outside any transaction, so these may run together: the store's own
  // connection pool bounds how many existence checks are in flight.
  await Promise.all(
    uniqueNames([...names, ...existingBefore.map((row) => row.requiredCanonicalName)]).map(async (canonicalName) => {
      const { document, documentId } = await resolve(canonicalName);
      resolved.set(normalizeName(canonicalName), {
        document,
        documentId,
        layerId: document?.layerId ?? (await inferRequiredLayerId(run.projectId, canonicalName)),
      });
    }),
  );
  const resolutionOf = (canonicalName: string) => resolved.get(normalizeName(canonicalName));

  const db = getDb();
  return await db.transaction(async () => {
    const existing = await listDependenciesForRun(runId);
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
      const out: Dependency[] = [];
      for (const row of existing) {
        const known = resolutionOf(row.requiredCanonicalName);
        if (!known) {
          out.push(await relinkDependency(row));
          continue;
        }
        if (known.documentId !== row.requiredDocumentId) await linkDependencyToDocument(row.id, known.documentId);
        out.push({ ...row, requiredDocumentId: known.documentId });
      }
      return out;
    }

    await deleteDependenciesForRun(runId);
    const out: Dependency[] = [];
    for (const canonicalName of names) {
      const known = resolutionOf(canonicalName)!;
      out.push(
        await createDependency({
          projectId: run.projectId,
          dependentRunId: runId,
          requiredCanonicalName: canonicalName,
          requiredDocumentId: known.documentId,
          requiredLayerId: known.layerId,
          dependencyType,
          required,
        }),
      );
    }
    return out;
  });
}

/** Re-read a dependency's resolution without rewriting its identity. */
async function relinkDependency(row: Dependency): Promise<Dependency> {
  const document = await findDocumentByCanonicalName(row.projectId, row.requiredCanonicalName);
  const presence = await documentPresence(document);
  const shouldBe = presence.present ? (document?.id ?? null) : null;
  if (shouldBe === row.requiredDocumentId) return row;
  await linkDependencyToDocument(row.id, shouldBe);
  return { ...row, requiredDocumentId: shouldBe };
}

/**
 * Re-link every dependency in the project against current reality and record
 * what changed. Called from `recomputeProject`, which is why importing one PDF
 * can unblock a synthesis three layers away without anyone asking it to.
 */
export async function refreshProjectDependencies(projectId: string): Promise<{
  resolved: string[];
  broken: string[];
}> {
  const db = getDb();
  /*
   * Read first, and take a connection for a transaction only when a link has
   * actually moved. The transaction re-derives the answer itself, so a change
   * landing between this read and it is still applied exactly once; and inside
   * a caller's transaction this read is part of it, as before.
   */
  if (!(await dependenciesDrifted(projectId))) return { resolved: [], broken: [] };
  return db.transaction(async () => {
    const changes = await resolveProjectDependencies(projectId);
    for (const canonicalName of changes.resolved) {
      await recordEvent({
        projectId,
        layerId: await inferRequiredLayerId(projectId, canonicalName),
        entityType: 'DEPENDENCY',
        eventType: 'DEPENDENCY_RESOLVED',
        payload: { canonicalName },
      });
    }
    for (const canonicalName of changes.broken) {
      await recordEvent({
        projectId,
        layerId: await inferRequiredLayerId(projectId, canonicalName),
        entityType: 'DEPENDENCY',
        eventType: 'DEPENDENCY_MISSING',
        payload: { canonicalName },
      });
    }
    return changes;
  });
}
