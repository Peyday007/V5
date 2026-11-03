/**
 * Brain-only mode (§84): Claude routines are handed only Brain-improvement work.
 *
 * Production, 2026-11-02: routines were handed `bin_481feaaee88f48ffa917`
 * ("What it costs to land mining dump trucks in Russia"), declined it three
 * times for LEGAL_RISK, and spent five attempts and a dozen fires on it, while
 * its audit sibling `bin_fda69558546e41358288` did the same. Nothing asked what
 * kind of work a bin was before handing it out. These pin that the server now
 * asks, in the assignment query itself, and that the answer defaults to deny.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, getBin, listBinEvents } from '../server/repos/bins.ts';
import { createProject } from '../server/repos/projects.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { findTool } from '../server/mcp/tools.ts';
import { checkIn } from '../server/services/bins/service.ts';
import {
  brainOnlyMode,
  enforceBrainOnly,
  setBrainOnlyMode,
  workItemPurposeAdmits,
} from '../server/services/bins/brainOnly.ts';
import { binLane, classifyBinPurpose } from '../server/domain/binPurpose.ts';
import { WORKER_INSTRUCTIONS, instructionProblems } from '../server/services/bins/workerInstructions.ts';
import type { BinManifest, Principal, ProjectMembership } from '../server/domain/types.ts';

const SCOPES = ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'] as const;

let play: TestProject;
let brainProjectId = '';
let workerId = '';

function manifest(projectId: string, input: string): BinManifest {
  return {
    objective: 'Return the sha-256 of one value carried in this manifest.',
    why: 'a bounded check',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'echo', establishes: 'answered', input, transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['one unit result'],
    outputs: ['the sha-256'],
    authorizedActions: ['submit the unit result', 'complete this bin'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a result'],
  };
}

function membership(projectId: string): ProjectMembership {
  return {
    id: `mem_${projectId}`,
    projectId,
    principalType: 'WORKER',
    principalId: workerId,
    role: 'MEMBER',
    scopes: [...SCOPES],
    active: true,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: new Date().toISOString(),
    revokedAt: null,
  } as ProjectMembership;
}

/** A Claude routine's worker, a member of both the play project and Brain's own. */
function routine(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'routine',
    displayName: 'routine',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'tok_routine',
    authMethod: 'WORKER_BEARER',
    memberships: [membership(play.project.id), membership(brainProjectId)],
    requestId: 'req_routine',
  } as Principal;
}

/** A bin of the generic kind, so only the project and the words decide its purpose. */
async function bin(projectId: string, title: string, priority = 5): Promise<string> {
  const created = await createBin({
    projectId,
    kind: 'METHOD_CHECK',
    title,
    objective: title,
    manifest: manifest(projectId, `${title}-${Math.random()}`),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 3,
    priority,
  });
  return created.id;
}

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const found = findTool(name)!;
  const outcome = await found.run(args, {
    principal: routine(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, unknown>;
}

beforeEach(async () => {
  play = await freshProject();
  brainProjectId = (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
  const worker = await createWorker({ name: 'routine', displayName: 'routine', createdByType: 'SYSTEM', createdById: 'test' });
  workerId = worker.id;
  for (const projectId of [play.project.id, brainProjectId]) {
    await grantMembership({
      principalType: 'WORKER',
      principalId: worker.id,
      projectId,
      role: 'MEMBER',
      scopes: [...SCOPES],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
  }
  // The real switch, the real way: production's migration already has it ON.
  await setBrainOnlyMode(true, 'test', 'brain-only suite');
});

describe('purpose is decided at creation, deterministically first', () => {
  it('tags a bin in Brain’s own project as Brain improvement, and a play project’s as play research', async () => {
    const brain = await getBin(await bin(brainProjectId, 'How should a source be judged'));
    const deal = await getBin(await bin(play.project.id, 'AI receptionist pricing in Ohio'));
    expect(brain?.purpose).toBe('BRAIN_IMPROVEMENT');
    expect(brain?.purposeBasis).toBe('PROJECT:brain-architecture');
    expect(deal?.purpose).toBe('PLAY_RESEARCH');
  });

  it('never lets a keyword promote play work to Brain improvement', () => {
    const decision = classifyBinPurpose({
      kind: 'RESEARCH_PACKET',
      title: 'Improve Brain research methods and evidence rules',
      objective: 'audit Brain source judging',
      project: { slug: 'cash-mode-1', purpose: 'PROJECT' },
    });
    expect(decision.purpose).toBe('PLAY_RESEARCH');
  });

  it('classifies Brain’s own repository as Brain work and any other repository as a product', () => {
    const base = { kind: 'FACTORY_UNITS', title: 't', objective: 'o', project: { slug: 'deal-dispatch', purpose: 'PROJECT' } };
    expect(classifyBinPurpose({ ...base, repositoryId: 'peyday007/v5' }).purpose).toBe('BRAIN_IMPROVEMENT');
    expect(classifyBinPurpose({ ...base, repositoryId: 'someone/storefront' }).purpose).toBe('PLAY_RESEARCH');
  });

  it('parks the Russia landed-cost question as a legal call, and lead hunting as grunt work', () => {
    const play = { kind: 'RESEARCH_PACKET', project: { slug: 'manufacturing-empire', purpose: 'PROJECT' } };
    expect(
      classifyBinPurpose({
        ...play,
        title: 'What it costs to land mining dump trucks in Russia (round 2)',
        objective: 'landed cost',
      }).purpose,
    ).toBe('BLOCKED_LEGAL');
    expect(classifyBinPurpose({ ...play, title: 'Build a list of 200 dentists', objective: 'lead hunting' }).purpose).toBe(
      'GRUNT',
    );
    expect(binLane('BLOCKED_LEGAL', true)).toBe('PARKED_LEGAL');
    expect(binLane('GRUNT', true)).toBe('WAITING_FOR_FREE_LANE');
    expect(binLane('PLAY_RESEARCH', true)).toBe('WAITING_FOR_FREE_LANE');
    expect(binLane(null, true)).toBe('WAITING_FOR_FREE_LANE');
  });
});

describe('the assignment query enforces it', () => {
  it('never assigns a play bin to a Claude worker, even when it is the only and highest-priority bin', async () => {
    const id = await bin(play.project.id, 'AI receptionist pricing in Ohio', 9);
    const answer = await checkIn({ principal: routine(), workerId });
    expect(answer.assigned).toBe(false);
    expect((await getBin(id))?.state).toBe('READY');
  });

  it('never assigns a legal bin, with the mode on or off', async () => {
    const id = await bin(play.project.id, 'Export controls on selling CNC spindles to Iran');
    expect((await getBin(id))?.purpose).toBe('BLOCKED_LEGAL');
    expect((await checkIn({ principal: routine(), workerId })).assigned).toBe(false);
    await setBrainOnlyMode(false, 'test', 'legal is parked whatever the mode');
    expect((await checkIn({ principal: routine(), workerId })).assigned).toBe(false);
    expect((await getBin(id))?.state).toBe('READY');
  });

  it('denies an untagged bin by default', async () => {
    const id = await bin(brainProjectId, 'A Brain method bin whose tag was lost');
    await getDb().run('UPDATE bins SET purpose = NULL, purpose_basis = NULL WHERE id = ?', [id]);
    const answer = await checkIn({ principal: routine(), workerId });
    expect(answer.assigned).toBe(false);
    if (!answer.assigned) expect(answer.reason).toBe('NO_WORK');
  });

  it('answers NO_WORK when only junk is queued, and tells the routine to end without notifying', async () => {
    await bin(play.project.id, 'AI receptionist pricing in Ohio');
    await bin(play.project.id, 'Build a list of 200 dentists for a local mailer');
    await bin(play.project.id, 'Sanctions exposure on a Russia dump-truck sale');
    const answer = await tool('brain_check_in', { session_ref: 'cse_junk_only' });
    expect(answer.assigned).toBe(false);
    expect(answer.reason).toBe('NO_WORK');
    expect(answer.notify).toBe(false);
    expect(String(answer.message)).toMatch(/do not send a notification/);
  });

  it('flows a Brain-improvement bin end to end, past play bins of higher priority', async () => {
    await bin(play.project.id, 'AI receptionist pricing in Ohio', 9);
    const id = await bin(brainProjectId, 'Re-derive the source-judging check', 3);
    const answer = await tool('brain_check_in', { session_ref: 'cse_brain_work' });
    expect(answer.assigned).toBe(true);
    expect(answer.binId).toBe(id);

    const unit = (await getBin(id))!.manifest.units[0]!;
    const proof = { bin_id: id, lease_id: answer.leaseId, lease_generation: answer.leaseGeneration };
    await tool('brain_bin_submit_unit', {
      ...proof,
      unit_key: unit.key,
      value: createHash('sha256').update(String(unit.input)).digest('hex'),
    });
    const done = await tool('brain_bin_complete', proof);
    expect(done.state).toBe('COMPLETE');
    expect((await getBin(id))?.state).toBe('COMPLETE');
  });

  it('keeps play bins assignable once the owner turns the mode off', async () => {
    const id = await bin(play.project.id, 'AI receptionist pricing in Ohio');
    await setBrainOnlyMode(false, 'owner', 'owner said so');
    expect(await brainOnlyMode()).toBe(false);
    const answer = await checkIn({ principal: routine(), workerId });
    expect(answer.assigned).toBe(true);
    if (answer.assigned) expect(answer.assignment.binId).toBe(id);
  });
});

describe('the clean-up pass', () => {
  it('retags untagged bins and releases a routine’s lease on non-Brain work, silently', async () => {
    await setBrainOnlyMode(false, 'test', 'let the routine take a play bin first');
    const id = await bin(play.project.id, 'AI receptionist pricing in Ohio');
    const taken = await checkIn({ principal: routine(), workerId });
    expect(taken.assigned).toBe(true);
    await getDb().run('UPDATE bins SET purpose = NULL WHERE id = ?', [id]);

    await setBrainOnlyMode(true, 'test', 'reserve routines again'); // runs the pass
    const after = await getBin(id);
    expect(after?.state).toBe('READY');
    expect(after?.workerId).toBeNull();
    expect(after?.purpose).toBe('PLAY_RESEARCH');
    const events = await listBinEvents(id);
    expect(events.some((e) => e.eventType === 'BIN_PARKED' && e.outcome === 'WAITING_FOR_FREE_LANE')).toBe(true);
    expect(events.some((e) => e.eventType === 'BIN_RELEASED')).toBe(true);
    // A second pass changes nothing.
    expect(await enforceBrainOnly()).toEqual({ tagged: 0, binLeasesReleased: 0, itemLeasesReleased: 0, parked: {} });
  });

  it('refuses a work item whose owning bin is not Brain improvement, and one no bin owns', async () => {
    const playBin = await bin(play.project.id, 'AI receptionist pricing in Ohio');
    const brainBin = await bin(brainProjectId, 'Audit the evidence rule');
    expect(await workItemPurposeAdmits({ bin_id: playBin, orchestration_id: null })).toBe(false);
    expect(await workItemPurposeAdmits({ bin_id: brainBin, orchestration_id: null })).toBe(true);
    expect(await workItemPurposeAdmits({ bin_id: null, orchestration_id: null })).toBe(false);
  });
});

describe('the served instructions say what the server enforces', () => {
  it('tells routines they do only Brain-improvement work and not to notify about parked work', () => {
    expect(WORKER_INSTRUCTIONS).toMatch(/only work that improves\s+Brain itself/);
    expect(WORKER_INSTRUCTIONS).toMatch(/NO_WORK/);
    expect(WORKER_INSTRUCTIONS).toMatch(/Do not send notifications about skipped, parked/);
    expect(instructionProblems()).toEqual([]);
  });
});
