/**
 * Knowledge expands as a normal capability, not only inside a sprint
 * (adversarial findings F7 and F5, 2026-11-15).
 *
 * F7: a constructed arrangement's research round — and with it the
 * arrangement library's `asked_count` and research verdicts — opens under the
 * standing research grant the industry kernel maps under, not only inside an
 * ACTIVE sprint. A wound-down sprint with no standing grant still opens
 * nothing, and revoking the grant stops it; spending and outreach are not
 * touched.
 *
 * F5: an opening held only as evidence (no payer a gated claim established)
 * feeds construction as demand evidence — its buyer becomes a buyer population
 * — without being promoted to a found opening.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal, revokeGoal } from '../server/repos/russellAuthority.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createNode } from '../server/repos/industry.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
import { activate, knowledgeResearchAllowed, launchableUnderCashMode, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { MAX_LIVE_GOAL_ROUNDS, openConstructedRound } from '../server/services/cash/discovery.ts';
import { clearConstructionMemo, constructArrangements } from '../server/services/cash/construct.ts';
import { rememberArrangements } from '../server/services/cash/arrangementLibrary.ts';

let projectId = '';
let userId = '';
const now = new Date();

beforeEach(async () => {
  clearConstructionMemo();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `know-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

async function standingGrant(): Promise<string> {
  return (
    await createGoal({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Standing research', allowedWork: ['RESEARCH'],
      maxMissions: 0, maxFragments: 0, maxConcurrent: 6, maxProbes: 0, workPolicy: 'UNCAPPED',
    })
  ).id;
}

async function vetSector(): Promise<void> {
  const root = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Veterinary care', origin: 'SEED' });
  await createNode({ projectId, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'Independent veterinary clinics', origin: 'SEED' });
  await createNode({ projectId, parentId: root.node.id, kind: 'BOTTLENECK', name: 'After-hours phone coverage', origin: 'SEED' });
  await createNode({ projectId, parentId: root.node.id, kind: 'FULFILMENT_SOURCE', name: 'Remote answering services', origin: 'SEED' });
}

async function signalOpening(payer: string, industry = 'Veterinary care'): Promise<string> {
  const mode = (await getCashMode(projectId))!;
  const o = await createOpportunity({
    projectId, cashModeId: mode.id, ownerUserId: userId, title: 'Overflow appointment booking', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
  });
  await updateOpportunity(o.id, { payer, industry });
  return o.id;
}

describe('F7: constructed research runs under the standing grant, not only inside a sprint', () => {
  it('opens a constructed round after the sprint winds down while a standing grant is live, counts the asking, and the round launches', async () => {
    await vetSector();
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    expect(built.length).toBeGreaterThan(0);
    await rememberArrangements(projectId, null, built);
    const key = built[0]!.key;
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'the sprint is ending' });
    const ask = () => openConstructedRound({ goal: { id: 'wst_knowledge', title: 'Learn what clinics pay for' }, projectId, key, title: 'Constructed: clinics', question: 'Do clinics pay for this?', now: now.toISOString(), liveCap: 2 * MAX_LIVE_GOAL_ROUNDS });

    // Wound down, no standing grant: the sprint's wind-down ends it, as before.
    expect((await knowledgeResearchAllowed(projectId)).allowed).toBe(false);
    expect(await ask()).toBeNull();

    const grantId = await standingGrant();
    const decision = await knowledgeResearchAllowed(projectId);
    expect(decision).toMatchObject({ allowed: true, basis: 'STANDING' });
    const opened = await ask();
    expect(opened).not.toBeNull();
    expect((await arrangementForLegacyKey(projectId, key))?.askedCount).toBe(1);
    const round = (await listRounds(projectId)).find((one) => one.candidateId === opened!.candidateId)!;
    expect(round.bucketId).toContain('-mx-');
    const wound = (await getCashMode(projectId))!;
    expect(wound.state).toBe('WINDING_DOWN');
    expect(await launchableUnderCashMode({ candidateId: round.candidateId, mode: wound })).toBe(true);

    // Revoking the grant is what stops it: the round no longer launches, and nothing new opens.
    expect(await revokeGoal({ goalId: grantId, actorUserId: userId, reason: 'stop' })).toBe(true);
    expect(await launchableUnderCashMode({ candidateId: round.candidateId, mode: wound })).toBe(false);
    expect((await knowledgeResearchAllowed(projectId)).allowed).toBe(false);
  });

  it("a wound-down sprint's own lens rounds stay stopped under the standing grant", async () => {
    await standingGrant();
    // A lens (non-constructed) round opened while the sprint ran.
    const { openRound } = await import('../server/repos/cashDiscovery.ts');
    const mode = (await getCashMode(projectId))!;
    const lens = await openRound({ projectId, cashModeId: mode.id, bucketId: 'goal-wst_x-remote', mechanism: 'OTHER', round: 1, candidateId: `rcd_${Math.random().toString(36).slice(2, 12)}` });
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'the sprint is ending' });
    expect(await launchableUnderCashMode({ candidateId: lens.round.candidateId, mode: (await getCashMode(projectId))! })).toBe(false);
  });
});

describe('F5: an evidence-only opening feeds construction as demand evidence', () => {
  it("its payer becomes a buyer population in its sector; the opening itself is not promoted", async () => {
    await vetSector();
    const before = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    expect(before.some((one) => one.demand.name === 'Mobile pet groomers')).toBe(false);

    const id = await signalOpening('Mobile pet groomers');
    clearConstructionMemo();
    const after = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    const fromSignal = after.filter((one) => one.demand.name === 'Mobile pet groomers');
    expect(fromSignal.length).toBeGreaterThan(0);
    for (const one of fromSignal) {
      expect(one.demand.from).toBe('OPENING');
      expect(one.demand.ref).toBe(id);
      expect(one.demand.claimId).toBeTruthy();
    }
    // Still evidence, not a found opening: nothing on the opening moved.
    const o = (await getOpportunity(id))!;
    expect(o.state).not.toBe('QUALIFIED');
  });
});
