/**
 * Engine-level tests that do not depend on import, chat or HTTP: the dependency
 * checker, the state engine, the planner, the prompt compiler, and the
 * audit/redo/synthesis/freeze lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, deletePhysicalFile, freshProject, teardown, type TestProject } from './helpers.ts';
import {
  checkCanonicalNames,
  checkRunDependencies,
  setRunDependencies,
} from '../server/services/dependencies.ts';
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

beforeEach(async () => {
  fixture = await freshProject();
});
afterEach(async () => {
  await teardown();
});

const FULL_PACKET = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
/** The planner's audit priority; blockages must rank ahead of it. */
const PRIORITY_AUDIT = 30;

/** A persisted, already-failed expansion run so lineage tests have a parent. */
async function failedRun(layerId: string, documentId: string | null = null) {
  const compiled = await compilePrompt({ projectId: fixture.project.id, layerId, runType: 'EXPANSION' });
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
  it('renders the spec summary and names what is missing', async () => {
    for (const v of FULL_PACKET.slice(0, 6)) await addDocument(fixture, 'Decision Routing Rules', v);
    const required = FULL_PACKET.map((v) => `Decision Routing Rules ${v}`);

    const before = await checkCanonicalNames(fixture.project.id, required);
    expect(before.summary).toBe('6 / 7 READY');
    expect(before.missing).toEqual(['Decision Routing Rules v1G']);
    expect(before.ready).toBe(false);

    await addDocument(fixture, 'Decision Routing Rules', 'v1G');
    const after = await checkCanonicalNames(fixture.project.id, required);
    expect(after.summary).toBe('7 / 7 READY');
    expect(after.ready).toBe(true);
  });

  it('refuses to count a document whose file disappeared', async () => {
    const document = await addDocument(fixture, 'Monetization Logic', 'v1');
    deletePhysicalFile(document);
    const result = await checkCanonicalNames(fixture.project.id, ['Monetization Logic v1']);
    expect(result.presentCount).toBe(0);
    expect(result.inconsistent).toContain('Monetization Logic v1');
  });

  it('stores run dependencies idempotently', async () => {
    const layer = await fixture.layerByName('Discovery Logic');
    const run = await failedRun(layer.id);
    const names = ['Discovery Logic v1', 'Discovery Logic v1B'];
    const first = await setRunDependencies(run.id, names);
    const second = await setRunDependencies(run.id, names);
    expect(first).toHaveLength(2);
    expect(second.map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
    expect((await checkRunDependencies(run.id)).requiredCount).toBe(2);
  });
});

describe('state engine', () => {
  it('reports INCOMPLETE naming the exact missing version', async () => {
    for (const v of ['v1', 'v1B', 'v1C', 'v1E']) await addDocument(fixture, 'Discovery Logic', v);
    const layer = await fixture.layerByName('Discovery Logic');
    await setLayerExpectations(layer.id, ['v1', 'v1B', 'v1C', 'v1D', 'v1E']);

    const state = await computeLayerState(layer.id);
    expect(state.missingVersions).toEqual(['v1D']);
    expect(state.documentsComplete).toBe(4);
    expect(state.documentsExpected).toBe(5);
    expect(state.status).toBe('INCOMPLETE');
  });

  it('becomes AUDIT_READY when every expected document is present', async () => {
    const versions = ['v1', 'v1B', 'v1C'];
    for (const v of versions) await addDocument(fixture, 'Execution Playbooks', v);
    const layer = await fixture.layerByName('Execution Playbooks');
    await setLayerExpectations(layer.id, versions);
    expect((await computeLayerState(layer.id)).status).toBe('AUDIT_READY');
  });

  it('marks a vanished file inconsistent and flips the document flag', async () => {
    const document = await addDocument(fixture, 'World Model', 'v1');
    deletePhysicalFile(document);
    await recomputeProject(fixture.project.id);

    expect((await getDocument(document.id))?.fileMissing).toBe(true);
    expect((await computeLayerState((await fixture.layerByName('World Model')).id)).inconsistentDocuments)
      .toContain('World Model v1');
  });

  it('derives expectations from what was actually imported', async () => {
    for (const v of ['v1', 'v1B', 'v1C']) await addDocument(fixture, 'Taxonomy', v);
    const state = await deriveLayerExpectationsFromDocuments((await fixture.layerByName('Taxonomy')).id);
    expect(state.expectedVersions).toEqual(['v1', 'v1B', 'v1C']);
    expect(state.missingVersions).toEqual([]);
  });

  it('honours a manual override but still exposes the derived reason', async () => {
    await addDocument(fixture, 'Taxonomy', 'v1');
    const layer = await fixture.layerByName('Taxonomy');
    const state = await setLayerManualStatus(layer.id, 'BLOCKED', 'waiting on an external source');
    expect(state.status).toBe('BLOCKED');
    expect(state.statusSource).toBe('MANUAL');
    expect(state.reason.length).toBeGreaterThan(0);

    const cleared = await setLayerManualStatus(layer.id, null);
    expect(cleared.statusSource).toBe('DERIVED');
  });
});

describe('prompt compiler', () => {
  it('targets the next expansion and enforces naming', async () => {
    await addDocument(fixture, 'Qualification Logic', 'v1');
    const compiled = await compilePrompt({
      projectId: fixture.project.id,
      layerId: (await fixture.layerByName('Qualification Logic')).id,
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

  it('builds a synthesis prompt over the whole source packet', async () => {
    for (const v of FULL_PACKET) await addDocument(fixture, 'Decision Routing Rules', v);
    const compiled = await compilePrompt({
      projectId: fixture.project.id,
      layerId: (await fixture.layerByName('Decision Routing Rules')).id,
      runType: 'SYNTHESIS',
    });
    expect(compiled.targetVersion).toBe('v3.1');
    expect(compiled.requiredAttachments).toHaveLength(7);
    expect(compiled.expectedFilename).toBe('Decision Routing Rules v3.1.pdf');
  });

  it('declares the other layers out of scope', async () => {
    await addDocument(fixture, 'World Model', 'v1');
    const compiled = await compilePrompt({
      projectId: fixture.project.id,
      layerId: (await fixture.layerByName('World Model')).id,
      runType: 'EXPANSION',
    });
    const boundaries = compiled.sections.find((s) => s.key === 'CROSS_LAYER_BOUNDARIES');
    expect(boundaries?.body).toContain('Discovery Logic');
    expect(boundaries?.body).not.toContain('World Model v');
  });
});

describe('synthesis', () => {
  it('refuses an incomplete packet and unblocks once it is complete', async () => {
    for (const v of FULL_PACKET.slice(0, 6)) await addDocument(fixture, 'Discovery Logic', v);
    const layer = await fixture.layerByName('Discovery Logic');
    await setLayerExpectations(layer.id, FULL_PACKET);

    let error: unknown;
    try {
      await prepareSynthesis({ layerId: layer.id });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DependencyError);
    expect((error as DependencyError).result.missing).toContain('Discovery Logic v1G');

    await addDocument(fixture, 'Discovery Logic', 'v1G');
    const prepared = await prepareSynthesis({ layerId: layer.id });
    expect(prepared.dependencies.summary).toBe('7 / 7 READY');
    expect(prepared.document.canonicalName).toBe('Discovery Logic v3.1');
    // Invariant 10: the exact prompt and attachment list are persisted on the run.
    expect((await getRun(prepared.run.id))?.prompt).toBe(prepared.run.prompt);
    expect(prepared.run.requiredAttachments).toHaveLength(7);
  });

  it('refuses outright on a layer with nothing to consolidate', async () => {
    // "0 / 0 READY" is technically ready and completely meaningless.
    await expect(
      prepareSynthesis({ layerId: (await fixture.layerByName('Taxonomy')).id }),
    ).rejects.toThrow(/no completed research/i);
    await expect(
      prepareSynthesis({ layerId: (await fixture.layerByName('Taxonomy')).id, override: true }),
    ).rejects.toThrow(/no completed research/i);
  });

  it('records the reason when the user overrides the warning', async () => {
    for (const v of FULL_PACKET.slice(0, 6)) await addDocument(fixture, 'Discovery Logic', v);
    const layer = await fixture.layerByName('Discovery Logic');
    await setLayerExpectations(layer.id, FULL_PACKET);

    const prepared = await prepareSynthesis({
      layerId: layer.id,
      override: true,
      overrideReason: 'v1G is not going to happen',
    });
    expect(prepared.run.dependencyOverride).toBe(true);
    expect(prepared.dependencies.ready).toBe(false);
  });
});

describe('audit verdict coercion', () => {
  const ctx = async () => ({ projectId: fixture.project.id, layerId: (await fixture.layerByName('Taxonomy')).id });

  it('accepts the canonical verdicts and common aliases', async () => {
    expect((await normalizeAuditResult({ verdict: 'PASS' }, await ctx())).verdict).toBe('PASS');
    expect((await normalizeAuditResult({ verdict: 'ready for synthesis' as never }, await ctx())).verdict)
      .toBe('READY_FOR_SYNTHESIS');
  });

  it('never reads a negated verdict as its own opposite', async () => {
    // "not ready for synthesis" contains "ready for synthesis"; treating that as
    // approval would advance a layer the audit had just rejected.
    for (const raw of [
      'not ready for synthesis',
      'NOT READY_TO_FREEZE',
      'no pass',
      'definitely not ready for synthesis',
      'failed audit',
    ]) {
      expect((await normalizeAuditResult({ verdict: raw as never }, await ctx())).verdict, raw)
        .toBe('MORE_RESEARCH');
    }
  });

  it('reads the LAST fenced block, not an echoed template', () => {
    // Both audit prompts ask the model to end its reply with the JSON object. A
    // model that quotes the platform's own template first must not have that
    // placeholder stored as the audit of record.
    const template = JSON.stringify({
      verdict: 'PASS | KEEP | PATCH | REDO | MISSING_DEPENDENCY | MORE_RESEARCH | READY_FOR_SYNTHESIS | READY_TO_FREEZE | BLOCKED',
      summary: 'one short paragraph',
      failures: ['each concrete failure, one per entry'],
    });
    const real = JSON.stringify({
      verdict: 'REDO',
      summary: 'Section 3 is a stub; redo required.',
      failures: ['section 3 is a placeholder'],
    });
    const reply = [
      'Here is the shape I was asked for:',
      '```json',
      template,
      '```',
      'And here is my actual verdict:',
      '```json',
      real,
      '```',
    ].join('\n');

    const parsed = parseAuditJson(reply);
    expect(parsed?.verdict).toBe('REDO');
    expect(parsed?.summary).toContain('stub');
  });

  it('refuses a verdict string that names several verdicts at once', async () => {
    // The template's verdict field lists all nine; that is a menu, not a decision.
    const menu = 'PASS | KEEP | REDO | READY_FOR_SYNTHESIS | BLOCKED';
    expect((await normalizeAuditResult({ verdict: menu as never }, await ctx())).verdict).toBe('MORE_RESEARCH');
  });

  it('parses fenced model JSON without inverting it', () => {
    const parsed = parseAuditJson('```json\n{"verdict":"not ready for synthesis","summary":"x"}\n```');
    expect(parsed?.verdict).toBe('MORE_RESEARCH');
  });

  it('always produces the structured arrays, even from a bare verdict', async () => {
    const result = await normalizeAuditResult({ verdict: 'PATCH' }, await ctx());
    expect(result.failures).toEqual([]);
    expect(result.missingDocuments).toEqual([]);
    expect(result.requiredResearchRuns).toEqual([]);
    expect(result.requiredPatches).toEqual([]);
    expect(result.nextAction.length).toBeGreaterThan(0);
  });
});

describe('audit, redo and freeze', () => {
  it('stores audits structurally and moves the layer', async () => {
    const document = await addDocument(fixture, 'Monetization Logic', 'v1');
    const layer = await fixture.layerByName('Monetization Logic');

    const outcome = await recordAudit({
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
    expect((await listEventsByLayer(layer.id)).some((e) => e.eventType === 'AUDIT_COMPLETED')).toBe(true);
  });

  it('creates a redo without touching the failed attempt', async () => {
    const document = await addDocument(fixture, 'Learning Evaluation', 'v1');
    const layer = await fixture.layerByName('Learning Evaluation');
    const parent = await failedRun(layer.id, document.id);

    const redo = await createRedoRun({
      parentRunId: parent.id,
      reason: 'missing source-family observability section',
    });

    const reloaded = await getRun(parent.id);
    expect(reloaded?.prompt).toBe(parent.prompt);
    expect(reloaded?.status).toBe('FAILED');
    expect(redo.parentRunId).toBe(parent.id);
    expect(redo.attemptNumber).toBe(parent.attemptNumber + 1);
    expect(redo.redoReason).toContain('observability');
    expect(redo.prompt).toBeTruthy();
  });

  it('stops automatic redos at the configured cap', async () => {
    const layer = await fixture.layerByName('Learning Evaluation');
    let current = await failedRun(layer.id);
    for (let i = 0; i < 2; i += 1) {
      current = await createRedoRun({ parentRunId: current.id, reason: `attempt ${i}`, automatic: true });
    }
    const verdict = await canAutoRedo(current.id, 2);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason.toLowerCase()).toContain('human');
  });

  it('freezes only with a canonical artifact and keeps provenance', async () => {
    for (const v of ['v1', 'v1B', 'v1C']) await addDocument(fixture, 'World Model', v);
    const layer = await fixture.layerByName('World Model');

    await expect(freezeLayer(layer.id)).rejects.toThrow();

    const canonical = await addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const state = await freezeLayer(layer.id, canonical.id);
    expect(state.status).toBe('FROZEN');
    expect(state.canonicalName).toBe('World Model v3.1');

    const documents = await listDocumentsByLayer(layer.id);
    expect(documents).toHaveLength(4);
    expect(documents.find((d) => d.version === 'v3.1')?.isCanonical).toBe(true);
    expect(documents.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(3);

    const reopened = await reopenLayer(layer.id, 'cross-layer audit found a contradiction');
    expect(reopened.status).toBe('REOPENED');
    expect(await listDocumentsByLayer(layer.id)).toHaveLength(4);
  });
});

describe('blockages clear themselves', () => {
  it('stops blocking once the document a MISSING_DEPENDENCY audit named arrives', async () => {
    await addDocument(fixture, 'Discovery Logic', 'v1');
    const layer = await fixture.layerByName('Discovery Logic');

    await recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: {
        verdict: 'MISSING_DEPENDENCY',
        summary: 'Needs the v1B sibling before it can be judged.',
        missingDocuments: ['Discovery Logic v1B'],
      },
    });
    expect((await computeLayerState(layer.id)).status).toBe('BLOCKED');

    // Spec section 18: uploading the missing dependency is what unblocks the
    // work — the user should not have to re-run the audit to clear the flag.
    await addDocument(fixture, 'Discovery Logic', 'v1B');
    await recomputeProject(fixture.project.id);

    const after = await computeLayerState(layer.id);
    expect(after.missingDependencies).toEqual([]);
    expect(after.status).not.toBe('BLOCKED');
  });

  it('keeps blocking when the audit named nothing to resolve', async () => {
    await addDocument(fixture, 'Qualification Logic', 'v1');
    const layer = await fixture.layerByName('Qualification Logic');
    await recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: { verdict: 'BLOCKED', summary: 'Waiting on a decision about scope.' },
    });
    await recomputeProject(fixture.project.id);
    // Nothing was named, so nothing can arrive to clear it — a human must act.
    expect((await computeLayerState(layer.id)).status).toBe('BLOCKED');
  });

  it('gives a reopened layer its source packet back so it can be re-synthesised', async () => {
    for (const v of ['v1', 'v1B', 'v1C']) await addDocument(fixture, 'World Model', v);
    const canonical = await addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = await fixture.layerByName('World Model');
    await freezeLayer(layer.id, canonical.id);
    expect((await listDocumentsByLayer(layer.id)).filter((d) => d.status === 'SUPERSEDED')).toHaveLength(3);

    await reopenLayer(layer.id, 'cross-layer audit found a contradiction');
    await recomputeProject(fixture.project.id);

    // The provenance is usable again — otherwise the layer dead-ends: its own
    // registered, on-disk documents would report as missing forever.
    const restored = await listDocumentsByLayer(layer.id);
    expect(restored.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(0);
    expect(restored.every((d) => !d.frozen)).toBe(true);
    await expect(prepareSynthesis({ layerId: layer.id })).resolves.toBeTruthy();
  });

  it('lets a reopen lapse once work resumes, instead of pinning the layer', async () => {
    for (const v of ['v1', 'v1B']) await addDocument(fixture, 'World Model', v);
    const canonical = await addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = await fixture.layerByName('World Model');
    await freezeLayer(layer.id, canonical.id);
    await reopenLayer(layer.id, 'contradiction');
    await recomputeProject(fixture.project.id);

    // Derived, never pinned — a pin would mask every later audit forever.
    expect((await computeLayerState(layer.id)).statusSource).toBe('DERIVED');

    await recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: { verdict: 'READY_FOR_SYNTHESIS', summary: 'Rework holds up.' },
    });
    await recomputeProject(fixture.project.id);
    expect((await computeLayerState(layer.id)).status).toBe('SYNTHESIS_READY');
  });

  it('keeps a reopened layer reopened until something happens', async () => {
    for (const v of ['v1', 'v1B']) await addDocument(fixture, 'World Model', v);
    const canonical = await addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = await fixture.layerByName('World Model');
    await freezeLayer(layer.id, canonical.id);

    expect((await reopenLayer(layer.id, 'cross-layer contradiction')).status).toBe('REOPENED');
    await recomputeProject(fixture.project.id);
    expect((await computeLayerState(layer.id)).status).toBe('REOPENED');
  });
});

describe('waiting runs follow their packet', () => {
  it('moves a run from BLOCKED to READY when the missing document arrives', async () => {
    const layer = await fixture.layerByName('Taxonomy');
    const run = await failedRun(layer.id);
    await updateRun(run.id, { status: 'BLOCKED' });
    await setRunDependencies(run.id, ['Monetization Logic v1']);
    await recomputeProject(fixture.project.id);
    expect((await getRun(run.id))?.status).toBe('BLOCKED');

    await addDocument(fixture, 'Monetization Logic', 'v1');
    await recomputeProject(fixture.project.id);

    // Section 18: no "now go update the database" step.
    expect((await checkRunDependencies(run.id)).ready).toBe(true);
    expect((await getRun(run.id))?.status).toBe('READY');
  });

  it("leaves a finished run's status alone", async () => {
    const layer = await fixture.layerByName('Taxonomy');
    const run = await failedRun(layer.id);
    await setRunDependencies(run.id, ['Monetization Logic v1']);
    await recomputeProject(fixture.project.id);
    // History is not rewritten by a recompute.
    expect((await getRun(run.id))?.status).toBe('FAILED');
  });
});

describe('a passing final audit freezes the layer', () => {
  it('freezes automatically when the canonical document exists', async () => {
    for (const v of ['v1', 'v1B']) await addDocument(fixture, 'Decision Routing Rules', v);
    await addDocument(fixture, 'Decision Routing Rules', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = await fixture.layerByName('Decision Routing Rules');

    const outcome = await recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: { verdict: 'READY_TO_FREEZE', summary: 'The synthesis holds up.' },
    });

    // Sections 4, 14 and 18 all state this transition is automatic.
    expect(outcome.layerState.status).toBe('FROZEN');
    expect((await computeLayerState(layer.id)).canonicalName).toBe('Decision Routing Rules v3.1');
  });

  it('records the audit but does not freeze without a canonical artifact', async () => {
    await addDocument(fixture, 'Learning Evaluation', 'v1');
    const layer = await fixture.layerByName('Learning Evaluation');

    const outcome = await recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: { verdict: 'READY_TO_FREEZE', summary: 'Looks done.' },
    });

    // Invariant 6 still holds: the audit stands, the freeze waits.
    expect(outcome.audit.verdict).toBe('READY_TO_FREEZE');
    expect((await computeLayerState(layer.id)).status).not.toBe('FROZEN');
  });
});

describe('a frozen layer is not immune to a missing file', () => {
  it('reports BLOCKED, not "nothing to do", when the canonical artifact vanishes', async () => {
    for (const v of ['v1', 'v1B']) await addDocument(fixture, 'World Model', v);
    const canonical = await addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = await fixture.layerByName('World Model');
    await freezeLayer(layer.id, canonical.id);
    expect((await computeLayerState(layer.id)).status).toBe('FROZEN');

    deletePhysicalFile(canonical);
    await recomputeProject(fixture.project.id);

    // Invariant 9 outranks the frozen shortcut: saying "nothing to do" while
    // listing the document as inconsistent is a contradiction in one payload.
    const state = await computeLayerState(layer.id);
    expect(state.inconsistentDocuments).toContain('World Model v3.1');
    expect(state.status).toBe('BLOCKED');
    expect(state.nextAction.toLowerCase()).toContain('restore');
  });
});

describe('planner', () => {
  it('names the blocking document and is deterministic', async () => {
    for (const v of FULL_PACKET.slice(0, 6)) await addDocument(fixture, 'Discovery Logic', v);
    await setLayerExpectations((await fixture.layerByName('Discovery Logic')).id, FULL_PACKET);
    await recomputeProject(fixture.project.id);

    const plan = await buildPlan(fixture.project.id);
    const discovery = [...plan.now, ...plan.next, ...plan.blocked, ...plan.later].find(
      (item) => item.layerName === 'Discovery Logic',
    );
    expect(discovery).toBeDefined();
    expect(discovery?.missing).toContain('Discovery Logic v1G');
    expect(plan.nextBestActionText.length).toBeGreaterThan(0);
    expect(await calculateNextAction(fixture.project.id)).not.toBeNull();

    const again = await buildPlan(fixture.project.id);
    expect(again.nextBestActionText).toBe(plan.nextBestActionText);
    expect(again.now.map((i) => i.layerId)).toEqual(plan.now.map((i) => i.layerId));
  });

  it('names the same document as the layer row does', async () => {
    // Regression: the planner used to target the highest version while the state
    // engine targeted the first unaudited one, so the two panes disagreed.
    await addDocument(fixture, 'World Model', 'v1');
    await addDocument(fixture, 'World Model', 'v1B');
    await recomputeProject(fixture.project.id);

    const state = await computeLayerState((await fixture.layerByName('World Model')).id);
    expect(state.status).toBe('AUDIT_READY');

    const plan = await buildPlan(fixture.project.id);
    const item = [...plan.now, ...plan.next].find((i) => i.layerName === 'World Model');
    expect(item?.title).toBe(state.nextAction);
    expect(item?.targetVersion).toBe(state.nextVersion);
  });

  it('makes a real blockage the next best action, ahead of ordinary work', async () => {
    // The spec's example: Discovery Logic is BLOCKED missing v1G while another
    // layer has an audit waiting, and the one prominent answer is about v1G.
    for (const v of FULL_PACKET.slice(0, 6)) await addDocument(fixture, 'Discovery Logic', v);
    const layer = await fixture.layerByName('Discovery Logic');
    await setLayerExpectations(layer.id, FULL_PACKET);
    await addDocument(fixture, 'World Model', 'v1');

    // A run requiring the packet is what turns "v1G is expected" into
    // "v1G is required". (An explicitly overridden run would not block, by design.)
    const run = await failedRun(layer.id);
    await updateRun(run.id, { status: 'PLANNED' });
    await setRunDependencies(run.id, FULL_PACKET.map((v) => `Discovery Logic ${v}`));
    await recomputeProject(fixture.project.id);

    const state = await computeLayerState(layer.id);
    expect(state.status).toBe('BLOCKED');
    expect(state.missingDependencies).toContain('Discovery Logic v1G');

    const plan = await buildPlan(fixture.project.id);
    expect(plan.nextBestActionText).toContain('Discovery Logic v1G');
    expect(plan.nextBestAction?.priority).toBeLessThan(PRIORITY_AUDIT);
  });

  it('prioritises an inconsistent file above all ordinary work', async () => {
    const document = await addDocument(fixture, 'Discovery Logic', 'v1');
    await addDocument(fixture, 'World Model', 'v1');
    deletePhysicalFile(document);
    await recomputeProject(fixture.project.id);

    const plan = await buildPlan(fixture.project.id);
    // Invariant 9: nothing else about the project is safe to act on first.
    expect(plan.nextBestAction?.actionType).toBe('RECONCILE');
    expect(plan.nextBestActionText).toContain('Discovery Logic v1');
    expect(plan.blocked.some((i) => i.actionType === 'RECONCILE')).toBe(true);
  });

  it('puts a frozen layer in LATER with nothing to do', async () => {
    const canonical = await addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    await freezeLayer((await fixture.layerByName('World Model')).id, canonical.id);
    await recomputeProject(fixture.project.id);

    const plan = await buildPlan(fixture.project.id);
    const item = plan.later.find((i) => i.layerName === 'World Model');
    expect(item).toBeDefined();
    expect(item?.actionType).toBe('NONE');
  });
});

describe('waves advance on their own', () => {
  it('moves the layer and the project forward as research progresses', async () => {
    const layer = await fixture.layerByName('Taxonomy');

    await addDocument(fixture, 'Taxonomy', 'v1');
    await recomputeProject(fixture.project.id);
    expect((await getLayer(layer.id))?.currentWave).toBe(1);
    expect((await getProject(fixture.project.id))?.currentWave).toBe(1);

    await addDocument(fixture, 'Taxonomy', 'v1B');
    await recomputeProject(fixture.project.id);
    expect((await getLayer(layer.id))?.currentWave).toBe(2);
    expect((await getProject(fixture.project.id))?.currentWave).toBe(2);

    await addDocument(fixture, 'Taxonomy', 'v3.1', { documentType: 'SYNTHESIS' });
    await recomputeProject(fixture.project.id);
    expect((await getLayer(layer.id))?.currentWave).toBe(3);
    // The project sits at the furthest wave any layer has reached.
    expect((await getProject(fixture.project.id))?.currentWave).toBe(3);
    expect((await getLayer((await fixture.layerByName('World Model')).id))?.currentWave).toBe(1);
  });
});

describe('runtime state file', () => {
  it('writes a derived snapshot that mirrors the database', async () => {
    for (const v of ['v1', 'v1B']) await addDocument(fixture, 'Taxonomy', v);
    await recomputeProject(fixture.project.id);

    const written = await writeProjectState(fixture.project.id);
    const read = readProjectState();
    expect(read).not.toBeNull();
    expect(read?.project.slug).toBe('deal-dispatch');
    expect(read?.layers).toHaveLength(8);
    expect(read?.nextBestAction).toBe(written.nextBestAction);
    expect(read?.documents.some((d) => d.canonicalName === 'Taxonomy v1B')).toBe(true);
  });
});
