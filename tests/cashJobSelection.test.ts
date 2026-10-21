/**
 * Which openings are worth research, and which become execution jobs.
 *
 * Production, Cash Mode 1, 2026-10-21: 340 openings and 269 deep dives produced
 * one qualified piece — a broker's $5 membership fee read as the price against
 * an $800 deposit read as the exposure, marked READY_TO_TEST with its own card
 * reading "USD -795.00 expected" — and no job at all, while five Freelancer
 * jobs Brain had screened as deliverable sat PREPARED and uncounted. These pin
 * the repairs: no dive or field research is spent on a marketplace listing, an
 * opening closing inside the runway, or capital the ledger does not hold; a
 * piece that loses money on its own figures is not qualified, readied or
 * contacted for; and a prepared marketplace job is an execution job whose
 * blockers name the account and the grant.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { whyNotDiving } from '../server/services/cash/validation.ts';
import { closesWithin, marketplaceOf } from '../server/services/cash/worthResearching.ts';
import { recordJob } from '../server/repos/marketplaceJobs.ts';
import { pipelineReading } from '../server/services/cash/jobPipeline.ts';
import { cashTier } from '../server/services/cash/tier.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import type { Layer, OpportunitySignal } from '../server/domain/types.ts';

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({
    email: 'selection@example.com',
    displayName: 'Peyton',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  ownerId = owner.id;
  const started = await activate({
    projectId,
    ownerUserId: owner.id,
    actorUserId: owner.id,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
});

async function claimAt(url: string): Promise<string> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: url });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'discovery',
    assignment: 'discovery',
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'market-signal',
      question: 'Who published a paid request?',
      geography: null,
      timeframe: null,
      population: null,
      definitions: null,
      requiredEvidence: [],
      acceptableSourceTypes: [],
      excludedSourceTypes: [],
      completionCriteria: ['A request.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'ACCEPTED',
    },
  ]);
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'TARGETED',
      claim: 'A client posted an open fixed-price request.',
      claimType: 'SOURCED_FACT',
      sourceUrl: url,
      sourceTitle: 'A request',
      sourcePublisher: 'A publisher',
      sourceDate: '2026-10-19',
      evidenceExcerpt: 'open fixed-price request',
      evidenceLocator: 'page',
      evidenceLane: 'demand_signal',
      retrievedAt: '2026-10-19T12:00:00.000Z',
      confidence: 0.8,
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      accepted: true,
      rejectionReason: null,
      contentHash: url,
    },
  ]);
  return claim!.id;
}

async function opening(input: { url?: string; signal?: OpportunitySignal; title?: string } = {}): Promise<string> {
  const sourceClaimId = input.url ? await claimAt(input.url) : null;
  const made = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: ownerId,
    title: input.title ?? 'An opening',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    opportunitySignal: input.signal ?? 'PAID_TASK_OR_CONTRACT',
    currency: 'USD',
    sourceClaimId,
  });
  await updateOpportunity(made.id, { buying_signal: 'asked' });
  return made.id;
}

const dive = async (id: string) => whyNotDiving((await getOpportunity(id))!);

describe('which hosts are marketplace listings', () => {
  it('matches a marketplace by its registered name on any country domain, and nothing else', () => {
    expect(marketplaceOf('https://www.freelancer.com/projects/excel/pdf-text-to-word')).toBe('freelancer');
    expect(marketplaceOf('https://www.freelancer.ie/jobs/pdf/')).toBe('freelancer');
    expect(marketplaceOf('https://www.peopleperhour.com/freelance-jobs/x-4527194')).toBe('peopleperhour');
    expect(marketplaceOf('https://freelancer.co.uk/p/1')).toBe('freelancer');
    expect(marketplaceOf('https://guru.example.com/rfp')).toBeNull();
    expect(marketplaceOf('https://www.stlouis-mo.gov/supply/bids/')).toBeNull();
    expect(marketplaceOf('not a url')).toBeNull();
    expect(marketplaceOf(null)).toBeNull();
  });

  it('reads a closing date inside the runway as soon, and an unknown date as never soon', () => {
    const now = '2026-10-21T02:00:00.000Z';
    expect(closesWithin('2026-10-22', now)).toBe(true);
    expect(closesWithin('2026-10-30', now)).toBe(false);
    expect(closesWithin('next Friday', now)).toBe(false);
    expect(closesWithin(null, now)).toBe(false);
  });
});

describe('no dive is spent where no answer could make the opening executable', () => {
  it('refuses a Freelancer listing, and dives the same opening from a buyer’s own site', async () => {
    const listing = await opening({ url: 'https://www.freelancer.com/projects/wordpress/portfolio-site-build' });
    expect(await dive(listing)).toEqual({
      kind: 'NOT_WORTH_RESEARCHING',
      reason: { kind: 'MARKETPLACE_LISTING', marketplace: 'freelancer' },
    });
    const own = await opening({ url: 'https://www.example-buyer.com/rfp/web-services' });
    expect((await dive(own)).kind).toBe('ELIGIBLE');
  });

  it('refuses an opening that closes before a dive could finish', async () => {
    const id = await opening({ url: 'https://www.example-buyer.com/rfp/soon' });
    await updateOpportunity(id, { expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
    expect(await dive(id)).toMatchObject({ kind: 'NOT_WORTH_RESEARCHING', reason: { kind: 'CLOSES_TOO_SOON' } });
    await updateOpportunity(id, { expires_at: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString() });
    expect((await dive(id)).kind).toBe('ELIGIBLE');
  });

  it('refuses an asset to buy that the deployable cash cannot pay for', async () => {
    const asset = await opening({ url: 'https://www.publicsurplus.com/sms/auction/view?auc=1', signal: 'RESALABLE_ASSET_OPENING' });
    expect(await dive(asset)).toMatchObject({
      kind: 'NOT_WORTH_RESEARCHING',
      reason: { kind: 'CAPITAL_NOT_HELD', needsCents: null, deployableCents: 0 },
    });
    // A service with an exposure is still researched: capital can arrive, and execution waits for it.
    const exposed = await opening({ url: 'https://www.example-buyer.com/rfp/bond' });
    await updateOpportunity(exposed, { peak_funding_cents: 80000 });
    expect((await dive(exposed)).kind).toBe('ELIGIBLE');
  });
});

describe('a piece that loses money on its own figures is not qualified', () => {
  it('caps the tier at CANDIDATE when the published price is below the published exposure', async () => {
    const id = await opening({ url: 'https://campobroker.com/broker-subastas-copart-iaai/' });
    await updateOpportunity(id, { price_cents: 500, peak_funding_cents: 80000 });
    const opportunity = (await getOpportunity(id))!;
    // Every field answered and the short card ready: production's shape exactly.
    const empty = cashEngineCard({ opportunity, facts: [] });
    const card = { ...empty, entries: empty.entries.map((entry) => ({ ...entry, value: 'answered' })), unknowns: [] };
    const readiness = { ...evidenceCard(opportunity).readiness, ready: true, missing: [] };
    const losing = cashTier({ opportunity, card, readiness });
    expect(losing.tier).toBe('CANDIDATE');
    expect(losing.summary).toMatch(/Loses money/);
    // The same card with a price that covers the exposure is ready to test.
    const paying = cashTier({ opportunity: { ...opportunity, priceCents: 90000 }, card, readiness });
    expect(paying.tier).toBe('READY_TO_TEST');
  });
});

describe('a prepared marketplace job is an execution job', () => {
  it('is counted, staged as ready-but-blocked, and names the account and the grant', async () => {
    await recordJob({
      projectId,
      externalId: '40775802',
      title: 'PDF Text to Word',
      url: 'https://www.freelancer.com/projects/40775802',
      employerExternalId: null,
      currency: 'USD',
      budgetMinCents: 3000,
      budgetMaxCents: 25000,
      postedAt: '2026-10-20T10:00:00.000Z',
      description: 'Convert the text of my PDFs into editable Word documents.',
      screenReasons: ['a data operations Brain can produce and verify'],
      proposalText: 'AI-assisted and checked.',
      bidAmountCents: 16000,
      bidPeriodDays: 3,
      state: 'PREPARED',
      categories: ['DATASET'],
      economics: { netUsd: 144.67 },
    });
    await recordJob({
      projectId,
      externalId: '40000001',
      title: 'Rejected job',
      url: 'https://www.freelancer.com/projects/40000001',
      employerExternalId: null,
      currency: 'USD',
      budgetMinCents: 1000,
      budgetMaxCents: 2000,
      postedAt: null,
      description: 'hourly',
      screenReasons: ['hourly work needs a person on the clock'],
      proposalText: null,
      bidAmountCents: null,
      bidPeriodDays: null,
      state: 'REJECTED',
    });
    // Off by default: the owner rejected freelance work, so a PREPARED bid is
    // history and never an execution job asking for a Freelancer account.
    const off = (await pipelineReading(projectId, { userId: ownerId, owner: true }))!;
    expect(off.marketplaceJobs).toEqual([]);
    expect(off.counts.READY_BLOCKED).toBe(0);
    expect(JSON.stringify(off)).not.toMatch(/FREELANCER_OAUTH_TOKEN/);

    // Only a deployment that turns the operation back on reads them as jobs.
    process.env.BRAIN_FREELANCER_OPERATION = 'on';
    try {
    const reading = (await pipelineReading(projectId, { userId: ownerId, owner: true }))!;
    expect(reading.marketplaceJobs).toHaveLength(1);
    const job = reading.marketplaceJobs[0]!;
    expect(job.stage).toBe('READY_BLOCKED');
    expect(job.netUsd).toBe(144.67);
    expect(reading.counts.READY_BLOCKED).toBeGreaterThanOrEqual(1);
    const bid = job.tasks.find((task) => task.key === 'bid')!;
    expect(bid.status).toBe('BLOCKED_PROVIDER');
    expect(bid.because).toMatch(/FREELANCER_OAUTH_TOKEN/);
    expect(job.blockers.join(' ')).toMatch(/not connected/);
    // A member who is not the owner is not shown another operation's jobs.
    expect((await pipelineReading(projectId, { userId: 'usr_other', owner: false }))!.marketplaceJobs).toEqual([]);
    } finally {
      delete process.env.BRAIN_FREELANCER_OPERATION;
    }
  });
});
