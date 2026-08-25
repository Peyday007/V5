/**
 * Derived runtime state file (spec section 17).
 *
 * `/data/runtime/project-state.json` is a concise, machine-readable mirror of
 * what the platform currently believes, written so an outside tool (Claude Code,
 * a shell script, a person with `cat`) can read project state without touching
 * SQLite. It is DERIVED: the database stays authoritative, this file is always
 * safe to delete, and it is rewritten from scratch whenever state changes.
 *
 * **It is not written in cloud mode, and that is deliberate.**
 *
 * The file earns its place on a single machine, where the database is a file
 * beside it and a person may reasonably want to read state without opening
 * SQLite. In cloud mode it earns nothing and costs something real: it would be
 * instance-local state describing shared truth. Two Brains against one Postgres
 * would each write their own copy, each stale the moment the other committed
 * anything, and the first person to `cat` one would be reading a different
 * project than the database holds.
 *
 * Nothing reads it as input — no route, no service, no client code — so
 * declining to write it removes a source of confusion rather than a capability.
 * Cloud state is rebuilt from Postgres, which is the only copy that can be
 * right for everybody.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, DB_PATH, PROJECT_STATE_FILE, RUNTIME_ROOT } from '../env.ts';
import { getMigrationReport, activeDatabaseConfig } from '../db/database.ts';
import type { Document, LayerStateSnapshot, PlannerItem } from '../domain/types.ts';
import { listDocuments } from '../repos/documents.ts';
import { listLayers } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { listActiveRuns } from '../repos/runs.ts';
import { nowIso } from '../repos/util.ts';
import { buildPlan } from './planner.ts';

export interface RuntimeProjectState {
  generatedAt: string;
  schemaVersion: number;
  databasePath: string;
  dataRoot: string;
  project: {
    id: string;
    slug: string;
    name: string;
    wave: number;
    status: string;
    northStar: string | null;
  };
  layers: LayerStateSnapshot[];
  nextBestAction: string;
  plan: {
    now: PlannerItem[];
    next: PlannerItem[];
    later: PlannerItem[];
    blocked: PlannerItem[];
  };
  documents: {
    canonicalName: string;
    layer: string | null;
    version: string;
    status: string;
    filename: string | null;
    fileMissing: boolean;
  }[];
  activeRuns: {
    id: string;
    layer: string | null;
    runType: string;
    status: string;
    targetVersion: string | null;
  }[];
  inconsistencies: string[];
}

/**
 * Regenerate `/data/runtime/project-state.json` and return what was written.
 *
 * Written through a temp file in the same directory and then renamed, so a
 * reader never sees a half-written document and a crash mid-write leaves the
 * previous snapshot intact.
 */
/**
 * Whether this Brain keeps a local snapshot at all.
 *
 * Asked of the database Brain actually opened, not of the environment: the
 * point of the whole persistence boundary is that "am I cloud-backed" is a fact
 * about a connection that answered, never about a variable being set.
 */
export function writesRuntimeSnapshot(): boolean {
  return (activeDatabaseConfig()?.provider ?? 'sqlite') !== 'postgres';
}

/**
 * Write the snapshot, in local mode.
 *
 * In cloud mode this builds the state and returns it — callers that want the
 * derived view still get it — and writes nothing. The return value is the same
 * either way, so no caller has to know which mode it is in.
 */
export async function writeProjectState(projectId: string): Promise<RuntimeProjectState> {
  const state = await buildProjectState(projectId);
  if (!writesRuntimeSnapshot()) return state;
  const directory = path.dirname(PROJECT_STATE_FILE);
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  if (path.resolve(directory) !== path.resolve(RUNTIME_ROOT)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tempPath = path.join(directory, `.project-state.${crypto.randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(tempPath, 'w');
    try {
      fs.writeFileSync(handle, payload, 'utf8');
      // Flush before the rename so the snapshot survives an unclean shutdown.
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tempPath, PROJECT_STATE_FILE);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return state;
}

/**
 * Read the last written snapshot. Returns null when the file is absent or
 * unreadable — it is derived state, so a missing or corrupt file is a cache miss
 * to be regenerated, never an error worth failing a request over.
 */
export function readProjectState(): RuntimeProjectState | null {
  // Never in cloud mode, whatever is on this disk. A file left behind by an
  // earlier local run — or put there by anything else — describes a database
  // this instance is not using, and a stale answer is worse than none.
  if (!writesRuntimeSnapshot()) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(PROJECT_STATE_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RuntimeProjectState;
  } catch {
    return null;
  }
}

/** Assemble the snapshot from live database state (no filesystem writes). */
async function buildProjectState(projectId: string): Promise<RuntimeProjectState> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);

  const report = getMigrationReport();
  const plan = await buildPlan(projectId);
  const layerNames = new Map((await listLayers(projectId)).map((layer) => [layer.id, layer.name]));
  const documents = await listDocuments(projectId);
  const activeRuns = await listActiveRuns(projectId);

  return {
    generatedAt: nowIso(),
    schemaVersion: report?.schemaVersion ?? 0,
    databasePath: report?.databasePath ?? DB_PATH,
    dataRoot: DATA_ROOT,
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      wave: project.currentWave,
      status: project.status,
      northStar: project.northStar,
    },
    layers: plan.layers,
    nextBestAction: plan.nextBestActionText,
    plan: {
      now: plan.now,
      next: plan.next,
      later: plan.later,
      blocked: plan.blocked,
    },
    documents: documents.map((doc) => ({
      canonicalName: doc.canonicalName,
      layer: doc.layerId ? layerNames.get(doc.layerId) ?? null : null,
      version: doc.version,
      status: doc.status,
      filename: doc.filename,
      fileMissing: doc.fileMissing,
    })),
    activeRuns: activeRuns.map((run) => ({
      id: run.id,
      layer: run.layerId ? layerNames.get(run.layerId) ?? null : null,
      runType: run.runType,
      status: run.status,
      targetVersion: run.targetVersion,
    })),
    inconsistencies: collectInconsistencies(documents, plan.layers, layerNames),
  };
}

/**
 * Everything the platform knows to be internally contradictory, in one list an
 * outside reader can act on: files that vanished from under a registered
 * document (invariant 9), finished documents with nothing on disk (invariant 8),
 * and frozen layers with no canonical artifact (invariant 6).
 *
 * A merely missing dependency is not listed: that is ordinary, expected
 * work-still-to-do and it already shows up in the plan's BLOCKED bucket.
 */
function collectInconsistencies(
  documents: Document[],
  layers: LayerStateSnapshot[],
  layerNames: Map<string, string>,
): string[] {
  const messages = new Set<string>();

  for (const doc of documents) {
    if (doc.fileMissing) {
      messages.add(
        `${doc.canonicalName}: registered file is missing from disk (${doc.filesystemPath ?? 'no path recorded'}).`,
      );
      continue;
    }
    if ((doc.status === 'COMPLETE' || doc.status === 'FROZEN') && !doc.filesystemPath) {
      messages.add(`${doc.canonicalName}: status ${doc.status} but no file is recorded.`);
    }
    if (!doc.layerId) {
      messages.add(`${doc.canonicalName}: registered without a layer.`);
    } else if (!layerNames.has(doc.layerId)) {
      messages.add(`${doc.canonicalName}: points at a layer that no longer exists.`);
    }
  }

  for (const layer of layers) {
    for (const name of layer.inconsistentDocuments) {
      messages.add(`${layer.layerName}: ${name} is registered but its file is gone.`);
    }
    if (layer.frozen && !layer.canonicalName) {
      messages.add(`${layer.layerName}: frozen with no canonical document.`);
    }
  }

  return [...messages];
}
