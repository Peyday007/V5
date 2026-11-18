/**
 * R2, production runpod-report 44238718584 (04:40Z 2026-11-18), goal
 * wst_7b4fcbb5f2384f31b6c3: all 13 accepted claims in three hours "reached no
 * opening", stored 0, in_plan 0 — among them Solarize's figures, the kind of
 * quantity the goal plan lists as unknown. The constructed-round back-fill now
 * reads a claim that states no per-unit price for the one non-price figure the
 * plan reads per buyer (`account_units_per_month`, the arrangement's need
 * rate), and refuses — naming why — every figure the plan has no fact for: a
 * close or reply rate, a market's total over a period, a percentage price cut.
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
import { readNonPriceFact } from '../server/services/industry/nonPriceFacts.ts';
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
  const owner = await createUser({ email: `r2-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
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
      sourced: true, accepted: true, rejectionReason: null, contentHash: `r2:${i}:${text}`,
    })),
  );
  return rows.map((one) => one.id);
}

const SOLARIZE = {
  newToSolar: 'In Connecticut, 20% of households who signed a contract … through Solarize CT had never previously considered installing solar',
  portland: "Solarize Portland's first round achieved 120 new residential installations in just six months",
  homes: '560 homes installed',
  costCut: 'cost reductions of 20-30%',
  contractor: 'Contractor savings on marketing and lead generation drove costs down by an additional 30 to 35%',
};

describe('R2: the reader files only a figure the plan reads per buyer, as stated', () => {
  it('refuses every Solarize claim, each for what it actually states', () => {
    expect(readNonPriceFact(SOLARIZE.newToSolar)).toEqual({ refused: expect.stringMatching(/no share of buyers approached who agreed/) });
    expect(readNonPriceFact(SOLARIZE.portland)).toEqual({ refused: expect.stringMatching(/total across the market.*deals a market takes/) });
    expect(readNonPriceFact(SOLARIZE.homes)).toEqual({ refused: expect.stringMatching(/no period/) });
    // A percentage price reduction is not a close rate.
    expect(readNonPriceFact(SOLARIZE.costCut)).toEqual({ refused: expect.stringMatching(/percentage change in a price or cost, which is not a close rate/) });
    expect(readNonPriceFact(SOLARIZE.contractor)).toEqual({ refused: expect.stringMatching(/percentage change in a price or cost/) });
  });

  it('recognises a close or reply rate and refuses it, because the plan reads no fact for either', () => {
    expect(readNonPriceFact('Solarize campaigns report a close rate of 18% among homeowners who requested a site assessment.')).toEqual({ refused: expect.stringMatching(/plan reads no fact for either/) });
    expect(readNonPriceFact('About 3% of the businesses contacted replied to the cold email.')).toEqual({ refused: expect.stringMatching(/plan reads no fact for either/) });
  });

  it('files a per-buyer monthly count exactly as stated, a range as a range, and never a market total or money', () => {
    expect(readNonPriceFact('Each local service business sends 2 EDDM postcard runs per month on average.')).toMatchObject({ key: 'account_units_per_month', low: 2, high: 2 });
    expect(readNonPriceFact('A typical restaurant orders 30 to 45 deliveries a month.')).toMatchObject({ key: 'account_units_per_month', low: 30, high: 45 });
    expect(readNonPriceFact('Installers completed 40 installations per month across the program.')).toEqual({ refused: expect.stringMatching(/without saying it is one buyer/) });
    expect(readNonPriceFact('Each business spends $500 per month on flyers.')).toHaveProperty('refused');
    expect(readNonPriceFact('Each household installs 1 system every year.')).toHaveProperty('refused');
  });
});

describe('R2: on an OPEN constructed round, non-price claims reach the plan or are refused by name', () => {
  it('files the per-buyer volume against the arrangement’s buyer, OBSERVED with its claim; refuses every Solarize claim; the plan reads the volume', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const ids = await accepted(orchestrationId, fragmentId, [...Object.values(SOLARIZE), 'Each local service business sends 2 EDDM postcard runs per month on average.']);
    const volumeId = ids[ids.length - 1]!;
    const before = await planInputsFingerprint(projectId, GOAL);
    expect((await constructionObservations({ projectId, currency: 'USD', daysLeft: 30 })).volume).toEqual([]);

    const decisions = (await backfillCandidates(projectId)).decisions.filter((one) => one.source === 'CONSTRUCTED_ROUND');
    const byId = new Map(decisions.map((one) => [one.claimId, one]));
    for (const id of ids.slice(0, -1)) {
      expect(byId.get(id)?.candidate).toBeNull();
      expect(byId.get(id)?.reason).toMatch(/per unit, and it states/);
    }
    expect(byId.get(ids[3]!)?.reason).toMatch(/not a close rate/);
    expect(byId.get(volumeId)?.candidate).toMatchObject({ key: 'account_units_per_month', amount: 2, high: 2 });

    const filed = await backfillClaimFacts(projectId);
    expect(filed.filed.map((one) => one.sourceClaimId)).toEqual([volumeId]);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'account_units_per_month', segment: `map_${buyerId}`, low: 2, high: 2, status: 'OBSERVED', sourceClaimId: volumeId });

    // The plan's construction read holds it as the buyers' volume (its need rate), over the goal window, with the claim as lineage.
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 30 });
    expect(read.priced).toEqual([]);
    expect(read.volume.map((one) => one.lineage)).toEqual([[`claim:${volumeId}`]]);
    expect(read.volume[0]!.value).toEqual({ kind: 'POINT', value: 2 });
    expect(await planInputsFingerprint(projectId, GOAL)).not.toBe(before);

    // Idempotent.
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
  });

  it('files no volume from a claim that is not an observation its source reports', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    const [id] = await accepted(orchestrationId, fragmentId, ['Each local service business sends 2 EDDM postcard runs per month on average.']);
    await getDb().run(`UPDATE research_claims SET claim_type = 'INFERENCE' WHERE id = ?`, [id]);
    expect((await backfillCandidates(projectId)).decisions.find((one) => one.claimId === id)?.reason).toMatch(/not an observation/);
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
  });
});
