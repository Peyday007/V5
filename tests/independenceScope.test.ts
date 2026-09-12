/**
 * The triage that turns a flat list of 117 into a handful of decisions.
 *
 * The production scan named a hundred and seventeen packets needing "a
 * decision". Eight of them were an author who also reviewed. A hundred and nine
 * recorded no session at all, which is a different fact with a different
 * remedy — and the single most damaging thing this module could do is let those
 * hundred and nine read as violations, either in a field or in a sentence.
 *
 * So what is pinned here is not "it classifies". It is the set of ways a triage
 * goes wrong:
 *
 *   - an unattributed packet described, anywhere, as demonstrated
 *   - a packet already being re-run counted among the ones somebody must act on
 *   - a corrected packet still counted against the round its correction replaced
 *   - a conclusion called "in use" because nothing said it was not
 *   - a conclusion called historical while a frozen layer stands on it
 *
 * Plus the `ORDER BY` rule, which is why the suite is also run against
 * Postgres: a report that only runs on the laptop is not a report about
 * production.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import { createAudit } from '../server/repos/audits.ts';
import { updateDocument } from '../server/repos/documents.ts';
import { updateLayer } from '../server/repos/layers.ts';
import { freezeLayer } from '../server/services/freeze.ts';
import {
  createFragments,
  createOrchestration,
  finishPass,
  startPass,
  updateOrchestration,
} from '../server/repos/research.ts';
import { openReopen, resolveReopen } from '../server/repos/auditReopens.ts';
import {
  createRequirements,
  insertExistingClaims,
  upsertCoverage,
} from '../server/repos/reconciliation.ts';
import { launchMission, linkMission, recordKnowledge } from '../server/repos/russellMissions.ts';
import { classifyPacket, scopeIndependence } from '../server/services/audit/independenceScope.ts';
import type { Document } from '../server/domain/types.ts';

let fixture: Awaited<ReturnType<typeof freshProject>>;
let projectId = '';
let layerId = '';
let runId = '';

/** The session that wrote the report, and the ones that did not. */
const AUTHOR = 'cred_author';
const OTHER = 'cred_other';
const THIRD = 'cred_third';
const FOURTH = 'cred_fourth';

/** Well ordered so a round boundary can sit between them. */
const FIRST_ROUND = '2026-01-01T00:00:00.000Z';
const BOUNDARY = '2026-02-01T00:00:00.000Z';
const SECOND_ROUND = '2026-03-01T00:00:00.000Z';

async function makePacket(title: string): Promise<string> {
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId,
    title,
    assignment: 'Answer one question.',
    provider: 'WORKER',
  });
  /*
   * A packet that filed a report had a fragment that cleared its gate. The
   * integrity-reaudit fixture went without one and that is what hid a whole
   * defect, so this one carries the shape production can actually produce.
   */
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: `q-${orchestration.id.slice(-6)}`,
      question: 'The one question this packet answered.',
      requiredEvidence: [
        {
          id: 'official_source',
          description: 'What the official source says.',
          necessity: 'REQUIRED',
        },
      ],
      acceptableSourceTypes: ['official source'],
      excludedSourceTypes: ['forum posts'],
      completionCriteria: ['The official source states the answer.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'ACCEPTED',
    },
  ]);
  return orchestration.id;
}

async function recordPass(input: {
  orchestrationId: string;
  passKey: 'SYNTHESIS' | 'AUDIT';
  ordinal: number;
  sessionRef: string | null;
  completedAt: string;
}): Promise<void> {
  const pass = await startPass({
    orchestrationId: input.orchestrationId,
    fragmentId: null,
    passKey: input.passKey,
    ordinal: input.ordinal,
    provider: 'WORKER',
    model: 'wkr_one',
    prompt: 'assignment',
    promptSha256: 'x'.repeat(64),
    executorWorkerId: 'wkr_one',
    executorRoutineId: 'rtn_one',
    executorAccountId: 'acct_one',
    executorSessionRef: input.sessionRef,
  });
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}', parsed: {} });
  await getDb().run('UPDATE research_passes SET completed_at = ? WHERE id = ?', [
    input.completedAt,
    pass.id,
  ]);
}

/** The production shape: one session wrote the report and filed the primary audit. */
async function authorReviewedItsOwnWork(orchestrationId: string, at = FIRST_ROUND): Promise<void> {
  await recordPass({ orchestrationId, passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR, completedAt: at });
  await recordPass({ orchestrationId, passKey: 'AUDIT', ordinal: 5, sessionRef: AUTHOR, completedAt: at });
  await recordPass({ orchestrationId, passKey: 'AUDIT', ordinal: 6, sessionRef: OTHER, completedAt: at });
  await recordPass({ orchestrationId, passKey: 'AUDIT', ordinal: 7, sessionRef: THIRD, completedAt: at });
}

/** Three separate reviewers, none of them the author. */
async function threeSeparateSessions(orchestrationId: string, at = FIRST_ROUND): Promise<void> {
  await recordPass({ orchestrationId, passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR, completedAt: at });
  await recordPass({ orchestrationId, passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER, completedAt: at });
  await recordPass({ orchestrationId, passKey: 'AUDIT', ordinal: 6, sessionRef: THIRD, completedAt: at });
  await recordPass({ orchestrationId, passKey: 'AUDIT', ordinal: 7, sessionRef: FOURTH, completedAt: at });
}

async function fileReport(orchestrationId: string, version: string): Promise<Document> {
  const document = await addDocument(fixture, 'Monetization Logic', version, { withFile: true });
  const audit = await createAudit({
    projectId,
    layerId,
    runId,
    auditedDocumentId: document.id,
    result: {
      verdict: 'PASS',
      summary: 'The round that was audited.',
      failures: [],
      missingDocuments: [],
      requiredResearchRuns: [],
      requiredPatches: [],
      synthesisRequired: false,
      freezeEligible: true,
      nextVersion: null,
      nextAction: 'Nothing.',
    },
  });
  await updateOrchestration(orchestrationId, {
    documentId: document.id,
    status: 'COMPLETE',
    verdict: 'PASS',
    auditId: audit.id,
    completedAt: new Date().toISOString(),
  });
  return document;
}

/** Make the layer say this document is its current version, as the state engine would. */
async function markCurrent(document: Document): Promise<void> {
  await updateLayer(layerId, { currentVersion: document.version });
}

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
  runId = run.id;
});

/* ========================================================================= */

describe('each status, from rows', () => {
  it('calls it DEMONSTRATED when a reviewer session is one of the author sessions', async () => {
    const packet = await makePacket('A packet its author audited');
    await authorReviewedItsOwnWork(packet);
    const document = await fileReport(packet, 'v1');
    await markCurrent(document);

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('DEMONSTRATED');
    expect(finding?.conflictedRoles).toEqual(['PRIMARY']);
    expect(finding?.statusReason).toContain('also authored');
  });

  it('calls it UNATTRIBUTED when a reviewer recorded no session, and never DEMONSTRATED', async () => {
    const packet = await makePacket('A packet nobody can tell about');
    await recordPass({ orchestrationId: packet, passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR, completedAt: FIRST_ROUND });
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 5, sessionRef: null, completedAt: FIRST_ROUND });
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 6, sessionRef: OTHER, completedAt: FIRST_ROUND });
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 7, sessionRef: THIRD, completedAt: FIRST_ROUND });
    await fileReport(packet, 'v1');

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('UNATTRIBUTED');
    // The data must not carry it either: a role only reaches `conflictedRoles`
    // when two recorded strings are equal, and a role that recorded nothing
    // never can.
    expect(finding?.conflictedRoles).toEqual([]);
    expect(finding?.unattributedRoles).toEqual(['PRIMARY']);
    expect(finding?.statusReason).toContain('cannot be told either way');
    expect(finding?.statusReason).not.toContain('authored');
  });

  it('calls an author with no recorded session UNATTRIBUTED rather than a violation', async () => {
    const packet = await makePacket('A packet whose author is unknown');
    await recordPass({ orchestrationId: packet, passKey: 'SYNTHESIS', ordinal: 4, sessionRef: null, completedAt: FIRST_ROUND });
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER, completedAt: FIRST_ROUND });
    await fileReport(packet, 'v1');

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('UNATTRIBUTED');
    expect(finding?.authorUnattributed).toBe(true);
    expect(finding?.conflictedRoles).toEqual([]);
  });

  it('calls it RECOVERING, not DEMONSTRATED, while a reopen is OPEN', async () => {
    const packet = await makePacket('A packet already being re-run');
    await authorReviewedItsOwnWork(packet);
    const document = await fileReport(packet, 'v1');
    await markCurrent(document);

    await openReopen({
      orchestrationId: packet,
      projectId,
      documentId: document.id,
      documentVersion: document.version,
      documentHash: document.fileHash ?? 'no-hash',
      finding: 'AUTHOR_REVIEWED_OWN_WORK',
      findingDetail: 'PRIMARY ran in the session that authored the report.',
      authorityChannel: 'DELEGATED_TERMINAL',
      supersededAuditId: null,
      rolesRerun: ['PRIMARY', 'ADVERSARIAL', 'JUDGE'],
      rolesCarried: [],
      requestedById: 'usr_someone',
      requestKey: `key-${packet}`,
      roundStartedAt: BOUNDARY,
    });

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('RECOVERING');
    expect(finding?.status).not.toBe('DEMONSTRATED');
    expect(finding?.reopen?.state).toBe('OPEN');
    // The reopen moved the boundary, so the pairing it was opened for is behind
    // it: the round that stands has no reviewer in it yet, which is what being
    // re-run means.
    expect(finding?.conflictedRoles).toEqual([]);
    expect(finding?.roundStartedAt).toBe(BOUNDARY);

    // And it is not a decision anybody is being asked to make.
    const report = await scopeIndependence({ projectId });
    expect(report.summary.decisions).not.toContain(packet);
  });

  it('calls a cancelled packet SUPERSEDED_HISTORY however its sessions look', async () => {
    const packet = await makePacket('A packet that was cancelled');
    await authorReviewedItsOwnWork(packet);
    await updateOrchestration(packet, {
      status: 'CANCELLED',
      cancelReason: 'the question stopped mattering',
      cancelledAt: new Date().toISOString(),
    });

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('SUPERSEDED_HISTORY');
    expect(finding?.statusReason).toContain('CANCELLED');
    // The pairing is still a recorded fact and is still reported. What the
    // status says is that nothing stands on the conclusion it produced, which
    // is a different sentence from "it did not happen".
    expect(finding?.conflictedRoles).toEqual(['PRIMARY']);
    expect(finding?.inUse).toBe(false);
  });

  it('calls a corrected packet SUPERSEDED_HISTORY without editing one recorded row', async () => {
    const packet = await makePacket('A packet whose round was replaced');
    await authorReviewedItsOwnWork(packet);
    const document = await fileReport(packet, 'v1');

    const before = await getDb().all<{ id: string; completed_at: string | null }>(
      'SELECT id, completed_at FROM research_passes WHERE orchestration_id = ? ORDER BY id',
      [packet],
    );

    const { reopen } = await openReopen({
      orchestrationId: packet,
      projectId,
      documentId: document.id,
      documentVersion: document.version,
      documentHash: document.fileHash ?? 'no-hash',
      finding: 'AUTHOR_REVIEWED_OWN_WORK',
      findingDetail: 'PRIMARY ran in the session that authored the report.',
      authorityChannel: 'DELEGATED_TERMINAL',
      supersededAuditId: null,
      rolesRerun: ['PRIMARY', 'ADVERSARIAL', 'JUDGE'],
      rolesCarried: [],
      requestedById: 'usr_someone',
      requestKey: `key-${packet}`,
      roundStartedAt: BOUNDARY,
    });

    // The replacement round: three sessions, none of them the author's.
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER, completedAt: SECOND_ROUND });
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 6, sessionRef: THIRD, completedAt: SECOND_ROUND });
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 7, sessionRef: FOURTH, completedAt: SECOND_ROUND });
    const replacement = await createAudit({
      projectId,
      layerId,
      runId,
      auditedDocumentId: document.id,
      result: {
        verdict: 'PASS',
        summary: 'The replacement round.',
        failures: [],
        missingDocuments: [],
        requiredResearchRuns: [],
        requiredPatches: [],
        synthesisRequired: false,
        freezeEligible: true,
        nextVersion: null,
        nextAction: 'Nothing.',
      },
    });
    expect(await resolveReopen({ id: reopen.id, auditId: replacement.id })).toBe(true);

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('SUPERSEDED_HISTORY');
    expect(finding?.roundStartedAt).toBe(BOUNDARY);
    expect(finding?.statusReason).toContain(reopen.id);
    expect(finding?.conflictedRoles).toEqual([]);

    // §5: the boundary moved in time; every pass is exactly where it was.
    const after = await getDb().all<{ id: string; completed_at: string | null }>(
      'SELECT id, completed_at FROM research_passes WHERE orchestration_id = ? ORDER BY id',
      [packet],
    );
    for (const row of before) {
      expect(after.find((entry) => entry.id === row.id)?.completed_at).toBe(row.completed_at);
    }
  });

  it('calls three separated sessions CLEAN and leaves them out of the report', async () => {
    const packet = await makePacket('A packet audited properly');
    await threeSeparateSessions(packet);
    await fileReport(packet, 'v1');

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('CLEAN');

    const report = await scopeIndependence({ projectId });
    expect(report.summary.byStatus.CLEAN).toBe(1);
    expect(report.findings.map((entry) => entry.orchestrationId)).not.toContain(packet);
  });

  it('calls a packet with nothing to compare CLEAN rather than unknown', async () => {
    const packet = await makePacket('A packet that has not been audited');
    await recordPass({ orchestrationId: packet, passKey: 'SYNTHESIS', ordinal: 4, sessionRef: null, completedAt: FIRST_ROUND });

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('CLEAN');
    expect(finding?.statusReason).toContain('nothing to compare');
  });
});

/* ========================================================================= */

describe('whether the conclusion is still in use', () => {
  it('reports a superseded document as not in use, and says which row says so', async () => {
    const packet = await makePacket('A packet whose report was replaced');
    await authorReviewedItsOwnWork(packet);
    const first = await fileReport(packet, 'v1');
    const second = await addDocument(fixture, 'Monetization Logic', 'v1B', { withFile: true });
    await updateDocument(first.id, {
      supersededByDocumentId: second.id,
      status: 'SUPERSEDED',
    });
    await markCurrent(second);

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('DEMONSTRATED');
    expect(finding?.inUse).toBe(false);
    expect(finding?.use).toEqual([]);
    expect(finding?.notInUseReason).toContain('superseded');
    expect(finding?.dependents).toEqual([]);
  });

  it('reports a frozen layer as in use, and names the layer as the dependent', async () => {
    const packet = await makePacket('A packet the archive stands on');
    await authorReviewedItsOwnWork(packet);
    const document = await fileReport(packet, 'v1');
    await freezeLayer(layerId, document.id);

    const finding = await classifyPacket(packet);
    expect(finding?.inUse).toBe(true);
    expect(finding?.use.map((entry) => entry.kind)).toContain('LAYER_FROZEN');
    expect(finding?.use.find((entry) => entry.kind === 'LAYER_FROZEN')?.rowId).toBe(layerId);
    expect(finding?.dependents.some((entry) => entry.kind === 'LAYER' && entry.id === layerId)).toBe(
      true,
    );
    expect(finding?.notInUseReason).toBeNull();
  });

  it('is not in use merely because nothing said otherwise', async () => {
    const packet = await makePacket('A packet nothing leans on');
    await authorReviewedItsOwnWork(packet);
    // Filed, but the layer names no canonical document and no current version,
    // nothing was written back, and no other packet cites it.
    await fileReport(packet, 'v1');

    const finding = await classifyPacket(packet);
    expect(finding?.status).toBe('DEMONSTRATED');
    expect(finding?.inUse).toBe(false);
    expect(finding?.notInUseReason).toContain('no current knowledge row came from it');
    expect(finding?.notInUseReason).toContain('no other packet cites its claims');
  });

  it('reports a current knowledge row as in use, and a superseded one as not', async () => {
    const packet = await makePacket('A packet Russell wrote back');
    await authorReviewedItsOwnWork(packet);
    await fileReport(packet, 'v1');

    const { mission } = await launchMission({
      projectId,
      layerId,
      visibility: 'SHARED',
      objective: 'Settle the one question.',
      whyNow: 'Because it was asked.',
      idempotencyKey: `mission-${packet}`,
    });
    await linkMission({ missionId: mission.id, orchestrationId: packet });
    const knowledge = await recordKnowledge({
      projectId,
      layerId,
      visibility: 'SHARED',
      kind: 'CONCLUSION',
      statement: 'The answer the project now holds.',
      provenance: { orchestrationId: packet },
      authorType: 'PIPELINE',
      confidence: 'ESTABLISHED',
      missionId: mission.id,
    });

    const inUse = await classifyPacket(packet);
    expect(inUse?.inUse).toBe(true);
    expect(inUse?.use.map((entry) => entry.kind)).toContain('KNOWLEDGE_CURRENT');
    expect(inUse?.dependents.some((entry) => entry.id === knowledge.id)).toBe(true);

    // A belief the project has already replaced is history in exactly the way a
    // superseded document is, so it stops being a dependent. The replacement
    // came from somewhere else — a person, another mission — which is why this
    // packet is left with nothing current.
    const replacement = await recordKnowledge({
      projectId,
      layerId,
      visibility: 'SHARED',
      kind: 'CONCLUSION',
      statement: 'What the project believes instead.',
      provenance: {},
      authorType: 'HUMAN',
      confidence: 'ESTABLISHED',
      supersedesId: knowledge.id,
    });
    await getDb().run('UPDATE russell_knowledge SET superseded_by_id = ? WHERE id = ?', [
      replacement.id,
      knowledge.id,
    ]);

    const later = await classifyPacket(packet);
    expect(later?.dependents.some((entry) => entry.id === knowledge.id)).toBe(false);
    expect(later?.notInUseReason).toContain('no current knowledge row came from it');
  });

  it('names another packet that cites its claims as a dependent', async () => {
    const author = await makePacket('The packet that answered it');
    await authorReviewedItsOwnWork(author);
    const document = await fileReport(author, 'v1');

    const [claim] = await insertExistingClaims([
      {
        projectId,
        documentId: document.id,
        extractionRunId: null,
        layerId,
        claim: 'The statutory fee is fixed by section 211.',
        claimType: 'SOURCED_FACT',
        extractionConfidence: 0.9,
        evidenceConfidence: 0.9,
        contentHash: 'a'.repeat(64),
      },
    ]);
    expect(claim).toBeTruthy();

    const consumer = await makePacket('The packet that relied on it');
    const [requirement] = await createRequirements([
      {
        orchestrationId: consumer,
        projectId,
        layerId,
        requirementKey: 'the-fee',
        ordinal: 0,
        statement: 'State the statutory fee.',
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
      },
    ]);
    expect(requirement).toBeTruthy();
    await upsertCoverage({
      orchestrationId: consumer,
      requirementId: requirement!.id,
      status: 'SATISFIED',
      reasons: ['the archive already answers this'],
      claimIds: [claim!.id],
      documentIds: [document.id],
      confidence: 0.9,
      needsResearch: false,
    });

    const finding = await classifyPacket(author);
    expect(finding?.inUse).toBe(true);
    expect(finding?.use.map((entry) => entry.kind)).toContain('CITED_BY_PACKET');
    const dependent = finding?.dependents.find((entry) => entry.kind === 'REQUIREMENT_COVERAGE');
    expect(dependent?.orchestrationId).toBe(consumer);
  });
});

/* ========================================================================= */

describe('the triage summary', () => {
  it('separates the decisions from everything else, and never counts the unknown as a finding', async () => {
    // One demonstrated and relied on: the decision.
    const decided = await makePacket('Demonstrated, and the layer is frozen on it');
    await authorReviewedItsOwnWork(decided);
    const frozenDocument = await fileReport(decided, 'v1');
    await freezeLayer(layerId, frozenDocument.id);

    // One demonstrated and historical.
    const historical = await makePacket('Demonstrated, and cancelled');
    await authorReviewedItsOwnWork(historical);
    await updateOrchestration(historical, {
      status: 'CANCELLED',
      cancelReason: 'abandoned',
      cancelledAt: new Date().toISOString(),
    });

    // Two nobody can tell about.
    for (const title of ['Unknown one', 'Unknown two']) {
      const packet = await makePacket(title);
      await recordPass({ orchestrationId: packet, passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR, completedAt: FIRST_ROUND });
      await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 5, sessionRef: null, completedAt: FIRST_ROUND });
    }

    // One that is fine.
    const clean = await makePacket('Audited properly');
    await threeSeparateSessions(clean);

    const report = await scopeIndependence({ projectId });

    expect(report.summary.scanned).toBe(5);
    expect(report.summary.byStatus).toEqual({
      DEMONSTRATED: 1,
      UNATTRIBUTED: 2,
      RECOVERING: 0,
      SUPERSEDED_HISTORY: 1,
      CLEAN: 1,
    });
    expect(report.summary.notClean).toBe(4);
    expect(report.summary.decisions).toEqual([decided]);
    expect(report.summary.unattributedInUse + report.summary.unattributedHistorical).toBe(2);

    // The headline must make the short list obvious, and must describe the
    // unknown as unknown every time it mentions it.
    expect(report.summary.headline).toContain('1 is a demonstrated');
    expect(report.summary.headline).toContain('2 recorded no session');
    expect(report.summary.headline).toContain('not a violation');

    // Strongest statement first, and in-use ahead of historical.
    expect(report.findings[0]?.orchestrationId).toBe(decided);
    expect(report.findings.map((entry) => entry.status)).toEqual([
      'DEMONSTRATED',
      'UNATTRIBUTED',
      'UNATTRIBUTED',
      'SUPERSEDED_HISTORY',
    ]);
  });

  it('says there is nothing to decide when nothing is both demonstrated and in use', async () => {
    const packet = await makePacket('Unknown, and nothing leans on it');
    await recordPass({ orchestrationId: packet, passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR, completedAt: FIRST_ROUND });
    await recordPass({ orchestrationId: packet, passKey: 'AUDIT', ordinal: 5, sessionRef: null, completedAt: FIRST_ROUND });

    const report = await scopeIndependence({ projectId });
    expect(report.summary.decisions).toEqual([]);
    expect(report.summary.headline).toContain('nothing to decide');
    expect(report.summary.headline).toContain('not a violation');
  });

  it('scopes to one project when asked, and reads every packet when not', async () => {
    const packet = await makePacket('The only packet here');
    await authorReviewedItsOwnWork(packet);
    await fileReport(packet, 'v1');

    expect((await scopeIndependence({ projectId })).summary.scanned).toBe(1);
    expect((await scopeIndependence()).summary.scanned).toBe(1);
    expect((await scopeIndependence({ projectId: 'prj_nothing' })).summary.scanned).toBe(0);
  });

  it('answers null for a packet that does not exist', async () => {
    expect(await classifyPacket('orc_nothing')).toBeNull();
  });
});
