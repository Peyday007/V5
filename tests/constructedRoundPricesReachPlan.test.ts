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
import { backfillCandidates, backfillClaimFacts, backfillConstructedShare } from '../server/services/industry/expand.ts';
import { unfiledConstructedRoundClaims } from '../server/repos/research.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { constructionObservations } from '../server/services/cash/construct.ts';
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
  const owner = await createUser({ email: `b1c-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
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
    // B1f: the claim's stated total is one deal; $0.47 is one postcard piece, not a transaction the plan can count.
    expect(mine.find((one) => one.claimId === priced)?.candidate?.amount).toBe(4675);
    expect(mine.find((one) => one.claimId === unpriced)?.reason).toMatch(/per unit/);

    const filed = await backfillClaimFacts(projectId);
    expect(filed.filed.map((one) => one.sourceClaimId)).toEqual([priced]);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'price_per_unit', segment: `map_${buyerId}`, low: 4675, high: 4675, status: 'OBSERVED', sourceClaimId: priced });

    // The round never settled.
    expect((await getDb().get<{ state: string }>('SELECT state FROM cash_discovery_rounds WHERE id = ?', [`cdr_${KEY}`]))?.state).toBe('OPEN');
    // The plan's construction read holds it, and the plan's fingerprint moved, so the next pass re-derives.
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced.map((one) => one.lineage)).toEqual([[`claim:${priced}`]]);
    expect(read.priced[0]!.value).toEqual({ kind: 'POINT', value: 4675 });
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


/**
 * B1g, production 2026-11-18, project prj_22fb4fec295f403a8a22: of 200
 * constructed-round claims, 185 were refused "round's arrangement names no
 * live map buyer type" — `industry_node_id` is set only when the demand came
 * from the map (297 of 1,316 arrangements). The plan reads a `map_<node>` fact
 * for any arrangement whose demand name is that node's population, so that is
 * the buyer a claim is filed against.
 */
describe('B1g: a constructed round files against the buyer the plan reads, from its own share and cursor', () => {
  /** Drop the map column and give the arrangement a demand from somewhere else. */
  async function unmapped(design: unknown, opportunityId: string | null = null): Promise<void> {
    await getDb().run('UPDATE monetization_paths SET industry_node_id = NULL, opportunity_id = ?, design_json = ? WHERE project_id = ?', [opportunityId, JSON.stringify(design), projectId]);
  }

  it('(a) files an opening-demand arrangement’s price against the map buyer type the plan matches by population, and the plan reads it for that demand', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    // The demand came from an opening: its payer, singular, is the map node "Local service businesses" by the plan's own key.
    await unmapped({ version: 1, arrangement: { demand: { name: 'Local service business', from: 'OPENING', ref: 'cop_x' } } });
    const [priced] = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run.']);
    const pool = await backfillCandidates(projectId);
    const decision = pool.decisions.find((one) => one.claimId === priced)!;
    expect(decision.reason).toBeNull();
    expect(decision.candidate?.buyer?.id).toBe(buyerId);
    expect((await backfillClaimFacts(projectId)).filed.map((one) => one.segment)).toEqual([`map_${buyerId}`]);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced.map((one) => one.lineage)).toEqual([[`claim:${priced}`]]);
  });

  it('(a) reads the demand from the arrangement’s opening when its stored design names none', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const opening = await createOpportunity({
      projectId, cashModeId: modeId, ownerUserId: ownerId, title: 'EDDM for local service businesses', mechanism: 'PRODUCTIZED_SERVICE',
      currency: 'USD', sourceClaimId: null, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A printer', requiredCapabilities: [],
    } as Parameters<typeof createOpportunity>[0]);
    await getDb().run('UPDATE cash_opportunities SET payer = ? WHERE id = ?', ['The local service businesses', opening.id]);
    await unmapped({}, opening.id);
    const [priced] = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece.']);
    const pool = await backfillCandidates(projectId);
    expect(pool.decisions.find((one) => one.claimId === priced)?.candidate?.buyer?.id).toBe(buyerId);
  });

  it('(a) maps a population the map does not hold yet (mapAskedPopulation) and files against it, so the plan reads it for that demand (P1 break point 6)', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    await unmapped({ version: 1, arrangement: { demand: { name: 'Regional dental chains', from: 'REVERSE', ref: 'x' } } });
    const [priced] = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total $4,675.']);
    // The dry run reports the population to map, and maps nothing.
    const decision = (await backfillCandidates(projectId)).decisions.find((one) => one.claimId === priced)!;
    expect(decision.reason).toBeNull();
    expect(decision.candidate?.buyer).toBeNull();
    expect(decision.candidate?.askedPopulation?.name).toBe('Regional dental chains');
    expect((await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM industry_nodes WHERE project_id = ? AND name = 'Regional dental chains'", [projectId]))!.n).toBe(0);
    // The writer maps it, established by the claim, and files against it.
    const filed = await backfillClaimFacts(projectId);
    const node = await getDb().get<{ id: string; kind: string; source_claim_id: string }>("SELECT id, kind, source_claim_id FROM industry_nodes WHERE project_id = ? AND name = 'Regional dental chains'", [projectId]);
    expect(node).toMatchObject({ kind: 'BUYER_TYPE', source_claim_id: priced });
    expect(filed.filed.map((one) => one.segment)).toEqual([`map_${node!.id}`]);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced.map((one) => one.lineage)).toContainEqual([`claim:${priced}`]);
  });

  it('(a) refuses, naming it, a demand that is no buyer population — and invents none', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    await unmapped({ version: 1, arrangement: { demand: { name: 'therefore an unidentified individual', from: 'REVERSE', ref: 'x' } } });
    const [priced] = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece.']);
    const decision = (await backfillCandidates(projectId)).decisions.find((one) => one.claimId === priced)!;
    expect(decision.candidate).toBeNull();
    expect(decision.reason).toMatch(/plan reads no fact/);
    expect(decision.unmatchedBuyer).toBe('therefore an unidentified individual');
    const nodesBefore = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM industry_nodes WHERE project_id = ?', [projectId]))!.n;
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
    expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM industry_nodes WHERE project_id = ?', [projectId]))!.n).toBe(nodesBefore);
  });

  it('(a) says a pathway round names no arrangement', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    await getDb().run('UPDATE cash_discovery_rounds SET bucket_id = ? WHERE id = ?', [`goal-${GOAL}-mx-pwabcdef0123`, `cdr_${KEY}`]);
    const [priced] = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece.']);
    expect((await backfillCandidates(projectId)).decisions.find((one) => one.claimId === priced)?.reason).toMatch(/pathway construction/);
  });

  it('(b) sources 1 and 2 cannot starve source 3: it keeps its own share of the batch', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    // Four declared unit economics, each fileable by source 1, and one constructed-round price.
    const declared = await accepted(orchestrationId, fragmentId, [1, 2, 3, 4].map((n) => `Local service businesses pay $${n}.00 per flyer delivered (declared ${n}).`));
    for (const [i, id] of declared.entries()) {
      await getDb().run(
        `UPDATE research_claims SET structural_finding = 'UNIT_ECONOMIC', structural_subject = 'price_per_unit', structural_qualifier = 'Local service businesses', structural_amount_cents = ? WHERE id = ?`,
        [(i + 1) * 100, id],
      );
    }
    const [roundPrice] = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece (round).']);
    expect(backfillConstructedShare(2)).toBe(1);
    const filed = await backfillClaimFacts(projectId, 2);
    expect(filed.filed).toHaveLength(2);
    expect(filed.filed.map((one) => one.sourceClaimId)).toContain(roundPrice);
    expect(filed.filed.every((one) => one.segment === `map_${buyerId}`)).toBe(true);
  });

  it('(c) the dry run reads source 3 from its own cursor, never source 1’s', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    const [priced] = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece.']);
    // A source-1 cursor past every claim does not hide source 3's claims.
    const past = await backfillCandidates(projectId, { unitEconomic: '~' });
    expect(past.decisions.filter((one) => one.source === 'CONSTRUCTED_ROUND').map((one) => one.claimId)).toEqual([priced]);
    // Source 3's own cursor does.
    const after = await backfillCandidates(projectId, { constructed: '~' });
    expect(after.decisions.filter((one) => one.source === 'CONSTRUCTED_ROUND')).toEqual([]);
  });

  it('(d) LIMIT counts distinct claims: an orchestration linked to two rounds does not halve the scan', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    // A second round (a pathway round) whose mission is linked to the same orchestration.
    const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: 'Pathway', statement: 'Brain constructed a transaction; confirm or refute it.' });
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, found, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'OPEN', ?, 0, ?, ?)`,
      ['cdr_pw', projectId, modeId, `goal-${GOAL}-mx-pwabcdef0123`, 'GOAL_MECHANISM', candidate.id, at, at, at],
    );
    const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'pw', whyNow: 'test', idempotencyKey: 'pw:1', candidateId: candidate.id });
    await linkMission({ missionId: mission.id, orchestrationId });
    const ids = await accepted(orchestrationId, fragmentId, ['Oppizi charges $0.47 per postcard piece.', 'A printer charges $0.52 per postcard piece.', 'Another charges $0.61 per postcard piece.']);
    const two = await unfiledConstructedRoundClaims(projectId, '', 2);
    expect(two.map((one) => one.claim.id)).toEqual([...ids].sort().slice(0, 2));
    // The arrangement's round, not the pathway round, is the one a claim is read under.
    expect(new Set(two.map((one) => one.bucketId))).toEqual(new Set([`goal-${GOAL}-mx-${KEY}`]));
  });
});
