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
import {
  decideHandoff,
  HANDOFF_DECIDER_VERSION,
  routeAuditedDocument,
} from '../server/services/audit/handoff.ts';
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
import {
  enqueueWork,
  getWorkItem,
  getWorkItemRow,
  listWorkItems,
  listWorkItemsForOrchestration,
} from '../server/repos/workQueue.ts';
import { auditAdmission } from '../server/services/research/auditAdmission.ts';
import {
  createBin,
  getBin,
  listBinEvents,
  terminateUnleasedBin,
} from '../server/repos/bins.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import {
  askHuman,
  getMission,
  knowledgeForMission,
  launchMission,
  linkMission,
  openRequestFor,
  reanchorKnowledge,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { createUser } from '../server/repos/identity.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { reconcileCompletedMission } from '../server/services/russell/completionLinks.ts';

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
  async function packetInTheWrongLayer(options: { conversationId?: string | null } = {}) {
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

    /*
     * Round one: three completed passes, exactly as the real packet had —
     * including the execution lineage, which is not decoration here. The
     * separation matrix and the judge's wait are both decided from these
     * columns, so a fixture that left them null would make every cross-round
     * comparison refuse for "unrecorded lineage" and prove nothing about the
     * rule under test.
     */
    const roundOne = { PRIMARY: 5, ADVERSARIAL: 6, JUDGE: 7 } as const;
    for (const [role, ordinal] of Object.entries(roundOne)) {
      const pass = await startPass({
        orchestrationId: orchestration.id,
        passKey: 'AUDIT',
        ordinal,
        provider: 'WORKER',
        model: 'wkr-1',
        prompt: `audit pass ${ordinal}`,
        promptSha256: 'x'.repeat(64),
        executorWorkerId: 'wkr_round_one',
        executorRoutineId: 'frt_round_one',
        executorAccountId: 'fac_round_one',
        executorSessionRef: `oat_round_one_${role.toLowerCase()}`,
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

    /*
     * The bin, parked exactly as production's was.
     *
     * `RESEARCH_PACKET_V1` refuses a packet sitting at `NEEDS_HUMAN` with the
     * disposition `HUMAN`, and a `HUMAN` refusal terminalizes the bin. So the
     * real chain had three parks, not two — and the bin is the one that
     * decides whether a worker is ever sent. A fixture without it routes a
     * document into a project where nothing was ever waiting.
     */
    const bin = await createBin({
      projectId: fixture.project.id,
      layerId: worldModel.id,
      kind: 'RESEARCH_PACKET',
      title: 'County property tax assessment roll access',
      objective: 'Research it, file it, and have it audited.',
      manifest: {
        objective: 'Research it, file it, and have it audited.',
        why: 'The archive does not answer it.',
        lineage: {
          projectId: fixture.project.id,
          layerId: worldModel.id,
          goal: null,
          orchestrationId: orchestration.id,
        },
        units: [],
        acceptableSources: ['county register of deeds or recording office'],
        excludedSources: ['vendor or software marketing pages'],
        evidence: ['a quoted official statement of terms'],
        outputs: ['a filed report'],
        authorizedActions: ['read official public records'],
        prohibitedActions: ['any spend'],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 30 },
        stoppingConditions: ['the packet is terminal'],
      },
      completionContract: 'RESEARCH_PACKET_V1',
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    await terminateUnleasedBin(
      bin.id,
      bin.leaseGeneration,
      'NEEDS_HUMAN',
      'The packet is NEEDS_HUMAN, which is not a state it files a report in.',
    );

    const { mission } = await launchMission({
      projectId: fixture.project.id,
      layerId: worldModel.id,
      visibility: 'PRIVATE',
      objective: 'County property tax assessment roll access',
      whyNow: "The project's own archive does not answer this.",
      idempotencyKey: `handoff-test-${orchestration.id}`,
      conversationId: options.conversationId ?? null,
    });
    await linkMission({ missionId: mission.id, orchestrationId: orchestration.id, binId: bin.id });
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

    return {
      document,
      orchestration,
      audit: audit.audit,
      mission,
      staleItemId: stale.id,
      roundOne,
      binId: bin.id,
    };
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

  it('puts the packet\u2019s bin back to work, so a worker is actually sent', async () => {
    /*
     * The third park, and the only one nothing answered.
     *
     * The document routed, the packet reopened, the mission left NEEDS_HUMAN
     * and the person\u2019s request was withdrawn with a truthful message \u2014 and the
     * bin stayed terminal, so the reopened round\u2019s first audit item sat queued
     * and claimable with nobody ever sent for it. Worse than stuck: the person
     * had already been told there was nothing left for them to decide.
     */
    const { mission, binId } = await packetInTheWrongLayer();
    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');
    const parked = (await getBin(binId))!;

    const report = await tick('test-owner');
    expect(report.binReopenRefused).toHaveLength(0);

    const bin = (await getBin(binId))!;
    expect(bin.state).toBe('READY');
    // Answered, not erased: §5 and the reopen\u2019s own contract.
    expect(bin.attemptCount).toBe(parked.attemptCount);
    expect(bin.leaseGeneration).toBeGreaterThan(parked.leaseGeneration);
    expect((await getMission(mission.id))!.state).toBe('RUNNING');

    // And it is Brain that answered it, on the routing, recorded as itself.
    const reopened = (await listBinEvents(binId, 100)).filter(
      (event) => event.eventType === 'BIN_REOPENED',
    );
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.reason).toMatch(/layer that owns this work/);
  });

  it('leaves a bin parked for a reason the routing did not resolve', async () => {
    // The guard is narrower, not absent. A packet that has genuinely finished
    // and failed still answers HUMAN, so reopening would spend an activation to
    // be refused for the same reason — and the routing is still correct, since
    // the document belongs to Discovery Logic whatever became of the packet.
    const { orchestration, binId } = await packetInTheWrongLayer();
    await updateOrchestration(orchestration.id, {
      status: 'FAILED',
      failureReason: 'Nothing left to try.',
    });

    const report = await tick('test-owner');
    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');
    expect(report.binReopenRefused.map((entry) => entry.binId)).toContain(binId);
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

  /*
   * The links a finished mission leaves behind.
   *
   * The handoff and the second round were built and proven, and the packet came
   * out right: the report was filed in the layer that owns it and three fresh
   * sessions passed it. Then the mission's own pointers still named round one.
   *
   * `russell_missions.document_id`, `audit_id` and `layer_id` are what the
   * writeback reads — `recordKnowledge` files the conclusion under the layer
   * and attaches the document and the audit as its provenance — so a stale
   * pointer does not stop anything and does not look like a failure. It just
   * makes the project believe the right conclusion under the wrong heading,
   * citing the verdict that said the work belonged somewhere else.
   *
   * In production that is what mission `rms_2f53d1629a4348b2be53` did.
   */
  describe('a finished mission cites the round that actually judged it', () => {
    /** Round two, run and passed in the layer the handoff moved the work to. */
    async function passRoundTwo(orchestrationId: string) {
      const packet = (await getOrchestration(orchestrationId))!;
      const discovery = await fixture.layerByName('Discovery Logic');
      // The role's own ordinal, which is what `earlierAuditRole` matches on.
      // Round one used the same three; the round boundary is what separates
      // them, and that is the whole point of the boundary being a timestamp.
      for (const ordinal of [5, 6, 7]) {
        const pass = await startPass({
          orchestrationId,
          passKey: 'AUDIT',
          ordinal,
          provider: 'WORKER',
          model: 'wkr-2',
          prompt: `round two pass ${ordinal}`,
          promptSha256: 'y'.repeat(64),
          executorWorkerId: 'wkr_round_two',
          executorRoutineId: 'frt_round_two',
          executorAccountId: 'fac_round_two',
          executorSessionRef: `oat_round_two_${ordinal}`,
        });
        await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
      }
      const second = await recordAudit({
        projectId: fixture.project.id,
        layerId: discovery.id,
        runId: packet.runId,
        auditedDocumentId: packet.documentId,
        auditedDocumentIds: packet.documentId ? [packet.documentId] : [],
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
      await updateOrchestration(orchestrationId, {
        verdict: 'PASS',
        auditId: second.audit.id,
      });
      const advanced = await advancePacket(orchestrationId);
      expect(advanced.status).toBe('COMPLETE');
      return { audit: second.audit, discovery };
    }

    it('points at round two, and files what it concluded in the new layer', async () => {
      const { orchestration, mission, audit: roundOne } = await packetInTheWrongLayer();
      await tick('test-owner');

      /*
       * Both links already set, and both naming round one — the state a mission
       * is in whenever anything linked it while the first round was live. The
       * old derivation stopped looking the moment these two were non-null, so
       * everything below was decided before the second round existed. Non-null
       * is not the same fact as current, and this is where the difference bites.
       */
      await linkMission({
        missionId: mission.id,
        documentId: (await getOrchestration(orchestration.id))!.documentId!,
        auditId: roundOne.id,
      });

      const { audit: roundTwo, discovery } = await passRoundTwo(orchestration.id);
      expect(roundTwo.id).not.toBe(roundOne.id);

      const writebackTick = await tick('test-owner');

      /*
       * Corrected *before* the writeback, not repaired afterwards.
       *
       * The reconciliation below can fix a mission that already wrote back, and
       * that would hide this: it runs later in the same tick, so an early
       * return here would produce a stale writeback and an immediate
       * correction, and every assertion below would still pass. Requiring no
       * correction is what makes the re-read load-bearing.
       */
      expect(writebackTick.linksReconciled).toHaveLength(0);
      expect(
        (await listEvents(fixture.project.id, 300)).filter(
          (event) => event.eventType === 'RUSSELL_LINKS_RECONCILED',
        ),
      ).toHaveLength(0);

      /*
       * The link, and the exact thing that was wrong.
       *
       * `listAuditsByProject` returns newest first and the old derivation took
       * the last element of it, so with two audits in one run it chose the
       * older one every time — round one's `MORE_RESEARCH`, the verdict that
       * sent the work away. Asserting on the id rather than on a count is the
       * point: both were present and one of them was correct.
       */
      const finished = (await getMission(mission.id))!;
      expect(finished.auditId).toBe(roundTwo.id);
      expect(finished.auditId).not.toBe(roundOne.id);

      // All four rows carrying the same ownership fact agree.
      const packet = (await getOrchestration(orchestration.id))!;
      expect(packet.layerId).toBe(discovery.id);
      expect((await getDocument(packet.documentId!))!.layerId).toBe(discovery.id);
      expect(finished.layerId).toBe(discovery.id);
      expect(finished.documentId).toBe(packet.documentId);

      const knowledge = await knowledgeForMission(mission.id);
      expect(knowledge.length).toBeGreaterThan(0);
      for (const row of knowledge) {
        expect(row.layerId).toBe(discovery.id);
        expect(row.provenance['auditId']).toBe(roundTwo.id);
        expect(row.provenance['documentId']).toBe(packet.documentId);
      }

      // And it is still one writeback, replayed rather than repeated.
      await tick('test-owner');
      const again = (await getMission(mission.id))!;
      expect(again.writebackAt).toBe(finished.writebackAt);
      expect(
        (await listEvents(fixture.project.id, 300)).filter(
          (event) => event.eventType === 'RUSSELL_MISSION_WRITEBACK',
        ),
      ).toHaveLength(1);
      expect(await knowledgeForMission(mission.id)).toHaveLength(knowledge.length);
    });

    it('aligns the mission with the document, whoever calls the handoff', async () => {
      /*
       * The alignment used to live in the Russell loop's re-open path, so a
       * mission stayed with its document exactly when the loop was the caller.
       * This calls the routing directly, which is what any other consumer —
       * including the reconciliation below — would do.
       */
      const { mission, audit } = await packetInTheWrongLayer();
      const discovery = await fixture.layerByName('Discovery Logic');

      const routed = await routeAuditedDocument({ auditId: audit.id });
      expect(routed.ok).toBe(true);
      expect((await getMission(mission.id))!.layerId).toBe(discovery.id);
    });

    it('repairs a mission that already wrote back against the round before it', async () => {
      /*
       * This is the one starting state the current build cannot produce, and
       * arranging it is therefore the honest thing rather than the shortcut the
       * rest of this file avoids: the rows exist because an *older* build wrote
       * them, and the reconciliation exists for exactly those rows. What is
       * arranged is precisely what production has — a written-back mission
       * whose links name the superseded round, and knowledge derived from them.
       */
      const owner = await createUser({
        email: 'reconcile-owner@example.test',
        displayName: 'The owner',
        password: 'a-long-enough-password',
        isBrainAdmin: false,
      });
      const conversation = await createConversation({
        ownerUserId: owner.id,
        title: 'County assessment rolls',
        projectId: fixture.project.id,
        visibility: 'PRIVATE',
      });
      const { orchestration, mission, audit: roundOne } = await packetInTheWrongLayer({
        conversationId: conversation.id,
      });
      const worldModel = await fixture.layerByName('World Model');
      await tick('test-owner');
      const { audit: roundTwo, discovery } = await passRoundTwo(orchestration.id);
      await tick('test-owner');

      const finished = (await getMission(mission.id))!;
      const knowledgeBefore = await knowledgeForMission(mission.id);
      const turnsBefore = await listTurns(conversation.id);
      expect(knowledgeBefore.length).toBeGreaterThan(0);

      // Wind the links back to what the older build left, projection included.
      await linkMission({
        missionId: mission.id,
        auditId: roundOne.id,
        layerId: worldModel.id,
      });
      for (const row of knowledgeBefore) {
        await reanchorKnowledge({
          knowledgeId: row.id,
          layerId: worldModel.id,
          provenance: { ...row.provenance, auditId: roundOne.id },
        });
      }

      const report = await tick('test-owner');

      expect(report.linksReconciled.map((entry) => entry.missionId)).toContain(mission.id);
      const corrected = (await getMission(mission.id))!;
      expect(corrected.auditId).toBe(roundTwo.id);
      expect(corrected.layerId).toBe(discovery.id);
      expect(corrected.documentId).toBe(finished.documentId);

      // The projection is corrected in place: same rows, same ids, no second
      // conclusion and no second thing for a person to read.
      const knowledgeAfter = await knowledgeForMission(mission.id);
      expect(knowledgeAfter.map((row) => row.id)).toEqual(knowledgeBefore.map((row) => row.id));
      for (const row of knowledgeAfter) {
        expect(row.layerId).toBe(discovery.id);
        expect(row.provenance['auditId']).toBe(roundTwo.id);
        expect(row.supersededById).toBeNull();
      }
      expect((await listTurns(conversation.id)).map((turn) => turn.id)).toEqual(
        turnsBefore.map((turn) => turn.id),
      );

      // Nothing is re-run and nothing is written back twice.
      expect(corrected.writebackAt).toBe(finished.writebackAt);
      expect(
        (await listEvents(fixture.project.id, 300)).filter(
          (event) => event.eventType === 'RUSSELL_MISSION_WRITEBACK',
        ),
      ).toHaveLength(1);

      // Both audits are still there, and the correction says what it did.
      const audits = await listAuditsByProject(fixture.project.id);
      expect(audits.map((entry) => entry.id)).toEqual(
        expect.arrayContaining([roundOne.id, roundTwo.id]),
      );
      const reconciled = (await listEvents(fixture.project.id, 300)).filter(
        (event) => event.eventType === 'RUSSELL_LINKS_RECONCILED',
      );
      expect(reconciled).toHaveLength(1);
      const corrections = reconciled[0]!.payload['corrections'] as {
        field: string;
        from: string | null;
        to: string;
      }[];
      expect(corrections.map((entry) => entry.field).sort()).toEqual(['auditId', 'layerId']);
      expect(corrections.find((entry) => entry.field === 'auditId')).toMatchObject({
        from: roundOne.id,
        to: roundTwo.id,
      });

      // Idempotent by the state it produces: nothing left to select.
      const second = await tick('test-owner');
      expect(second.linksReconciled).toHaveLength(0);
      expect(
        (await listEvents(fixture.project.id, 300)).filter(
          (event) => event.eventType === 'RUSSELL_LINKS_RECONCILED',
        ),
      ).toHaveLength(1);
      expect(await reconcileCompletedMission(mission.id)).toMatchObject({
        ok: true,
        refusal: 'ALREADY_CURRENT',
      });
    });

    it('refuses to repoint at nothing while a re-opened round is unfinished', async () => {
      /*
       * Between the handoff and round two's judge the mission's audit is stale
       * and there is no replacement. Blanking it would leave a filed conclusion
       * citing no verdict at all, which is worse than the stale citation, so
       * this stops and says which case it is — and says it every tick, because
       * a round that never finishes is a fact somebody would want.
       */
      const { mission, audit: roundOne } = await packetInTheWrongLayer();
      await tick('test-owner');
      await linkMission({ missionId: mission.id, auditId: roundOne.id });

      const outcome = await reconcileCompletedMission(mission.id);
      expect(outcome.ok).toBe(false);
      expect(outcome.refusal).toBe('NO_CURRENT_ROUND_AUDIT');
      expect((await getMission(mission.id))!.auditId).toBe(roundOne.id);
    });
  });

  /*
   * The round boundary has four readers, and a boundary three of them apply is
   * worse than none.
   *
   * `auditBriefFor` and `packetRunner` were scoped when the handoff was built.
   * `auditAdmission` was not, and it is the one that decides *who may take a
   * role* — so the previous round's completed arguments were still satisfying
   * the judge's wait. Nothing produced a JUDGE item early, because the runner
   * enqueues the roles in order, which is exactly why this needed a test rather
   * than a reading: the weakened control was invisible behind a correct one.
   */
  describe('a re-audited packet is judged on its own round', () => {
    /** The lineage an arriving worker brings, all of it server-derived. */
    const arriving = {
      workerId: 'wkr_round_two',
      routineId: 'frt_round_two',
      accountId: 'fac_round_two',
      sessionRef: 'oat_round_two_judge',
    };

    it('refuses a judge whose arguments belong to the round before the handoff', async () => {
      const { orchestration } = await packetInTheWrongLayer();
      await tick('test-owner');

      const item = await enqueueWork({
        projectId: fixture.project.id,
        workType: 'RESEARCH_AUDIT',
        payload: { role: 'JUDGE' },
        createdByType: 'SYSTEM',
        requiredScopes: ['queue:claim'],
        orchestrationId: orchestration.id,
      });
      const row = (await getWorkItemRow(item.id))!;

      const verdict = await auditAdmission(arriving)(row);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('may not begin until');
      // Both arguments, because this round has produced neither.
      expect(verdict.reason).toContain('PRIMARY and ADVERSARIAL');
    });

    it('admits the judge once this round has produced both arguments', async () => {
      const { orchestration } = await packetInTheWrongLayer();
      await tick('test-owner');

      for (const [role, ordinal] of [
        ['primary', 5],
        ['adversarial', 6],
      ] as const) {
        const pass = await startPass({
          orchestrationId: orchestration.id,
          passKey: 'AUDIT',
          ordinal,
          provider: 'WORKER',
          model: 'wkr-2',
          prompt: `round two ${role}`,
          promptSha256: 'y'.repeat(64),
          executorWorkerId: 'wkr_round_two',
          executorRoutineId: 'frt_round_two',
          executorAccountId: 'fac_round_two',
          executorSessionRef: `oat_round_two_${role}`,
        });
        await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
      }

      const item = await enqueueWork({
        projectId: fixture.project.id,
        workType: 'RESEARCH_AUDIT',
        payload: { role: 'JUDGE' },
        createdByType: 'SYSTEM',
        requiredScopes: ['queue:claim'],
        orchestrationId: orchestration.id,
      });
      const verdict = await auditAdmission(arriving)((await getWorkItemRow(item.id))!);
      expect(verdict.ok).toBe(true);
    });

    it('still refuses a judge that argued in this round', async () => {
      // The floor itself, unchanged: scoping decides *which* passes are
      // compared and never whether the comparison happens.
      const { orchestration } = await packetInTheWrongLayer();
      await tick('test-owner');

      for (const [role, ordinal] of [
        ['primary', 5],
        ['adversarial', 6],
      ] as const) {
        const pass = await startPass({
          orchestrationId: orchestration.id,
          passKey: 'AUDIT',
          ordinal,
          provider: 'WORKER',
          model: 'wkr-2',
          prompt: `round two ${role}`,
          promptSha256: 'y'.repeat(64),
          executorWorkerId: 'wkr_round_two',
          executorRoutineId: 'frt_round_two',
          executorAccountId: 'fac_round_two',
          executorSessionRef: `oat_round_two_${role}`,
        });
        await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
      }

      const item = await enqueueWork({
        projectId: fixture.project.id,
        workType: 'RESEARCH_AUDIT',
        payload: { role: 'JUDGE' },
        createdByType: 'SYSTEM',
        requiredScopes: ['queue:claim'],
        orchestrationId: orchestration.id,
      });
      const verdict = await auditAdmission({
        ...arriving,
        sessionRef: 'oat_round_two_adversarial',
      })((await getWorkItemRow(item.id))!);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('same session');
      // The refusal names the pair and the dimension and never the credential.
      expect(verdict.reason).not.toContain('oat_round_two_adversarial');
    });

    it('does not refuse this round for sharing a session with the last one', async () => {
      /*
       * A session that attacked the document under the World Model's criteria
       * is not reviewing its own work when it writes the primary audit under
       * Discovery Logic's — the round it argued in has been superseded and
       * nothing is judging it. Refusing anyway is stricter than the rule, and
       * stricter in the wrong direction: it withholds a surface on the strength
       * of a verdict that no longer stands.
       */
      const { orchestration } = await packetInTheWrongLayer();
      await tick('test-owner');
      // The tick reopens the round; the runner is what enqueues its first role.
      await advancePacket(orchestration.id);

      const items = (await listWorkItemsForOrchestration(orchestration.id)).filter(
        (item) => item.workType === 'RESEARCH_AUDIT' && item.state === 'QUEUED',
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.payload['role']).toBe('PRIMARY');

      const verdict = await auditAdmission({
        ...arriving,
        sessionRef: 'oat_round_one_adversarial',
      })((await getWorkItemRow(items[0]!.id))!);
      expect(verdict.ok).toBe(true);
    });
  });
});
