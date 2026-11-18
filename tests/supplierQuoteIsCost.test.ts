/** B1i: see the describe block. */
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
import { backfillCandidates, backfillClaimFacts, claimPricesSupply, rederivedMeaning } from '../server/services/industry/expand.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { readMoneyFigures } from '../server/services/cash/figures.ts';
import { constructionObservations } from '../server/services/cash/construct.ts';
import type { Layer } from '../server/domain/types.ts';

const KEY = '2821cce3c372';
const GOAL = 'wst_7b4fcbb5f2384f31b6c3';
/** mpx_a8f5f34d435f48af9a57's stored sides, as production holds them (2026-11-18). */
const SIDES = {
  demand: 'Local businesses buying a slot on a shared direct-mail postcard',
  supply: 'Commercial printers and mail houses that print and enter EDDM mailings on order',
};
const DESIGN = JSON.stringify({ version: 1, arrangement: { key: KEY, structure: 'BROKER', design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'SUBSCRIPTION' }, demand: { name: SIDES.demand }, supply: { name: SIDES.supply } } });
const OPPIZI = 'Oppizi charges $0.47 per postcard piece for a 10,000‑home EDDM run, total $4,675';
const USPS_BMEU = 'EDDM BMEU (bulk mail entry) postage price is as low as $0.259 per piece for flats up to 3.3 oz.';

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({ email: `b1i-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect 10000 dollars of settled cash.' });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
  ownerId = owner.id;
});

/** The map buyer, the arrangement the plan composed for it, and an OPEN round asking about it. */
async function openArrangementRound(): Promise<{ buyerId: string; orchestrationId: string; fragmentId: string }> {
  const sector = await seedSubject({ projectId, name: 'Local marketing', actorRef: 'BRAIN' });
  const buyer = await seedSubject({ projectId, name: 'Local service businesses', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
  await recordConstructedArrangements(projectId, GOAL, [
    {
      signature: `sig-${KEY}`, legacyKey: KEY, method: 'BROKERAGE', title: 'Local service businesses: EDDM postcard runs, brokered',
      thesis: 'Local service businesses pay', constructionOrigin: 'FORWARD', opportunityId: null, industryNodeId: buyer.node.id,
      precedentOpportunityId: null, inputsDigest: 'd1', designJson: DESIGN, positionJson: null, positionKey: null,
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
      sourced: true, accepted: true, rejectionReason: null, contentHash: `b1i:${i}:${text}`,
    })),
  );
  return rows.map((one) => one.id);
}


/**
 * B1i, production 2026-11-18: the round on arrangement 2821cce3c372 (slots on
 * a shared EDDM postcard, sold to local businesses, run bought from printers
 * and mail houses) returned only what the SUPPLY charges — Oppizi's all-in
 * $4,675 per 10,000-home run and USPS EDDM postage — and every one was filed
 * as `price_per_unit`, what a slot buyer pays (#1085: $4,675 per slot).
 */
describe('B1i: a supplier quote on a constructed round is the arrangement’s cost, never its buyers’ price', () => {
  it('reads the money figures as stated, refusing a sub-cent figure rather than reading $0.259 as $259', () => {
    expect(readMoneyFigures(USPS_BMEU, 'USD')).toEqual([]);
    expect(readMoneyFigures(OPPIZI, 'USD').map((one) => one.cents)).toEqual([47, 467500]);
    expect(readMoneyFigures('A run costs $1.250 thousand', 'USD')).toEqual([]);
    expect(readMoneyFigures('total $4.675', 'USD').map((one) => one.cents)).toEqual([467500]);
  });

  it('classifies the production claims by the arrangement’s own sides', () => {
    expect(claimPricesSupply(OPPIZI, SIDES)).toBe(true);
    expect(claimPricesSupply('USPS lists EDDM Retail flats price at $0.26 per piece on its postage prices page.', SIDES)).toBe(true);
    expect(claimPricesSupply('Valpak advertisers pay $395 for a slot on a shared direct-mail postcard.', SIDES)).toBe(false);
    expect(claimPricesSupply(OPPIZI, { demand: SIDES.demand, supply: null })).toBe(false);
    expect(claimPricesSupply(OPPIZI, undefined)).toBe(false);
  });

  it('files Oppizi as contractor_rate_per_unit 4675 and no buyer price, so the plan reads a cost and no value', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const [oppizi, usps] = await accepted(orchestrationId, fragmentId, [OPPIZI, 'USPS lists EDDM Retail flats price at $0.26 per piece on its postage prices page.']);
    const pool = (await backfillCandidates(projectId)).decisions.filter((one) => one.source === 'CONSTRUCTED_ROUND');
    expect(pool.find((one) => one.claimId === oppizi)?.candidate).toMatchObject({ key: 'contractor_rate_per_unit', amount: 4675 });
    expect(pool.find((one) => one.claimId === usps)?.candidate).toMatchObject({ key: 'contractor_rate_per_unit', amount: 0.26 });
    await backfillClaimFacts(projectId);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts.map((one) => [one.sourceClaimId, one.key, one.low]).sort()).toEqual([[oppizi, 'contractor_rate_per_unit', 4675], [usps, 'contractor_rate_per_unit', 0.26]].sort());
    expect(facts.every((one) => one.segment === `map_${buyerId}`)).toBe(true);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced).toEqual([]);
    expect(read.unitCost.map((one) => one.value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ kind: 'POINT', value: 0.26 }, { kind: 'POINT', value: 4675 }]);
  });

  it('supersedes the production facts: $0.47 and $4,675 prices become a $4,675 cost, and a $259 misreading is withdrawn', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const [oppizi, bmeu] = (await accepted(orchestrationId, fragmentId, [OPPIZI, USPS_BMEU])) as [string, string];
    const file = (claimId: string, amount: number) =>
      recordClaimFact({
        projectId, nodeId: buyerId, claimId, key: 'price_per_unit', segment: `map_${buyerId}`, low: amount, high: amount, status: 'OBSERVED',
        measures: 'what these buyers are published paying per unit', sourceTitle: 'EDDM', sourceUrl: 'https://eddm.com/', sourceKind: 'SECONDARY', observedAt: '2026-01-01T00:00:00.000Z',
      });
    const wrongPrice = (await file(oppizi, 4675))!;
    const misread = (await file(bmeu, 259))!;
    expect((await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 })).priced.map((one) => one.value)).toHaveLength(2);

    const pass = await backfillClaimFacts(projectId);
    expect(pass.refiled.map((one) => [one.supersedesFactId, one.key, one.low, one.status]).sort()).toEqual(
      [[wrongPrice.id, 'contractor_rate_per_unit', 4675, 'OBSERVED'], [misread.id, 'price_per_unit', 259, 'ASSUMPTION']].sort(),
    );
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced).toEqual([]);
    expect(read.unitCost.map((one) => one.value)).toEqual([{ kind: 'POINT', value: 4675 }]);
    // Idempotent: nothing is superseded twice, and a withdrawn fact is not withdrawn again.
    expect((await backfillClaimFacts(projectId)).refiled).toEqual([]);
    expect(rederivedMeaning({ key: 'price_per_unit', low: 0.47, high: 0.47 }, OPPIZI, SIDES)).toMatchObject({ key: 'contractor_rate_per_unit', amount: 4675 });
    expect(rederivedMeaning({ key: 'price_per_unit', low: 259, high: 259, status: 'ASSUMPTION' }, USPS_BMEU, SIDES)).toBeNull();
  });
});
