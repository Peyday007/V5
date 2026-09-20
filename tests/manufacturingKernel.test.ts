/**
 * The manufacturing empire kernel: what to build next, and what building it
 * would make possible.
 *
 * ---------------------------------------------------------------------------
 * What this pins, and why each one is a property rather than an example
 * ---------------------------------------------------------------------------
 *
 * **A capability a product teaches is never a capability this company holds.**
 * The rule the whole kernel rests on. Research can establish that producing
 * motorcycles requires chassis engineering and that producing ATVs develops it;
 * nothing research establishes may say this company has either. So the tests
 * that matter here are the ones that drive a full, well-sourced, gated research
 * round through the real path and then assert that **nothing is held**.
 *
 * **Demand pulls manufacturing.** A category with every engineering fact
 * established and nobody established to be buying can never read ENTER, and a
 * category nobody has researched cannot either. The second is the subtle one:
 * `requires.every(held)` is true of the empty set, so an unexamined category
 * would otherwise report that this company already has everything it needs.
 *
 * **The ladder is discovered.** There is no list of machine categories in the
 * repository, and the first assertion reads the source to prove it — the
 * brief's own six levels are an example sequence it explicitly refuses to
 * mandate.
 *
 * **A finding is declared, never read out of prose.** The same repair
 * `opportunity_signal` and `structural_finding` already made, one axis along,
 * so the tests that matter are the refusals.
 *
 * **What can be derived is not stored.** The readings, the verdicts, the
 * capability chain and the plan are all computed from rows, so a change in the
 * rows changes them with nothing having to notice.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listEvents } from '../server/repos/events.ts';
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
import {
  getCapability,
  getProgram,
  listCapabilities,
  listCategories,
  listCategoryEvidence,
  listEdges,
  listManufacturingRounds,
} from '../server/repos/manufacturing.ts';
import { liveGoalNamed } from '../server/repos/russellAuthority.ts';
import { validateCapabilityFinding, capabilitySlug } from '../server/domain/manufacturing.ts';
import {
  MANUFACTURING_AUTHORITY_NAME,
  moveProgramme,
  startProgramme,
} from '../server/services/manufacturing/program.ts';
import { ladderSnapshot } from '../server/services/manufacturing/ladder.ts';
import { readLadder, bridgesTo, ENTRY_VERDICTS } from '../server/services/manufacturing/readiness.ts';
import { allocate, MAX_OPEN_PROGRAMME_ROUNDS } from '../server/services/manufacturing/allocate.ts';
import { planFrom, runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import {
  declareHeld,
  retireCategoryDecision,
  seedCategory,
  withdrawHeld,
} from '../server/services/manufacturing/declare.ts';
import { programmeView, VERDICT_ORDER } from '../server/services/manufacturing/view.ts';
import { findTool } from '../server/mcp/tools.ts';
import { CAPABILITY_FINDINGS } from '../server/domain/types.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import type { CapabilityFinding, Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

const OBJECTIVE =
  'Build the capability to manufacture progressively harder machines, beginning from powered ' +
  'equipment and following demand rather than ambition.';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `machines-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
});

async function started(): Promise<void> {
  const outcome = await startProgramme({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: OBJECTIVE,
  });
  expect(outcome.ok).toBe(true);
}

interface DeclaredClaim {
  claim: string;
  finding: CapabilityFinding;
  subject: string;
  observedOn?: string;
  accepted?: boolean;
}

/**
 * A finished mission for one programme round, carrying declared findings.
 *
 * Built from the real repositories rather than from a stub, because the thing
 * under test is which rows the absorption reads: a fixture that handed it
 * findings directly would pass against an absorption that read prose.
 */
async function finishedRound(input: {
  candidateId: string;
  claims: DeclaredClaim[];
  /**
   * Leave the mission RUNNING, so the claims are filed and the round is not
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
    prompt: 'a programme round',
  });
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
      requiredEvidence: [
        { id: 'requires', description: 'what producing needs', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a regulator’s published requirement'],
      excludedSourceTypes: ['a capability asserted with no source'],
      completionCriteria: ['every finding declared on its claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'machine-capability',
      question: 'What does producing this require?',
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
      sourceUrl: 'https://example.test/trade-body/shipments',
      sourceTitle: 'A trade body statistic',
      sourcePublisher: 'A trade association',
      sourceDate: '2026-09-10',
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the table body',
      evidenceLane: 'requires',
      capabilityFinding: one.finding,
      capabilitySubject: one.subject,
      capabilityObservedOn: one.observedOn ?? null,
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.subject}|${one.finding}`,
    })),
  );
  for (const [index, claim] of inserted.entries()) {
    await decideClaim(claim.id, { accepted: input.claims[index]!.accepted ?? true });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a programme round',
    whyNow: 'the programme is active',
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
  const missions = await listMissions({ projectId });
  const mission = missions.find((one) => one.candidateId === candidateId);
  expect(mission, 'no mission for that candidate').toBeTruthy();
  await transitionMission({ missionId: mission!.id, from: 'RUNNING', to: 'DONE' });
}

/** The candidate a round of this purpose is asking, if one is open. */
async function candidateFor(purpose: string, categoryId?: string): Promise<string | null> {
  const program = await getProgram(projectId);
  if (!program) return null;
  const rounds = await listManufacturingRounds(program.id);
  const round = rounds.find(
    (one) =>
      one.purpose === purpose &&
      one.state === 'OPEN' &&
      (categoryId === undefined || one.categoryId === categoryId),
  );
  return round?.candidateId ?? null;
}

async function categoryNamed(name: string): Promise<string> {
  const program = await getProgram(projectId);
  const all = await listCategories(program!.id);
  const found = all.find((one) => one.name === name);
  expect(found, `no category named ${name}`).toBeTruthy();
  return found!.id;
}

/**
 * Drive a category all the way to enterable: buyers, a route, one requirement,
 * and that requirement declared held by a person.
 *
 * Used by more than one test, and deliberately goes through the real path for
 * every step — the research through gated claims, the holding through
 * `declareHeld` — because the property under test is precisely that the last
 * step cannot be reached by the first three.
 */
async function drivenToEnterable(name: string): Promise<string> {
  await started();
  const seeded = await seedCategory({
    projectId,
    name,
    actorRef: userId,
  });
  expect('category' in seeded).toBe(true);
  const categoryId = (seeded as { category: { id: string } }).category.id;

  await runManufacturingKernel(projectId);
  const demand = await candidateFor('DEMAND', categoryId);
  expect(demand).toBeTruthy();
  await finishedRound({
    candidateId: demand!,
    claims: [
      {
        claim: 'The association reported 41,800 units shipped in the year to June.',
        finding: 'DEMAND_EVIDENCE',
        subject: 'UNIT_SHIPMENTS',
        observedOn: '2026-06-30',
      },
      {
        claim: 'Machines of this kind reach contractors through a franchised dealer network.',
        finding: 'DISTRIBUTION_CHANNEL',
        subject: 'DEALER_NETWORK',
      },
    ],
  });
  await runManufacturingKernel(projectId);

  const capability = await candidateFor('CAPABILITY', categoryId);
  expect(capability).toBeTruthy();
  await finishedRound({
    candidateId: capability!,
    claims: [
      {
        claim: 'Producers must be able to integrate a small engine with a pump and a frame.',
        finding: 'CAPABILITY_REQUIRED',
        subject: 'small engine integration',
      },
    ],
  });
  await runManufacturingKernel(projectId);
  return categoryId;
}

// ---------------------------------------------------------------------------

describe('a capability a product teaches is not a capability we hold', () => {
  /**
   * The assertion the whole kernel rests on, driven end to end.
   *
   * Every step here is the real path: the round is opened by the allocator, the
   * claims go in through `insertClaims` and are gated by `decideClaim`, and the
   * absorption reads the declarations from the rows. The point is what does
   * *not* happen at the end of it.
   */
  it('files everything a gated round established and holds nothing', async () => {
    await started();
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    await runManufacturingKernel(projectId);

    const demand = await candidateFor('DEMAND');
    await finishedRound({
      candidateId: demand!,
      claims: [
        {
          claim: 'The association reported 41,800 units shipped in the year to June.',
          finding: 'DEMAND_EVIDENCE',
          subject: 'UNIT_SHIPMENTS',
          observedOn: '2026-06-30',
        },
        {
          claim: 'They reach contractors through franchised dealers.',
          finding: 'DISTRIBUTION_CHANNEL',
          subject: 'DEALER_NETWORK',
        },
      ],
    });
    await runManufacturingKernel(projectId);

    const capability = await candidateFor('CAPABILITY');
    await finishedRound({
      candidateId: capability!,
      claims: [
        {
          claim: 'Producing one requires integrating a small engine with a pump and a frame.',
          finding: 'CAPABILITY_REQUIRED',
          subject: 'small engine integration',
        },
        {
          claim: 'Producing at this level develops high-pressure pump assembly.',
          finding: 'CAPABILITY_TAUGHT',
          subject: 'high pressure pump assembly',
        },
        {
          claim: 'Units sold in this market must carry a recognised safety certification.',
          finding: 'ENTRY_BARRIER',
          subject: 'SAFETY_CERTIFICATION',
        },
      ],
    });
    await runManufacturingKernel(projectId);

    const program = await getProgram(projectId);
    const capabilities = await listCapabilities(program!.id);
    const edges = await listEdges(program!.id);

    // Everything arrived...
    expect(capabilities.map((one) => one.name).sort()).toEqual([
      'high pressure pump assembly',
      'small engine integration',
    ]);
    expect(edges.map((one) => one.relation).sort()).toEqual(['REQUIRES', 'TEACHES']);
    expect((await listCategoryEvidence(program!.id)).map((one) => one.kind).sort()).toEqual([
      'DEMAND_EVIDENCE',
      'DISTRIBUTION_CHANNEL',
      'ENTRY_BARRIER',
    ]);

    // ...and not one capability is held.
    expect(capabilities.every((one) => one.heldAt === null)).toBe(true);
    expect(capabilities.every((one) => one.heldEvidence === null)).toBe(true);
  });

  /**
   * And the structural half of it: the module that files research does not
   * import the one that records a holding.
   *
   * A behavioural test can show that today's code does not do it; reading the
   * source shows that there is no parameter, branch or value that *could*.
   * `tests/operatorConsoleRemoved.test.ts` reads the repository for the same
   * reason — what must not exist is not something behaviour can see.
   */
  it('has no route from absorbing research to recording a holding', () => {
    // Comments stripped first, deliberately. `expand.ts` *says* in prose that
    // it does not import the holding writer, and that sentence is the record of
    // why — this repository keeps its own reasoning. What must not exist is the
    // call, so the assertion is about code.
    const expand = readFileSync('server/services/manufacturing/expand.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(expand).not.toContain('declareCapabilityHeld');
    expect(expand).not.toContain('heldEvidence');

    // And the only writer of the column takes an actor and an evidence kind,
    // neither of which anything on the research path has.
    const repo = readFileSync('server/repos/manufacturing.ts', 'utf8');
    expect(repo).toContain('export async function declareCapabilityHeld');
    const ensure = repo.slice(
      repo.indexOf('export async function ensureCapability'),
      repo.indexOf('export async function listCapabilities'),
    );
    expect(ensure).not.toContain('held_at = ?');
  });

  it('records a holding only from a person, with what they said', async () => {
    await started();
    const outcome = await declareHeld({
      projectId,
      name: 'small engine integration',
      note: 'We hired two engine engineers in March and they have shipped a running prototype.',
      actorRef: userId,
    });
    expect('capability' in outcome).toBe(true);
    const capability = (outcome as { capability: { id: string } }).capability;
    const after = await getCapability(capability.id);
    expect(after!.heldEvidence).toBe('DECLARED');
    expect(after!.heldBy).toBe(userId);
    expect(after!.heldNote).toContain('hired two engine engineers');
  });

  it('refuses to record a holding with no stated reason', async () => {
    await started();
    const outcome = await declareHeld({
      projectId,
      name: 'chassis engineering',
      note: '   ',
      actorRef: userId,
    });
    expect('error' in outcome).toBe(true);
    expect((outcome as { error: string }).error).toContain('records how it came to');
  });

  it('lets a person withdraw what a person declared, and keeps the capability', async () => {
    await started();
    const held = await declareHeld({
      projectId,
      name: 'chassis engineering',
      note: 'An acquisition we have since unwound.',
      actorRef: userId,
    });
    const id = (held as { capability: { id: string } }).capability.id;

    const after = await withdrawHeld({
      projectId,
      capabilityId: id,
      reason: 'The acquisition fell through.',
      actorRef: userId,
    });
    expect('heldAt' in after && after.heldAt).toBe(null);
    // The row survives: a capability that stopped being held is still a
    // capability something requires.
    expect(await getCapability(id)).toBeTruthy();
  });
});

describe('demand pulls manufacturing, and an unknown is never a favourable assumption', () => {
  /**
   * The subtle one. `requires.every(held)` is true of the empty set, so a
   * category nobody has asked what it takes to build would otherwise report
   * that this company already holds everything it needs.
   */
  it('reads an unexamined category as UNKNOWN on every condition, never MET', async () => {
    await started();
    await seedCategory({ projectId, name: 'Business jets', actorRef: userId });

    const snapshot = await ladderSnapshot(projectId);
    const [reading] = readLadder(snapshot!);

    expect(reading!.verdict).toBe('UNEXAMINED');
    expect(reading!.conditions.map((one) => one.answer)).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
    ]);
    const held = reading!.conditions.find((one) => one.condition === 'CAPABILITIES_HELD');
    expect(held!.because).toContain('An empty list of requirements is not a list that is satisfied');
  });

  it('never reads ENTER for a category with every capability held and no buyers', async () => {
    await started();
    const seeded = await seedCategory({ projectId, name: 'Light aircraft', actorRef: userId });
    const categoryId = (seeded as { category: { id: string } }).category.id;

    await runManufacturingKernel(projectId);
    const capability = await candidateFor('CAPABILITY', categoryId) ?? (await candidateFor('DEMAND', categoryId));
    // The first question asked of an unexamined category is demand, always.
    const rounds = await listManufacturingRounds((await getProgram(projectId))!.id);
    expect(rounds.filter((one) => one.categoryId === categoryId).map((one) => one.purpose)).toEqual([
      'DEMAND',
    ]);

    // Answer it with nothing: the sources were asked and found no buyers.
    await finishedRound({ candidateId: capability!, claims: [] });
    await runManufacturingKernel(projectId);

    // Now hand the company every capability in the world.
    await declareHeld({
      projectId,
      name: 'airframe assembly',
      note: 'We bought an airframe shop.',
      actorRef: userId,
    });

    const snapshot = await ladderSnapshot(projectId);
    const reading = readLadder(snapshot!).find((one) => one.categoryId === categoryId);
    expect(reading!.verdict).toBe('NO_DEMAND_FOUND');
    expect(reading!.because).toContain('Manufacturing here would be looking for demand afterwards');
  });

  /**
   * Buyers and no published route is its own verdict, and the reason is the
   * remedy: "nobody is buying" is answered by looking elsewhere, and "nobody
   * has established how it reaches them" is answered by asking again. This
   * state used to fall through to INVESTIGATING, which said the category was
   * still being researched while its demand round had settled — a status that
   * contradicts the rows underneath it.
   */
  it('separates buyers-with-no-route from nobody-is-buying', async () => {
    await started();
    const seeded = await seedCategory({ projectId, name: 'Mining haul trucks', actorRef: userId });
    const categoryId = (seeded as { category: { id: string } }).category.id;

    await runManufacturingKernel(projectId);
    await finishedRound({
      candidateId: (await candidateFor('DEMAND', categoryId))!,
      claims: [
        {
          claim: 'A mine operator published a fleet purchase of eleven units.',
          finding: 'DEMAND_EVIDENCE',
          subject: 'FLEET_PURCHASE',
          observedOn: '2026-04-02',
        },
      ],
    });
    await runManufacturingKernel(projectId);

    const reading = readLadder((await ladderSnapshot(projectId))!).find(
      (one) => one.categoryId === categoryId,
    )!;
    expect(reading.verdict).toBe('NO_ROUTE_FOUND');
    expect(reading.because).toContain('nowhere to sell');
    // And the condition underneath says which of the two it is.
    const route = reading.conditions.find(
      (one) => one.condition === 'ROUTE_TO_BUYER_ESTABLISHED',
    )!;
    expect(route.answer).toBe('NOT_MET');
  });

  it('reaches ENTER only when all four conditions are met', async () => {
    const categoryId = await drivenToEnterable('Commercial pressure washers');

    let snapshot = await ladderSnapshot(projectId);
    let reading = readLadder(snapshot!).find((one) => one.categoryId === categoryId);
    // Buyers, a route and a known requirement — but the requirement is not held.
    expect(reading!.verdict).toBe('BUILD_CAPABILITY_FIRST');
    expect(reading!.missing.map((one) => one.capability.name)).toEqual(['small engine integration']);

    await declareHeld({
      projectId,
      name: 'small engine integration',
      note: 'Two engine engineers and a running prototype.',
      actorRef: userId,
    });

    snapshot = await ladderSnapshot(projectId);
    reading = readLadder(snapshot!).find((one) => one.categoryId === categoryId);
    expect(reading!.verdict).toBe('ENTER');
    expect(reading!.conditions.every((one) => one.answer === 'MET')).toBe(true);
  });

  /**
   * The derivation is not stored, so withdrawing a holding moves the verdict
   * back with nothing having to notice.
   */
  it('moves the verdict back when a holding is withdrawn, with no recompute', async () => {
    const categoryId = await drivenToEnterable('Commercial pressure washers');
    const held = await declareHeld({
      projectId,
      name: 'small engine integration',
      note: 'A prototype that ran.',
      actorRef: userId,
    });
    const capabilityId = (held as { capability: { id: string } }).capability.id;

    expect(
      readLadder((await ladderSnapshot(projectId))!).find((one) => one.categoryId === categoryId)!
        .verdict,
    ).toBe('ENTER');

    await withdrawHeld({
      projectId,
      capabilityId,
      reason: 'The engineers left.',
      actorRef: userId,
    });

    expect(
      readLadder((await ladderSnapshot(projectId))!).find((one) => one.categoryId === categoryId)!
        .verdict,
    ).toBe('BUILD_CAPABILITY_FIRST');
  });
});

describe('the ladder is discovered, never declared', () => {
  /**
   * The brief's own six levels are an example sequence it explicitly refuses to
   * mandate, so encoding them would be encoding the one thing it says not to.
   * This reads the repository, for `operatorConsoleRemoved`'s reason.
   */
  it('holds no list of machine categories anywhere in the kernel', () => {
    const files = [
      'server/domain/manufacturing.ts',
      'server/services/manufacturing/allocate.ts',
      'server/services/manufacturing/questions.ts',
      'server/services/manufacturing/ladder.ts',
      'server/services/manufacturing/kernel.ts',
      'server/services/manufacturing/readiness.ts',
      'server/repos/manufacturing.ts',
    ];
    // Words from the brief's own example pyramid. Finding one in a *value*
    // would mean somebody had encoded the sequence the brief refuses to fix.
    const machines = /['"`][^'"`]*\b(pressure washer|motorcycle|excavator|business jet|ATV|UTV)/i;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(withoutComments, `${file} names a machine category`).not.toMatch(machines);
    }
  });

  it('asks the sources what exists before anything is on the ladder', async () => {
    await started();
    const pass = await runManufacturingKernel(projectId);
    expect(pass.opened.map((one) => one.purpose)).toEqual(['BOOTSTRAP']);
    expect(pass.opened[0]!.question).toContain('classification');
    expect(pass.opened[0]!.why).toContain('The ladder is empty');
  });

  it('files the categories a gated claim established, and nothing else', async () => {
    await started();
    await runManufacturingKernel(projectId);
    const candidate = await candidateFor('BOOTSTRAP');

    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'The association recognises commercial pressure washers as a category.',
          finding: 'PRODUCT_CATEGORY',
          subject: 'Commercial pressure washers',
        },
        {
          claim: 'It also recognises portable generators.',
          finding: 'PRODUCT_CATEGORY',
          subject: 'Portable generators',
        },
        {
          claim: 'The market for cleaning equipment is expected to grow.',
          finding: 'PRODUCT_CATEGORY',
          subject: 'Growth',
          accepted: false,
        },
      ],
    });
    await runManufacturingKernel(projectId);

    const names = (await listCategories((await getProgram(projectId))!.id)).map((one) => one.name);
    expect(names.sort()).toEqual(['Commercial pressure washers', 'Portable generators']);
  });
});

describe('a finding is declared, and the refusals are the point', () => {
  it('applies one rule at both doors, so the two cannot disagree', () => {
    const schema = readFileSync('server/services/research/schema.ts', 'utf8');
    const tools = readFileSync('server/mcp/researchTools.ts', 'utf8');
    expect(schema).toContain('validateCapabilityFinding');
    expect(tools).toContain('validateCapabilityFinding');
    // Neither reimplements the vocabulary.
    expect(schema).not.toContain("'CAPABILITY_REQUIRED'");
    expect(tools).not.toContain("=== 'CAPABILITY_REQUIRED'");
  });

  it('refuses a demand signal with no observation date', () => {
    const result = validateCapabilityFinding({
      where: 'claims[0]',
      finding: 'DEMAND_EVIDENCE',
      subject: 'UNIT_SHIPMENTS',
      observedOn: null,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('capability_observed_on');
  });

  it('refuses an observation date on a kind that has none', () => {
    const result = validateCapabilityFinding({
      where: 'claims[0]',
      finding: 'CAPABILITY_REQUIRED',
      subject: 'chassis engineering',
      observedOn: '2026-01-01',
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('carries no observation date');
  });

  it('refuses a subject outside a closed vocabulary, naming the set', () => {
    const result = validateCapabilityFinding({
      where: 'claims[0]',
      finding: 'ENTRY_BARRIER',
      subject: 'it is quite hard',
      observedOn: null,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('TYPE_APPROVAL_OR_HOMOLOGATION');
  });

  it('refuses a subject with no finding, rather than storing a value nothing reads', () => {
    const result = validateCapabilityFinding({
      where: 'claims[0]',
      finding: null,
      subject: 'chassis engineering',
      observedOn: null,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('with no capability_finding');
  });

  it('accepts a claim that declares nothing, which is most claims', () => {
    const result = validateCapabilityFinding({
      where: 'claims[0]',
      finding: null,
      subject: null,
      observedOn: null,
    });
    expect(result.ok).toBe(true);
  });

  /**
   * The defect §33 already paid for once, asserted structurally rather than by
   * string match.
   *
   * `brain_submit_claims` told a worker in its description to set
   * `opportunity_signal`, and the schema beside it declared
   * `additionalProperties: false` without that property. A client honouring the
   * schema drops the field; one honouring the prose sends what the schema
   * forbids. Either way the column that decides whether anything is created can
   * never be filled, and the failure reads exactly like a worker honestly
   * finding nothing.
   *
   * These three fields are the same shape one axis along, and one of them —
   * `capability_finding` — is what decides whether a category ever reaches the
   * ladder at all.
   */
  it('declares every capability field its own description tells a caller to set', () => {
    const tool = findTool('brain_submit_claims')!;
    const items = (tool.inputSchema as any).properties.claims.items;

    // The half that makes an omission fatal rather than merely untidy.
    expect(items.additionalProperties).toBe(false);

    for (const field of ['capability_finding', 'capability_subject', 'capability_observed_on']) {
      expect(tool.description, field).toContain(field);
      expect(items.properties[field], field).toBeTruthy();
    }
    expect(items.properties.capability_finding.enum).toEqual([...CAPABILITY_FINDINGS]);
  });
});

describe('the capability chain', () => {
  /**
   * The brief's *"think in capability chains"* as a derivation: everything that
   * teaches what a target requires is a predecessor of it, and there can be
   * several — which is why this is an edge table and not a parent pointer.
   */
  it('names the categories that would supply what a target is missing', async () => {
    await started();
    const washers = await seedCategory({
      projectId,
      name: 'Commercial pressure washers',
      actorRef: userId,
    });
    const bikes = await seedCategory({ projectId, name: 'Motorcycles', actorRef: userId });
    const washerId = (washers as { category: { id: string } }).category.id;
    const bikeId = (bikes as { category: { id: string } }).category.id;

    // Two rounds, one per category, each declaring one half of the chain.
    await runManufacturingKernel(projectId);
    for (const [categoryId, claims] of [
      [
        washerId,
        [
          {
            claim: 'Producing these develops small engine integration.',
            finding: 'CAPABILITY_TAUGHT' as const,
            subject: 'small engine integration',
          },
        ],
      ],
      [
        bikeId,
        [
          {
            claim: 'Producing these requires small engine integration.',
            finding: 'CAPABILITY_REQUIRED' as const,
            subject: 'Small Engine Integration',
          },
        ],
      ],
    ] as const) {
      const candidate = await candidateFor('DEMAND', categoryId as string);
      await finishedRound({
        candidateId: candidate!,
        claims: [...claims],
      });
    }
    await runManufacturingKernel(projectId);

    // The two rounds spelled it differently, and the chain is joined anyway:
    // the slug is the identity, and the first spelling to arrive is the one a
    // reader sees. One capability, not two.
    expect(await listCapabilities((await getProgram(projectId))!.id)).toHaveLength(1);

    const readings = readLadder((await ladderSnapshot(projectId))!);
    const bike = readings.find((one) => one.categoryId === bikeId)!;
    expect(bike.missing.map((one) => one.capability.name)).toEqual(['small engine integration']);

    const bridges = bridgesTo(bike, readings);
    expect(bridges.map((one) => one.category.name)).toEqual(['Commercial pressure washers']);
    expect(bridges[0]!.supplies.map((one) => one.name)).toEqual(['small engine integration']);
  });

  /**
   * Two spellings of one capability are one capability, because the identity is
   * a deterministic reduction rather than a judgement. Two *different* names
   * stay two, which is the honest limit rather than an oversight: joining them
   * needs a reader, and a guess would weld together two chains that are not the
   * same chain.
   */
  it('joins two spellings of one capability and never two names of two', () => {
    expect(capabilitySlug('Chassis Engineering')).toBe(capabilitySlug('chassis  engineering'));
    expect(capabilitySlug('chassis engineering')).not.toBe(capabilitySlug('frame design'));
  });

  it('excludes a retired category from the chain, because a killed path is not a route', async () => {
    await started();
    const washers = await seedCategory({
      projectId,
      name: 'Commercial pressure washers',
      actorRef: userId,
    });
    const bikes = await seedCategory({ projectId, name: 'Motorcycles', actorRef: userId });
    const washerId = (washers as { category: { id: string } }).category.id;
    const bikeId = (bikes as { category: { id: string } }).category.id;

    await runManufacturingKernel(projectId);
    await finishedRound({
      candidateId: (await candidateFor('DEMAND', washerId))!,
      claims: [
        {
          claim: 'Producing these develops small engine integration.',
          finding: 'CAPABILITY_TAUGHT',
          subject: 'small engine integration',
        },
      ],
    });
    await finishedRound({
      candidateId: (await candidateFor('DEMAND', bikeId))!,
      claims: [
        {
          claim: 'Producing these requires small engine integration.',
          finding: 'CAPABILITY_REQUIRED',
          subject: 'small engine integration',
        },
      ],
    });
    await runManufacturingKernel(projectId);

    await retireCategoryDecision({
      projectId,
      categoryId: washerId,
      reason: 'The owner decided not to enter cleaning equipment.',
      actorRef: userId,
    });

    const readings = readLadder((await ladderSnapshot(projectId))!);
    const bike = readings.find((one) => one.categoryId === bikeId)!;
    expect(bridgesTo(bike, readings)).toEqual([]);
    // And the retired row is still there, with its reason.
    const all = await listCategories((await getProgram(projectId))!.id);
    expect(all.find((one) => one.id === washerId)!.retiredReason).toContain('not to enter');
  });
});

describe('what the allocator asks, and in what order', () => {
  it('asks demand before capability for a category nobody has examined', async () => {
    await started();
    await seedCategory({ projectId, name: 'Utility vehicles', actorRef: userId });
    const snapshot = await ladderSnapshot(projectId);
    const plan = allocate({ snapshot: snapshot!, slots: 5 });
    // The bootstrap and the demand question, and nothing about capability.
    expect(plan.asks.map((one) => one.purpose).sort()).toEqual(['BOOTSTRAP', 'DEMAND']);
  });

  it('is a pure decision over a snapshot, so the same input gives the same plan', async () => {
    await started();
    await seedCategory({ projectId, name: 'Utility vehicles', actorRef: userId });
    const snapshot = await ladderSnapshot(projectId);
    const first = allocate({ snapshot: snapshot!, slots: 3 });
    const second = allocate({ snapshot: snapshot!, slots: 3 });
    expect(second).toEqual(first);
  });

  it('asks one question per category per pass, so breadth is not starved', async () => {
    const categoryId = await drivenToEnterable('Commercial pressure washers');
    const snapshot = await ladderSnapshot(projectId);
    const plan = planFrom(snapshot!);
    const forThis = plan.asks.filter((one) => one.categoryId === categoryId);
    expect(forThis.length).toBeLessThanOrEqual(1);
    expect(plan.asks.length).toBeLessThanOrEqual(MAX_OPEN_PROGRAMME_ROUNDS);
  });

  it('names what it declined and why, in words a person can read', async () => {
    await started();
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await seedCategory({ projectId, name: `Category ${name}`, actorRef: userId });
    }
    const snapshot = await ladderSnapshot(projectId);
    const plan = allocate({ snapshot: snapshot!, slots: 2 });
    expect(plan.asks).toHaveLength(2);
    expect(plan.declined.length).toBeGreaterThan(0);
    for (const one of plan.declined) {
      expect(one.subject).not.toMatch(/^mcat_/);
      expect(one.why.length).toBeGreaterThan(10);
    }
  });
});

describe('it is an entrance, not a second pipeline', () => {
  it('creates a Russell candidate and nothing that bypasses the pipeline', async () => {
    await started();
    await runManufacturingKernel(projectId);
    const candidates = await listCandidates({ projectId });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.state).toBe('CAPTURED');
  });

  it('routes each purpose to its own reviewed envelope and profile', () => {
    for (const envelopeId of [
      'RUSSELL_MACHINE_LADDER_V1',
      'RUSSELL_MACHINE_DEMAND_V1',
      'RUSSELL_MACHINE_CAPABILITY_V1',
    ]) {
      const envelope = getApprovalEnvelope(envelopeId);
      expect(envelope, envelopeId).toBeTruthy();
      // Nothing here authorizes an external effect.
      expect(envelope!.forbiddenActions.test('purchase')).toBe(true);
      expect(profileFor(envelopeId), envelopeId).toBeTruthy();
    }
  });

  it('asks the demand question first among the three, by launch ordinal', () => {
    const demand = profileFor('RUSSELL_MACHINE_DEMAND_V1')!;
    const capability = profileFor('RUSSELL_MACHINE_CAPABILITY_V1')!;
    const ladder = profileFor('RUSSELL_MACHINE_LADDER_V1')!;
    expect(demand.launchOrdinal).toBeLessThan(capability.launchOrdinal);
    expect(capability.launchOrdinal).toBeLessThan(ladder.launchOrdinal);
  });

  it('keeps filing what already ran after the programme is paused', async () => {
    await started();
    await runManufacturingKernel(projectId);
    const candidate = await candidateFor('BOOTSTRAP');
    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'The association recognises portable generators.',
          finding: 'PRODUCT_CATEGORY',
          subject: 'Portable generators',
        },
      ],
    });

    await moveProgramme({ projectId, actorUserId: userId, to: 'PAUSED' });
    const pass = await runManufacturingKernel(projectId);

    // Filed, because the spending already happened...
    expect(pass.absorbed.categories.map((one) => one.name)).toEqual(['Portable generators']);
    // ...and nothing new was opened.
    expect(pass.opened).toHaveLength(0);
    expect(pass.declined[0]!.why).toContain('paused');
  });
});

describe('the programme is not a cash sprint', () => {
  it('runs on a project with no cash mode at all', async () => {
    await started();
    const pass = await runManufacturingKernel(projectId);
    expect(pass.opened).toHaveLength(1);
  });

  it('writes a research grant that authorizes reading and nothing else', async () => {
    await started();
    const goal = await liveGoalNamed(projectId, MANUFACTURING_AUTHORITY_NAME);
    expect(goal).toBeTruthy();
    expect(goal!.allowedWork).toEqual(['RESEARCH']);
    expect(goal!.maxExternalSpend).toBe(0);
    for (const prohibition of ['NEW_SPENDING', 'PURCHASE', 'CONTACT_PERSON']) {
      expect(goal!.prohibitions).toContain(prohibition);
    }
  });

  it('withdraws the grant when the programme is archived, and rewrites it on resume', async () => {
    await started();
    await moveProgramme({ projectId, actorUserId: userId, to: 'ARCHIVED', reason: 'Not now.' });
    expect(await liveGoalNamed(projectId, MANUFACTURING_AUTHORITY_NAME)).toBeNull();

    await moveProgramme({ projectId, actorUserId: userId, to: 'ACTIVE' });
    expect(await liveGoalNamed(projectId, MANUFACTURING_AUTHORITY_NAME)).toBeTruthy();
  });
});

describe('persistence, idempotency and the record', () => {
  it('produces one round and one category however many times the tick runs', async () => {
    await started();
    await runManufacturingKernel(projectId);
    await runManufacturingKernel(projectId);
    await runManufacturingKernel(projectId);
    const program = await getProgram(projectId);
    expect(await listManufacturingRounds(program!.id)).toHaveLength(1);

    const candidate = await candidateFor('BOOTSTRAP');
    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'The association recognises portable generators.',
          finding: 'PRODUCT_CATEGORY',
          subject: 'Portable generators',
        },
      ],
    });
    await runManufacturingKernel(projectId);
    await runManufacturingKernel(projectId);
    expect(
      (await listCategories(program!.id)).filter((one) => one.name === 'Portable generators'),
    ).toHaveLength(1);
  });

  it('carries the reason a question was opened onto the project history', async () => {
    await started();
    await runManufacturingKernel(projectId);
    const events = await listEvents(projectId);
    const opened = events.find((one) => one.eventType === 'MANUFACTURING_ROUND_OPENED');
    expect(opened).toBeTruthy();
    expect(String(opened!.payload['why'])).toContain('The ladder is empty');
  });

  it('records a holding on the project history, with the evidence kind', async () => {
    await started();
    await declareHeld({
      projectId,
      name: 'small engine integration',
      note: 'Two engineers and a prototype.',
      actorRef: userId,
    });
    const events = await listEvents(projectId);
    const held = events.find((one) => one.eventType === 'MANUFACTURING_CAPABILITY_HELD');
    expect(held).toBeTruthy();
    expect(held!.payload['evidence']).toBe('DECLARED');
  });

  /**
   * The crash window between filing and settling, which a tally gets wrong.
   *
   * `absorb` used to count what *this pass wrote*. That is correct only while
   * every pass that absorbs a round also closes it — and a tick that dies in
   * between leaves the claims filed and the round OPEN, so the next pass writes
   * nothing (every insert conflicts), counts zero, and records a round that
   * established two things as having established none.
   *
   * `found` is what barrenness is decided against, so that reads as a category
   * nobody should look at again. Simulated here by absorbing twice and settling
   * on the second, which is exactly the state the dead tick leaves behind.
   */
  it('records what a round established even when a pass already filed it', async () => {
    await started();
    await runManufacturingKernel(projectId);
    const candidate = await candidateFor('BOOTSTRAP');

    await finishedRound({
      candidateId: candidate!,
      leaveRunning: true,
      claims: [
        {
          claim: 'The association recognises portable generators.',
          finding: 'PRODUCT_CATEGORY',
          subject: 'Portable generators',
        },
        {
          claim: 'It also recognises air compressors.',
          finding: 'PRODUCT_CATEGORY',
          subject: 'Air compressors',
        },
      ],
    });

    // The pass that files them. The mission is still running, so the round
    // stays OPEN — which is the state a tick that died in between leaves.
    const first = await runManufacturingKernel(projectId);
    expect(first.absorbed.categories).toHaveLength(2);
    expect(first.absorbed.settled).toHaveLength(0);

    // The pass that settles it. It files nothing, because every insert now
    // conflicts — and a tally of what *this* pass wrote would read zero.
    await finishMissionFor(candidate!);
    const second = await runManufacturingKernel(projectId);
    expect(second.absorbed.categories).toHaveLength(0);

    const program = await getProgram(projectId);
    const bootstrap = (await listManufacturingRounds(program!.id)).find(
      (one) => one.purpose === 'BOOTSTRAP',
    )!;
    expect(bootstrap.state).toBe('HARVESTED');
    // Two, not zero: the count comes from the claims rather than from which
    // pass happened to win the insert.
    expect(bootstrap.found).toBe(2);
  });

  it('settles a barren round as nothing found rather than leaving it open', async () => {
    await started();
    await runManufacturingKernel(projectId);
    const candidate = await candidateFor('BOOTSTRAP');
    await finishedRound({ candidateId: candidate!, claims: [] });
    await runManufacturingKernel(projectId);

    const rounds = await listManufacturingRounds((await getProgram(projectId))!.id);
    const bootstrap = rounds.find((one) => one.purpose === 'BOOTSTRAP')!;
    expect(bootstrap.state).toBe('HARVESTED');
    expect(bootstrap.found).toBe(0);
  });
});

describe('the view', () => {
  it('reports enterable as empty honestly, and names what would close the nearest gap', async () => {
    const categoryId = await drivenToEnterable('Commercial pressure washers');
    const view = await programmeView(projectId);
    expect(view!.enterable).toEqual([]);
    expect(view!.next[0]!.reading.categoryId).toBe(categoryId);
    expect(view!.counts.capabilitiesHeld).toBe(0);
    expect(view!.counts.capabilities).toBe(1);
  });

  it('performs no effect: reading the programme creates nothing', async () => {
    const categoryId = await drivenToEnterable('Commercial pressure washers');
    const program = await getProgram(projectId);
    const before = {
      rounds: (await listManufacturingRounds(program!.id)).length,
      categories: (await listCategories(program!.id)).length,
      capabilities: (await listCapabilities(program!.id)).length,
      candidates: (await listCandidates({ projectId })).length,
    };

    await programmeView(projectId);
    await programmeView(projectId);

    expect({
      rounds: (await listManufacturingRounds(program!.id)).length,
      categories: (await listCategories(program!.id)).length,
      capabilities: (await listCapabilities(program!.id)).length,
      candidates: (await listCandidates({ projectId })).length,
    }).toEqual(before);
    expect(categoryId).toBeTruthy();
  });
});

describe('the dangerous boundaries', () => {
  /**
   * A verdict added later cannot slip past the ordering.
   *
   * `VERDICT_ORDER` is a `Record` over the union, so an unnamed verdict is a
   * compile error — and this asserts it at runtime too, because a `as` cast
   * anywhere would defeat the type and `indexOf` on an array would have sorted
   * the unnamed one silently to the top, which is where a reader looks first.
   */
  it('ranks every verdict explicitly, with none falling through', () => {
    expect(Object.keys(VERDICT_ORDER).sort()).toEqual([...ENTRY_VERDICTS].sort());
    const ranks = Object.values(VERDICT_ORDER);
    expect(new Set(ranks).size).toBe(ranks.length);
    // ENTER is what a reader is looking for, so it is first.
    expect(VERDICT_ORDER.ENTER).toBe(Math.min(...ranks));
  });

  /**
   * Replaying the same declarations changes nothing.
   *
   * The queue is at-least-once, so a redelivered submission, a retried tick and
   * a restart mid-absorb all have to land on the same rows. The arbiter is the
   * unique index rather than anything this pass remembers.
   */
  it('files one row however many times the same finding is absorbed', async () => {
    await started();
    await seedCategory({ projectId, name: 'Utility vehicles', actorRef: userId });
    await runManufacturingKernel(projectId);
    const candidate = await candidateFor('DEMAND');
    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'A fleet operator published a purchase of eleven units.',
          finding: 'DEMAND_EVIDENCE',
          subject: 'FLEET_PURCHASE',
          observedOn: '2026-04-02',
        },
      ],
    });

    const program = await getProgram(projectId);
    for (let i = 0; i < 4; i += 1) await runManufacturingKernel(projectId);

    const evidence = await listCategoryEvidence(program!.id);
    expect(evidence.filter((one) => one.kind === 'DEMAND_EVIDENCE')).toHaveLength(1);
    // And the round's own record of what it produced does not drift either.
    const round = (await listManufacturingRounds(program!.id)).find(
      (one) => one.purpose === 'DEMAND' && one.state === 'HARVESTED',
    )!;
    expect(round.found).toBe(1);
  });

  /**
   * A paused programme re-arms when it is resumed, and not for anything else.
   *
   * The half that matters is the second: a deferral that cleared on any change
   * at all would wake work whose condition still holds, which is the "fire
   * spent on work nobody can do" §27 corrects one system along.
   */
  it('re-arms from the state change that actually answers it, and not from noise', async () => {
    await started();
    await seedCategory({ projectId, name: 'Utility vehicles', actorRef: userId });
    await moveProgramme({ projectId, actorUserId: userId, to: 'PAUSED' });

    const paused = await runManufacturingKernel(projectId);
    expect(paused.opened).toHaveLength(0);

    // Something unrelated changes: another category is named. Still paused.
    await seedCategory({ projectId, name: 'Compact loaders', actorRef: userId });
    const stillPaused = await runManufacturingKernel(projectId);
    expect(stillPaused.opened).toHaveLength(0);
    expect(stillPaused.declined[0]!.why).toContain('paused');

    // The one change that answers it.
    await moveProgramme({ projectId, actorUserId: userId, to: 'ACTIVE' });
    const resumed = await runManufacturingKernel(projectId);
    expect(resumed.opened.length).toBeGreaterThan(0);
  });

  /**
   * Nothing a worker can send marks a capability held — including a claim that
   * says so in as many words.
   *
   * The vocabulary has no value for it, so the submission is refused at the
   * door rather than stored and ignored. Refused is what lets the worker
   * correct it; stored-and-ignored is what looks like success.
   */
  it('has no declaration a worker could use to claim a capability is held', () => {
    for (const invented of ['CAPABILITY_HELD', 'CAPABILITY_ACQUIRED', 'RESEARCHED']) {
      const result = validateCapabilityFinding({
        where: 'claims[0]',
        finding: invented,
        subject: 'chassis engineering',
        observedOn: null,
      });
      expect(result.ok, invented).toBe(false);
    }
    // And the closed set itself contains no such value.
    expect(CAPABILITY_FINDINGS.some((one) => /HELD|ACQUIRED|HAVE/i.test(one))).toBe(false);
  });

  /**
   * Holding is attributed, and an unattributed one cannot be written.
   *
   * `held_at`, `held_evidence` and `held_by` move together or not at all — a
   * schema CHECK, not a convention — so a capability recorded as held for no
   * stated reason by nobody is not a row this database can hold.
   */
  it('records who said so and what they said, or records nothing', async () => {
    await started();
    const held = await declareHeld({
      projectId,
      name: 'chassis engineering',
      note: 'We acquired a frame shop in April.',
      actorRef: userId,
    });
    const capability = (held as { capability: { id: string } }).capability;
    const row = await getCapability(capability.id);
    expect(row!.heldAt).not.toBeNull();
    expect(row!.heldEvidence).toBe('DECLARED');
    expect(row!.heldBy).toBe(userId);
    expect(row!.heldNote).toContain('frame shop');
  });
});
