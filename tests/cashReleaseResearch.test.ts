/**
 * Openings filed from a freelance-marketplace listing are put away with their
 * research, and live bins under a contract with no evaluator are retired.
 *
 * Both passes are derived from rows on the tick. They keep every row, touch no
 * opening somebody committed to or a person archived, and do nothing the
 * second time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, getOrchestration, insertClaims } from '../server/repos/research.ts';
import { createNeed, createOpportunity, getNeed, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createCandidate, getCandidate, transitionCandidate } from '../server/repos/russellCandidates.ts';
import { getMission, launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { getDb } from '../server/db/database.ts';
import { releaseOpportunityResearch } from '../server/services/cash/releaseResearch.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({
    email: `retire-${Math.random().toString(36).slice(2, 10)}@example.com`,
    displayName: 'Owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  ownerId = owner.id;
  const started = await activate({
    projectId,
    ownerUserId: owner.id,
    actorUserId: owner.id,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
});

async function packet(title: string): Promise<string> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title,
    assignment: title,
    provider: 'WORKER',
    autoApprove: false,
  });
  return orchestration.id;
}

async function opening(url: string): Promise<string> {
  const orchestrationId = await packet('discovery');
  const [fragment] = await createFragments([
    {
      orchestrationId,
      projectId,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'market-signal',
      question: 'Who published a paid request?',
      geography: null,
      timeframe: null,
      population: null,
      definitions: null,
      requiredEvidence: [],
      acceptableSourceTypes: [],
      excludedSourceTypes: [],
      completionCriteria: ['A request.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'ACCEPTED',
    },
  ]);
  const [claim] = await insertClaims([
    {
      orchestrationId,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'TARGETED',
      claim: 'A client posted an open fixed-price request.',
      claimType: 'SOURCED_FACT',
      sourceUrl: url,
      sourceTitle: 'A request',
      sourcePublisher: 'A publisher',
      sourceDate: '2026-10-19',
      evidenceExcerpt: 'open fixed-price request',
      evidenceLocator: 'page',
      evidenceLane: 'demand_signal',
      retrievedAt: '2026-10-19T12:00:00.000Z',
      confidence: 0.8,
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      accepted: true,
      rejectionReason: null,
      contentHash: url,
    },
  ]);
  const made = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: ownerId,
    title: 'An opening',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    opportunitySignal: 'PAID_TASK_OR_CONTRACT',
    currency: 'USD',
    sourceClaimId: claim!.id,
  });
  return made.id;
}

async function setState(id: string, state: string, archivedReason: string | null = null): Promise<void> {
  await getDb().run('UPDATE cash_opportunities SET state = ?, archived_reason = ? WHERE id = ?', [state, archivedReason, id]);
}

const REASON = 'The goal screen rejected this opening.';

describe('releasing the research behind an opening', () => {
  it('releases needs, ideas, missions and packets, freeing the slot, and does it once', async () => {
    const id = await opening('https://www.example-buyer.com/rfp/a');
    const dive = await createCandidate({ projectId, visibility: 'SHARED', title: 'Qualify', statement: 'Qualify it.' });
    await transitionCandidate({ candidateId: dive.id, from: 'CAPTURED', to: 'QUEUED' });
    const divePacket = await packet('dive');
    const { mission } = await launchMission({
      projectId, visibility: 'SHARED', objective: 'Qualify it.', whyNow: 'test',
      idempotencyKey: `dive-${dive.id}`, candidateId: dive.id,
    });
    await linkMission({ missionId: mission.id, orchestrationId: divePacket });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    await updateOpportunity(id, { candidate_id: dive.id, validation_orchestration_id: divePacket, validation_state: 'RUNNING' });
    const question = await createCandidate({ projectId, visibility: 'SHARED', title: 'Payer', statement: 'Who pays?' });
    await transitionCandidate({ candidateId: question.id, from: 'CAPTURED', to: 'QUEUED' });
    const need = await createNeed({
      projectId, opportunityId: id, blockedAction: 'Payer', whyItMatters: 'test', recommendedPath: 'research',
      setupEffort: 'none', nextStep: 'Name who pays.', completionCondition: 'payer answered',
      candidateId: question.id, requestKey: `question:${id}:payer`,
    });

    const first = await releaseOpportunityResearch({ opportunity: (await getOpportunity(id))!, reason: REASON });
    expect(first.released).toBe(true);
    expect(first.needsWithdrawn).toEqual([need.id]);
    expect(first.missionsCancelled).toEqual([mission.id]);
    expect(first.packetsCancelled).toEqual([divePacket]);
    expect(first.candidatesRejected.sort()).toEqual([dive.id, question.id].sort());
    expect((await getNeed(need.id))!.state).toBe('WITHDRAWN');
    expect((await getMission(mission.id))!.state).toBe('CANCELLED');
    expect((await getOrchestration(divePacket))!.status).toBe('CANCELLED');
    expect((await getOpportunity(id))!.sourceClaimId).not.toBeNull();

    const second = await releaseOpportunityResearch({ opportunity: (await getOpportunity(id))!, reason: REASON });
    expect(second.needsWithdrawn).toEqual([]);
    expect(second.missionsCancelled).toEqual([]);
    expect(second.packetsCancelled).toEqual([]);
    expect(second.candidatesRejected).toEqual([]);
  });

  it('never touches an opening somebody committed to', async () => {
    const id = await opening('https://www.example-buyer.com/rfp/b');
    const dive = await createCandidate({ projectId, visibility: 'SHARED', title: 'Qualify', statement: 'Qualify it.' });
    await transitionCandidate({ candidateId: dive.id, from: 'CAPTURED', to: 'QUEUED' });
    await updateOpportunity(id, { candidate_id: dive.id });
    await setState(id, 'EXECUTING');
    const out = await releaseOpportunityResearch({ opportunity: (await getOpportunity(id))!, reason: REASON });
    expect(out.released).toBe(false);
    expect(out.candidatesRejected).toEqual([]);
    expect((await getCandidate(dive.id))!.state).toBe('QUEUED');
  });
});
