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
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { createCandidate, getCandidate, transitionCandidate } from '../server/repos/russellCandidates.ts';
import { getMission, launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createBin, getBin } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import {
  LISTING_ARCHIVE_REASON,
  LISTINGS_RETIRED_EVENT,
  retireMarketplaceListings,
} from '../server/services/cash/retireListings.ts';
import { retireUnjudgeableBins } from '../server/services/bins/retireUnjudgeable.ts';
import type { BinManifest, CompletionContract, Layer } from '../server/domain/types.ts';

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

describe('retiring freelance-marketplace listings', () => {
  it('archives an uncommitted listing and stops its research, once', async () => {
    const listing = await opening('https://www.upwork.com/jobs/~01abc');

    // A running deep dive: a candidate, its mission and its packet.
    const dive = await createCandidate({ projectId, visibility: 'SHARED', title: 'Qualify', statement: 'Qualify the listing.' });
    await transitionCandidate({ candidateId: dive.id, from: 'CAPTURED', to: 'QUEUED' });
    const divePacket = await packet('dive');
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'Qualify the listing.',
      whyNow: 'test',
      idempotencyKey: `dive-${dive.id}`,
      candidateId: dive.id,
    });
    await linkMission({ missionId: mission.id, orchestrationId: divePacket });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    await updateOpportunity(listing, { candidate_id: dive.id, validation_orchestration_id: divePacket, validation_state: 'RUNNING' });

    // An open field question whose idea has not launched yet.
    const question = await createCandidate({ projectId, visibility: 'SHARED', title: 'Payer', statement: 'Who pays?' });
    await transitionCandidate({ candidateId: question.id, from: 'CAPTURED', to: 'QUEUED' });
    const need = await createNeed({
      projectId,
      opportunityId: listing,
      blockedAction: 'Payer for the listing',
      whyItMatters: 'test',
      recommendedPath: 'research',
      setupEffort: 'none',
      nextStep: 'Name who pays.',
      completionCondition: 'payer answered',
      candidateId: question.id,
      requestKey: `question:${listing}:payer`,
    });

    // Neighbours this pass must leave alone.
    const committed = await opening('https://www.fiverr.com/requests/123');
    await setState(committed, 'EXECUTING');
    const personArchived = await opening('https://www.guru.com/jobs/456');
    await setState(personArchived, 'ARCHIVED', 'A person put this away.');
    const ownSite = await opening('https://www.example-buyer.com/rfp/web-services');

    const first = await retireMarketplaceListings(projectId);
    expect(first.archived).toEqual([listing]);
    expect(first.needsWithdrawn).toEqual([need.id]);
    expect(first.candidatesRejected.sort()).toEqual([dive.id, question.id].sort());
    expect(first.missionsCancelled).toEqual([mission.id]);
    expect(first.packetsCancelled).toEqual([divePacket]);

    const after = (await getOpportunity(listing))!;
    expect(after.state).toBe('ARCHIVED');
    expect(after.archivedReason).toBe(LISTING_ARCHIVE_REASON);
    expect(after.sourceClaimId).not.toBeNull();
    expect((await getNeed(need.id))!.state).toBe('WITHDRAWN');
    expect((await getCandidate(question.id))!.state).toBe('REJECTED');
    expect((await getMission(mission.id))!.state).toBe('CANCELLED');
    expect((await getOrchestration(divePacket))!.status).toBe('CANCELLED');

    expect((await getOpportunity(committed))!.state).toBe('EXECUTING');
    expect((await getOpportunity(personArchived))!.archivedReason).toBe('A person put this away.');
    expect((await getOpportunity(ownSite))!.state).toBe('DISCOVERED');

    const events = await cashEventsOfKindInProject(projectId, LISTINGS_RETIRED_EVENT);
    expect(events).toHaveLength(1);

    // A second tick finds nothing to do and records nothing.
    const second = await retireMarketplaceListings(projectId);
    expect(second).toEqual({ archived: [], needsWithdrawn: [], candidatesRejected: [], missionsCancelled: [], packetsCancelled: [] });
    expect(await cashEventsOfKindInProject(projectId, LISTINGS_RETIRED_EVENT)).toHaveLength(1);
  });
});

describe('retiring bins whose contract has no evaluator', () => {
  it('retires a live bin under a removed contract and leaves a registered one alone', async () => {
    const base = {
      projectId,
      kind: 'TEST',
      title: 'A bin',
      objective: 'Something to do.',
      manifest: { objective: 'Something to do.', units: [] } as unknown as BinManifest,
      createdByType: 'SYSTEM',
      ready: true,
    };
    const gone = await createBin({ ...base, completionContract: 'REMOVED_CONTRACT_V1' as CompletionContract });
    const kept = await createBin({ ...base, completionContract: 'RESEARCH_PACKET_V1' });

    expect(await retireUnjudgeableBins()).toEqual([gone.id]);
    expect((await getBin(gone.id))!.state).toBe('CANCELLED');
    expect((await getBin(kept.id))!.state).toBe('READY');
    expect(await retireUnjudgeableBins()).toEqual([]);
  });
});
