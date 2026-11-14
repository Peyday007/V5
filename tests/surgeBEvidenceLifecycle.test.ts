/**
 * Evidence lifecycle (lens W, W-11 and W-12).
 *
 * W-11: a claim carried its source, dates and scope but not how its figure was
 * measured, on how many cases, its limits, its validity window or what would
 * void it. These ride the claim now, through `brain_submit_claims`, onto the
 * row, and into the quant Observation the pooler reads.
 *
 * W-12: an observation past its window was excluded outright — a cliff. Now it
 * ages: past the window (its own `valid_until`, else the quantity's default)
 * its information halves every half-life and its interval widens, but it is
 * kept with its time context. Only a recorded invalidation excludes it, with
 * the reason. And refresh is ranked by the plan's own input sensitivity, so
 * research re-asks what could move the strongest plan first.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { findTool } from '../server/mcp/tools.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  claimSources,
  createFragments,
  createOrchestration,
  listClaimsForFragment,
  recordClaimInvalidationMet,
} from '../server/repos/research.ts';
import { validateMeasurement } from '../server/services/research/schema.ts';
import { observationsFor, staleRefreshPriority, type CashKnowledge } from '../server/services/quant/knowledge.ts';
import { ageOf, classify } from '../server/services/quant/pool.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import type { LimitingInput } from '../server/services/quant/portfolio.ts';
import type { Observation, QuantityNode } from '../server/domain/quant.ts';
import type { CashCardFact, CashOpportunity, Principal, WorkerScope } from '../server/domain/types.ts';

const now = new Date('2026-11-14T00:00:00Z');

function opening(id: string): CashOpportunity {
  return {
    id,
    title: `Opening ${id}`,
    mechanism: 'SERVICE_FEE',
    opportunitySignal: 'ACTIVE_BUYER_DEMAND',
    industry: 'dental',
    priceCents: 200_000,
    currency: 'USD',
    duplicateOfId: null,
  } as unknown as CashOpportunity;
}

function fact(id: string, opportunityId: string, value: string, claimId: string | null, field = 'conversionRates'): CashCardFact {
  return { id, projectId: 'p', opportunityId, field, kind: 'RESEARCHED', value, claimId, createdAt: '2026-10-01T00:00:00Z' } as unknown as CashCardFact;
}

function knowledgeOf(opportunities: CashOpportunity[], facts: CashCardFact[], sources: CashKnowledge['sources']): CashKnowledge {
  return {
    projectId: 'p',
    opportunities: new Map(opportunities.map((one) => [one.id, one])),
    facts,
    lessons: [],
    sources,
    estimates: new Map(),
    routeMoney: new Map(),
    routeScores: new Map(),
    routeMoneyError: null,
  } as unknown as CashKnowledge;
}

function source(over: Partial<NonNullable<ReturnType<CashKnowledge['sources']['get']>>>) {
  return { sourceUrl: 'https://example.com/study', sourcePublisher: 'A publisher', sourceDate: '2026-06-01', measurementMethod: null, sampleSize: null, validUntil: null, invalidatedBy: null, invalidationMetAt: null, invalidationNote: null, ...over };
}

const countObs = (id: string, extra: Partial<Observation> = {}): Observation => ({
  id,
  value: { kind: 'COUNT', successes: 40, trials: 200 },
  context: {},
  lineage: [id],
  source: { kind: 'CLAIM', ref: id },
  ...extra,
});

function rateNode(observations: Observation[]): QuantityNode {
  return { key: 'close', label: 'close', unit: 'share', kind: 'RATE', min: 0, max: 1, freshDays: 365, observations };
}

const width = (obs: Observation) => {
  const est = reconstruct({ nodes: [rateNode([obs])] }, 'close', now).estimates['close']!;
  return { est, width: est.p95 - est.p05 };
};

describe('W-11: claim measurement metadata round-trips submission → row → observation', () => {
  let projectId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  it('carries method, sample size, limits, window and invalidation from brain_submit_claims to the quant Observation', async () => {
    const worker = await createWorker({ name: `w11-${Math.random().toString(36).slice(2, 8)}`, displayName: 'reader', createdByType: 'SYSTEM', createdById: 'test' });
    const scopes: WorkerScope[] = ['project:read', 'research:read', 'research:write', 'claims:write', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'];
    const membership = await grantMembership({ projectId, principalType: 'WORKER', principalId: worker.id, role: 'MEMBER', scopes, grantedByType: 'SYSTEM', grantedById: 'test' });
    const principal = {
      type: 'WORKER', id: worker.id, handle: worker.name, displayName: worker.displayName, isBrainAdmin: false, mustChangePassword: false,
      credentialId: 'cred_w11', authMethod: 'WORKER_BEARER', memberships: [membership], requestId: 'req_w11',
    } as unknown as Principal;
    const call = async (name: string, args: Record<string, unknown>) => {
      const found = findTool(name)!;
      return (await found.run(args, { principal, requestId: `req_${Math.random().toString(36).slice(2)}` })).value as Record<string, any>;
    };
    const layer = (await listLayers(projectId))[0]!;
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'close rates' });
    const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Close rates', assignment: 'published close rates', provider: 'WORKER', autoApprove: false });
    const [fragment] = await createFragments([
      {
        orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'close-rate',
        question: 'What close rate do dental service firms report?', geography: 'United States',
        requiredEvidence: [{ id: 'close_rate', description: 'a published close rate', necessity: 'REQUIRED' }],
        acceptableSourceTypes: ['an industry survey'], excludedSourceTypes: ['an unsourced claim'],
        completionCriteria: ['a quoted rate with its date'], minIndependentSources: 1, maxRepairs: 2, dependsOn: [], attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    await getDb().run("UPDATE research_fragments SET status = 'QUEUED' WHERE id = ?", [fragment!.id]);
    await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', requiredScopes: ['claims:write'], orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM', createdById: 'test', payload: {} });
    const claimed = (await call('brain_claim_work', { project_id: projectId, work_types: ['RESEARCH_FRAGMENT'], limit: 1 }))['claimed'][0];

    const base = {
      claim_type: 'SOURCED_FACT', source_url: 'https://example.com/survey', source_title: 'Survey', source_publisher: 'An association',
      source_date: '2026-06-01', evidence_excerpt: 'close rate of 20%', evidence_locator: 'table 2', evidence_lane: 'close_rate',
      retrieved_at: '2026-06-02', confidence: 0.8, primary_source: true,
    };
    // A declared sample must be a whole number: refused before anything is stored.
    await expect(call('brain_submit_claims', {
      work_item_id: claimed.workItemId, lease_id: claimed.leaseId, lease_generation: claimed.leaseGeneration,
      claims: [{ ...base, claim: 'The close rate is 20%.', sample_size: 0 }],
    })).rejects.toThrow(/sample_size/);

    const submitted = await call('brain_submit_claims', {
      work_item_id: claimed.workItemId, lease_id: claimed.leaseId, lease_generation: claimed.leaseGeneration,
      claims: [
        {
          ...base,
          claim: 'Dental service firms report a close rate of 20%.',
          method: 'member survey',
          sample_size: 150,
          limitations: 'self-selected respondents',
          valid_until: '2027-06-30',
          invalidated_by: 'the association reissues the survey',
        },
        // A worker that declares none of it is not refused.
        { ...base, claim: 'Another firm reports a close rate of 25%.', source_url: 'https://example.org/other' },
      ],
    });
    expect(submitted['recorded']).toBe(2);

    const stored = await listClaimsForFragment(fragment!.id);
    const declared = stored.find((one) => one.measurementMethod)!;
    expect(declared).toMatchObject({ measurementMethod: 'member survey', sampleSize: 150, limitations: 'self-selected respondents', validUntil: '2027-06-30', invalidatedBy: 'the association reissues the survey', invalidationMetAt: null });
    const bare = stored.find((one) => !one.measurementMethod)!;
    expect(bare).toMatchObject({ sampleSize: null, validUntil: null, invalidatedBy: null });

    const sources = await claimSources([declared.id]);
    const knowledge = knowledgeOf([opening('A')], [fact('f1', 'A', 'Close rate was 20%.', declared.id)], sources);
    const [obs] = observationsFor(knowledge, 'close', opening('A'));
    expect(obs!.value).toEqual({ kind: 'POINT', value: 0.2, sampleSize: 150 });
    expect(obs!.method).toBe('member survey');
    expect(obs!.validUntil).toBe('2027-06-30');
    expect(obs!.invalidation).toEqual({ condition: 'the association reissues the survey', metAt: null, note: null });

    // The condition is recorded as met: the row keeps everything, the pooler excludes it with the reason.
    expect(await recordClaimInvalidationMet(bare.id, 'no condition declared')).toBeNull();
    const met = await recordClaimInvalidationMet(declared.id, '2027 edition published', '2026-11-01T00:00:00Z');
    expect(met).toMatchObject({ claim: declared.claim, sampleSize: 150, invalidationMetAt: '2026-11-01T00:00:00Z', invalidationNote: '2027 edition published' });
    const after = knowledgeOf([opening('A')], [fact('f1', 'A', 'Close rate was 20%.', declared.id)], await claimSources([declared.id]));
    const node = rateNode(observationsFor(after, 'close', opening('A')));
    const sorted = classify(node, now);
    expect(sorted.direct.length + sorted.comparable.length + sorted.broad.length).toBe(0);
    expect(sorted.excluded[0]!.reason).toMatch(/invalidated: its condition "the association reissues the survey" was recorded as met on 2026-11-01 \(2027 edition published\)/);
  });

  it('applies one rule at both doors', () => {
    const ok = validateMeasurement({ where: 'c', method: ' audited ', sampleSize: 12, limitations: undefined, validUntil: '2027-01-31', invalidatedBy: null });
    expect(ok).toEqual({ ok: true, value: { measurementMethod: 'audited', sampleSize: 12, limitations: null, validUntil: '2027-01-31', invalidatedBy: null } });
    expect(validateMeasurement({ where: 'c', method: null, sampleSize: 2.5, limitations: null, validUntil: null, invalidatedBy: null }).ok).toBe(false);
    expect(validateMeasurement({ where: 'c', method: null, sampleSize: null, limitations: null, validUntil: '2027-02-30', invalidatedBy: null }).ok).toBe(false);
  });
});

describe('W-12: age decays, it does not exclude', () => {
  const fresh = countObs('fresh', { observedAt: '2026-06-01T00:00:00Z' });
  const old = countObs('old', { observedAt: '2023-11-14T00:00:00Z' }); // 3 years: 2 half-lives past a 365-day window

  it('keeps an observation past its default window, down-weighted with a wider interval', () => {
    const a = width(fresh);
    const b = width(old);
    expect(b.est.excluded).toEqual([]);
    expect(b.est.used).toEqual(['old']);
    expect(b.est.tier).not.toBe('UNKNOWN');
    expect(b.width).toBeGreaterThan(a.width);
    const aging = ageOf(old, 365, now);
    expect(aging.windowFrom).toBe('DEFAULT');
    expect(aging.weight).toBeCloseTo(0.25, 2);
    const kept = classify(rateNode([old]), now).direct[0]!;
    const unaged = classify(rateNode([fresh]), now).direct[0]!;
    expect(kept.v).toBeCloseTo(unaged.v / aging.weight, 6);
    expect(kept.adjusted.join(' ')).toMatch(/aged: \d+ days past the 365-day window/);
    // Continuous, not a cliff: a day past the window costs almost nothing.
    expect(ageOf(countObs('edge', { observedAt: '2025-11-13T00:00:00Z' }), 365, now).weight).toBeGreaterThan(0.99);
  });

  it('lets an explicit valid_until override the default window, both ways', () => {
    const declaredCurrent = countObs('old-but-valid', { observedAt: '2023-11-14T00:00:00Z', validUntil: '2027-12-31' });
    expect(ageOf(declaredCurrent, 365, now)).toMatchObject({ windowFrom: 'VALID_UNTIL', weight: 1, pastDays: 0 });
    expect(width(declaredCurrent).width).toBeCloseTo(width(fresh).width, 6);

    const declaredExpired = countObs('fresh-but-expired', { observedAt: '2026-10-01T00:00:00Z', validUntil: '2025-11-14' });
    const aging = ageOf(declaredExpired, 365, now);
    expect(aging.windowFrom).toBe('VALID_UNTIL');
    expect(aging.weight).toBeLessThan(0.51);
    expect(width(declaredExpired).width).toBeGreaterThan(width(fresh).width);
  });

  it('excludes an observation whose invalidation condition is recorded as met, with the reason', () => {
    const voided = countObs('voided', { observedAt: '2026-06-01T00:00:00Z', invalidation: { condition: 'the fee schedule changes', metAt: '2026-10-01T00:00:00Z', note: null } });
    const pending = countObs('pending', { observedAt: '2026-06-01T00:00:00Z', invalidation: { condition: 'the fee schedule changes', metAt: null } });
    const est = reconstruct({ nodes: [rateNode([voided, pending])] }, 'close', now).estimates['close']!;
    expect(est.used).toEqual(['pending']);
    expect(est.excluded).toEqual([{ id: 'voided', reason: 'invalidated: its condition "the fee schedule changes" was recorded as met on 2026-10-01' }]);
  });
});

describe('W-12: refresh is ranked by how much a figure moves the strongest plan', () => {
  it('puts the stale figure behind the plan-moving input first, ahead of an older one the plan barely reads', () => {
    const sources: CashKnowledge['sources'] = new Map([
      // Behind the close rate of A: past its 1095-day window by about a year.
      ['c-close', source({ sourceUrl: 'https://one.example/a', sourceDate: '2022-11-14' })],
      // Behind the reply rate of B: older still, but the plan's reach barely moves with it.
      ['c-reply', source({ sourceUrl: 'https://two.example/b', sourceDate: '2019-11-14' })],
      // Fresh, so never a refresh candidate.
      ['c-fresh', source({ sourceUrl: 'https://three.example/c', sourceDate: '2026-09-01' })],
      // Stale, behind nothing the plan names: listed last, never dropped.
      ['c-orphan', source({ sourceUrl: 'https://four.example/d', sourceDate: '2021-01-01' })],
    ]);
    const knowledge = knowledgeOf(
      [opening('A'), opening('B'), opening('C')],
      [
        fact('fa', 'A', 'Close rate was 20%.', 'c-close'),
        fact('fb', 'B', 'Reply rate was 5%.', 'c-reply'),
        fact('fc', 'A', 'Close rate was 30%.', 'c-fresh'),
        // A cycle time nothing in the plan's limiting inputs reads.
        fact('fd', 'C', 'Cash arrives in 30 days.', 'c-orphan', 'timeToFirstCash'),
      ],
      sources,
    );
    const limiting: LimitingInput[] = [
      { opportunityIds: ['B'], input: 'reply rate', field: 'respond', sensitivity: 0.15, have: { tier: 'COMPARABLE', events: 0, populations: 1, sizedPopulations: 0 }, need: 'reply rate' },
      { opportunityIds: ['A'], input: 'close rate', field: 'close', sensitivity: 0.62, have: { tier: 'COMPARABLE', events: 0, populations: 1, sizedPopulations: 0 }, need: 'close rate' },
    ];
    const ranked = staleRefreshPriority(knowledge, limiting, now);
    expect(ranked.map((one) => one.observationId)).toEqual(['fact:fa', 'fact:fb', 'fact:fd']);
    expect(ranked[0]).toMatchObject({ claimId: 'c-close', quantity: 'close', sensitivity: 0.62, windowFrom: 'DEFAULT' });
    expect(ranked[0]!.weight).toBeLessThan(1);
    expect(ranked[1]).toMatchObject({ claimId: 'c-reply', quantity: 'respond', sensitivity: 0.15 });
    expect(ranked[2]).toMatchObject({ claimId: 'c-orphan', sensitivity: 0, opportunityIds: [] });
    expect(ranked[1]!.pastDays).toBeGreaterThan(ranked[0]!.pastDays);
  });
});
