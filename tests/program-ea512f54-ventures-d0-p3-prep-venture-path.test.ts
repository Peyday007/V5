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
  economicsFromReading,
  stagesFromReading,
  statedAmounts,
  statedPrice,
  type InstitutionalPrerequisite,
  type ResourceSituation,
  type VentureNode,
  type VentureStage,
} from '../server/services/manufacturing/venturePath.ts';
import { pathPrerequisites } from '../server/services/manufacturing/institutionReading.ts';
import { readLadder } from '../server/services/manufacturing/readiness.ts';
import { ladderSnapshot } from '../server/services/manufacturing/ladder.ts';
import type { Layer } from '../server/domain/types.ts';

const usd = (amountMinor: number) => ({ currency: 'USD', amountMinor });

/** A built node back as the stage it came from, with the budget a test supplies for the unpriced ones. */
function asStage(node: VentureNode, price: (node: VentureNode) => { currency: string; amountMinor: number } | null): VentureStage {
  const { layer: _layer, budget, ...rest } = node;
  return { ...rest, budget: budget.state === 'PRICED' ? budget.money : price(node) };
}

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

    // With no demand on record, market research rests on an unknown, so nothing past it is funded:
    // no validate-first alternative commits the tooling money (invariant 39).
    expect(alternatives.filter((a) => a.kind === 'VALIDATE_FIRST')).toEqual([]);

    // Once demand is on record, the rebuilt alternative funds the priced, capability-free prefix the capital covers.
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'DEMAND_EVIDENCE',
      observedOn: '2026-09-10',
      subject: 'facility managers replacing scrubbers',
      statement: 'Facility managers replace floor scrubbers every five years',
      sourceClaimId: await acceptedClaim('Facility managers replace floor scrubbers every five years'),
    });
    const withDemand = (await runManufacturingKernel(projectId)).ventures.find((v) => v.categoryId === category.id)!;
    const first = withDemand.venture.alternatives.find((a) => a.kind === 'VALIDATE_FIRST');
    expect(first).toBeDefined();
    expect(first!.differs[0]).toContain(capitalKey);
    expect(first!.total).toEqual({ currency: 'USD', amountMinor: 30_000_00 });
    expect(first!.verdict.feasibility).toBe('FEASIBLE');
    // What it funds rests on no unknown; the channel, still without a distribution channel on record, is deferred.
    for (const n of first!.path.nodes) expect(n.unknowns ?? []).toEqual([]);
    expect(first!.path.nodes.map((n) => n.key)).not.toContain('channel');
  });

  it('validate-first never funds a stage resting on an unknown, nor anything that consumes it (invariant 39)', () => {
    const usdOf = (amountMinor: number) => ({ currency: 'USD', amountMinor });
    const base = (key: string, dependsOn: string[], amountMinor: number, unknowns: string[] = []): VentureStage => ({
      key,
      title: key,
      dependsOn,
      decision: key,
      resource: key,
      artifact: key,
      actor: 'Brain',
      budget: usdOf(amountMinor),
      evidence: [],
      completion: key,
      unknowns,
    });
    const stages = (researchUnknowns: string[]) => [
      base('market-research', [], 0, researchUnknowns),
      base('unit-economics', ['market-research'], 0),
      base('capital:FACILITY', ['unit-economics'], 10_000_00),
      base('enter', ['capital:FACILITY'], 0),
      base('build', ['enter'], 900_000_00),
    ];
    const situation: ResourceSituation = { available: usdOf(50_000_00), heldCapabilityIds: new Set() };
    const blind = alternativesFor(stages(['no demand evidence is on record']), situation).filter((a) => a.kind === 'VALIDATE_FIRST');
    expect(blind).toEqual([]);
    const known = alternativesFor(stages([]), situation).find((a) => a.kind === 'VALIDATE_FIRST');
    expect(known?.verdict.feasibility).toBe('FEASIBLE');
    expect(known?.path.total).toEqual(usdOf(10_000_00));
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
    // The permit for that barrier is the barrier stage, not a second institutional stage (R6-F1).
    expect(path.nodes.some((n) => n.key === 'institution:PERMIT:appliance safety listing')).toBe(false);
    // What is unpriced is exactly the institutional machinery trading needs and no row prices (R6-F1); the barrier is priced.
    expect(path.unpriced.length).toBeGreaterThan(0);
    for (const key of path.unpriced) expect(key.startsWith('institution:')).toBe(true);
    expect(path.total).toBeNull();
    expect(path.floor).toEqual({ currency: 'USD', amountMinor: 52_000_00 });
    // Before capital the graph's verdict — the one recorded and told to goals — is a capital shortfall read from what is priced.
    const firstVerdict = first.venture.verdict!;
    expect(firstVerdict.challenges.map((c) => c.kind)).toContain('CAPITAL_EXCEEDED');
    expect(firstVerdict.challenges.find((c) => c.kind === 'UNPRICED_STAGE')!.stages).toEqual(path.unpriced);
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
    expect(second.venture.path.floor).toEqual({ currency: 'USD', amountMinor: 52_000_00 });
    // The capital blocker cleared: the recorded verdict moves INFEASIBLE -> UNDETERMINED, which is the transition
    // that tells the project's goals the venture was unblocked. Before the repair the barrier held it at
    // UNDETERMINED on both passes (UNPRICED_STAGE), so capital arriving changed nothing and nothing was told.
    const secondKinds = second.venture.verdict!.challenges.map((c) => c.kind);
    expect(secondKinds).not.toContain('CAPITAL_EXCEEDED');
    expect(ventureRecord(second).feasibility).toBe('UNDETERMINED');
    // What remains is the institutional machinery nobody has priced and the return nobody has established
    // (invariant 39), never the barrier: the barrier stage is priced and no challenge names it.
    expect(new Set(secondKinds)).toEqual(new Set(['UNPRICED_STAGE', 'BUILT_ON_UNKNOWNS']));
    for (const one of second.venture.verdict!.challenges) for (const key of one.stages) expect(key.startsWith('institution:')).toBe(true);
    // Once the institutions are priced and a return is established, the same graph, barrier included, reads FEASIBLE
    // against the same capital — and the institutional cost is in the total it is judged on.
    const priced = buildVenturePath(second.venture.path.nodes.map((n) => asStage(n, () => usd(500_00))));
    if (!priced.ok) throw new Error('path refused');
    expect(priced.total).toEqual(usd(52_000_00 + 500_00 * second.venture.path.unpriced.length));
    const withReturn = challengeVenture(priced, { available: usd(60_000_00), heldCapabilityIds: new Set() }, { expectedReturn: usd(90_000_00) });
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

/* ------------------------------------------------------------------------- */
/* Weakness and substitution are reachable from the kernel, not only by hand  */
/* ------------------------------------------------------------------------- */

describe('VENT-24-2: the kernel itself names a weak strategy and keeps the routes around an impossible one', () => {
  it('reads money figures a sentence states, and only the ones it states', () => {
    expect(statedAmounts('US buyers spent $4.2 billion and €30,000 elsewhere')).toEqual([
      { currency: 'USD', amountMinor: 420_000_000_000 },
      { currency: 'EUR', amountMinor: 3_000_000 },
    ]);
    expect(statedAmounts('Restoration contractors bought 40,000 commercial dehumidifiers last year')).toEqual([]);
    expect(statedPrice('The integrator was acquired for $25,000 in 2025')).toEqual({ currency: 'USD', amountMinor: 25_000_00 });
    expect(statedPrice('A drive integrator offers brushless integration as a service')).toBeNull();
  });

  it('bounds the return by stated buyer spending, never by a unit price, and never establishes a return', () => {
    const spend = { statement: 'Buyers spent $40,000 on hand-built kilns last year', sourceClaimId: 'clm_spend' };
    const unit = { statement: 'A kiln is priced at $900 each', sourceClaimId: 'clm_unit' };
    expect(economicsFromReading({ demand: [spend, unit] }, 'USD')).toEqual({
      expectedReturn: null,
      returnCeiling: { money: usd(40_000_00), evidence: ['clm_spend'] },
    });
    expect(economicsFromReading({ demand: [unit] }, 'USD')).toEqual({ expectedReturn: null, returnCeiling: null });
    expect(economicsFromReading({ demand: [spend] }, 'EUR')).toEqual({ expectedReturn: null, returnCeiling: null });
    // A ceiling above the cost proves nothing favourable: the return is still not established.
    const rich: ResourceSituation = { available: usd(1_000_000_00), heldCapabilityIds: new Set(['cap_cnc']) };
    const path = buildVenturePath(venture);
    if (!path.ok) throw new Error('expected a path');
    const high = challengeVenture(path, rich, { expectedReturn: null, returnCeiling: { money: usd(10_000_000_00), evidence: ['clm_x'] } });
    expect(high.feasibility).toBe('UNDETERMINED');
    expect(high.challenges.map((c) => c.kind)).toEqual(['BUILT_ON_UNKNOWNS']);
  });

  it('keeps a substituted route that clears every blocking challenge when no return is established, with its own UNDETERMINED verdict', () => {
    const alts = alternativesFor(venture, poor);
    const contracted = alts.find((a) => a.kind === 'SUBSTITUTED');
    expect(contracted?.differs).toEqual(['production: BUILD → CONTRACT via a contract manufacturer']);
    expect(contracted!.verdict.feasibility).toBe('UNDETERMINED');
    expect(contracted!.verdict.challenges.map((c) => c.kind)).toEqual(['BUILT_ON_UNKNOWNS']);
    // A route that leaves the plan impossible is still not offered.
    for (const a of alts) expect(a.verdict.feasibility).not.toBe('INFEASIBLE');
    // And an original that is merely undetermined gets no undetermined substitutes: they would not be materially better.
    const rich: ResourceSituation = { available: usd(1_000_000_00), heldCapabilityIds: new Set(['cap_cnc']) };
    expect(alternativesFor(venture, rich).filter((a) => a.kind === 'SUBSTITUTED')).toEqual([]);
  });

  it('from the kernel: stated buyer spending below the cost raises ECONOMICALLY_WEAK on its evidence, and offers no substitute as a cure', async () => {
    const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Electric kilns', actorRef: userId, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;

    await recordCategoryCapital({
      programId: program.id,
      categoryId: category.id,
      requirement: 'TOOLING_AND_EQUIPMENT',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 50_000_00,
      amountHighMinor: 60_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'Kiln shell tooling costs $50,000–$60,000',
      sourceClaimId: await acceptedClaim('Kiln shell tooling costs $50,000–$60,000'),
    });
    const spendClaim = await acceptedClaim('Studios spent $40,000 on electric kilns in the region last year');
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'DEMAND_EVIDENCE',
      observedOn: '2026-09-01',
      subject: 'pottery studios',
      statement: 'Studios spent $40,000 on electric kilns in the region last year',
      sourceClaimId: spendClaim,
    });
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 100_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-weak-${projectId}` });

    const weak = (await runManufacturingKernel(projectId)).ventures.find((v) => v.categoryId === category.id)!;
    if (!weak.venture.path.ok) throw new Error('path refused');
    // The contract with the studios, the account and the books are unpriced, so the total is withheld (R6-F1);
    // the tooling alone already costs more than all the spending on record, so the weakness holds whatever they cost.
    expect(weak.venture.path.total).toBeNull();
    expect(weak.venture.path.floor).toEqual(usd(60_000_00));
    const named = weak.venture.verdict!.challenges.find((c) => c.kind === 'ECONOMICALLY_WEAK');
    expect(named).toBeDefined();
    expect(named!.evidence).toEqual([spendClaim]);
    expect(weak.venture.verdict!.feasibility).toBe('INFEASIBLE');
    expect(ventureRecord(weak).verdict!.challenges.map((c) => c.kind)).toContain('ECONOMICALLY_WEAK');

    // Nothing the rows admit makes it less than weak, so no substitute is offered as a cure.
    expect(weak.venture.alternatives.filter((a) => a.kind === 'SUBSTITUTED')).toEqual([]);
  });

  it('from the kernel: a capability nobody holds, with a candidate whose own source states its price, yields a priced SUBSTITUTED (BUY) route', async () => {
    const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Glass annealing ovens', actorRef: userId, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;
    await recordCategoryCapital({
      programId: program.id,
      categoryId: category.id,
      requirement: 'TOOLING_AND_EQUIPMENT',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 10_000_00,
      amountHighMinor: 20_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'Oven shell tooling costs $10,000–$20,000',
      sourceClaimId: await acceptedClaim('Oven shell tooling costs $10,000–$20,000'),
    });
    await recordCategoryEvidence({
      programId: program.id,
      categoryId: category.id,
      kind: 'DEMAND_EVIDENCE',
      observedOn: '2026-09-01',
      subject: 'glass studios',
      statement: 'Glass studios spent $500,000 on annealing ovens last year',
      sourceClaimId: await acceptedClaim('Glass studios spent $500,000 on annealing ovens last year'),
    });
    const { capability } = await ensureCapability({ programId: program.id, projectId, name: 'Oven controller firmware', origin: 'SEED' });
    await recordEdge({
      programId: program.id,
      categoryId: category.id,
      capabilityId: capability.id,
      relation: 'REQUIRES',
      statement: 'An annealing oven needs programmable controller firmware',
      sourceClaimId: await acceptedClaim('An annealing oven needs programmable controller firmware'),
    });
    const priceClaim = await acceptedClaim('A controller firmware studio was acquired for $5,000');
    await recordAcquisitionCandidate({
      programId: program.id,
      categoryId: category.id,
      capabilityId: capability.id,
      name: 'A firmware studio',
      contribution: 'CAPABILITY',
      statement: 'A controller firmware studio was acquired for $5,000',
      sourceClaimId: priceClaim,
    });
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 100_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-buy-${projectId}` });

    const reading = (await runManufacturingKernel(projectId)).ventures.find((v) => v.categoryId === category.id)!;
    if (!reading.venture.path.ok) throw new Error('path refused');
    const capabilityNode = reading.venture.path.nodes.find((n) => n.key === `capability:${capability.id}`)!;
    expect(capabilityNode.alternatives).toEqual([expect.objectContaining({ mode: 'BUY', actor: 'A firmware studio', budget: usd(5_000_00), evidence: [priceClaim] })]);
    expect(reading.venture.verdict!.feasibility).toBe('INFEASIBLE');
    expect(reading.venture.verdict!.challenges.map((c) => c.kind)).toContain('CAPABILITY_NOT_HELD');

    const bought = reading.venture.alternatives.find((a) => a.kind === 'SUBSTITUTED');
    expect(bought).toBeDefined();
    expect(bought!.differs).toEqual([`capability:${capability.id}: BUILD → BUY via A firmware studio`]);
    // Tooling and the bought studio are priced; the institutional machinery is not, so the total is withheld (R6-F1).
    expect(bought!.total).toBeNull();
    expect(bought!.path.floor).toEqual(usd(25_000_00));
    const kinds = bought!.verdict.challenges.map((c) => c.kind);
    expect(kinds).not.toContain('CAPABILITY_NOT_HELD');
    expect(kinds).not.toContain('ECONOMICALLY_WEAK');
    for (const key of bought!.verdict.challenges.find((c) => c.kind === 'UNPRICED_STAGE')!.stages) expect(key.startsWith('institution:')).toBe(true);
    // The return is still nobody's established fact, so the route is recorded as UNDETERMINED, never as ready.
    expect(bought!.verdict.feasibility).toBe('UNDETERMINED');
    expect(ventureRecord(reading).alternatives.map((a) => a.kind)).toContain('SUBSTITUTED');
  });
});

describe('INST-30 / VENT-24-2: the institutional machinery is part of the venture plan (R6-F1)', () => {
  async function juicers(): Promise<{ categoryId: string; toolingClaim: string }> {
    const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Commercial cold-press juicers', actorRef: userId, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const categoryId = seeded.category.id;
    const toolingClaim = await acceptedClaim('Press frame tooling costs $15,000–$20,000');
    await recordCategoryCapital({
      programId: program.id,
      categoryId,
      requirement: 'TOOLING_AND_EQUIPMENT',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 15_000_00,
      amountHighMinor: 20_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'Press frame tooling costs $15,000–$20,000',
      sourceClaimId: toolingClaim,
    });
    await recordCategoryEvidence({
      programId: program.id,
      categoryId,
      kind: 'DEMAND_EVIDENCE',
      observedOn: '2026-09-01',
      subject: 'juice bars',
      statement: 'Juice bars replace cold presses every four years',
      sourceClaimId: await acceptedClaim('Juice bars replace cold presses every four years'),
    });
    await recordCategoryEvidence({
      programId: program.id,
      categoryId,
      kind: 'DISTRIBUTION_CHANNEL',
      subject: 'food-service equipment dealers',
      statement: 'Food-service equipment dealers carry cold presses',
      sourceClaimId: await acceptedClaim('Food-service equipment dealers carry cold presses'),
    });
    return { categoryId, toolingClaim };
  }

  it('the kernel carries every institutional prerequisite of the best structure as a stage the entry decision waits for, withheld when unpriced', async () => {
    const { categoryId } = await juicers();
    await recordMoney({ projectId, kind: 'CAPITAL_IN', amountCents: 100_000_00, currency: 'USD', recordedBy: userId, idempotencyKey: `capital-inst-${projectId}` });

    const pass = await runManufacturingKernel(projectId);
    const plan = pass.institutions.find((one) => one.categoryId === categoryId)!;
    const prerequisites = pathPrerequisites(plan);
    // The rows name a buyer and a distributor, so trading through them needs contracts, authority to sign, an account and books.
    const kinds = new Set(prerequisites.map((one) => one.kind));
    for (const kind of ['CONTRACT', 'SIGNING_AUTHORITY', 'PAYMENT_ACCOUNT', 'ACCOUNTING_BOOKS', 'EXTERNAL_PROVIDER']) expect(kinds.has(kind)).toBe(true);

    const venture = pass.ventures.find((one) => one.categoryId === categoryId)!;
    const path = venture.venture.path;
    if (!path.ok) throw new Error(`path refused: ${path.detail}`);
    const institutionKeys = prerequisites.map((one) => `institution:${one.key}`);
    for (const one of prerequisites) {
      const node = path.nodes.find((n) => n.key === `institution:${one.key}`)!;
      expect(node).toBeDefined();
      expect(node.evidence).toEqual(one.evidence);
      expect(node.approval ?? null).toEqual(one.approval);
      expect(node.dependsOn).toEqual(expect.arrayContaining(['unit-economics', ...one.prerequisites.map((key) => `institution:${key}`)]));
      // Nobody has priced it, so it is withheld — never zero.
      expect(node.budget.state).toBe('WITHHELD');
    }
    // Opening the account and signing contracts are approvals a person gives; the plan names them and who acts.
    const account = path.nodes.find((n) => n.key.startsWith('institution:PAYMENT_ACCOUNT:'))!;
    expect(account.approval?.class).toBe('ACCOUNT_OPENING');
    const contract = path.nodes.find((n) => n.key.startsWith('institution:CONTRACT:'))!;
    expect(contract.approval?.class).toBe('LEGAL_COMMITMENT');
    // Entering waits for every one of them, and launch follows entry.
    expect(path.nodes.find((n) => n.key === 'enter')!.dependsOn).toEqual(expect.arrayContaining(institutionKeys));
    // The total no longer reads as if institutions were free: it is withheld, naming exactly them.
    expect(path.total).toBeNull();
    expect(new Set(path.unpriced)).toEqual(new Set(institutionKeys));
    expect(path.floor).toEqual(usd(20_000_00));
    const verdict = venture.venture.verdict!;
    expect(verdict.challenges.find((c) => c.kind === 'UNPRICED_STAGE')!.stages).toEqual(path.unpriced);
    expect(verdict.feasibility).toBe('UNDETERMINED');
    // A validate-first route never funds a stage that needs an approval, nor the entry that waits for one.
    for (const alternative of venture.venture.alternatives.filter((a) => a.kind === 'VALIDATE_FIRST')) {
      for (const node of alternative.path.nodes) {
        expect(node.approval).toBeUndefined();
        expect(['enter', 'launch', 'scale']).not.toContain(node.key);
      }
    }
    // Nothing was formed, signed or opened: the derivation still holds no element and no approval.
    for (const structure of plan.derivation.structures) {
      for (const element of structure.elements) {
        expect(element.held).toBe(false);
        if (element.approval) expect(element.approval.approved).toBe(false);
      }
    }
  });

  it('a priced institutional prerequisite enters the venture total, and can make an affordable plan unaffordable', async () => {
    const { categoryId } = await juicers();
    const snapshot = (await ladderSnapshot(projectId))!;
    const reading = readLadder(snapshot).find((one) => one.categoryId === categoryId)!;
    const situation: ResourceSituation = { available: usd(25_000_00), heldCapabilityIds: new Set() };

    // Without the institutions the plan costs the tooling alone and fits the capital.
    const bare = buildVenturePath(stagesFromReading(reading));
    if (!bare.ok) throw new Error('path refused');
    expect(bare.total).toEqual(usd(20_000_00));
    expect(challengeVenture(bare, situation).challenges.map((c) => c.kind)).not.toContain('CAPITAL_EXCEEDED');

    // With a sourced setup figure on each institutional element, the total carries them and exceeds the capital.
    const plan = (await runManufacturingKernel(projectId)).institutions.find((one) => one.categoryId === categoryId)!;
    const priced: InstitutionalPrerequisite[] = pathPrerequisites(plan).map((one) => ({ ...one, setup: { state: 'PRICED', money: usd(2_000_00) } }));
    expect(priced.length).toBeGreaterThan(2);
    const full = buildVenturePath(stagesFromReading(reading, [], priced));
    if (!full.ok) throw new Error('path refused');
    expect(full.unpriced).toEqual([]);
    expect(full.total).toEqual(usd(20_000_00 + 2_000_00 * priced.length));
    const verdict = challengeVenture(full, situation);
    expect(verdict.challenges.map((c) => c.kind)).toContain('CAPITAL_EXCEEDED');
    expect(verdict.feasibility).toBe('INFEASIBLE');

    // An unpriced one withholds the total but the priced part still bounds it from below: a floor beyond capital is a shortfall.
    const partly = buildVenturePath(stagesFromReading(reading, [], [...priced.slice(1), { ...priced[0]!, setup: { state: 'UNPRICED' } }]));
    if (!partly.ok) throw new Error('path refused');
    expect(partly.total).toBeNull();
    expect(partly.floor).toEqual(usd(20_000_00 + 2_000_00 * (priced.length - 1)));
    const partlyVerdict = challengeVenture(partly, situation);
    expect(partlyVerdict.challenges.map((c) => c.kind)).toEqual(expect.arrayContaining(['CAPITAL_EXCEEDED', 'UNPRICED_STAGE']));
    expect(partlyVerdict.feasibility).toBe('INFEASIBLE');
  });
});
