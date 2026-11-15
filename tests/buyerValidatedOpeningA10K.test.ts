/**
 * Finding A-10K and the inventory commissioning class it came through
 * (OPERATOR:MISSING_CAPABILITY:e3c7e6c0fade6db6).
 *
 *   A-10K  "No buyer-validated opening for $10k plan; conversion unmeasured". It is
 *          an evidence gap, not a code defect (docs/INTELLIGENCE-RECOVERY-2026-11-14.md):
 *          it closes only by measurement (outreach replies, §94) or sourced comparables.
 *          (2) pins that path. No conversion an assumption, an unsized rate or a single
 *          population states ever certifies an opening. Independent sized comparables
 *          with margin do.
 *   class  An unowned, unrepaired BLOCKING finding is read by `inventoryDeficiencies` as
 *          a MISSING_CAPABILITY deficiency, commissionable by its id. It is not offered
 *          again while its repair is in flight, nor after that repair is REJECTED, REVERTED or
 *          KEPT_NO_EFFECT (directly or through a combined host) while the finding still states no cause (attempt 2 of this weakness came from that re-offer).
 *          Once its cause is confirmed it is offered again, with the cause. (1) pins it.
 *
 * Nothing here lowers a bar: the cases in (2) that must not certify still must not.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { decideCandidate, upsertCandidate } from '../server/repos/improvement.ts';
import { getInventoryItem, upsertInventory } from '../server/services/operator/inventory.ts';
import { inventoryDeficiencies, readingId } from '../server/services/operator/director.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import { inputSample, toScenarioInput } from '../server/services/quant/export.ts';
import { evaluateGoalPortfolio, inputEvidence, measuredRateInput } from '../server/services/goals/portfolio.ts';
import { conversionState, judgeAcceptance } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { Observation, QuantityNode } from '../server/domain/quant.ts';

const uid = () => Math.random().toString(36).slice(2, 8);
const ctx = { runId: 'opr_a10k', actor: 'test' };

beforeEach(async () => {
  await freshProject();
  await createUser({ email: `own-${uid()}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
});

describe('(1) an unowned BLOCKING finding like A-10K is a commissionable MISSING_CAPABILITY deficiency until a repair is in flight', () => {
  const a10k = (id: string, over: Record<string, unknown> = {}) =>
    upsertInventory(
      {
        id,
        capability: 'buyer-validated opening',
        symptom: 'No buyer-validated opening for $10k plan; conversion unmeasured',
        evidence: 'Production plan read: best candidate reaches the target in 9.2% of worlds, coverage not a probability, no buyer-validated opening.',
        severity: 'BLOCKING',
        ...over,
      },
      ctx,
    );

  it('is offered with its id, blocks the goal and carries the finding\'s own acceptance; silent while repaired, silent after a rejected repair until its cause is confirmed', async () => {
    const id = `A-10K-${uid()}`;
    expect((await a10k(id)).ok).toBe(true);
    expect((await getInventoryItem(id))!.status).toBe('DISCOVERED');

    const offered = (await inventoryDeficiencies()).find((one) => one.source?.ref === id);
    expect(offered).toBeDefined();
    expect(readingId(offered!)).toBe(`dfx_inv_${id}`);
    expect(offered!.diagnosis.deficiency).toBe('MISSING_CAPABILITY');
    expect(offered!.diagnosis.blocksGoal).toBe(true);
    expect(offered!.diagnosis.observed).toContain('No buyer-validated opening for $10k plan');
    expect(offered!.diagnosis.observed).toContain('Nobody owns it and no repair is in flight');
    expect(offered!.diagnosis.acceptance).toContain(`A test reproduces finding ${id}`);
    // A DISCOVERED finding states no cause: the diagnosis does not invent one.
    expect(offered!.diagnosis.cause).toBeNull();

    // A repair is commissioned and linked: the finding is in flight and not offered again.
    const repair = (await upsertCandidate({
      weaknessKey: `OPERATOR:MISSING_CAPABILITY:${uid()}`, kind: 'OPERATOR:MISSING_CAPABILITY', title: 'repair A-10K', problem: 'p', metric: 'RESEARCH_JOB_SUCCESS_RATE', downstreamMetric: null,
      ownerComponent: `operator:MISSING_CAPABILITY:${uid()}`, frequency: 1, denominator: 1, scope: 'GENERAL', severity: 'MEDIUM', evidence: {},
    })).candidate;
    expect((await a10k(id, { linkedCandidateId: repair.id })).ok).toBe(true);
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);

    // That repair is rejected (attempt 1's outcome) and the finding still states no cause. Offering it
    // again would commission attempt N+1 on the same unanswerable question, which is how A-10K kept
    // returning to the Factory as an engineering repair. It is not offered again.
    await decideCandidate(repair.id, 'REJECTED', 'Method research ended FAILED with no accepted claim');
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);

    // Once its cause is confirmed, the next attempt has something to act on: offered again, carrying the cause.
    const cause = 'Evidence gap: no measured buyer conversion and no sized comparables; closes by §94 outreach replies.';
    expect((await a10k(id, { rootCause: cause, status: 'ROOT_CAUSE_CONFIRMED' })).ok).toBe(true);
    const reoffered = (await inventoryDeficiencies()).find((one) => one.source?.ref === id);
    expect(reoffered).toBeDefined();
    expect(reoffered!.diagnosis.cause).toBe(cause);

    // Owning it stops the offer: a person or session that took it is the repair.
    expect((await a10k(id, { owner: 'session A' })).ok).toBe(true);
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);
  });

  // Every decision that says a repair did not fix it holds a causeless finding back, not only REJECTED:
  // a repair the improvement loop REVERTED or KEPT_NO_EFFECT, or one COMBINED into a host that was
  // rejected, would otherwise commission attempt N+1 on the same rows — the loop that kept A-10K
  // coming back as engineering work.
  const repairRow = async () =>
    (await upsertCandidate({
      weaknessKey: `OPERATOR:MISSING_CAPABILITY:${uid()}`, kind: 'OPERATOR:MISSING_CAPABILITY', title: 'repair A-10K', problem: 'p', metric: 'RESEARCH_JOB_SUCCESS_RATE', downstreamMetric: null,
      ownerComponent: `operator:MISSING_CAPABILITY:${uid()}`, frequency: 1, denominator: 1, scope: 'GENERAL', severity: 'MEDIUM', evidence: {},
    })).candidate;

  for (const decision of ['REVERTED', 'KEPT_NO_EFFECT'] as const) {
    it(`is not re-offered after a repair decided ${decision} while it still states no cause; a confirmed cause re-offers it`, async () => {
      const id = `A-10K-${uid()}`;
      const repair = await repairRow();
      expect((await a10k(id, { linkedCandidateId: repair.id })).ok).toBe(true);
      expect(await decideCandidate(repair.id, decision, `measured: ${decision}`)).toBe(true);
      expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);

      const cause = 'Evidence gap: no measured buyer conversion; closes by §94 outreach replies.';
      expect((await a10k(id, { rootCause: cause, status: 'ROOT_CAUSE_CONFIRMED' })).ok).toBe(true);
      expect((await inventoryDeficiencies()).find((one) => one.source?.ref === id)?.diagnosis.cause).toBe(cause);
    });
  }

  it('is not re-offered when its repair was COMBINED into a host that was then rejected', async () => {
    const id = `A-10K-${uid()}`;
    const host = await repairRow();
    const repair = await repairRow();
    expect((await a10k(id, { linkedCandidateId: repair.id })).ok).toBe(true);
    expect(await decideCandidate(repair.id, 'COMBINED', 'same owner', { combinedIntoId: host.id })).toBe(true);
    // The host is still undecided: in flight, not offered.
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);
    expect(await decideCandidate(host.id, 'REJECTED', 'no cause stated')).toBe(true);
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);
  });

  it('a causeless finding whose repair was only HELD is not held back by this rule (HELD is not a verdict on the fix)', async () => {
    const id = `A-10K-${uid()}`;
    const repair = await repairRow();
    expect((await a10k(id, { linkedCandidateId: repair.id })).ok).toBe(true);
    expect(await decideCandidate(repair.id, 'HELD', 'closed unmerged', { heldOn: 'dependency' })).toBe(true);
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).toContain(id);
  });
});

/* ------------------------------------------------------------------------- */
/* (2) A-10K closes on measured or sized evidence, never on assumption        */
/* ------------------------------------------------------------------------- */

const now = new Date('2026-11-15T00:00:00Z');
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

function inferred(key: string, values: Observation['value'][], opts: { sameOpportunity?: boolean } = {}): ModelInput {
  const node: QuantityNode = {
    key,
    label: key,
    unit: 'share',
    kind: 'RATE',
    min: 0,
    max: 1,
    context: { opportunity: 'target', mechanism: 'SERVICE_FEE', industry: 'dental' },
    material: ['mechanism'],
    freshDays: 1095,
    observations: values.map((value, i) => ({
      id: `${key}-src${i}`,
      value,
      context: opts.sameOpportunity ? { opportunity: 'target', mechanism: 'SERVICE_FEE', industry: 'dental' } : { opportunity: `other${i}`, mechanism: 'SERVICE_FEE', industry: `industry${i}` },
      lineage: [`url:publisher${i}.example/study`],
      source: { kind: 'CLAIM' as const, ref: `claim-${key}-${i}` },
      observedAt: '2026-06-01T00:00:00Z',
    })),
  };
  const est = reconstruct({ nodes: [node] }, key, now).estimates[key]!;
  const exported = toScenarioInput(est);
  return {
    value: null,
    low: est.p05,
    high: est.p95,
    provenance: exported.provenance,
    source: exported.sources[0] ?? null,
    note: `inferred: ${exported.note}`,
    distribution: exported.spec,
    inferred: { tier: est.tier, justified: exported.provenance === 'EVIDENCE', p10: est.p10, p50: est.p50, p90: est.p90, observations: est.used.length, ...inputSample(est) },
  };
}
const counts = (key: string, pairs: Array<[number, number]>) => inferred(key, pairs.map(([successes, trials]) => ({ kind: 'COUNT' as const, successes, trials })));

function opening(over: Partial<ModelledOpportunity>): ModelledOpportunity {
  return {
    opportunity: { id: 'cop_a10k', title: '$10k plan opening', projectId: 'p' } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close: fixed(0.2),
    respond: fixed(0.2),
    directCost: fixed(10),
    volume: fixed(500),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

/** The $10k plan: $10,000 kept in 24 days, 100 emails a day. */
const plan10k = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '100 emails a day from three warmed mailboxes', worlds: 2000, seed: 11, knowledge: null };

function judge(one: ModelledOpportunity) {
  const portfolio = evaluateGoalPortfolio({ ...plan10k, openings: [one] });
  const missing = conversionState(one).state === 'NONE' ? (['CONVERSION'] as const) : [];
  return { portfolio, acceptance: judgeAcceptance({ achieved: false, chosen: null, portfolio, measuredChance: null, considered: [{ opportunityId: 'cop_a10k', missing: [...missing] }] }) };
}

describe('(2) A-10K: a $10k opening is buyer-validated only on measured or sized conversion evidence', () => {
  const unvalidated: Array<[string, ModelInput]> = [
    ['conversion unmeasured: an assumed range', { value: null, low: 0.1, high: 0.3, provenance: 'ASSUMPTION', source: null, note: 'a person said so' }],
    ['a fixed rate with no stated sample', fixed(0.2)],
    ['unsized published rates only', inferred('close', [{ kind: 'POINT', value: 0.2 }, { kind: 'POINT', value: 0.22 }, { kind: 'POINT', value: 0.18 }])],
    ['an unsized published range', inferred('close', [{ kind: 'RANGE', low: 0.1, high: 0.25 }], { sameOpportunity: true })],
    ['a single comparable population', counts('close', [[400, 2000]])],
  ];
  for (const [label, close] of unvalidated) {
    it(`reproduces A-10K — ${label}: conversion is not established and the plan is not accepted`, () => {
      expect(inputEvidence(close, 'close').establishes).toBe(false);
      expect(conversionState(opening({ close })).state).toBe('NONE');
      const { portfolio, acceptance } = judge(opening({ close, respond: counts('respond', [[40, 200], [44, 200], [38, 200]]) }));
      expect(portfolio.assurance?.claimsAtLeast90).toBe(false);
      expect(acceptance.status).not.toBe('ACCEPTED');
      expect(acceptance.verdict).toBe('IMPROVEMENT_REQUIRED');
    });
  }

  it('no longer happens on measured replies and independent sized comparables with margin: conversion is established and the plan is CONFIDENCE_VERIFIED', () => {
    const respond = measuredRateInput({ trials: 1200, low: 216, high: 252 });
    const close = counts('close', [[40, 200], [46, 200], [36, 200], [42, 210], [39, 190]]);
    expect(inputEvidence(respond, 'respond')).toMatchObject({ tier: 'HISTORICAL', establishes: true });
    expect(inputEvidence(close, 'close')).toMatchObject({ tier: 'COMPARABLE', establishes: true, sizedPopulations: 5 });
    expect(conversionState(opening({ close, respond })).state).not.toBe('NONE');
    const { portfolio, acceptance } = judge(opening({ close, respond }));
    expect(portfolio.assurance?.status).toBe('CLAIMS_AT_LEAST_90');
    expect(acceptance.status).toBe('ACCEPTED');
    expect(acceptance.verdict).toBe('CONFIDENCE_VERIFIED');
    expect(acceptance.probability!.lowerBound).toBeGreaterThanOrEqual(0.9);
  });
});
