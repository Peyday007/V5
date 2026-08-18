/**
 * End-to-end test of the experience the spec calls the most important one (section 25):
 *
 *   open the app -> drop existing PDFs in -> the platform identifies them ->
 *   it reconstructs project state -> it says what is complete, what is missing,
 *   what is blocked, what is ready for synthesis, what is frozen ->
 *   "what's next?" returns one reliable answer.
 *
 * Everything here goes through the real services; nothing is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, deletePhysicalFile, freshProject, teardown, type TestProject } from './helpers.ts';
import { importFile } from '../server/services/importer.ts';
import { scanAndReconcile } from '../server/services/reconcile.ts';
import {
  computeLayerState,
  deriveLayerExpectationsFromDocuments,
  recomputeProject,
  setLayerExpectations,
} from '../server/services/stateEngine.ts';
import { checkCanonicalNames } from '../server/services/dependencies.ts';
import { buildPlan, calculateNextAction } from '../server/services/planner.ts';
import { prepareSynthesis, DependencyError } from '../server/services/synthesis.ts';
import { recordAudit } from '../server/services/auditEngine.ts';
import { freezeLayer, reopenLayer } from '../server/services/freeze.ts';
import { createRedoRun } from '../server/services/redoEngine.ts';
import { compilePrompt } from '../server/services/promptCompiler.ts';
import { handleChatMessage } from '../server/services/agent/chat.ts';
import { createRun, getRun } from '../server/repos/runs.ts';
import { getDocument, listDocumentsByLayer } from '../server/repos/documents.ts';
import { listEventsByLayer } from '../server/repos/events.ts';
import { storeFile } from '../server/services/storage.ts';
import type { ResearchRun } from '../server/domain/types.ts';

let fixture: TestProject;

beforeEach(() => {
  fixture = freshProject();
});

afterEach(() => {
  teardown();
});

function pdf(name: string): { originalFilename: string; contents: Buffer } {
  return { originalFilename: name, contents: Buffer.from(`%PDF-1.4 fake contents for ${name}`) };
}

describe('dropping existing research in', () => {
  it('infers layer, version and type from real filenames and registers them', () => {
    const results = [
      'Decision Routing Rules v1F.pdf',
      'Discovery Logic v1G.pdf',
      'World Model v1.pdf',
      'Qualification Logic v3.1.pdf',
    ].map((name) => importFile({ projectId: fixture.project.id, ...pdf(name) }));

    for (const result of results) {
      expect(result.registered, `${result.filename}: ${result.message}`).toBe(true);
      expect(result.documentId).toBeTruthy();
    }

    const [routing, discovery, world, qualification] = results;
    expect(routing?.inference.layerName).toBe('Decision Routing Rules');
    expect(routing?.inference.version).toBe('v1F');
    expect(routing?.inference.documentType).toBe('EXPANSION');

    expect(discovery?.inference.version).toBe('v1G');
    expect(world?.inference.version).toBe('v1');
    expect(world?.inference.documentType).toBe('FOUNDATION');
    expect(qualification?.inference.version).toBe('v3.1');
    expect(qualification?.inference.documentType).toBe('SYNTHESIS');
  });

  it('names the stored document canonically rather than trusting the dropped filename', () => {
    const result = importFile({
      projectId: fixture.project.id,
      ...pdf('deal dispatch - DISCOVERY LOGIC  v1g FINAL (2).pdf'),
    });
    if (!result.documentId) throw new Error(`expected registration, got: ${result.message}`);
    const document = getDocument(result.documentId);
    expect(document?.canonicalName).toBe('Discovery Logic v1G');
    expect(document?.filename).toBe('Discovery Logic v1G.pdf');
  });

  it('does not register a file it cannot confidently place', () => {
    const result = importFile({ projectId: fixture.project.id, ...pdf('meeting notes.pdf') });
    expect(result.registered).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    // Invariant 8: the file exists on disk but is not a registered document.
    expect(result.storedPath).toBeTruthy();
    expect(result.documentId).toBeNull();
  });

  it('reports a re-dropped identical file as a duplicate instead of double-registering', () => {
    const file = pdf('Taxonomy v1.pdf');
    const first = importFile({ projectId: fixture.project.id, ...file });
    const second = importFile({ projectId: fixture.project.id, ...file });
    expect(first.registered).toBe(true);
    expect(second.duplicateOfDocumentId).toBe(first.documentId);
    expect(listDocumentsByLayer(fixture.layerByName('Taxonomy').id)).toHaveLength(1);
  });
});

describe('layer state is derived, never typed in', () => {
  it('reports INCOMPLETE with the exact missing version when one is absent', () => {
    for (const version of ['v1', 'v1B', 'v1C', 'v1E']) {
      addDocument(fixture, 'Discovery Logic', version);
    }
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, ['v1', 'v1B', 'v1C', 'v1D', 'v1E']);

    const state = computeLayerState(layer.id);
    expect(state.missingVersions).toEqual(['v1D']);
    expect(state.documentsComplete).toBe(4);
    expect(state.documentsExpected).toBe(5);
    expect(state.status).toBe('INCOMPLETE');
  });

  it('becomes AUDIT_READY once every expected document is present', () => {
    const versions = ['v1', 'v1B', 'v1C', 'v1D', 'v1E'];
    for (const version of versions) addDocument(fixture, 'Execution Playbooks', version);
    const layer = fixture.layerByName('Execution Playbooks');
    setLayerExpectations(layer.id, versions);

    const state = computeLayerState(layer.id);
    expect(state.missingVersions).toEqual([]);
    expect(state.status).toBe('AUDIT_READY');
  });

  it('flags a registered document whose file vanished as inconsistent', () => {
    const document = addDocument(fixture, 'World Model', 'v1');
    deletePhysicalFile(document);
    recomputeProject(fixture.project.id);

    // Invariant 9: a database row is not healthy when its file disappeared.
    expect(getDocument(document.id)?.fileMissing).toBe(true);
    const state = computeLayerState(fixture.layerByName('World Model').id);
    expect(state.inconsistentDocuments).toContain('World Model v1');
  });

  it('derives expectations from what was actually imported', () => {
    for (const version of ['v1', 'v1B', 'v1C']) addDocument(fixture, 'Taxonomy', version);
    const state = deriveLayerExpectationsFromDocuments(fixture.layerByName('Taxonomy').id);
    expect(state.expectedVersions).toEqual(['v1', 'v1B', 'v1C']);
    expect(state.missingVersions).toEqual([]);
  });
});

describe('dependency checker', () => {
  it('renders the spec summary format and names what is missing', () => {
    const versions = ['v1A', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const version of versions.slice(0, 6)) addDocument(fixture, 'Decision Routing Rules', version);

    const required = versions.map((v) => `Decision Routing Rules ${v}`);
    const result = checkCanonicalNames(fixture.project.id, required);

    expect(result.requiredCount).toBe(7);
    expect(result.presentCount).toBe(6);
    expect(result.summary).toBe('6 / 7 READY');
    expect(result.missing).toEqual(['Decision Routing Rules v1G']);
    expect(result.ready).toBe(false);

    addDocument(fixture, 'Decision Routing Rules', 'v1G');
    const after = checkCanonicalNames(fixture.project.id, required);
    expect(after.summary).toBe('7 / 7 READY');
    expect(after.ready).toBe(true);
  });

  it('does not count a dependency whose file is gone', () => {
    const document = addDocument(fixture, 'Monetization Logic', 'v1');
    deletePhysicalFile(document);
    recomputeProject(fixture.project.id);

    const result = checkCanonicalNames(fixture.project.id, ['Monetization Logic v1']);
    expect(result.presentCount).toBe(0);
    expect(result.inconsistent).toContain('Monetization Logic v1');
  });
});

describe('synthesis', () => {
  const versions = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];

  it('refuses to run with an incomplete source packet', () => {
    for (const version of versions.slice(0, 6)) addDocument(fixture, 'Discovery Logic', version);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, versions);

    // Invariant 4.
    let error: unknown;
    try {
      prepareSynthesis({ layerId: layer.id });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DependencyError);
    expect((error as DependencyError).result.missing).toContain('Discovery Logic v1G');
  });

  it('unblocks automatically once the missing dependency is imported', () => {
    for (const version of versions.slice(0, 6)) addDocument(fixture, 'Discovery Logic', version);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, versions);

    importFile({ projectId: fixture.project.id, ...pdf('Discovery Logic v1G.pdf') });

    const preparation = prepareSynthesis({ layerId: layer.id });
    expect(preparation.dependencies.ready).toBe(true);
    expect(preparation.dependencies.summary).toBe('7 / 7 READY');
    expect(preparation.document.version).toBe('v3.1');
    expect(preparation.document.canonicalName).toBe('Discovery Logic v3.1');
    // Invariant 10: the exact prompt and attachment list are recorded on the run.
    expect(preparation.run.prompt).toBeTruthy();
    expect(preparation.run.requiredAttachments).toHaveLength(7);
    expect(getRun(preparation.run.id)?.prompt).toBe(preparation.run.prompt);
  });

  it('proceeds when the user explicitly overrides the warning', () => {
    for (const version of versions.slice(0, 6)) addDocument(fixture, 'Discovery Logic', version);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, versions);

    const preparation = prepareSynthesis({
      layerId: layer.id,
      override: true,
      overrideReason: 'v1G is not going to happen',
    });
    expect(preparation.run.dependencyOverride).toBe(true);
    expect(preparation.dependencies.ready).toBe(false);
  });
});

describe('audit, redo and freeze', () => {
  it('compiles an expansion prompt that carries the enforced naming block', () => {
    addDocument(fixture, 'Qualification Logic', 'v1');
    const layer = fixture.layerByName('Qualification Logic');
    const compiled = compilePrompt({
      projectId: fixture.project.id,
      layerId: layer.id,
      runType: 'EXPANSION',
    });

    expect(compiled.targetVersion).toBe('v1B');
    expect(compiled.targetCanonicalName).toBe('Qualification Logic v1B');
    expect(compiled.expectedFilename).toBe('Qualification Logic v1B.pdf');
    expect(compiled.expectedConversationTitle).toBe('Qualification Logic v1B');
    expect(compiled.requiredAttachments).toContain('Qualification Logic v1');
    // The naming rules and the final check are non-negotiable parts of every prompt.
    expect(compiled.sections.map((s) => s.key)).toContain('NAMING_RULES');
    expect(compiled.sections.at(-1)?.key).toBe('FINAL_NAMING_CHECK');
    expect(compiled.prompt).toContain('Qualification Logic v1B');
  });

  it('preserves lineage across a redo', () => {
    const document = addDocument(fixture, 'Learning Evaluation', 'v1');
    const layer = fixture.layerByName('Learning Evaluation');

    const { run } = prepareRun(layer.id, document.id);
    const redo = createRedoRun({
      parentRunId: run.id,
      reason: 'missing source-family observability section',
    });

    // Invariant 5.
    const parent = getRun(run.id);
    expect(parent).not.toBeNull();
    expect(parent?.prompt).toBe(run.prompt);
    expect(redo.parentRunId).toBe(run.id);
    expect(redo.attemptNumber).toBe(run.attemptNumber + 1);
    expect(redo.redoReason).toContain('observability');
  });

  it('freezes a layer only with a canonical artifact, and keeps provenance', () => {
    for (const version of ['v1', 'v1B', 'v1C']) addDocument(fixture, 'World Model', version);
    const layer = fixture.layerByName('World Model');

    // Invariant 6: no canonical document yet, so freezing must refuse.
    expect(() => freezeLayer(layer.id)).toThrow();

    const canonical = addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const state = freezeLayer(layer.id, canonical.id);
    expect(state.status).toBe('FROZEN');
    expect(state.canonicalName).toBe('World Model v3.1');

    const documents = listDocumentsByLayer(layer.id);
    expect(documents).toHaveLength(4); // nothing deleted
    expect(documents.find((d) => d.version === 'v3.1')?.isCanonical).toBe(true);
    expect(documents.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(3);

    const reopened = reopenLayer(layer.id, 'cross-layer audit found a contradiction');
    expect(reopened.status).toBe('REOPENED');
    expect(listDocumentsByLayer(layer.id)).toHaveLength(4);
  });

  it('records audits structurally, not as prose', () => {
    const document = addDocument(fixture, 'Monetization Logic', 'v1');
    const layer = fixture.layerByName('Monetization Logic');

    const outcome = recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      auditedDocumentId: document.id,
      result: {
        verdict: 'MORE_RESEARCH',
        summary: 'Pricing ladder is asserted without evidence.',
        failures: ['No evidence for the pricing ladder', 'Section 4 contradicts section 2'],
        missingDocuments: ['Monetization Logic v1B'],
        requiredResearchRuns: ['Monetization Logic v1B'],
      },
    });

    // Invariant 11.
    expect(outcome.audit.findings.filter((f) => f.findingType === 'FAILURE')).toHaveLength(2);
    expect(outcome.audit.findings.filter((f) => f.findingType === 'MISSING_DOCUMENT')).toHaveLength(1);
    expect(outcome.layerState.latestAuditVerdict).toBe('MORE_RESEARCH');
    expect(outcome.layerState.status).toBe('MORE_RESEARCH_REQUIRED');

    // Invariant 3.
    const events = listEventsByLayer(layer.id);
    expect(events.some((e) => e.eventType === 'AUDIT_COMPLETED')).toBe(true);
  });
});

describe('the planner answers "what next?" from real state', () => {
  it('names the missing document as the thing that is blocking', () => {
    const versions = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const version of versions.slice(0, 6)) addDocument(fixture, 'Discovery Logic', version);
    setLayerExpectations(fixture.layerByName('Discovery Logic').id, versions);
    recomputeProject(fixture.project.id);

    const plan = buildPlan(fixture.project.id);
    const discovery = [...plan.now, ...plan.next, ...plan.blocked].find(
      (item) => item.layerName === 'Discovery Logic',
    );
    expect(discovery).toBeDefined();
    expect(discovery?.missing).toContain('Discovery Logic v1G');

    const action = calculateNextAction(fixture.project.id);
    expect(action).not.toBeNull();
    expect(plan.nextBestActionText.length).toBeGreaterThan(0);
  });

  it('is deterministic across repeated calls', () => {
    for (const version of ['v1', 'v1B']) addDocument(fixture, 'Taxonomy', version);
    recomputeProject(fixture.project.id);
    const first = buildPlan(fixture.project.id);
    const second = buildPlan(fixture.project.id);
    expect(second.nextBestActionText).toBe(first.nextBestActionText);
    expect(second.now.map((i) => i.layerId)).toEqual(first.now.map((i) => i.layerId));
  });
});

describe('reconciliation', () => {
  it('reports a file on disk that nobody registered', () => {
    storeFile({
      projectSlug: fixture.project.slug,
      layerSlug: fixture.layerByName('Taxonomy').slug,
      filename: 'Taxonomy v1B.pdf',
      contents: Buffer.from('%PDF-1.4 dropped in by hand'),
    });

    const report = scanAndReconcile(fixture.project.id);
    const issue = report.issues.find((i) => i.kind === 'UNREGISTERED_FILE');
    expect(issue).toBeDefined();
    expect(issue?.path).toContain('Taxonomy v1B.pdf');
    expect(report.healthy).toBe(false);
  });

  it('reports a registered document whose file was deleted', () => {
    const document = addDocument(fixture, 'World Model', 'v1');
    deletePhysicalFile(document);

    const report = scanAndReconcile(fixture.project.id);
    const issue = report.issues.find((i) => i.kind === 'MISSING_PHYSICAL_FILE');
    expect(issue).toBeDefined();
    expect(issue?.documentId).toBe(document.id);
  });

  it('is healthy when the database and the filesystem agree', () => {
    addDocument(fixture, 'World Model', 'v1');
    const report = scanAndReconcile(fixture.project.id);
    expect(report.issues).toHaveLength(0);
    expect(report.healthy).toBe(true);
  });
});

describe('chat never invents state', () => {
  it('answers "what is missing?" from the database', () => {
    const versions = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const version of versions.slice(0, 6)) addDocument(fixture, 'Discovery Logic', version);
    setLayerExpectations(fixture.layerByName('Discovery Logic').id, versions);
    recomputeProject(fixture.project.id);

    const turn = handleChatMessage({ projectId: fixture.project.id, content: 'What is missing?' });
    expect(turn.toolCalls.length).toBeGreaterThan(0);
    expect(turn.assistantMessage.content).toContain('Discovery Logic v1G');
  });

  it('does not claim a document exists when it does not', () => {
    const turn = handleChatMessage({
      projectId: fixture.project.id,
      content: 'What is the status of Discovery Logic?',
    });
    expect(turn.toolCalls.length).toBeGreaterThan(0);
    expect(turn.assistantMessage.content).toMatch(/NOT_STARTED|no documents|0/i);
  });

  it('answers "what next?" with the planner result', () => {
    addDocument(fixture, 'World Model', 'v1');
    recomputeProject(fixture.project.id);
    const turn = handleChatMessage({ projectId: fixture.project.id, content: "What's next?" });
    expect(turn.assistantMessage.content.length).toBeGreaterThan(0);
    expect(turn.toolCalls.some((c) => c.name === 'calculate_next_action')).toBe(true);
  });
});

/** Create a persisted, already-failed run so lineage tests have something to redo. */
function prepareRun(layerId: string, documentId: string): { run: ResearchRun } {
  const compiled = compilePrompt({ projectId: fixture.project.id, layerId, runType: 'EXPANSION' });
  const run = createRun({
    projectId: fixture.project.id,
    layerId,
    targetDocumentId: documentId,
    targetVersion: compiled.targetVersion,
    runType: 'EXPANSION',
    status: 'FAILED',
    prompt: compiled.prompt,
    promptSections: compiled.sections,
    requiredAttachments: compiled.requiredAttachments,
    expectedConversationTitle: compiled.expectedConversationTitle,
    expectedFilename: compiled.expectedFilename,
  });
  return { run };
}
