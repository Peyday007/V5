/**
 * One cross-border deal, walked the whole way, through the entrances a real
 * session uses.
 *
 * ---------------------------------------------------------------------------
 * Why this exists beside the unit suite
 * ---------------------------------------------------------------------------
 *
 * §24 records the lesson at length and §30 repeats it: walking the journey
 * found five transitions that existed, were tested, and could be reached by
 * nothing — every one invisible to a test that arranged its own starting
 * state. A test that hands `fileFindings` a claim row is testing the filing; it
 * cannot tell a mechanism from a function nothing calls.
 *
 * So this file starts from a person activating a sprint and drives the loop the
 * brief asks for:
 *
 *   discover both sides → pair → research the compliance envelope
 *   → establish the landed cost → establish how the trade pays
 *   → find the decision maker → reach outreach-ready → promote into the
 *   portfolio → record what the attempt taught
 *
 * ---------------------------------------------------------------------------
 * Only the external edge is simulated
 * ---------------------------------------------------------------------------
 *
 * The worker authenticates as a `WORKER` principal, claims a real item off the
 * durable queue and submits through `brain_submit_claims` and
 * `brain_submit_verification`. So everything a fired Cowork session is held to
 * actually runs: the scope check, the lease and generation proof, the lane
 * validation, Step 6's idempotency scope, the pass records, and Brain's own
 * seven-condition gate.
 *
 * **That is the half that matters most here.** §33 records what happens when a
 * declaration is named in a tool's prose and left out of its schema: a client
 * honouring `additionalProperties: false` drops the one field that decides
 * whether anything is ever created, and the failure reads exactly like a worker
 * honestly finding nothing. A test that wrote `deal_finding` straight into the
 * claims table would pass against precisely that defect. This one puts every
 * declaration through the wire.
 *
 * What stays fixture is the sentences a worker found and the two judgements
 * only a reader of a source can make. **Two things this is not**, said rather
 * than assumed: not a live Cowork session — no Routine fires, no provider is
 * called, nothing external is read — and the tool *layer* rather than the MCP
 * *transport*, which `tests/mcp.test.ts` and `tests/oauth.test.ts` cover.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { findTool } from '../server/mcp/tools.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { approvePlan, advancePacket } from '../server/services/research/packetRunner.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listDealRounds, listDeals, listParties } from '../server/repos/dealflow.ts';
import { getOpportunity } from '../server/repos/cashPortfolio.ts';
import { runDealflowKernel } from '../server/services/dealflow/kernel.ts';
import { dealflowView } from '../server/services/dealflow/view.ts';
import { observe } from '../server/services/dealflow/seed.ts';
import type { ClaimedWork, Layer, Principal, ProjectMembership, WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = [
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

const CLASS = 'fuel tank trailers';
const MARKET = 'Zambia';

let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');

  const user = await createUser({
    email: `walk-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;

  const worker = await createWorker({
    name: `deal-worker-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'The dealflow worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

function workerPrincipal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'deal-worker',
    displayName: 'The dealflow worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_deal_walk',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_deal_walk',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: SCOPES,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      } as ProjectMembership,
    ],
    requestId: 'req_deal_walk',
  } as Principal;
}

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const found = findTool(name);
  if (!found) throw new Error(`no such tool: ${name}`);
  const outcome = await found.run(args, {
    principal: workerPrincipal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, any>;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

async function claimQueued(type: string): Promise<ClaimedWork> {
  const outcome = await tool('brain_claim_work', {
    project_id: projectId,
    work_types: [type],
    limit: 1,
  });
  const [claimed] = (outcome['claimed'] ?? []) as ClaimedWork[];
  if (!claimed) {
    throw new Error(`Brain queued nothing of type ${type}: ${JSON.stringify(outcome).slice(0, 400)}`);
  }
  return claimed;
}

/** What a worker submits for one claim, as it goes over the wire. */
interface WireClaim {
  claim: string;
  deal_finding?: string;
  deal_subject?: string;
  deal_equipment?: string;
  deal_jurisdiction?: string;
  deal_value?: string;
  deal_amount_cents?: number;
  deal_currency?: string;
  searched_repositories?: string[];
  claim_type?: string;
}

/**
 * One kernel round answered by a worker, through the real tools.
 *
 * The orchestration is attached to the round's own candidate through a
 * mission, which is how the filing knows which round a set of claims belongs
 * to — a round whose candidate no mission names belongs to nothing, and its
 * claims are correctly ignored.
 */
async function workerAnswers(input: {
  candidateId: string;
  question: string;
  claims: WireClaim[];
}): Promise<void> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: input.question,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: input.question,
    assignment: input.question,
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      requiredEvidence: [
        {
          id: 'dealflow',
          description: 'what the sources establish about this transaction',
          necessity: 'REQUIRED' as const,
        },
      ],
      acceptableSourceTypes: ['a published page a source identifies by URL'],
      excludedSourceTypes: ['a plausible party nobody published anything about'],
      completionCriteria: ['every finding declared on its own claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: `dealflow-${Math.random().toString(36).slice(2, 8)}`,
      question: input.question,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const approved = await approvePlan({
    orchestrationId: orchestration.id,
    approvedByUserId: userId,
  });
  expect(approved.enqueued.length).toBeGreaterThan(0);

  const researching = await claimQueued('RESEARCH_FRAGMENT');
  const submitted = await tool('brain_submit_claims', {
    ...proof(researching),
    claims: input.claims.map((one, index) => ({
      claim: one.claim,
      claim_type: one.claim_type ?? 'SOURCED_FACT',
      source_url: `https://example.test/source/${index}`,
      source_title: 'A published page',
      source_publisher: 'A ministry of transport',
      source_date: '2026-08-01',
      evidence_excerpt: one.claim,
      evidence_locator: 'the page body',
      evidence_lane: 'dealflow',
      retrieved_at: '2026-09-12',
      confidence: 0.9,
      primary_source: true,
      ...(one.searched_repositories ? { searched_repositories: one.searched_repositories } : {}),
      ...(one.deal_finding ? { deal_finding: one.deal_finding } : {}),
      ...(one.deal_subject ? { deal_subject: one.deal_subject } : {}),
      ...(one.deal_equipment ? { deal_equipment: one.deal_equipment } : {}),
      ...(one.deal_jurisdiction ? { deal_jurisdiction: one.deal_jurisdiction } : {}),
      ...(one.deal_value ? { deal_value: one.deal_value } : {}),
      ...(one.deal_amount_cents !== undefined
        ? { deal_amount_cents: one.deal_amount_cents }
        : {}),
      ...(one.deal_currency ? { deal_currency: one.deal_currency } : {}),
    })),
    search_queries: [input.question],
  });
  // The worker never decides acceptance, and nothing here pretends otherwise.
  expect(submitted['accepted']).toBe(0);
  const stored = submitted['claims'] as { claimId: string }[];
  expect(stored.length).toBe(input.claims.length);

  await tool('brain_complete_work', {
    ...proof(researching),
    result_ref: String(submitted['recorded']),
    summary: 'claims submitted',
  });

  await advancePacket(orchestration.id);
  const verifying = await claimQueued('RESEARCH_VERIFY');
  await tool('brain_submit_verification', {
    ...proof(verifying),
    verdicts: stored.map((row) => ({
      claim_id: row.claimId,
      supports_claim: true,
      geography: 'MATCH',
      timeframe: 'MATCH',
      population: 'MATCH',
      definitions: 'MATCH',
      geography_basis: 'Judged against the market the fragment declares.',
      timeframe_basis: 'Judged against the timeframe the fragment declares.',
      population_basis: 'Judged against the population the fragment declares.',
      definitions_basis: 'Judged against the definitions the fragment declares.',
      note: 'Read the page.',
    })),
    sufficiency: 'SUFFICIENT',
    missing_lanes: [],
    unresolved_gaps: [],
  });
  await tool('brain_complete_work', {
    ...proof(verifying),
    result_ref: 'gated',
    summary: 'verified and gated',
  });

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: input.question,
    whyNow: 'the kernel asked',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
}

/** The candidate of the round Brain has open, whatever its purpose. */
async function openRound(): Promise<{ candidateId: string; purpose: string }> {
  const rounds = await listDealRounds(projectId);
  const open = rounds.find((one) => one.state === 'OPEN');
  if (!open) throw new Error('the kernel has no question open');
  return { candidateId: open.candidateId, purpose: open.purpose };
}

describe('one deal, from an activated sprint to the portfolio', () => {
  it('walks the loop the brief asks for, with every declaration through the wire', async () => {
    // ---------------------------------------------------------------
    // A person activates the sprint. Nothing about dealflow exists yet.
    // ---------------------------------------------------------------
    expect(
      (
        await activate({
          projectId,
          ownerUserId: userId,
          actorUserId: userId,
          objective: 'Maximize additional usable cash over the next few weeks.',
        })
      ).ok,
    ).toBe(true);

    // ---------------------------------------------------------------
    // 1. DISCOVER BOTH SIDES.
    //
    // The kernel opens the one question it can — there is no class on the
    // map, so nothing two-sided can be asked yet.
    // ---------------------------------------------------------------
    let pass = await runDealflowKernel(projectId);
    expect(pass.opened.map((one) => one.purpose)).toEqual(['SEED_EQUIPMENT']);

    const seed = await openRound();
    await workerAnswers({
      candidateId: seed.candidateId,
      question: 'Which industrial equipment moves across borders this way?',
      claims: [
        {
          claim: 'A mining operator published a haulage fleet expansion requiring road tankers.',
          deal_finding: 'BUYER_NEED',
          deal_subject: 'Kabwe Mining',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
        },
        {
          claim: 'A manufacturer publishes export capability and models for this class.',
          deal_finding: 'SUPPLIER_CAPABILITY',
          deal_subject: 'Shandong Heavy Vehicles',
          deal_equipment: CLASS,
          deal_jurisdiction: 'China',
        },
        {
          claim: 'The manufacturer publishes an ex-works price for the configuration.',
          deal_finding: 'COST_COMPONENT',
          deal_subject: 'one unit',
          deal_equipment: CLASS,
          deal_jurisdiction: 'China',
          deal_value: 'FACTORY_PRICE',
          deal_amount_cents: 30_000_00,
          deal_currency: 'USD',
        },
      ],
    });

    /*
     * The declarations survived the wire. §33's defect is exactly this
     * assertion failing while everything around it reads healthy, so it is
     * checked before anything downstream is.
     */
    pass = await runDealflowKernel(projectId);
    expect(pass.filed.parties.length).toBe(2);
    expect(pass.filed.costs.length).toBe(1);
    expect(pass.filed.refused).toEqual([]);

    // 2. PAIR. Both sides of one class exist, so a deal candidate does.
    expect(pass.paired.length).toBe(1);
    const deals = await listDeals(projectId);
    expect(deals[0]!.equipmentClass).toBe(CLASS);

    // The buyer's market came from the declared column, never from the prose.
    const buyer = (await listParties(projectId)).find((one) => one.kind === 'BUYER');
    expect(buyer?.country).toBe(MARKET);

    // ---------------------------------------------------------------
    // 3. VERIFY REQUIREMENTS.
    //
    // The kernel asks for the compliance envelope, because an unresearched
    // layer is the cheapest thing that can still make the pairing worthless.
    // ---------------------------------------------------------------
    expect(pass.opened.map((one) => one.purpose)).toEqual(['COMPLIANCE']);
    const compliance = await openRound();
    expect(compliance.purpose).toBe('COMPLIANCE');

    await workerAnswers({
      candidateId: compliance.candidateId,
      question: `What does ${MARKET} demand of ${CLASS}?`,
      claims: [
        {
          claim: 'Road tankers require type approval before they may be registered.',
          deal_finding: 'COMPLIANCE_REQUIREMENT',
          deal_subject: 'Type approval',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'MARKET_APPROVAL',
        },
        {
          claim: 'Tanks carrying fuel require periodic pressure testing and marking.',
          deal_finding: 'COMPLIANCE_REQUIREMENT',
          deal_subject: 'Tank testing and marking',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'PRODUCT_CERTIFICATION',
        },
        {
          claim: 'Import of this heading is permitted subject to duty; no ban or quota applies.',
          deal_finding: 'REQUIREMENT_ABSENCE',
          deal_subject: 'no import prohibition',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'IMPORT_BARRIER',
          claim_type: 'NEGATIVE_EXISTENCE',
          searched_repositories: ['the customs tariff schedule', 'the trade restrictions register'],
        },
        {
          claim: 'No separate factory approval is demanded of foreign manufacturers.',
          deal_finding: 'REQUIREMENT_ABSENCE',
          deal_subject: 'no factory certification demanded',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'FACTORY_CERTIFICATION',
          claim_type: 'NEGATIVE_EXISTENCE',
          searched_repositories: ['the standards bureau register', 'the transport authority rules'],
        },
        {
          claim: 'The operator publishes its own vendor safety specification for tankers.',
          deal_finding: 'COMPLIANCE_REQUIREMENT',
          deal_subject: 'Buyer vendor safety specification',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'BUYER_ACCEPTANCE',
        },
      ],
    });

    pass = await runDealflowKernel(projectId);
    expect(pass.filed.requirements.length).toBe(5);

    /*
     * All five layers answered, and two of them by a *documented* absence —
     * which is a different fact from nobody having looked, and the only reason
     * this envelope can read as established at all.
     */
    let view = await dealflowView(projectId);
    expect(view.markets[0]!.envelopes[0]!.verdict).toBe('ESTABLISHED');

    // ---------------------------------------------------------------
    // 4. ESTIMATE TRUE LANDED ECONOMICS.
    // ---------------------------------------------------------------
    expect(pass.opened.map((one) => one.purpose)).toEqual(['LANDED_COST']);
    const landed = await openRound();
    await workerAnswers({
      candidateId: landed.candidateId,
      question: `What does it cost to land ${CLASS} in ${MARKET}?`,
      claims: [
        {
          claim: 'The published freight rate on this lane.',
          deal_finding: 'COST_COMPONENT',
          deal_subject: 'one unit',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'OCEAN_FREIGHT',
          deal_amount_cents: 4_000_00,
          deal_currency: 'USD',
        },
        {
          claim: 'The duty rate for this tariff heading.',
          deal_finding: 'COST_COMPONENT',
          deal_subject: 'one unit',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'IMPORT_DUTY',
          deal_amount_cents: 5_700_00,
          deal_currency: 'USD',
        },
        {
          claim: 'Published clearance and port charges.',
          deal_finding: 'COST_COMPONENT',
          deal_subject: 'one unit',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'CUSTOMS_CLEARANCE',
          deal_amount_cents: 800_00,
          deal_currency: 'USD',
        },
        {
          claim: 'Published inland haulage from the port to the region.',
          deal_finding: 'COST_COMPONENT',
          deal_subject: 'one unit',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'INLAND_DESTINATION',
          deal_amount_cents: 1_200_00,
          deal_currency: 'USD',
        },
        {
          claim: 'What operators in this market pay for comparable equipment today.',
          deal_finding: 'COST_COMPONENT',
          deal_subject: 'one unit',
          deal_equipment: CLASS,
          deal_jurisdiction: MARKET,
          deal_value: 'BUYER_ALTERNATIVE',
          deal_amount_cents: 52_000_00,
          deal_currency: 'USD',
        },
      ],
    });

    pass = await runDealflowKernel(projectId);
    expect(pass.filed.costs.length).toBe(5);

    // ---------------------------------------------------------------
    // 5. DETERMINE THE COMMERCIAL STRUCTURE.
    // ---------------------------------------------------------------
    expect(pass.opened.map((one) => one.purpose)).toEqual(['STRUCTURE']);
    const structure = await openRound();
    await workerAnswers({
      candidateId: structure.candidateId,
      question: `How does the ${CLASS} trade pay an intermediary?`,
      claims: [
        {
          claim: 'Manufacturers publish agent terms for export sales into new markets.',
          deal_finding: 'COMMERCIAL_PRECEDENT',
          deal_subject: 'three to five per cent of invoice value',
          deal_equipment: CLASS,
          deal_value: 'REFERRAL_COMMISSION',
        },
      ],
    });

    pass = await runDealflowKernel(projectId);
    expect(pass.filed.structures.length).toBe(1);

    // ---------------------------------------------------------------
    // 6. IDENTIFY THE DECISION MAKER.
    // ---------------------------------------------------------------
    expect(pass.opened.map((one) => one.purpose)).toEqual(['DECISION_MAKER']);
    const decision = await openRound();
    await workerAnswers({
      candidateId: decision.candidateId,
      question: 'Who decides a purchase at the buyer?',
      claims: [
        {
          claim: 'Capital equipment is procured through a published central tender process.',
          deal_finding: 'DECISION_MAKER',
          deal_subject: 'Kabwe Mining',
        },
      ],
    });

    pass = await runDealflowKernel(projectId);
    expect(pass.filed.decisionMakers.length).toBe(1);

    // ---------------------------------------------------------------
    // 7. THE DEAL CANDIDATE REACHES OUTREACH-READY AND IS PROMOTED.
    //
    // And the promotion is where research stops and Cash Mode's own execution
    // path begins — there is no second lifecycle in this kernel.
    // ---------------------------------------------------------------
    expect(pass.promoted.length).toBe(1);

    view = await dealflowView(projectId);
    const candidate = view.deals[0]!;
    expect(candidate.stage).toBe('OUTREACH_READY');
    expect(candidate.outstanding).toEqual([]);
    expect(candidate.opportunityId).not.toBe(null);

    // Every published figure summed once, on one basis, in one currency.
    expect(candidate.transactionValueCents).toBe(41_700_00);

    /*
     * §13's distinction, at the surface where it would be easiest to lose:
     * Brain states the transaction and refuses to state our share, because our
     * share is a fee under a structure nobody has chosen at a rate no source
     * states as ours.
     */
    expect(candidate.ourRevenueCents).toBe(null);
    expect(candidate.capitalClass).toBe('NONE');

    // The opportunity is real work in the portfolio, and its price is
    // deliberately unset: a card's price means what *we* are paid.
    const opportunity = await getOpportunity(candidate.opportunityId!);
    expect(opportunity!.state).toBe('DISCOVERED');
    expect(opportunity!.priceCents).toBe(null);
    expect(opportunity!.payer).toContain('Kabwe Mining');

    // ---------------------------------------------------------------
    // 8. RECORD WHAT THE ATTEMPT TAUGHT.
    //
    // One observation, reported as one — never promoted into a rule by being
    // the only thing in the table.
    // ---------------------------------------------------------------
    await observe({
      projectId,
      actorRef: userId,
      dealId: candidate.id,
      kind: 'CERTIFICATION_SURPRISE',
      jurisdiction: MARKET,
      equipmentClass: CLASS,
      statement: 'The buyer added a vendor specification the public record did not carry.',
    });

    view = await dealflowView(projectId);
    expect(view.lessons.length).toBe(1);
    expect(view.lessons[0]!.isPattern).toBe(false);
    expect(view.lessons[0]!.says).toContain('Observed once');

    // And the loop keeps going: with the deal finished with research, the
    // kernel's slots go back to widening the map rather than to this pairing.
    expect(view.next.every((one) => one.purpose !== 'COMPLIANCE')).toBe(true);
  });

  /**
   * The refusal that matters most, exercised over the wire rather than
   * against the validator directly.
   *
   * A documented absence is the only finding in this kernel that asserts
   * something does not exist, and §14 is explicit that such a claim is
   * established by a documented search or not at all. Refused here, the worker
   * still holds the attempt and can submit a corrected claim; accepted, a
   * layer nobody searched would read as clear.
   */
  it('refuses an undocumented absence at the tool, before anything is stored', async () => {
    expect(
      (
        await activate({
          projectId,
          ownerUserId: userId,
          actorUserId: userId,
          objective: 'Maximize additional usable cash over the next few weeks.',
        })
      ).ok,
    ).toBe(true);
    await runDealflowKernel(projectId);
    const seed = await openRound();

    await expect(
      workerAnswers({
        candidateId: seed.candidateId,
        question: 'Which industrial equipment moves across borders this way?',
        claims: [
          {
            claim: 'Nothing seems to be required at the factory layer.',
            deal_finding: 'REQUIREMENT_ABSENCE',
            deal_subject: 'no factory certification demanded',
            deal_equipment: CLASS,
            deal_jurisdiction: MARKET,
            deal_value: 'FACTORY_CERTIFICATION',
          },
        ],
      }),
    ).rejects.toThrow(/searched_repositories/);

    expect(await listParties(projectId)).toEqual([]);
  });
});
