/**
 * A program that grows by releases, scheduled by when its work is wanted (§97).
 *
 * Pins: a release is appended after everything before it and every earlier
 * item keeps its id; the release's normative text must be mapped; an earlier
 * requirement cannot be dropped or redefined by a release; the same release
 * twice is one; started campaigns are kept, so nothing completed is submitted
 * again; campaigns enter the line most urgent first with their priority; a
 * prepared requirement waits until a live requirement depends on it, and is
 * then started without anyone naming it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, restartDatabase, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { ensureChangeRequest } from '../server/repos/factory.ts';
import { getProgram, listCampaignLinks } from '../server/repos/factoryProgram.ts';
import type { CampaignProgress, ProgramRequirement, RequirementCheck, RequirementMap } from '../server/domain/factoryProgram.ts';
import {
  amendProgram,
  approveProgram,
  readProgram,
  submitProgram,
  tickProgram,
  type CampaignSubmission,
  type ProgramPorts,
} from '../server/services/factory/program/coordinator.ts';
import { extractSourceItems, itemsMovedBy, programSource } from '../server/services/factory/program/spec.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';

let fixture: TestProject;
let approverId = '';

beforeEach(async () => {
  fixture = await freshProject();
  approverId = (
    await createUser({ email: `release-${Math.random().toString(36).slice(2, 10)}@test.local`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true })
  ).id;
});

afterEach(async () => {
  await teardown();
});

class Line implements ProgramPorts {
  submitted: string[] = [];
  queued = new Map<string, number>();
  keyOf = new Map<string, string>();
  live = new Set<string>();
  clock = Date.parse('2026-11-09T12:00:00.000Z');

  async submit(input: CampaignSubmission) {
    const { changeRequest } = await ensureChangeRequest({
      projectId: input.projectId,
      submissionKey: input.submissionKey,
      objective: input.objective,
      expectedOutcome: input.expectedOutcome,
      nonGoals: input.nonGoals,
      acceptanceConditions: input.acceptanceConditions.map((c, i) => ({ id: `A${String(i + 1).padStart(2, '0')}`, ...c, mandatory: true })),
      repository: input.repository,
      baseBranch: input.baseBranch,
      baseSha: 'deadbeef',
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: input.mutationScope,
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'revert',
      verificationCommands: ['npm test'],
    });
    this.submitted.push(input.submissionKey.split(':').at(-1)!);
    this.keyOf.set(changeRequest.id, input.submissionKey.split(':').at(-1)!);
    return { changeRequestId: changeRequest.id, riskClass: 'LOW' };
  }
  async queue(input: { changeRequestId: string; priority: number }) {
    this.queued.set(input.changeRequestId, input.priority);
  }
  async authorizeRelease() {}
  async riskOf() {
    return 'LOW';
  }
  async progressOf(changeRequestId: string): Promise<Omit<CampaignProgress, 'key'>> {
    const admitted = this.queued.has(changeRequestId);
    const live = this.live.has(changeRequestId);
    return { changeRequestId, campaignId: admitted ? `fc:${changeRequestId}` : null, outcome: admitted ? (live ? 'LIVE' : 'BUILDING') : null, delivered: live, needsPerson: false, blocker: null };
  }
  async verify(checks: RequirementCheck[]) {
    return { revision: 'rev1', checks: checks.map((c) => ({ check: c.kind, ok: true, detail: 'ok' })) };
  }
  revision() {
    return 'rev1';
  }
  now() {
    this.clock += 60_000;
    return new Date(this.clock);
  }
  priorityOf(campaignKey: string): number | undefined {
    for (const [id, key] of this.keyOf) if (key === campaignKey) return this.queued.get(id);
    return undefined;
  }
}

const SOURCE = `# Release 01

## A. Revenue

Brain must collect cash through an authorized offer.

## B. Research

Brain must ingest public feeds without a model call per record.

## C. Later

Brain should prepare a browser operator for sites without an API.
`;

const RELEASE_02 = `# Release 02

## D. Ventures

Brain must model a new venture's institutional prerequisites, and use the browser operator when a site has no API.
`;

function requirement(key: string, source: string[], over: Partial<ProgramRequirement> = {}): ProgramRequirement {
  return {
    key,
    kind: 'CAPABILITY',
    title: key,
    subsystem: key.toLowerCase(),
    source,
    quote: null,
    behavior: `${key} behaves as the source states.`,
    inputs: [],
    outputs: [],
    constraints: [],
    dependsOn: [],
    interactsWith: [],
    existing: null,
    missingWork: `Implement ${key}.`,
    paths: [`server/services/${key.toLowerCase()}.ts`],
    verification: [{ kind: 'BUNDLE_TEXT', text: `marker:${key}` }],
    ambiguities: [],
    ...over,
  };
}

function firstMap(): RequirementMap {
  const items = extractSourceItems(SOURCE);
  const id = (needle: string): string => items.find((i) => i.text.includes(needle))!.id;
  return {
    requirements: [
      requirement('CASH', [id('collect cash')], { priority: 'P0' }),
      requirement('FEEDS', [id('ingest public feeds')], { priority: 'P1' }),
      requirement('BROWSER', [id('browser operator')], { priority: 'P3', prepared: true }),
    ],
    context: [],
  };
}

async function submitAndApprove() {
  const submitted = await submitProgram({ projectId: fixture.project.id, title: 'Architecture', sourceText: SOURCE, map: firstMap(), repository: 'https://github.com/Peyday007/V5', baseBranch: 'production' });
  expect(submitted.map.errors).toEqual([]);
  expect(submitted.plan?.ok).toBe(true);
  const approved = await approveProgram({ programId: submitted.program.id, userId: approverId, autoRelease: false });
  expect(approved.ok).toBe(true);
  return submitted.program.id;
}

describe('a program scheduled by priority, with prepared capabilities', () => {
  it('queues the most urgent first with its priority and keeps a prepared capability out of the line', async () => {
    const programId = await submitAndApprove();
    const line = new Line();
    const report = await tickProgram(programId, line);
    expect(report.queued).toEqual(['cash-d0-p0', 'feeds-d0-p1']);
    expect(line.priorityOf('cash-d0-p0')).toBe(2);
    expect(line.priorityOf('feeds-d0-p1')).toBe(3);
    const reading = await readProgram(programId, line);
    const browser = reading.requirements.find((r) => r.key === 'BROWSER')!;
    expect(browser.status).toBe('MAPPED');
    expect(browser.reason).toMatch(/prepared/);
  });
});

describe('a program amended by a later release', () => {
  it('appends the release, keeps every earlier item and campaign, and promotes what the release needs', async () => {
    const programId = await submitAndApprove();
    const line = new Line();
    await tickProgram(programId, line);
    const before = extractSourceItems(SOURCE);

    // A release map that forgets the new text is refused, and the release is still recorded.
    const omitted = await amendProgram({ programId, title: 'Release 02', sourceText: RELEASE_02, map: firstMap(), actorType: 'PERSON', actorId: approverId });
    expect(omitted.amendment).toMatchObject({ number: 1, created: true });
    expect(omitted.version).toBeNull();
    expect(omitted.map.errors.map((e) => e.code)).toContain('OMITTED_REQUIREMENT');

    const program = (await getProgram(programId))!;
    const after = extractSourceItems(programSource(program));
    expect(itemsMovedBy(before, after)).toEqual([]);
    const ventureItem = after.slice(before.length).find((i) => i.text.includes('institutional prerequisites'))!;

    // A release may not drop what was approved.
    const dropped = structuredClone(firstMap());
    dropped.requirements = dropped.requirements.filter((r) => r.key !== 'FEEDS');
    dropped.requirements.push(requirement('VENTURE', [ventureItem.id], { priority: 'P2', dependsOn: ['BROWSER'] }));
    const refusedDrop = await amendProgram({ programId, title: 'Release 02', sourceText: RELEASE_02, map: dropped, actorType: 'PERSON', actorId: approverId });
    expect(refusedDrop.amendment).toMatchObject({ number: 1, created: false });
    expect(refusedDrop.map.errors.map((e) => e.code)).toContain('REQUIREMENT_DROPPED');

    // The additive map installs; the prepared browser operator is now needed and starts by itself.
    const full = structuredClone(firstMap());
    full.requirements.push(requirement('VENTURE', [ventureItem.id], { priority: 'P2', dependsOn: ['BROWSER'] }));
    const installed = await amendProgram({ programId, title: 'Release 02', sourceText: `${RELEASE_02}\n\n`, map: full, actorType: 'PERSON', actorId: approverId });
    expect(installed.amendment).toMatchObject({ number: 1, created: false });
    expect(installed.version).not.toBeNull();

    await restartDatabase();
    const second = await tickProgram(programId, line);
    expect(second.queued).toEqual(['browser-d0-p3-prep']);
    // Nothing that had started is submitted again.
    expect(line.submitted.filter((k) => k === 'cash-d0-p0')).toHaveLength(1);
    expect((await listCampaignLinks(programId)).map((l) => l.campaignKey).sort()).toEqual(['browser-d0-p3-prep', 'cash-d0-p0', 'feeds-d0-p1']);

    // The venture waits for the browser operator to be live, then starts.
    for (const [id, key] of line.keyOf) if (key === 'browser-d0-p3-prep') line.live.add(id);
    const third = await tickProgram(programId, line);
    expect(third.queued).toEqual(['venture-d1']);

    const intact = await getProbe('factory.program.source-intact')!({ program: programId, releases: 1 });
    expect(intact).toMatchObject({ ok: true });
    expect(intact.detail).toMatch(/1 release/);
  });

  it('refuses a release that would move earlier items', () => {
    const before = extractSourceItems(SOURCE);
    const shifted = extractSourceItems(`Preamble that was not there.\n\n${SOURCE}`);
    expect(itemsMovedBy(before, shifted).length).toBeGreaterThan(0);
  });
});

describe('the Brain architecture program, Release 01', () => {
  it('ships a map that accounts for every item of the verbatim source and a plan the gate accepts', async () => {
    const { readFileSync } = await import('node:fs');
    const { parseRequirementMap, validateRequirementMap } = await import('../server/services/factory/program/map.ts');
    const { deriveProgramPlan, validateProgramPlan } = await import('../server/services/factory/program/plan.ts');
    const { probeNames } = await import('../server/services/factory/program/probes.ts');
    const source = readFileSync('objectives/programs/brain-architecture/release-01.md', 'utf8');
    const map = parseRequirementMap(JSON.parse(readFileSync('objectives/programs/brain-architecture/release-01.map.json', 'utf8')));
    const items = extractSourceItems(source);
    expect(items.filter((i) => i.normative).length).toBeGreaterThan(400);
    const validation = validateRequirementMap(items, map);
    expect(validation.errors).toEqual([]);
    const plan = deriveProgramPlan(map);
    expect(validateProgramPlan(map, plan).errors).toEqual([]);
    // Every requirement written no code for is answered by a registered probe; the rest stay UNKNOWN until one is reviewed.
    const registered = new Set(probeNames());
    for (const key of plan.verifyOnly) {
      const r = map.requirements.find((x) => x.key === key)!;
      for (const check of r.verification) if (check.kind === 'PROBE') expect(registered.has(check.probe), check.probe).toBe(true);
    }
  });
});

describe('the research-throughput probe (CAP-16-3)', () => {
  it('fails while providers fail and passes once work is accepted again', async () => {
    const { recordBinEvent } = await import('../server/repos/bins.ts');
    const probe = getProbe('r01.cap-16-3')!;
    expect((await probe({ hours: 1 })).ok).toBe(false);
    for (let i = 0; i < 4; i += 1) await recordBinEvent({ eventType: 'FREE_LANE_ITEM', outcome: 'RELEASED_TRANSIENT', reason: 'model brain-a: model call failed: cheap lane HTTP 503', evidenceClass: 'MEASURED' });
    expect((await probe({ hours: 1 })).ok).toBe(false);
    for (let i = 0; i < 5; i += 1) await recordBinEvent({ eventType: 'FREE_LANE_ITEM', outcome: 'SUBMITTED', reason: 'model brain-a', evidenceClass: 'MEASURED' });
    const passing = await probe({ hours: 1 });
    expect(passing).toMatchObject({ ok: true });
    expect(passing.detail).toMatch(/5 accepted of 9/);
  });
});

describe('a campaign owns a test file of its own', () => {
  it('adds a unique tests/ path to every submitted campaign scope and says so in the objective', async () => {
    const programId = await submitAndApprove();
    const line = new Line();
    const seen: CampaignSubmission[] = [];
    const submit = line.submit.bind(line);
    line.submit = async (input: CampaignSubmission) => {
      seen.push(input);
      return submit(input);
    };
    await tickProgram(programId, line);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      const testPath = s.mutationScope.find((p) => p.startsWith('tests/program-'));
      expect(testPath).toMatch(/^tests\/program-[a-z0-9]{1,8}-[a-z0-9-]+\*\.test\.ts$/);
      expect(s.objective).toContain(testPath!);
    }
    expect(new Set(seen.map((s) => s.mutationScope.at(-1))).size).toBe(seen.length);
  });
});
