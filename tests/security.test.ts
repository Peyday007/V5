/**
 * Path confinement.
 *
 * `import/resolve` and `reconcile/fix` take a filesystem path straight from the
 * caller and then MOVE the file. The data root also holds the database, the
 * runtime snapshot and the backups, so a path that merely stays inside the data
 * root is not safe enough: "brain.db" would relocate the database into the
 * documents tree and destroy the project on the next restart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { registerExistingFile, resolveImport } from '../server/services/importer.ts';
import { applyReconcileFix } from '../server/services/reconcile.ts';
import { DATA_ROOT } from '../server/env.ts';
import {
  assertInsideProjectDocuments,
  documentsDir,
  resolveStoredFile,
} from '../server/services/storage.ts';

let fixture: TestProject;

beforeEach(() => {
  fixture = freshProject();
});
afterEach(() => {
  teardown();
});

/** Paths inside the data root but outside the project's documents tree. */
const OUTSIDE = ['brain.db', 'runtime/project-state.json', 'backups/anything.db', '../etc/passwd'];

describe('a caller-supplied path cannot escape the documents tree', () => {
  it('rejects them outright', () => {
    for (const relativePath of OUTSIDE) {
      expect(() => assertInsideProjectDocuments(fixture.project.slug, relativePath), relativePath)
        .toThrow();
    }
  });

  it('accepts either root for a stored file, and still confines both', () => {
    const documents = documentsDir(fixture.project.slug);
    fs.mkdirSync(path.join(documents, '_unfiled'), { recursive: true });
    const stored = path.join(documents, '_unfiled', 'notes.txt');
    fs.writeFileSync(stored, 'text');

    // What Brain hands out, and what somebody reading the folder would type.
    const dataRelative = path.relative(DATA_ROOT, stored).split(path.sep).join('/');
    expect(resolveStoredFile(fixture.project.slug, dataRelative)).toBe(stored);
    expect(resolveStoredFile(fixture.project.slug, '_unfiled/notes.txt')).toBe(stored);

    // Being forgiving about the root does not widen what is reachable.
    for (const relativePath of OUTSIDE) {
      expect(() => resolveStoredFile(fixture.project.slug, relativePath), relativePath).toThrow();
    }
    expect(() => resolveStoredFile(fixture.project.slug, '../../brain.db')).toThrow();
  });

  it('refuses to confirm an import of the database', () => {
    const dbPath = path.join(DATA_ROOT, 'brain.db');
    fs.writeFileSync(dbPath, 'pretend database');

    expect(() =>
      resolveImport({
        projectId: fixture.project.id,
        relativePath: 'brain.db',
        layerId: fixture.layerByName('Taxonomy').id,
        version: 'v1',
        documentType: 'REFERENCE',
      }),
    ).toThrow(/not inside this project/i);

    // The file is still exactly where it was.
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('refuses to register a file from outside the documents tree', () => {
    fs.mkdirSync(path.join(DATA_ROOT, 'runtime'), { recursive: true });
    const snapshot = path.join(DATA_ROOT, 'runtime', 'project-state.json');
    fs.writeFileSync(snapshot, '{}');

    expect(() =>
      registerExistingFile({
        projectId: fixture.project.id,
        relativePath: 'runtime/project-state.json',
        layerId: fixture.layerByName('World Model').id,
        version: 'v1',
      }),
    ).toThrow(/not inside this project/i);
    expect(fs.existsSync(snapshot)).toBe(true);
  });

  it('refuses the same path through a reconcile fix', () => {
    const dbPath = path.join(DATA_ROOT, 'brain.db');
    fs.writeFileSync(dbPath, 'pretend database');

    const attempt = () =>
      applyReconcileFix({
        projectId: fixture.project.id,
        kind: 'UNREGISTERED_FILE',
        path: 'brain.db',
        layerId: fixture.layerByName('World Model').id,
        version: 'v9',
      });

    // Either it throws or it reports failure — but the file must not move.
    try {
      const result = attempt();
      expect(result.ok).toBe(false);
    } catch (error) {
      expect(String(error)).toMatch(/not inside this project/i);
    }
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('still accepts a genuine path inside the documents tree', () => {
    const dir = path.join(documentsDir(fixture.project.slug), 'taxonomy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Taxonomy v1.pdf'), '%PDF-1.4 real');

    const relative = path.relative(DATA_ROOT, path.join(dir, 'Taxonomy v1.pdf')).split(path.sep).join('/');
    const result = registerExistingFile({ projectId: fixture.project.id, relativePath: relative });
    expect(result.registered).toBe(true);
  });
});
