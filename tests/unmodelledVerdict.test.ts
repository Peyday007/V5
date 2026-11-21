/**
 * The verdict of a plan with no found opening to model says what was modelled
 * instead (production 91bf9ef8, 2026-11-21).
 *
 * Five goals' plan reads printed "No live opportunity is far enough along to
 * model: each one is evidence only or has no price anywhere." while the same
 * reading compared "0 found opening(s) + 6 constructed estimate(s) ...
 * estimates in the best combination 2", and goal wst_4f0c312400e1425dab2e's best
 * combination settled a median 40,338 against 50,000. The verdict described the
 * found openings only. It now names the constructed estimates, what their best
 * combination reaches (as coverage, never a probability) and settles, and keeps
 * the old sentence only when nothing at all was modelled.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { unmodelledVerdict } from '../server/services/cash/unmodelledVerdict.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { CashMechanism, Layer, OpportunitySignal } from '../server/domain/types.ts';

const OLD = 'No live opportunity is far enough along to model: each one is evidence only or has no price anywhere.';

let projectId = '';
let userId = '';
let cashModeId = '';
let layer: Layer;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (await createUser({ email: `mx-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

type ClaimInput = { claim: string; signal?: OpportunitySignal; lane?: string; sourceUrl: string };

/** Claims accepted at the gate inside an orchestration of their own. */
async function gatedClaims(claims: ClaimInput[]): Promise<{ ids: string[]; orchestrationId: string }> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a question' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a question', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a directory'], excludedSourceTypes: ['a forecast'], completionCriteria: ['a dated source'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'q', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const inserted = await insertClaims(
    claims.map((one) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: one.claim, evidenceLocator: 'the page', evidenceLane: one.lane ?? SIGNAL_LANE, opportunitySignal: one.signal ?? null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${one.claim}|${one.sourceUrl}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  return { ids: inserted.map((one) => one.id), orchestrationId: orchestration.id };
}

/** Map parts established by gated claims — the industry kernel's own rows. */
async function sector(name: string, parts: { buyer: string; bottleneck: string; supply: string }): Promise<void> {
  const [, buyer, bottleneck, supply] = (await gatedClaims([
    { claim: `${name} is a sector.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(name)}` },
    { claim: `${parts.buyer} buy in ${name}.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.buyer)}` },
    { claim: `${parts.bottleneck} is a recurring problem.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.bottleneck)}` },
    { claim: `${parts.supply} serve this.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.supply)}` },
  ])).ids;
  const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: parts.buyer, origin: buyer ? 'DISCOVERED' : 'SEED', sourceClaimId: buyer ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'BOTTLENECK', name: parts.bottleneck, origin: bottleneck ? 'DISCOVERED' : 'SEED', sourceClaimId: bottleneck ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'FULFILMENT_SOURCE', name: parts.supply, origin: supply ? 'DISCOVERED' : 'SEED', sourceClaimId: supply ?? null });
}

async function goal(amountCents: number, days = 30, capitalCents: number | null = null): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: capitalCents, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

async function opening(input: { title: string; priceCents: number; mechanism?: CashMechanism; payer?: string; volume?: string; signal?: OpportunitySignal; play?: boolean }) {
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: userId, title: input.title, mechanism: input.mechanism ?? 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: input.signal ?? 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
    requiredCapabilities: input.play === false ? [] : ['PRODUCE_SPREADSHEET'],
  });
  const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  await fact(CAPTURE_KEY, 'Sell the work to each buyer.');
  await fact('payer', input.payer ?? 'Property managers');
  await fact('delivery', 'Brain produces it.');
  await updateOpportunity(o.id, { payer: input.payer ?? 'Property managers', price_cents: input.priceCents, offer_scope: 'One report', reachable_channel: 'Published emails', buying_signal: 'Posted asking', signal_observed_at: inDays(-2), peak_funding_cents: 0, human_hours: 2 });
  await fact('price', `$${input.priceCents / 100}`);
  await fact('timeToFirstCash', '7 days');
  await fact('directCosts', '$10');
  if (input.volume) await fact('buyerVolume', input.volume);
  return o;
}


describe('a plan with no found opening to model, but constructed estimates modelled', () => {
  it('says the estimates were modelled and what their best combination reaches, never only that nothing could be modelled', async () => {
    await sector('Veterinary care', { buyer: 'Independent veterinary clinics', bottleneck: 'After-hours phone coverage', supply: 'Remote answering services' });
    // The one held opening prices the population, and is itself left out: its one-off signal is stale.
    const held = await opening({ title: 'One small report', priceCents: 20_000, play: false, signal: 'PAID_TASK_OR_CONTRACT', payer: 'Independent veterinary clinics' });
    await updateOpportunity(held.id, { signal_observed_at: inDays(-200) });
    const id = await goal(600_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    expect(reading.excluded.map((one) => one.opportunityId)).toContain(held.id);
    const estimates = reading.portfolio!.demand.filter((one) => one.opportunityId.startsWith('arr_') && !one.refused);
    expect(estimates.length).toBeGreaterThan(0);
    const best = reading.portfolio!.best!;
    expect(best).not.toBeNull();
    expect(reading.refusal).not.toBe(OLD);
    expect(reading.refusal).toContain(`${estimates.length} constructed estimate(s) were modelled`);
    expect(reading.refusal).toContain(`reaches the target in ${(best.reach * 100).toFixed(1)}% of worlds, which is coverage of assumed inputs, not a probability`);
    expect(reading.refusal).toContain(`settles a median USD ${Math.round(best.settledP50).toLocaleString('en-US')}, short of the USD 6,000 target`);
    expect(reading.summary.startsWith(reading.refusal!)).toBe(true);
  });
});

const portfolio = (over: Partial<GoalPortfolio>): GoalPortfolio =>
  ({ basis: 'COVERAGE', worlds: 1000, best: null, alternatives: [], demand: [], limits: { target: 50_000 }, missing: [], searched: 1, ...over }) as unknown as GoalPortfolio;
const estimate = (id: string, refused: string | null = null) => ({ opportunityId: id, refused }) as unknown as GoalPortfolio['demand'][number];

describe('the verdict reads the portfolio\'s own numbers', () => {
  it('keeps the old sentence only when nothing at all was modelled', () => {
    expect(unmodelledVerdict(3, null, 'USD')).toBe(OLD);
    expect(unmodelledVerdict(3, portfolio({}), 'USD')).toBe(OLD);
    expect(unmodelledVerdict(3, portfolio({ demand: [estimate('arr_a', 'no price')] }), 'USD')).toBe(OLD);
    expect(unmodelledVerdict(0, null, 'USD')).toBe('There is no live opportunity in this project to build a plan from.');
  });

  it('states production goal C as it read: 6 estimates, 2 in the best combination, 0% coverage, a median 40,338 short of 50,000', () => {
    const best = { members: [{ opportunityId: 'arr_30354053591a', title: 'a', share: 0.5 }, { opportunityId: 'arr_03e3254dced2', title: 'b', share: 0.5 }], reach: 0, settledP10: 24_627, settledP50: 40_338, settledP90: 55_130, capitalShort: 0, overSpend: 0.97 };
    const text = unmodelledVerdict(4, portfolio({ best, demand: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => estimate(`arr_${x}`)) }), 'USD');
    expect(text).toBe(
      'No found opening is far enough along to model; 6 constructed estimate(s) were modelled: the best combination (2 of them) reaches the target in 0.0% of worlds, which is coverage of assumed inputs, not a probability, and settles a median USD 40,338, short of the USD 50,000 target.',
    );
  });

  it('never calls a median at the target a success, and says when no combination fits the limits', () => {
    const best = { members: [{ opportunityId: 'arr_a', title: 'a', share: 1 }], reach: 0.62, settledP10: 1, settledP50: 60_000, settledP90: 9e4, capitalShort: 0, overSpend: 0 };
    const text = unmodelledVerdict(1, portfolio({ best, demand: [estimate('arr_a'), estimate('arr_b', 'no price')] }), 'USD');
    expect(text).toContain('1 constructed estimate(s) were modelled (1 more refused)');
    expect(text).toContain('62.0% of worlds, which is coverage of assumed inputs, not a probability');
    expect(text).toContain('settles a median USD 60,000 against the USD 50,000 target');
    expect(text).not.toMatch(/probability of|likely|will reach/);
    expect(unmodelledVerdict(1, portfolio({ demand: [estimate('arr_a')] }), 'USD')).toBe(
      "No found opening is far enough along to model; 1 constructed estimate(s) were modelled, and no combination of them can run inside the goal's limits against the USD 50,000 target.",
    );
  });
});
