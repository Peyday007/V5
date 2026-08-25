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
import { freshProject, teardown, type TestProject, testDatabaseKind} from './helpers.ts';
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
import { listRuns } from '../server/repos/runs.ts';
import { buildPdf, prosePage } from './fixtures/pdf.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});
afterEach(async () => {
  await teardown();
});

/**
 * A real, readable PDF rather than a few bytes that merely start with `%PDF`.
 *
 * This matters to what the test proves. A document Brain cannot read is not
 * evidence, so its layer is BLOCKED (invariant: section 9) — which means a
 * walk to AUDIT_READY over unreadable bytes only ever passed while extraction
 * had not caught up yet, and asserted the queue's latency instead of the
 * platform's answer. Readable fixtures make the same assertions mean what they
 * say whenever extraction finishes.
 */
function pdfFor(name: string): Buffer {
  return buildPdf([
    prosePage(name.replace(/\.pdf$/, ''), [
      [
        `This document is the research packet for ${name}.`,
        'It states the boundary, the population and the timeframe it covers,',
        'and records the findings that follow from them.',
      ],
      [
        'Each finding resolves to a passage in a source, and each source is',
        'named so a reader can check it without asking the author.',
      ],
    ]),
  ]);
}

function drop(name: string) {
  return importFile({
    projectId: fixture.project.id,
    originalFilename: name,
    contents: pdfFor(name),
  });
}

describe('the first real session', () => {
  it('reconstructs project state from a folder of existing PDFs', async () => {
    const names = [
      'World Model v1.pdf',
      'World Model v1B.pdf',
      'World Model v3.1.pdf',
      'Discovery Logic v1.pdf',
      'Discovery Logic v1B.pdf',
      'Discovery Logic v1C.pdf',
      'Decision Routing Rules v1A.pdf',
      'Decision Routing Rules v1B.pdf',
    ];
    const dropped = await Promise.all(names.map(drop));

    for (const result of dropped) {
      expect(result.registered, `${result.filename}: ${result.message}`).toBe(true);
    }

    // The platform knows what it has, per layer, without being told.
    expect(await listDocumentsByLayer((await fixture.layerByName('World Model')).id)).toHaveLength(3);
    expect(await listDocumentsByLayer((await fixture.layerByName('Discovery Logic')).id)).toHaveLength(3);
    expect(await listDocumentsByLayer((await fixture.layerByName('Taxonomy')).id)).toHaveLength(0);

    // Layers with no research read as NOT_STARTED rather than as invented state.
    expect((await computeLayerState((await fixture.layerByName('Taxonomy')).id)).status).toBe('NOT_STARTED');
  });

  it('walks a layer from imported research to frozen', async () => {
    const packet = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const version of packet) await drop(`Discovery Logic ${version}.pdf`);

    const layer = await fixture.layerByName('Discovery Logic');
    await deriveLayerExpectationsFromDocuments(layer.id);
    expect((await computeLayerState(layer.id)).status).toBe('AUDIT_READY');

    // Audit clears the expansion wave.
    const audited = await recordAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      result: {
        verdict: 'READY_FOR_SYNTHESIS',
        summary: 'Coverage is complete and internally consistent.',
      },
    });
    expect(audited.layerState.status).toBe('SYNTHESIS_READY');

    // Synthesis consumes the whole packet.
    const prepared = await prepareSynthesis({ layerId: layer.id });
    expect(prepared.dependencies.summary).toBe('7 / 7 READY');
    expect(prepared.document.canonicalName).toBe('Discovery Logic v3.1');

    // The synthesis comes back and is imported under its canonical name.
    const synthesised = await drop('Discovery Logic v3.1.pdf');
    expect(synthesised.registered).toBe(true);

    const frozen = await freezeLayer(layer.id);
    expect(frozen.status).toBe('FROZEN');
    expect(frozen.canonicalName).toBe('Discovery Logic v3.1');

    // Provenance survives the freeze.
    const documents = await listDocumentsByLayer(layer.id);
    expect(documents).toHaveLength(8);
    expect(documents.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(7);

    // And the plan reflects it without anything else being told.
    const plan = await buildPlan(fixture.project.id);
    expect(plan.later.some((item) => item.layerName === 'Discovery Logic')).toBe(true);
  });

  it('keeps the derived runtime snapshot in step with the database', async () => {
    await drop('World Model v1.pdf');
    await recomputeProject(fixture.project.id);

    if (testDatabaseKind === 'postgres') {
      // In cloud mode there is no local snapshot to keep in step — the database
      // is the one copy that can be right for every instance.
      expect(readProjectState()).toBeNull();
      return;
    }

    const snapshot = readProjectState();
    expect(snapshot?.project.slug).toBe('deal-dispatch');
    expect(snapshot?.documents.some((d) => d.canonicalName === 'World Model v1')).toBe(true);
    expect(snapshot?.nextBestAction.length).toBeGreaterThan(0);
  });
});

describe('chat reads state instead of remembering it', () => {
  it('answers "what is missing?" with the real missing document', async () => {
    const packet = ['v1', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G'];
    for (const version of packet.slice(0, 6)) await drop(`Discovery Logic ${version}.pdf`);
    const layer = await fixture.layerByName('Discovery Logic');
    await deriveLayerExpectationsFromDocuments(layer.id);
    // Declare the full packet as expected so v1G reads as missing.
    await runTool('set_layer_expectations', { projectId: fixture.project.id }, {
      layerId: layer.id,
      expectedVersions: packet,
    });
    await recomputeProject(fixture.project.id);

    const turn = await handleChatMessage({ projectId: fixture.project.id, content: 'What is missing?' });
    expect(turn.toolCalls.length).toBeGreaterThan(0);
    expect(turn.assistantMessage.content).toContain('Discovery Logic v1G');
  });

  it('does not claim a document exists when it does not', async () => {
    const turn = await handleChatMessage({
      projectId: fixture.project.id,
      content: 'What is the status of Discovery Logic?',
    });
    expect(turn.toolCalls.length).toBeGreaterThan(0);
    expect(turn.assistantMessage.content).toMatch(/NOT_STARTED|no documents|0/i);
    expect(turn.assistantMessage.content).not.toMatch(/v1G/);
  });

  it('answers "what next?" from the planner', async () => {
    await drop('World Model v1.pdf');
    await recomputeProject(fixture.project.id);
    const turn = await handleChatMessage({ projectId: fixture.project.id, content: "What's next?" });
    expect(turn.toolCalls.some((c) => c.name === 'calculate_next_action')).toBe(true);
    expect(turn.assistantMessage.content.length).toBeGreaterThan(0);
  });

  it('persists the whole exchange locally, including the tool calls', async () => {
    await handleChatMessage({ projectId: fixture.project.id, content: "What's next?" });
    const { conversation, messages } = await getChatHistory(fixture.project.id);
    expect(conversation.projectId).toBe(fixture.project.id);
    expect(messages.some((m) => m.role === 'USER')).toBe(true);
    expect(messages.some((m) => m.role === 'ASSISTANT')).toBe(true);
    // Invariant 12: the local database is the record, not a provider thread.
    expect(messages.some((m) => m.role === 'TOOL')).toBe(true);
  });

  it('never changes state in answer to a question', async () => {
    // A question is not a command. Chat must not take an irreversible action
    // because the user asked about it.
    await drop('World Model v3.1.pdf');
    await drop('Discovery Logic v1.pdf');
    const world = await fixture.layerByName('World Model');

    const questions = [
      'Is World Model ready to freeze?',
      'Should I redo Discovery Logic v1?',
      'What should I do next?',
      'Which prompt would Discovery Logic need?',
      'Do I need to audit Discovery Logic?',
    ];
    for (const question of questions) {
      const turn = await handleChatMessage({ projectId: fixture.project.id, content: question });
      expect(turn.assistantMessage.content.length, question).toBeGreaterThan(0);
    }

    expect((await computeLayerState(world.id)).status).not.toBe('FROZEN');
    // No question may have created a run.
    expect(await listRuns(fixture.project.id)).toHaveLength(0);
  });

  it('still acts on a plainly worded command', async () => {
    await drop('World Model v3.1.pdf');
    const world = await fixture.layerByName('World Model');

    await handleChatMessage({ projectId: fixture.project.id, content: 'Freeze World Model.' });
    expect((await computeLayerState(world.id)).status).toBe('FROZEN');

    await drop('Discovery Logic v1.pdf');
    await handleChatMessage({ projectId: fixture.project.id, content: 'Audit Discovery Logic.' });
    expect((await listRuns(fixture.project.id)).length).toBeGreaterThan(0);
  });

  it('resolves loose layer references the way a person would type them', async () => {
    expect((await resolveLayerReference(fixture.project.id, 'Discovery'))?.name).toBe('Discovery Logic');
    expect((await resolveLayerReference(fixture.project.id, 'discovery logic'))?.name).toBe('Discovery Logic');
    expect((await resolveLayerReference(fixture.project.id, 'WORLD MODEL'))?.name).toBe('World Model');
    expect(await resolveLayerReference(fixture.project.id, 'nonsense layer')).toBeNull();
  });

  it('freezes a layer on request, but only with a canonical artifact', async () => {
    const refused = await handleChatMessage({
      projectId: fixture.project.id,
      content: 'Freeze World Model.',
    });
    expect(refused.assistantMessage.content.toLowerCase()).toMatch(/canonical|cannot|no document/);

    await drop('World Model v3.1.pdf');
    const accepted = await handleChatMessage({
      projectId: fixture.project.id,
      content: 'Freeze World Model.',
    });
    expect(accepted.assistantMessage.content).toMatch(/FROZEN|frozen/);
    expect((await computeLayerState((await fixture.layerByName('World Model')).id)).status).toBe('FROZEN');
  });
});
