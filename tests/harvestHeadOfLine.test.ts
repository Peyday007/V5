/**
 * W17 (production 2026-11-17, goal wst_7b4fcbb5f2384f31b6c3): newly accepted
 * goal claims never became openings. `signalledClaims` read the oldest
 * `limit` candidate rows in SQL and only then dropped, in code, the ones that
 * can never be filed (a seller's own price page in an untagged lane). Nothing
 * marks a dropped row, so it is read again on every pass: once a project holds
 * a window's worth of them, every later claim — a constructed round's opening
 * included — is behind them for ever and the harvest files nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, signalledClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings } from '../server/services/goals/plan.ts';
import { harvest, openConstructedRound } from '../server/services/cash/discovery.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { getDb } from '../server/db/database.ts';
import type { Layer } from '../server/domain/types.ts';

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
  userId = (await createUser({ email: `hol-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

async function goal(): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return g.id;
}

/** One finished packet behind a constructed round, holding accepted untagged demand_pattern claims, oldest first. */
async function packet(candidateId: string, claims: { text: string; url: string }[]): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: 'demand_pattern', description: 'buyers repeatedly paying', necessity: 'CONDITIONAL' }],
      acceptableSourceTypes: ['a price page'], excludedSourceTypes: ['a forecast'], completionCriteria: ['two dated examples'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'market-signal', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  for (const one of claims) {
    const [claim] = await insertClaims([{
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.text, sourceUrl: one.url, sourceTitle: 'A page', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: 'x', evidenceLocator: 'the page', evidenceLane: 'demand_pattern', opportunitySignal: null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${candidateId}|${one.url}`,
    }]);
    await decideClaim(claim!.id, { accepted: true });
  }
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${candidateId}`, candidateId });
  await getDb().run('UPDATE russell_missions SET orchestration_id = ? WHERE id = ?', [orchestration.id, mission.id]);
}

describe('claims the harvest can never file do not hold back the claims behind them', () => {
  it('files a constructed round’s new pattern claim behind more than a window of sellers’ own price pages', async () => {
    const w = (await getWorkstream(await goal()))!;
    const older = await openConstructedRound({ goal: w, projectId, key: 'old1', title: 'Constructed: vendor rate cards', question: 'Which buyers pay for vendor rate cards?' });
    expect(older).not.toBeNull();
    // Production shape: an untagged demand_pattern claim from a seller's own price page — gated, accepted, never an opening.
    await packet(
      older!.candidateId,
      Array.from({ length: 45 }, (_, i) => ({ text: `Buyers pay Vendor${i} 49 USD per month for its plan.`, url: `https://vendor${i}.example.test/pricing` })),
    );
    const newer = await openConstructedRound({ goal: w, projectId, key: 'gpo1', title: 'Constructed: group purchasing for small offices', question: 'Which small offices pay for pooled purchasing?' });
    expect(newer).not.toBeNull();
    await packet(newer!.candidateId, [
      { text: 'Dental practices repeatedly pay purchasing cooperatives an annual fee to pool supply orders (examples March 2026 and May 2026).', url: 'https://dentaleconomics.example.test/coops-2026' },
    ]);

    // The read itself must reach past what it will drop, rather than return a window of nothing.
    const read = await signalledClaims({ projectId, limit: 40 });
    expect(read.map((one) => one.claim.claim)).toContain('Dental practices repeatedly pay purchasing cooperatives an annual fee to pool supply orders (examples March 2026 and May 2026).');

    await harvest({ projectId, limit: 10 });
    const openings = await listOpportunities({ projectId });
    expect(openings.some((one) => (one.buyingSignal ?? '').startsWith('Dental practices repeatedly pay'))).toBe(true);
    // And the sellers' own pages are still not openings.
    expect(openings.some((one) => (one.buyingSignal ?? '').startsWith('Buyers pay Vendor'))).toBe(false);
  });
});
