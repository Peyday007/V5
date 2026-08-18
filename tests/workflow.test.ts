/**
 * The experience the spec calls the most important one (section 25), end to end:
 *
 *   open the app -> drop existing PDFs in -> the platform identifies them ->
 *   it reconstructs project state -> it says what is complete, missing, blocked,
 *   ready for synthesis, frozen -> "what's next?" returns one reliable answer.
 *
 * Plus the guarantee that makes the chat trustworthy: it never asserts state it
 * has not read from the database (invariants 7 and 12).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { importFile } from '../server/services/importer.ts';
import {
  computeLayerState,
  deriveLayerExpectationsFromDocuments,
  recomputeProject,
} from '../server/services/stateEngine.ts';
import { buildPlan } from '../server/services/planner.ts';
import { prepareSynthesis } from '../server/services/synthesis.ts';
import { recordAudit } from '../server/services/auditEngine.ts';
import { freezeLayer } from '../server/services/freeze.ts';
import { handleChatMessage, getChatHistory } from '../server/services/agent/chat.ts';
import { runTool, resolveLayerReference } from '../server/services/agent/tools.ts';
import { readProjectState } from '../server/services/runtimeState.ts';
import { listDocumentsByLayer } from '../server/repos/documents.ts';

let fixture: TestProject;

beforeEach(() => {
  fixture = freshProject();
});
afterEach(() => {
  teardown();
});

function drop(name: string) {
  return importFile({
    projectId: fixture.project.id,
    originalFilename: name,
    contents: Buffer.from(`%PDF-1.4 contents of ${name}`),
  });
}

describe('the first real session', () => {
  it('reconstructs project state from a folder of existing PDFs', () => {
    const dropped = [
      'World Model v1.pdf',
      'World Model v1B.pdf',
      'World Model v3.1.pdf',
      'Discovery Logic v1.pdf',
      'Discovery Logic v1B.pdf',
      'Discovery Logic v1C.pdf',
      'Decision Routing Rules v1A.pdf',
      'Decision Routing Rules v1B.pdf',
    ].map(drop);

    for (const result of dropped) {
      expect(result.registered, `${result.filename}: ${result.message}`).toBe(true);
    }

    // The platform knows what it has, per layer, without being told.
    expect(listDocumentsByLayer(fixture.layerByName('World Model').id)).toHaveLength(3);
    expect(listDocumentsByLayer(fixture.layerByName('Discovery Logic').id)).toHaveLength(3);
    expect(listDocumentsByLayer(fixture.layerByName('Taxonomy').id)).toHaveLength(0);

    // Layers with no research read as NOT_STARTED rather than as invented state.
    expect(computeLayerState(fixture.layerByName('Taxonomy').id).status).toBe('NOT_STARTED');
  });

  it('walks a layer from imported research to frozen', () => {
    const packet = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const version of packet) drop(`Discovery Logic ${version}.pdf`);

    const layer = fixture.layerByName('Discovery Logic');
    deriveLayerExpectationsFromDocuments(layer.id);
    expect(computeLayerState(layer.id).status).toBe('AUDIT_READY');

    // Audit clears the expansion wave.
    const audited = recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: {
        verdict: 'READY_FOR_SYNTHESIS',
        summary: 'Coverage is complete and internally consistent.',
      },
    });
    expect(audited.layerState.status).toBe('SYNTHESIS_READY');

    // Synthesis consumes the whole packet.
    const prepared = prepareSynthesis({ layerId: layer.id });
    expect(prepared.dependencies.summary).toBe('7 / 7 READY');
    expect(prepared.document.canonicalName).toBe('Discovery Logic v3.1');

    // The synthesis comes back and is imported under its canonical name.
    const synthesised = drop('Discovery Logic v3.1.pdf');
    expect(synthesised.registered).toBe(true);

    const frozen = freezeLayer(layer.id);
    expect(frozen.status).toBe('FROZEN');
    expect(frozen.canonicalName).toBe('Discovery Logic v3.1');

    // Provenance survives the freeze.
    const documents = listDocumentsByLayer(layer.id);
    expect(documents).toHaveLength(8);
    expect(documents.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(7);

    // And the plan reflects it without anything else being told.
    const plan = buildPlan(fixture.project.id);
    expect(plan.later.some((item) => item.layerName === 'Discovery Logic')).toBe(true);
  });

  it('keeps the derived runtime snapshot in step with the database', () => {
    drop('World Model v1.pdf');
    recomputeProject(fixture.project.id);

    const snapshot = readProjectState();
    expect(snapshot?.project.slug).toBe('deal-dispatch');
    expect(snapshot?.documents.some((d) => d.canonicalName === 'World Model v1')).toBe(true);
    expect(snapshot?.nextBestAction.length).toBeGreaterThan(0);
  });
});

describe('chat reads state instead of remembering it', () => {
  it('answers "what is missing?" with the real missing document', () => {
    const packet = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const version of packet.slice(0, 6)) drop(`Discovery Logic ${version}.pdf`);
    const layer = fixture.layerByName('Discovery Logic');
    deriveLayerExpectationsFromDocuments(layer.id);
    // Declare the full packet as expected so v1G reads as missing.
    runTool('set_layer_expectations', { projectId: fixture.project.id }, {
      layerId: layer.id,
      expectedVersions: packet,
    });
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
    expect(turn.assistantMessage.content).not.toMatch(/v1G/);
  });

  it('answers "what next?" from the planner', () => {
    drop('World Model v1.pdf');
    recomputeProject(fixture.project.id);
    const turn = handleChatMessage({ projectId: fixture.project.id, content: "What's next?" });
    expect(turn.toolCalls.some((c) => c.name === 'calculate_next_action')).toBe(true);
    expect(turn.assistantMessage.content.length).toBeGreaterThan(0);
  });

  it('persists the whole exchange locally, including the tool calls', () => {
    handleChatMessage({ projectId: fixture.project.id, content: "What's next?" });
    const { conversation, messages } = getChatHistory(fixture.project.id);
    expect(conversation.projectId).toBe(fixture.project.id);
    expect(messages.some((m) => m.role === 'USER')).toBe(true);
    expect(messages.some((m) => m.role === 'ASSISTANT')).toBe(true);
    // Invariant 12: the local database is the record, not a provider thread.
    expect(messages.some((m) => m.role === 'TOOL')).toBe(true);
  });

  it('resolves loose layer references the way a person would type them', () => {
    expect(resolveLayerReference(fixture.project.id, 'Discovery')?.name).toBe('Discovery Logic');
    expect(resolveLayerReference(fixture.project.id, 'discovery logic')?.name).toBe('Discovery Logic');
    expect(resolveLayerReference(fixture.project.id, 'WORLD MODEL')?.name).toBe('World Model');
    expect(resolveLayerReference(fixture.project.id, 'nonsense layer')).toBeNull();
  });

  it('freezes a layer on request, but only with a canonical artifact', () => {
    const refused = handleChatMessage({
      projectId: fixture.project.id,
      content: 'Freeze World Model.',
    });
    expect(refused.assistantMessage.content.toLowerCase()).toMatch(/canonical|cannot|no document/);

    drop('World Model v3.1.pdf');
    const accepted = handleChatMessage({
      projectId: fixture.project.id,
      content: 'Freeze World Model.',
    });
    expect(accepted.assistantMessage.content).toMatch(/FROZEN|frozen/);
    expect(computeLayerState(fixture.layerByName('World Model').id).status).toBe('FROZEN');
  });
});
