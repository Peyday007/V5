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
 *          again while its repair is in flight. Once that repair is decided, it is offered
 *          again, which is how attempt 2 of this weakness came to exist. (1) pins it.
 *   cause  Commissioned with no goal, that EVIDENCE finding opened no goal research round, so
 *          production never gained the measurement (2) requires, and every merged repair left
 *          A-10K standing. (3) pins the fix: the finding is attributed to the live goal whose
 *          plan lacks the same evidence, and its commission asks that goal's own search for it.
 *
 * Nothing here lowers a bar: the cases in (2) that must not certify still must not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const discovery = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], answer: null as null | { bucketId: string; candidateId: string; round: number } }));
vi.mock('../server/services/cash/discovery.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/cash/discovery.ts')>();
  return {
    ...original,
    openGoalDiscovery: vi.fn(async (input: Record<string, unknown>) => {
      discovery.calls.push(input);
      return discovery.answer;
    }),
  };
});
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { decideCandidate, upsertCandidate } from '../server/repos/improvement.ts';
import { getInventoryItem, upsertInventory } from '../server/services/operator/inventory.ts';
import { commissionReading, evidenceGapGoal, findingEvidenceKinds, inventoryDeficiencies, readingId } from '../server/services/operator/director.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream, getWorkstream, listLinks } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import { inputSample, toScenarioInput } from '../server/services/quant/export.ts';
import { evaluateGoalPortfolio, inputEvidence, measuredRateInput } from '../server/services/goals/portfolio.ts';
import { conversionState, judgeAcceptance } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { Observation, QuantityNode } from '../server/domain/quant.ts';

const uid = () => Math.random().toString(36).slice(2, 8);
const ctx = { runId: 'opr_a10k', actor: 'test' };

let projectId = '';
let userId = '';

beforeEach(async () => {
  discovery.calls.length = 0;
  discovery.answer = null;
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `own-${uid()}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
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

  it('is offered with its id, blocks the goal and carries the finding\'s own acceptance; silent while repaired, offered again once the repair is decided', async () => {
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

    // That repair is rejected (attempt 1's outcome): the finding is unclaimed again and offered again.
    await decideCandidate(repair.id, 'REJECTED', 'Method research ended FAILED with no accepted claim');
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).toContain(id);

    // Owning it stops the offer: a person or session that took it is the repair.
    expect((await a10k(id, { owner: 'session A' })).ok).toBe(true);
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);
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

  // The bar, not production: this evidence is built here to show what certifies. Production gains it
  // only through the goal's own search, which (3) shows the finding's commission now asks.
  it('certifies only on measured replies and independent sized comparables with margin: conversion is established and the plan is CONFIDENCE_VERIFIED', () => {
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

/* ------------------------------------------------------------------------- */
/* (3) The finding reaches the goal whose plan lacks the evidence             */
/* ------------------------------------------------------------------------- */

describe('(3) A-10K is commissioned against the live goal whose plan lacks conversion evidence, so that goal\'s search measures it', () => {
  const symptom = 'No buyer-validated opening for $10k plan; conversion unmeasured';
  const finding = (id: string) =>
    upsertInventory(
      { id, capability: 'buyer-validated opening', symptom, evidence: 'Production plan read: best candidate reaches the target in 9.2% of worlds, coverage not a probability, no buyer-validated opening.', severity: 'BLOCKING' },
      ctx,
    );

  async function cashGoal(title: string): Promise<string> {
    const g = await createWorkstream({ projectId, title, intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(Date.now() + 24 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId })).ok).toBe(true);
    return g.id;
  }

  /** A not-accepted plan reading, stored the way the plan pass stores one: failed chain links and shortfall sentences. */
  async function planReading(goalId: string, failedLinks: string[], shortfalls: string[]): Promise<void> {
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at)
       VALUES (?, ?, ?, NULL, NULL, 'IMPROVEMENT_REQUIRED', NULL, ?, NULL, ?, ?)`,
      [
        `gpr_${uid()}${uid()}`,
        goalId,
        `d${uid()}`,
        JSON.stringify([{ key: 's1', links: failedLinks.map((link) => ({ link, ok: false })) }]),
        JSON.stringify({ acceptance: { status: 'NOT_ACCEPTED', shortfalls, required: 0.9 } }),
        new Date().toISOString(),
      ],
    );
  }

  beforeEach(async () => {
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const admin = `admin-${uid()}@example.com`;
    await createUser({ email: admin, displayName: 'Admin', password: 'correct horse battery staple 1', isBrainAdmin: true });
    await setImprovementSwitch(false, admin, 'test: no Factory submission from this test');
  });

  it('reads the evidence the finding names in the plan\'s own vocabulary', () => {
    expect(findingEvidenceKinds(symptom)).toEqual(expect.arrayContaining(['CONVERSION', 'BUYER']));
    expect(evidenceGapGoal([{ goalId: 'g_price', kinds: ['PRICE'] }, { goalId: 'g_conv', kinds: ['CONVERSION', 'PRICE'] }], symptom)).toEqual({ goalId: 'g_conv', kinds: ['CONVERSION'] });
    expect(evidenceGapGoal([{ goalId: 'g_price', kinds: ['PRICE'] }], symptom)).toBeNull();
  });

  it('reproduces the cause: with no goal whose plan lacks it, the finding names no goal and its commission opens no goal round', async () => {
    const other = await cashGoal('a plan short only on price');
    await planReading(other, ['OFFER_AND_PRICE'], ['The price is not established.']);
    const id = `A-10K-${uid()}`;
    expect((await finding(id)).ok).toBe(true);
    const offered = (await inventoryDeficiencies()).find((one) => one.source?.ref === id)!;
    expect(offered.diagnosis.goalId).toBeNull();
    expect(offered.intervention).toBe('EVIDENCE');
    const result = await commissionReading(offered, 'opr_a10k');
    expect(result.reason).toContain('the diagnosis names no goal');
    expect(discovery.calls).toHaveLength(0);
  });

  it('no longer happens: the finding is attributed to the goal whose plan lacks conversion, and its commission asks that goal\'s search to measure it', async () => {
    const tenK = await cashGoal('$10k plan');
    await planReading(tenK, ['CONVERSION'], ['Conversion is not established for the best candidate: no buyer has said yes at a measured rate.']);
    const id = `A-10K-${uid()}`;
    expect((await finding(id)).ok).toBe(true);

    const offered = (await inventoryDeficiencies()).find((one) => one.source?.ref === id)!;
    expect(offered.diagnosis.goalId).toBe(tenK);
    expect(offered.diagnosis.observed).toContain(`Goal ${tenK}'s latest plan reading lacks the same evidence (buyer, conversion)`);
    expect(offered.diagnosis.observed).toContain('replies from its outreach (§94) or independent sized comparables');
    // Still evidence, never a guess sent to Factory: no cause is invented and no bar is lowered.
    expect(offered.diagnosis.cause).toBeNull();
    expect(offered.intervention).toBe('EVIDENCE');
    expect(readingId(offered)).toBe(`dfx_inv_${id}`);

    discovery.answer = { bucketId: `goal-${tenK}-x`, candidateId: 'rcd_a10k', round: 1 };
    const result = await commissionReading(offered, 'opr_a10k');
    expect(result).toMatchObject({ ok: true, intervention: 'EVIDENCE', roundCandidateId: 'rcd_a10k', linkedFinding: id });
    expect(result.started).toContain('goal research round rcd_a10k');
    expect(discovery.calls).toHaveLength(1);
    expect((discovery.calls[0]!['goal'] as { id: string }).id).toBe(tenK);
    expect(String(discovery.calls[0]!['diagnosis'])).toContain('conversion unmeasured');
    expect((await listLinks(tenK)).some((l) => l.ref === 'rcd_a10k' && l.relation === 'PURSUES')).toBe(true);
    // The repair is in flight now, so the finding is not offered a second time.
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain(id);
  });
});
