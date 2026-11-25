/**
 * Production 2026-11-25 (planning-eval stall): the goal price questions
 * orc_0d04107ea0ad43c1bf21 and orc_8a75b0f1cdeb455c8062 filed 19 accepted
 * claims in lane `economics` with no declared figure ("B2B year-end gift
 * budgets typically range from $30–$120 per recipient"), so the back-fill
 * never read them, both needs stayed OPEN and the plan never got a price.
 * A price stated per a named unit is now read from the claim's prose, both
 * ends of a range kept, and the need answered with the figure, its unit and
 * the claim. A claim with no such figure answers nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { listProjectConstructionFacts } from '../server/repos/construction.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { backfillClaimFacts, rederivedMeaning, statedUnitPrice } from '../server/services/industry/expand.ts';
import { sendNeeds } from '../server/services/quant/needs.ts';
import { priceNeedOf, priceScope } from '../server/services/goals/portfolioNeeds.ts';
import { GOAL_PRICE_KEY_PREFIX } from '../server/services/goals/goalWork.ts';
import type { UnpricedPopulation } from '../server/services/goals/portfolio.ts';
import type { Layer } from '../server/domain/types.ts';

describe('the price a claim states per a named unit', () => {
  it('keeps both ends of a range and the unit the text names', () => {
    expect(statedUnitPrice('B2B year-end gift budgets typically range from $30–$120 per recipient')).toEqual({ low: 30, high: 120, unit: 'recipient' });
    expect(statedUnitPrice('Premium boxes priced at $100 to $250+ per person for leadership departures')).toEqual({ low: 100, high: 250, unit: 'person' });
    expect(statedUnitPrice('Douglas-fir at $400–$700 per thousand board feet')).toEqual({ low: 400, high: 700, unit: 'thousand board feet' });
  });

  it('answers nothing without a figure stated per a named unit, and never mixes units', () => {
    expect(statedUnitPrice('B2B bundle pricing at 1.8–2.2x landed cost for 500+ units')).toBeNull();
    expect(statedUnitPrice('The study costs $25,000 in total.')).toBeNull();
    expect(statedUnitPrice('Boxes sell for $5 each.')).toBeNull();
    expect(statedUnitPrice('$40 per box, or $900 per pallet')).toEqual({ low: 40, high: 40, unit: 'box' });
    // A rate per hour or word is not a purchase; a unit stops before the phrase after it.
    expect(statedUnitPrice('Assistants charge $10 per hour.')).toBeNull();
    expect(statedUnitPrice('a volume-weighted $328 per MBF over the last quarter')).toEqual({ low: 328, high: 328, unit: 'mbf' });
  });
});

describe('a card price filed from a rate is withdrawn', () => {
  const card = 'what this buyer pays per unit of work, as published: Agencies charge $0.01 to $0.05 per email for list cleaning';
  it('supersedes a card-filed price with an ASSUMPTION once the card took that claim back as its price', () => {
    const meaning = rederivedMeaning({ key: 'price_per_unit', low: 0.01, high: 0.01, status: 'OBSERVED', measures: card, cardPriceWithdrawn: true }, 'Agencies charge $0.01 to $0.05 per email for list cleaning', undefined);
    expect(meaning).toMatchObject({ key: 'price_per_unit', amount: 0.01, status: 'ASSUMPTION' });
    // Withdrawn once: the ASSUMPTION is not withdrawn again.
    expect(rederivedMeaning({ key: 'price_per_unit', low: 0.01, high: 0.01, status: 'ASSUMPTION', measures: card, cardPriceWithdrawn: true }, 'Agencies charge $0.01 to $0.05 per email', undefined)).toBeNull();
    // A rate per the unit of work nothing took back stands.
    expect(rederivedMeaning({ key: 'price_per_unit', low: 300, high: 300, status: 'OBSERVED', measures: 'what this buyer pays per unit of work, as published: x' }, 'Independent restaurants pay $300 to $450 per grease trap cleaning.', undefined)).toBeNull();
  });

  it('leaves a card price the claim states for one purchase, and an answer to a price question', () => {
    expect(rederivedMeaning({ key: 'price_per_unit', low: 2500, high: 2500, status: 'OBSERVED', measures: 'what this buyer pays per unit of work, as published: x', cardPriceWithdrawn: true }, 'The study is priced at $2,500 in total.', undefined)).toBeNull();
    expect(rederivedMeaning({ key: 'price_per_unit', low: 30, high: 120, status: 'OBSERVED', measures: 'answering Brain’s price question about "x": USD 30–120 per recipient' }, 'budgets range from $30–$120 per recipient', undefined)).toBeNull();
  });
});

let projectId = '';
let layer: Layer;
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({ email: `stated-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect 10000 dollars of settled cash.' });
  if (!started.ok) throw new Error('could not activate');
  ownerId = owner.id;
});

function unpriced(population: string, buyer: string): UnpricedPopulation {
  return { population, buyer, designs: 3, arrangementKey: 'abc123def456', label: `${buyer}: gift boxes`, question: `What does one buyer described as "${buyer}" pay, in USD, for one purchase?` };
}

async function askAndAnswer(one: UnpricedPopulation, texts: string[]): Promise<{ needId: string; claimIds: string[] }> {
  const [delivered] = await sendNeeds({ projectId, actorRef: ownerId, graphScope: priceScope(one.population), keyPrefix: GOAL_PRICE_KEY_PREFIX, needs: [priceNeedOf(one)] });
  if (!delivered?.sent || delivered.to !== 'RESEARCH_CANDIDATE') throw new Error('price question not sent');
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'price' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Price', assignment: 'price', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'goal-price',
      question: 'What do these buyers pay?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: [], acceptableSourceTypes: ['a published price list'], excludedSourceTypes: [], completionCriteria: ['A price.'],
      dependsOn: [], minIndependentSources: 1, status: 'ACCEPTED',
    },
  ]);
  const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'price', whyNow: 'test', idempotencyKey: `price:${one.population}`, candidateId: delivered.ref });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  // As production's were: lane `economics`, no declared finding, subject or amount.
  const rows = await insertClaims(
    texts.map((text) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const,
      claim: text, claimType: 'SOURCED_FACT' as const, sourceUrl: 'https://example.org/gifting', sourceTitle: 'Gifting guide',
      sourcePublisher: 'A seller', sourceDate: '2026-11-01', evidenceExcerpt: text, evidenceLocator: 'p1', evidenceLane: 'economics',
      retrievedAt: '2026-11-25T12:00:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `stated:${Math.random()}:${text}`,
    })),
  );
  const need = await getDb().get<{ id: string }>('SELECT id FROM cash_needs WHERE project_id = ? AND candidate_id = ?', [projectId, delivered.ref]);
  return { needId: need!.id, claimIds: rows.map((row) => row.id) };
}

describe('a goal price question answered in prose reaches the plan', () => {
  it('files the stated range against the population and answers the need with figure, unit and claim', async () => {
    const sector = await seedSubject({ projectId, name: 'Corporate gifting', actorRef: 'BRAIN' });
    const buyer = await seedSubject({ projectId, name: 'Small and mid-size firms sending year-end gifts', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const { needId, claimIds } = await askAndAnswer(unpriced(buyer.node.id, 'Small and mid-size firms sending year-end gifts'), [
      'B2B bundle pricing at 1.8–2.2x landed cost for 500+ units with ~40–55% gross margin',
      'B2B year-end gift budgets typically range from $30–$120 per recipient',
    ]);
    const filed = await backfillClaimFacts(projectId);
    expect(filed.filed.map((one) => one.sourceClaimId)).toEqual([claimIds[1]]);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'price_per_unit', segment: `map_${buyer.node.id}`, low: 30, high: 120, status: 'OBSERVED' });
    expect(facts[0]!.measures).toContain('USD 30–120 per recipient');
    const need = await getDb().get<{ state: string; resolution: string }>('SELECT state, resolution FROM cash_needs WHERE id = ?', [needId]);
    expect(need!.state).toBe('RESOLVED');
    expect(need!.resolution).toContain('USD 30–120 per recipient');
    expect(need!.resolution).toContain(claimIds[1]!);
    // A replay files nothing twice.
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
  });

  it('a question whose answers state no price per a named unit stays open', async () => {
    const sector = await seedSubject({ projectId, name: 'Forestry', actorRef: 'BRAIN' });
    const buyer = await seedSubject({ projectId, name: 'State forestry agencies', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const { needId } = await askAndAnswer(unpriced(buyer.node.id, 'State forestry agencies'), ['Timber auctions are held quarterly by sealed bid.']);
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
    expect(await listProjectConstructionFacts(projectId)).toEqual([]);
    expect((await getDb().get<{ state: string }>('SELECT state FROM cash_needs WHERE id = ?', [needId]))!.state).toBe('OPEN');
  });
});
