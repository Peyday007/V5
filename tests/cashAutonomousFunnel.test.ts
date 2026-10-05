/**
 * MONEY BUILD 3/4 — the acceptance journey: an ACTIVE sprint with no
 * handcrafted opportunity reaches READY_TO_TEST with nobody answering a
 * researchable fact.
 *
 * `cashIntegrationPass` and `cashDeploymentSmoke` both reach READY, and both
 * get there by a person PATCHing the price, the exposure and the execution
 * thesis onto the card. That proves the gate and proves nothing about whether
 * Brain can fill the card itself — and driving it without the person found two
 * writers that did not exist: a researched `price` was a sentence written into
 * an integer column, and a researched `exposure` had no column to land in at
 * all, so its need stayed open beside a finished mission for ever.
 *
 * What a person does here is exactly the two decisions that are theirs:
 * pressing Start (which is also the research authorization, §33) and nothing
 * else. No `fillCard`, no PATCH, no `PERSON` card fact, no standing research
 * goal created by hand. The assertions at the end check the provenance of every
 * fact on the card, not merely the tier.
 *
 * What is simulated is the external edge, as in `cashIntegrationPass`: the
 * sentences a worker found on the web and the two judgements only a reader of
 * the source can make, submitted through the real MCP tools under a real lease
 * and decided by Brain's own gate. The mission lifecycle around each packet is
 * linked by the test, because judging a captured idea is itself a bin a fleet
 * worker answers and there is no fleet here. Every question answered is one
 * Brain itself asked — a bucket round, a deep dive, or a card need — and the
 * test only ever answers candidates Brain created.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { findTool } from '../server/mcp/tools.ts';
import { claimWork } from '../server/repos/workQueue.ts';
import { advancePacket, approvePlan } from '../server/services/research/packetRunner.ts';
import {
  latestMissionForCandidate,
  launchMission,
  linkMission,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { getOpportunity, listNeeds, listOpportunities } from '../server/repos/cashPortfolio.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { tick } from '../server/services/russell/loop.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { cashTier, type TierReading } from '../server/services/cash/tier.ts';
import type {
  CashOpportunity,
  ClaimedWork,
  Layer,
  Principal,
  WorkerScope,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

const WORKER_SCOPES: WorkerScope[] = [
  'project:read',
  'documents:read',
  'research:read',
  'research:propose',
  'research:write',
  'claims:write',
  'contradictions:write',
  'checkpoints:write',
  'blockers:report',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
];

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `autonomous-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const worker = await createWorker({
    name: `autonomous-worker-${Math.random().toString(36).slice(2, 10)}`,
    displayName: 'The research worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: workerId,
    role: 'MEMBER',
    scopes: WORKER_SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

function principal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'autonomous-worker',
    displayName: 'The research worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_autonomous',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_autonomous_worker',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: WORKER_SCOPES,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      },
    ],
    requestId: 'req_autonomous',
  } as Principal;
}

async function asWorker(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: principal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

/**
 * Claim the item Brain queued for this packet, and only that one.
 *
 * Narrowed by orchestration, because the same tick also opens other kernels'
 * questions in this project, and a worker answering the wrong packet's lanes
 * would make a failure here about the fixture rather than about the funnel.
 */
async function claimQueued(type: string, orchestrationId: string): Promise<ClaimedWork> {
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId, scopes: WORKER_SCOPES }],
    workTypes: [type],
    orchestrationId,
  });
  if (!claimed) throw new Error(`Brain queued nothing of type ${type}`);
  return claimed;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

interface Found {
  claim: string;
  lane: string;
  sourceUrl: string;
  signal?: string;
}

/**
 * One packet for one candidate Brain created, answered through the tools and
 * judged by Brain's gate, then linked to a DONE mission for that candidate.
 */
async function answer(candidateId: string, question: string, found: Found[]): Promise<void> {
  const lanes = [...new Set(found.map((one) => one.lane))].map((id) => ({
    id,
    description: `Evidence for ${id}.`,
    necessity: 'REQUIRED' as const,
  }));
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: question,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: question,
    assignment: question,
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets this sprint may look at',
      requiredEvidence: lanes,
      acceptableSourceTypes: ['a published request, posting, listing, notice or schedule'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['at least one dated published source'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'autonomous',
      question,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: userId });

  const researching = await claimQueued('RESEARCH_FRAGMENT', orchestration.id);
  const submitted = await asWorker('brain_submit_claims', {
    ...proof(researching),
    claims: found.map((one) => ({
      claim: one.claim,
      claim_type: 'SOURCED_FACT',
      source_url: one.sourceUrl,
      source_title: 'A published page',
      source_publisher: new URL(one.sourceUrl).hostname,
      source_date: '2026-09-28',
      evidence_excerpt: one.claim,
      evidence_locator: 'the page body',
      evidence_lane: one.lane,
      retrieved_at: '2026-09-29',
      confidence: 0.9,
      primary_source: true,
      ...(one.signal ? { opportunity_signal: one.signal } : {}),
    })),
    search_queries: [question],
  });
  const stored = submitted['claims'] as { claimId: string }[];
  expect(stored).toHaveLength(found.length);
  await asWorker('brain_complete_work', {
    ...proof(researching),
    result_ref: String(submitted['recorded']),
    summary: 'claims submitted',
  });

  await advancePacket(orchestration.id);
  const verifying = await claimQueued('RESEARCH_VERIFY', orchestration.id);
  const gate = await asWorker('brain_submit_verification', {
    ...proof(verifying),
    verdicts: stored.map((row) => ({
      claim_id: row.claimId,
      supports_claim: true,
      geography: 'MATCH',
      timeframe: 'MATCH',
      population: 'MATCH',
      definitions: 'MATCH',
      geography_basis: 'Judged against the geography the fragment declares.',
      timeframe_basis: 'Judged against the timeframe the fragment declares.',
      population_basis: 'Judged against the population the fragment declares.',
      definitions_basis: 'Judged against the definitions the fragment declares.',
      note: 'Read the page.',
    })),
    sufficiency: 'SUFFICIENT',
    missing_lanes: [],
    unresolved_gaps: [],
  });
  // Brain's gate decides, not the worker.
  expect(gate['acceptedClaims']).toBe(found.length);
  await asWorker('brain_complete_work', {
    ...proof(verifying),
    result_ref: String(gate['acceptedClaims']),
    summary: 'verified and gated',
  });

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: question,
    whyNow: 'Brain asked this',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
}

/** What the open web says, per question. The only fixture in the journey. */
const SOURCE = 'https://example.test/westfield/notices/2026-441';

const DEEP_DIVE: Found[] = [
  {
    claim:
      'The Westfield drainage authority procurement officer approves and pays for research ' +
      'purchases under USD 25,000.',
    lane: 'payer',
    sourceUrl: 'https://example.test/westfield/delegations',
  },
  {
    claim: 'Comparable parcel-ownership research engagements are published at USD 1,800 to USD 2,400.',
    lane: 'price_evidence',
    sourceUrl: 'https://example.test/rates/parcel-research',
  },
  {
    claim: 'The county recorder publishes title-search fees totalling USD 300 for the twenty parcels named.',
    lane: 'cost_evidence',
    sourceUrl: 'https://example.test/county/recorder/fees',
  },
  {
    claim: 'The authority publishes payment terms of net 30 from written acceptance.',
    lane: 'timing',
    sourceUrl: 'https://example.test/westfield/terms',
  },
  {
    claim: 'The notice states the work is a desk review of twenty parcels, about twelve hours.',
    lane: 'effort',
    sourceUrl: SOURCE,
  },
  {
    claim:
      'The notice requires a written ownership table per parcel, delivered by email; no site ' +
      'visit is required.',
    lane: 'delivery_requirements',
    sourceUrl: SOURCE,
  },
  {
    claim: 'The notice disqualifies only bidders with a conflict of interest with a named landowner.',
    lane: 'disqualifier',
    sourceUrl: SOURCE,
  },
  {
    claim: 'The authority states no licence or registration is required below USD 25,000.',
    lane: 'eligibility',
    sourceUrl: 'https://example.test/westfield/procurement-rules',
  },
  {
    claim: 'The notice accepts questions and submissions by email only; no call is required.',
    lane: 'contact_mode',
    sourceUrl: SOURCE,
  },
];

/** A card question Brain raised, answered by the page that settles it. */
function forField(field: string): Found[] | null {
  const lane = 'demand_signal';
  switch (field) {
    case 'payer':
      return [{ claim: DEEP_DIVE[0]!.claim, lane, sourceUrl: DEEP_DIVE[0]!.sourceUrl }];
    case 'access':
      return [
        {
          claim: 'The notice gives procurement@westfield-drainage.example for questions and submissions.',
          lane,
          sourceUrl: SOURCE,
        },
      ];
    case 'price':
      return [{ claim: DEEP_DIVE[1]!.claim, lane, sourceUrl: DEEP_DIVE[1]!.sourceUrl }];
    case 'exposure':
      return [{ claim: DEEP_DIVE[2]!.claim, lane, sourceUrl: DEEP_DIVE[2]!.sourceUrl }];
    case 'delivery':
    case 'fulfillment':
      return [{ claim: DEEP_DIVE[5]!.claim, lane, sourceUrl: SOURCE }];
    case 'buyingEvidence':
      return [
        {
          claim: 'The Westfield drainage authority published request 2026-441 on 28 September 2026.',
          lane,
          sourceUrl: SOURCE,
        },
      ];
    default:
      return null;
  }
}

async function readingOf(opportunity: CashOpportunity): Promise<TierReading> {
  return cashTier({
    opportunity,
    card: cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }),
    readiness: evidenceCard(opportunity).readiness,
  });
}

describe('an ACTIVE sprint with nothing handcrafted reaches READY_TO_TEST by itself', () => {
  it('discovers, qualifies and readies an opening with no person answering a fact', async () => {
    // The one decision that is a person's: Start. Nothing else is granted by hand.
    const activated = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(activated.ok).toBe(true);
    expect(await listOpportunities({ projectId })).toEqual([]);

    await tick('autonomous');
    const bucket = (await listCandidates({ projectId })).find(
      (one) => one.title === SEARCH_BUCKETS[0]!.title,
    );
    expect(bucket, 'discovery opened a bucket round on its own').toBeDefined();

    // Discovery: a dated published request, typed as an opening by the reader.
    await answer(bucket!.id, bucket!.statement, [
      {
        claim:
          'The Westfield drainage authority published request 2026-441 for ownership research ' +
          'on twenty parcels, with a stated budget of USD 2,000, closing 30 October 2026.',
        lane: 'demand_signal',
        sourceUrl: SOURCE,
        signal: 'ACTIVE_BUYER_DEMAND',
      },
    ]);

    const tiers: string[] = [];
    const answered = new Set<string>();
    let piece: CashOpportunity | null = null;
    for (let pass = 0; pass < 12; pass += 1) {
      await tick('autonomous');
      const pieces = await listOpportunities({ projectId });
      piece = pieces[0] ?? null;
      if (!piece) continue;
      const reading = await readingOf(piece);
      if (tiers[tiers.length - 1] !== reading.tier) tiers.push(reading.tier);
      if (reading.tier === 'READY_TO_TEST') break;

      // Answer only what Brain itself asked: the deep dive...
      if (piece.validationState === 'PENDING' && piece.candidateId && !answered.has(piece.candidateId)) {
        if (!(await latestMissionForCandidate(piece.candidateId))) {
          answered.add(piece.candidateId);
          await answer(piece.candidateId, `Qualify: ${piece.title}`, DEEP_DIVE);
        }
      }
      // ...and the card needs it raised for researchable blanks.
      for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
        if (!need.candidateId || answered.has(need.candidateId)) continue;
        if (await latestMissionForCandidate(need.candidateId)) continue;
        const field = need.requestKey?.split(':').pop() ?? '';
        const found = forField(field);
        if (!found) continue;
        answered.add(need.candidateId);
        await answer(need.candidateId, need.nextStep, found);
      }
    }

    expect(piece).not.toBeNull();
    const final = (await getOpportunity(piece!.id))!;
    const reading = await readingOf(final);
    // Where it stopped, if it did, is the first real blocker.
    expect(
      { tier: reading.tier, toAdvance: reading.toAdvance.map((one) => one.key) },
      `the funnel stopped at ${reading.tier}`,
    ).toEqual({ tier: 'READY_TO_TEST', toAdvance: [] });
    // It moved through the funnel truthfully, not straight to the end.
    expect(tiers[0]).toBe('SIGNAL');
    expect(tiers).toContain('READY_TO_TEST');

    // No person answered anything: every fact is research or Brain's proposal.
    const facts = await cardFactsFor(final.id);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.filter((one) => one.kind === 'PERSON')).toEqual([]);
    expect(facts.every((one) => one.decidedBy === 'BRAIN')).toBe(true);

    // Money read from a source's figures, never from prose: the price from the
    // buyer's own stated budget, the exposure from the highest published cost.
    expect(final.priceCents).toBe(200_000);
    expect(final.peakFundingCents).toBe(30_000);
    expect(final.payer).toContain('procurement officer');

    // And Brain declared it ready itself; nobody pressed the button.
    expect(final.state).toBe('READY');
  }, 120_000);
});

describe('a money field is read from a figure, never from a sentence', () => {
  it('takes the low end of a price and the high end of a cost, and refuses prose', async () => {
    const { figureFor, COLUMN } = await import('../server/services/cash/answers.ts');
    // The unfavourable end in both directions.
    expect(figureFor('price', 'Published at USD 1,800 to USD 2,400.', 'USD')).toBe(180_000);
    expect(figureFor('exposure', 'Fees of USD 120 and USD 300 apply.', 'USD')).toBe(30_000);
    // A sentence with no figure answers nothing, rather than being written
    // into an integer column — which SQLite would store and Postgres refuse.
    expect(figureFor('price', 'Comparable work is quoted on request.', 'USD')).toBeNull();
    expect(figureFor('exposure', 'Nothing has to be bought first.', 'USD')).toBeNull();
    // A prose field is not a money field.
    expect(figureFor('payer', 'USD 300', 'USD')).toBeNull();
    // And the exposure finally has somewhere to land.
    expect(COLUMN['exposure']).toBe('peak_funding_cents');
  });
});
