/**
 * Production 2026-11-20 (read-only probes, runs 44749620314 and 44750150850):
 * ten goal-price fragments were ACCEPTED and 16 accepted claims declared
 * `price_per_unit` with an amount, and no construction fact named any of
 * them. The back-fill matched each claim's `structural_qualifier` against the
 * map's buyer types, and researchers had written sentences there ("WriterAccess
 * plan fees published on the same page Basic $49/Month…", "GitHub Inc is the
 * payer…"), so every claim was refused "buyer qualifier matches no mapped
 * buyer type"; in two projects the map held no buyer type at all.
 *
 * An answer to a question Brain asked about a named population is filed
 * against that population — read from the question's own scope
 * (`price:<population>`), never from the researcher's qualifier — and the
 * plan's price read (`constructionObservations`) then holds it.
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
import { listNodes } from '../server/repos/industry.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { backfillCandidates, backfillClaimFacts } from '../server/services/industry/expand.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { constructionObservations } from '../server/services/cash/construct.ts';
import { sendNeeds } from '../server/services/quant/needs.ts';
import { priceNeedOf, priceScope } from '../server/services/goals/portfolioNeeds.ts';
import { GOAL_PRICE_KEY_PREFIX } from '../server/services/goals/goalWork.ts';
import type { UnpricedPopulation } from '../server/services/goals/portfolio.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({ email: `price-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect 10000 dollars of settled cash.' });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
  ownerId = owner.id;
});

function unpriced(population: string, buyer: string): UnpricedPopulation {
  return {
    population,
    buyer,
    designs: 4,
    arrangementKey: 'abc123def456',
    label: `${buyer}: managed writing`,
    question: `What does one buyer described as "${buyer}" pay, in USD, for one purchase of it? Declare each figure on its claim: structural_finding UNIT_ECONOMIC, structural_subject price_per_unit, structural_qualifier "${buyer}".`,
  };
}

/** Send the goal's price question exactly as `sendPriceNeeds` does, and run research on the idea it opened. */
async function askAndResearch(one: UnpricedPopulation): Promise<{ orchestrationId: string; fragmentId: string }> {
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
  return { orchestrationId: orchestration.id, fragmentId: fragment!.id };
}

async function declaredPrice(orchestrationId: string, fragmentId: string, input: { text: string; qualifier: string; cents: number; sourceUrl?: string | null; accepted?: boolean }): Promise<string> {
  const [row] = await insertClaims([
    {
      orchestrationId, fragmentId, passId: null, passKey: 'TARGETED' as const,
      claim: input.text, claimType: 'SOURCED_FACT' as const, sourceUrl: input.sourceUrl === undefined ? 'https://example.org/pricing' : input.sourceUrl, sourceTitle: 'Pricing',
      sourcePublisher: 'A seller', sourceDate: '2026-11-01', evidenceExcerpt: input.text, evidenceLocator: 'pricing', evidenceLane: 'economics',
      retrievedAt: '2026-11-19T20:40:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: input.accepted ?? true, rejectionReason: null, contentHash: `price:${Math.random()}:${input.text}`,
      structuralFinding: 'UNIT_ECONOMIC', structuralSubject: 'price_per_unit', structuralQualifier: input.qualifier, structuralAmountCents: input.cents,
    },
  ]);
  return row!.id;
}

const SENTENCE = 'WriterAccess plan fees published on the same page Basic $49/Month, Pro $129/Month';

describe('an accepted answer to a goal price question is filed against the population the question asked about', () => {
  it('maps the population when the map holds no buyer type, files the fact against it, and the plan reads it', async () => {
    expect((await listNodes(projectId)).filter((one) => one.kind === 'BUYER_TYPE')).toEqual([]);
    const opening = await createOpportunity({
      projectId, cashModeId: modeId, ownerUserId: ownerId, title: 'Managed blog writing', mechanism: 'PRODUCTIZED_SERVICE',
      currency: 'USD', sourceClaimId: null, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A seller', requiredCapabilities: [],
    } as Parameters<typeof createOpportunity>[0]);
    await getDb().run('UPDATE cash_opportunities SET industry = ? WHERE id = ?', ['Content marketing', opening.id]);
    const { orchestrationId, fragmentId } = await askAndResearch(unpriced(opening.id, 'Content marketing agencies'));
    const priced = await declaredPrice(orchestrationId, fragmentId, { text: `${SENTENCE}; agencies pay $129 per month.`, qualifier: SENTENCE, cents: 12_900 });

    const pool = await backfillCandidates(projectId);
    const decision = pool.decisions.find((one) => one.claimId === priced)!;
    expect(decision.reason).toBeNull();
    expect(decision.candidate?.askedPopulation?.name).toBe('Content marketing agencies');

    const filed = await backfillClaimFacts(projectId);
    expect(filed.filed.map((one) => one.sourceClaimId)).toEqual([priced]);
    const buyer = (await listNodes(projectId)).find((one) => one.kind === 'BUYER_TYPE')!;
    expect(buyer).toMatchObject({ name: 'Content marketing agencies', origin: 'DISCOVERED', sourceClaimId: priced });
    const sector = (await listNodes(projectId)).find((one) => one.id === buyer.parentId)!;
    expect(sector.name).toBe('Content marketing');
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'price_per_unit', segment: `map_${buyer.id}`, low: 129, high: 129, status: 'OBSERVED', sourceClaimId: priced });

    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced.map((one) => one.lineage)).toEqual([[`claim:${priced}`]]);

    // Idempotent: a replay files nothing twice and maps nothing twice.
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
    expect((await listNodes(projectId)).filter((one) => one.kind === 'BUYER_TYPE')).toHaveLength(1);
  });

  it('files against the map buyer type the question scoped (a map-derived population), whatever the qualifier says', async () => {
    const sector = await seedSubject({ projectId, name: 'Software', actorRef: 'BRAIN' });
    const buyer = await seedSubject({ projectId, name: 'Open-source maintainers', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const { orchestrationId, fragmentId } = await askAndResearch(unpriced(buyer.node.id, 'Open-source maintainers'));
    const priced = await declaredPrice(orchestrationId, fragmentId, { text: 'Sponsors pay maintainers $25 per month on GitHub Sponsors.', qualifier: 'GitHub Inc is the payer for the Sponsors program', cents: 2_500 });
    const nodesBefore = (await listNodes(projectId)).length;
    const filed = await backfillClaimFacts(projectId);
    expect(filed.filed.map((one) => [one.sourceClaimId, one.segment])).toEqual([[priced, `map_${buyer.node.id}`]]);
    expect((await listNodes(projectId)).length).toBe(nodesBefore);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced.map((one) => one.lineage)).toEqual([[`claim:${priced}`]]);
  });

  it('keeps the gates: an unsourced answer files nothing and maps nothing; a claim nobody asked about still needs its qualifier', async () => {
    const { orchestrationId, fragmentId } = await askAndResearch(unpriced('invented:dental practices', 'Dental practices'));
    const unsourced = await declaredPrice(orchestrationId, fragmentId, { text: 'Practices pay $300 per month.', qualifier: SENTENCE, cents: 30_000, sourceUrl: null });
    const pool = await backfillCandidates(projectId);
    expect(pool.decisions.find((one) => one.claimId === unsourced)?.reason).toMatch(/source URL/);
    expect((await backfillClaimFacts(projectId)).filed).toEqual([]);
    expect((await listNodes(projectId)).filter((one) => one.kind === 'BUYER_TYPE')).toEqual([]);

    // A UNIT_ECONOMIC claim from research that asked about no population: the qualifier fallback, unchanged.
    const sector = await seedSubject({ projectId, name: 'Dental', actorRef: 'BRAIN' });
    await seedSubject({ projectId, name: 'Dental practices', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'other' });
    const other = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Other', assignment: 'other', provider: 'WORKER', autoApprove: false });
    const [frag] = await createFragments([
      {
        orchestrationId: other.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'other',
        question: 'q', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
        requiredEvidence: [], acceptableSourceTypes: ['x'], excludedSourceTypes: [], completionCriteria: ['x'],
        dependsOn: [], minIndependentSources: 1, status: 'ACCEPTED',
      },
    ]);
    const stray = await declaredPrice(other.id, frag!.id, { text: 'Practices pay $300 per month.', qualifier: SENTENCE, cents: 30_000 });
    const decision = (await backfillCandidates(projectId)).decisions.find((one) => one.claimId === stray)!;
    expect(decision.candidate).toBeNull();
    expect(decision.reason).toMatch(/qualifier matches no mapped buyer type/);
  });

  it('pins the qualifier in the question to the buyers’ exact name', () => {
    const need = priceNeedOf(unpriced('cop_x', 'Content marketing agencies'));
    expect(need.question).toContain('Set structural_qualifier to exactly "Content marketing agencies"');
  });
});
