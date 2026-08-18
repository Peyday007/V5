/**
 * Import, inference and reconciliation (spec sections 7 and 21) — the path the
 * user's first real session depends on: drop a folder of existing PDFs in and
 * have the platform reconstruct project state from filenames.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, deletePhysicalFile, freshProject, teardown, type TestProject } from './helpers.ts';
import { inferFromFilename } from '../server/services/inference.ts';
import { importFile, resolveImport } from '../server/services/importer.ts';
import { applyReconcileFix, scanAndReconcile } from '../server/services/reconcile.ts';
import { computeLayerState, setLayerExpectations } from '../server/services/stateEngine.ts';
import { prepareSynthesis, DependencyError } from '../server/services/synthesis.ts';
import { getDocument, listDocumentsByLayer } from '../server/repos/documents.ts';
import { storeFile } from '../server/services/storage.ts';

let fixture: TestProject;

beforeEach(() => {
  fixture = freshProject();
});
afterEach(() => {
  teardown();
});

function pdf(name: string) {
  return { originalFilename: name, contents: Buffer.from(`%PDF-1.4 contents of ${name}`) };
}

describe('filename inference', () => {
  it('reads the spec examples exactly', () => {
    const routing = inferFromFilename(fixture.project.id, 'Decision Routing Rules v1F.pdf');
    expect(routing.layerName).toBe('Decision Routing Rules');
    expect(routing.version).toBe('v1F');
    expect(routing.documentType).toBe('EXPANSION');
    expect(routing.canonicalName).toBe('Decision Routing Rules v1F');
    expect(routing.ambiguous).toBe(false);
    expect(routing.reasons.length).toBeGreaterThan(0);

    expect(inferFromFilename(fixture.project.id, 'World Model v1.pdf').documentType).toBe('FOUNDATION');
    expect(inferFromFilename(fixture.project.id, 'Qualification Logic v3.1.pdf').documentType).toBe('SYNTHESIS');
  });

  it('tolerates separators, case and filename noise', () => {
    for (const name of [
      'monetization-logic-v1c.pdf',
      'Monetization_Logic_V1C.pdf',
      'Monetization  Logic  v1c (1).pdf',
      '2025-04-02 Monetization Logic v1C.pdf',
    ]) {
      const inferred = inferFromFilename(fixture.project.id, name);
      expect(inferred.layerName, name).toBe('Monetization Logic');
      expect(inferred.version, name).toBe('v1C');
    }
  });

  it('refuses to guess when the layer is unknown', () => {
    const inferred = inferFromFilename(fixture.project.id, 'meeting notes.pdf');
    expect(inferred.layerId).toBeNull();
    expect(inferred.ambiguous).toBe(true);
    expect(inferred.confidence).toBeLessThan(0.8);
  });
});

describe('importing', () => {
  it('registers confident matches and files them under the canonical name', () => {
    const result = importFile({ projectId: fixture.project.id, ...pdf('Discovery Logic v1G.pdf') });
    expect(result.registered).toBe(true);

    const document = getDocument(result.documentId!);
    expect(document?.canonicalName).toBe('Discovery Logic v1G');
    expect(document?.filename).toBe('Discovery Logic v1G.pdf');
    expect(document?.status).toBe('COMPLETE');
    expect(document?.filesystemPath).toContain('discovery-logic');
  });

  it('takes the platform filename, not the dropped one', () => {
    const result = importFile({
      projectId: fixture.project.id,
      ...pdf('deal dispatch - DISCOVERY LOGIC  v1g FINAL (2).pdf'),
    });
    expect(result.registered).toBe(true);
    expect(getDocument(result.documentId!)?.filename).toBe('Discovery Logic v1G.pdf');
  });

  it('stores but does not register a file it cannot place', () => {
    const result = importFile({ projectId: fixture.project.id, ...pdf('meeting notes.pdf') });
    // Invariant 8: on disk is not the same as registered.
    expect(result.storedPath).toBeTruthy();
    expect(result.registered).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.documentId).toBeNull();
  });

  it('confirms an ambiguous import and relocates the file', () => {
    const staged = importFile({ projectId: fixture.project.id, ...pdf('meeting notes.pdf') });
    const layer = fixture.layerByName('Taxonomy');

    const resolved = resolveImport({
      projectId: fixture.project.id,
      relativePath: staged.storedPath!,
      layerId: layer.id,
      version: 'v1',
      documentType: 'FOUNDATION',
    });

    expect(resolved.registered).toBe(true);
    const document = getDocument(resolved.documentId!);
    expect(document?.canonicalName).toBe('Taxonomy v1');
    expect(document?.filesystemPath).toContain('taxonomy');
    expect(document?.filesystemPath).not.toContain('_unfiled');
  });

  it('reports an identical re-drop as a duplicate', () => {
    const file = pdf('Taxonomy v1.pdf');
    const first = importFile({ projectId: fixture.project.id, ...file });
    const second = importFile({ projectId: fixture.project.id, ...file });
    expect(first.registered).toBe(true);
    expect(second.duplicateOfDocumentId).toBe(first.documentId);
    expect(listDocumentsByLayer(fixture.layerByName('Taxonomy').id)).toHaveLength(1);
  });

  it('unblocks a blocked synthesis purely by importing the missing dependency', () => {
    const packet = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const v of packet.slice(0, 6)) addDocument(fixture, 'Discovery Logic', v);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, packet);
    expect(() => prepareSynthesis({ layerId: layer.id })).toThrow(DependencyError);

    importFile({ projectId: fixture.project.id, ...pdf('Discovery Logic v1G.pdf') });

    // The import itself recomputed state — nothing else had to be told.
    expect(computeLayerState(layer.id).missingVersions).toEqual([]);
    const prepared = prepareSynthesis({ layerId: layer.id });
    expect(prepared.dependencies.summary).toBe('7 / 7 READY');
  });
});

describe('scan and reconcile', () => {
  it('is healthy when the database and filesystem agree', () => {
    addDocument(fixture, 'World Model', 'v1');
    const report = scanAndReconcile(fixture.project.id);
    expect(report.issues).toHaveLength(0);
    expect(report.healthy).toBe(true);
  });

  it('reports a file dropped in by hand as unregistered, and can register it', () => {
    const stored = storeFile({
      projectSlug: fixture.project.slug,
      layerSlug: fixture.layerByName('Taxonomy').slug,
      filename: 'Taxonomy v1B.pdf',
      contents: Buffer.from('%PDF-1.4 dropped in by hand'),
    });

    const report = scanAndReconcile(fixture.project.id);
    const issue = report.issues.find((i) => i.kind === 'UNREGISTERED_FILE');
    expect(issue).toBeDefined();
    expect(issue?.fixable).toBe(true);

    const fixed = applyReconcileFix({
      projectId: fixture.project.id,
      kind: 'UNREGISTERED_FILE',
      path: stored.relativePath,
    });
    expect(fixed.ok).toBe(true);
    expect(fixed.report.issues.filter((i) => i.kind === 'UNREGISTERED_FILE')).toHaveLength(0);
    expect(listDocumentsByLayer(fixture.layerByName('Taxonomy').id)).toHaveLength(1);
  });

  it('reports a registered document whose file was deleted', () => {
    const document = addDocument(fixture, 'World Model', 'v1');
    deletePhysicalFile(document);

    const report = scanAndReconcile(fixture.project.id);
    const issue = report.issues.find((i) => i.kind === 'MISSING_PHYSICAL_FILE');
    expect(issue).toBeDefined();
    expect(issue?.documentId).toBe(document.id);
    expect(report.healthy).toBe(false);
  });

  it('never deletes a user file', () => {
    const document = addDocument(fixture, 'World Model', 'v1');
    scanAndReconcile(fixture.project.id);
    expect(getDocument(document.id)?.filesystemPath).toBeTruthy();
    const report = scanAndReconcile(fixture.project.id);
    expect(report.scannedFiles).toBeGreaterThan(0);
  });
});
