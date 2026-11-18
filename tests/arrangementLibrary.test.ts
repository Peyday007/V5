/**
 * Constructed arrangements are a durable library, not a cache (Surge B,
 * K-1..K-8, migration 152 / pg 143).
 *
 * What is proved here, each against real rows:
 *   * an arrangement composed by a goal's plan is a CONSTRUCTED ledger row that
 *     survives every in-memory cache being cleared, and the next construction
 *     reuses it rather than composing it again;
 *   * the same structure composed by two goals — or after its buyer node is
 *     retired and re-created — is one row, and another project composing the
 *     same structure is found by its signature;
 *   * research that refutes an arrangement is written to it, and it is not
 *     asked again until its inputs change;
 *   * an `arr_` estimate is never linked to a goal as an opening, and a goal
 *     model's weighing of it is recorded once per reading;
 *   * the construction cap ranks before it cuts, and says how many it cut.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createNode, listNodes, retireNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { askConstructedArrangements, awaitsPriceWithKnownCost, forgetGoalReadings, openingsToPursue, PRICE_REASK_ASKINGS, priceReaskQuestion, readGoalPlan } from '../server/services/goals/plan.ts';
import { getDb } from '../server/db/database.ts';
import {
  arrangementSignature,
  clearConstructionMemo,
  constructArrangements,
  forEachCandidate,
  lastConstructionReport,
  MAX_CONSTRUCTIONS,
  selectCandidates,
  type Candidate,
  type ConstructedArrangement,
  type ConstructionJob,
  type Primitive,
} from '../server/services/cash/construct.ts';
import { harvest, MAX_LIVE_GOAL_ROUNDS, openConstructedRound, priceReaskRound, SIGNAL_LANE, staleUnlaunchedRounds } from '../server/services/cash/discovery.ts';
import { arrangementKeyOfBucket, recordReadingEvaluations, rememberArrangements } from '../server/services/cash/arrangementLibrary.ts';
import { createProject } from '../server/repos/projects.ts';
import {
  arrangementEvaluations,
  arrangementForLegacyKey,
  arrangementsBySignature,
  listConstructedArrangements,
  listPaths,
  pathFact,
} from '../server/repos/monetization.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { defaultDesign, isDefaultDesign, STRUCTURES } from '../server/services/cash/properties.ts';
import type { ClaimType, Layer, OpportunitySignal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let layer: Layer;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

/** Every in-process cache a restart or a deploy loses. */
function restart(): void {
  forgetKnowledge();
  forgetGoalReadings();
  clearConstructionMemo();
}

async function cashProject(): Promise<{ projectId: string; layer: Layer; userId: string }> {
  const fixture = await freshProject();
  const owner = (await createUser({ email: `lib-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId: fixture.project.id, ownerUserId: owner, actorUserId: owner, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  return { projectId: fixture.project.id, layer: await fixture.layerByName('Discovery Logic'), userId: owner };
}

beforeEach(async () => {
  restart();
  const made = await cashProject();
  projectId = made.projectId;
  layer = made.layer;
  userId = made.userId;
  cashModeId = (await getCashMode(projectId))!.id;
});

type ClaimInput = { claim: string; signal?: OpportunitySignal; lane?: string; sourceUrl: string; claimType?: ClaimType };

async function gatedClaims(claims: ClaimInput[], into = { projectId, layer }): Promise<{ ids: string[]; orchestrationId: string }> {
  const run = await createRun({ projectId: into.projectId, layerId: into.layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a question' });
  const orchestration = await createOrchestration({ projectId: into.projectId, layerId: into.layer.id, runId: run.id, title: 'a question', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: into.projectId, layerId: into.layer.id, geography: 'any market',
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
      claimType: one.claimType ?? ('SOURCED_FACT' as const), contentHash: `${one.claim}|${one.sourceUrl}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  return { ids: inserted.map((one) => one.id), orchestrationId: orchestration.id };
}

async function finishedMission(candidateId: string, claims: ClaimInput[]): Promise<void> {
  const { orchestrationId } = await gatedClaims(claims);
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${orchestrationId}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

async function sector(name: string, parts: { buyer: string; bottleneck: string; supply: string }, into = { projectId, layer }): Promise<void> {
  const [, buyer, bottleneck, supply] = (await gatedClaims([
    { claim: `${name} is a sector.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(name)}` },
    { claim: `${parts.buyer} buy in ${name}.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.buyer)}` },
    { claim: `${parts.bottleneck} is a recurring problem.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.bottleneck)}` },
    { claim: `${parts.supply} serve this.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.supply)}` },
  ], into)).ids;
  const node = await createNode({ projectId: into.projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  await createNode({ projectId: into.projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: parts.buyer, origin: 'DISCOVERED', sourceClaimId: buyer ?? null });
  await createNode({ projectId: into.projectId, parentId: node.node.id, kind: 'BOTTLENECK', name: parts.bottleneck, origin: 'DISCOVERED', sourceClaimId: bottleneck ?? null });
  await createNode({ projectId: into.projectId, parentId: node.node.id, kind: 'FULFILMENT_SOURCE', name: parts.supply, origin: 'DISCOVERED', sourceClaimId: supply ?? null });
}

const VET = { buyer: 'Independent veterinary clinics', bottleneck: 'After-hours phone coverage', supply: 'Remote answering services' };

async function goal(amountCents: number, title = 'Collect cash fast'): Promise<string> {
  const g = await createWorkstream({ projectId, title, intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: null, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

async function constructedRows(): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM monetization_paths WHERE project_id = ? AND origin = 'CONSTRUCTED'`, [projectId]);
  return Number(row?.n ?? 0);
}

describe('a constructed arrangement is a library row', () => {
  it('survives a restart, and the next construction reuses it instead of composing it again', async () => {
    await sector('Veterinary care', VET);
    // The buyer's claim states where it holds; the arrangement carries that, by reference to the claim (K-8).
    const buyerNode = (await listNodes(projectId)).find((one) => one.kind === 'BUYER_TYPE')!;
    await getDb().run('UPDATE research_claims SET geography = ? WHERE id = ?', ['United States', buyerNode.sourceClaimId]);
    const id = await goal(600_000);
    await readGoalPlan({ goalId: id, now, evaluations: 500 });
    const stored = await listConstructedArrangements(projectId);
    expect(stored.length).toBeGreaterThan(0);
    // Hypothesis and provenance on every row: the design, its value and unknown parts, its parts' claims, its first goal.
    for (const one of stored) {
      expect(one.signature).toMatch(/^[0-9a-f]{32}$/);
      expect(one.firstGoalId).toBe(id);
      const arrangement = one.design['arrangement'] as { value: { tier: string }; unknownParts: string[]; demand: { claimId: string | null } };
      expect(arrangement.value.tier).toBeTruthy();
      expect(Array.isArray(arrangement.unknownParts)).toBe(true);
      expect(one.design['paymentTiming']).toBeTruthy();
    }
    expect(stored.some((one) => one.constructionOrigin === 'REVERSE' && one.opportunityId === null && one.industryNodeId === null)).toBe(true);
    const forward = stored.find((one) => one.constructionOrigin === 'FORWARD')!;
    expect(forward.industryNodeId).not.toBeNull();
    // Geography of the parts' claims is carried, where the claim states one.
    expect(forward.design['geography']).toEqual(['United States']);
    // The ledger's own ranking never sees a hypothesis.
    expect((await listPaths({ projectId })).some((one) => one.origin === 'CONSTRUCTED')).toBe(false);

    restart();
    // Nothing in memory, everything in the database.
    expect(await constructedRows()).toBe(stored.length);
    await readGoalPlan({ goalId: id, now, evaluations: 500 });
    const report = lastConstructionReport(projectId)!;
    expect(report.reused).toBeGreaterThan(0);
    expect(await constructedRows()).toBe(stored.length);
  });

  it('holds one row per structure across two goals, a re-created node and two projects', async () => {
    await sector('Veterinary care', VET);
    const first = await goal(600_000, 'First goal');
    await readGoalPlan({ goalId: first, now, evaluations: 500 });
    const afterFirst = await listConstructedArrangements(projectId);
    // The first goal ends; a new goal on the same project starts.
    await getDb().run('UPDATE workstreams SET archived_at = ?, archived_reason = ? WHERE id = ?', [now.toISOString(), 'met', first]);
    const second = await goal(900_000, 'Second goal');
    restart();
    await readGoalPlan({ goalId: second, now, evaluations: 500 });
    const afterSecond = await listConstructedArrangements(projectId);
    // The second goal's forward arrangements are the first's structures: no new row for them.
    const firstSigs = new Set(afterFirst.map((one) => one.signature));
    for (const one of afterSecond.filter((a) => a.constructionOrigin !== 'REVERSE')) expect(firstSigs.has(one.signature)).toBe(true);
    expect(new Set(afterSecond.map((one) => one.signature)).size).toBe(afterSecond.length);
    expect(afterSecond.filter((one) => firstSigs.has(one.signature)).every((one) => one.firstGoalId === first)).toBe(true);

    // The buyer node is retired and re-created under the same name: same structure, same row, new reference.
    const buyer = (await listNodes(projectId)).find((one) => one.kind === 'BUYER_TYPE' && !one.retiredAt)!;
    expect(await retireNode(buyer.id, 'duplicate entry')).toBe(true);
    const again = await createNode({ projectId, parentId: buyer.parentId, kind: 'BUYER_TYPE', name: buyer.name, origin: 'SEED' });
    restart();
    await readGoalPlan({ goalId: second, now, evaluations: 500 });
    const afterRecreate = await listConstructedArrangements(projectId);
    const forwardSigs = new Set(afterSecond.filter((one) => one.constructionOrigin !== 'REVERSE').map((one) => one.signature));
    expect(afterRecreate.filter((one) => forwardSigs.has(one.signature)).some((one) => one.industryNodeId === again.node.id)).toBe(true);
    expect(afterRecreate.filter((one) => one.industryNodeId === again.node.id).every((one) => forwardSigs.has(one.signature))).toBe(true);

    // Another project composing the same structure is found by its signature (K-5): same kinds and names, its own rows.
    const elsewhere = await createProject({ name: 'Elsewhere', slug: `elsewhere-${Math.random().toString(36).slice(2, 8)}` });
    const root = await createNode({ projectId: elsewhere.id, parentId: null, kind: 'SECTOR', name: 'Veterinary care', origin: 'SEED' });
    await createNode({ projectId: elsewhere.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: VET.buyer, origin: 'SEED' });
    await createNode({ projectId: elsewhere.id, parentId: root.node.id, kind: 'BOTTLENECK', name: VET.bottleneck, origin: 'SEED' });
    await createNode({ projectId: elsewhere.id, parentId: root.node.id, kind: 'FULFILMENT_SOURCE', name: VET.supply, origin: 'SEED' });
    const built = await constructArrangements({ projectId: elsewhere.id, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    await rememberArrangements(elsewhere.id, null, built);
    const shared = afterFirst.find((one) => one.constructionOrigin === 'FORWARD' && built.some((b) => b.signature === one.signature))!;
    expect(shared).toBeDefined();
    const across = await arrangementsBySignature(shared.signature);
    expect(new Set(across.map((one) => one.projectId))).toEqual(new Set([projectId, elsewhere.id]));
  });
});

describe('research written to the arrangement', () => {
  it('records a refutation and does not ask the refuted arrangement again until its inputs change', async () => {
    await sector('Veterinary care', VET);
    const id = await goal(600_000);
    const w = (await getWorkstream(id))!;
    const reading = (await readGoalPlan({ goalId: id, now, evaluations: 500 }))!;
    /*
     * A forward arrangement for the clinics, from the library — one the new evidence below can reach.
     *
     * That evidence is an opening sold to these buyers as a productized service, and construction
     * then stops composing the *default* design of every structure that already holds that way:
     * those buyers are "already held sold exactly this way" (`forEachCandidate`). Such an arrangement
     * is never recomposed, so its stored digest cannot move however much evidence arrives. The library
     * lists one pass's rows by one shared `created_at` and then a random id, so a bare `find` drew that
     * arrangement about one run in fifty (Postgres suite, 2026-11-17, run 44029560078) and the test
     * failed on a digest that was right not to change.
     */
    const SOLD_AS = 'PRODUCTIZED_SERVICE' as const;
    const forward = (await listConstructedArrangements(projectId)).find((one) => {
      const design = (one.design['arrangement'] as ConstructedArrangement).design;
      const retired = isDefaultDesign(design) && (STRUCTURES[design.base].alreadyHeldAs as readonly string[]).includes(SOLD_AS);
      return one.constructionOrigin === 'FORWARD' && one.industryNodeId !== null && !retired;
    })!;
    const key = forward.legacyKey!;
    const ask = () => openConstructedRound({ goal: { id, title: w.title }, projectId, key, title: 'Constructed: clinics', question: 'Do clinics pay for this?', now: now.toISOString(), liveCap: 2 * MAX_LIVE_GOAL_ROUNDS });
    const first = await ask();
    expect(first).not.toBeNull();
    const round = (await listRounds(projectId)).find((one) => one.candidateId === first!.candidateId)!;
    expect(arrangementKeyOfBucket(round.bucketId)).toBe(key);
    expect((await arrangementForLegacyKey(projectId, key))!.askedCount).toBe(1);

    // The research finishes and establishes an absence: nobody is published as paying for this.
    await finishedMission(round.candidateId, [
      { claim: 'No published source shows any buyers of this kind paying for this arrangement.', sourceUrl: 'https://example.test/absence', claimType: 'NEGATIVE_EXISTENCE' },
    ]);
    await harvest({ projectId });
    const refuted = (await arrangementForLegacyKey(projectId, key))!;
    expect(refuted.verdict).toMatchObject({ verdict: 'REFUTED', roundId: round.id, inputsDigest: refuted.inputsDigest });
    // What research observed is an EVIDENCE fact resolving to the gated claim — never Brain's estimate.
    const fact = (await pathFact(refuted.pathId, 'expectedRevenue'))!;
    expect(fact.kind).toBe('EVIDENCE');
    expect(fact.claimId).toBeTruthy();

    // Long after every backoff, the same arrangement under the same inputs is not asked again.
    const longAgo = inDays(-30);
    await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ?, harvested_at = ? WHERE id = ?', [longAgo, longAgo, round.id]);
    expect(await ask()).toBeNull();
    const more = await askConstructedArrangements(w, reading, now, 3, 2 * MAX_LIVE_GOAL_ROUNDS);
    const reasked = (await listRounds(projectId)).filter((one) => more.includes(one.candidateId) && arrangementKeyOfBucket(one.bucketId) === key);
    expect(reasked).toHaveLength(0);

    // New evidence about its buyer arrives — a published price this population paid — so its inputs change and it may be asked again.
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: userId, title: 'Clinic report', mechanism: SOLD_AS, currency: 'USD',
      sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
    });
    await recordCardFact({ projectId, opportunityId: o.id, field: CAPTURE_KEY, kind: 'EVIDENCE', value: 'Sell it.', claimId: `clm_c_${o.id}`, decidedBy: 'BRAIN' });
    await updateOpportunity(o.id, { payer: VET.buyer, price_cents: 45_000 });
    restart();
    // Read at the time the new evidence exists, as production always does: the file's `now` is fixed
    // when it loads, and on a slow shard (737 s, Postgres 2026-11-15) rows written minutes later are
    // after it, so a read at that instant can predate the price it is meant to see.
    await readGoalPlan({ goalId: id, now: new Date(Date.now() + 1_000), evaluations: 500 });
    const changed = (await arrangementForLegacyKey(projectId, key))!;
    expect(changed.inputsDigest).not.toBe(refuted.inputsDigest);
    expect(changed.verdict?.verdict).toBe('REFUTED');
    expect(await ask()).not.toBeNull();
    expect((await arrangementForLegacyKey(projectId, key))!.askedCount).toBe(2);
  });
});

describe('a goal model weighs arrangements, it does not pursue them as openings', () => {
  it('never links an arr_ estimate as an opening', () => {
    const accepted = { acceptance: { accepted: { opportunityIds: ['arr_0123456789ab', 'opp_real'] } } } as unknown as Parameters<typeof openingsToPursue>[0];
    expect(openingsToPursue(accepted, null)).toEqual(['opp_real']);
    const none = { acceptance: { accepted: null } } as unknown as Parameters<typeof openingsToPursue>[0];
    expect(openingsToPursue(none, { chainComplete: true, opportunityIds: ['arr_ffffffffffff', 'opp_2'] })).toEqual(['opp_2']);
  });

  it('records each reading\'s weighing once, with whether the best combination picked it', async () => {
    await sector('Veterinary care', VET);
    const id = await goal(600_000);
    await readGoalPlan({ goalId: id, now, evaluations: 500 });
    const one = (await listConstructedArrangements(projectId)).find((a) => a.constructionOrigin === 'FORWARD')!;
    const arr = `arr_${one.legacyKey}`;
    const write = (readingId: string) =>
      recordReadingEvaluations({ projectId, goalId: id, readingId, demand: [{ opportunityId: arr, refused: null, revenue: { p50: 1234.5 } }, { opportunityId: 'opp_x', refused: null, revenue: { p50: 9 } }], picked: new Set([arr]), prefix: 'arr_' });
    expect(await write('gpr_1')).toBe(1);
    expect(await write('gpr_1')).toBe(0);
    expect(await write('gpr_2')).toBe(1);
    const after = (await arrangementForLegacyKey(projectId, one.legacyKey!))!;
    expect(after.evaluatedCount).toBe(2);
    expect(after.lastEvaluation).toMatchObject({ goalId: id, readingId: 'gpr_2', contributionCents: 123_450, picked: true });
    expect(await arrangementEvaluations(one.pathId)).toHaveLength(2);
  });
});

describe('an arrangement reads only its own buyers\' prices (PRICE-POOL)', () => {
  it('never gives two buyer groups with no shared payer the same borrowed price, and stores an unpriced one as UNKNOWN', async () => {
    // Held openings priced for dentists and roofers only.
    for (const [payer, cents] of [['Dentists', 90_000], ['Dentists', 120_000], ['Roofers', 1_500_000]] as const) {
      const o = await createOpportunity({
        projectId, cashModeId, ownerUserId: userId, title: `${payer} work ${cents}`, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
        sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
      });
      await recordCardFact({ projectId, opportunityId: o.id, field: 'payer', kind: 'EVIDENCE', value: payer, claimId: `clm_p_${o.id}`, decidedBy: 'BRAIN' });
      await updateOpportunity(o.id, { payer, price_cents: cents, peak_funding_cents: cents });
    }
    await sector('Pet care', { buyer: 'Dog groomers', bottleneck: 'Missed appointments', supply: 'Booking assistants' });
    await sector('Freight', { buyer: 'Trucking dispatchers', bottleneck: 'Empty return legs', supply: 'Load brokers' });
    await sector('Dental care', { buyer: 'Dentists', bottleneck: 'Unfilled chairs', supply: 'Recall callers' });
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    const of = (buyer: string) => built.filter((one) => one.demand.name === buyer && one.structure === 'BROKER');
    const groomers = of('Dog groomers');
    const dispatchers = of('Trucking dispatchers');
    expect(groomers.length).toBeGreaterThan(0);
    expect(dispatchers.length).toBeGreaterThan(0);
    // Neither group has a price of its own: neither borrows the project's.
    for (const one of [...groomers, ...dispatchers]) expect(one.value).toMatchObject({ tier: 'UNKNOWN', observations: 0 });
    // The dentists' arrangement reads exactly the dentists' two prices, never the roofers'.
    const dentists = of('Dentists').find((one) => one.value.tier !== 'UNKNOWN')!;
    expect(dentists.value.observations).toBe(2);
    expect(dentists.value.p90).toBeLessThan(15_000);
    // And the library keeps the unpriced ones unpriced.
    await rememberArrangements(projectId, null, built);
    const stored = (await listConstructedArrangements(projectId)).filter((one) => (one.design['arrangement'] as { demand: { name: string } }).demand.name === 'Dog groomers');
    expect(stored.length).toBeGreaterThan(0);
    for (const one of stored) expect((one.design['arrangement'] as { value: { tier: string } }).value.tier).toBe('UNKNOWN');
  });
});

describe('the construction cap ranks before it cuts', () => {
  it('keeps what ranks highest wherever it falls in enumeration order, keeps breadth, and counts what it cut', () => {
    const p = (name: string, claimId: string | null = null): Primitive => ({ name, claimId, from: 'INDUSTRY_MAP', ref: `ref:${name}`, path: `NODE:${name.toLowerCase()}` });
    const needs = Array.from({ length: 15 }, (_, i) => p(`need ${i}`));
    const supply = Array.from({ length: 15 }, (_, i) => p(`supplier ${i}`));
    const limits = { daysLeft: 30, remainingCents: 1_000_000, capitalCeilingCents: null, capitalBeforeProofCents: null, bestReachCents: null };
    const job: ConstructionJob = {
      sectors: [{ name: 'services', demand: [p('buyer a'), p('buyer b')], needs, supply }],
      opportunities: [],
      precedent: [],
      capability: null,
      priced: [],
      tiedUp: [],
      input: { projectId: 'p', currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, limits },
      limits,
      targets: [],
      exclusions: [],
      now: new Date('2026-11-14T00:00:00Z'),
    };
    // Enumeration order: designs outermost, so the very last candidate is a variant design for buyer b.
    const plain = selectCandidates(job);
    expect(plain.considered).toBeGreaterThan(MAX_CONSTRUCTIONS);
    expect(plain.selected).toHaveLength(MAX_CONSTRUCTIONS);
    // Breadth: both buyer populations get an even share of the cap.
    const perBuyer = (sel: typeof plain.selected) => sel.filter((one) => one.demand.name === 'buyer b').length;
    expect(Math.abs(perBuyer(plain.selected) - MAX_CONSTRUCTIONS / 2)).toBeLessThanOrEqual(1);
    // The original design ranks before its variants when nothing else separates them.
    expect(plain.selected.filter((one) => one.design.base === 'BROKER' && JSON.stringify(one.design) === JSON.stringify(defaultDesign('BROKER'))).length).toBeGreaterThan(0);

    // Research confirmed the last-enumerated structure, and a late need rests on a gated claim: both are kept.
    const all: Candidate[] = [];
    forEachCandidate(job, (one) => all.push(one));
    const last = all[all.length - 1]!;
    expect(plain.selected.some((one) => one.order === last.order)).toBe(false);
    const confirmed = arrangementSignature(last.design, last.demand, last.need, last.supply);
    const evidencedNeed = { ...needs[14]!, claimId: 'clm_late' };
    const ranked = selectCandidates({ ...job, sectors: [{ ...job.sectors[0]!, needs: [...needs.slice(0, 14), evidencedNeed] }], known: [[confirmed, { verdict: 'CONFIRMED', p50: 0 }]] });
    expect(ranked.selected[0]!.order).toBe(last.order);
    expect(ranked.selected.filter((one) => one.need?.claimId === 'clm_late').length).toBeGreaterThan(0);
    expect(ranked.considered - ranked.selected.length).toBe(plain.considered - MAX_CONSTRUCTIONS);
  });
});

describe('an arrangement whose cost is known and price is not is re-asked for the price (production 2026-11-18, 2821cce3c372)', () => {
  it('opens before the barren backoff ends, a bounded number of times, never while one is open or just settled', () => {
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    const round = (n: number, harvestedHoursAgo: number, state = 'HARVESTED') =>
      ({ id: `cdr_${n}`, round: n, state, found: 0, openedAt: at(harvestedHoursAgo + 5), harvestedAt: state === 'OPEN' ? null : at(harvestedHoursAgo) }) as unknown as Parameters<typeof priceReaskRound>[0][number];
    const t = now.toISOString();
    expect(priceReaskRound([round(1, 16)], t, PRICE_REASK_ASKINGS)).toBe(2);
    expect(priceReaskRound([round(1, 2)], t, PRICE_REASK_ASKINGS)).toBeNull();
    expect(priceReaskRound([round(1, 40), round(2, 1, 'OPEN')], t, PRICE_REASK_ASKINGS)).toBeNull();
    expect(priceReaskRound([round(1, 40), round(2, 10)], t, PRICE_REASK_ASKINGS)).toBe(3);
    expect(priceReaskRound([round(1, 40), round(2, 30), round(3, 10)], t, PRICE_REASK_ASKINGS)).toBeNull();
  });

  it('is selected only with an unknown price and an observed cost, and is asked differently the second time', () => {
    const base = { label: 'pooled postcards', demand: { name: 'local service businesses' }, value: { tier: 'UNKNOWN' as const, p10: 0, p50: 0, p90: 0, observations: 0 } };
    const cost = { tier: 'COMPARABLE' as const, p10: 4675, p50: 4675, p90: 4675, observations: 1, sources: ['claim:clm_9cf1f15c'] };
    expect(awaitsPriceWithKnownCost({ ...base, fixedCost: cost } as never)).toBe(true);
    expect(awaitsPriceWithKnownCost({ ...base } as never)).toBe(false);
    expect(awaitsPriceWithKnownCost({ ...base, value: { ...base.value, tier: 'COMPARABLE' }, fixedCost: cost } as never)).toBe(false);
    const q = priceReaskQuestion({ ...base, fixedCost: cost } as never, 'USD');
    expect(q).toMatch(/per slot/);
    expect(q).toMatch(/4,675/);
    expect(q).toMatch(/reconstruct/);
  });

  it('openConstructedRound re-asks inside the backoff only when told the price is the missing input, and stops at the bound', async () => {
    await sector('Veterinary care', VET);
    const id = await goal(600_000);
    const w = (await getWorkstream(id))!;
    await readGoalPlan({ goalId: id, now, evaluations: 500 });
    const key = (await listConstructedArrangements(projectId)).find((one) => one.constructionOrigin === 'FORWARD')!.legacyKey!;
    const ask = (priceReaskUpTo?: number) =>
      openConstructedRound({ goal: { id, title: w.title }, projectId, key, title: 'Constructed: clinics', question: 'What does one clinic pay per slot?', now: now.toISOString(), liveCap: 2 * MAX_LIVE_GOAL_ROUNDS, ...(priceReaskUpTo ? { priceReaskUpTo } : {}) });
    const settleBarren = async (candidateId: string) => {
      await finishedMission(candidateId, [{ claim: 'Clinics answer phones after hours.', lane: 'structure', sourceUrl: `https://example.test/${candidateId}` }]);
      await harvest({ projectId });
      const r = (await listRounds(projectId)).find((one) => one.candidateId === candidateId)!;
      expect(r.state).toBe('HARVESTED');
      const ago = new Date(now.getTime() - 10 * 3_600_000).toISOString();
      await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ?, harvested_at = ? WHERE id = ?', [ago, ago, r.id]);
    };
    const first = (await ask())!;
    expect(first).not.toBeNull();
    await settleBarren(first.candidateId);
    // Ten hours after a barren round the ordinary backoff (a day, doubling) holds it…
    expect(await ask()).toBeNull();
    // …a price re-ask does not, and is bounded.
    const second = (await ask(PRICE_REASK_ASKINGS))!;
    expect(second).not.toBeNull();
    await settleBarren(second.candidateId);
    const third = (await ask(PRICE_REASK_ASKINGS))!;
    expect(third).not.toBeNull();
    await settleBarren(third.candidateId);
    expect(await ask(PRICE_REASK_ASKINGS)).toBeNull();
  });
});

describe('a round that never launched does not hold a price re-ask out (production 2026-11-18, cdr_8c45a2cc held 2821cce3c372 out ten hours)', () => {
  it('a price re-ask opens past rounds unlaunched for an hour, an ordinary ask does not, and a fresh unlaunched round still counts', async () => {
    await sector('Veterinary care', VET);
    const id = await goal(600_000);
    const w = (await getWorkstream(id))!;
    await readGoalPlan({ goalId: id, now, evaluations: 500 });
    const keys = [...new Set((await listConstructedArrangements(projectId)).map((one) => one.legacyKey!).filter(Boolean))];
    expect(keys.length).toBeGreaterThanOrEqual(4);
    const [k1, k2, k3, priced] = keys as [string, string, string, string];
    const ask = (key: string, priceReaskUpTo?: number) =>
      openConstructedRound({ goal: { id, title: w.title }, projectId, key, title: 'Constructed: clinics', question: 'What does one clinic pay per slot?', now: now.toISOString(), liveCap: MAX_LIVE_GOAL_ROUNDS, ...(priceReaskUpTo ? { priceReaskUpTo } : {}) });
    // The goal's whole live cap is taken by rounds whose ideas never became missions.
    for (const key of [k1, k2, k3]) expect(await ask(key)).not.toBeNull();
    const held = (await listRounds(projectId)).filter((r) => r.state === 'OPEN' && r.bucketId.includes('-mx-'));
    expect(held).toHaveLength(3);
    // Just opened, they may still launch on the next tick: nothing yields.
    expect(await staleUnlaunchedRounds(held, now.toISOString())).toBe(0);
    expect(await ask(priced, PRICE_REASK_ASKINGS)).toBeNull();
    // Two hours unlaunched, they are queued for the grant, not researching.
    const ago = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    for (const r of held) await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ? WHERE id = ?', [ago, r.id]);
    expect(await staleUnlaunchedRounds(held.map((r) => ({ ...r, openedAt: ago })), now.toISOString())).toBe(3);
    expect(await ask(priced)).toBeNull();
    const reask = await ask(priced, PRICE_REASK_ASKINGS);
    expect(reask).not.toBeNull();
    // The waiting rounds keep their rows and their ideas: nothing is launched or retired for them.
    for (const r of held) {
      expect((await listRounds(projectId)).find((x) => x.id === r.id)!.state).toBe('OPEN');
      expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM russell_missions WHERE candidate_id = ?', [r.candidateId]))!.n).toBe(0);
    }
  });
});
