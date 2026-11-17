/**
 * B1c, production 08cba93f (2026-11-17), goal wst_7b4fcbb5f2384f31b6c3:
 * `TRACE claims 7 stored 0 in_plan 0`. A constructed-arrangement round
 * (goal-…-mx-2821cce3c372 r1) still OPEN hours later held accepted claims such
 * as "Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run",
 * with no opportunity_signal and no UNIT_ECONOMIC declaration, so neither the
 * harvest nor the construction back-fill read them, and the plan never did.
 *
 * The back-fill's third source files a per-unit price from such a claim as a
 * construction fact against the arrangement's own buyer type, without waiting
 * for the round to settle, and the plan's construction read
 * (`constructionObservations`) then holds it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { listProjectConstructionFacts } from '../server/repos/construction.ts';
import { recordConstructedArrangements } from '../server/repos/monetization.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { backfillCandidates, backfillClaimFacts } from '../server/services/industry/expand.ts';
import { constructionObservations } from '../server/services/cash/construct.ts';
import { planInputsFingerprint } from '../server/services/goals/plan.ts';
import type { Layer } from '../server/domain/types.ts';

const KEY = '2821cce3c372';
const GOAL = 'wst_7b4fcbb5f2384f31b6c3';

let projectId = '';
let layer: Layer;
let modeId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({ email: `b1c-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect 10000 dollars of settled cash.' });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
});

/** The map buyer, the arrangement the plan composed for it, and an OPEN round asking about it. */
async function openArrangementRound(): Promise<{ buyerId: string; orchestrationId: string; fragmentId: string }> {
  const sector = await seedSubject({ projectId, name: 'Local marketing', actorRef: 'BRAIN' });
  const buyer = await seedSubject({ projectId, name: 'Local service businesses', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
  await recordConstructedArrangements(projectId, GOAL, [
    {
      signature: `sig-${KEY}`, legacyKey: KEY, method: 'BROKERAGE', title: 'Local service businesses: EDDM postcard runs, brokered',
      thesis: 'Local service businesses pay', constructionOrigin: 'FORWARD', opportunityId: null, industryNodeId: buyer.node.id,
      precedentOpportunityId: null, inputsDigest: 'd1', designJson: '{}', positionJson: null, positionKey: null,
    },
  ]);
  const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: 'Confirm or refute', statement: 'Brain composed an arrangement nobody has published; confirm or refute it.' });
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'OPEN', ?, 0, ?, ?)`,
    [`cdr_${KEY}`, projectId, modeId, `goal-${GOAL}-mx-${KEY}`, 'GOAL_MECHANISM', candidate.id, at, at, at],
  );
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'mx' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Confirm or refute', assignment: 'mx', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'goal-mechanism',
      question: 'Do such buyers pay for this, and at what price?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: [], acceptableSourceTypes: ['a published price list'], excludedSourceTypes: [], completionCriteria: ['A price.'],
      dependsOn: [], minIndependentSources: 1, status: 'RUNNING',
    },
  ]);
  const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'mx', whyNow: 'test', idempotencyKey: `mx:${KEY}`, candidateId: candidate.id });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  return { buyerId: buyer.node.id, orchestrationId: orchestration.id, fragmentId: fragment!.id };
}

async function accepted(orchestrationId: string, fragmentId: string, texts: string[]): Promise<string[]> {
  const rows = await insertClaims(
    texts.map((text, i) => ({
      orchestrationId, fragmentId, passId: null, passKey: 'TARGETED' as const,
      claim: text, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/eddm-${i}`, sourceTitle: 'EDDM pricing',
      sourcePublisher: 'A printer', sourceDate: '2026-11-01', evidenceExcerpt: text, evidenceLocator: 'pricing', evidenceLane: 'economics',
      retrievedAt: '2026-11-17T20:40:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `b1c:${i}:${text}`,
    })),
  );
  return rows.map((one) => one.id);
}

describe('B1c: a priced claim on an OPEN constructed round reaches the plan', () => {
  it('files the per-unit price against the arrangement’s buyer and the plan reads it, with the round still OPEN', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const [priced, unpriced] = await accepted(orchestrationId, fragmentId, [
      'Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total $4,675.',
      'There are no mailing-list or setup fees.',
    ]);
    const before = await planInputsFingerprint(projectId, GOAL);
    expect((await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 })).priced).toEqual([]);

    // The census's dry run reports the same selection the writer files.
    const pool = await backfillCandidates(projectId);
    const mine = pool.decisions.filter((one) => one.source === 'CONSTRUCTED_ROUND');
    expect(mine.find((one) => one.claimId === priced)?.candidate?.amount).toBe(0.47);
    expect(mine.find((one) => one.claimId === unpriced)?.reason).toMatch(/per unit/);

    const filed = await backfillClaimFacts(projectId);
    expect(filed.filed.map((one) => one.sourceClaimId)).toEqual([priced]);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'price_per_unit', segment: `map_${buyerId}`, low: 0.47, high: 0.47, status: 'OBSERVED', sourceClaimId: priced });

    // The round never settled.
    expect((await getDb().get<{ state: string }>('SELECT state FROM cash_discovery_rounds WHERE id = ?', [`cdr_${KEY}`]))?.state).toBe('OPEN');
    // The plan's construction read holds it, and the plan's fingerprint moved, so the next pass re-derives.
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced.map((one) => one.lineage)).toEqual([[`claim:${priced}`]]);
    expect(read.priced[0]!.value).toEqual({ kind: 'POINT', value: 0.47 });
    expect(await planInputsFingerprint(projectId, GOAL)).not.toBe(before);

    // Idempotent: a replay files nothing twice.
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
    expect(await listProjectConstructionFacts(projectId)).toHaveLength(1);
  });

  it('files nothing for a round whose arrangement names no map buyer type', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    await getDb().run('UPDATE monetization_paths SET industry_node_id = NULL WHERE project_id = ?', [projectId]);
    await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece.']);
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
    expect(await listProjectConstructionFacts(projectId)).toEqual([]);
  });
});
