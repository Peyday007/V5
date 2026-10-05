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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, restartDatabase } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { advanceWithinAuthority, operate } from '../server/services/cash/operate.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { recordObservation } from '../server/services/cash/journey/deal.ts';
import { requestInvoice } from '../server/services/cash/invoicing.ts';
import { dealPosition } from '../server/services/cash/journey/position.ts';
import { agreementsFor, outcomesFor } from '../server/repos/cashJourney.ts';
import { listInvoices } from '../server/repos/cashInvoices.ts';
import { clearPaymentReader, registerPaymentReader } from '../server/services/cash/providers/payments.ts';
import type { InvoiceReading } from '../server/services/cash/providers/stripe.ts';
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type EffectAdapter } from '../server/services/effects/adapter.ts';
import { agree, fulfil } from './helpers/cashDeal.ts';
import { recordMoneyEvent } from '../server/services/cash/opportunities.ts';
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
import {
  CAPTURE_KEY,
  cashTier,
  UNIVERSAL_QUALIFICATION,
  type TierReading,
} from '../server/services/cash/tier.ts';
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

interface Journey {
  final: CashOpportunity;
  reading: TierReading;
  /** Every tier the piece was observed at, in order, with the card then. */
  observed: { tier: string; fields: string[] }[];
}

interface Variation {
  /** Replaces the discovery claim, e.g. to take the budget figure out of it. */
  discovery?: string;
  /** Replaces the deep dive's answers. */
  deepDive?: Found[];
  /** Per card field: what research finds, or null for nothing found. */
  field?: Record<string, Found[] | null>;
}

/**
 * Drive one ACTIVE sprint from Start, answering only what Brain itself asked.
 *
 * Everything that varies between the tests below is what the open web says;
 * the person's part is always the same single decision.
 */
async function drive(variation: Variation = {}): Promise<Journey> {
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
        variation.discovery ??
        'The Westfield drainage authority published request 2026-441 for ownership research ' +
          'on twenty parcels, with a stated budget of USD 2,000, closing 30 October 2026.',
      lane: 'demand_signal',
      sourceUrl: SOURCE,
      signal: 'ACTIVE_BUYER_DEMAND',
    },
  ]);

  const observed: Journey['observed'] = [];
  const answered = new Set<string>();
  let piece: CashOpportunity | null = null;
  for (let pass = 0; pass < 12; pass += 1) {
    await tick('autonomous');
    const pieces = await listOpportunities({ projectId });
    piece = pieces[0] ?? null;
    if (!piece) continue;
    const reading = await readingOf(piece);
    if (observed[observed.length - 1]?.tier !== reading.tier) {
      observed.push({
        tier: reading.tier,
        fields: (await cardFactsFor(piece.id)).map((one) => one.field),
      });
    }
    if (reading.tier === 'READY_TO_TEST') break;

    // Answer only what Brain itself asked: the deep dive...
    if (piece.validationState === 'PENDING' && piece.candidateId && !answered.has(piece.candidateId)) {
      if (!(await latestMissionForCandidate(piece.candidateId))) {
        answered.add(piece.candidateId);
        await answer(piece.candidateId, `Qualify: ${piece.title}`, variation.deepDive ?? DEEP_DIVE);
      }
    }
    // ...and the card needs it raised for researchable blanks.
    for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
      if (!need.candidateId || answered.has(need.candidateId)) continue;
      if (await latestMissionForCandidate(need.candidateId)) continue;
      const field = need.requestKey?.split(':').pop() ?? '';
      const found =
        variation.field && field in variation.field ? variation.field[field]! : forField(field);
      if (!found) continue;
      answered.add(need.candidateId);
      await answer(need.candidateId, need.nextStep, found);
    }
  }

  expect(piece).not.toBeNull();
  const final = (await getOpportunity(piece!.id))!;
  return { final, reading: await readingOf(final), observed };
}

describe('an ACTIVE sprint with nothing handcrafted reaches READY_TO_TEST by itself', () => {
  it('discovers, qualifies and readies an opening with no person answering a fact', async () => {
    const { final, reading, observed } = await drive();
    const tiers = observed.map((one) => one.tier);
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

    // Replaying the whole operating step changes nothing: no second fact, no
    // second answer event, no reopened need. Idempotent by the need's own
    // closure, not by a flag.
    const factsBefore = (await cardFactsFor(final.id)).length;
    const answeredBefore = await answerEvents(final.id);
    for (let again = 0; again < 3; again += 1) await tick('autonomous');
    const { applyResearchAnswers } = await import('../server/services/cash/answers.ts');
    expect((await applyResearchAnswers(projectId)).applied).toEqual([]);
    expect((await cardFactsFor(final.id)).length).toBe(factsBefore);
    expect(await answerEvents(final.id)).toBe(answeredBefore);

    // A restart holds no memory to lose: the facts and the tier are rows.
    await restartDatabase();
    const reread = (await getOpportunity(final.id))!;
    expect(reread.priceCents).toBe(200_000);
    expect(reread.peakFundingCents).toBe(30_000);
    expect((await cardFactsFor(final.id)).length).toBe(factsBefore);
    expect((await readingOf(reread)).tier).toBe('READY_TO_TEST');
  }, 120_000);

  it('reaches each tier only once the facts it is derived from are on the card', async () => {
    const { observed } = await drive();
    // A tier can be passed through inside one tick, so every observation is
    // held against what its own tier is derived from, rather than expecting to
    // see each rung.
    const rank = (tier: string) => ['SIGNAL', 'CANDIDATE', 'QUALIFIED', 'READY_TO_TEST'].indexOf(tier);
    expect(observed[0]!.tier).toBe('SIGNAL');
    expect(observed[0]!.fields).not.toContain('payer');
    for (const { tier, fields } of observed) {
      if (rank(tier) >= rank('CANDIDATE')) {
        expect(fields, `${tier} without a payer and a capture mechanism`).toEqual(
          expect.arrayContaining(['payer', CAPTURE_KEY]),
        );
      }
      if (rank(tier) >= rank('QUALIFIED')) {
        for (const key of UNIVERSAL_QUALIFICATION) {
          expect(fields, `${tier} without ${key}`).toContain(key);
        }
      }
      if (rank(tier) >= rank('READY_TO_TEST')) {
        expect(fields, `${tier} without the bounded-test money`).toEqual(
          expect.arrayContaining(['price', 'exposure']),
        );
      }
    }
    expect(observed.map((one) => one.tier)).toContain('READY_TO_TEST');
  }, 120_000);
});

describe('the autonomous funnel cannot skip evidence it does not have', () => {
  it('stays a SIGNAL when nothing establishes who pays', async () => {
    const { final, reading } = await drive({
      field: { payer: null },
      deepDive: DEEP_DIVE.filter((one) => one.lane !== 'payer'),
    });
    expect(reading.tier).toBe('SIGNAL');
    expect(final.payer).toBeNull();
    expect(final.state).not.toBe('READY');
  }, 120_000);

  it('stops short of QUALIFIED when the deep dive leaves part of the thesis unanswered', async () => {
    const { final, reading } = await drive({
      deepDive: DEEP_DIVE.filter((one) => one.lane !== 'disqualifier' && one.lane !== 'eligibility'),
    });
    expect(['SIGNAL', 'CANDIDATE']).toContain(reading.tier);
    expect(reading.toAdvance.map((one) => one.key)).toEqual(
      expect.arrayContaining(['disqualifiers']),
    );
    expect(final.state).not.toBe('READY');
  }, 120_000);

  it('leaves the exposure unknown when no research states a cost, and price research cannot fill it', async () => {
    const { final, reading } = await drive({
      // The deep dive's cost answer is prose, so nothing proposes an exposure...
      deepDive: DEEP_DIVE.map((one) =>
        one.lane === 'cost_evidence'
          ? { ...one, claim: 'The county recorder publishes title-search fees on request.' }
          : one,
      ),
      // ...and the exposure question itself comes back with no figure.
      field: {
        exposure: [
          {
            claim: 'The notice says nothing has to be bought before the work is delivered.',
            lane: 'demand_signal',
            sourceUrl: SOURCE,
          },
        ],
      },
    });
    // The price research did state figures; none of them reached the exposure.
    expect(final.priceCents).toBe(200_000);
    expect(final.peakFundingCents).toBeNull();
    expect(reading.tier).not.toBe('READY_TO_TEST');
    expect(final.state).not.toBe('READY');
    // The need is still open and says why, rather than closing on prose.
    const exposureNeed = (await listNeeds({ projectId, states: ['OPEN'] })).find(
      (need) => need.requestKey?.endsWith(':exposure'),
    );
    expect(exposureNeed, 'the exposure question stays open').toBeDefined();
    expect((await cardFactsFor(final.id)).some((one) => one.field === 'exposure')).toBe(false);
  }, 120_000);

  it('writes a researched price as cents, and refuses a price stated only in prose', async () => {
    // The discovery and the deep dive state no figure, so the only way a price
    // reaches the card is the card question's own research — the writer that
    // put the claim sentence into the integer column.
    const noFigures = {
      discovery:
        'The Westfield drainage authority published request 2026-441 for ownership research ' +
        'on twenty parcels, closing 30 October 2026.',
      deepDive: DEEP_DIVE.map((one) =>
        one.lane === 'price_evidence'
          ? { ...one, claim: 'Comparable parcel-ownership research engagements are quoted on request.' }
          : one,
      ),
    };
    const priced = await drive({
      ...noFigures,
      field: {
        price: [
          {
            claim:
              'The authority awarded the last comparable parcel-ownership review for USD 1,850 ' +
              'and the one before it for USD 2,100.',
            lane: 'demand_signal',
            sourceUrl: 'https://example.test/westfield/awards',
          },
        ],
      },
    });
    expect(typeof priced.final.priceCents).toBe('number');
    expect(priced.final.priceCents).toBe(185_000);
    const fact = (await cardFactsFor(priced.final.id)).find((one) => one.field === 'price');
    expect(fact?.kind).toBe('EVIDENCE');
    expect(fact?.claimId).toBeTruthy();
    expect(fact?.value).toContain('USD 1,850');
  }, 120_000);

  it('leaves the price unknown when research states it only in words', async () => {
    const { final, reading } = await drive({
      discovery:
        'The Westfield drainage authority published request 2026-441 for ownership research ' +
        'on twenty parcels, closing 30 October 2026.',
      deepDive: DEEP_DIVE.map((one) =>
        one.lane === 'price_evidence'
          ? { ...one, claim: 'Comparable parcel-ownership research engagements are quoted on request.' }
          : one,
      ),
      field: {
        price: [
          {
            claim: 'The authority pays roughly two thousand for work of this kind.',
            lane: 'demand_signal',
            sourceUrl: 'https://example.test/westfield/awards',
          },
        ],
      },
    });
    expect(final.priceCents).toBeNull();
    expect(reading.tier).not.toBe('READY_TO_TEST');
    expect((await cardFactsFor(final.id)).some((one) => one.field === 'price' && one.kind === 'EVIDENCE')).toBe(false);
  }, 120_000);
});

describe('a proposed exposure never replaces a figure that is not a proposal', () => {
  it('leaves a column set by anything else alone, and computes the margin from what the card holds', async () => {
    const { createOpportunity, updateOpportunity } = await import('../server/repos/cashPortfolio.ts');
    const { recordCardFact } = await import('../server/repos/cashCardFacts.ts');
    const { getCashMode } = await import('../server/repos/cashMode.ts');
    const { proposeTerms, applyProposal } = await import('../server/services/cash/answers.ts');
    await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' });
    const piece = await createOpportunity({
      projectId,
      cashModeId: (await getCashMode(projectId))!.id,
      ownerUserId: userId,
      title: 'A published request for parcel research',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      source: 'RESEARCH',
      currency: 'USD',
      sourceClaimId: 'clm_fixture',
    } as never);
    await recordCardFact({
      projectId,
      opportunityId: piece.id,
      field: 'directCosts',
      kind: 'EVIDENCE',
      value: 'The county recorder publishes title-search fees totalling USD 300.',
      decidedBy: 'BRAIN',
    } as never);

    await updateOpportunity(piece.id, {
      buying_signal: 'The authority published request 2026-441 for ownership research, budget USD 2,000.',
      signal_observed_at: '2026-09-28',
    } as never);

    // A column written by some other path, with no card fact behind it.
    await updateOpportunity(piece.id, { peak_funding_cents: 75_000, price_cents: 200_000 } as never);
    const held = (await getOpportunity(piece.id))!;
    const proposal = await proposeTerms(held);
    // Not vacuous: the proposal did run, and proposed something.
    expect(proposal.terms.length).toBeGreaterThan(0);
    expect(proposal.terms.some((term) => term.field === 'exposure')).toBe(false);
    await applyProposal({ opportunity: held, proposal });
    expect((await getOpportunity(piece.id))!.peakFundingCents).toBe(75_000);
    // The margin is against the 750 the card holds, not the 300 it might have proposed.
    const economics = proposal.terms.find((term) => term.field === 'economics');
    expect(economics?.value).toContain('1,250.00');

    // With nothing on the column, the published cost is proposed and written.
    await updateOpportunity(piece.id, { peak_funding_cents: null } as never);
    const blank = (await getOpportunity(piece.id))!;
    const proposed = await proposeTerms(blank);
    expect(proposed.terms.find((term) => term.field === 'exposure')?.cents).toBe(30_000);
    await applyProposal({ opportunity: blank, proposal: proposed });
    expect((await getOpportunity(piece.id))!.peakFundingCents).toBe(30_000);

    // The proposal path applies the writer's rule too: a rate is not a price,
    // and a figure Postgres's INTEGER cannot hold is not proposed.
    for (const signal of [
      'The authority pays $25 per hour for ownership research.',
      'The authority budgets $30,000,000 for the programme.',
    ]) {
      await updateOpportunity(piece.id, { buying_signal: signal, price_cents: null } as never);
      const again = await proposeTerms((await getOpportunity(piece.id))!);
      expect(again.terms.some((term) => term.field === 'price'), signal).toBe(false);
    }
  });
});

async function answerEvents(opportunityId: string): Promise<number> {
  const { cashEventsOfKind } = await import('../server/repos/cashMode.ts');
  return (await cashEventsOfKind(opportunityId, 'CASH_CARD_ANSWERED')).length;
}

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

  it('refuses a figure that is ambiguous, in another currency, a rate, or too large for the column', async () => {
    const { figureFor, MAX_COLUMN_CENTS } = await import('../server/services/cash/answers.ts');
    // Ambiguous: no currency marker, shorthand, a spelled-out scale, a percentage.
    expect(figureFor('price', 'Comparable work pays 1,800 to 2,400.', 'USD')).toBeNull();
    expect(figureFor('price', 'Comparable work pays $1.8k.', 'USD')).toBeNull();
    expect(figureFor('price', 'The programme is $1,200 million.', 'USD')).toBeNull();
    expect(figureFor('price', 'A fee of 15% of $ value.', 'USD')).toBeNull();
    // Another currency's dollar sign is not this currency's.
    expect(figureFor('price', 'Quoted at C$1,200.', 'USD')).toBeNull();
    expect(figureFor('exposure', 'Fees are HK$900 and A$5,000.', 'USD')).toBeNull();
    // US$ is still dollars.
    expect(figureFor('price', 'Quoted at US$1,200.', 'USD')).toBe(120_000);
    // A rate is not a total, so it answers neither field...
    expect(figureFor('price', 'Paid at $25 per hour.', 'USD')).toBeNull();
    expect(figureFor('exposure', 'Software at $49/mo.', 'USD')).toBeNull();
    // ...but a total beside it still does.
    expect(figureFor('price', 'Paid at $25 per hour, capped at $2,000.', 'USD')).toBe(200_000);
    // Above what Postgres's INTEGER column holds: unanswerable, never clipped.
    expect(figureFor('exposure', 'A $30,000,000 machine is required.', 'USD')).toBeNull();
    expect(MAX_COLUMN_CENTS).toBe(2_147_483_647);
  });
});

/*
 * The whole money stack as one system. The two halves were each proven
 * separately — this file to READY_TO_TEST, `cashFirstDollar` from a card a
 * test filled in — and nothing held one opportunity across the seam. Here the
 * opening the autonomous funnel found and readied is the one Brain contacts,
 * agrees, invoices, collects, fulfils, settles and learns from. Only the
 * providers are fakes; every transition is the service a route or the tick
 * calls, and a restart and a replay in the middle must double nothing.
 */
describe('one opportunity from discovery to learning, across the seam', () => {
  const sends: Record<string, Record<string, unknown>[]> = {};
  const readings: Record<string, InvoiceReading> = {};

  function sandbox(action: keyof typeof COMMERCIAL_EFFECTS, prefix: string): void {
    sends[action] ??= [];
    const list = sends[action]!;
    const adapter: EffectAdapter = {
      name: `sandbox.${action.toLowerCase()}`,
      effectClass: 'EXTERNAL_OPAQUE',
      namespace: COMMERCIAL_EFFECTS[action].namespace.name,
      validate: (payload) => payload as Record<string, unknown>,
      fingerprintInputs: (payload) => payload,
      send: async (request) => {
        list.push(request.payload as Record<string, unknown>);
        return { kind: 'CONFIRMED', receiptRef: `${prefix}-${list.length}` };
      },
    };
    registerAdapter(adapter);
  }

  function connect(): void {
    clearAdapters();
    sandbox('CONTACT_BUYER', 'msg');
    sandbox('QUOTE_AND_INVOICE', 'inv');
    registerPaymentReader({
      name: 'sandbox.invoice_payments',
      provider: 'sandbox',
      health: () => ({ usable: true, reason: 'sandbox' }),
      read: async (id) =>
        readings[id] ?? {
          kind: 'READ', status: 'open', hostedUrl: `https://pay.example/${id}`, number: `N-${id}`,
          amountPaidCents: 0, currency: 'USD', chargeId: null, paidAt: null, balance: null,
        },
    });
  }

  let clock = Date.now();
  const pass = async () => {
    clock += 10 * 60 * 1000;
    await operate(projectId, new Date(clock).toISOString());
  };

  async function entries(opportunityId: string): Promise<Record<string, number>> {
    const rows = await getDb().all<{ kind: string; n: number }>(
      'SELECT kind, COUNT(*) AS n FROM cash_money_entries WHERE opportunity_id = ? GROUP BY kind',
      [opportunityId],
    );
    return Object.fromEntries(rows.map((one) => [one.kind, Number(one.n)]));
  }

  afterEach(() => {
    clearAdapters();
    clearPaymentReader();
  });

  it('discovers, qualifies, contacts, agrees, invoices, collects, fulfils, settles and learns', async () => {
    // DISCOVERY → SIGNAL → CANDIDATE → QUALIFIED → READY_TO_TEST, autonomously.
    const { final, reading, observed } = await drive();
    expect(observed[0]!.tier).toBe('SIGNAL');
    expect(reading.tier).toBe('READY_TO_TEST');
    expect(final.state).toBe('READY');
    const id = final.id;

    // A person's standing commercial grant, and the providers connected.
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000,
      maxPerActionCents: 300_000,
      maxConcurrent: 3,
      currency: 'USD',
    });
    // The opening needs money out before money comes back, so the sprint has
    // capital; without it Brain contacts and correctly declines to execute.
    const capital = await recordMoneyEvent({
      projectId,
      kind: 'CAPITAL_IN',
      amountCents: 50_000,
      currency: 'USD',
      verifiedReference: 'owner transfer 2026-10-05',
      idempotencyKey: 'capital:seam',
      actorRef: userId,
    });
    expect(capital.ok).toBe(true);
    connect();

    // CONTACT: Brain reaches the one published address, by itself.
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(id))!.state).toBe('EXECUTING');
    expect(sends.CONTACT_BUYER).toHaveLength(1);
    expect(sends.CONTACT_BUYER![0]).toMatchObject({ to: 'procurement@westfield-drainage.example' });

    // BUYER RESPONSE is evidence; AGREEMENT is its own owner.
    const reply = await recordObservation({
      opportunityId: id,
      kind: 'BUYER_ACCEPTED',
      source: 'PERSON',
      evidenceRef: 'reply 2026-10-05 "proceed at USD 2,000"',
      actorRef: userId,
    });
    expect(reply.ok).toBe(true);
    const agreement = await agree(id, 200_000, userId);

    // A restart between the agreement and the invoice: nothing is resent.
    clearAdapters();
    await restartDatabase();
    connect();
    await pass();
    expect(sends.CONTACT_BUYER).toHaveLength(1);

    // INVOICE: the agreement's amount, the person's terms; the tick issues it.
    const drafted = await requestInvoice({
      projectId,
      opportunityId: id,
      customerName: 'Westfield Drainage Authority',
      customerEmail: 'accounts@westfield-drainage.example',
      taxTreatment: 'NO_TAX_CHARGED',
      dueDate: '2099-01-31',
      actorRef: userId,
    });
    expect(drafted.ok).toBe(true);
    if (drafted.ok) expect(drafted.value.amountCents).toBe(200_000);
    await pass();
    await pass();
    expect(sends.QUOTE_AND_INVOICE).toHaveLength(1);
    const [issued] = await listInvoices({ projectId, opportunityId: id });
    expect(issued).toMatchObject({ state: 'ISSUED', amountCents: 200_000, providerInvoiceId: 'inv-1' });

    // PAYMENT is earned, not cash.
    readings['inv-1'] = {
      kind: 'READ', status: 'paid', hostedUrl: null, number: 'N-inv-1', amountPaidCents: 200_000,
      currency: 'USD', chargeId: 'ch-inv-1', paidAt: new Date().toISOString(),
      balance: { id: 'txn-inv-1', status: 'pending', currency: 'USD', amountCents: 200_000, feeCents: 0, availableOn: null },
    };
    await pass();
    expect((await dealPosition({ opportunity: (await getOpportunity(id))!, currency: 'USD' })).paymentState).toBe(
      'PAID_UNSETTLED',
    );
    expect((await cashPosition({ projectId, currency: 'USD' })).availableFundsCents).toBe(50_000);

    // FULFILMENT → DELIVERY → ACCEPTANCE, each its own fact. Paid is not done.
    await fulfil(agreement, userId);
    await pass();
    expect((await getOpportunity(id))!.state).toBe('DELIVERING');

    // SETTLEMENT and the provider's fee, once each.
    readings['inv-1'] = {
      ...(readings['inv-1'] as Extract<InvoiceReading, { kind: 'READ' }>),
      balance: { id: 'txn-inv-1', status: 'available', currency: 'USD', amountCents: 200_000, feeCents: 5_830, availableOn: new Date().toISOString() },
    };
    await pass();
    await pass();
    expect((await getOpportunity(id))!.state).toBe('COLLECTED');
    await pass();

    // CONTRIBUTION from rows: settled less the fee, nothing counted twice.
    const deal = await dealPosition({ opportunity: (await getOpportunity(id))!, currency: 'USD' });
    expect(deal.stage).toBe('COMPLETE');
    expect(deal.pnl).toMatchObject({
      agreedRevenueCents: 200_000,
      customerPaymentsCents: 200_000,
      settledCashCents: 200_000,
      unsettledCents: 0,
      contributionCents: 194_170,
      owedByBuyerCents: 0,
    });

    // LEARNING: terminal evidence, once, carrying the price research found.
    const learned = await outcomesFor({ projectId, opportunityId: id });
    expect(learned.find((one) => one.kind === 'CONTACT_RESULT')!.valueText).toBe('BUYER_ACCEPTED');
    expect(learned.find((one) => one.kind === 'ACCEPTED_PRICE')!.valueCents).toBe(200_000);

    // A replay of every pass, and a second restart, change nothing anywhere.
    const before = { money: await entries(id), learned: learned.length };
    clearAdapters();
    await restartDatabase();
    connect();
    for (let again = 0; again < 4; again += 1) await pass();
    await tick('autonomous');
    expect(await entries(id)).toEqual(before.money);
    expect(before.money).toEqual({ PIPELINE_AGREED: 1, CUSTOMER_PAYMENT: 1, SETTLEMENT: 1, COST: 1 });
    expect((await outcomesFor({ projectId, opportunityId: id })).length).toBe(before.learned);
    expect([sends.CONTACT_BUYER!.length, sends.QUOTE_AND_INVOICE!.length]).toEqual([1, 1]);
    expect(await agreementsFor(id)).toHaveLength(1);
  }, 180_000);
});
