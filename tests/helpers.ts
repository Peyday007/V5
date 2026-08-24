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
export async function freshProject(): Promise<TestProject> {
  await closeDatabase();
  fs.rmSync(path.join(DATA_ROOT, 'projects'), { recursive: true, force: true });
  const dbPath = path.join(DATA_ROOT, `test-${Math.random().toString(36).slice(2)}.db`);
  await initDatabase({ dbPath });
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
