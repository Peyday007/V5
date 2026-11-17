import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { ensureCapability, getProgram, recordAcquisitionCandidate, recordCategoryCapital, recordCategoryEvidence, recordEdge } from '../server/repos/manufacturing.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { declareHeld, seedCategory } from '../server/services/manufacturing/declare.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import { ventureRecord } from '../server/services/manufacturing/recorded.ts';
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

  it('builds every real category into a dependency-ordered stage graph from its own rows, challenged, with alternatives', async () => {
    const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Industrial floor scrubbers', actorRef: userId, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;

    const { capability } = await ensureCapability({ programId: program.id, projectId, name: 'Brushless drive integration', origin: 'SEED' });
    await recordEdge({
      programId: program.id,
      categoryId: category.id,
      capabilityId: capability.id,
      relation: 'REQUIRES',
      statement: 'A scrubber drive needs brushless motor integration',
      sourceClaimId: await acceptedClaim('A scrubber drive needs brushless motor integration'),
    });
    const toolingClaim = await acceptedClaim('Tooling for a scrubber chassis costs $20,000–$30,000');
    await recordCategoryCapital({
      programId: program.id,
      categoryId: category.id,
      requirement: 'TOOLING_AND_EQUIPMENT',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 20_000_00,
      amountHighMinor: 30_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'Tooling for a scrubber chassis costs $20,000–$30,000',
      sourceClaimId: toolingClaim,
    });
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'ENTRY_BARRIER',
      subject: 'electrical safety listing',
      statement: 'Sale requires an electrical safety listing',
      sourceClaimId: await acceptedClaim('Sale requires an electrical safety listing'),
    });
    const supplierClaim = await acceptedClaim('A drive integrator offers brushless integration as a service');
    await recordAcquisitionCandidate({
      programId: program.id,
      categoryId: category.id,
      capabilityId: capability.id,
      name: 'A drive integrator',
      contribution: 'CAPABILITY',
      statement: 'A drive integrator offers brushless integration as a service',
      sourceClaimId: supplierClaim,
    });
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 50_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-graph-${projectId}` });

    const pass = await runManufacturingKernel(projectId);
    const reading = pass.ventures.find((v) => v.categoryId === category.id)!;
    const { path, verdict, alternatives } = reading.venture;
    if (!path.ok) throw new Error(`path refused: ${path.detail}`);

    // The graph is ordered by what each stage consumes, not a star of independent prerequisites under one decision (R4-F1).
    const capitalKey = 'capital:TOOLING_AND_EQUIPMENT';
    const capabilityKey = `capability:${capability.id}`;
    const barrierKey = path.nodes.find((n) => n.key.startsWith('barrier:'))!.key;
    const node = (key: string) => {
      const found = path.nodes.find((n) => n.key === key);
      if (!found) throw new Error(`no stage ${key}`);
      return found;
    };
    // Every stage the clause names is produced from the rows, not only by a hand-built test venture.
    for (const key of ['market-research', 'positioning', 'specification', 'unit-economics', 'validation', 'pricing', 'channel', 'production', 'enter', 'launch', 'scale']) node(key);
    // Only market research starts the path; every other stage depends on another stage.
    expect(path.layers[0]).toEqual(['market-research']);
    for (const n of path.nodes.filter((one) => one.key !== 'market-research')) expect(n.dependsOn.length).toBeGreaterThan(0);
    // Ancestors, so a test can say "comes after" without fixing the exact edges.
    const before = (later: string, earlier: string): boolean => {
      const seen = new Set<string>();
      const walk = (key: string): boolean =>
        node(key).dependsOn.some((dep) => dep === earlier || (!seen.has(dep) && (seen.add(dep), walk(dep))));
      return walk(later);
    };
    expect(before(capitalKey, 'unit-economics')).toBe(true); // no money committed before the economics
    expect(before(capitalKey, 'validation')).toBe(true); // tooling follows a validated design
    expect(node('production').dependsOn).toEqual(expect.arrayContaining([capitalKey, capabilityKey, barrierKey]));
    expect(before('channel', 'pricing')).toBe(true);
    expect(node('enter').dependsOn).toEqual(expect.arrayContaining(['production', 'channel']));
    expect(node('launch').dependsOn).toEqual(['enter']);
    expect(node('scale').dependsOn).toEqual(['launch']);
    expect(path.layers.length).toBeGreaterThan(6);
    // Missing demand and distribution evidence sit on the stages that read them.
    expect(node('market-research').unknowns).toEqual([expect.stringContaining('no demand evidence')]);
    expect(node('channel').unknowns).toEqual([expect.stringContaining('no distribution channel')]);

    // Every node carries the seven fields, and evidence resolves to the rows it stands on.
    for (const node of path.nodes) {
      for (const field of ['decision', 'resource', 'artifact', 'actor', 'completion'] as const) expect(node[field].length).toBeGreaterThan(0);
    }
    const tooling = path.nodes.find((n) => n.key === capitalKey)!;
    expect(tooling.budget).toEqual({ state: 'PRICED', money: { currency: 'USD', amountMinor: 30_000_00 } });
    expect(tooling.evidence).toEqual([toolingClaim]);

    // Unpriced stages withhold the total, and the challenge names what stops it.
    expect(path.total).toBeNull();
    expect(path.unpriced).toEqual(expect.arrayContaining([capabilityKey]));
    expect(verdict!.feasibility).toBe('INFEASIBLE');
    expect(verdict!.challenges.map((c) => c.kind)).toEqual(expect.arrayContaining(['CAPABILITY_NOT_HELD', 'UNPRICED_STAGE', 'BUILT_ON_UNKNOWNS']));

    // The supplier on record is carried as a BUY alternative to developing the capability.
    const capabilityNode = path.nodes.find((n) => n.key === capabilityKey)!;
    expect(capabilityNode.alternatives).toEqual([expect.objectContaining({ mode: 'BUY', actor: 'A drive integrator', evidence: [supplierClaim] })]);

    // The rebuilt alternative funds the priced, capability-free prefix the capital covers.
    const first = alternatives.find((a) => a.kind === 'VALIDATE_FIRST');
    expect(first).toBeDefined();
    expect(first!.differs[0]).toContain(capitalKey);
    expect(first!.total).toEqual({ currency: 'USD', amountMinor: 30_000_00 });
  });

  it('a category with an entry barrier priced by its certification row becomes FEASIBLE when capital arrives, and the institutional plan prices the same permit (R4-F2)', async () => {
    const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Commercial dehumidifiers', actorRef: userId, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;

    await recordCategoryCapital({
      programId: program.id,
      categoryId: category.id,
      requirement: 'TOOLING_AND_EQUIPMENT',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 30_000_00,
      amountHighMinor: 40_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'Coil-forming tooling costs $30,000–$40,000',
      sourceClaimId: await acceptedClaim('Coil-forming tooling costs $30,000–$40,000'),
    });
    const feeClaim = await acceptedClaim('A safety listing for a dehumidifier costs $8,000–$12,000');
    await recordCategoryCapital({
      programId: program.id,
      categoryId: category.id,
      requirement: 'CERTIFICATION_AND_APPROVAL',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 8_000_00,
      amountHighMinor: 12_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'A safety listing for a dehumidifier costs $8,000–$12,000',
      sourceClaimId: feeClaim,
    });
    const barrierClaim = await acceptedClaim('Sale requires an appliance safety listing');
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'ENTRY_BARRIER',
      subject: 'appliance safety listing',
      statement: 'Sale requires an appliance safety listing',
      sourceClaimId: barrierClaim,
    });
    // Demand and a channel on record, so the graph's only open question is the money.
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'DEMAND_EVIDENCE',
      subject: 'restoration contractors',
      statement: 'Restoration contractors bought 40,000 commercial dehumidifiers last year',
      observedOn: '2026-09-01',
      sourceClaimId: await acceptedClaim('Restoration contractors bought 40,000 commercial dehumidifiers last year'),
    });
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'DISTRIBUTION_CHANNEL',
      subject: 'equipment rental houses',
      statement: 'Equipment rental houses stock commercial dehumidifiers',
      sourceClaimId: await acceptedClaim('Equipment rental houses stock commercial dehumidifiers'),
    });

    const before = await runManufacturingKernel(projectId);
    const first = before.ventures.find((v) => v.categoryId === category.id)!;
    const path = first.venture.path;
    if (!path.ok) throw new Error(`path refused: ${path.detail}`);
    // The barrier is priced by the certification row, which is not also a second, unlinked stage.
    const barrierNode = path.nodes.find((n) => n.key.startsWith('barrier:'))!;
    expect(barrierNode.budget).toEqual({ state: 'PRICED', money: { currency: 'USD', amountMinor: 12_000_00 } });
    expect(barrierNode.evidence).toEqual([barrierClaim, feeClaim]);
    // A certification is of the validated design, and production waits for it and for the tooling (R4-F1).
    expect(barrierNode.dependsOn).toEqual(['validation']);
    expect(path.nodes.find((n) => n.key === 'production')!.dependsOn).toEqual(expect.arrayContaining([barrierNode.key, 'capital:TOOLING_AND_EQUIPMENT']));
    expect(path.layers[0]).toEqual(['market-research']);
    expect(path.nodes.some((n) => n.key === 'capital:CERTIFICATION_AND_APPROVAL')).toBe(false);
    expect(path.unpriced).toEqual([]);
    expect(path.total).toEqual({ currency: 'USD', amountMinor: 52_000_00 });
    // Before capital the graph's verdict — the one recorded and told to goals — is a capital shortfall, not a permanent UNPRICED_STAGE.
    const firstVerdict = first.venture.verdict!;
    expect(firstVerdict.challenges.map((c) => c.kind)).toContain('CAPITAL_EXCEEDED');
    expect(firstVerdict.challenges.map((c) => c.kind)).not.toContain('UNPRICED_STAGE');
    expect(firstVerdict.feasibility).toBe('INFEASIBLE');
    expect(ventureRecord(first).feasibility).toBe('INFEASIBLE');

    // The institutional plan reads the same rows the same way: the permit for that barrier is priced by that fee.
    const plan = before.institutions.find((one) => one.categoryId === category.id)!;
    const permits = plan.derivation.structures.flatMap((one) => one.elements).filter((one) => one.key === 'PERMIT:appliance safety listing');
    expect(permits.length).toBeGreaterThan(0);
    for (const permit of permits) expect(permit.cost?.oneTime).toEqual({ currency: 'USD', lowMinor: 8_000_00, highMinor: 12_000_00 });

    // Capital arrives from a successful operation; the next pass reconsiders the venture with nobody restating it.
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 60_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-barrier-${projectId}` });
    const after = await runManufacturingKernel(projectId);
    const second = after.ventures.find((v) => v.categoryId === category.id)!;
    if (!second.venture.path.ok) throw new Error('path refused');
    expect(second.venture.path.total).toEqual({ currency: 'USD', amountMinor: 52_000_00 });
    // The capital blocker cleared: the recorded verdict moves INFEASIBLE -> UNDETERMINED, which is the transition
    // that tells the project's goals the venture was unblocked. Before the repair the barrier held it at
    // UNDETERMINED on both passes (UNPRICED_STAGE), so capital arriving changed nothing and nothing was told.
    const secondKinds = second.venture.verdict!.challenges.map((c) => c.kind);
    expect(secondKinds).not.toContain('CAPITAL_EXCEEDED');
    expect(secondKinds).not.toContain('UNPRICED_STAGE');
    expect(ventureRecord(second).feasibility).toBe('UNDETERMINED');
    // What remains is only the return nobody has established (invariant 39), never the barrier: once a return is
    // established the same graph, barrier included, reads FEASIBLE against the same capital.
    expect(second.venture.verdict!.challenges).toEqual([{ kind: 'BUILT_ON_UNKNOWNS', detail: 'the expected return is not established', stages: [] }]);
    const withReturn = challengeVenture(second.venture.path, { available: usd(60_000_00), heldCapabilityIds: new Set() }, { expectedReturn: usd(90_000_00) });
    expect(withReturn.feasibility).toBe('FEASIBLE');
  });

  it('a barrier no published figure prices still withholds the total: nothing is guessed (R4-F2)', async () => {
    const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Commercial ice makers', actorRef: userId, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;
    await recordCategoryCapital({
      programId: program.id,
      categoryId: category.id,
      requirement: 'TOOLING_AND_EQUIPMENT',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 10_000_00,
      amountHighMinor: 15_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'Evaporator tooling costs $10,000–$15,000',
      sourceClaimId: await acceptedClaim('Evaporator tooling costs $10,000–$15,000'),
    });
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'ENTRY_BARRIER',
      subject: 'sanitation certification',
      statement: 'Sale requires a sanitation certification',
      sourceClaimId: await acceptedClaim('Sale requires a sanitation certification'),
    });
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 100_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-unpriced-${projectId}` });
    const pass = await runManufacturingKernel(projectId);
    const reading = pass.ventures.find((v) => v.categoryId === category.id)!;
    if (!reading.venture.path.ok) throw new Error('path refused');
    expect(reading.venture.path.total).toBeNull();
    expect(reading.venture.verdict!.feasibility).toBe('UNDETERMINED');
    expect(reading.venture.verdict!.challenges.map((c) => c.kind)).toContain('UNPRICED_STAGE');
  });

  it('a project with no programme reports no ventures and does no work', async () => {
    const pass = await runManufacturingKernel(projectId);
    expect(pass.ventures).toEqual([]);
  });
});
