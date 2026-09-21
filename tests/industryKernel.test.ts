/**
 * The self-expanding industry kernel: where Brain looks, and how it decides.
 *
 * ---------------------------------------------------------------------------
 * What was missing, and what this pins
 * ---------------------------------------------------------------------------
 *
 * Cash Mode's ten search buckets are ten *mechanisms* — who published a paid
 * request, where one deliverable has two prices, who has sold more than they
 * can deliver — and not one of them says *where* to ask. Production discovery
 * therefore searched an undifferentiated economy, and nothing anywhere said
 * which industries Brain had opened or what lived underneath any of them.
 *
 * Four properties are what make the kernel honest rather than a list, and this
 * file pins each of them as a property rather than as an example:
 *
 * **The map is discovered.** There is no list of industries in the repository,
 * and the first assertion here reads the source to prove it. A node exists
 * because a gated claim said so, or because a person seeded it.
 *
 * **A structural finding is declared, never read out of prose.** The same
 * repair `opportunity_signal` already made, one axis along — so the tests that
 * matter are the *refusals*, not the acceptances.
 *
 * **What can be derived is not stored.** Coverage, the verdict, the capital
 * tier and the plan are all computed from rows, so a change in the rows
 * changes them with nothing having to notice.
 *
 * **An unknown is never a favourable assumption.** A requirement with no
 * published amount withholds the minimum owner capital entirely rather than
 * summing the rest — the one error here that would fail in the encouraging
 * direction.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listCashEvents } from '../server/repos/cashMode.ts';
import {
  createOpportunity,
  listOpportunities,
  transitionOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import {
  launchMission,
  linkMission,
  listMissions,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { activate, setLifecycle, launchableUnderCashMode } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import {
  listCapitalFor,
  listConstraintsForProject,
  listIndustryRounds,
  listNodes,
} from '../server/repos/industry.ts';
import { validateStructural } from '../server/domain/industry.ts';
import { graphSnapshot } from '../server/services/industry/graph.ts';
import { allocate, MAX_OPEN_KERNEL_ROUNDS } from '../server/services/industry/allocate.ts';
import { runIndustryKernel, planFrom } from '../server/services/industry/kernel.ts';
import { seedSubject, retireSubject } from '../server/services/industry/seed.ts';
import { readCapital, executableNow, reactivated, tierFor } from '../server/services/industry/capital.ts';
import { standingOf } from '../server/services/industry/verdict.ts';
import { industryView } from '../server/services/industry/view.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import type { CapitalStructure, Layer, StructuralFinding } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `kernel-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

interface StructuralClaim {
  claim: string;
  finding: StructuralFinding;
  subject: string;
  qualifier?: string;
  amountCents?: number;
  sourceUrl?: string;
  accepted?: boolean;
}

/**
 * A finished mission for one kernel round, carrying declared findings.
 *
 * Built from the real repositories rather than from a stub, because the thing
 * under test is which rows the absorption reads: a fixture that handed it
 * findings directly would pass against an absorption that read prose.
 */
async function finishedRound(input: {
  candidateId: string;
  claims: StructuralClaim[];
  /**
   * Leave the mission RUNNING, so the findings are filed and the round is not
   * settled — the state a tick that died between the two leaves behind.
   */
  leaveRunning?: boolean;
}): Promise<string> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a kernel round',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a kernel round',
    assignment: 'how this is put together',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the sprint may look at',
      requiredEvidence: [
        { id: 'sub_structure', description: 'what sits underneath', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['an industry classification system'],
      excludedSourceTypes: ['a structure asserted with no source that names it'],
      completionCriteria: ['every level declared on its claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'industry-structure',
      question: 'How is this put together?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, {
    status: 'ACCEPTED',
    completedAt: new Date().toISOString(),
    blockedReason: null,
  });

  const inserted = await insertClaims(
    input.claims.map((one) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: one.claim,
      sourceUrl: one.sourceUrl ?? 'https://example.test/classification/512110',
      sourceTitle: 'A classification entry',
      sourcePublisher: 'A statistical agency',
      sourceDate: '2026-09-10',
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the entry body',
      evidenceLane: 'sub_structure',
      structuralFinding: one.finding,
      structuralSubject: one.subject,
      structuralQualifier: one.qualifier ?? null,
      structuralAmountCents: one.amountCents ?? null,
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.subject}`,
    })),
  );
  for (const [index, claim] of inserted.entries()) {
    await decideClaim(claim.id, { accepted: input.claims[index]!.accepted ?? true });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a kernel round',
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  if (!input.leaveRunning) {
    await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
  }
  return orchestration.id;
}

/** Finish a mission left running, so its round settles on the next pass. */
async function finishMissionFor(candidateId: string): Promise<void> {
  const mission = (await listMissions({ projectId })).find(
    (one) => one.candidateId === candidateId,
  );
  expect(mission, 'no mission for that candidate').toBeTruthy();
  await transitionMission({ missionId: mission!.id, from: 'RUNNING', to: 'DONE' });
}

/** The candidate a kernel round of this purpose is asking, if one is open. */
async function candidateFor(purpose: string): Promise<string | null> {
  const rounds = await listIndustryRounds(projectId);
  const round = rounds.find((one) => one.purpose === purpose && one.state === 'OPEN');
  return round?.candidateId ?? null;
}

// ---------------------------------------------------------------------------

describe('the map is discovered, never declared', () => {
  /**
   * The assertion the whole kernel rests on, and it reads the repository
   * rather than behaviour.
   *
   * `tests/operatorConsoleRemoved.test.ts` reads the source for the same
   * reason: what must not exist is not something a behavioural test can see.
   * A list of industries anywhere in the kernel would answer the question the
   * kernel exists to ask, and would be wrong about every economy a
   * classification system has revised since somebody typed it.
   */
  it('holds no list of industries anywhere in the kernel', () => {
    const suspects = [
      'server/services/industry/allocate.ts',
      'server/services/industry/expand.ts',
      'server/services/industry/graph.ts',
      'server/services/industry/kernel.ts',
      'server/services/industry/questions.ts',
      'server/services/industry/seed.ts',
      'server/domain/industry.ts',
      'server/repos/industry.ts',
    ];
    /*
     * Named industries that a hardcoded bootstrap would inevitably contain.
     * Not a complete list of industries — it cannot be, which is the point —
     * but every one of these is a word that only appears in a file like this
     * if somebody has started writing the economy down.
     */
    const industries = [
      'Manufacturing',
      'Agriculture',
      'Construction',
      'Mining',
      'Utilities',
      'Wholesale Trade',
      'Retail Trade',
      'Transportation and Warehousing',
      'Finance and Insurance',
      'Real Estate',
      'Health Care',
      'Accommodation and Food',
    ];
    for (const path of suspects) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      for (const industry of industries) {
        expect(source).not.toContain(industry);
      }
    }
  });

  it('starts with an empty map and asks the classification systems what exists', async () => {
    await activated();
    expect(await listNodes(projectId)).toHaveLength(0);

    const pass = await runIndustryKernel(projectId);
    expect(pass.opened).toHaveLength(1);
    expect(pass.opened[0]!.purpose).toBe('BOOTSTRAP');

    // The question names *systems to consult*, which is naming sources — the
    // same thing `proposedSources` already does — and names no sector.
    const question = pass.opened[0]!.question;
    expect(question).toContain('NAICS');
    expect(question).toContain('ISIC');
    for (const industry of ['Manufacturing', 'Construction', 'Health Care']) {
      expect(question).not.toContain(industry);
    }

    // And it is a captured candidate, so the archive check, the judgment pass,
    // the compiler and all three audit roles still decide. Not a second path.
    const candidates = await listCandidates({ projectId });
    const bootstrap = candidates.find((one) => one.id === pass.opened[0]!.candidateId);
    expect(bootstrap?.state).toBe('CAPTURED');
  });

  it('files the sectors a gated claim established, and nothing else', async () => {
    await activated();
    await runIndustryKernel(projectId);
    const candidateId = (await candidateFor('BOOTSTRAP'))!;

    await finishedRound({
      candidateId,
      claims: [
        { claim: 'The system declares a sector for motion picture production.', finding: 'SUB_INDUSTRY', subject: 'Motion picture and video industries' },
        { claim: 'The system declares a sector for freight transport.', finding: 'SUB_INDUSTRY', subject: 'Freight transportation' },
        // Accepted by the worker and refused by the gate. It must not reach
        // the map: the gate decides what counts, and it decides once.
        { claim: 'Somebody said there is a sector for vibes.', finding: 'SUB_INDUSTRY', subject: 'Vibes', accepted: false },
      ],
    });

    const pass = await runIndustryKernel(projectId);
    expect(pass.absorbed.nodes.map((one) => one.name).sort()).toEqual([
      'Freight transportation',
      'Motion picture and video industries',
    ]);
    for (const node of pass.absorbed.nodes) {
      expect(node.origin).toBe('BOOTSTRAP');
      expect(node.kind).toBe('SECTOR');
      // Every node traces to a passage. The schema enforces it; this reads it.
      expect(node.sourceClaimId).toBeTruthy();
    }

    // The round settles with what it produced, so the next one is decided
    // against a number rather than against a default.
    const rounds = await listIndustryRounds(projectId);
    const bootstrap = rounds.find((one) => one.purpose === 'BOOTSTRAP')!;
    expect(bootstrap.state).toBe('HARVESTED');
    expect(bootstrap.found).toBe(2);
  });
});

describe('a structural finding is declared, and the refusals are the point', () => {
  it('refuses a finding outside the closed set rather than storing it', () => {
    const result = validateStructural({
      where: 'claims[0]',
      finding: 'SOUNDS_PROMISING',
      subject: 'Animation',
      qualifier: null,
      amountCents: null,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a map finding with no subject, because a node with no name is nothing', () => {
    const result = validateStructural({
      where: 'claims[0]',
      finding: 'SUB_INDUSTRY',
      subject: '  ',
      qualifier: null,
      amountCents: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('structural_subject');
  });

  it('refuses a capital subject that is not one of the requirements it may be', () => {
    const result = validateStructural({
      where: 'claims[0]',
      finding: 'CAPITAL_REQUIREMENT',
      subject: 'a big studio',
      qualifier: null,
      amountCents: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('LABOR');
  });

  it('refuses a restructuring that does not say what it answers', () => {
    const result = validateStructural({
      where: 'claims[0]',
      finding: 'CAPITAL_RESTRUCTURING',
      subject: 'SUBCONTRACT',
      qualifier: null,
      amountCents: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('reduces nothing');
  });

  it('refuses a subject on a kind that names nothing, and a figure on one that has none', () => {
    const stray = validateStructural({
      where: 'claims[0]',
      finding: null,
      subject: 'Animation',
      qualifier: null,
      amountCents: null,
    });
    expect(stray.ok).toBe(false);

    const figure = validateStructural({
      where: 'claims[1]',
      finding: 'BOTTLENECK',
      subject: 'In-between animator shortage',
      qualifier: null,
      amountCents: 5_000,
    });
    expect(figure.ok).toBe(false);
    if (!figure.ok) expect(figure.error).toContain('no figure');
  });

  /**
   * There is no kind for a platitude, and that is structural rather than a
   * filter over prose.
   *
   * §27 records what happens to a closed list that has to be complete over
   * ordinary English — four widenings, each adding the one word the last
   * production message was declined for. This list's failure mode is
   * *missing* a real constraint, never admitting a baseline one, because the
   * baseline one has nowhere to go.
   */
  it('has nowhere to file an observation every business already knows', () => {
    for (const platitude of ['CUSTOMERS_MAY_NOT_BUY', 'STAFF_MUST_BE_PAID', 'BUSINESSES_HAVE_EXPENSES']) {
      const result = validateStructural({
        where: 'claims[0]',
        finding: 'HIDDEN_CONSTRAINT',
        subject: platitude,
        qualifier: null,
        amountCents: null,
      });
      expect(result.ok).toBe(false);
    }
    // And a real one is accepted, so the refusal above is the vocabulary
    // rather than the validator refusing everything.
    const real = validateStructural({
      where: 'claims[0]',
      finding: 'HIDDEN_CONSTRAINT',
      subject: 'CYCLE_LONGER_THAN_STATED',
      qualifier: null,
      amountCents: null,
    });
    expect(real.ok).toBe(true);
  });

  it('applies one rule at both doors, so the two cannot disagree', () => {
    // The wire door and the provider door both delegate here, which is what
    // this asserts: neither file may hold a second copy of the rule.
    const tool = readFileSync(new URL('../server/mcp/researchTools.ts', import.meta.url), 'utf8');
    const schema = readFileSync(
      new URL('../server/services/research/schema.ts', import.meta.url),
      'utf8',
    );
    expect(tool).toContain('validateStructural');
    expect(schema).toContain('validateStructural');
    // And the field is declared in the schema, not only described in the
    // prose — §33's defect, where a client honouring the schema dropped the
    // one field that decided whether anything was ever created.
    expect(tool).toContain("structural_finding: {");
    expect(tool).toContain("structural_subject: {");
  });
});

describe('recursive expansion', () => {
  it('drills into a subject that produced an opening, and not into one that did not', async () => {
    await activated();
    const seed = await seedSubject({
      projectId,
      name: 'Animation and anime production',
      actorRef: userId,
    });
    const quiet = await seedSubject({ projectId, name: 'A quiet corner', actorRef: userId });

    // An opening that came out of the seeded subject's own scan.
    const mode = (await getCashMode(projectId))!;
    await createOpportunity({
      projectId,
      cashModeId: mode.id,
      ownerUserId: userId,
      title: 'A studio published an overflow request',
      mechanism: 'SUBCONTRACTED_FULFILMENT',
      currency: mode.currency,
      industryNodeId: seed.node.id,
    });

    const snapshot = await graphSnapshot(projectId);
    const plan = await planFrom(snapshot);

    const forSeed = plan.asks.filter((one) => one.nodeId === seed.node.id);
    const forQuiet = plan.asks.filter((one) => one.nodeId === quiet.node.id);
    expect(forSeed.length).toBeGreaterThan(0);
    // The subject with evidence outranks the one without, which is the brief's
    // own allocation rule: effort follows evidence of accessible cash.
    if (forQuiet.length > 0) {
      expect(Math.min(...forSeed.map((one) => one.rank))).toBeLessThan(
        Math.min(...forQuiet.map((one) => one.rank)),
      );
    }
    // And the reason is recorded in words, so the decision can be argued with.
    expect(forSeed[0]!.why).toContain('Animation and anime production');
  });

  it('files a discovered subject underneath the subject that was asked about', async () => {
    await activated();
    const seed = await seedSubject({
      projectId,
      name: 'Animation and anime production',
      actorRef: userId,
    });

    await runIndustryKernel(projectId);
    const rounds = await listIndustryRounds(projectId);
    const scoped = rounds.find((one) => one.nodeId === seed.node.id && one.state === 'OPEN');
    expect(scoped).toBeDefined();

    await finishedRound({
      candidateId: scoped!.candidateId,
      claims: [
        { claim: 'A trade body describes finishing as a distinct stage.', finding: 'VALUE_CHAIN_LAYER', subject: 'Finishing' },
        { claim: 'Production studios commission the work.', finding: 'BUYER_TYPE', subject: 'Production studios' },
        { claim: 'Offshore subcontractors perform it.', finding: 'FULFILMENT_SOURCE', subject: 'Offshore subcontract studios' },
        { claim: 'The trade press documents an in-between animator shortage.', finding: 'BOTTLENECK', subject: 'In-between animator shortage' },
      ],
    });

    const pass = await runIndustryKernel(projectId);
    expect(pass.absorbed.nodes).toHaveLength(4);
    for (const node of pass.absorbed.nodes) {
      expect(node.parentId).toBe(seed.node.id);
      expect(node.origin).toBe('DISCOVERED');
    }

    // The path is what a question about a child actually carries, because a
    // leaf name on its own is not a researchable subject.
    const view = await industryView(projectId);
    const finishing = view.subjects.find((one) => one.name === 'Finishing')!;
    expect(finishing.path).toEqual(['Animation and anime production', 'Finishing']);
  });

  /**
   * Recursion that stops, and stops for a reason in the rows.
   *
   * A bottleneck and a buyer type are leaves of understanding rather than
   * places with more inside them; decomposing them would produce a graph of
   * adjectives. They are still *scanned*, because a bottleneck is exactly
   * where an opening lives.
   */
  it('never asks what sits underneath a bottleneck, and still searches one', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    await runIndustryKernel(projectId);
    const scoped = (await listIndustryRounds(projectId)).find(
      (one) => one.nodeId === seed.node.id && one.state === 'OPEN',
    )!;
    await finishedRound({
      candidateId: scoped.candidateId,
      claims: [
        { claim: 'A documented shortage.', finding: 'BOTTLENECK', subject: 'A named shortage' },
      ],
    });
    await runIndustryKernel(projectId);

    const snapshot = await graphSnapshot(projectId);
    const bottleneck = snapshot.coverage.find((one) => one.node.name === 'A named shortage')!;
    expect(bottleneck.recurses).toBe(false);

    const plan = await planFrom(snapshot);
    const mine = plan.asks.filter((one) => one.nodeId === bottleneck.node.id);
    expect(mine.every((one) => one.purpose !== 'MAP')).toBe(true);
  });
});

describe('weak paths are killed, and killing one is not a delete', () => {
  it('stops offering a subject whose searches found nothing and whose map found nothing', async () => {
    const snapshot = await graphSnapshot(projectId);
    const barren = standingOf(
      {
        node: {
          id: 'ind_1',
          projectId,
          parentId: null,
          kind: 'SECTOR',
          name: 'A barren sector',
          description: null,
          origin: 'SEED',
          sourceClaimId: null,
          retiredAt: null,
          retiredReason: null,
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
        path: ['A barren sector'],
        depth: 0,
        children: 0,
        recurses: true,
        mapRounds: 1,
        mapOpen: false,
        mapFound: 0,
        scanRounds: 3,
        scanOpen: false,
        scanFound: 0,
        bucketsAsked: new Set(),
        openings: 0,
        constraints: 0,
        lastAskedAt: '2026-09-01T00:00:00.000Z',
        lastSettledAt: '2026-09-02T00:00:00.000Z',
      },
      [],
    );
    expect(barren.verdict).toBe('DEAD_END');
    expect(barren.worthDeepening).toBe(false);
    expect(snapshot.nodes).toHaveLength(0);
  });

  it('keeps a retired subject, its reason and its evidence, and stops offering it', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    await runIndustryKernel(projectId);
    const before = (await planFrom(await graphSnapshot(projectId))).asks;
    expect(before.some((one) => one.nodeId === seed.node.id)).toBe(true);

    await retireSubject({
      projectId,
      nodeId: seed.node.id,
      reason: 'The margins do not survive the licensing here.',
      actorRef: userId,
    });

    const after = (await planFrom(await graphSnapshot(projectId))).asks;
    expect(after.some((one) => one.nodeId === seed.node.id)).toBe(false);

    // Kept, not deleted — which is what stops it arriving again as a fresh
    // discovery and the allowance being spent to learn it twice.
    const nodes = await listNodes(projectId);
    expect(nodes.find((one) => one.id === seed.node.id)?.retiredReason).toBe(
      'The margins do not survive the licensing here.',
    );
    const view = await industryView(projectId);
    expect(view.retired.map((one) => one.id)).toContain(seed.node.id);
  });
});

describe('research prioritization', () => {
  it('finishes what has already been spent before starting the next search', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    const mode = (await getCashMode(projectId))!;
    const opportunity = await createOpportunity({
      projectId,
      cashModeId: mode.id,
      ownerUserId: userId,
      title: 'A qualified opening',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: mode.currency,
      industryNodeId: seed.node.id,
    });
    // Qualified, which is when decomposing its capital is worth a round.
    await transitionOpportunity({
      id: opportunity.id,
      from: ['DISCOVERED'],
      to: 'EVIDENCE_CARD',
    });

    const plan = await planFrom(await graphSnapshot(projectId));
    expect(plan.asks[0]!.purpose).toBe('CAPITAL');
    expect(plan.asks[0]!.opportunityId).toBe(opportunity.id);
  });

  it('never opens more questions at once than the concurrency bound', async () => {
    await activated();
    for (let index = 0; index < 8; index += 1) {
      await seedSubject({ projectId, name: `Sector ${index}`, actorRef: userId });
    }
    const plan = await planFrom(await graphSnapshot(projectId));
    expect(plan.asks.length).toBeLessThanOrEqual(MAX_OPEN_KERNEL_ROUNDS);
    // And the ones it did not take are reported rather than dropped.
    expect(plan.declined.length).toBeGreaterThan(0);
  });

  it('asks one question per subject per pass, so breadth is not starved', async () => {
    await activated();
    for (let index = 0; index < 3; index += 1) {
      await seedSubject({ projectId, name: `Sector ${index}`, actorRef: userId });
    }
    const plan = await planFrom(await graphSnapshot(projectId));
    const subjects = plan.asks.map((one) => one.nodeId ?? one.opportunityId ?? 'bootstrap');
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it('is a pure decision over a snapshot, so the same input gives the same plan', async () => {
    await activated();
    await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    const snapshot = await graphSnapshot(projectId);
    const once = allocate({ snapshot, slots: 4, capitalDecomposed: new Set() });
    const twice = allocate({ snapshot, slots: 4, capitalDecomposed: new Set() });
    expect(twice.asks).toEqual(once.asks);
  });
});

describe('capital structure', () => {
  const entry = (over: Partial<CapitalStructure>): CapitalStructure => ({
    id: `cap_${Math.random().toString(36).slice(2, 10)}`,
    projectId: 'prj_1',
    opportunityId: 'cop_1',
    entryKind: 'REQUIREMENT',
    requirement: 'EQUIPMENT',
    mechanism: null,
    answersId: null,
    amountCents: null,
    residualCents: null,
    statement: 'a requirement',
    sourceClaimId: 'clm_1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  });

  it('withholds the minimum entirely when any requirement has no published amount', () => {
    const reading = readCapital('cop_1', [
      entry({ requirement: 'EQUIPMENT', amountCents: 500_000 }),
      // Nothing published an amount. Summing the rest would produce a number
      // that is wrong in the encouraging direction — the one error here that
      // makes a piece look cheaper than it is.
      entry({ requirement: 'LICENSING', amountCents: null }),
    ]);
    expect(reading.minimumOwnerCents).toBeNull();
    expect(reading.unknown).toBe('AMOUNT_UNKNOWN');
  });

  it('separates "nobody has looked" from "it is out of reach"', () => {
    const undecomposed = readCapital('cop_1', []);
    expect(undecomposed.unknown).toBe('NOT_DECOMPOSED');
    expect(executableNow(undecomposed, 10_000_000)).toBe('UNKNOWN');

    const known = readCapital('cop_1', [entry({ amountCents: 50_000_000 })]);
    expect(executableNow(known, 10_000_000)).toBe('NO');
    expect(executableNow(known, 60_000_000)).toBe('YES');
  });

  it('lets a published residual reduce a requirement, and an unpublished one reduce nothing', () => {
    const requirement = entry({ requirement: 'INVENTORY', amountCents: 1_000_000 });
    const withNothing = readCapital('cop_1', [
      requirement,
      entry({
        entryKind: 'RESTRUCTURING',
        requirement: null,
        mechanism: 'CONSIGNMENT',
        answersId: requirement.id,
        residualCents: null,
      }),
    ]);
    // Available, and it moves no number. A mechanism with no figure is not a
    // discount however plausible it sounds.
    expect(withNothing.minimumOwnerCents).toBe(1_000_000);
    expect(withNothing.mechanisms).toEqual(['CONSIGNMENT']);

    const withResidual = readCapital('cop_1', [
      requirement,
      entry({
        entryKind: 'RESTRUCTURING',
        requirement: null,
        mechanism: 'CONSIGNMENT',
        answersId: requirement.id,
        residualCents: 100_000,
      }),
    ]);
    expect(withResidual.minimumOwnerCents).toBe(100_000);
    expect(withResidual.removedCents).toBe(900_000);
  });

  it('takes the best published residual rather than averaging alternatives', () => {
    const requirement = entry({ requirement: 'WORKING_CAPITAL', amountCents: 2_000_000 });
    const reading = readCapital('cop_1', [
      requirement,
      entry({
        entryKind: 'RESTRUCTURING',
        requirement: null,
        mechanism: 'CUSTOMER_DEPOSIT',
        answersId: requirement.id,
        residualCents: 800_000,
      }),
      entry({
        entryKind: 'RESTRUCTURING',
        requirement: null,
        mechanism: 'MILESTONE_BILLING',
        answersId: requirement.id,
        residualCents: 400_000,
      }),
    ]);
    // You use one structure, not the mean of two.
    expect(reading.minimumOwnerCents).toBe(400_000);
  });
});

describe('capital tiers and reactivation', () => {
  it('files an opening by what it needs rather than losing it', () => {
    expect(tierFor(100_000)).toBe('T0');
    expect(tierFor(1_000_000)).toBe('T1');
    expect(tierFor(3_000_000)).toBe('T2');
    expect(tierFor(300_000_000)).toBe('T5');
    // An undecomposed opening has no tier, which is different from a high one.
    expect(tierFor(null)).toBeNull();
  });

  it('brings an opening back when the money crosses its minimum', () => {
    const readings = [
      readCapital('cop_small', [
        {
          id: 'cap_1', projectId: 'p', opportunityId: 'cop_small', entryKind: 'REQUIREMENT',
          requirement: 'LABOR', mechanism: null, answersId: null, amountCents: 300_000,
          residualCents: null, statement: 's', sourceClaimId: 'c',
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]),
      readCapital('cop_big', [
        {
          id: 'cap_2', projectId: 'p', opportunityId: 'cop_big', entryKind: 'REQUIREMENT',
          requirement: 'PROPERTY', mechanism: null, answersId: null, amountCents: 90_000_000,
          residualCents: null, statement: 's', sourceClaimId: 'c',
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]),
    ];
    const back = reactivated(readings, 100_000, 1_000_000);
    expect(back.map((one) => one.opportunityId)).toEqual(['cop_small']);
    // And nothing comes back when the money has not moved.
    expect(reactivated(readings, 1_000_000, 1_000_000)).toHaveLength(0);
  });
});

describe('it is an entrance, not a second pipeline', () => {
  it('routes each kernel question to a reviewed envelope with a matching profile', () => {
    for (const id of ['RUSSELL_INDUSTRY_MAP_V1', 'RUSSELL_CAPITAL_STRUCTURE_V1']) {
      const envelope = getApprovalEnvelope(id);
      expect(envelope).not.toBeNull();
      // It authorizes reading and refuses every action, which is the whole
      // reason adding an envelope is a code change somebody reviews.
      expect(envelope!.forbiddenActions.test('purchase a subscription')).toBe(true);
      expect(envelope!.forbiddenActions.test('contact the buyer to ask their budget')).toBe(true);
      expect(profileFor(id)).not.toBeNull();
    }
  });

  it('classifies a kernel question as discovery, so winding down stops it', async () => {
    await activated();
    await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    const pass = await runIndustryKernel(projectId);
    expect(pass.opened.length).toBeGreaterThan(0);
    const candidateId = pass.opened[0]!.candidateId;

    const mode = (await getCashMode(projectId))!;
    expect(await launchableUnderCashMode({ candidateId, mode })).toBe(true);

    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'the sprint is ending',
    });
    const wound = (await getCashMode(projectId))!;
    expect(await launchableUnderCashMode({ candidateId, mode: wound })).toBe(false);

    // And no new question is opened while it is wound down.
    const after = await runIndustryKernel(projectId);
    expect(after.opened).toHaveLength(0);
    expect(after.declined[0]!.why).toContain('no new discovery');
  });

  it('keeps filing what already ran after the sprint has wound down', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    await runIndustryKernel(projectId);
    const scoped = (await listIndustryRounds(projectId)).find(
      (one) => one.nodeId === seed.node.id && one.state === 'OPEN',
    )!;
    await finishedRound({
      candidateId: scoped.candidateId,
      claims: [
        { claim: 'A trade body names a narrower industry.', finding: 'SUB_INDUSTRY', subject: 'A narrower one' },
      ],
    });

    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'the sprint is ending',
    });

    // Winding down ends new discovery and never the answers to what already
    // ran arriving — the spending happened when it ran.
    const pass = await runIndustryKernel(projectId);
    expect(pass.absorbed.nodes.map((one) => one.name)).toEqual(['A narrower one']);
    expect(pass.opened).toHaveLength(0);
  });
});

describe('persistence and idempotency', () => {
  it('produces one round and one subject however many times the tick runs', async () => {
    await activated();
    await seedSubject({ projectId, name: 'A sector', actorRef: userId });

    const first = await runIndustryKernel(projectId);
    const second = await runIndustryKernel(projectId);
    /*
     * The second pass never re-asks a question the first one opened.
     *
     * It may legitimately open a *different* one — the allocator has four
     * slots and a subject has more than one question worth asking — so what
     * is pinned is that no exact question is duplicated, which is what the
     * unique index on `industry_rounds` actually guarantees.
     */
    const asked = [...first.opened, ...second.opened].map(
      (one) => `${one.purpose}|${one.nodeId ?? '-'}|${one.bucketId ?? '-'}|${one.round}`,
    );
    expect(new Set(asked).size).toBe(asked.length);

    const scoped = (await listIndustryRounds(projectId)).find(
      (one) => one.state === 'OPEN' && one.nodeId !== null,
    )!;
    await finishedRound({
      candidateId: scoped.candidateId,
      claims: [
        { claim: 'A trade body names it.', finding: 'SUB_INDUSTRY', subject: 'A narrower one' },
      ],
    });

    await runIndustryKernel(projectId);
    await runIndustryKernel(projectId);
    const named = (await listNodes(projectId)).filter((one) => one.name === 'A narrower one');
    expect(named).toHaveLength(1);
    expect(first.opened.length).toBeGreaterThan(0);
  });

  it('carries the reason a question was opened onto the project history', async () => {
    await activated();
    await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    await runIndustryKernel(projectId);

    const events = await listCashEvents(projectId, 50);
    const opened = events.filter((one) => one.kind === 'INDUSTRY_ROUND_OPENED');
    /*
     * Every opened round, rather than whichever one the listing happens to
     * return first.
     *
     * One pass opens more than one question — the bootstrap and the seeded
     * subject's first scan — and `listCashEvents` orders by `created_at DESC,
     * id DESC` over ids that are random. Two rows written in the same
     * millisecond therefore come back in an arbitrary order, so a `find` here
     * asserts on whichever one sorted first. It passed locally and failed in
     * CI, which is the tell: an ordering that is true only sometimes is not an
     * ordering, and §33 records the same defect one surface along.
     *
     * The intent was never "the first event names the subject" anyway. It is
     * that **each** round carries the reason it was opened for, so that "why
     * did Brain research this" resolves to a sentence written when the
     * decision was made, over a snapshot that has since moved on.
     */
    const why = opened.map((one) => String((one.detail as Record<string, unknown>)['why']));
    expect(why.length).toBeGreaterThan(0);
    expect(why.every((one) => one.trim().length > 0)).toBe(true);
    expect(why.some((one) => one.includes('A sector'))).toBe(true);
    expect(why.some((one) => one.includes('the economy contains'))).toBe(true);
  });
});

describe('capital and constraints reach the right table', () => {
  it('files a requirement, its structure and a constraint from one packet', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    const mode = (await getCashMode(projectId))!;
    const opportunity = await createOpportunity({
      projectId,
      cashModeId: mode.id,
      ownerUserId: userId,
      title: 'A qualified opening',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: mode.currency,
      industryNodeId: seed.node.id,
    });
    await transitionOpportunity({
      id: opportunity.id,
      from: ['DISCOVERED'],
      to: 'EVIDENCE_CARD',
    });

    await runIndustryKernel(projectId);
    const capitalRound = (await listIndustryRounds(projectId)).find(
      (one) => one.purpose === 'CAPITAL' && one.state === 'OPEN',
    )!;
    expect(capitalRound.opportunityId).toBe(opportunity.id);

    await finishedRound({
      candidateId: capitalRound.candidateId,
      claims: [
        {
          claim: 'A supplier publishes a minimum inventory order of $4,000.',
          finding: 'CAPITAL_REQUIREMENT',
          subject: 'INVENTORY',
          amountCents: 400_000,
        },
        {
          claim: 'The trade body documents consignment terms leaving $500 at risk.',
          finding: 'CAPITAL_RESTRUCTURING',
          subject: 'CONSIGNMENT',
          qualifier: 'INVENTORY',
          amountCents: 50_000,
        },
        {
          claim: 'The buyer pays only after final acceptance, which follows delivery by weeks.',
          finding: 'HIDDEN_CONSTRAINT',
          subject: 'PAYMENT_ON_FINAL_ACCEPTANCE',
        },
      ],
    });

    const pass = await runIndustryKernel(projectId);
    expect(pass.absorbed.capital).toHaveLength(2);
    expect(pass.absorbed.constraints).toHaveLength(1);

    const reading = readCapital(opportunity.id, await listCapitalFor(opportunity.id));
    // The structure names the requirement it answers, so its residual applies.
    expect(reading.minimumOwnerCents).toBe(50_000);
    expect(reading.mechanisms).toEqual(['CONSIGNMENT']);

    const constraints = await listConstraintsForProject(projectId);
    expect(constraints[0]!.opportunityId).toBe(opportunity.id);
    expect(constraints[0]!.kind).toBe('PAYMENT_ON_FINAL_ACCEPTANCE');

    // And the view puts the two together: what it needs, against what exists.
    const view = await industryView(projectId);
    const card = view.capital.find((one) => one.opportunityId === opportunity.id)!;
    expect(card.minimumOwnerCents).toBe(50_000);
    expect(card.constraints).toHaveLength(1);
  });

  it('refuses a capital figure on a round that is not about one opening', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    await runIndustryKernel(projectId);
    const scoped = (await listIndustryRounds(projectId)).find(
      (one) => one.nodeId === seed.node.id && one.state === 'OPEN',
    )!;
    await finishedRound({
      candidateId: scoped.candidateId,
      claims: [
        {
          claim: 'Equipment costs $20,000 somewhere in this sector.',
          finding: 'CAPITAL_REQUIREMENT',
          subject: 'EQUIPMENT',
          amountCents: 2_000_000,
        },
      ],
    });

    const pass = await runIndustryKernel(projectId);
    // Reported rather than attached to something plausible: Brain deciding
    // which piece of work a figure was about is the confidently wrong answer.
    expect(pass.absorbed.capital).toHaveLength(0);
    expect(pass.absorbed.refused).toHaveLength(1);
    expect(pass.absorbed.refused[0]!.why).toContain('one opening');
  });
});

describe('a round records what it established, whenever the tick happened to die', () => {
  /**
   * The crash window between filing and settling, which a tally gets wrong.
   *
   * `absorb` counted what *this pass wrote*. That is correct only while every
   * pass that absorbs a round also closes it — and a tick that dies in between
   * leaves the findings filed and the round OPEN, so the next pass writes
   * nothing (every insert conflicts on its unique index), counts zero, and
   * records a round that established two subjects as having established none.
   *
   * `found` is what `nextRoundFor` and `standingOf` decide barrenness against,
   * so the subject is then documented as one nobody should look at again — from
   * an accident of timing rather than from anything about the subject.
   *
   * The openings half was already derived from rows; this makes the other half
   * the same shape. Simulated by absorbing once with the mission still running
   * and settling on the pass after, which is exactly what the dead tick leaves.
   */
  it('records what a round established even when an earlier pass already filed it', async () => {
    await activated();
    await runIndustryKernel(projectId);
    const candidate = await candidateFor('BOOTSTRAP');

    await finishedRound({
      candidateId: candidate!,
      leaveRunning: true,
      claims: [
        {
          claim: 'The classification declares an information sector.',
          finding: 'SUB_INDUSTRY',
          subject: 'Information',
        },
        {
          claim: 'It also declares a manufacturing sector.',
          finding: 'SUB_INDUSTRY',
          subject: 'Manufacturing',
        },
      ],
    });

    // The pass that files them. The mission is still running, so the round
    // stays OPEN — the state a tick that died in between leaves behind.
    const first = await runIndustryKernel(projectId);
    expect(first.absorbed.nodes).toHaveLength(2);
    expect(first.absorbed.settled).toHaveLength(0);

    // The pass that settles it. It files nothing, because every insert now
    // conflicts — and a tally of what *this* pass wrote would read zero.
    await finishMissionFor(candidate!);
    const second = await runIndustryKernel(projectId);
    expect(second.absorbed.nodes).toHaveLength(0);

    const bootstrap = (await listIndustryRounds(projectId)).find(
      (one) => one.purpose === 'BOOTSTRAP',
    )!;
    expect(bootstrap.state).toBe('HARVESTED');
    expect(bootstrap.found).toBe(2);
  });

  /**
   * And the repair changes nothing about a round that settled correctly.
   *
   * Counting *rows* rather than declared claims is what makes that true: two
   * claims naming one subject file one node, which is what the tally counted.
   * Counting claims would have said two and quietly moved a number on every
   * correctly settled round in the database.
   */
  it('counts what was filed, so two claims naming one subject stay one finding', async () => {
    await activated();
    await runIndustryKernel(projectId);
    const candidate = await candidateFor('BOOTSTRAP');

    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'One classification declares an information sector.',
          finding: 'SUB_INDUSTRY',
          subject: 'Information',
          sourceUrl: 'https://example.test/naics/51',
        },
        {
          claim: 'Another declares the same information sector.',
          finding: 'SUB_INDUSTRY',
          subject: 'Information',
          sourceUrl: 'https://example.test/isic/j',
        },
      ],
    });
    await runIndustryKernel(projectId);

    expect((await listNodes(projectId)).filter((one) => one.name === 'Information')).toHaveLength(1);
    const bootstrap = (await listIndustryRounds(projectId)).find(
      (one) => one.purpose === 'BOOTSTRAP',
    )!;
    // One node was filed, so one finding — exactly what the tally recorded.
    expect(bootstrap.found).toBe(1);
  });
});

describe('a scan is judged on the openings it produced', () => {
  /**
   * The defect this pins would have killed the most productive subject first.
   *
   * A SCAN round is the ten mechanism questions with a scope, so what it
   * produces is **openings** — written by `harvest` into `cash_opportunities`
   * — and almost none of its claims carry a structural finding at all.
   * Counting only what the kernel itself filed recorded `found = 0` for a scan
   * that turned up five openings, and three of those in a row is
   * `BARREN_ROUNDS`. The subject producing the most work in the sprint would
   * have been the first one Brain stopped asking about.
   */
  it('counts what harvest promoted, not only what the kernel filed', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    await runIndustryKernel(projectId);
    const scan = (await listIndustryRounds(projectId)).find(
      (one) => one.purpose === 'SCAN' && one.nodeId === seed.node.id,
    )!;

    // A finished scan whose claims are openings rather than structure — which
    // is the ordinary shape of a scan, not an edge case.
    const orchestrationId = await finishedRound({ candidateId: scan.candidateId, claims: [] });
    const mode = (await getCashMode(projectId))!;
    for (const title of ['A published brief', 'A second published brief']) {
      await createOpportunity({
        projectId,
        cashModeId: mode.id,
        ownerUserId: userId,
        title,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        currency: mode.currency,
        industryNodeId: seed.node.id,
        orchestrationId,
      });
    }

    await runIndustryKernel(projectId);
    const settled = (await listIndustryRounds(projectId)).find((one) => one.id === scan.id)!;
    expect(settled.state).toBe('HARVESTED');
    expect(settled.found).toBe(2);

    // And the subject reads as productive rather than barren, which is what
    // the count was for.
    const snapshot = await graphSnapshot(projectId);
    const coverage = snapshot.coverage.find((one) => one.node.id === seed.node.id)!;
    expect(coverage.scanFound).toBe(2);
    expect(standingOf(coverage, snapshot.opportunities).verdict).not.toBe('DEAD_END');
  });

  it('still records nothing as nothing, so a barren subject does stop', async () => {
    await activated();
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    await runIndustryKernel(projectId);
    const scan = (await listIndustryRounds(projectId)).find(
      (one) => one.purpose === 'SCAN' && one.nodeId === seed.node.id,
    )!;
    await finishedRound({ candidateId: scan.candidateId, claims: [] });
    await runIndustryKernel(projectId);

    const settled = (await listIndustryRounds(projectId)).find((one) => one.id === scan.id)!;
    // Zero rather than null: the round settled, and it found nothing. Those
    // are two different facts and only the second one is a measurement.
    expect(settled.found).toBe(0);
  });
});

describe('the animation seed is a row, not a special case', () => {
  it('treats a seeded subject exactly as it treats a discovered one', async () => {
    await activated();
    const seed = await seedSubject({
      projectId,
      name: 'Animation and anime production',
      description: 'The value chain from commission through finishing and delivery.',
      actorRef: userId,
      reason: 'The operator named it as the first subject worth Brain’s attention.',
    });
    expect(seed.node.origin).toBe('SEED');
    // The one origin Brain cannot write: the schema requires every other one
    // to carry the claim that established it, and Brain cannot produce a claim
    // that has not been through the gate.
    expect(seed.node.sourceClaimId).toBeNull();

    // No branch anywhere treats it differently. It is scanned and decomposed
    // by the ordinary rules, and it would be retired by them too.
    const plan = await planFrom(await graphSnapshot(projectId));
    const mine = plan.asks.filter((one) => one.nodeId === seed.node.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(['SCAN', 'MAP']).toContain(mine[0]!.purpose);

    // Seeding is idempotent, and naming something Brain already found does not
    // rewrite how Brain came to know about it.
    const again = await seedSubject({
      projectId,
      name: 'Animation and anime production',
      actorRef: userId,
    });
    expect(again.created).toBe(false);
    expect(again.node.id).toBe(seed.node.id);
    expect((await listNodes(projectId)).filter((one) => one.parentId === null)).toHaveLength(1);
  });

  it('spends nothing and starts nothing by itself', async () => {
    await activated();
    const before = (await listOpportunities({ projectId })).length;
    await seedSubject({ projectId, name: 'Animation and anime production', actorRef: userId });
    // A row. No mission, no orchestration, no opening — the allocator decides
    // when the subject is asked about and the grant decides whether it may run.
    expect((await listIndustryRounds(projectId))).toHaveLength(0);
    expect((await listOpportunities({ projectId })).length).toBe(before);
  });
});
