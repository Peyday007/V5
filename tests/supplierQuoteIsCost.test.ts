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
import { readMoneyFigures, readSubCentRates } from '../server/services/cash/figures.ts';
import { composeInvented, constructionObservations, inventionContext } from '../server/services/cash/construct.ts';
import { planInputsFingerprint } from '../server/services/goals/plan.ts';
import { estimatedFromArrangement, MAX_BUYERS_OFFERED } from '../server/services/cash/goalScenario.ts';
import { supplyQuote } from '../server/services/industry/expand.ts';
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

  it('files Oppizi as a run’s fixed cost 4675 and no buyer price, so the plan reads a cost and no value', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const [oppizi, usps] = await accepted(orchestrationId, fragmentId, [OPPIZI, 'USPS lists EDDM Retail flats price at $0.26 per piece on its postage prices page.']);
    const pool = (await backfillCandidates(projectId)).decisions.filter((one) => one.source === 'CONSTRUCTED_ROUND');
    expect(pool.find((one) => one.claimId === oppizi)?.candidate).toMatchObject({ key: 'fixed_cost_per_run', amount: 4675 });
    expect(pool.find((one) => one.claimId === usps)?.candidate).toMatchObject({ key: 'contractor_rate_per_unit', amount: 0.26 });
    await backfillClaimFacts(projectId);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts.map((one) => [one.sourceClaimId, one.key, one.low]).sort()).toEqual([[oppizi, 'fixed_cost_per_run', 4675], [usps, 'contractor_rate_per_unit', 0.26]].sort());
    expect(facts.every((one) => one.segment === `map_${buyerId}`)).toBe(true);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced).toEqual([]);
    expect(read.unitCost.map((one) => one.value)).toEqual([{ kind: 'POINT', value: 0.26 }]);
    expect(read.runCost.map((one) => one.value)).toEqual([{ kind: 'POINT', value: 4675 }]);
  });

  it('supersedes the production facts: $0.47 and $4,675 prices become a $4,675 run cost, and a $259 misreading becomes a $0.259 unit cost', async () => {
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
      [[wrongPrice.id, 'fixed_cost_per_run', 4675, 'OBSERVED'], [misread.id, 'contractor_rate_per_unit', 0.259, 'OBSERVED']].sort(),
    );
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced).toEqual([]);
    expect(read.unitCost.map((one) => one.value)).toEqual([{ kind: 'POINT', value: 0.259 }]);
    expect(read.runCost.map((one) => one.value)).toEqual([{ kind: 'POINT', value: 4675 }]);
    // Idempotent: nothing is superseded twice, and a withdrawn fact is not withdrawn again.
    expect((await backfillClaimFacts(projectId)).refiled).toEqual([]);
    expect(rederivedMeaning({ key: 'price_per_unit', low: 0.47, high: 0.47 }, OPPIZI, SIDES)).toMatchObject({ key: 'fixed_cost_per_run', amount: 4675 });
    expect(rederivedMeaning({ key: 'price_per_unit', low: 259, high: 259, status: 'ASSUMPTION' }, USPS_BMEU, SIDES)).toMatchObject({ key: 'contractor_rate_per_unit', amount: 0.259 });
    expect(rederivedMeaning({ key: 'contractor_rate_per_unit', low: 0.259, high: 0.259, status: 'OBSERVED' }, USPS_BMEU, SIDES)).toBeNull();
  });
});

/**
 * B1j, production 2026-11-18 (d4732f8d, probes 44264538191 / 44264848784):
 * after #1091 the accepted Oppizi claim sat as `contractor_rate_per_unit`
 * 4675 (cfa_d740c475), which a pooled design never reads — its fixed run cost
 * came only from an opening's `peakFundingCents` — and USPS's "$0.259 per
 * piece" sat withdrawn as `price_per_unit` 259 (cfa_8cc776d4). Neither reached
 * the plan of arrangement 2821cce3c372 (BROKER, pooled buyers, threshold
 * presale).
 */
describe('B1j: an accepted per-run supply quote is the pooled arrangement’s fixed run cost', () => {
  const USPS_RETAIL = 'USPS lists EDDM Retail flats price at $0.26 per piece on its postage prices page.';
  const USPS_RETAIL_2 = 'USPS EDDM Retail postage is $0.26 per piece for flats.';

  it('reads a per-run total as the run’s fixed cost and a per-piece quote, sub-cent included, as a unit cost', () => {
    expect(supplyQuote(OPPIZI)).toMatchObject({ key: 'fixed_cost_per_run', amount: 4675, basis: 'RUN' });
    expect(supplyQuote(USPS_RETAIL)).toMatchObject({ key: 'contractor_rate_per_unit', amount: 0.26, basis: 'UNIT' });
    expect(supplyQuote(USPS_BMEU)).toMatchObject({ key: 'contractor_rate_per_unit', amount: 0.259, basis: 'UNIT' });
    expect(readSubCentRates(USPS_BMEU, 'USD')).toEqual([0.259]);
    // Only a rate stated per something, in this currency: never a bare or a foreign figure.
    expect(readSubCentRates('a total of $0.259', 'USD')).toEqual([]);
    expect(readSubCentRates('C$0.259 per piece', 'USD')).toEqual([]);
    expect(supplyQuote('EDDM mailings are popular with printers.')).toBeNull();
  });

  it('supersedes the production facts into the arrangement’s economics: fixed run cost 4675 from the Oppizi claim, unit costs 0.26 and 0.259, and no value', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const [oppizi, retail, retail2, bmeu] = (await accepted(orchestrationId, fragmentId, [OPPIZI, USPS_RETAIL, USPS_RETAIL_2, USPS_BMEU])) as [string, string, string, string];
    const file = (claimId: string, key: 'contractor_rate_per_unit' | 'price_per_unit', amount: number, status: 'OBSERVED' | 'ASSUMPTION') =>
      recordClaimFact({
        projectId, nodeId: buyerId, claimId, key, segment: `map_${buyerId}`, low: amount, high: amount, status,
        measures: 'as #1091 filed it', sourceTitle: 'EDDM', sourceUrl: 'https://eddm.com/', sourceKind: 'SECONDARY', observedAt: '2026-01-01T00:00:00.000Z',
      });
    // Production as d4732f8d holds it: cfa_d740c475, cfa_7ebd701a, cfa_ffeb589f and cfa_8cc776d4. The first is past its validity (2026-06-30).
    const d740 = (await file(oppizi, 'contractor_rate_per_unit', 4675, 'OBSERVED'))!;
    const ebd7 = (await file(retail, 'contractor_rate_per_unit', 0.26, 'OBSERVED'))!;
    const ffeb = (await file(retail2, 'contractor_rate_per_unit', 0.26, 'OBSERVED'))!;
    const cc77 = (await file(bmeu, 'price_per_unit', 259, 'ASSUMPTION'))!;
    expect(d740.validUntil?.slice(0, 10)).toBe('2026-06-30');

    const input = { projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 22, now: new Date('2026-11-18T12:00:00.000Z') };
    const spec = { design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'SUBSCRIPTION' } as const, population: 'Local service businesses', need: null };
    const composeIt = async () => {
      const made = composeInvented(spec, await inventionContext(input));
      if ('refused' in made) throw new Error(made.refused);
      return made;
    };
    const before = await composeIt();
    expect(before.fixedCost).toBeUndefined();
    expect(before.unknownParts).toContain('fixed_cost');
    const fingerprintBefore = await planInputsFingerprint(projectId, GOAL);

    const pass = await backfillClaimFacts(projectId);
    expect(pass.refiled.map((one) => [one.supersedesFactId, one.key, one.low, one.status]).sort()).toEqual(
      [[d740.id, 'fixed_cost_per_run', 4675, 'OBSERVED'], [cc77.id, 'contractor_rate_per_unit', 0.259, 'OBSERVED']].sort(),
    );
    // The two correct per-piece postage costs are left as they are.
    expect(pass.refiled.some((one) => one.supersedesFactId === ebd7.id || one.supersedesFactId === ffeb.id)).toBe(false);
    // §5: superseded, never overwritten — the old rows are history.
    expect((await listProjectConstructionFacts(projectId)).some((one) => one.id === d740.id)).toBe(false);
    expect(await getDb().get('SELECT id FROM construction_facts WHERE id = ?', [d740.id])).toBeTruthy();

    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced).toEqual([]);
    expect(read.runCost.map((one) => [one.value, one.lineage])).toEqual([[{ kind: 'POINT', value: 4675 }, [`claim:${oppizi}`]]]);
    expect(read.unitCost.map((one) => one.value).sort((a, b) => (a.kind === 'POINT' && b.kind === 'POINT' ? a.value - b.value : 0))).toEqual([
      { kind: 'POINT', value: 0.259 }, { kind: 'POINT', value: 0.26 }, { kind: 'POINT', value: 0.26 },
    ]);

    const after = await composeIt();
    // The arrangement's composed economics carry the run's fixed cost, resting on the Oppizi claim.
    // One supplier's total for a new arrangement is a comparable observation: it locates the run's cost
    // (p50 4675) and bounds it, and, alone, does not yet justify a distribution, so research still asks for it.
    expect(after.fixedCost).toMatchObject({ tier: 'COMPARABLE', observations: 1, sources: [`claim:${oppizi}`] });
    expect(after.fixedCost!.p50).toBeCloseTo(4675, 3);
    expect(after.fixedCost!.p10).toBeLessThan(4675);
    expect(after.fixedCost!.p90).toBeGreaterThan(4675);
    expect(after.inputsDigest).not.toBe(before.inputsDigest);
    // A cost manufactures no value: what a slot buyer pays is still unknown, and nothing is at risk before the presale.
    expect(after.value).toMatchObject({ tier: 'UNKNOWN', observations: 0 });
    expect(after.value).toEqual(before.value);
    expect(after.value.evidence).toBeUndefined();
    expect(after.unknownParts).toContain('value');
    expect(after.stress).toMatchObject({ exposure: 'SAFE', worstCaseCents: 0 });
    // The plan sees new evidence.
    expect(await planInputsFingerprint(projectId, GOAL)).not.toBe(fingerprintBefore);
    // Idempotent.
    expect((await backfillClaimFacts(projectId)).refiled).toEqual([]);
  });
});

/**
 * D4, production 2026-11-18: arrangement 2821cce3c372 carried its researched
 * fixed run cost (cfa_ca236ebb, 4675, from clm_9cf1f15c), and no goal-model
 * input read it. Driven here end to end — two accepted claims of the round,
 * filed by the back-fill, composed, converted to the goal model — the way the
 * plan reads them. Before the fix a researched slot price made the
 * arrangement a model candidate whose per-slot cost was the blind "nothing to
 * 60% of the top price" sweep, a margin of at least 40% on every slot whatever
 * the run costs.
 */
describe('D4: a pooled arrangement’s researched run cost reaches the goal model once its price does', () => {
  const SLOT = 'Local businesses pay $395 per slot on a shared direct-mail postcard mailed to 10,000 homes.';
  const input = { projectId: '', currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 22, now: new Date('2026-11-18T12:00:00.000Z') };
  const spec = { design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'SUBSCRIPTION' } as const, population: 'Local service businesses', need: null };
  const composeIt = async () => {
    const made = composeInvented(spec, await inventionContext({ ...input, projectId }));
    if ('refused' in made) throw new Error(made.refused);
    return made;
  };

  it('with the run cost alone the value stays unknown and the arrangement stays out of the model (no manufactured score)', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    await accepted(orchestrationId, fragmentId, [OPPIZI]);
    await backfillClaimFacts(projectId);
    const arrangement = await composeIt();
    expect(arrangement.fixedCost?.p50).toBeCloseTo(4675, 3);
    expect(arrangement.value.tier).toBe('UNKNOWN');
    expect(estimatedFromArrangement(arrangement, { projectId, currency: 'USD', daysLeft: 22, beforeProofCents: null })).toBeNull();
  });

  it('with a researched slot price, the per-slot cost is the run cost shared by an unestablished number of buyers, citing the run-cost claim', async () => {
    const { buyerId, orchestrationId, fragmentId } = await openArrangementRound();
    const [oppizi, slot] = (await accepted(orchestrationId, fragmentId, [OPPIZI, SLOT])) as [string, string];
    await backfillClaimFacts(projectId);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts.map((one) => [one.sourceClaimId, one.key, one.low, one.segment]).sort()).toEqual(
      [[oppizi, 'fixed_cost_per_run', 4675, `map_${buyerId}`], [slot, 'price_per_unit', 395, `map_${buyerId}`]].sort(),
    );
    const arrangement = await composeIt();
    expect(arrangement.value).toMatchObject({ tier: 'COMPARABLE', observations: 1, sources: [`claim:${slot}`] });
    expect(arrangement.fixedCost).toMatchObject({ observations: 1, sources: [`claim:${oppizi}`] });

    const modelled = estimatedFromArrangement(arrangement, { projectId, currency: 'USD', daysLeft: 22, beforeProofCents: null })!;
    expect(modelled).not.toBeNull();
    // The slot price enters, as an assumption (one pooled-run observation establishes nothing, GH2).
    expect(modelled.price.inferred).toMatchObject({ tier: 'ASSUMED', justified: false });
    expect(modelled.price.inferred!.p50).toBeCloseTo(395, 3);
    // The per-slot cost is read from the run's cost, never capped at 60% of the price.
    const cost = modelled.directCost;
    expect(cost.provenance).toBe('ASSUMPTION');
    expect(cost.inferred).toMatchObject({ tier: 'ASSUMED', justified: false });
    expect(cost.source?.note).toContain(`claim:${oppizi}`);
    expect(cost.low!).toBeCloseTo(arrangement.fixedCost!.p10 / MAX_BUYERS_OFFERED, 6);
    expect(cost.high!).toBeCloseTo(arrangement.fixedCost!.p90, 6);
    expect(cost.high!).toBeGreaterThan(modelled.price.high!);
    // Swept log-uniformly: half its draws lie below the geometric middle, and a slot can cost more than it sells for.
    const values = cost.distribution?.kind === 'EMPIRICAL' ? cost.distribution.values : [];
    expect(values.length).toBeGreaterThan(10);
    expect(values.filter((v) => v > 395).length).toBeGreaterThan(0);
    expect(values.filter((v) => v < 395).length).toBeGreaterThan(0);
  });

  it('leaves a design that is not pooled, or a pooled one with no researched run cost, exactly as before', async () => {
    const { orchestrationId, fragmentId } = await openArrangementRound();
    await accepted(orchestrationId, fragmentId, [SLOT]);
    await backfillClaimFacts(projectId);
    const arrangement = await composeIt();
    expect(arrangement.fixedCost).toBeUndefined();
    const modelled = estimatedFromArrangement(arrangement, { projectId, currency: 'USD', daysLeft: 22, beforeProofCents: null })!;
    expect(modelled.directCost).toMatchObject({ provenance: 'UNKNOWN', low: 0 });
    expect(modelled.directCost.high!).toBeCloseTo(modelled.price.high! * 0.6, 6);
  });
});
