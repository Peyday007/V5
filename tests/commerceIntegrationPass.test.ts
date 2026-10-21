/**
 * The commerce kernel walked once, end to end, with a worker answering over
 * the wire (§73).
 *
 * The unit suite writes claim columns directly, so it cannot see the defect
 * §45 records twice: a declaration that reaches the tool and not the table,
 * because the submission mapper carried only the fields it had been told
 * about. Here a `WORKER` principal claims real queue items and submits through
 * `brain_submit_claims` and `brain_submit_verification`, so the scope check,
 * the lease proof, the validator, the mapper and Brain's own evidence gate all
 * run. What stays fixture is the sentences a worker found.
 *
 * The walk: a person starts the programme on a Cash Mode project; the kernel
 * asks what is selling; a worker answers; the products are filed; the kernel
 * follows up with who ships it, what it sells for and what one order costs;
 * the product reaches QUALIFIED with an acquisition budget — and nothing
 * anywhere has listed, ordered, advertised or spent anything.
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
import { listCommerceFacts, listCommerceProducts, listCommerceRounds } from '../server/repos/commerce.ts';
import { startCommerceProgramme } from '../server/services/commerce/programme.ts';
import { runCommerceKernel } from '../server/services/commerce/kernel.ts';
import { commerceView } from '../server/services/commerce/view.ts';
import { getDb } from '../server/db/database.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  ProjectMembership,
  WorkerScope,
} from '../server/domain/types.ts';

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

let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');

  const user = await createUser({
    email: `commerce-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;

  const worker = await createWorker({
    name: `commerce-worker-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'The commerce worker',
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
    handle: 'commerce-worker',
    displayName: 'The commerce worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_commerce_walk',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_commerce_walk',
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
    requestId: 'req_commerce_walk',
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

/** What a worker submits for one claim, exactly as it goes over the wire. */
interface WireClaim {
  claim: string;
  date?: string;
  publisher?: string;
  fields: Record<string, unknown>;
}

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
          id: 'commerce',
          description: 'what the sources establish about the product',
          necessity: 'REQUIRED' as const,
        },
      ],
      acceptableSourceTypes: ['a published page a source identifies by URL'],
      excludedSourceTypes: ['an article about the trade that names no party'],
      completionCriteria: ['every finding declared on its own claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: `commerce-${Math.random().toString(36).slice(2, 8)}`,
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
      claim_type: 'SOURCED_FACT',
      source_url: `https://example.test/commerce/${index}`,
      source_title: 'A published page',
      source_publisher: one.publisher ?? 'A publisher',
      source_date: one.date ?? new Date().toISOString().slice(0, 10),
      evidence_excerpt: one.claim,
      evidence_locator: 'the page body',
      evidence_lane: 'commerce',
      retrieved_at: '2026-09-22',
      confidence: 0.9,
      primary_source: true,
      ...one.fields,
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

const PRODUCT = 'Posture corrector brace';

/** The candidate of the open round of this purpose, after the kernel has had its pass. */
async function roundFor(purpose: string): Promise<string> {
  const pass = await runCommerceKernel(projectId);
  const open = (await listCommerceRounds(projectId)).find(
    (one) => one.purpose === purpose && one.state === 'OPEN',
  );
  if (!open) throw new Error(`no ${purpose} round open: ${JSON.stringify(pass.declined).slice(0, 600)}`);
  return open.candidateId;
}

function finding(finding: string, subject: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { commerce_finding: finding, commerce_product: PRODUCT, commerce_subject: subject, ...extra };
}

describe('a product found selling, costed, and qualified — over the wire', () => {
  it('walks from Start to QUALIFIED through the real tools, and spends nothing', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    const started = await startCommerceProgramme({
      projectId,
      actorUserId: userId,
      objective: 'Find generic products selling now that one order can pay to advertise.',
    });
    expect(started.ok).toBe(true);

    await workerAnswers({
      candidateId: await roundFor('DISCOVER'),
      question: 'What is selling now?',
      claims: [
        { claim: 'It ranks #3 in Health & Household.', publisher: 'Amazon', fields: finding('PRODUCT_DEMAND', 'Amazon Best Sellers', { commerce_value: 'BESTSELLER_RANK' }) },
        { claim: 'Over ten thousand sold this month.', publisher: 'TikTok', fields: finding('PRODUCT_DEMAND', 'TikTok Shop', { commerce_value: 'ORDER_COUNT' }) },
        { claim: 'Desk workers ask for a discreet one.', fields: finding('NICHE_SIGNAL', 'remote office workers') },
      ],
    });
    await runCommerceKernel(projectId);

    // Every declaration reached the table, not only the tool. Two demand claims
    // from one publisher would be one source; these are two.
    const products = await listCommerceProducts(projectId);
    expect(products.map((one) => one.name)).toEqual([PRODUCT]);
    expect((await listCommerceFacts(projectId)).length).toBe(3);

    await workerAnswers({
      candidateId: await roundFor('SOURCE'),
      question: 'Who would ship it?',
      claims: [
        { claim: 'Listed at $8.00, ships in 9 days.', fields: finding('SUPPLIER_OFFER', 'CJ Dropshipping', { commerce_amount_cents: 800, commerce_currency: 'USD', commerce_days: 9 }) },
        { claim: 'Shipping to the US is $4.00.', fields: finding('COST_LINE', 'CJ Dropshipping', { commerce_value: 'SHIPPING_TO_CUSTOMER', commerce_amount_cents: 400, commerce_currency: 'USD' }) },
      ],
    });
    await workerAnswers({
      candidateId: await roundFor('PRICE'),
      question: 'What does it sell for?',
      claims: [
        { claim: 'Sold at $39.99.', fields: finding('RETAIL_PRICE', 'A storefront', { commerce_amount_cents: 3999, commerce_currency: 'USD' }) },
      ],
    });
    await runCommerceKernel(projectId);
    await workerAnswers({
      candidateId: await roundFor('COSTS'),
      question: 'What does one order cost to sell?',
      claims: [
        { claim: 'Online card payments cost 2.9%.', fields: finding('COST_LINE', 'Stripe', { commerce_value: 'PAYMENT_PROCESSING', commerce_rate_bps: 290 }) },
      ],
    });
    await runCommerceKernel(projectId);

    const view = await commerceView(projectId);
    const one = view.products.find((entry) => entry.name === PRODUCT)!;
    expect(one.stage, one.because).toBe('QUALIFIED');
    expect(one.acquisitionBudget).toContain('26.83');

    // Nothing in the commercial machinery moved.
    const db = getDb();
    for (const table of ['cash_actions', 'cash_money_entries', 'cash_opportunities']) {
      const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [projectId]);
      expect(`${table}:${Number(row?.n ?? 0)}`).toBe(`${table}:0`);
    }
  });
});
