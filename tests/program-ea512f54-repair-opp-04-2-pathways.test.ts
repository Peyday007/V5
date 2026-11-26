/**
 * OPP-04 repair, episode 2: a partial arrangement is kept, not abandoned.
 *
 * Production, 2026-11-26: probe r01.opp-04 read 30 live goals and found no pathway on any of
 * them. `readGoalPlan` built its pathway reading only from openings the cash model considered and
 * designs it priced, and its refusal branch returned `pathways: null` outright — so every design
 * nothing priced yet was dropped silently. S-0061: "An unknown is not an automatic favorable
 * assumption or a reason to abandon a partial arrangement."
 *
 *   B01 — the pure builder marks every fact proven, estimated (value or range) or unknown (no
 *         value), tallies fourteen, and passes the probe's own rule.
 *   B02 — unknowns contribute nothing: zero contribution, never in the living portfolio's
 *         combination, and the modelled pathways' portfolio is unchanged by partials.
 *   B03 — each gap names the missing component and the cheapest move to learn or supply it;
 *         a channel the share outruns carries REACH_SHORTFALL and a channel-changing CONSTRUCT.
 *   B04 — readPathways keeps a partial arrangement already modelled only once.
 *   P01 — readGoalPlan for a live goal with constructed designs and no opening returns pathways,
 *         each passing pathwayProblem, on the refusal branch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { partialPathwayOf, publishedFacts, readPathways, type TransactionPathway } from '../server/services/goals/pathways.ts';
import { pathwayProblem } from '../server/services/factory/program/release01/pathwaysProbe.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import type { Layer } from '../server/domain/types.ts';

const ctx = { remaining: 10_000, daysLeft: 30, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[] };
const range = (tier: string, p10: number, p50: number, p90: number) => ({ tier, p10, p50, p90, observations: 3, sources: ['claim:x'] });

function arrangement(over: Record<string, unknown> = {}): ConstructedArrangement {
  return {
    key: 'k1',
    structure: 'SUBCONTRACT',
    design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Any sector',
    demand: { name: 'Regional fleet operators', claimId: 'clm_1', from: 'INDUSTRY_MAP', ref: 'ind_1' },
    need: null,
    supply: null,
    label: 'A subcontracted service for regional fleet operators',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'UNKNOWN', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    ...over,
  } as unknown as ConstructedArrangement;
}

const target = { remainingCents: 1_000_000, daysLeft: 30, currency: 'USD', capitalCeilingCents: null, capitalBeforeProofCents: 37_500 };

describe('B01: every fact of a partial arrangement is marked', () => {
  it('an unpriced design: unknowns state no value, the tally is fourteen, the probe rule passes', () => {
    const p = partialPathwayOf(arrangement(), ctx);
    expect(p.origin).toBe('CONSTRUCTED');
    expect(p.partial).toBe(true);
    expect(p.revenuePerDeal.status).toBe('UNKNOWN');
    expect(p.net.status).toBe('UNKNOWN');
    for (const f of publishedFacts(p)) if (f.status === 'UNKNOWN') expect(f.value).toBeNull();
    expect(p.counts.proven + p.counts.estimated + p.counts.unknown).toBe(14);
    expect(p.counts.proven).toBe(0);
    expect(pathwayProblem(p)).toBeNull();
  });

  it('a priced design with a supply cost and a close rate: ranged estimates with a basis', () => {
    const p = partialPathwayOf(arrangement({ value: range('COMPARABLE', 400, 900, 2_000), supplyCost: range('COMPARABLE', 100, 300, 500), conversion: range('COMPARABLE', 0.05, 0.1, 0.2), supply: { name: 'Mobile technicians', claimId: null } }), ctx);
    expect(p.revenuePerDeal).toMatchObject({ status: 'ESTIMATED', value: 900, low: 400, high: 2_000 });
    expect(p.fulfilmentCost).toMatchObject({ status: 'ESTIMATED', value: 300 });
    expect(p.net).toMatchObject({ status: 'ESTIMATED', value: 600, low: -100, high: 1_900 });
    expect(p.conversion.status).toBe('ESTIMATED');
    expect(p.fulfiller.status).toBe('ESTIMATED');
    expect(p.gaps).not.toContain('NO_PRICE');
    expect(pathwayProblem(p)).toBeNull();
  });

  it('a mechanism-only price is not these buyers\' price: unknown, never borrowed', () => {
    const p = partialPathwayOf(arrangement({ value: range('MECHANISM', 10, 50, 90) }), ctx);
    expect(p.revenuePerDeal.status).toBe('UNKNOWN');
    expect(p.revenuePerDeal.value).toBeNull();
    expect(p.gaps).toContain('NO_PRICE');
  });
});

describe('B02: an unknown is never a favourable number', () => {
  it('contributes nothing, and the modelled portfolio is the same with or without partials', () => {
    const p = partialPathwayOf(arrangement({ value: range('COMPARABLE', 400, 900, 2_000), conversion: range('COMPARABLE', 0.05, 0.1, 0.2) }), ctx);
    expect(p.contribution).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(p.gross).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(p.executable).toBe(false);
    const base = { modelled: [], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now: new Date() };
    const without = readPathways(base);
    const withPartials = readPathways({ ...base, partial: [arrangement(), arrangement({ key: 'k2', value: range('COMPARABLE', 400, 900, 2_000) })] });
    expect(without.pathways).toHaveLength(0);
    expect(withPartials.pathways).toHaveLength(2);
    expect(withPartials.portfolio).toEqual(without.portfolio);
    expect(withPartials.informationValue).toEqual(without.informationValue);
    expect(withPartials.measures.leadingNetP50).toBe(0);
    for (const one of withPartials.pathways) expect(pathwayProblem(one)).toBeNull();
    // Its moves reach the next actions, so the cheapest way to learn or supply the component is asked.
    expect(withPartials.nextActions.length).toBeGreaterThan(0);
  });
});

describe('B03: the quantity transforms the strategy', () => {
  it('every gap carries a move, cheapest first, and no channel is a construct move', () => {
    const p = partialPathwayOf(arrangement(), ctx);
    for (const gap of p.gaps) expect(p.moves.some((m) => m.gap === gap)).toBe(true);
    expect(p.moves.find((m) => m.gap === 'NO_CHANNEL')?.action).toBe('CONSTRUCT');
    expect(p.moves.find((m) => m.gap === 'NO_PRICE')).toMatchObject({ action: 'RESEARCH', field: 'revenueRange' });
    expect(p.moves.find((m) => m.gap === 'NO_SUPPLIER')?.action).toBe('CONSTRUCT');
  });

  it('a share needing more prospects a day than outreach reaches names REACH_SHORTFALL and changes the channel', () => {
    // A small net at a low close rate, repeating: its tenth of the gap outruns 60 contacts a day.
    const p = partialPathwayOf(arrangement({ design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING' }, value: range('COMPARABLE', 4, 6, 9), supplyCost: range('COMPARABLE', 0.5, 1, 2), conversion: range('COMPARABLE', 0.001, 0.002, 0.004) }), ctx);
    expect(p.fit.lever.variable).toBe('CHANNEL');
    expect(p.gaps).toContain('REACH_SHORTFALL');
    expect(p.moves.some((m) => m.gap === 'REACH_SHORTFALL' && m.action === 'CONSTRUCT')).toBe(true);
    expect(pathwayProblem(p)).toBeNull();
  });
});

describe('B04: one design is read once', () => {
  it('a partial already present is not duplicated', () => {
    const r = readPathways({ modelled: [], considered: [], target, portfolio: null, permissionsMissing: ['SEND_EMAIL'], rounds: [], now: new Date(), partial: [arrangement(), arrangement()] });
    expect(r.pathways).toHaveLength(1);
    expect(r.pathways[0]!.rights.status).toBe('DENIED');
    expect(pathwayProblem(r.pathways[0]!)).toBeNull();
  });
});

describe('P01: a live goal with constructed designs and no opening exposes its pathways', () => {
  let projectId = '';
  let userId = '';
  let layer: Layer;
  const now = new Date();
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

  beforeEach(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    const fixture = await freshProject();
    projectId = fixture.project.id;
    layer = await fixture.layerByName('Discovery Logic');
    userId = (await createUser({ email: `opp4-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  });

  async function sector(name: string, buyer: string): Promise<void> {
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
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
    const [claim] = await insertClaims([{
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: `${buyer} buy in ${name}.`, sourceUrl: `https://example.test/${encodeURIComponent(buyer)}`, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: 'x', evidenceLocator: 'the page', evidenceLane: 'structure', opportunitySignal: null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${buyer}|${name}`,
    }]);
    await decideClaim(claim!.id, { accepted: true });
    const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
    await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: buyer, origin: 'DISCOVERED', sourceClaimId: claim!.id });
  }

  async function goal(): Promise<string> {
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
    expect(
      (await setTarget({
        goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
        capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
      } as Parameters<typeof setTarget>[0])).ok,
    ).toBe(true);
    return g.id;
  }

  it('returns marked pathways instead of none, each passing the probe rule, and counts none of them', async () => {
    await sector('Fleet maintenance', 'Regional fleet operators');
    const id = await goal();
    const reading = (await readGoalPlan({ goalId: id, persist: false, evaluations: 300 }))!;
    expect(reading).not.toBeNull();
    expect(reading.pathways).not.toBeNull();
    const pathways: TransactionPathway[] = reading.pathways!.pathways;
    expect(pathways.length).toBeGreaterThan(0);
    // The production shape: the model refused (no live opening), and before this repair that branch returned no pathways.
    expect(reading.refusal).not.toBeNull();
    expect(pathways.some((p) => p.partial)).toBe(true);
    for (const p of pathways) expect(pathwayProblem(p)).toBeNull();
    for (const p of pathways.filter((one) => one.partial)) {
      expect(p.contribution).toEqual({ p10: 0, p50: 0, p90: 0 });
      expect(reading.pathways!.portfolio.leading?.members ?? []).not.toContain(p.opportunityId);
    }
  });
});
