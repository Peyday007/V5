/**
 * Production, 2026-11-20 (census run 44780189914): one buyer segment of
 * prj_22fb4fec, map_ind_42887b66ff1e476990b4 (WriterAccess content-writing
 * pricing), held three OBSERVED `price_per_unit` facts answering one goal price
 * question: $0.04 and $0.05 per word, and a $449 monthly plan. The plan reads
 * every price fact as what one payer pays for one purchase (`a_value`), so it
 * pooled a per-word rate with a plan price into one per-deal range spanning
 * five orders of magnitude.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { listProjectConstructionFacts, recordClaimFact } from '../server/repos/construction.ts';
import { backfillClaimFacts, claimPaysPopulation } from '../server/services/industry/expand.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { readMoneyFigures } from '../server/services/cash/figures.ts';
import { composeInvented, constructionObservations, inventionContext, nextInputQuestion, statesMeasuredRate } from '../server/services/cash/construct.ts';
import type { Layer } from '../server/domain/types.ts';

const BUYERS = 'Businesses buying content writing';
const PER_WORD_4 = 'WriterAccess charges businesses $0.04 per word for 2-star writers.';
const PER_WORD_5 = 'WriterAccess charges businesses $0.05 per word for 3-star writers.';
const MONTHLY = 'WriterAccess sells businesses a monthly plan at $449 per month.';

let projectId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
});

async function acceptedClaims(texts: string[], structural: (i: number) => Record<string, unknown> = () => ({})): Promise<string[]> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'price' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Goal price', assignment: 'price', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'goal-price',
      question: `What does one buyer described as "${BUYERS}" pay?`, geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: [], acceptableSourceTypes: ['a published price list'], excludedSourceTypes: [], completionCriteria: ['A price.'],
      dependsOn: [], minIndependentSources: 1, status: 'RUNNING',
    },
  ]);
  const rows = await insertClaims(
    texts.map((text, i) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const,
      claim: text, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/writeraccess-${i}`, sourceTitle: 'WriterAccess pricing',
      sourcePublisher: 'WriterAccess', sourceDate: '2026-11-01', evidenceExcerpt: text, evidenceLocator: 'pricing', evidenceLane: 'economics',
      retrievedAt: '2026-11-20T10:00:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `unit:${i}:${text}`,
      ...structural(i),
    })),
  );
  return rows.map((one) => one.id);
}

describe('a per-word rate and a plan price answering one price question are never one per-purchase range', () => {
  it('reads a rate per measured quantity as such, and a billing period or an item as not', () => {
    for (const text of [PER_WORD_4, 'Writers earn $95/hr.', 'Editing costs $3 per page.', 'Transcription is $1.50 a minute.', 'Copy is $12 per 100 words.']) {
      expect(readMoneyFigures(text, 'USD').every((one) => one.perMeasure && one.perUnit), text).toBe(true);
    }
    for (const text of [MONTHLY, 'Oppizi charges $0.47 per postcard piece.', 'A 1,000-word blog post costs $120.', 'Local businesses pay $395 for a slot.']) {
      expect(readMoneyFigures(text, 'USD').some((one) => one.perMeasure), text).toBe(false);
    }
    expect(statesMeasuredRate(PER_WORD_4, 0.04, 0.04)).toBe(true);
    expect(statesMeasuredRate(MONTHLY, 449, 449)).toBe(false);
    // A claim stating the total for one purchase beside its rate is that total.
    expect(statesMeasuredRate('A 1,000-word post at $0.12 per word costs $120 in total.', 120, 120)).toBe(false);
    expect(statesMeasuredRate(null, 0.04, 0.04)).toBe(false);
  });

  it('prices the WriterAccess segment from the monthly plan alone, never a range from $0.04 to $449', async () => {
    const sector = await seedSubject({ projectId, name: 'Content marketing', actorRef: 'BRAIN' });
    const buyer = await seedSubject({ projectId, name: BUYERS, kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const claims = await acceptedClaims([PER_WORD_4, PER_WORD_5, MONTHLY]);
    for (const [claimId, amount] of [[claims[0]!, 0.04], [claims[1]!, 0.05], [claims[2]!, 449]] as const) {
      await recordClaimFact({
        projectId, nodeId: buyer.node.id, claimId, key: 'price_per_unit', segment: `map_${buyer.node.id}`, low: amount, high: amount, status: 'OBSERVED',
        measures: `answering Brain's price question about "${BUYERS}"`, sourceTitle: 'WriterAccess pricing', sourceUrl: 'https://example.org/writeraccess', sourceKind: 'PRIMARY',
        observedAt: '2026-11-20',
      });
    }

    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 30 });
    expect(read.priced.map((one) => [one.value, one.lineage])).toEqual([[{ kind: 'POINT', value: 449 }, [`claim:${claims[2]}`]]]);

    const input = { projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 30, now: new Date('2026-11-20T12:00:00.000Z') };
    const made = composeInvented({ design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' }, population: BUYERS, need: null }, await inventionContext(input));
    if ('refused' in made) throw new Error(made.refused);
    expect(made.value.observations).toBe(1);
    expect(made.value.sources).toEqual([`claim:${claims[2]}`]);
    expect(made.value.p10).toBeGreaterThan(1);
    expect(made.value.p50).toBeCloseTo(449, 0);
  });

  it('leaves the price a question when only per-word rates answered it, and asks for one purchase', async () => {
    const sector = await seedSubject({ projectId, name: 'Content marketing', actorRef: 'BRAIN' });
    const buyer = await seedSubject({ projectId, name: BUYERS, kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const [claim] = await acceptedClaims([PER_WORD_4]);
    await recordClaimFact({
      projectId, nodeId: buyer.node.id, claimId: claim!, key: 'price_per_unit', segment: `map_${buyer.node.id}`, low: 0.04, high: 0.04, status: 'OBSERVED',
      measures: 'per word', sourceTitle: 'WriterAccess pricing', sourceUrl: 'https://example.org/writeraccess', sourceKind: 'PRIMARY', observedAt: '2026-11-20',
    });
    expect((await constructionObservations({ projectId, currency: 'USD', daysLeft: 30 })).priced).toEqual([]);

    const input = { projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 30, now: new Date('2026-11-20T12:00:00.000Z') };
    const made = composeInvented({ design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' }, population: BUYERS, need: null }, await inventionContext(input));
    if ('refused' in made) throw new Error(made.refused);
    expect(made.value.tier).toBe('UNKNOWN');
    const ask = nextInputQuestion(made, 'USD');
    expect(ask?.part).toBe('value');
    expect(ask?.question).toContain('the total one of these buyers pays for one purchase');
    expect(ask?.question).toContain('A rate per word, page, hour or minute is not this figure');
    expect(ask?.question).not.toContain('for a rate');
  });
});

/**
 * Production, 2026-11-20 (prj_22fb4fec): GitHub's $10,000 bug-bounty rewards —
 * money GitHub pays security researchers — were filed as `price_per_unit` on
 * three buyer nodes. A price is what the population pays; money paid to it
 * runs the other way.
 */
describe('a figure paid to the population is never filed as the price it pays', () => {
  const BOUNTY = 'GitHub pays security researchers bounties of up to $10,000 for a critical vulnerability.';

  it('reads the population as the recipient only when the claim says so', () => {
    for (const text of [BOUNTY, 'Security researchers earn up to $10,000 per critical bug on GitHub.', 'GitHub awards bounties of up to $10,000 to independent security researchers.', 'Researchers receive $617 on average per report.', 'Researchers are paid $500 per valid report.']) {
      expect(claimPaysPopulation(text, 'Security researchers'), text).toBe(true);
    }
    // The paying side, and a claim that names no recipient, are not judged the wrong way round.
    expect(claimPaysPopulation(BOUNTY, 'Companies running bug bounty programs')).toBe(false);
    expect(claimPaysPopulation('Companies running bug bounty programs pay HackerOne $20,000 a year.', 'Companies running bug bounty programs')).toBe(false);
    expect(claimPaysPopulation('GitHub bug bounty rewards go up to $10,000.', 'Security researchers')).toBe(false);
    expect(claimPaysPopulation('Dental practices pay $500 per month for the service.', 'Dental practices')).toBe(false);
    expect(claimPaysPopulation('Restaurants receive a monthly invoice of $300.', 'Independent restaurants')).toBe(false);
  });

  it('files the bounty against the programs that pay it and refuses it against the researchers it is paid to', async () => {
    const sector = await seedSubject({ projectId, name: 'Application security', actorRef: 'BRAIN' });
    const researchers = await seedSubject({ projectId, name: 'Security researchers', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const programs = await seedSubject({ projectId, name: 'Companies running bug bounty programs', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
    const qualifiers = ['Security researchers', 'Companies running bug bounty programs'];
    const [toResearchers, fromPrograms] = await acceptedClaims([BOUNTY, `${BOUNTY} `], (i) => ({
      structuralFinding: 'UNIT_ECONOMIC', structuralSubject: 'price_per_unit', structuralQualifier: qualifiers[i], structuralAmountCents: 1_000_000,
    }));
    await backfillClaimFacts(projectId);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts.map((one) => [one.sourceClaimId, one.key, one.low, one.segment])).toEqual([[fromPrograms, 'price_per_unit', 10_000, `map_${programs.node.id}`]]);
    expect(facts.some((one) => one.sourceClaimId === toResearchers || one.segment === `map_${researchers.node.id}`)).toBe(false);
  });

  it('asks for money the buyers pay out, never money paid to them', async () => {
    const input = { projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 30, now: new Date('2026-11-20T12:00:00.000Z') };
    const made = composeInvented({ design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' }, population: 'Security researchers', need: null }, await inventionContext(input));
    if ('refused' in made) throw new Error(made.refused);
    expect(nextInputQuestion(made, 'USD')?.question).toContain('the claim must say they are the ones paying: a reward, bounty, wage, fee or payout paid to them runs the other way');
  });
});
