/**
 * Priced payers on the map (2026-11-15): construction_facts stayed 0 after the
 * F3 back-fill shipped, because the back-fill files a card's price only
 * against a payer the map names, and production's map held 11 buyer types
 * while its 49 priced openings named organisations — "Pennsylvania Department
 * of Agriculture", "School District of Philadelphia", "US residential
 * homeowners (Mechanicsburg, PA)" — none of them were.
 *
 * One standing kernel pass now puts each such payer on the map as a buyer
 * population (deduplicated by population), the back-fill files the opening's
 * price against it, and construction prices arrangements for those buyers.
 *
 * Every card fact here is written by `applyValidationAnswers` and
 * `proposeEngineTerms` from gated claims, exactly as production writes them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createOpportunity, getOpportunity, listOpportunities, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims, updateFragment } from '../server/repos/research.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
import { listProjectConstructionFacts } from '../server/repos/construction.ts';
import { applyValidationAnswers, proposeEngineTerms } from '../server/services/cash/validation.ts';
import { fillCard } from '../server/services/cash/opportunities.ts';
import { clearConstructionMemo, constructArrangements } from '../server/services/cash/construct.ts';
import { selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { runIndustryKernel, resetBackfillIdle } from '../server/services/industry/kernel.ts';
import { backfillCandidates, mapPricedPayers } from '../server/services/industry/expand.ts';
import { listNodes } from '../server/repos/industry.ts';
import { buyerPopulationName } from '../server/domain/industry.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import type { EvidenceLane, Layer } from '../server/domain/types.ts';

const DIVE_LANES: EvidenceLane[] = profileFor('RUSSELL_CASH_VALIDATION_V1')!.lanes;

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`payers-${Math.random().toString(36).slice(2, 8)}`, projectId]);
  const owner = await createUser({ email: `pp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  ownerId = owner.id;
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
  clearConstructionMemo();
  resetBackfillIdle();
});

/** A finished deep dive whose gated claims are filed in the named lanes, as a worker submits them. */
async function dive(key: string, claims: { lane: string; text: string }[]): Promise<{ candidateId: string }> {
  const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: `Qualify: ${key}`, statement: key });
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: key });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: `Qualify: ${key}`, assignment: key, provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'opening-validation',
      question: 'Who pays, at what price, and what rules it out?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: DIVE_LANES, acceptableSourceTypes: ['a published price list'], excludedSourceTypes: ['blog'], completionCriteria: ['A named payer.'],
      dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    },
  ]);
  await updateFragment(fragment!.id, { status: 'BLOCKED' });
  await insertClaims(
    claims.map((spec) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const,
      claim: spec.text, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/${key}`, sourceTitle: 'Published notice',
      sourcePublisher: 'A public body', sourceDate: '2026-09-01', evidenceExcerpt: spec.text, evidenceLocator: 'p. 2', evidenceLane: spec.lane,
      retrievedAt: '2026-10-07T12:00:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `${key}:${spec.lane}:${spec.text}`,
    })),
  );
  const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: key, whyNow: 'test', idempotencyKey: `dive:${key}`, candidateId: candidate.id });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'FAILED', terminalReason: 'x' });
  return { candidateId: candidate.id };
}

/** A priced opening whose dive settled, as the validation lane leaves it. */
async function pricedOpening(key: string, spec: { payer: string; price: string; industry: string | null; offer: string }): Promise<string> {
  const round = await dive(key, [
    { lane: 'payer', text: spec.payer },
    { lane: 'price_evidence', text: spec.price },
  ]);
  const made = await createOpportunity({ projectId, cashModeId: modeId, ownerUserId: ownerId, title: spec.offer, mechanism: 'SUBCONTRACTED_FULFILMENT', currency: 'USD', requiredCapabilities: [], sourceClaimId: null, source: 'A publisher' });
  await recordCashEvent({ projectId, opportunityId: made.id, kind: 'CASH_VALIDATION_STARTED', actorRef: 'BRAIN', summary: 'started', detail: { candidateId: round.candidateId, round: 1 } });
  await updateOpportunity(made.id, { candidate_id: round.candidateId, validation_state: 'BLOCKED', validation_rounds: 1, industry: spec.industry, offer_scope: spec.offer } as never);
  // A priced opening carries its price column, as the card path writes it.
  const filled = await fillCard({ opportunityId: made.id, actorRef: 'BRAIN', patch: { priceCents: Number(/\$([\d,]+)/.exec(spec.price)![1]!.replace(/,/g, '')) * 100 } });
  if (!filled.ok) throw new Error('could not price the opening');
  return made.id;
}

/** Production's shape: eleven buyer types, none of them any priced payer's population. */
async function productionMap(): Promise<void> {
  const roots = ['Commercial kitchens', 'Dentistry', 'Pet care'];
  const buyers = ['Independent restaurants', 'Hotel kitchens', 'Catering firms', 'Dental practices', 'Orthodontists', 'Dental labs', 'Dog groomers', 'Boarding kennels', 'Veterinary clinics', 'Pet stores', 'Animal shelters'];
  const ids = [];
  for (const name of roots) ids.push((await seedSubject({ projectId, name, actorRef: ownerId })).node.id);
  for (const [i, name] of buyers.entries()) await seedSubject({ projectId, name, kind: 'BUYER_TYPE', parentId: ids[Math.min(2, Math.floor(i / 4))]!, actorRef: ownerId });
}

describe('a priced payer the map does not name becomes a buyer population', () => {
  it('generalises a single named organisation, keeps a general population, and never leaves a state in the name', () => {
    expect(buyerPopulationName('Pennsylvania Department of Agriculture')).toBe('state agriculture departments');
    expect(buyerPopulationName('New Jersey Department of Agriculture')).toBe('state agriculture departments');
    expect(buyerPopulationName('School District of Philadelphia')).toBe('school districts');
    expect(buyerPopulationName('US residential homeowners (Mechanicsburg, PA)')).toBe('US residential homeowners');
    expect(buyerPopulationName('NEH Division of Preservation and Access')).toBe('NEH Division of Preservation and Access');
    expect(buyerPopulationName('City of Pittsburgh')).toBe('municipal governments');
    expect(buyerPopulationName('Pennsylvania farmers')).toBe('farmers');
    expect(buyerPopulationName('  ')).toBeNull();
  });

  it('one kernel pass maps the payers (deduplicated), the back-fill files their prices, and construction admits a priced arrangement', async () => {
    await productionMap();
    const openings = [
      await pricedOpening('pda', { payer: 'Pennsylvania Department of Agriculture', price: 'The Pennsylvania Department of Agriculture pays $2,500 per farm grant application prepared.', industry: 'Agricultural grants', offer: 'Farm grant application preparation' }),
      await pricedOpening('nja', { payer: 'New Jersey Department of Agriculture', price: 'The New Jersey Department of Agriculture pays $3,000 per farm grant application prepared.', industry: 'Agricultural grants', offer: 'Farm grant application preparation for growers' }),
      await pricedOpening('sdp', { payer: 'School District of Philadelphia', price: 'The School District of Philadelphia pays $1,200 per curriculum review.', industry: 'K-12 education', offer: 'Curriculum review' }),
      await pricedOpening('home', { payer: 'US residential homeowners (Mechanicsburg, PA)', price: 'Homeowners pay $250 per energy audit report.', industry: null, offer: 'Energy audit reports' }),
    ];
    await applyValidationAnswers(projectId);
    await proposeEngineTerms(projectId);
    for (const id of openings) {
      expect((await cardFact(id, 'payer'))?.kind).toBe('EVIDENCE');
      expect((await cardFact(id, 'revenueRange'))?.kind).toBe('EVIDENCE');
    }
    // Before: no priced payer is on the map; the dry run reads each as a population to add, and nothing is filed yet.
    const before = await backfillCandidates(projectId);
    expect(before.decisions.filter((one) => one.candidate && !one.candidate.buyer).map((one) => one.candidate!.newBuyer!.population).sort()).toEqual([
      'US residential homeowners', 'school districts', 'state agriculture departments', 'state agriculture departments',
    ]);
    expect(await listProjectConstructionFacts(projectId)).toHaveLength(0);

    const pass = await runIndustryKernel(projectId);
    expect(pass.failures ?? []).toEqual([]);
    expect(pass.payersMapped).toBe(3);

    const nodes = await listNodes(projectId);
    const discovered = nodes.filter((one) => one.kind === 'BUYER_TYPE' && one.origin === 'DISCOVERED');
    expect(discovered.map((one) => one.name).sort()).toEqual(['US residential homeowners', 'school districts', 'state agriculture departments']);
    expect(discovered.every((one) => one.sourceClaimId)).toBe(true);
    const byId = new Map(nodes.map((one) => [one.id, one]));
    const parentOf = (name: string) => byId.get(discovered.find((one) => one.name === name)!.parentId!)!;
    expect(parentOf('state agriculture departments')).toMatchObject({ kind: 'SECTOR', name: 'Agricultural grants', parentId: null });
    expect(parentOf('school districts').name).toBe('K-12 education');
    expect(parentOf('US residential homeowners').name).toBe('Unclassified');

    // The back-fill filed each opening's price against its population, the two departments against one node.
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(4);
    const departments = discovered.find((one) => one.name === 'state agriculture departments')!;
    expect(facts.filter((one) => one.segment === `map_${departments.id}`).map((one) => one.low).sort()).toEqual([2500, 3000]);
    expect(facts.every((one) => one.key === 'price_per_unit' && one.status === 'OBSERVED')).toBe(true);

    // Idempotent: a second pass maps and files nothing more.
    resetBackfillIdle();
    const again = await runIndustryKernel(projectId);
    expect(again.payersMapped).toBe(0);
    expect(await listProjectConstructionFacts(projectId)).toHaveLength(4);
    expect((await mapPricedPayers(projectId)).created).toHaveLength(0);

    // Construction reads the new populations as demand, priced from their own facts.
    clearConstructionMemo();
    // A discovered sector holds no mapped supplier yet, so what reaches these buyers is what Brain proved it delivers (the goal frame's `delivers`).
    const arrangements = await constructArrangements({ projectId, currency: 'USD', delivers: ['written reports'], capitalCeilingCents: null, daysLeft: 30 });
    const ours = new Set(discovered.map((one) => one.id));
    const forThem = arrangements.filter((one) => ours.has(one.demand.ref));
    expect(forThem.length).toBeGreaterThan(0);
    expect(new Set(forThem.map((one) => one.sector))).toEqual(new Set(['Agricultural grants', 'K-12 education', 'Unclassified']));

    const live = await listOpportunities({ projectId });
    const selected = selectEstimatedArrangements(forThem, {
      projectId, currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [], daysLeft: 30,
      otherPrices: live
        .filter((one) => one.payer && one.priceCents !== null && one.priceCents > 0)
        .map((one) => ({ value: one.priceCents! / 100, industry: one.industry, mechanism: one.mechanism, payer: one.payer })),
    });
    // The two agriculture departments' published prices are their own sector's comparable prices.
    const admitted = selected.openings.filter((one) => one.marketKey?.includes(departments.id));
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted[0]!.price.note).toMatch(/same sector \(Agricultural grants\)/);
    expect(selected.selection.cut.some((one) => one.population === departments.id && one.reason.includes('no comparable price'))).toBe(false);
    expect((await getOpportunity(openings[0]!))?.payer).toBe('Pennsylvania Department of Agriculture');
  });

  it('bounds each pass, and resumes where the last one stopped', async () => {
    await productionMap();
    await pricedOpening('pda', { payer: 'Pennsylvania Department of Agriculture', price: 'It pays $2,500 per application.', industry: 'Agricultural grants', offer: 'Farm grant application preparation' });
    await pricedOpening('sdp', { payer: 'School District of Philadelphia', price: 'It pays $1,200 per review.', industry: 'K-12 education', offer: 'Curriculum review' });
    await applyValidationAnswers(projectId);
    await proposeEngineTerms(projectId);
    expect((await mapPricedPayers(projectId, 1)).created).toHaveLength(1);
    expect((await mapPricedPayers(projectId, 1)).created).toHaveLength(1);
    expect((await mapPricedPayers(projectId, 1)).created).toHaveLength(0);
  });
});

import { payerNamedIn, buyerPopulationName as populationOf } from '../server/domain/industry.ts';
import { backfillClaimFacts } from '../server/services/industry/expand.ts';

/*
 * Production census 2026-11-15 08:10Z: 21 buyer types on the map, 99 held
 * openings read by the back-fill, 0 candidates — 77 of them "opening payer
 * matches no mapped buyer type", because each opening's payer is the research
 * sentence, which the name reader did not read.
 */
const SPREADSHEET = 'Buyers who pay for spreadsheet templates are primarily small business operators, freelancers, bookkeepers and teachers who want ready-made tools.';
const FREELANCER = 'On Freelancer.com the payer is the employer who posts the project and funds the milestone before work starts.';
const GOTRANSCRIPT = "GoTranscript's Billing Terms (its own PDF) name universities, research institutions, market research firms and media companies as customers invoiced monthly.";

describe('the back-fill reads the payer production stores, and maps a population it does not hold', () => {
  it('reads the quoted production sentences into buyer populations', () => {
    expect(payerNamedIn(SPREADSHEET)).toBe('small business operators, freelancers, bookkeepers and teachers');
    expect(populationOf(SPREADSHEET)).toBe('small business operators');
    expect(payerNamedIn(FREELANCER)).toBe('employer');
    expect(payerNamedIn(GOTRANSCRIPT)).toBe('universities');
    expect(populationOf(GOTRANSCRIPT)).toBe('universities and colleges');
    // A sentence that names nobody, a pronoun, or a role word alone stays unnamed.
    expect(payerNamedIn('It pays $2,500 per application.')).toBeNull();
    expect(payerNamedIn('The payer is unknown.')).toBeNull();
    expect(payerNamedIn('Buyers pay $40 per hour.')).toBeNull();
    // A company suffix is not a list.
    expect(populationOf('GitHub, Inc. is the payer: it runs the bug bounty program')).toBe('GitHub, Inc');
  });

  it('files each priced opening against its payer population, adding the population first, and keeps honest refusals', async () => {
    await productionMap();
    const openings = [
      await pricedOpening('sheets', { payer: SPREADSHEET, price: 'Spreadsheet templates on Etsy sell for $29 per template.', industry: 'Digital templates', offer: 'Spreadsheet templates' }),
      await pricedOpening('freelancer', { payer: FREELANCER, price: 'Data-entry projects on Freelancer.com are posted at $250 per project.', industry: 'Freelance marketplaces', offer: 'Data entry' }),
      await pricedOpening('gotranscript', { payer: GOTRANSCRIPT, price: 'GoTranscript invoices $90 per transcribed audio hour.', industry: 'Transcription', offer: 'Transcription' }),
      await pricedOpening('nobody', { payer: 'Domain Name Wire reports that VJN.com was tested in Appraise.net', price: 'Appraise.net put the range at $55,000.', industry: 'Domains', offer: 'Domain brokerage' }),
    ];
    await applyValidationAnswers(projectId);
    await proposeEngineTerms(projectId);
    expect((await getOpportunity(openings[0]!))?.payer).toBe(SPREADSHEET);

    // The dry run: three would map a new population, one names nobody.
    const pool = await backfillCandidates(projectId);
    const card = pool.decisions.filter((one) => one.source === 'CARD_EVIDENCE');
    expect(card.filter((one) => one.candidate).map((one) => one.candidate!.newBuyer!.population).sort()).toEqual(['employer', 'small business operators', 'universities and colleges']);
    expect(card.filter((one) => !one.candidate).map((one) => one.reason)).toEqual(['opening payer names no buyer population']);
    expect(card.some((one) => one.reason === 'opening payer matches no mapped buyer type')).toBe(false);

    // The back-fill alone (no `mapPricedPayers`) puts each population on the map and files the price against it.
    const first = await backfillClaimFacts(projectId);
    expect(first.filed).toHaveLength(3);
    const nodes = await listNodes(projectId);
    const discovered = nodes.filter((one) => one.kind === 'BUYER_TYPE' && one.origin === 'DISCOVERED');
    expect(discovered.map((one) => one.name).sort()).toEqual(['employer', 'small business operators', 'universities and colleges']);
    expect(discovered.every((one) => one.sourceClaimId)).toBe(true);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts.map((one) => one.low).sort((a, b) => a - b)).toEqual([29, 90, 250]);
    // Sourced claims: provenance kept, observed, never verified.
    expect(facts.every((one) => one.status === 'OBSERVED' && one.sourceClaimId && one.source.url)).toBe(true);
    for (const fact of facts) expect(discovered.some((one) => fact.segment === `map_${one.id}`)).toBe(true);

    // Idempotent: a replay maps and files nothing more, and the kernel's own mapping pass finds nothing left.
    expect((await backfillClaimFacts(projectId)).filed).toHaveLength(0);
    expect((await mapPricedPayers(projectId)).created).toHaveLength(0);
    expect(await listProjectConstructionFacts(projectId)).toHaveLength(3);
  });
});

describe('a payer is read out of the research sentence production stores', () => {
  it('names the payer a sentence names, and none where it names nobody', () => {
    expect(payerNamedIn('GitHub, Inc. is the payer: it runs the bug bounty program and says it pays researchers')).toBe('GitHub, Inc');
    expect(payerNamedIn('GitHub is the payer; its bug bounty is run through HackerOne (hackerone.com/github)')).toBe('GitHub');
    expect(payerNamedIn('Market: City of St. Louis, MO. The payer/buyer is St. Louis Development Corporation')).toBe('St Louis Development Corporation');
    expect(payerNamedIn('Buyers who pay for spreadsheet templates are primarily small business operators, freelancers and educators')).toBe('small business operators, freelancers and educators');
    expect(payerNamedIn('Domain Name Wire reports that VJN.com was tested in Appraise.net: range $55k-$85k')).toBeNull();
    expect(payerNamedIn("Dropcurb's customers book pickups through Dropcurb; haulers receive the address")).toBeNull();
    // A plain name stays a name, and still generalises.
    expect(populationOf('Pennsylvania Department of Agriculture')).toBe('state agriculture departments');
    expect(populationOf('Domain Name Wire reports that VJN.com was tested in Appraise.net')).toBeNull();
  });
});
