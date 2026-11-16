import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { ensureCapability, getProgram, recordCategoryCapital, recordEdge } from '../server/repos/manufacturing.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { declareHeld, seedCategory } from '../server/services/manufacturing/declare.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import {
  alternativesFor,
  buildVenturePath,
  challengeVenture,
  type ResourceSituation,
  type VentureStage,
} from '../server/services/manufacturing/venturePath.ts';
import type { Layer } from '../server/domain/types.ts';

const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });

function stage(key: string, dependsOn: string[], part: Partial<VentureStage> = {}): VentureStage {
  return {
    key,
    title: key,
    dependsOn,
    decision: `decide ${key}`,
    resource: `resource for ${key}`,
    artifact: `${key} artifact`,
    actor: 'Brain',
    budget: usd(100_00),
    evidence: [`clm_${key}`],
    completion: `${key} done`,
    ...part,
  };
}

const venture: VentureStage[] = [
  stage('market-research', []),
  stage('positioning', ['market-research']),
  stage('unit-economics', ['market-research']),
  stage('prototype', ['positioning', 'unit-economics'], { budget: usd(2_000_00) }),
  stage('production', ['prototype'], {
    budget: usd(50_000_00),
    requiresCapabilityIds: ['cap_cnc'],
    alternatives: [{ mode: 'CONTRACT', actor: 'a contract manufacturer', budget: usd(6_000_00), requiresCapabilityIds: [], evidence: ['clm_cm_quote'] }],
  }),
  stage('channel', ['positioning'], { budget: usd(500_00) }),
  stage('launch', ['production', 'channel'], { budget: usd(300_00) }),
];

const poor: ResourceSituation = { available: usd(10_000_00), heldCapabilityIds: new Set() };

describe('VENT-24-2: the order is the dependencies', () => {
  it('layers stages by dependency, with independent stages side by side', () => {
    const path = buildVenturePath(venture);
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    expect(path.layers).toEqual([['market-research'], ['positioning', 'unit-economics'], ['prototype', 'channel'], ['production'], ['launch']]);
  });

  it('refuses a cycle and names it', () => {
    const path = buildVenturePath([stage('a', ['c']), stage('b', ['a']), stage('c', ['b'])]);
    expect(path.ok).toBe(false);
    if (path.ok) return;
    expect(path.refused).toBe('CYCLE');
    expect(path.detail).toMatch(/a → c → b → a|b → a → c → b|c → b → a → c/);
  });

  it('refuses a dependency the venture does not name', () => {
    const path = buildVenturePath([stage('a', ['ghost'])]);
    expect(path.ok).toBe(false);
    if (!path.ok) expect(path.refused).toBe('UNKNOWN_DEPENDENCY');
  });

  it('carries decision, resource, artifact, actor, budget, evidence and completion on every node, and withholds an unpriced total', () => {
    const path = buildVenturePath([...venture.slice(0, 3), stage('pricing', ['unit-economics'], { budget: null })]);
    if (!path.ok) throw new Error('expected a path');
    for (const n of path.nodes) {
      for (const field of ['decision', 'resource', 'artifact', 'actor', 'completion'] as const) expect(n[field]).toBeTruthy();
      expect(n.evidence.length).toBeGreaterThan(0);
      expect(['PRICED', 'WITHHELD']).toContain(n.budget.state);
    }
    expect(path.nodes.find((n) => n.key === 'pricing')!.budget.state).toBe('WITHHELD');
    expect(path.total).toBeNull();
    expect(path.unpriced).toEqual(['pricing']);
  });
});

describe('VENT-24-2: impossible combinations are challenged, weak strategies rebuilt', () => {
  it('names capital beyond what is deployable and a capability not held', () => {
    const path = buildVenturePath(venture);
    if (!path.ok) throw new Error('expected a path');
    const verdict = challengeVenture(path, poor, { expectedReturn: usd(200_000_00) });
    expect(verdict.feasibility).toBe('INFEASIBLE');
    expect(verdict.challenges.map((c) => c.kind)).toEqual(expect.arrayContaining(['CAPITAL_EXCEEDED', 'CAPABILITY_NOT_HELD']));
    expect(verdict.challenges.find((c) => c.kind === 'CAPABILITY_NOT_HELD')!.stages).toEqual(['production']);
  });

  it('never calls a plan resting on unknowns feasible', () => {
    const rich: ResourceSituation = { available: usd(1_000_000_00), heldCapabilityIds: new Set(['cap_cnc']) };
    const path = buildVenturePath(venture.map((s) => (s.key === 'channel' ? { ...s, unknowns: ['whether dealers will stock it'] } : s)));
    if (!path.ok) throw new Error('expected a path');
    expect(challengeVenture(path, rich, { expectedReturn: usd(200_000_00) }).feasibility).toBe('UNDETERMINED');
    expect(challengeVenture(buildVenturePath(venture) as Extract<ReturnType<typeof buildVenturePath>, { ok: true }>, rich).feasibility).toBe('UNDETERMINED');
  });

  it('names an economically weak strategy', () => {
    const rich: ResourceSituation = { available: usd(1_000_000_00), heldCapabilityIds: new Set(['cap_cnc']) };
    const path = buildVenturePath(venture);
    if (!path.ok) throw new Error('expected a path');
    const verdict = challengeVenture(path, rich, { expectedReturn: usd(1_000_00) });
    expect(verdict.challenges.map((c) => c.kind)).toContain('ECONOMICALLY_WEAK');
    expect(verdict.feasibility).toBe('INFEASIBLE');
  });

  it('builds materially different feasible alternatives instead of discarding the venture', () => {
    const alts = alternativesFor(venture, poor, { expectedReturn: usd(200_000_00) });
    const contracted = alts.find((a) => a.kind === 'SUBSTITUTED');
    expect(contracted).toBeDefined();
    expect(contracted!.differs).toEqual(['production: BUILD → CONTRACT via a contract manufacturer']);
    expect(contracted!.verdict.feasibility).toBe('FEASIBLE');
    const first = alts.find((a) => a.kind === 'VALIDATE_FIRST');
    expect(first).toBeDefined();
    expect(first!.stages.map((s) => s.key)).toContain('decide-to-proceed');
    expect(first!.stages.map((s) => s.key)).not.toContain('production');
    expect(first!.verdict.feasibility).toBe('FEASIBLE');
    for (const a of alts) expect(a.verdict.feasibility).toBe('FEASIBLE');
  });
});

/* ------------------------------------------------------------------------- */
/* The kernel revisits the venture as capital and capabilities change          */
/* ------------------------------------------------------------------------- */

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `ventures-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
});

/** One accepted, sourced claim, so the capital and requirement rows have the evidence the schema demands. */
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
      fragmentKey: 'venture-path',
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

describe('VENT-24-2: the kernel revisits an earlier venture when capital or capability changes', () => {
  it('reads a category INFEASIBLE, then FEASIBLE on the next tick after capital arrives and a capability is held, with nobody restating it', async () => {
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

    const before = await runManufacturingKernel(projectId);
    const first = before.ventures.find((v) => v.categoryId === category.id)!;
    expect(first.feasibility).toBe('INFEASIBLE');
    expect(first.cost).toEqual({ currency: 'USD', amountMinor: 60_000_00 });
    expect(first.challenges.map((c) => c.kind)).toEqual(expect.arrayContaining(['CAPABILITY_NOT_HELD', 'CAPITAL_EXCEEDED']));

    // A successful operation creates capital, and the company comes to hold the capability.
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 75_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-${projectId}` });
    const held = await declareHeld({ projectId, capabilityId: capability.id, note: 'Our line passed pressure certification', actorRef: userId });
    expect('error' in held).toBe(false);

    const after = await runManufacturingKernel(projectId);
    const second = after.ventures.find((v) => v.categoryId === category.id)!;
    expect(second.feasibility).toBe('FEASIBLE');
    expect(second.available).toEqual({ currency: 'USD', amountMinor: 75_000_00 });
    expect(second.newestInput).toMatchObject({ kind: 'CAPABILITY_HELD', capabilityId: capability.id });
  });

  it('a project with no programme reports no ventures and does no work', async () => {
    const pass = await runManufacturingKernel(projectId);
    expect(pass.ventures).toEqual([]);
  });
});
