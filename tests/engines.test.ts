/**
 * Engine-level tests that do not depend on import, chat or HTTP: the dependency
 * checker, the state engine, the planner, the prompt compiler, and the
 * audit/redo/synthesis/freeze lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, deletePhysicalFile, freshProject, teardown, type TestProject } from './helpers.ts';
import { checkCanonicalNames, setRunDependencies, checkRunDependencies } from '../server/services/dependencies.ts';
import {
  computeLayerState,
  deriveLayerExpectationsFromDocuments,
  recomputeProject,
  setLayerExpectations,
  setLayerManualStatus,
} from '../server/services/stateEngine.ts';
import { buildPlan, calculateNextAction } from '../server/services/planner.ts';
import { compilePrompt } from '../server/services/promptCompiler.ts';
import { prepareSynthesis, DependencyError } from '../server/services/synthesis.ts';
import { normalizeAuditResult, parseAuditJson, recordAudit } from '../server/services/auditEngine.ts';
import { canAutoRedo, createRedoRun } from '../server/services/redoEngine.ts';
import { freezeLayer, reopenLayer } from '../server/services/freeze.ts';
import { writeProjectState, readProjectState } from '../server/services/runtimeState.ts';
import { createRun, getRun, updateRun } from '../server/repos/runs.ts';
import { getDocument, listDocumentsByLayer } from '../server/repos/documents.ts';
import { listEventsByLayer } from '../server/repos/events.ts';
import { getLayer } from '../server/repos/layers.ts';
import { getProject } from '../server/repos/projects.ts';

let fixture: TestProject;

beforeEach(() => {
  fixture = freshProject();
});
afterEach(() => {
  teardown();
});

const FULL_PACKET = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
/** The planner's audit priority; blockages must rank ahead of it. */
const PRIORITY_AUDIT = 30;

/** A persisted, already-failed expansion run so lineage tests have a parent. */
function failedRun(layerId: string, documentId: string | null = null) {
  const compiled = compilePrompt({ projectId: fixture.project.id, layerId, runType: 'EXPANSION' });
  return createRun({
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
}

describe('dependency checker', () => {
  it('renders the spec summary and names what is missing', () => {
    for (const v of FULL_PACKET.slice(0, 6)) addDocument(fixture, 'Decision Routing Rules', v);
    const required = FULL_PACKET.map((v) => `Decision Routing Rules ${v}`);

    const before = checkCanonicalNames(fixture.project.id, required);
    expect(before.summary).toBe('6 / 7 READY');
    expect(before.missing).toEqual(['Decision Routing Rules v1G']);
    expect(before.ready).toBe(false);

    addDocument(fixture, 'Decision Routing Rules', 'v1G');
    const after = checkCanonicalNames(fixture.project.id, required);
    expect(after.summary).toBe('7 / 7 READY');
    expect(after.ready).toBe(true);
  });

  it('refuses to count a document whose file disappeared', () => {
    const document = addDocument(fixture, 'Monetization Logic', 'v1');
    deletePhysicalFile(document);
    const result = checkCanonicalNames(fixture.project.id, ['Monetization Logic v1']);
    expect(result.presentCount).toBe(0);
    expect(result.inconsistent).toContain('Monetization Logic v1');
  });

  it('stores run dependencies idempotently', () => {
    const layer = fixture.layerByName('Discovery Logic');
    const run = failedRun(layer.id);
    const names = ['Discovery Logic v1', 'Discovery Logic v1B'];
    const first = setRunDependencies(run.id, names);
    const second = setRunDependencies(run.id, names);
    expect(first).toHaveLength(2);
    expect(second.map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
    expect(checkRunDependencies(run.id).requiredCount).toBe(2);
  });
});

describe('state engine', () => {
  it('reports INCOMPLETE naming the exact missing version', () => {
    for (const v of ['v1', 'v1B', 'v1C', 'v1E']) addDocument(fixture, 'Discovery Logic', v);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, ['v1', 'v1B', 'v1C', 'v1D', 'v1E']);

    const state = computeLayerState(layer.id);
    expect(state.missingVersions).toEqual(['v1D']);
    expect(state.documentsComplete).toBe(4);
    expect(state.documentsExpected).toBe(5);
    expect(state.status).toBe('INCOMPLETE');
  });

  it('becomes AUDIT_READY when every expected document is present', () => {
    const versions = ['v1', 'v1B', 'v1C'];
    for (const v of versions) addDocument(fixture, 'Execution Playbooks', v);
    const layer = fixture.layerByName('Execution Playbooks');
    setLayerExpectations(layer.id, versions);
    expect(computeLayerState(layer.id).status).toBe('AUDIT_READY');
  });

  it('marks a vanished file inconsistent and flips the document flag', () => {
    const document = addDocument(fixture, 'World Model', 'v1');
    deletePhysicalFile(document);
    recomputeProject(fixture.project.id);

    expect(getDocument(document.id)?.fileMissing).toBe(true);
    expect(computeLayerState(fixture.layerByName('World Model').id).inconsistentDocuments)
      .toContain('World Model v1');
  });

  it('derives expectations from what was actually imported', () => {
    for (const v of ['v1', 'v1B', 'v1C']) addDocument(fixture, 'Taxonomy', v);
    const state = deriveLayerExpectationsFromDocuments(fixture.layerByName('Taxonomy').id);
    expect(state.expectedVersions).toEqual(['v1', 'v1B', 'v1C']);
    expect(state.missingVersions).toEqual([]);
  });

  it('honours a manual override but still exposes the derived reason', () => {
    addDocument(fixture, 'Taxonomy', 'v1');
    const layer = fixture.layerByName('Taxonomy');
    const state = setLayerManualStatus(layer.id, 'BLOCKED', 'waiting on an external source');
    expect(state.status).toBe('BLOCKED');
    expect(state.statusSource).toBe('MANUAL');
    expect(state.reason.length).toBeGreaterThan(0);

    const cleared = setLayerManualStatus(layer.id, null);
    expect(cleared.statusSource).toBe('DERIVED');
  });
});

describe('prompt compiler', () => {
  it('targets the next expansion and enforces naming', () => {
    addDocument(fixture, 'Qualification Logic', 'v1');
    const compiled = compilePrompt({
      projectId: fixture.project.id,
      layerId: fixture.layerByName('Qualification Logic').id,
      runType: 'EXPANSION',
    });

    expect(compiled.targetVersion).toBe('v1B');
    expect(compiled.targetCanonicalName).toBe('Qualification Logic v1B');
    expect(compiled.expectedConversationTitle).toBe('Qualification Logic v1B');
    expect(compiled.expectedFilename).toBe('Qualification Logic v1B.pdf');
    expect(compiled.requiredAttachments).toContain('Qualification Logic v1');
    expect(compiled.sections.map((s) => s.key)).toContain('NAMING_RULES');
    expect(compiled.sections.at(-1)?.key).toBe('FINAL_NAMING_CHECK');
  });

  it('builds a synthesis prompt over the whole source packet', () => {
    for (const v of FULL_PACKET) addDocument(fixture, 'Decision Routing Rules', v);
    const compiled = compilePrompt({
      projectId: fixture.project.id,
      layerId: fixture.layerByName('Decision Routing Rules').id,
      runType: 'SYNTHESIS',
    });
    expect(compiled.targetVersion).toBe('v3.1');
    expect(compiled.requiredAttachments).toHaveLength(7);
    expect(compiled.expectedFilename).toBe('Decision Routing Rules v3.1.pdf');
  });

  it('declares the other layers out of scope', () => {
    addDocument(fixture, 'World Model', 'v1');
    const compiled = compilePrompt({
      projectId: fixture.project.id,
      layerId: fixture.layerByName('World Model').id,
      runType: 'EXPANSION',
    });
    const boundaries = compiled.sections.find((s) => s.key === 'CROSS_LAYER_BOUNDARIES');
    expect(boundaries?.body).toContain('Discovery Logic');
    expect(boundaries?.body).not.toContain('World Model v');
  });
});

describe('synthesis', () => {
  it('refuses an incomplete packet and unblocks once it is complete', () => {
    for (const v of FULL_PACKET.slice(0, 6)) addDocument(fixture, 'Discovery Logic', v);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, FULL_PACKET);

    let error: unknown;
    try {
      prepareSynthesis({ layerId: layer.id });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DependencyError);
    expect((error as DependencyError).result.missing).toContain('Discovery Logic v1G');

    addDocument(fixture, 'Discovery Logic', 'v1G');
    const prepared = prepareSynthesis({ layerId: layer.id });
    expect(prepared.dependencies.summary).toBe('7 / 7 READY');
    expect(prepared.document.canonicalName).toBe('Discovery Logic v3.1');
    // Invariant 10: the exact prompt and attachment list are persisted on the run.
    expect(getRun(prepared.run.id)?.prompt).toBe(prepared.run.prompt);
    expect(prepared.run.requiredAttachments).toHaveLength(7);
  });

  it('refuses outright on a layer with nothing to consolidate', () => {
    // "0 / 0 READY" is technically ready and completely meaningless.
    expect(() => prepareSynthesis({ layerId: fixture.layerByName('Taxonomy').id }))
      .toThrow(/no completed research/i);
    expect(() => prepareSynthesis({ layerId: fixture.layerByName('Taxonomy').id, override: true }))
      .toThrow(/no completed research/i);
  });

  it('records the reason when the user overrides the warning', () => {
    for (const v of FULL_PACKET.slice(0, 6)) addDocument(fixture, 'Discovery Logic', v);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, FULL_PACKET);

    const prepared = prepareSynthesis({
      layerId: layer.id,
      override: true,
      overrideReason: 'v1G is not going to happen',
    });
    expect(prepared.run.dependencyOverride).toBe(true);
    expect(prepared.dependencies.ready).toBe(false);
  });
});

describe('audit verdict coercion', () => {
  const ctx = () => ({ projectId: fixture.project.id, layerId: fixture.layerByName('Taxonomy').id });

  it('accepts the canonical verdicts and common aliases', () => {
    expect(normalizeAuditResult({ verdict: 'PASS' }, ctx()).verdict).toBe('PASS');
    expect(normalizeAuditResult({ verdict: 'ready for synthesis' as never }, ctx()).verdict)
      .toBe('READY_FOR_SYNTHESIS');
  });

  it('never reads a negated verdict as its own opposite', () => {
    // "not ready for synthesis" contains "ready for synthesis"; treating that as
    // approval would advance a layer the audit had just rejected.
    for (const raw of [
      'not ready for synthesis',
      'NOT READY_TO_FREEZE',
      'no pass',
      'definitely not ready for synthesis',
      'failed audit',
    ]) {
      expect(normalizeAuditResult({ verdict: raw as never }, ctx()).verdict, raw)
        .toBe('MORE_RESEARCH');
    }
  });

  it('parses fenced model JSON without inverting it', () => {
    const parsed = parseAuditJson('```json\n{"verdict":"not ready for synthesis","summary":"x"}\n```');
    expect(parsed?.verdict).toBe('MORE_RESEARCH');
  });

  it('always produces the structured arrays, even from a bare verdict', () => {
    const result = normalizeAuditResult({ verdict: 'PATCH' }, ctx());
    expect(result.failures).toEqual([]);
    expect(result.missingDocuments).toEqual([]);
    expect(result.requiredResearchRuns).toEqual([]);
    expect(result.requiredPatches).toEqual([]);
    expect(result.nextAction.length).toBeGreaterThan(0);
  });
});

describe('audit, redo and freeze', () => {
  it('stores audits structurally and moves the layer', () => {
    const document = addDocument(fixture, 'Monetization Logic', 'v1');
    const layer = fixture.layerByName('Monetization Logic');

    const outcome = recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      auditedDocumentId: document.id,
      result: {
        verdict: 'MORE_RESEARCH',
        summary: 'Pricing ladder asserted without evidence.',
        failures: ['No evidence for the pricing ladder', 'Section 4 contradicts section 2'],
        missingDocuments: ['Monetization Logic v1B'],
      },
    });

    expect(outcome.audit.findings.filter((f) => f.findingType === 'FAILURE')).toHaveLength(2);
    expect(outcome.audit.findings.filter((f) => f.findingType === 'MISSING_DOCUMENT')).toHaveLength(1);
    expect(outcome.layerState.status).toBe('MORE_RESEARCH_REQUIRED');
    expect(listEventsByLayer(layer.id).some((e) => e.eventType === 'AUDIT_COMPLETED')).toBe(true);
  });

  it('creates a redo without touching the failed attempt', () => {
    const document = addDocument(fixture, 'Learning Evaluation', 'v1');
    const layer = fixture.layerByName('Learning Evaluation');
    const parent = failedRun(layer.id, document.id);

    const redo = createRedoRun({
      parentRunId: parent.id,
      reason: 'missing source-family observability section',
    });

    const reloaded = getRun(parent.id);
    expect(reloaded?.prompt).toBe(parent.prompt);
    expect(reloaded?.status).toBe('FAILED');
    expect(redo.parentRunId).toBe(parent.id);
    expect(redo.attemptNumber).toBe(parent.attemptNumber + 1);
    expect(redo.redoReason).toContain('observability');
    expect(redo.prompt).toBeTruthy();
  });

  it('stops automatic redos at the configured cap', () => {
    const layer = fixture.layerByName('Learning Evaluation');
    let current = failedRun(layer.id);
    for (let i = 0; i < 2; i += 1) {
      current = createRedoRun({ parentRunId: current.id, reason: `attempt ${i}`, automatic: true });
    }
    const verdict = canAutoRedo(current.id, 2);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason.toLowerCase()).toContain('human');
  });

  it('freezes only with a canonical artifact and keeps provenance', () => {
    for (const v of ['v1', 'v1B', 'v1C']) addDocument(fixture, 'World Model', v);
    const layer = fixture.layerByName('World Model');

    expect(() => freezeLayer(layer.id)).toThrow();

    const canonical = addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const state = freezeLayer(layer.id, canonical.id);
    expect(state.status).toBe('FROZEN');
    expect(state.canonicalName).toBe('World Model v3.1');

    const documents = listDocumentsByLayer(layer.id);
    expect(documents).toHaveLength(4);
    expect(documents.find((d) => d.version === 'v3.1')?.isCanonical).toBe(true);
    expect(documents.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(3);

    const reopened = reopenLayer(layer.id, 'cross-layer audit found a contradiction');
    expect(reopened.status).toBe('REOPENED');
    expect(listDocumentsByLayer(layer.id)).toHaveLength(4);
  });
});

describe('blockages clear themselves', () => {
  it('stops blocking once the document a MISSING_DEPENDENCY audit named arrives', () => {
    addDocument(fixture, 'Discovery Logic', 'v1');
    const layer = fixture.layerByName('Discovery Logic');

    recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: {
        verdict: 'MISSING_DEPENDENCY',
        summary: 'Needs the v1B sibling before it can be judged.',
        missingDocuments: ['Discovery Logic v1B'],
      },
    });
    expect(computeLayerState(layer.id).status).toBe('BLOCKED');

    // Spec section 18: uploading the missing dependency is what unblocks the
    // work — the user should not have to re-run the audit to clear the flag.
    addDocument(fixture, 'Discovery Logic', 'v1B');
    recomputeProject(fixture.project.id);

    const after = computeLayerState(layer.id);
    expect(after.missingDependencies).toEqual([]);
    expect(after.status).not.toBe('BLOCKED');
  });

  it('keeps blocking when the audit named nothing to resolve', () => {
    addDocument(fixture, 'Qualification Logic', 'v1');
    const layer = fixture.layerByName('Qualification Logic');
    recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: { verdict: 'BLOCKED', summary: 'Waiting on a decision about scope.' },
    });
    recomputeProject(fixture.project.id);
    // Nothing was named, so nothing can arrive to clear it — a human must act.
    expect(computeLayerState(layer.id).status).toBe('BLOCKED');
  });

  it('gives a reopened layer its source packet back so it can be re-synthesised', () => {
    for (const v of ['v1', 'v1B', 'v1C']) addDocument(fixture, 'World Model', v);
    const canonical = addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = fixture.layerByName('World Model');
    freezeLayer(layer.id, canonical.id);
    expect(listDocumentsByLayer(layer.id).filter((d) => d.status === 'SUPERSEDED')).toHaveLength(3);

    reopenLayer(layer.id, 'cross-layer audit found a contradiction');
    recomputeProject(fixture.project.id);

    // The provenance is usable again — otherwise the layer dead-ends: its own
    // registered, on-disk documents would report as missing forever.
    const restored = listDocumentsByLayer(layer.id);
    expect(restored.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(0);
    expect(restored.every((d) => !d.frozen)).toBe(true);
    expect(() => prepareSynthesis({ layerId: layer.id })).not.toThrow();
  });

  it('lets a reopen lapse once work resumes, instead of pinning the layer', () => {
    for (const v of ['v1', 'v1B']) addDocument(fixture, 'World Model', v);
    const canonical = addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = fixture.layerByName('World Model');
    freezeLayer(layer.id, canonical.id);
    reopenLayer(layer.id, 'contradiction');
    recomputeProject(fixture.project.id);

    // Derived, never pinned — a pin would mask every later audit forever.
    expect(computeLayerState(layer.id).statusSource).toBe('DERIVED');

    recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: { verdict: 'READY_FOR_SYNTHESIS', summary: 'Rework holds up.' },
    });
    recomputeProject(fixture.project.id);
    expect(computeLayerState(layer.id).status).toBe('SYNTHESIS_READY');
  });

  it('keeps a reopened layer reopened until something happens', () => {
    for (const v of ['v1', 'v1B']) addDocument(fixture, 'World Model', v);
    const canonical = addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = fixture.layerByName('World Model');
    freezeLayer(layer.id, canonical.id);

    expect(reopenLayer(layer.id, 'cross-layer contradiction').status).toBe('REOPENED');
    recomputeProject(fixture.project.id);
    expect(computeLayerState(layer.id).status).toBe('REOPENED');
  });
});

describe('planner', () => {
  it('names the blocking document and is deterministic', () => {
    for (const v of FULL_PACKET.slice(0, 6)) addDocument(fixture, 'Discovery Logic', v);
    setLayerExpectations(fixture.layerByName('Discovery Logic').id, FULL_PACKET);
    recomputeProject(fixture.project.id);

    const plan = buildPlan(fixture.project.id);
    const discovery = [...plan.now, ...plan.next, ...plan.blocked, ...plan.later].find(
      (item) => item.layerName === 'Discovery Logic',
    );
    expect(discovery).toBeDefined();
    expect(discovery?.missing).toContain('Discovery Logic v1G');
    expect(plan.nextBestActionText.length).toBeGreaterThan(0);
    expect(calculateNextAction(fixture.project.id)).not.toBeNull();

    const again = buildPlan(fixture.project.id);
    expect(again.nextBestActionText).toBe(plan.nextBestActionText);
    expect(again.now.map((i) => i.layerId)).toEqual(plan.now.map((i) => i.layerId));
  });

  it('names the same document as the layer row does', () => {
    // Regression: the planner used to target the highest version while the state
    // engine targeted the first unaudited one, so the two panes disagreed.
    addDocument(fixture, 'World Model', 'v1');
    addDocument(fixture, 'World Model', 'v1B');
    recomputeProject(fixture.project.id);

    const state = computeLayerState(fixture.layerByName('World Model').id);
    expect(state.status).toBe('AUDIT_READY');

    const plan = buildPlan(fixture.project.id);
    const item = [...plan.now, ...plan.next].find((i) => i.layerName === 'World Model');
    expect(item?.title).toBe(state.nextAction);
    expect(item?.targetVersion).toBe(state.nextVersion);
  });

  it('makes a real blockage the next best action, ahead of ordinary work', () => {
    // The spec's example: Discovery Logic is BLOCKED missing v1G while another
    // layer has an audit waiting, and the one prominent answer is about v1G.
    for (const v of FULL_PACKET.slice(0, 6)) addDocument(fixture, 'Discovery Logic', v);
    const layer = fixture.layerByName('Discovery Logic');
    setLayerExpectations(layer.id, FULL_PACKET);
    addDocument(fixture, 'World Model', 'v1');

    // A run requiring the packet is what turns "v1G is expected" into
    // "v1G is required". (An explicitly overridden run would not block, by design.)
    const run = failedRun(layer.id);
    updateRun(run.id, { status: 'PLANNED' });
    setRunDependencies(run.id, FULL_PACKET.map((v) => `Discovery Logic ${v}`));
    recomputeProject(fixture.project.id);

    const state = computeLayerState(layer.id);
    expect(state.status).toBe('BLOCKED');
    expect(state.missingDependencies).toContain('Discovery Logic v1G');

    const plan = buildPlan(fixture.project.id);
    expect(plan.nextBestActionText).toContain('Discovery Logic v1G');
    expect(plan.nextBestAction?.priority).toBeLessThan(PRIORITY_AUDIT);
  });

  it('prioritises an inconsistent file above all ordinary work', () => {
    const document = addDocument(fixture, 'Discovery Logic', 'v1');
    addDocument(fixture, 'World Model', 'v1');
    deletePhysicalFile(document);
    recomputeProject(fixture.project.id);

    const plan = buildPlan(fixture.project.id);
    // Invariant 9: nothing else about the project is safe to act on first.
    expect(plan.nextBestAction?.actionType).toBe('RECONCILE');
    expect(plan.nextBestActionText).toContain('Discovery Logic v1');
    expect(plan.blocked.some((i) => i.actionType === 'RECONCILE')).toBe(true);
  });

  it('puts a frozen layer in LATER with nothing to do', () => {
    const canonical = addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    freezeLayer(fixture.layerByName('World Model').id, canonical.id);
    recomputeProject(fixture.project.id);

    const plan = buildPlan(fixture.project.id);
    const item = plan.later.find((i) => i.layerName === 'World Model');
    expect(item).toBeDefined();
    expect(item?.actionType).toBe('NONE');
  });
});

describe('waves advance on their own', () => {
  it('moves the layer and the project forward as research progresses', () => {
    const layer = fixture.layerByName('Taxonomy');

    addDocument(fixture, 'Taxonomy', 'v1');
    recomputeProject(fixture.project.id);
    expect(getLayer(layer.id)?.currentWave).toBe(1);
    expect(getProject(fixture.project.id)?.currentWave).toBe(1);

    addDocument(fixture, 'Taxonomy', 'v1B');
    recomputeProject(fixture.project.id);
    expect(getLayer(layer.id)?.currentWave).toBe(2);
    expect(getProject(fixture.project.id)?.currentWave).toBe(2);

    addDocument(fixture, 'Taxonomy', 'v3.1', { documentType: 'SYNTHESIS' });
    recomputeProject(fixture.project.id);
    expect(getLayer(layer.id)?.currentWave).toBe(3);
    // The project sits at the furthest wave any layer has reached.
    expect(getProject(fixture.project.id)?.currentWave).toBe(3);
    expect(getLayer(fixture.layerByName('World Model').id)?.currentWave).toBe(1);
  });
});

describe('runtime state file', () => {
  it('writes a derived snapshot that mirrors the database', () => {
    for (const v of ['v1', 'v1B']) addDocument(fixture, 'Taxonomy', v);
    recomputeProject(fixture.project.id);

    const written = writeProjectState(fixture.project.id);
    const read = readProjectState();
    expect(read).not.toBeNull();
    expect(read?.project.slug).toBe('deal-dispatch');
    expect(read?.layers).toHaveLength(8);
    expect(read?.nextBestAction).toBe(written.nextBestAction);
    expect(read?.documents.some((d) => d.canonicalName === 'Taxonomy v1B')).toBe(true);
  });
});
