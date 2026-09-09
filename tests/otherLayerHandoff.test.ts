/**
 * `OTHER_LAYER` has a consumer.
 *
 * The production stop these tests were written from: a research packet clearing
 * the evidence gate, filing a report with its ledger inside it, passing an
 * audit in three distinct sessions — and then parking at `NEEDS_HUMAN` because
 * the judge said the work belonged to a different layer and nothing in Brain
 * read that. The classification existed, the schema refused it without an
 * owner, the owner resolved to a real layer id, and every one of those facts
 * sat in `audit_gaps` with no consequence.
 *
 * So these begin where production began: a document filed under the wrong
 * layer, an audit that says so and names exactly one owner, and no direct call
 * to the routing function anywhere. The tick has to find it and finish it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { getDocument, listDocumentsByLayer } from '../server/repos/documents.ts';
import { getAudit, listAuditsByProject } from '../server/repos/audits.ts';
import { recordAudit } from '../server/services/auditEngine.ts';
import { listEvents } from '../server/repos/events.ts';
import { decideHandoff, HANDOFF_DECIDER_VERSION } from '../server/services/audit/handoff.ts';
import { tick } from '../server/services/russell/loop.ts';
import type { AuditGap, Layer } from '../server/domain/types.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  finishPass,
  getOrchestration,
  startPass,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { enqueueWork, getWorkItem, listWorkItems } from '../server/repos/workQueue.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import {
  askHuman,
  getMission,
  launchMission,
  linkMission,
  openRequestFor,
  transitionMission,
} from '../server/repos/russellMissions.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

afterAll(async () => {
  await teardown();
});

/**
 * A judged document, filed under the wrong layer.
 *
 * Deliberately shaped like the real one: the research is sound and the verdict
 * is `MORE_RESEARCH` because of *where it is*, not because of what it says.
 */
async function misfiled(options: { owner?: string | null; second?: string | null } = {}) {
  const document = await addDocument(fixture, 'World Model', 'v1B', {
    contents: 'Which Michigan county offices publish assessment rolls, and on what terms.',
  });
  const owner = options.owner === undefined ? 'Discovery Logic' : options.owner;

  const gaps = [
    {
      classification: 'OTHER_LAYER' as const,
      title: 'County assessment-roll access belongs to Discovery Logic',
      detail: "This document's entire content is about how opportunities are found.",
      owningLayerName: owner,
      justification: 'The World Model describes what things are, not how they are sourced.',
      researchQuestion: null,
      expectedContribution: null,
      sourcePass: 'JUDGE' as const,
    },
    ...(options.second !== undefined && options.second !== null
      ? [
          {
            classification: 'OTHER_LAYER' as const,
            title: 'A second opinion about ownership',
            detail: 'Another layer is named for the same content.',
            owningLayerName: options.second,
            justification: 'Recorded as the judge wrote it.',
            researchQuestion: null,
            expectedContribution: null,
            sourcePass: 'JUDGE' as const,
          },
        ]
      : []),
  ];

  const outcome = await recordAudit({
    projectId: fixture.project.id,
    layerId: document.layerId!,
    auditedDocumentId: document.id,
    auditedDocumentIds: [document.id],
    source: 'TEST',
    mode: 'SINGLE_DOCUMENT',
    result: {
      verdict: 'MORE_RESEARCH',
      summary: 'The research is sound and it is filed under the wrong layer.',
      failures: [],
      missingDocuments: [],
      requiredResearchRuns: [],
      requiredPatches: [],
      synthesisRequired: false,
      freezeEligible: false,
      nextVersion: null,
      nextAction: 'Hand it to the layer that owns it.',
      confidence: 0.8,
    },
    gaps,
  });

  return { document, audit: outcome.audit };
}

describe('a document the audit says belongs to another layer', () => {
  it('is routed there by the tick, with nobody asked', async () => {
    const { document, audit } = await misfiled();
    const discovery = await fixture.layerByName('Discovery Logic');
    const worldModel = await fixture.layerByName('World Model');
    expect(document.layerId).toBe(worldModel.id);

    // No call to the routing function. The loop has to find it.
    const report = await tick('test-owner');

    expect(report.handedOff.map((entry) => entry.auditId)).toContain(audit.id);
    const moved = (await getDocument(document.id))!;
    expect(moved.layerId).toBe(discovery.id);
    // §4: the platform owns the filename, so the three names follow the layer.
    expect(moved.canonicalName).toBe('Discovery Logic v1B');
    expect(moved.conversationTitle).toBe('Discovery Logic v1B');
    expect(moved.filename).toContain('Discovery Logic v1B');
  });

  it('keeps the document, its bytes, its audit and its gaps exactly as they were', async () => {
    const { document, audit } = await misfiled();
    const before = (await getDocument(document.id))!;
    await tick('test-owner');
    const after = (await getDocument(document.id))!;

    // The same row. Not a copy, not a supersession, not re-researched.
    expect(after.id).toBe(before.id);
    expect(after.fileHash).toBe(before.fileHash);
    expect(after.fileSize).toBe(before.fileSize);
    expect(after.supersededByDocumentId).toBeNull();
    // The bytes stay where Brain wrote them: a storage key records what
    // happened, and moving an object to make a path read tidily would be an
    // external effect performed for cosmetics.
    expect(after.storageKey).toBe(before.storageKey);
    expect(after.filesystemPath).toBe(before.filesystemPath);

    // And exactly one document exists across both layers.
    const worldModel = await fixture.layerByName('World Model');
    const discovery = await fixture.layerByName('Discovery Logic');
    expect((await listDocumentsByLayer(worldModel.id)).map((d) => d.id)).not.toContain(document.id);
    expect((await listDocumentsByLayer(discovery.id)).filter((d) => d.id === document.id)).toHaveLength(1);

    // The verdict is not rewritten and the gaps are not deleted.
    const kept = (await getAudit(audit.id))!;
    expect(kept.verdict).toBe('MORE_RESEARCH');
    expect(kept.gaps.some((gap) => gap.classification === 'OTHER_LAYER')).toBe(true);
    expect(await listAuditsByProject(fixture.project.id)).toHaveLength(1);
  });

  it('records why it moved, in the project history', async () => {
    const { document, audit } = await misfiled();
    await tick('test-owner');

    const handoff = (await listEvents(fixture.project.id, 200)).find(
      (event) => event.eventType === 'DOCUMENT_HANDED_OFF',
    );
    expect(handoff?.entityId).toBe(document.id);
    expect(handoff?.payload).toMatchObject({
      auditId: audit.id,
      fromLayerName: 'World Model',
      toLayerName: 'Discovery Logic',
      previousCanonicalName: 'World Model v1B',
      canonicalName: 'Discovery Logic v1B',
      deciderVersion: HANDOFF_DECIDER_VERSION,
    });
  });

  it('does it once, however many times the loop runs', async () => {
    const { document } = await misfiled();
    const first = await tick('test-owner');
    expect(first.handedOff).toHaveLength(1);

    const second = await tick('test-owner');
    const third = await tick('test-owner');
    expect(second.handedOff).toHaveLength(0);
    expect(third.handedOff).toHaveLength(0);

    const moved = (await getDocument(document.id))!;
    expect(moved.canonicalName).toBe('Discovery Logic v1B');
    const events = (await listEvents(fixture.project.id, 200)).filter(
      (event) => event.eventType === 'DOCUMENT_HANDED_OFF',
    );
    expect(events).toHaveLength(1);
  });
});

describe('what the routing refuses, and leaves to a person', () => {
  /*
   * The inversions. Every one of these is a case where the rows do not settle
   * the destination, and a routing engine that guessed at any of them would be
   * worse than one that stops — because it would move somebody's research
   * somewhere on the strength of a coin toss and record it as a decision.
   */
  function gapsFor(over: Partial<AuditGap>[]): AuditGap[] {
    return over.map((gap, index) => ({
      id: `gap-${index}`,
      auditId: 'aud-1',
      ordinal: index,
      classification: 'OTHER_LAYER',
      title: 'ownership',
      detail: 'detail',
      owningLayerId: null,
      owningLayerName: null,
      justification: '',
      researchQuestion: null,
      expectedContribution: null,
      sourcePass: 'JUDGE',
      createdAt: '2026-09-09T00:00:00.000Z',
      ...gap,
    })) as AuditGap[];
  }

  const layers = [
    { id: 'lay-discovery', name: 'Discovery Logic' },
    { id: 'lay-world', name: 'World Model' },
  ] as Layer[];

  it('refuses when no gap asked for a handoff', () => {
    const decision = decideHandoff({
      gaps: gapsFor([{ classification: 'PATCH' }]),
      layers,
      documentLayerId: 'lay-world',
    });
    expect(decision).toMatchObject({ ok: false, refusal: 'NO_OTHER_LAYER_GAP' });
  });

  it('refuses when the gap names no owner', () => {
    const decision = decideHandoff({
      gaps: gapsFor([{ owningLayerName: '  ' }]),
      layers,
      documentLayerId: 'lay-world',
    });
    expect(decision).toMatchObject({ ok: false, refusal: 'NO_OWNING_LAYER_NAMED' });
  });

  it('refuses a layer this project does not have', () => {
    const decision = decideHandoff({
      gaps: gapsFor([{ owningLayerName: 'Pricing Logic' }]),
      layers,
      documentLayerId: 'lay-world',
    });
    expect(decision).toMatchObject({ ok: false, refusal: 'OWNING_LAYER_UNKNOWN' });
  });

  it('refuses two different owners rather than picking one', () => {
    const decision = decideHandoff({
      gaps: gapsFor([
        { owningLayerName: 'Discovery Logic', owningLayerId: 'lay-discovery' },
        { owningLayerName: 'World Model', owningLayerId: 'lay-world' },
      ]),
      layers,
      documentLayerId: 'lay-world',
    });
    expect(decision).toMatchObject({ ok: false, refusal: 'AMBIGUOUS_OWNERS' });
  });

  it('refuses one real owner beside one that resolves to nothing', () => {
    // The unresolvable name may be the right answer, misspelt. Routing on the
    // one that happened to resolve is the guess this refuses to make.
    const decision = decideHandoff({
      gaps: gapsFor([
        { owningLayerName: 'Discovery Logic', owningLayerId: 'lay-discovery' },
        { owningLayerName: 'Pricing Logic' },
      ]),
      layers,
      documentLayerId: 'lay-world',
    });
    expect(decision).toMatchObject({ ok: false, refusal: 'AMBIGUOUS_OWNERS' });
  });

  it('takes two gaps naming the same layer as one destination', () => {
    const decision = decideHandoff({
      gaps: gapsFor([
        { owningLayerName: 'Discovery Logic', owningLayerId: 'lay-discovery' },
        { owningLayerName: 'discovery logic' },
      ]),
      layers,
      documentLayerId: 'lay-world',
    });
    expect(decision).toMatchObject({ ok: true, targetLayerId: 'lay-discovery' });
  });

  it('refuses a document already filed where it belongs', () => {
    const decision = decideHandoff({
      gaps: gapsFor([{ owningLayerName: 'Discovery Logic', owningLayerId: 'lay-discovery' }]),
      layers,
      documentLayerId: 'lay-discovery',
    });
    expect(decision).toMatchObject({ ok: false, refusal: 'ALREADY_IN_OWNING_LAYER' });
  });

  it('leaves an ambiguous one exactly where it is, and says so', async () => {
    const { document } = await misfiled({ second: 'Monetization Logic' });
    const report = await tick('test-owner');

    expect(report.handedOff).toHaveLength(0);
    const worldModel = await fixture.layerByName('World Model');
    expect((await getDocument(document.id))!.layerId).toBe(worldModel.id);
    expect((await getDocument(document.id))!.canonicalName).toBe('World Model v1B');
  });

  it('leaves an unknown destination exactly where it is', async () => {
    const { document } = await misfiled({ owner: 'A Layer Nobody Created' });
    const report = await tick('test-owner');

    expect(report.handedOff).toHaveLength(0);
    const worldModel = await fixture.layerByName('World Model');
    expect((await getDocument(document.id))!.layerId).toBe(worldModel.id);
  });
});

describe('the rest of the path, after the routing', () => {
  /*
   * Requirement 8, walked rather than asserted about: corrected ownership, an
   * accepted terminal outcome, one writeback, and a follow-on only if one is
   * warranted.
   *
   * The blocker this found before it shipped is worth naming, because it would
   * have made the whole handoff a no-op that landed back in the park. Round
   * one's `RESEARCH_AUDIT` work items still exist after the routing, and
   * `alreadyCreated` matched them — so the runner would have faulted the packet
   * out to `NEEDS_HUMAN` saying a worker "finished without recording anything",
   * which was untrue and was the exact state the handoff exists to clear.
   */
  async function packetInTheWrongLayer() {
    const worldModel = await fixture.layerByName('World Model');
    const document = await addDocument(fixture, 'World Model', 'v1B', {
      contents: 'Which Michigan county offices publish assessment rolls, and on what terms.',
    });
    const run = await createRun({
      projectId: fixture.project.id,
      layerId: worldModel.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'county assessment-roll access',
    });
    const orchestration = await createOrchestration({
      projectId: fixture.project.id,
      layerId: worldModel.id,
      runId: run.id,
      title: 'County property tax assessment roll access',
      assignment: 'the official sources that answer it',
      provider: 'WORKER',
      autoApprove: false,
    });
    // The accepted fragment the real packet had: the research was sound, and
    // the judge's objection was where it was filed. Without it the runner would
    // go back to planning and the test would measure a different branch.
    await createFragments([
      {
        orchestrationId: orchestration.id,
        projectId: fixture.project.id,
        layerId: worldModel.id,
        fragmentIndex: 0,
        fragmentKey: 'official-record',
        question: 'Which county offices publish assessment rolls, and on what terms?',
        geography: 'Michigan',
        requiredEvidence: [
          { id: 'official_source', description: 'the office or portal', necessity: 'REQUIRED' },
        ],
        acceptableSourceTypes: ['county register of deeds or recording office'],
        excludedSourceTypes: ['vendor or software marketing pages'],
        completionCriteria: ['a quoted official statement of terms'],
        minIndependentSources: 1,
        maxRepairs: 2,
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    for (const fragment of await currentFragments(orchestration.id)) {
      await updateFragment(fragment.id, {
        status: 'ACCEPTED',
        completedAt: new Date().toISOString(),
      });
    }

    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      documentId: document.id,
      verdict: 'MORE_RESEARCH',
      failureReason: 'The judge asked for more and this run had nothing left to try.',
      completedAt: new Date().toISOString(),
    });

    // Round one: three completed passes, exactly as the real packet had.
    for (const ordinal of [5, 6, 7]) {
      const pass = await startPass({
        orchestrationId: orchestration.id,
        passKey: 'AUDIT',
        ordinal,
        provider: 'WORKER',
        model: 'wkr-1',
        prompt: `audit pass ${ordinal}`,
        promptSha256: 'x'.repeat(64),
      });
      await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
    }
    // And round one's work items, which are what used to fault the packet out.
    const stale = await enqueueWork({
      projectId: fixture.project.id,
      workType: 'RESEARCH_AUDIT',
      payload: { role: 'PRIMARY' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration.id,
    });

    const audit = await recordAudit({
      projectId: fixture.project.id,
      layerId: worldModel.id,
      runId: run.id,
      auditedDocumentId: document.id,
      auditedDocumentIds: [document.id],
      source: 'TEST',
      mode: 'SINGLE_DOCUMENT',
      result: {
        verdict: 'MORE_RESEARCH',
        summary: 'Sound research, filed under the wrong layer.',
        failures: [],
        missingDocuments: [],
        requiredResearchRuns: [],
        requiredPatches: [],
        synthesisRequired: false,
        freezeEligible: false,
        nextVersion: null,
        nextAction: 'Hand it to the layer that owns it.',
        confidence: 0.8,
      },
      gaps: [
        {
          classification: 'OTHER_LAYER' as const,
          title: 'This belongs to Discovery Logic',
          detail: 'How opportunities are found is not what the world is made of.',
          owningLayerName: 'Discovery Logic',
          justification: 'Recorded by the judge.',
          researchQuestion: null,
          expectedContribution: null,
          sourcePass: 'JUDGE' as const,
        },
      ],
    });

    const { mission } = await launchMission({
      projectId: fixture.project.id,
      layerId: worldModel.id,
      visibility: 'PRIVATE',
      objective: 'County property tax assessment roll access',
      whyNow: "The project's own archive does not answer this.",
      idempotencyKey: `handoff-test-${orchestration.id}`,
    });
    await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
    await transitionMission({
      missionId: mission.id,
      from: 'PLANNED',
      to: 'RUNNING',
    });
    await transitionMission({
      missionId: mission.id,
      from: 'RUNNING',
      to: 'NEEDS_HUMAN',
      waitingOn: 'a decision about where this belongs',
    });
    await askHuman({
      missionId: mission.id,
      projectId: fixture.project.id,
      whyNotRussell: 'Russell cannot decide which layer owns work.',
      recommendation: 'Record what could not be settled.',
      choices: [{ key: 'RECORD_GAPS', label: 'Record the gaps', consequence: 'Files it short.' }],
      authorityNeeded: 'SCOPE',
      resumeKey: `handoff-park-${orchestration.id}`,
    });

    return { document, orchestration, audit: audit.audit, mission, staleItemId: stale.id };
  }

  it('reopens the audit in the new layer instead of faulting out on the old round', async () => {
    const { orchestration, mission, staleItemId } = await packetInTheWrongLayer();
    const discovery = await fixture.layerByName('Discovery Logic');

    await tick('test-owner');

    // Ownership is corrected everywhere it is recorded, not only on the document.
    const packet = (await getOrchestration(orchestration.id))!;
    expect(packet.layerId).toBe(discovery.id);
    expect(packet.status).toBe('AUDITING');
    expect(packet.failureReason).toBeNull();
    expect((await getMission(mission.id))!.layerId).toBe(discovery.id);

    // The park is cleared by the routing, not left for somebody to answer.
    expect((await getMission(mission.id))!.state).toBe('RUNNING');
    expect((await openRequestFor(mission.id))).toBeNull();

    // Round one's item is withdrawn with its reason, not deleted.
    const stale = (await getWorkItem(staleItemId))!;
    expect(stale.state).toBe('CANCELLED');
    expect(stale.cancelledReason).toMatch(/handed to the layer that owns it/);

    // And the runner enqueues a fresh PRIMARY rather than faulting out.
    const advanced = await advancePacket(orchestration.id);
    expect(advanced.status).toBe('AUDITING');
    const primaries = (await listWorkItems(fixture.project.id, { limit: 200 })).filter(
      (item) =>
        item.orchestrationId === orchestration.id &&
        item.workType === 'RESEARCH_AUDIT' &&
        item.state === 'QUEUED',
    );
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.payload['role']).toBe('PRIMARY');
  });

  it('reaches an accepted terminal outcome and writes back exactly once', async () => {
    const { orchestration, mission } = await packetInTheWrongLayer();
    await tick('test-owner');

    // The new round's three passes, completed in the layer that owns the work.
    for (const ordinal of [5, 6, 7]) {
      const pass = await startPass({
        orchestrationId: orchestration.id,
        passKey: 'AUDIT',
        ordinal,
        provider: 'WORKER',
        model: 'wkr-2',
        prompt: `round two pass ${ordinal}`,
        promptSha256: 'y'.repeat(64),
      });
      await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
    }
    const discovery = await fixture.layerByName('Discovery Logic');
    const second = await recordAudit({
      projectId: fixture.project.id,
      layerId: discovery.id,
      auditedDocumentId: (await getOrchestration(orchestration.id))!.documentId,
      source: 'TEST',
      mode: 'SINGLE_DOCUMENT',
      result: {
        verdict: 'PASS',
        summary: 'In the layer that owns it, the work stands.',
        failures: [],
        missingDocuments: [],
        requiredResearchRuns: [],
        requiredPatches: [],
        synthesisRequired: false,
        freezeEligible: false,
        nextVersion: null,
        nextAction: 'None.',
        confidence: 0.9,
      },
      gaps: [],
    });
    await updateOrchestration(orchestration.id, {
      verdict: 'PASS',
      auditId: second.audit.id,
    });

    const advanced = await advancePacket(orchestration.id);
    expect(advanced.status).toBe('COMPLETE');

    // Two ticks, one writeback. The second is a replay, not a second effect.
    await tick('test-owner');
    const afterFirst = (await getMission(mission.id))!;
    expect(afterFirst.writebackAt).not.toBeNull();
    expect(afterFirst.state).toBe('DONE');

    await tick('test-owner');
    const afterSecond = (await getMission(mission.id))!;
    expect(afterSecond.writebackAt).toBe(afterFirst.writebackAt);

    const writebacks = (await listEvents(fixture.project.id, 300)).filter(
      (event) => event.eventType === 'RUSSELL_MISSION_WRITEBACK',
    );
    expect(writebacks).toHaveLength(1);
  });

  it('creates no follow-on when the packet settled what it asked', async () => {
    // §13 applies to a follow-on exactly as it does to a first question, and a
    // COMPLETE packet left nothing open — so the correct number is zero, and a
    // follow-on here would be research nobody needed.
    const { orchestration, mission } = await packetInTheWrongLayer();
    await tick('test-owner');
    await updateOrchestration(orchestration.id, { status: 'COMPLETE', verdict: 'PASS' });

    const report = await tick('test-owner');
    expect(report.followOns.filter((entry) => entry.missionId === mission.id)).toHaveLength(0);
    expect((await getMission(mission.id))!.nextMissionId).toBeNull();
  });
});
