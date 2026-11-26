/**
 * OPP-04 repair, episode 2: a partial arrangement is kept as a marked pathway, never abandoned.
 *
 * Production, 2026-11-26T07:52Z: probe r01.opp-04 read "30 live goal(s) read; none has a
 * pathway". The pathway reading was built only from what the goal's cash model priced — found
 * openings past its gates and constructed arrangements `selectEstimatedArrangements` could price —
 * so a goal whose designs were all cut as "nothing reconstructs its value" had no pathway at all.
 * S-0061: "An unknown is not an automatic favorable assumption or a reason to abandon a partial
 * arrangement. Brain should construct the cheapest path to learn or supply the missing component."
 *
 *   R01 — the pure builder: an unpriced design becomes a pathway whose every input is marked
 *         (unknowns state no value), that passes the probe's own rule, and that contributes nothing.
 *   R02 — `partialPathways` skips what the model already read, a design whose worst case exceeds
 *         the limits, and stays bounded.
 *   R03 — `readPathways` over no modelled opening but partial arrangements returns pathways, their
 *         moves follow every modelled move, and the portfolio reads no money from them.
 *   R04 — without `partial`, the reading is exactly what it was.
 *   R05 — the id prefix matches the model's own.
 *   R06 — readGoalPlan on a live goal whose designs nothing prices returns marked pathways.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PARTIAL_PATHWAYS, PARTIAL_ARRANGEMENT_ID_PREFIX, partialArrangementOpening, partialPathways, pathwayOf, readPathways } from '../server/services/goals/pathways.ts';
import { pathwayProblem } from '../server/services/factory/program/release01/pathwaysProbe.ts';
import { ARRANGEMENT_ID_PREFIX, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { ConstructedArrangement, Primitive } from '../server/services/cash/construct.ts';
import type { CashOpportunity } from '../server/domain/types.ts';
import { freshProject } from './helpers.ts';
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

const now = new Date();
const buyer = (key: string): Primitive => ({ name: `owner-operated trade firms ${key}`, claimId: null, from: 'INDUSTRY_MAP', ref: `n_${key}`, path: `BUYER:${key}` }) as Primitive;
const need = { name: 'quarterly marketing report', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_rep', path: 'NEED:rep' } as Primitive;

function arrangement(key: string, over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key,
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'trades',
    demand: buyer(key),
    need,
    supply: null,
    label: `Arrangement ${key}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 0,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['value', 'buyers'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    ...over,
  } as ConstructedArrangement;
}

const ctx = { projectId: 'prj_opp04', remaining: 10_000, daysLeft: 30, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[], now };

describe('R01: an unpriced design is a marked pathway', () => {
  for (const repeat of ['RECURRING_COHORT', 'ONE_OFF'] as const) {
    it(`marks every input and passes the probe rule (${repeat})`, () => {
      const a = arrangement(`k_${repeat}`, { design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat } as ConstructedArrangement['design'] });
      const [p] = partialPathways([a], new Set(), ctx);
      expect(p).toBeDefined();
      expect(pathwayProblem(p!)).toBeNull();
      expect(p!.origin).toBe('CONSTRUCTED');
      expect(p!.opportunityId).toBe(`arr_${a.key}`);
      expect(p!.revenuePerDeal.status).toBe('UNKNOWN');
      expect(p!.revenuePerDeal.value).toBeNull();
      expect(p!.net.status).toBe('UNKNOWN');
      expect(p!.net.value).toBeNull();
      expect(p!.counts.proven + p!.counts.estimated + p!.counts.unknown).toBe(14);
      // The missing component is named, and a move to learn or supply it is offered.
      expect(p!.gaps).toContain('NO_PRICE');
      expect(p!.moves.some((m) => m.action === 'RESEARCH' || m.action === 'CONSTRUCT')).toBe(true);
      // An unknown is never read as money.
      expect(p!.contribution).toEqual({ p10: 0, p50: 0, p90: 0 });
      expect(p!.gross).toEqual({ p10: 0, p50: 0, p90: 0 });
    });
  }

  it('states only what the design itself states: a one-off is one deal, nothing else is a number', () => {
    const one = partialArrangementOpening(arrangement('k1', { design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'ONE_OFF' } as ConstructedArrangement['design'] }), ctx);
    for (const k of ['price', 'capital', 'hours', 'daysToCash', 'close', 'respond', 'directCost'] as const) {
      expect(one[k].value).toBeNull();
      expect(one[k].low).toBeNull();
      expect(one[k].high).toBeNull();
      expect(one[k].provenance).toBe('UNKNOWN');
    }
    expect(one.volume.value).toBe(1);
    expect(one.estimated?.arrangementKey).toBe('k1');
  });
});

describe('R02: partialPathways keeps what the model did not read, and stays bounded', () => {
  it('skips modelled designs, those whose worst case exceeds the limits, and duplicates', () => {
    const a = arrangement('aa');
    const b = arrangement('bb');
    const c = arrangement('cc', { stress: { exposure: 'EXCEEDS', worstCaseCents: 1, failures: [] } as unknown as ConstructedArrangement['stress'] });
    const out = partialPathways([a, b, b, c], new Set(['arr_aa']), ctx);
    expect(out.map((p) => p.opportunityId)).toEqual(['arr_bb']);
  });

  it('reads at most the limit', () => {
    const many = Array.from({ length: MAX_PARTIAL_PATHWAYS + 5 }, (_, i) => arrangement(`m${i}`));
    expect(partialPathways(many, new Set(), ctx)).toHaveLength(MAX_PARTIAL_PATHWAYS);
    expect(partialPathways(many, new Set(), { ...ctx, limit: 3 })).toHaveLength(3);
  });
});

const target = { remainingCents: 1_000_000, daysLeft: 30, currency: 'USD', capitalCeilingCents: null, capitalBeforeProofCents: 37_500 };

function opening(): ModelledOpportunity {
  const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
  const o = {
    id: 'cop_found', projectId: 'prj_opp04', title: 'Reports for regional contractors', mechanism: 'BROKERED_SERVICE', industry: null,
    payer: 'Regional contractors', reachableChannel: 'published business email', buyingSignal: 'posted asking for it', signalObservedAt: null,
    offerScope: 'one report', priceCents: 50_000, currency: 'USD', fulfillmentOwner: 'A named supplier', economicsNote: null, expiresAt: null,
    requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD',
  } as unknown as CashOpportunity;
  return {
    opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: false, price: evidence(500), capital: evidence(0), hours: evidence(0), daysToCash: evidence(9),
    close: evidence(0.2), respond: evidence(0.05), directCost: evidence(100), volume: evidence(1), agreed: false, agreedValue: 0, agreedDeals: 0,
    fulfilledBy: null, competitiveAward: false,
  } as unknown as ModelledOpportunity;
}

describe('R03: readPathways keeps partial arrangements', () => {
  it('returns marked pathways for a goal the model priced nothing for', () => {
    const reading = readPathways({ modelled: [], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now, partial: { projectId: 'prj_opp04', arrangements: [arrangement('p1'), arrangement('p2')] } });
    expect(reading.pathways.map((p) => p.opportunityId)).toEqual(['arr_p1', 'arr_p2']);
    for (const p of reading.pathways) expect(pathwayProblem(p)).toBeNull();
    expect(reading.measures.pathways).toBe(2);
    expect(reading.measures.constructed).toBe(2);
    expect(reading.measures.facts.unknown).toBeGreaterThan(0);
    expect(reading.portfolio.leading).toBeNull();
    expect(reading.informationValue).toEqual([]);
    expect(reading.nextActions.length).toBeGreaterThan(0);
  });

  it('leaves a goal with modelled pathways exactly as it was', () => {
    const base = readPathways({ modelled: [opening()], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now });
    const withPartial = readPathways({ modelled: [opening()], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now, partial: { projectId: 'prj_opp04', arrangements: [arrangement('p1')] } });
    expect(withPartial).toEqual(base);
    expect(withPartial.pathways.map((p) => p.opportunityId)).toEqual(['cop_found']);
  });
});

describe('R04: without partial arrangements the reading is unchanged', () => {
  it('reads the same pathways as before', () => {
    const a = readPathways({ modelled: [opening()], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now });
    const b = readPathways({ modelled: [opening()], considered: [], target, portfolio: null, permissionsMissing: [], rounds: [], now, partial: null });
    expect(b).toEqual(a);
    expect(a.pathways).toEqual([pathwayOf(opening(), null, { remaining: 10_000, daysLeft: 30, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [], now, capabilities: null })]);
  });
});

describe('R05: the id prefix is the model\'s own', () => {
  it('matches ARRANGEMENT_ID_PREFIX', () => {
    expect(PARTIAL_ARRANGEMENT_ID_PREFIX).toBe(ARRANGEMENT_ID_PREFIX);
  });
});

describe('R06: readGoalPlan on a live goal whose designs nothing prices', () => {
  let projectId = '';
  let userId = '';
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

  beforeEach(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    const fixture = await freshProject();
    projectId = fixture.project.id;
    const layer = await fixture.layerByName('Discovery Logic');
    userId = (await createUser({ email: `opp04-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    // One buyer population on the project's map, with no price anywhere: every design over it is unpriced.
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
      claim: 'Independent dental practices buy in Dental care.', sourceUrl: 'https://example.test/dental', sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: 'x', evidenceLocator: 'the page', evidenceLane: 'structure', opportunitySignal: null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: 'dental|care',
    }]);
    await decideClaim(claim!.id, { accepted: true });
    const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Dental care', origin: 'SEED' });
    await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: 'Independent dental practices', origin: 'DISCOVERED', sourceClaimId: claim!.id });
  });

  it('returns pathways, every one of them marked as the probe requires', async () => {
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
    expect(
      (await setTarget({
        goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
        capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
      } as Parameters<typeof setTarget>[0])).ok,
    ).toBe(true);
    const reading = (await readGoalPlan({ goalId: g.id, persist: false, evaluations: 500 }))!;
    expect(reading.pathways).not.toBeNull();
    const pathways = reading.pathways!.pathways;
    expect(pathways.length).toBeGreaterThan(0);
    for (const p of pathways) expect(pathwayProblem(p)).toBeNull();
    // Nothing prices these buyers, so none of it is read as money.
    expect(pathways.some((p) => p.revenuePerDeal.status === 'UNKNOWN' && p.revenuePerDeal.value === null)).toBe(true);
  });
});
