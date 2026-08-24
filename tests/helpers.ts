/**
 * Shared harness. Every test file gets its own data root (see tests/setup.ts), so
 * these helpers can freely create projects, layers, documents and real files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { DATA_ROOT } from '../server/env.ts';
import { seedDealDispatch } from '../server/seed.ts';
import { createDocument } from '../server/repos/documents.ts';
import { listLayers } from '../server/repos/layers.ts';
import { buildNames } from '../server/domain/naming.ts';
import { versionSortKey, waveForVersion } from '../server/domain/version.ts';
import { storeFile } from '../server/services/storage.ts';
import type { Document, DocumentType, Layer, Project } from '../server/domain/types.ts';

export interface TestProject {
  project: Project;
  layers: Layer[];
  layerByName(name: string): Promise<Layer>;
}

/**
 * Fresh database AND a fresh document tree. Both have to be reset together: the
 * project slug is stable, so leaving files behind would make the next test's
 * reconciliation see them as unregistered.
 */
/**
 * Where this run's tests keep their rows.
 *
 * With `BRAIN_TEST_DATABASE_URL` set, the whole suite runs against a real
 * Postgres instead of SQLite. That is the only way to find out whether one
 * repository layer over two backends is actually true: a mock proves the code
 * calls the adapter, and nothing else. Each test file gets its own schema,
 * because vitest runs files concurrently and they would otherwise share tables.
 */
const POSTGRES_URL = (process.env.BRAIN_TEST_DATABASE_URL ?? '').trim() || null;

export const testDatabaseKind: 'sqlite' | 'postgres' = POSTGRES_URL ? 'postgres' : 'sqlite';

/** One schema per test file, derived from the per-file data root vitest hands out. */
function schemaForThisFile(): string {
  const stem = path.basename(DATA_ROOT).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  return `brain_t_${stem}`.slice(0, 60);
}

async function openTestDatabase(): Promise<void> {
  if (!POSTGRES_URL) {
    const dbPath = path.join(DATA_ROOT, `test-${Math.random().toString(36).slice(2)}.db`);
    await initDatabase({ dbPath });
    return;
  }
  const schema = schemaForThisFile();
  // Dropped and recreated rather than truncated: the migrator has to run from
  // nothing every time, so the schema each test sees is the one the migrations
  // actually produce rather than one left over from a previous run.
  const pg = await import('pg');
  const admin = new pg.default.Client({ connectionString: POSTGRES_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  await initDatabase({
    config: { provider: 'postgres', connectionString: POSTGRES_URL, poolSize: 4, schema },
  });
}

export async function freshProject(): Promise<TestProject> {
  await closeDatabase();
  fs.rmSync(path.join(DATA_ROOT, 'projects'), { recursive: true, force: true });
  await openTestDatabase();
  const { project, layers } = await seedDealDispatch();
  return {
    project,
    layers,
    async layerByName(name: string): Promise<Layer> {
      const found = (await listLayers(project.id)).find((l) => l.name === name);
      if (!found) throw new Error(`No such layer in test fixture: ${name}`);
      return found;
    },
  };
}

export async function teardown(): Promise<void> {
  await closeDatabase();
}

export interface AddDocumentOptions {
  documentType?: DocumentType;
  status?: Document['status'];
  /** Write a real file to disk and register its path/size/hash. */
  withFile?: boolean;
  contents?: string;
}

/**
 * Register a document for a layer the way the importer would, optionally writing
 * a real file so filesystem-sensitive code paths (invariants 8 and 9) are exercised.
 */
export async function addDocument(
  fixture: TestProject,
  layerName: string,
  version: string,
  options: AddDocumentOptions = {},
): Promise<Document> {
  const layer = await fixture.layerByName(layerName);
  const names = buildNames(layer.name, version);
  const withFile = options.withFile ?? true;

  let filesystemPath: string | null = null;
  let fileSize: number | null = null;
  let fileHash: string | null = null;
  if (withFile) {
    const stored = await storeFile({
      projectSlug: fixture.project.slug,
      layerSlug: layer.slug,
      filename: names.filename,
      contents: Buffer.from(options.contents ?? `${names.canonicalName} contents`),
    });
    filesystemPath = stored.relativePath;
    fileSize = stored.size;
    fileHash = stored.hash;
  }

  return await createDocument({
    projectId: fixture.project.id,
    layerId: layer.id,
    canonicalName: names.canonicalName,
    version,
    versionSort: versionSortKey(version),
    wave: waveForVersion(version, fixture.project.versionPolicy),
    documentType: options.documentType ?? 'EXPANSION',
    status: options.status ?? 'COMPLETE',
    filename: names.filename,
    filesystemPath,
    fileSize,
    fileHash,
    conversationTitle: names.conversationTitle,
    importedAt: new Date().toISOString(),
  });
}

/** Simulate the user deleting a file behind the platform's back. */
export function deletePhysicalFile(document: Document): void {
  if (!document.filesystemPath) throw new Error('Document has no file to delete');
  fs.rmSync(path.resolve(DATA_ROOT, document.filesystemPath), { force: true });
}

export function readDataFile(relativePath: string): Buffer {
  return fs.readFileSync(path.resolve(DATA_ROOT, relativePath));
}
