/**
 * Plan integrity across varied goals (`planIntegrity`; the architecture record's "Plan integrity").
 *
 * The production failures of 2026-11-19 were each found on one goal and fixed
 * on one goal's shape. This reads one shared world — found openings in three
 * sectors with real buyer populations (property management, dental practices,
 * commercial cleaning, restaurant equipment) and one sector whose only "buyer"
 * is a single named company ("GitHub", developer tools) — through a matrix of
 * goals that vary what a plan is built from:
 *
 *   capital       none / small ($1,000) / large ($10,000)
 *   revenue unit  one-time settled cash / monthly recurring
 *   deadline      short (7 days) / long (90 days)
 *   industry      each named sector, the one-company sector included
 *   autonomy      owner hours limited (person time scarce) / unlimited
 *
 * For every variant: the reading carries its integrity, it is empty, ACCEPTED
 * is never paired with a violation, every unpriced lead population is sent as
 * price research, and no step or plan text carries an internal key.
 *
 * Goals carry no "Brain-only" flag, so autonomy is varied by the owner time a
 * goal allows: a step that needs a person is still read on every variant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { forgetGoalReadings, readGoalPlan, type PlanReading } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { clearConstructionMemo } from '../server/services/cash/construct.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { internalKeyIn, planIntegrity } from '../server/domain/planIntegrity.ts';
import { integrityInput } from '../server/services/goals/planIntegrityInput.ts';
import type { CashMechanism } from '../server/domain/types.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims } from '../server/repos/research.ts';

/** A sourced, accepted claim a price fact can cite (the fact's claim is a real row). */
async function priceClaim(onProject: string, suffix: string): Promise<string> {
  const layerId = (await listLayers(onProject))[0]!.id;
  const run = await createRun({ projectId: onProject, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'price' });
  const orchestration = await createOrchestration({ projectId: onProject, layerId, runId: run.id, title: 'price', assignment: 'price', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: onProject, layerId, fragmentIndex: 0, fragmentKey: `price-${suffix}`, question: 'What dental practices pay',
      requiredEvidence: [{ id: 'figure', description: 'a published price', necessity: 'REQUIRED' }], acceptableSourceTypes: ['price list'], excludedSourceTypes: [],
      completionCriteria: ['a price'], dependsOn: [], minIndependentSources: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: `A dental practice pays $200 per compliance report ${suffix}`, sourceUrl: `https://example.org/price/${suffix}`, sourceTitle: 'Price list', sourcePublisher: 'example.org',
      sourceDate: '2026-10-01', evidenceExcerpt: '$200 per report', evidenceLocator: 'table 1', evidenceLane: 'figure', retrievedAt: '2026-11-01', confidence: 0.9,
      validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const, contentHash: `pt-${suffix}`,
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

const NOW = new Date();
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

interface Held {
  title: string;
  mechanism: CashMechanism;
  industry: string;
  payer: string;
  capture: string;
  priceCents: number;
  costCents: number;
  capitalCents: number;
  days: number;
  hours: number;
  volume: string;
  recurring: boolean;
}

/** One world for every variant: populations in four sectors, and one sector whose only buyer is one company. */
const WORLD: Held[] = [
  {
    title: 'Vendor-compliance spreadsheet for property managers', mechanism: 'PRODUCTIZED_SERVICE', industry: 'property management',
    payer: 'Property managers', capture: 'Sell the finished compliance spreadsheet to each manager.', priceCents: 60_000, costCents: 1_000, capitalCents: 0, days: 5, hours: 1,
    volume: '400 property managers are listed in the state directory; each needs one.', recurring: false,
  },
  {
    title: 'Monthly bookkeeping retainer for dental practices', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'dental practices',
    payer: 'Dental practice owners', capture: 'Bill each practice a monthly retainer; a subcontracted bookkeeper does the work.', priceCents: 90_000, costCents: 45_000, capitalCents: 0, days: 30, hours: 1,
    volume: '250 independent dental practices are listed in the state dental board directory; each pays monthly.', recurring: true,
  },
  {
    title: 'Resale of liquidated restaurant kitchen equipment', mechanism: 'SUPPLY_DEMAND_MISMATCH', industry: 'restaurant equipment',
    payer: 'Restaurant operators', capture: 'Buy a liquidated lot at auction and resell it to an opening restaurant.', priceCents: 1_400_000, costCents: 800_000, capitalCents: 800_000, days: 21, hours: 4,
    volume: '30 liquidation auctions a month are listed by the regional auctioneer; 40 restaurants open each month.', recurring: false,
  },
  {
    title: 'Post-construction cleanup for general contractors', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning',
    payer: 'General contractors', capture: 'Sell the final cleanup and subcontract a crew.', priceCents: 120_000, costCents: 60_000, capitalCents: 0, days: 10, hours: 2,
    volume: '80 general contractors are listed in the state licensing board; each needs cleanup per project.', recurring: false,
  },
  {
    // The one-company sector: production's "GitHub" as a buyer (2026-11-19).
    title: 'Sponsored maintenance reports for GitHub', mechanism: 'PRODUCTIZED_SERVICE', industry: 'developer tools',
    payer: 'GitHub', capture: 'Sell a maintenance report to GitHub.', priceCents: 300_000, costCents: 5_000, capitalCents: 0, days: 14, hours: 2,
    volume: 'GitHub is one company.', recurring: false,
  },
];

interface Variant {
  id: string;
  words: string;
  capital: 'none' | 'small' | 'large';
  unit: 'one-time' | 'monthly';
  deadline: 'short' | 'long';
  industry: string;
  autonomy: 'owner-hours-limited' | 'unlimited';
}

const VARIANTS: Array<Variant & { world?: 'openings' | 'map' }> = [
  { id: 'none-once-short', words: 'Collect $10,000 of settled cash within 7 days using no up-front capital.', capital: 'none', unit: 'one-time', deadline: 'short', industry: 'any', autonomy: 'unlimited' },
  { id: 'none-once-long', words: 'Collect $30,000 of settled cash within 90 days using no up-front capital.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'any', autonomy: 'unlimited' },
  { id: 'small-once-short', words: 'Turn $1,000 into $10,000 within 7 days.', capital: 'small', unit: 'one-time', deadline: 'short', industry: 'any', autonomy: 'unlimited' },
  { id: 'large-once-long', words: 'Turn $10,000 into $100,000 within 90 days.', capital: 'large', unit: 'one-time', deadline: 'long', industry: 'any', autonomy: 'unlimited' },
  { id: 'none-monthly-long-hours', words: 'Earn $5,000 a month in recurring revenue within 60 days with no more than 10 hours a week of owner time.', capital: 'none', unit: 'monthly', deadline: 'long', industry: 'any', autonomy: 'owner-hours-limited' },
  { id: 'small-monthly-short', words: 'Earn $2,000 a month in recurring revenue within 14 days, with at most 1,500 dollars of starting capital.', capital: 'small', unit: 'monthly', deadline: 'short', industry: 'any', autonomy: 'unlimited' },
  { id: 'industry-cleaning', words: 'Generate $20,000 within 45 days in a single industry the owner names: commercial cleaning.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'commercial cleaning', autonomy: 'unlimited' },
  { id: 'industry-dental', words: 'Generate $15,000 within 60 days in a single industry the owner names: dental practices.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'dental practices', autonomy: 'unlimited' },
  { id: 'industry-property', words: 'Generate $8,000 within 30 days in a single industry the owner names: property management, with no more than 5 hours a week of owner time.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'property management', autonomy: 'owner-hours-limited' },
  { id: 'industry-one-company', words: 'Generate $9,000 within 30 days in a single industry the owner names: developer tools.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'developer tools (one company)', autonomy: 'unlimited' },
  // The map world: no openings to sell, so the steps are the leading arrangement's own.
  { id: 'map-none-once-long', world: 'map', words: 'Collect $10,000 of settled cash within 60 days using no up-front capital.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'any (map)', autonomy: 'unlimited' },
  { id: 'map-large-once-long', world: 'map', words: 'Turn $10,000 into $100,000 within 90 days.', capital: 'large', unit: 'one-time', deadline: 'long', industry: 'any (map)', autonomy: 'unlimited' },
  { id: 'map-small-monthly-short', world: 'map', words: 'Earn $2,000 a month in recurring revenue within 14 days, with at most 1,500 dollars of starting capital.', capital: 'small', unit: 'monthly', deadline: 'short', industry: 'any (map)', autonomy: 'unlimited' },
  { id: 'map-industry-dentistry', world: 'map', words: 'Generate $5,000 within 30 days in a single industry the owner names: dentistry, with no more than 5 hours a week of owner time.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'dentistry (map)', autonomy: 'owner-hours-limited' },
  { id: 'map-industry-property-unpriced', world: 'map', words: 'Generate $6,000 within 45 days in a single industry the owner names: property management.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'property management (map, unpriced)', autonomy: 'unlimited' },
  { id: 'map-industry-one-company', world: 'map', words: 'Generate $9,000 within 30 days in a single industry the owner names: developer tools.', capital: 'none', unit: 'one-time', deadline: 'long', industry: 'developer tools (map, one company)', autonomy: 'unlimited' },
];

let projectId = '';
let userId = '';
/** The second world: a map and no openings, so the plan's steps are a constructed arrangement's. */
let mapProjectId = '';

beforeAll(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  clearConstructionMemo();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `pt-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  const cashModeId = (await getCashMode(projectId))!.id;
  for (const h of WORLD) {
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: userId, title: h.title, mechanism: h.mechanism, currency: 'USD', industry: h.industry,
      sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
      requiredCapabilities: ['PRODUCE_SPREADSHEET'],
    } as Parameters<typeof createOpportunity>[0]);
    const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
    await fact(CAPTURE_KEY, h.capture);
    await fact('payer', h.payer);
    await fact('delivery', 'Brain produces or subcontracts it.');
    await updateOpportunity(o.id, {
      payer: h.payer, price_cents: h.priceCents, offer_scope: h.title, reachable_channel: 'Published business email addresses',
      buying_signal: 'Posted asking for this work', signal_observed_at: inDays(-3), peak_funding_cents: h.capitalCents, human_hours: h.hours, industry: h.industry,
    } as never);
    await fact('price', `$${h.priceCents / 100}${h.recurring ? ' a month' : ''}`);
    await fact('timeToFirstCash', `${h.days} days`);
    await fact('directCosts', `$${h.costCents / 100}`);
    if (h.capitalCents > 0) await fact('exposure', `$${h.capitalCents / 100}`);
    await fact('buyerVolume', h.volume);
  }

  // The map world: three sectors with real buyer populations, one priced; and one whose only "buyer" is GitHub.
  mapProjectId = (await createProject({ name: 'Plan transfer map', slug: `plan-transfer-map-${Math.random().toString(36).slice(2, 8)}` })).id;
  expect((await activate({ projectId: mapProjectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  const actorRef = `person:${userId}`;
  const sectors: Array<[string, string[]]> = [
    ['Dentistry', ['Dental practices', 'Orthodontic clinics']],
    ['Property management', ['Residential property managers', 'Homeowner associations']],
    ['Commercial cleaning', ['Office cleaning contractors']],
    ['Developer tools', ['GitHub']],
  ];
  for (const [sector, buyers] of sectors) {
    const root = await seedSubject({ projectId: mapProjectId, name: sector, actorRef });
    for (const buyer of buyers) {
      const node = await seedSubject({ projectId: mapProjectId, name: buyer, kind: 'BUYER_TYPE', parentId: root.node.id, actorRef });
      if (buyer === 'Dental practices') {
        for (const [suffix, low, high] of [['d1', 150, 250], ['d2', 200, 300]] as const) {
          const claimId = await priceClaim(projectId, suffix);
          await recordClaimFact({
            projectId: mapProjectId, nodeId: node.node.id, claimId, key: 'price_per_unit', segment: `map_${node.node.id}`, low, high, status: 'OBSERVED',
            measures: 'a dental practice pays per compliance report', sourceTitle: 'Price list', sourceUrl: `https://example.org/${claimId}`, sourceKind: 'PRIMARY', observedAt: '2026-11-01T00:00:00.000Z',
          });
        }
      }
    }
  }
});

afterAll(async () => {
  await teardown();
});

/** The goal the words make, the only live target on the project's ledger (G-7): earlier variants' goals are retired first. */
async function goalFor(v: Variant & { world?: 'openings' | 'map' }): Promise<string> {
  const project = v.world === 'map' ? mapProjectId : projectId;
  await getDb().run(`UPDATE workstreams SET cancelled_at = ? WHERE target_project_id = ? AND cancelled_at IS NULL`, [NOW.toISOString(), project]);
  const created = await createGoal({ projectId: project, objective: v.words, actorRef: `person:${userId}`, userId, now: new Date(NOW.getTime() - 60_000) });
  expect(created.ok, created.ok ? '' : created.reason).toBe(true);
  return created.ok ? created.goal.id : '';
}

/** Every text a person reads on a plan: the steps, the summary, the acceptance, the next test. */
function texts(p: PlanReading): string[] {
  return [
    ...p.steps.flatMap((s) => [s.label, s.detail]),
    p.summary,
    p.acceptance.sentence,
    p.acceptance.candidate?.label ?? '',
    p.acceptance.accepted?.label ?? '',
    p.nextTest?.test ?? '',
  ];
}

const results: Record<string, unknown>[] = [];

describe('plan integrity holds across varied goals', () => {
  for (const v of VARIANTS) {
    it(v.id, async () => {
      const goalId = await goalFor(v);
      const p = (await readGoalPlan({ goalId, evaluations: 400 }))!;
      expect(p).not.toBeNull();
      const reach = p.acceptance.probability?.value ?? p.acceptance.candidate?.reach ?? null;
      results.push({
        variant: v.id, capital: v.capital, unit: v.unit, deadline: v.deadline, industry: v.industry, autonomy: v.autonomy,
        status: p.acceptance.status, reach: reach === null ? null : Math.round(reach * 1000) / 10,
        lead: p.lead ? `${p.lead.buyers} (${p.lead.price.basis})` : null,
        steps: p.steps.map((s) => `${s.label}${s.owner === 'PERSON' ? ' [PERSON]' : ''}${s.arrangement ? ` {${s.arrangement.stage} cost=${s.cost} day=${s.startDay ? s.startDay.low : s.arrangement.unscheduled ?? '-'}}` : ''}`).slice(0, 14),
        unpriced: (p.unpriced ?? []).map((u) => u.buyer).slice(0, 4),
        integrity: p.integrity,
      });
      // The reading carries its integrity, and the checker agrees with it.
      expect(p.integrity).toBeDefined();
      expect(planIntegrity(integrityInput(p)).violations).toEqual(p.integrity);
      expect(p.integrity, JSON.stringify(p.integrity)).toEqual([]);
      // ACCEPTED is never paired with a violation; RECOMMENDABLE iff ACCEPTED.
      if (p.acceptance.status === 'ACCEPTED') expect(p.integrity).toEqual([]);
      expect(p.verdict === 'RECOMMENDABLE').toBe(p.acceptance.status === 'ACCEPTED');
      // An unpriced lead population is sent as price research.
      if (p.lead?.price.basis === 'UNPRICED' && p.steps.some((s) => s.arrangement?.key === p.lead!.arrangementKey)) {
        expect((p.unpriced ?? []).map((u) => u.population)).toContain(p.lead.population);
      }
      // No text a person reads carries an internal key.
      for (const t of texts(p)) expect(internalKeyIn(t), t.slice(0, 200)).toBeNull();
      // The one-company sector never leads as a population, and no lead is outside the goal's own scope.
      if (p.lead) expect(p.lead.buyers).not.toBe('GitHub');
      if (p.lead) expect(p.lead.inScope).toBe(true);
      if (v.id === 'map-industry-one-company') expect(p.steps.some((s) => s.arrangement)).toBe(false);
    });
  }

  afterAll(() => {
    for (const r of results) console.log(`TRANSFER ${JSON.stringify(r)}`);
  });
});
