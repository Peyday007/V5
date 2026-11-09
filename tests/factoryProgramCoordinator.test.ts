/**
 * The program coordinator over real rows, against a simulated production (§96).
 *
 * The campaigns themselves are simulated — the existing machinery that runs one
 * campaign has its own suites — so what this pins is everything *between*
 * campaigns: a 126-requirement program approved once; independent campaigns
 * started together and dependent ones only after what they wait for is live;
 * the database restarted and a tick interrupted mid-step without anything
 * submitted twice or forgotten; a worker failure; existing functionality reused
 * and one false "existing" claim caught on production; a production failure
 * reopening a requirement, its dependents losing their verified status, one
 * repair opened (and resumed, not duplicated) until it holds; a discovered
 * dependency replanned; and DONE refused at every tick until the last
 * requirement passed on production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, restartDatabase, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { ensureChangeRequest } from '../server/repos/factory.ts';
import { listFactoryEvents } from '../server/repos/factoryFleet.ts';
import { getMap, getPlan, getProgram, listCampaignLinks } from '../server/repos/factoryProgram.ts';
import type { CampaignProgress, RequirementCheck } from '../server/domain/factoryProgram.ts';
import {
  approveProgram,
  proposeMap,
  readProgram,
  recordDiscoveredDependency,
  submitProgram,
  tickProgram,
  type CampaignSubmission,
  type ProgramPorts,
} from '../server/services/factory/program/coordinator.ts';
import { largeSpecification } from './fixtures/factoryProgramLarge.ts';

let fixture: TestProject;
let approverId = '';

beforeEach(async () => {
  fixture = await freshProject();
  approverId = (
    await createUser({ email: `program-${Math.random().toString(36).slice(2, 10)}@test.local`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true })
  ).id;
});

afterEach(async () => {
  await teardown();
});

/**
 * A simulated Factory and production: change requests become campaigns when the
 * test says so, a LIVE campaign's requirements behave unless marked broken, and
 * every deploy moves the production revision.
 */
class World implements ProgramPorts {
  submissions = new Map<string, CampaignSubmission>();
  byId = new Map<string, CampaignSubmission>();
  queued = new Set<string>();
  grants = new Map<string, number>();
  outcome = new Map<string, CampaignProgress['outcome']>();
  broken = new Set<string>();
  existingWorks = new Set<string>();
  revisionNo = 1;
  failQueueOnce = false;
  clock = Date.parse('2026-11-09T09:00:00.000Z');

  /** Real change-request rows, written the way the contract writes them, with no forge. */
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
    if (this.submissions.has(input.submissionKey)) throw new Error(`submitted twice: ${input.submissionKey}`);
    this.submissions.set(input.submissionKey, input);
    this.byId.set(changeRequest.id, input);
    this.keyOf.set(changeRequest.id, input.submissionKey.split(':').at(-1)!);
    return { changeRequestId: changeRequest.id, riskClass: 'LOW' };
  }
  keyOf = new Map<string, string>();
  async queue(input: { changeRequestId: string }) {
    if (this.failQueueOnce) {
      this.failQueueOnce = false;
      throw new Error('session interrupted between submit and queue');
    }
    this.queued.add(input.changeRequestId);
  }
  async authorizeRelease(input: { changeRequestId: string }) {
    this.grants.set(input.changeRequestId, (this.grants.get(input.changeRequestId) ?? 0) + 1);
  }
  async riskOf() {
    return 'LOW';
  }
  async progressOf(changeRequestId: string) {
    const outcome = this.outcome.get(changeRequestId) ?? null;
    const admitted = this.queued.has(changeRequestId);
    return {
      changeRequestId,
      campaignId: admitted ? `fc:${changeRequestId}` : null,
      outcome: admitted ? (outcome ?? 'BUILDING') : null,
      delivered: outcome === 'LIVE',
      needsPerson: false,
      blocker: outcome === 'BLOCKED' ? 'worker failed' : null,
    };
  }
  /** Which requirement keys production currently serves. */
  serving(): Set<string> {
    const live = new Set<string>(this.existingWorks);
    for (const [id, outcome] of this.outcome) {
      if (outcome !== 'LIVE') continue;
      const submission = this.byId.get(id);
      for (const condition of submission?.acceptanceConditions ?? []) live.add(condition.statement.split(':')[0]!);
    }
    for (const key of this.broken) live.delete(key);
    return live;
  }
  async verify(checks: RequirementCheck[]) {
    const serving = this.serving();
    return {
      revision: `rev${this.revisionNo}`,
      checks: checks.map((check) => {
        const key = check.kind === 'BUNDLE_TEXT' ? check.text.replace('marker:', '') : '';
        return { check: `bundle ${key}`, ok: serving.has(key), detail: serving.has(key) ? 'found' : 'missing' };
      }),
    };
  }
  revision() {
    return `rev${this.revisionNo}`;
  }
  now() {
    this.clock += 60_000;
    return new Date(this.clock);
  }
  /** Every queued campaign finishes and is deployed. */
  deployAll(except: (submission: CampaignSubmission) => boolean = () => false): string[] {
    const done: string[] = [];
    for (const id of this.queued) {
      if (this.outcome.get(id) === 'LIVE' || this.outcome.get(id) === 'BLOCKED') continue;
      if (except(this.byId.get(id)!)) continue;
      this.outcome.set(id, 'LIVE');
      done.push(id);
    }
    if (done.length) this.revisionNo += 1;
    return done;
  }
}

async function submitLarge(world: World) {
  const spec = largeSpecification();
  // Resolve the one open question as the owner would, so the program can finish.
  const map = structuredClone(spec.map);
  for (const r of map.requirements) for (const a of r.ambiguities) a.interpretation ??= 'The owner answered: no limit beyond the existing one.';
  // Existing claims: production really has all but one of them.
  const claimed = map.requirements.filter((r) => r.existing && !r.missingWork).map((r) => r.key);
  for (const key of claimed) world.existingWorks.add(key);
  const falseClaim = claimed[4]!;
  world.existingWorks.delete(falseClaim);
  const result = await submitProgram({
    projectId: fixture.project.id,
    title: 'Reliability fixture',
    sourceText: spec.source,
    map,
    repository: 'https://github.com/Peyday007/V5',
    baseBranch: 'production',
  });
  return { spec, map, result, falseClaim, claimed };
}

describe('a large program across many campaigns', () => {
  it('runs to a production-verified DONE through interruptions, a worker failure and a production failure', async () => {
    const world = new World();
    const { map, result, falseClaim, claimed } = await submitLarge(world);
    expect(result.map.errors).toEqual([]);
    expect(result.plan?.errors).toEqual([]);
    const programId = result.program.id;
    const plan = (await getPlan(programId))!.plan;
    const verdicts: string[] = [];

    // Nothing starts before a person approves the whole program.
    const before = await tickProgram(programId, world);
    expect(before.queued).toEqual([]);
    expect(before.verdict).toBe('NOT_DONE');
    expect((await approveProgram({ programId, userId: approverId, autoRelease: true })).ok).toBe(true);

    // First tick: existing functionality verified on production; every campaign with
    // no dependency queued at once; the false "existing" claim caught.
    const first = await tickProgram(programId, world);
    verdicts.push(first.verdict);
    const independent = plan.campaigns.filter((c) => c.dependsOn.length === 0).map((c) => c.key).sort();
    expect([...first.queued].filter((k) => !k.startsWith('repair-')).sort()).toEqual(independent);
    expect(independent.length).toBeGreaterThan(1);
    const passedExisting = first.verified.filter((v) => claimed.includes(v.requirement) && v.outcome === 'PASS').map((v) => v.requirement);
    expect(passedExisting.length).toBe(claimed.length - 1);
    expect(first.verified.find((v) => v.requirement === falseClaim)?.outcome).toBe('FAIL');
    expect(first.repairs.map((r) => r.requirement)).toEqual([falseClaim]);
    // Existing code is reused: no BUILD campaign implements a verified existing requirement.
    for (const c of plan.campaigns) for (const key of passedExisting) expect(c.implements).not.toContain(key);

    // A dependent campaign is never queued before everything it waits for is live.
    const liveKeys = (): Set<string> => {
      const live = new Set<string>();
      for (const [id, outcome] of world.outcome) if (outcome === 'LIVE') live.add(world.keyOf.get(id)!);
      return live;
    };
    const assertOrder = async () => {
      const links = await listCampaignLinks(programId);
      const current = (await getPlan(programId))!.plan;
      for (const link of links) {
        const campaign = current.campaigns.find((c) => c.key === link.campaignKey)!;
        for (const dep of campaign.dependsOn) expect(liveKeys().has(dep)).toBe(true);
      }
    };
    await assertOrder();

    // The database restarts: nothing is held in memory, and the same tick resumes.
    await restartDatabase();
    const resumed = await tickProgram(programId, world);
    expect(resumed.queued).toEqual([]); // nothing re-submitted
    expect([...world.submissions.keys()].length).toBe((await listCampaignLinks(programId)).length);

    // A worker fails one campaign; the rest deploy.
    // The campaign with the fewest dependents fails, so independent work can be seen to continue past it.
    const dependentsOf = (key: string) => plan.campaigns.filter((c) => c.dependsOn.includes(key)).length;
    const failing = [...world.queued]
      .filter((id) => !world.keyOf.get(id)!.startsWith('repair-'))
      .sort((a, b) => dependentsOf(world.keyOf.get(a)!) - dependentsOf(world.keyOf.get(b)!))[0]!;
    world.outcome.set(failing, 'BLOCKED');
    world.deployAll();
    let tick = await tickProgram(programId, world);
    verdicts.push(tick.verdict);
    const failedCampaignKey = world.keyOf.get(failing)!;
    const blockedReqs = plan.campaigns.find((c) => c.key === failedCampaignKey)!.implements;
    const reading = await readProgram(programId, world);
    for (const key of blockedReqs) expect(reading.requirements.find((r) => r.key === key)!.status).toBe('MAPPED');

    // A session is interrupted between submitting a campaign and queueing it.
    world.failQueueOnce = true;
    world.deployAll();
    await expect(tickProgram(programId, world)).rejects.toThrow(/interrupted/);
    tick = await tickProgram(programId, world); // completes the queue step; submits nothing twice
    verdicts.push(tick.verdict);
    for (const link of await listCampaignLinks(programId)) {
      expect(world.queued.has(link.changeRequestId)).toBe(true);
    }

    // The worker failure is answered (the campaign is regranted and finishes).
    world.outcome.delete(failing);

    // A requirement that passed is disproved by production after a later deploy.
    const victimOf = (): string => {
      const verifiedNow = map.requirements.filter((r) => map.requirements.some((x) => x.dependsOn.includes(r.key)) && r.missingWork && world.serving().has(r.key));
      return verifiedNow[0]!.key;
    };
    let victim: string | null = null;
    let replanDone = false;
    for (let round = 0; round < 40; round += 1) {
      world.deployAll();
      tick = await tickProgram(programId, world);
      verdicts.push(tick.verdict);
      if (round === 2 && !victim) {
        victim = victimOf();
        world.broken.add(victim);
        world.revisionNo += 1;
        tick = await tickProgram(programId, world);
        verdicts.push(tick.verdict);
        expect(tick.verified.find((v) => v.requirement === victim)?.outcome).toBe('FAIL');
        expect(tick.repairs.map((r) => r.requirement)).toEqual([victim]);
        const after = await readProgram(programId, world);
        expect(after.requirements.find((r) => r.key === victim)!.status).toBe('NOT_DONE');
        const dependents = map.requirements.filter((r) => r.dependsOn.includes(victim!));
        for (const d of dependents) expect(after.requirements.find((r) => r.key === d.key)!.status).not.toBe('PRODUCTION_VERIFIED');
        // Ticking again resumes the open repair; it does not open a second one.
        const again = await tickProgram(programId, world);
        expect(again.repairs).toEqual([]);
        // The repair's fix ships.
        world.broken.delete(victim);
      }
      if (round === 3) {
        // Implementation exposes a dependency between two unstarted requirements: replan.
        const started = new Set((await listCampaignLinks(programId)).map((l) => l.campaignKey));
        const unstarted = (await getPlan(programId))!.plan.campaigns.filter((c) => !started.has(c.key));
        if (unstarted.length >= 2) {
          // Two unstarted campaigns with no order between them: implementation shows one needs the other.
          const reaches = (from: string, to: string): boolean => {
            const stack = [from];
            const seen = new Set<string>();
            while (stack.length) {
              const n = stack.pop()!;
              if (n === to) return true;
              if (seen.has(n)) continue;
              seen.add(n);
              stack.push(...(unstarted.concat((await_plan.campaigns)).find((c) => c.key === n)?.dependsOn ?? []));
            }
            return false;
          };
          const await_plan = (await getPlan(programId))!.plan;
          const pair = unstarted.flatMap((x) => unstarted.map((y) => [x, y] as const)).find(([x, y]) => x !== y && !reaches(x.key, y.key) && !reaches(y.key, x.key));
          expect(pair).toBeDefined();
          const [later, earlier] = pair!;
          const a = later.implements[0]!;
          const b = earlier.implements[0]!;
          const replan = await recordDiscoveredDependency({ programId, requirementKey: a, dependsOn: b, reason: 'implementation showed a shared contract', actorType: 'FACTORY', actorId: null });
          expect(replan.reason ?? 'ok').toBe('ok');
          const replanned = (await getPlan(programId))!.plan;
          const owner = (key: string) => replanned.campaigns.find((c) => c.implements.includes(key))!;
          expect(owner(a).key === owner(b).key || owner(a).dependsOn.includes(owner(b).key)).toBe(true);
          replanDone = true;
          const cycle = await recordDiscoveredDependency({ programId, requirementKey: b, dependsOn: a, reason: 'this would close a loop', actorType: 'FACTORY', actorId: null });
          expect(cycle.ok).toBe(false);
        }
      }
      await assertOrder();
      if (tick.verdict === 'DONE') break;
    }

    expect(replanDone).toBe(true);
    // DONE arrives only once every requirement passed on production, and never before.
    const final = await readProgram(programId, world);
    expect(final.verdict).toBe('DONE');
    expect(final.counts.PRODUCTION_VERIFIED).toBe(map.requirements.length);
    expect(verdicts.slice(0, -1).every((v) => v !== 'DONE')).toBe(true);
    // The false existing claim was repaired by a campaign, and the repair is on the ledger.
    expect((await getPlan(programId))!.plan.campaigns.some((c) => c.repairOf?.requirement === falseClaim)).toBe(true);
    // No campaign was submitted twice, and no repair duplicated.
    const keys = [...world.submissions.keys()];
    expect(new Set(keys).size).toBe(keys.length);
    const repairs = (await getPlan(programId))!.plan.campaigns.filter((c) => c.kind === 'REPAIR');
    expect(new Set(repairs.map((r) => `${r.repairOf!.requirement}:${r.repairOf!.episode}`)).size).toBe(repairs.length);
    const events = await listFactoryEvents(null, { kinds: ['PROGRAM_DONE'], limit: 50 });
    expect(events.filter((e) => (e.detail as { programId?: string }).programId === programId)).toHaveLength(1);
  });

  it('clears a failure that was read wrongly at the next revision, while its repair is still running', async () => {
    const world = new World();
    const { result, falseClaim } = await submitLarge(world);
    const programId = result.program.id;
    await approveProgram({ programId, userId: approverId, autoRelease: true });
    const first = await tickProgram(programId, world);
    expect(first.verified.find((v) => v.requirement === falseClaim)?.outcome).toBe('FAIL');
    expect(first.repairs.map((r) => r.requirement)).toEqual([falseClaim]);
    // The failure was a misreading: production already serves it. Nothing is deployed for the repair yet.
    world.existingWorks.add(falseClaim);
    world.revisionNo += 1;
    const next = await tickProgram(programId, world);
    expect(next.verified.find((v) => v.requirement === falseClaim)?.outcome).toBe('PASS');
    expect(next.repairs).toEqual([]);
    const reading = await readProgram(programId, world);
    expect(reading.requirements.find((r) => r.key === falseClaim)!.status).toBe('PRODUCTION_VERIFIED');
  });

  it('keeps the source verbatim and refuses to redefine an approved requirement', async () => {
    const world = new World();
    const { spec, map, result } = await submitLarge(world);
    const programId = result.program.id;
    const stored = await getProgram(programId);
    expect(stored!.sourceText).toBe(spec.source);
    await approveProgram({ programId, userId: approverId, autoRelease: false });

    // The same key with a different source is refused: a source is never edited.
    await expect(
      submitProgram({ projectId: fixture.project.id, title: 'x', sourceText: `${spec.source}\n- extra: must also do this.`, map, repository: 'r', baseBranch: 'b', submissionKey: result.program.submissionKey }),
    ).rejects.toThrow(/never edited/);

    // Factory may not weaken a check, drop a requirement, or cut a relationship after approval.
    const weakened = structuredClone(map);
    weakened.requirements[0]!.verification = [{ kind: 'HTTP', path: '/healthz', expectStatus: 200 }];
    const refused = await proposeMap({ programId, map: weakened, actorType: 'FACTORY', actorId: null, reason: 'make it pass' });
    expect(refused.version).toBeNull();
    expect(refused.map.errors.map((e) => e.code)).toContain('REQUIREMENT_REDEFINED');
    const dropped = structuredClone(map);
    dropped.requirements.splice(30, 1);
    expect((await proposeMap({ programId, map: dropped, actorType: 'FACTORY', actorId: null, reason: 'smaller' })).map.errors.map((e) => e.code)).toContain('REQUIREMENT_DROPPED');
    expect((await getMap(programId))!.version).toBe(1);
  });

  it('refuses to install a map that omits a requirement, and holds a requirement with an open question', async () => {
    const world = new World();
    const spec = largeSpecification();
    const omitted = structuredClone(spec.map);
    omitted.requirements.splice(40, 1);
    const result = await submitProgram({ projectId: fixture.project.id, title: 'gap', sourceText: spec.source, map: omitted, repository: 'r', baseBranch: 'b' });
    expect(result.map.ok).toBe(false);
    expect(result.map.errors.map((e) => e.code)).toContain('OMITTED_REQUIREMENT');
    expect(await getMap(result.program.id)).toBeNull();
    expect((await approveProgram({ programId: result.program.id, userId: approverId, autoRelease: false })).ok).toBe(false);

    // The intact map installs; MOD-03's open question is listed at approval and blocks only its campaign.
    const ok = await proposeMap({ programId: result.program.id, map: spec.map, actorType: 'FACTORY', actorId: null, reason: 'fixed' });
    expect(ok.version).toBe(1);
    const approval = await approveProgram({ programId: result.program.id, userId: approverId, autoRelease: false });
    expect(approval.openQuestions.join()).toMatch(/MOD-03/);
    await tickProgram(result.program.id, world);
    const plan = (await getPlan(result.program.id))!.plan;
    const holding = plan.campaigns.find((c) => c.implements.includes('MOD-03'))!;
    expect((await listCampaignLinks(result.program.id)).some((l) => l.campaignKey === holding.key)).toBe(false);
    const reading = await readProgram(result.program.id, world);
    expect(reading.requirements.find((r) => r.key === 'MOD-03')!.status).toBe('BLOCKED');
    // Without an automatic-release approval, no grant is given.
    expect(world.grants.size).toBe(0);
  });
});
