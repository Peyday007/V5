/**
 * GOAL_PLAN.CONSTRUCTION.ROUNDS_FILE#2: a constructed round's pattern files an
 * opening when the claim itself says who pays — on the fragment shape
 * production actually compiles for a constructed round.
 *
 * Production read 0 of 27 constructed rounds filing ("pattern claims with no
 * payer"; "round abandoned"): the worker described the repeating buyers in the
 * `demand_pattern` lane without saying anybody pays, and `signalledClaims`
 * reads an untagged pattern only where its own text says buyers pay, so the
 * round filed nothing. The fix is in the question (`PATTERN_PAYER_SENTENCE`,
 * construct.ts): the claim is asked to name who pays. The fragment here
 * declares exactly the lanes `GOAL_MECHANISM` compiles for a goal round — the
 * profile has no `payer` lane, so a payer can only reach the harvest inside
 * the pattern claim — and a guard below fails if the fixture ever declares a
 * lane that profile does not.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { harvest, openConstructedRound } from '../server/services/cash/discovery.ts';
import { PATTERN_PAYER_SENTENCE } from '../server/services/cash/construct.ts';
import { goalMechanismProfile } from '../server/services/russell/compilerProfiles.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
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
  userId = (await createUser({ email: `cpp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

async function goal() {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return (await getWorkstream(g.id))!;
}

type Claim = { claim: string; lane: string; sourceUrl: string; claimType?: 'SOURCED_FACT' | 'NEGATIVE_EXISTENCE' };

/** The lanes production compiles for a goal's own round (compiler.ts, `goalMechanismProfile`). */
const GOAL_LANES = goalMechanismProfile('RUSSELL_CASH_DISCOVERY_V1')!.lanes.map((lane) => ({ id: lane.id, description: lane.description, necessity: lane.necessity }));

/** A packet behind a constructed round's idea, with one fragment declaring the lanes production compiles for it. */
async function packet(candidateId: string) {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: GOAL_LANES,
      acceptableSourceTypes: ['a case study'], excludedSourceTypes: ['a forecast'], completionCriteria: ['two dated examples'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'market-signal', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${candidateId}`, candidateId } as Parameters<typeof launchMission>[0]);
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  const gate = async (claims: Claim[]) => {
    await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
    const inserted = await insertClaims(claims.map((one) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A case study', sourcePublisher: 'A trade journal', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: one.claim, evidenceLocator: 'the page', evidenceLane: one.lane, opportunitySignal: null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: one.claimType ?? ('SOURCED_FACT' as const), contentHash: `${candidateId}|${one.claim}|${one.sourceUrl}`,
    })));
    for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  };
  const end = (to: 'DONE' | 'NEEDS_HUMAN', from: 'RUNNING' | 'NEEDS_HUMAN' = 'RUNNING') =>
    transitionMission({ missionId: mission.id, from, to, terminalReason: to === 'DONE' ? null : 'stopped', waitingOn: to === 'NEEDS_HUMAN' ? 'a person' : null });
  return { gate, end };
}

// A pattern with two dated examples and no buying word: the recorded class.
const PATTERN = 'HVAC firms repeatedly use outside agencies to set up AI receptionists (examples March 2026 and May 2026).';
// The same pattern written as PATTERN_PAYER_SENTENCE asks: who pays, that they pay, for what, at what price.
const ASKED = 'Residential HVAC firm owners repeatedly pay outside agencies $1,500 to set up AI receptionists (examples March 2026 and May 2026).';

const roundOf = async (candidateId: string) => (await listRounds(projectId)).find((one) => one.candidateId === candidateId)!;
const filedAs = async (text: string) => (await listOpportunities({ projectId })).filter((one) => (one.buyingSignal ?? '') === text);

describe("a constructed round's pattern files when the claim says who pays (GOAL_PLAN.CONSTRUCTION.ROUNDS_FILE#2)", () => {
  it('the fixture fragment is one production compiles: GOAL_MECHANISM lanes only, and no payer lane among them', () => {
    const ids = GOAL_LANES.map((lane) => lane.id);
    expect(ids).toContain('demand_pattern');
    expect(ids).not.toContain('payer');
  });

  it('reproduces the recorded failure: a pattern that names no payer files nothing and the round finds 0', async () => {
    const w = await goal();
    const r = await openConstructedRound({ goal: w, projectId, key: 'hvac0', title: 'Constructed: AI receptionist setup for HVAC firms', question: 'Which HVAC firms pay for AI receptionist setup?' });
    expect(r).not.toBeNull();
    const p = await packet(r!.candidateId);
    await p.gate([{ claim: PATTERN, lane: 'demand_pattern', sourceUrl: 'https://example.test/hvac/case-studies' }]);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await filedAs(PATTERN)).toHaveLength(0);
    expect(await roundOf(r!.candidateId)).toMatchObject({ state: 'HARVESTED', found: 0 });
  });

  it('files one opening, attributed to the round, for the pattern written as the question asks', async () => {
    expect(PATTERN_PAYER_SENTENCE).toMatch(/names who pays and says that they pay/);
    const w = await goal();
    const r = await openConstructedRound({ goal: w, projectId, key: 'hvac1', title: 'Constructed: AI receptionist setup for HVAC firms', question: 'Which HVAC firms pay for AI receptionist setup?' });
    expect(r).not.toBeNull();
    const p = await packet(r!.candidateId);
    // The mission parks, so the round settles ABANDONED before the claims are gated.
    await p.end('NEEDS_HUMAN');
    await harvest({ projectId });
    expect(await roundOf(r!.candidateId)).toMatchObject({ state: 'ABANDONED', found: 0 });
    await p.gate([{ claim: ASKED, lane: 'demand_pattern', sourceUrl: 'https://example.test/hvac/case-studies' }]);
    await p.end('DONE', 'NEEDS_HUMAN');
    await harvest({ projectId });

    const filed = await filedAs(ASKED);
    expect(filed).toHaveLength(1);
    const opening = filed[0]!;
    expect(opening.opportunitySignal).toBe('RECURRING_OUTSOURCED_WORK');
    expect(opening.discoveredByCandidateId).toBe(r!.candidateId);
    expect(opening.discoveryRoundId).toBe((await roundOf(r!.candidateId)).id);
    expect(await roundOf(r!.candidateId)).toMatchObject({ state: 'ABANDONED', found: 1 });

    // A second pass files nothing more.
    await harvest({ projectId });
    expect(await filedAs(ASKED)).toHaveLength(1);
  });

  it('files nothing for a documented absence in the pattern lane', async () => {
    const w = await goal();
    const r = await openConstructedRound({ goal: w, projectId, key: 'hvac2', title: 'Constructed: AI receptionist setup for HVAC firms', question: 'Which HVAC firms pay for AI receptionist setup?' });
    const p = await packet(r!.candidateId);
    const ABSENCE = 'No published source shows HVAC firms paying anyone for this setup.';
    await p.gate([{ claim: ABSENCE, lane: 'demand_pattern', sourceUrl: 'https://example.test/hvac/none', claimType: 'NEGATIVE_EXISTENCE' }]);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await filedAs(ABSENCE)).toHaveLength(0);
    expect(await roundOf(r!.candidateId)).toMatchObject({ state: 'HARVESTED', found: 0 });
  });

  it("files nothing for a seller's own page, even worded as buyers paying", async () => {
    const w = await goal();
    const r = await openConstructedRound({ goal: w, projectId, key: 'hvac3', title: 'Constructed: AI receptionist setup for HVAC firms', question: 'Which HVAC firms pay for AI receptionist setup?' });
    const p = await packet(r!.candidateId);
    const SELLER = 'HVAC firms pay us $1,500 to set up an AI receptionist that answers calls around the clock.';
    await p.gate([{ claim: SELLER, lane: 'demand_pattern', sourceUrl: 'https://receptionist.example.test/pricing' }]);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await filedAs(SELLER)).toHaveLength(0);
    expect(await roundOf(r!.candidateId)).toMatchObject({ state: 'HARVESTED', found: 0 });
  });
});
