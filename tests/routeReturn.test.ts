/**
 * P1 route return, break points 5, 7 and 8 of the production data-flow trace
 * (2026-11-25). Each is reproduced from the rows production held:
 *
 *   5. A pathway construction's round (`mx-pw…`) asked to fill a held
 *      opening's gap, and its answers came back only as new, unrelated
 *      openings: the back-fill refused it ("names no arrangement") and nothing
 *      else read it, so the opening that asked never had its card filled.
 *   7. A FULFILMENT_SOURCE / BOTTLENECK node was filed from any
 *      structural_subject a worker typed — production held "ad agencies,
 *      broadcasters, distributors, investors … committee companies do not pay"
 *      as a supplier — and construction built arrangements over it.
 *   8. The plan set's fulfilment signature was that supplier's free text, as
 *      a sorted word bag.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode, cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity } from '../server/repos/cashPortfolio.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { listNodes, openIndustryRound } from '../server/repos/industry.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { absorb } from '../server/services/industry/expand.ts';
import { applyResearchAnswers, PATHWAY_ROUND_ASKED, recordPathwayAsk } from '../server/services/cash/answers.ts';
import { addGraphParts } from '../server/services/cash/construct.ts';
import type { ConstructedArrangement, Primitive } from '../server/services/cash/construct.ts';
import { arrangementFulfilment, signatureOf } from '../server/services/goals/planSet.ts';
import { namesAMarketPart } from '../server/domain/industry.ts';
import type { Layer, OpportunitySignal, StructuralFinding } from '../server/domain/types.ts';

/** Verbatim from production's plan set (investigation 2026-11-24, stage B). */
const PRODUCTION_SUPPLY = 'ad agencies, broadcasters, distributors, investors and production companies; committee companies do not pay for the content';

let projectId = '';
let cashModeId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (await createUser({ email: `rr-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Collect 10000 dollars of settled cash.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

type ClaimInput = { claim: string; signal?: OpportunitySignal; finding?: StructuralFinding; subject?: string; sourceUrl: string };

/** A DONE mission for a candidate whose orchestration holds these gated claims. */
async function finishedMission(candidateId: string, claims: ClaimInput[]): Promise<string[]> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: 'structure', description: 'a source', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a directory'], excludedSourceTypes: [], completionCriteria: ['a dated source'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'q', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const inserted = await insertClaims(
    claims.map((one) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: '2026-11-20',
      evidenceExcerpt: one.claim, evidenceLocator: 'the page', evidenceLane: 'structure', opportunitySignal: one.signal ?? null, closesOn: null,
      retrievedAt: '2026-11-21', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${one.claim}|${one.sourceUrl}`,
      structuralFinding: one.finding ?? null, structuralSubject: one.subject ?? null,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${orchestration.id}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
  return inserted.map((one) => one.id);
}

describe('5: a pathway construction’s answers return to the opening that asked', () => {
  const GOAL = 'wst_route_return';

  async function heldOpening() {
    return createOpportunity({
      projectId, cashModeId, ownerUserId: userId, title: 'One veterinary clinic asked for after-hours cover', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
      sourceClaimId: null, opportunitySignal: 'PAID_TASK_OR_CONTRACT', source: 'A publisher', requiredCapabilities: [],
    } as Parameters<typeof createOpportunity>[0]);
  }

  /** The round `askPathwayConstructions` opens: a shared candidate and a `goal-…-mx-pw…` round row. */
  async function pathwayRound(): Promise<{ candidateId: string; bucketId: string }> {
    const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: 'Constructed', statement: 'Brain constructed a transaction from evidence it already holds.' });
    const bucketId = `goal-${GOAL}-mx-pwabcdef0123`;
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, found, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'OTHER', 1, ?, 'OPEN', ?, 0, ?, ?)`,
      ['cdr_pw_rr', projectId, cashModeId, bucketId, candidate.id, at, at, at],
    );
    return { candidateId: candidate.id, bucketId };
  }

  it('reproduces the defect: without the ask row, the round’s claims never reach the opening', async () => {
    const opening = await heldOpening();
    const round = await pathwayRound();
    await finishedMission(round.candidateId, [
      { claim: 'Independent veterinary clinics in Ohio buy after-hours answering cover from outside services.', signal: 'RECURRING_OUTSOURCED_WORK', sourceUrl: 'https://example.test/vets' },
    ]);
    await applyResearchAnswers(projectId);
    expect((await getOpportunity(opening.id))!.payer).toBeNull();
  });

  it('puts the round’s sourced answer on the asking opening’s field, preferring the claim that names buyers, once', async () => {
    const opening = await heldOpening();
    const round = await pathwayRound();
    await recordPathwayAsk({ projectId, opportunityId: opening.id, field: 'payer', gap: 'NO_BUYER', ...round });
    const [, named] = await finishedMission(round.candidateId, [
      { claim: 'After-hours answering is a growing service line in veterinary care.', sourceUrl: 'https://example.test/trend' },
      { claim: 'Independent veterinary clinics in Ohio buy after-hours answering cover from outside services.', signal: 'RECURRING_OUTSOURCED_WORK', sourceUrl: 'https://example.test/vets' },
    ]);
    const applied = await applyResearchAnswers(projectId);
    expect(applied.pathways).toEqual([{ opportunityId: opening.id, field: 'payer', claimId: named, candidateId: round.candidateId }]);
    expect((await getOpportunity(opening.id))!.payer).toMatch(/Independent veterinary clinics/);
    expect(await cardFact(opening.id, 'payer')).toMatchObject({ kind: 'EVIDENCE', claimId: named, needId: null });
    // A replay writes nothing twice: the field is evidence now.
    expect((await applyResearchAnswers(projectId)).pathways).toBeUndefined();
  });

  it('applies a money field only from a stated figure, and nothing while the research runs', async () => {
    const opening = await heldOpening();
    const round = await pathwayRound();
    await recordPathwayAsk({ projectId, opportunityId: opening.id, field: 'price', gap: 'NO_MARGIN', ...round });
    // Still running: nothing applied.
    const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: 'm:running', candidateId: round.candidateId });
    expect(mission).toBeDefined();
    expect((await applyResearchAnswers(projectId)).pathways).toBeUndefined();
    expect((await getOpportunity(opening.id))!.priceCents).toBeNull();
  });

  it('records which opening and field asked', async () => {
    const opening = await heldOpening();
    const round = await pathwayRound();
    await recordPathwayAsk({ projectId, opportunityId: opening.id, field: 'buyerVolume', gap: 'ONE_BUYER', ...round });
    const [event] = await cashEventsOfKindInProject(projectId, PATHWAY_ROUND_ASKED);
    expect(event).toMatchObject({ opportunityId: opening.id, detail: { field: 'buyerVolume', gap: 'ONE_BUYER', candidateId: round.candidateId, bucketId: round.bucketId } });
  });
});

describe('7: a supplier or a need is a kind, never a claim sentence', () => {
  it('names a part by the namesABuyerPopulation pattern', () => {
    for (const name of [PRODUCTION_SUPPLY, 'committee companies do not pay', 'printers, mail houses, list brokers', 'they print the run', 'unknown suppliers', 'Compliance is costly. Firms hire help', 'paying']) {
      expect(namesAMarketPart(name), name).toBe(false);
    }
    for (const name of ['Remote answering services', 'Commercial printers and mail houses that print and enter EDDM mailings on order', 'Oppizi', 'After-hours phone coverage', 'Not-for-profit hospitals', 'Do-it-yourself repair kits']) {
      expect(namesAMarketPart(name), name).toBe(true);
    }
  });

  it('absorb refuses a sentence as a FULFILMENT_SOURCE or BOTTLENECK and files a kind', async () => {
    const seed = await seedSubject({ projectId, name: 'Anime licensing', actorRef: userId });
    const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: 'Map', statement: 'Map the industry.' });
    await openIndustryRound({ projectId, cashModeId, nodeId: seed.node.id, purpose: 'MAP', bucketId: null, opportunityId: null, round: 1, candidateId: candidate.id });
    const [garbage, need, kind] = await finishedMission(candidate.id, [
      { claim: 'Production committees fund anime.', finding: 'FULFILMENT_SOURCE', subject: PRODUCTION_SUPPLY, sourceUrl: 'https://example.test/a' },
      { claim: 'Studios report it.', finding: 'BOTTLENECK', subject: 'studios are short of animators and cannot hire', sourceUrl: 'https://example.test/b' },
      { claim: 'Outsourcing studios do in-between animation.', finding: 'FULFILMENT_SOURCE', subject: 'Outsourced in-between animation studios', sourceUrl: 'https://example.test/c' },
    ]);
    const out = await absorb({ projectId });
    expect(out.refused.map((one) => one.claimId).sort()).toEqual([garbage, need].sort());
    const names = (await listNodes(projectId)).filter((one) => one.kind === 'FULFILMENT_SOURCE' || one.kind === 'BOTTLENECK').map((one) => one.name);
    expect(names).toEqual(['Outsourced in-between animation studios']);
    expect(out.nodes.map((one) => one.sourceClaimId)).toContain(kind);
  });

  it('construction takes no event-graph supplier that is a sentence or a list', () => {
    const held = new Map<string, { name: string | null; demand: Primitive[]; needs: Primitive[]; supply: Primitive[] }>();
    const sector = (name: string | null) => {
      const key = (name ?? '-').toLowerCase();
      if (!held.has(key)) held.set(key, { name, demand: [], needs: [], supply: [] });
      return held.get(key)!;
    };
    addGraphParts(
      [
        {
          neighborhood: 'Anime licensing',
          hypothesisKey: 'h1',
          actors: [
            { key: 'a', name: PRODUCTION_SUPPLY, role: 'SUPPLIER' },
            { key: 'c', name: 'ad agencies, broadcasters, distributors and investors', role: 'SUPPLIER' },
            { key: 'b', name: 'Sentai Filmworks', role: 'SUPPLIER' },
          ],
        },
      ] as unknown as Parameters<typeof addGraphParts>[0],
      () => true,
      sector,
    );
    expect(held.get('anime licensing')!.supply.map((one) => one.name)).toEqual(['Sentai Filmworks']);
  });
});

describe('8: the plan set’s fulfilment signature is the supplier’s kind, never its words', () => {
  const supply = (over: Partial<Primitive> | null) => ({ supply: over === null ? null : ({ name: PRODUCTION_SUPPLY, claimId: null, from: 'INDUSTRY_MAP', ref: 'n', path: 'p', ...over } as Primitive) }) as Pick<ConstructedArrangement, 'supply'>;

  it('reads brain, external or unestablished from the supply part’s kind', () => {
    expect(arrangementFulfilment(supply(null))).toBe('brain');
    expect(arrangementFulfilment(supply({ from: 'CAPABILITY' }))).toBe('brain');
    expect(arrangementFulfilment(supply({ claimId: 'clm_1' }))).toBe('external');
    expect(arrangementFulfilment(supply({ from: 'EVENT_GRAPH' }))).toBe('unestablished');
    const signature = signatureOf({ mechanism: 'broker', channel: 'pooled', fulfilment: arrangementFulfilment(supply({ claimId: 'clm_1' })), risk: 'r', revenue: 'one-off' });
    expect(signature).toContain('fulfilment=external');
    expect(signature).not.toMatch(/broadcaster|committee/);
  });
});
