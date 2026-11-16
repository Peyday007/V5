import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { ensureCapability, getProgram, recordAcquisitionCandidate, recordCategoryCapital, recordEdge } from '../server/repos/manufacturing.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { declareHeld, seedCategory } from '../server/services/manufacturing/declare.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import { recordedManufacturingReadings, recordVentureTransitions, VENTURE_READ_EVENT } from '../server/services/manufacturing/recorded.ts';
import { createWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { getDb } from '../server/db/database.ts';
import type { Layer } from '../server/domain/types.ts';

/*
 * VENT-24-2 on production records (repair R3-F3). The venture the kernel
 * derives every pass is a dependency-ordered stage graph, with its challenges
 * and materially different alternatives. These tests drive the real kernel,
 * record its pass the way the tick does, and read the row back. The row and
 * the programme view must carry the whole graph exactly as derived, and the
 * feasibility the goals are told about must be the graph's own verdict.
 */

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `venture-record-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
});

async function acceptedClaim(text: string): Promise<string> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a programme round' });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a programme round',
    assignment: 'what building this takes',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the programme may look at',
      requiredEvidence: [{ id: 'requires', description: 'what producing needs', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a published requirement'],
      excludedSourceTypes: ['an unsourced assertion'],
      completionCriteria: ['every finding declared'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'venture-record',
      question: 'What does producing this require?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: text,
      sourceUrl: 'https://example.test/source',
      sourceTitle: 'A source',
      sourcePublisher: 'A publisher',
      sourceDate: '2026-09-10',
      evidenceExcerpt: text,
      evidenceLocator: 'p. 1',
      evidenceLane: 'requires',
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: text,
    },
  ] as unknown as Parameters<typeof insertClaims>[0]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

/** A category that needs a capability nobody holds, a priced tooling stage, and a supplier who could supply the capability. */
async function seedVenture() {
  const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
  expect(started.ok).toBe(true);
  const program = (await getProgram(projectId))!;
  const seeded = await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId, reason: 'test' });
  if ('error' in seeded) throw new Error(seeded.error);
  const category = seeded.category;
  const { capability } = await ensureCapability({ programId: program.id, projectId, name: 'High-pressure pump assembly', origin: 'SEED' });
  await recordEdge({
    programId: program.id,
    categoryId: category.id,
    capabilityId: capability.id,
    relation: 'REQUIRES',
    statement: 'Assembling the pump requires a pressure-tested line',
    sourceClaimId: await acceptedClaim('Assembling the pump requires a pressure-tested line'),
  });
  await recordCategoryCapital({
    programId: program.id,
    categoryId: category.id,
    requirement: 'TOOLING_AND_EQUIPMENT',
    scenario: 'SMALLEST_CREDIBLE_ENTRY',
    amountLowMinor: 40_000_00,
    amountHighMinor: 60_000_00,
    currency: 'USD',
    basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
    asOf: '2026-09-01',
    statement: 'A test rig and fixtures cost $40,000–$60,000',
    sourceClaimId: await acceptedClaim('A test rig and fixtures cost $40,000–$60,000'),
  });
  await recordAcquisitionCandidate({
    programId: program.id,
    categoryId: category.id,
    capabilityId: capability.id,
    name: 'A pump assembler',
    contribution: 'CAPABILITY',
    statement: 'A pump assembler offers pressure-tested assembly as a service',
    sourceClaimId: await acceptedClaim('A pump assembler offers pressure-tested assembly as a service'),
  });
  return { category, capability };
}

const ventureRows = async (): Promise<number> =>
  (await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM bin_events WHERE project_id = ? AND event_type = ?', [projectId, VENTURE_READ_EVENT]))[0]!.n;

/** What crosses JSON, so a row read back compares with the pass that wrote it. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('VENT-24-2: the venture graph is a production record', () => {
  it('records the whole stage graph, its verdict and its alternatives, and serves them from the programme view', async () => {
    const { category } = await seedVenture();
    // Enough capital for the priced stages, so the validate-first alternative the rows admit is affordable.
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 75_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-graph-${projectId}` });
    const pass = await runManufacturingKernel(projectId);
    const live = pass.ventures.find((one) => one.categoryId === category.id)!;
    const { path, verdict, alternatives } = live.venture;
    if (!path.ok) throw new Error(`path refused: ${path.detail}`);
    expect(alternatives.length).toBeGreaterThan(0);

    expect(await recordVentureTransitions(projectId, pass.ventures)).toEqual([{ categoryId: category.id, from: null, to: verdict!.feasibility }]);

    const { ventures } = await recordedManufacturingReadings(projectId);
    const held = ventures.find((one) => one.categoryId === category.id)!;
    expect(held).toBeDefined();
    // The graph, node by node with its seven fields, exactly as the pass derived it.
    expect(held.graph).toEqual(wire(path));
    if (!held.graph.ok) throw new Error('recorded graph refused');
    for (const node of held.graph.nodes) {
      for (const field of ['decision', 'resource', 'artifact', 'actor', 'completion'] as const) expect(node[field].length).toBeGreaterThan(0);
      expect(node.budget.state === 'PRICED' || node.budget.state === 'WITHHELD').toBe(true);
      expect(Array.isArray(node.evidence)).toBe(true);
    }
    // The challenges in full, not only their kinds; and the feasibility is the graph's verdict.
    expect(held.verdict).toEqual(wire(verdict));
    expect(held.feasibility).toBe(verdict!.feasibility);
    // Each alternative with its own graph and verdict.
    expect(held.alternatives).toEqual(wire(alternatives.map((one) => ({ kind: one.kind, differs: one.differs, total: one.total, graph: one.path, verdict: one.verdict }))));
    for (const one of held.alternatives) expect(one.verdict.feasibility).toBe('FEASIBLE');
    // The per-category resource reading travels beside the graph.
    expect(held.reading).toEqual(wire({ feasibility: live.feasibility, challenges: live.challenges, cost: live.cost, available: live.available }));

    // The programme view a person reads serves the recorded venture.
    const view = (await programmeView(projectId))!;
    expect(view.ventures.find((one) => one.categoryId === category.id)).toEqual(held);
  });

  it('writes nothing for an unchanged venture and a new row when the graph changes', async () => {
    const { category } = await seedVenture();
    await recordVentureTransitions(projectId, (await runManufacturingKernel(projectId)).ventures);
    const rows = await ventureRows();
    expect(rows).toBe(1);

    expect(await recordVentureTransitions(projectId, (await runManufacturingKernel(projectId)).ventures)).toEqual([]);
    expect(await ventureRows()).toBe(rows);

    // Capital arrives: the graph reads against a different ledger, so it is a different venture reading.
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 75_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-record-${projectId}` });
    const changed = await recordVentureTransitions(projectId, (await runManufacturingKernel(projectId)).ventures);
    expect(changed.map((one) => one.categoryId)).toEqual([category.id]);
    expect(await ventureRows()).toBe(rows + 1);
  });

  it('tells live goals what the graph verdict says, not what the per-category reading says', async () => {
    const { category, capability } = await seedVenture();
    const goal = await createWorkstream({ projectId, title: 'Ten thousand', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });

    const before = (await runManufacturingKernel(projectId)).ventures.find((one) => one.categoryId === category.id)!;
    expect(before.venture.verdict!.feasibility).toBe('INFEASIBLE');
    await recordVentureTransitions(projectId, [before]);

    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 75_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-goal-${projectId}` });
    const declared = await declareHeld({ projectId, capabilityId: capability.id, note: 'Our line passed pressure certification', actorRef: userId });
    expect('error' in declared).toBe(false);

    const after = (await runManufacturingKernel(projectId)).ventures.find((one) => one.categoryId === category.id)!;
    // The resource reading is satisfied; the graph still rests on an expected return nobody established.
    expect(after.feasibility).toBe('FEASIBLE');
    expect(after.venture.verdict!.feasibility).toBe('UNDETERMINED');
    expect(await recordVentureTransitions(projectId, [after])).toEqual([{ categoryId: category.id, from: 'INFEASIBLE', to: 'UNDETERMINED' }]);

    const kinds = (await listWorkstreamEvents(goal.id)).map((one) => one.kind);
    expect(kinds).toContain('VENTURE_UNBLOCKED');
    expect(kinds).not.toContain('VENTURE_BECAME_FEASIBLE');
  });
});
