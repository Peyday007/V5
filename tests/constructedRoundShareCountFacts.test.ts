/**
 * R3, goal wst_7b4fcbb5f2384f31b6c3 (2026-11-18): every constructed
 * arrangement read its close rate, its reply rate and "deals the market can
 * take" as UNKNOWN. The plan read three construction facts for a constructed
 * arrangement (price, supply cost, monthly volume); `demand.conversion` and
 * `demand.buyers` were always unknown, though `account_win_rate` and
 * `accounts_reachable` are construction facts the industry engine already
 * reads. Now `constructionObservations` reads both for a map buyer, `compose`
 * puts them on the demand side, the arrangement carries its conversion, and the
 * goal model's close rate for it is that evidence. The constructed-round
 * back-fill files both only from unambiguous wording, and refuses the rest.
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
import { listProjectConstructionFacts, recordClaimFact } from '../server/repos/construction.ts';
import { recordConstructedArrangements } from '../server/repos/monetization.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { backfillCandidates, backfillClaimFacts } from '../server/services/industry/expand.ts';
import { readShareOrCount } from '../server/services/industry/shareCountFacts.ts';
import { clearConstructionMemo, constructArrangements, constructionObservations, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import { selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { planInputsFingerprint } from '../server/services/goals/plan.ts';
import type { Layer } from '../server/domain/types.ts';

const KEY = '2821cce3c372';
const GOAL = 'wst_7b4fcbb5f2384f31b6c3';

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({ email: `r3-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect 10000 dollars of settled cash.' });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
  ownerId = owner.id;
  clearConstructionMemo();
});

const SOLARIZE = {
  newToSolar: 'In Connecticut, 20% of households who signed a contract … through Solarize CT had never previously considered installing solar',
  portland: "Solarize Portland's first round achieved 120 new residential installations in just six months",
  homes: '560 homes installed',
  costCut: 'cost reductions of 20-30%',
  contractor: 'Contractor savings on marketing and lead generation drove costs down by an additional 30 to 35%',
};

describe('R3: the reader files a close rate or a buyer count only from unambiguous wording', () => {
  it('refuses every Solarize claim, each for what it actually states', () => {
    for (const buyer of ['Homeowners', 'Households', 'Local service businesses']) {
      expect(readShareOrCount(SOLARIZE.newToSolar, buyer)).toEqual({ refused: expect.stringMatching(/already bought, not of buyers approached: not a close rate/) });
      expect(readShareOrCount(SOLARIZE.portland, buyer)).toEqual({ refused: expect.stringMatching(/counts "new residential installations", not buyers of this type in a market/) });
      expect(readShareOrCount(SOLARIZE.homes, buyer)).toEqual({ refused: expect.stringMatching(/not buyers of this type in a market/) });
      expect(readShareOrCount(SOLARIZE.costCut, buyer)).toEqual({ refused: expect.stringMatching(/percentage change in a price or cost, which is no share of buyers and not a close rate/) });
      expect(readShareOrCount(SOLARIZE.contractor, buyer)).toEqual({ refused: expect.stringMatching(/percentage change in a price or cost/) });
    }
  });

  it('files a stated share of buyers approached who bought, and a stated close rate, as a share of one', () => {
    expect(readShareOrCount('18% of the businesses contacted signed a contract.', 'Local service businesses')).toMatchObject({ key: 'account_win_rate', low: 0.18, high: 0.18 });
    expect(readShareOrCount('12 percent of those approached bought a run.', 'Local service businesses')).toMatchObject({ key: 'account_win_rate', low: 0.12, high: 0.12 });
    expect(readShareOrCount('Solarize campaigns report a close rate of 18% among homeowners who requested a site assessment.', 'Homeowners')).toMatchObject({ key: 'account_win_rate', low: 0.18 });
    expect(readShareOrCount('Brokers report a 10-15% close rate on EDDM pitches.', 'Local service businesses')).toMatchObject({ key: 'account_win_rate', low: 0.1, high: 0.15 });
  });

  it('refuses a reply rate, two percentages, a bare conversion rate and a share of signers', () => {
    expect(readShareOrCount('About 3% of the businesses contacted replied to the cold email.', 'Local service businesses')).toEqual({ refused: expect.stringMatching(/reply or response rate/) });
    expect(readShareOrCount('A 20% close rate and a 5% reply rate were reported.', 'Local service businesses')).toEqual({ refused: expect.stringMatching(/more than one percentage/) });
    expect(readShareOrCount('The site conversion rate is 2%.', 'Local service businesses')).toEqual({ refused: expect.stringMatching(/conversion rate without saying it is of buyers approached/) });
    expect(readShareOrCount('Customers saw a 30% increase in calls.', 'Local service businesses')).toHaveProperty('refused');
  });

  it('files a count of buyers of the round’s own type in a named market, and refuses a flow, a bound, no market, or another thing counted', () => {
    expect(readShareOrCount('There are 3,400 dental practices in Texas.', 'Dental practices')).toMatchObject({ key: 'accounts_reachable', low: 3400, high: 3400 });
    expect(readShareOrCount('In Texas, there are about 3,400 dental practices.', 'Dental practice')).toMatchObject({ key: 'accounts_reachable', low: 3400 });
    expect(readShareOrCount('Michigan has 41,000 local service businesses.', 'Local service businesses')).toMatchObject({ key: 'accounts_reachable', low: 41000 });
    expect(readShareOrCount('500 new households signed up in Portland.', 'Households')).toEqual({ refused: expect.stringMatching(/counts buyers who acted/) });
    expect(readShareOrCount('Over 3,000 businesses operate in Detroit.', 'Local service businesses')).toEqual({ refused: expect.stringMatching(/a bound/) });
    expect(readShareOrCount('3,400 dental practices responded to the survey.', 'Dental practices')).toHaveProperty('refused');
    expect(readShareOrCount('Dentists opened 120 dental practices in 2024.', 'Dental practices')).toHaveProperty('refused');
    expect(readShareOrCount('Solar installs in the US reached 4,000,000 homes in 2023.', 'Homeowners')).toHaveProperty('refused');
    // A per-buyer monthly volume and a price are other readers' business.
    expect(readShareOrCount('Each local service business sends 2 EDDM postcard runs per month on average.', 'Local service businesses')).toBeNull();
    expect(readShareOrCount('Oppizi charges $0.47 per postcard piece.', 'Local service businesses')).toBeNull();
  });
});

async function fact(nodeId: string, claimId: string, key: 'price_per_unit' | 'account_win_rate' | 'accounts_reachable', low: number, high = low): Promise<void> {
  await recordClaimFact({
    projectId, nodeId, claimId, key, segment: `map_${nodeId}`, low, high, status: 'OBSERVED',
    measures: `${key} for dental practices`, sourceTitle: 'Published source', sourceUrl: `https://example.org/${claimId}`,
    sourceKind: 'PRIMARY', observedAt: '2026-11-01T00:00:00.000Z',
  });
}

const own = (all: ConstructedArrangement[], ref: string) => all.filter((one) => one.origin !== 'REVERSE' && one.demand.ref === ref);

describe('R3: a filed close rate and buyer count reach the arrangement and the goal model', () => {
  it('a filed win rate becomes the arrangement’s conversion, moves its composition and inputs digest, and is the goal model’s close rate', async () => {
    const sector = await seedSubject({ projectId, name: 'Dentistry', actorRef: ownerId });
    const practices = await seedSubject({ projectId, name: 'Dental practices', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: ownerId });
    await fact(practices.node.id, 'clm_price_a', 'price_per_unit', 180);
    await fact(practices.node.id, 'clm_price_b', 'price_per_unit', 260);
    const input = { projectId, currency: 'USD', delivers: ['compliance reports'], capitalCeilingCents: null, daysLeft: 30 };

    const before = own(await constructArrangements(input), practices.node.id);
    expect(before.length).toBeGreaterThan(0);
    for (const one of before) {
      expect(one.conversion).toBeUndefined();
    }
    const fingerprintBefore = await planInputsFingerprint(projectId, GOAL);

    await fact(practices.node.id, 'clm_win_a', 'account_win_rate', 0.12);
    await fact(practices.node.id, 'clm_win_b', 'account_win_rate', 0.18);
    await fact(practices.node.id, 'clm_count', 'accounts_reachable', 3400);
    expect(await planInputsFingerprint(projectId, GOAL)).not.toBe(fingerprintBefore);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 30 });
    expect(read.conversion.map((one) => one.lineage[0]).sort()).toEqual(['claim:clm_win_a', 'claim:clm_win_b']);
    expect(read.buyers.map((one) => one.value)).toEqual([{ kind: 'POINT', value: 3400 }]);

    clearConstructionMemo();
    const after = own(await constructArrangements(input), practices.node.id);
    expect(after.length).toBe(before.length);
    const priorDigest = new Map(before.map((one) => [one.key, one.inputsDigest]));
    for (const one of after) {
      // Reconstructed from these buyers' own filed rates, with the claims as provenance. Published
      // rates with no stated sample locate it but justify no distribution (quant/pool.ts), so the
      // part is still for research to size — never a precision nobody measured.
      expect(one.conversion?.sources).toEqual(['claim:clm_win_a', 'claim:clm_win_b']);
      expect(one.conversion!.p50).toBeGreaterThan(0.12);
      expect(one.conversion!.p50).toBeLessThan(0.18);
      expect(one.conversion!.evidence).toBeUndefined();
      // New evidence about these buyers reopens a refutation.
      expect(one.inputsDigest).not.toBe(priorDigest.get(one.key));
    }

    const got = selectEstimatedArrangements(after, { projectId, currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [], daysLeft: 30, otherPrices: [] });
    expect(got.openings.length).toBeGreaterThan(0);
    for (const one of got.openings) {
      // No longer the blind 2–50% sweep: the filed rates' own reconstructed range, as bounds.
      expect(one.close.note).not.toMatch(/no buyer has been asked yet/);
      expect(one.close.note).toMatch(/close rate filed for these buyers.*claim:clm_win_a, claim:clm_win_b.*without a sample/);
      expect(one.close.provenance).toBe('ASSUMPTION');
      expect(one.close.inferred?.justified).toBe(false);
      expect(one.close.low).toBeGreaterThan(0);
      expect(one.close.high).toBeLessThan(1);
      expect(one.close.low).toBeLessThan(0.12);
      expect(one.close.high).toBeGreaterThan(0.18);
    }
    // Without a filed rate the same arrangements are the blind sweep.
    const blind = selectEstimatedArrangements(before, { projectId, currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [], daysLeft: 30, otherPrices: [] });
    for (const one of blind.openings) expect(one.close.note).toMatch(/no buyer has been asked yet/);
  });
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
      question: 'Do such buyers pay for this, and how many agree?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: [], acceptableSourceTypes: ['a published case'], excludedSourceTypes: [], completionCriteria: ['A rate.'],
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
      claim: text, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/r3-${i}`, sourceTitle: 'Case study',
      sourcePublisher: 'A publisher', sourceDate: '2026-11-01', evidenceExcerpt: text, evidenceLocator: 'results', evidenceLane: 'economics',
      retrievedAt: '2026-11-17T20:40:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `r3:${i}:${text}`,
    })),
  );
  return rows.map((one) => one.id);
}

describe('R3: on an OPEN constructed round, a close rate and a buyer count are filed; the Solarize claims stay refused', () => {
  it('files both against the arrangement’s buyer as OBSERVED, refuses every Solarize claim with why, and the plan reads them', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const win = '18% of the local service businesses contacted signed a contract for a postcard run.';
    const count = 'There are 41,000 local service businesses in Michigan.';
    const ids = await accepted(orchestrationId, fragmentId, [...Object.values(SOLARIZE), win, count]);
    const [winId, countId] = ids.slice(-2) as [string, string];
    const fingerprint = await planInputsFingerprint(projectId, GOAL);

    const decisions = (await backfillCandidates(projectId)).decisions.filter((one) => one.source === 'CONSTRUCTED_ROUND');
    const byId = new Map(decisions.map((one) => [one.claimId, one]));
    for (const id of ids.slice(0, -2)) {
      expect(byId.get(id)?.candidate, id).toBeNull();
      expect(byId.get(id)?.reason).toBeTruthy();
    }
    expect(byId.get(ids[0]!)?.reason).toMatch(/not a close rate/);
    expect(byId.get(ids[1]!)?.reason).toMatch(/not buyers of this type in a market/);
    expect(byId.get(ids[3]!)?.reason).toMatch(/percentage change in a price or cost/);
    expect(byId.get(winId)?.candidate).toMatchObject({ key: 'account_win_rate', amount: 0.18, high: 0.18 });
    expect(byId.get(countId)?.candidate).toMatchObject({ key: 'accounts_reachable', amount: 41000 });

    const filed = await backfillClaimFacts(projectId);
    expect(filed.filed.map((one) => one.sourceClaimId).sort()).toEqual([winId, countId].sort());
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts.map((one) => [one.key, one.segment, one.low, one.high, one.status]).sort()).toEqual(
      [
        ['account_win_rate', `map_${buyerId}`, 0.18, 0.18, 'OBSERVED'],
        ['accounts_reachable', `map_${buyerId}`, 41000, 41000, 'OBSERVED'],
      ].sort(),
    );
    expect(await planInputsFingerprint(projectId, GOAL)).not.toBe(fingerprint);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 30 });
    expect(read.conversion.map((one) => one.lineage)).toEqual([[`claim:${winId}`]]);
    expect(read.buyers.map((one) => one.lineage)).toEqual([[`claim:${countId}`]]);
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
  });

  it('files no close rate from a claim that is not an observation its source reports', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    const [id] = await accepted(orchestrationId, fragmentId, ['18% of the local service businesses contacted signed a contract.']);
    await getDb().run(`UPDATE research_claims SET claim_type = 'INFERENCE' WHERE id = ?`, [id]);
    expect((await backfillCandidates(projectId)).decisions.find((one) => one.claimId === id)?.reason).toMatch(/not an observation/);
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
  });
});
