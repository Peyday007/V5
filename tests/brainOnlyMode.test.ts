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
import { binPurposeAdmits, createBin, getBin, listBinEvents, purposeAdmitsSql } from '../server/repos/bins.ts';
import { createProject } from '../server/repos/projects.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { findTool } from '../server/mcp/tools.ts';
import { checkIn, nextItemInBin } from '../server/services/bins/service.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import {
  brainOnlyMode,
  enforceBrainOnly,
  setBrainOnlyMode,
  workItemPurposeAdmits,
} from '../server/services/bins/brainOnly.ts';
import { OWNER_DIRECTED_GOAL_IDS, binLane, classifyBinPurpose } from '../server/domain/binPurpose.ts';
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

/** Russell candidates a mission may name (`russell_missions.candidate_id` references them). */
async function candidates(projectId: string, ids: string[], now: string): Promise<void> {
  await getDb().run(
    `INSERT INTO russell_candidates (id, project_id, title, statement, fingerprint, created_at, updated_at)
     VALUES ${ids.map(() => "(?, ?, 't', 's', ?, ?, ?)").join(', ')}`,
    ids.flatMap((id) => [id, projectId, `fp_${id}`, now, now]),
  );
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

  it('hands an idle routine the owner-directed goal’s research, and still no other play bin', async () => {
    // Production, 2026-11-23: twelve routines idle for weeks beside fifteen
    // READY bins of the $10K goal the owner put Brain's resources on.
    const goalId = OWNER_DIRECTED_GOAL_IDS[0]!;
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [goalId, play.project.id, '$10K', 'Collect 10000 dollars', 'REVENUE_DIRECT', now, now],
    );
    const other = await bin(play.project.id, 'AI receptionist pricing in Ohio', 9);
    const goalBin = await bin(play.project.id, 'Constructed: who pays for this arrangement', 3);
    const layer = await play.layerByName('Discovery Logic');
    const run = await createRun({ projectId: play.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const packet = await createOrchestration({ projectId: play.project.id, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    await getDb().run('UPDATE bins SET orchestration_id = ? WHERE id = ?', [packet.id, goalBin]);
    await getDb().run(
      `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
       VALUES (?, ?, 'PACKET', ?, 'PURSUES', 'BRAIN', ?)`,
      ['wsl_goal_packet', goalId, packet.id, now],
    );
    expect((await getBin(goalBin))?.purpose).toBe('PLAY_RESEARCH');
    const answer = await checkIn({ principal: routine(), workerId });
    expect(answer.assigned).toBe(true);
    if (answer.assigned) expect(answer.assignment.binId).toBe(goalBin);
    expect((await getBin(other))?.state).toBe('READY');
    expect((await checkIn({ principal: routine(), workerId })).assigned).toBe(false);
  });

  it('treats every live goal a person owns and set a target for as owner-directed, read from rows (§119)', async () => {
    // Production, 2026-11-25 00:19Z: five cash goals the owner set on 11-19 sat at
    // "Brain fires the next free Routine" beside 11 idle routines, because the
    // owner-directed set was a hard-coded list naming only the $10K goal.
    const owner = await createUser({ email: `od-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    const goalId = 'wst_0e0a1a7e0000000000000001';
    expect(OWNER_DIRECTED_GOAL_IDS).not.toContain(goalId);
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, owner_user_id, target_metric, target_amount_cents,
         target_currency, target_project_id, target_set_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'SETTLED_CASH', 300000, 'USD', ?, ?, ?, ?)`,
      [goalId, play.project.id, '$3K', 'Earn 3000 dollars', 'REVENUE_DIRECT', owner.id, play.project.id, now, now, now],
    );
    const goalBin = await bin(play.project.id, 'Constructed: who pays for this service', 3);
    const layer = await play.layerByName('Discovery Logic');
    const run = await createRun({ projectId: play.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const packet = await createOrchestration({ projectId: play.project.id, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    await getDb().run('UPDATE bins SET orchestration_id = ? WHERE id = ?', [packet.id, goalBin]);
    await getDb().run(
      `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
       VALUES ('wsl_row_goal_packet', ?, 'PACKET', ?, 'PURSUES', 'BRAIN', ?)`,
      [goalId, packet.id, now],
    );
    expect(await binPurposeAdmits(goalBin)).toBe(true);
    // Paused, it is no longer owner-directed, and its research goes back to the free lane alone.
    await getDb().run("UPDATE workstreams SET paused_at = ?, paused_reason = 'test' WHERE id = ?", [now, goalId]);
    expect(await binPurposeAdmits(goalBin)).toBe(false);
    // A goal without a stated target (a research question) never was.
    await getDb().run('UPDATE workstreams SET paused_at = NULL, target_metric = NULL, target_set_at = NULL WHERE id = ?', [goalId]);
    expect(await binPurposeAdmits(goalBin)).toBe(false);
    await getDb().run('UPDATE workstreams SET target_metric = ?, target_set_at = ? WHERE id = ?', ['SETTLED_CASH', now, goalId]);
    const answer = await checkIn({ principal: routine(), workerId });
    expect(answer.assigned).toBe(true);
    if (answer.assigned) expect(answer.assignment.binId).toBe(goalBin);
  });

  it('reaches the goal’s research through a mission the goal links, as the goal model does', async () => {
    const goalId = OWNER_DIRECTED_GOAL_IDS[0]!;
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [goalId, play.project.id, '$10K', 'Collect 10000 dollars', 'REVENUE_DIRECT', now, now],
    );
    const goalBin = await bin(play.project.id, 'Constructed: who pays for this arrangement', 3);
    const layer = await play.layerByName('Discovery Logic');
    const run = await createRun({ projectId: play.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const packet = await createOrchestration({ projectId: play.project.id, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    await getDb().run('UPDATE bins SET orchestration_id = ? WHERE id = ?', [packet.id, goalBin]);
    await getDb().run(
      `INSERT INTO russell_missions (id, project_id, objective, why_now, state, orchestration_id, idempotency_key, created_at, updated_at)
       VALUES ('rms_goal', ?, 'who pays', 'the plan needs it', 'RUNNING', ?, 'key_goal', ?, ?)`,
      [play.project.id, packet.id, now, now],
    );
    expect((await checkIn({ principal: routine(), workerId })).assigned).toBe(false);
    await getDb().run(
      `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
       VALUES ('wsl_goal_mission', ?, 'MISSION', 'rms_goal', 'PURSUES', 'BRAIN', ?)`,
      [goalId, now],
    );
    const answer = await checkIn({ principal: routine(), workerId });
    expect(answer.assigned).toBe(true);
    if (answer.assigned) expect(answer.assignment.binId).toBe(goalBin);
  });

  it('reaches the goal’s bin through a candidate the goal links, by the mission’s bin', async () => {
    const goalId = OWNER_DIRECTED_GOAL_IDS[0]!;
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [goalId, play.project.id, '$10K', 'Collect 10000 dollars', 'REVENUE_DIRECT', now, now],
    );
    const goalBin = await bin(play.project.id, 'Constructed: who pays for this arrangement', 3);
    await candidates(play.project.id, ['cand_goal'], now);
    await getDb().run(
      `INSERT INTO russell_missions (id, project_id, objective, why_now, state, candidate_id, bin_id, idempotency_key, created_at, updated_at)
       VALUES ('rms_goal_c', ?, 'who pays', 'the plan needs it', 'RUNNING', 'cand_goal', ?, 'key_goal_c', ?, ?)`,
      [play.project.id, goalBin, now, now],
    );
    expect(await binPurposeAdmits(goalBin)).toBe(false);
    await getDb().run(
      `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
       VALUES ('wsl_goal_cand', ?, 'CANDIDATE', 'cand_goal', 'PURSUES', 'BRAIN', ?)`,
      [goalId, now],
    );
    expect(await binPurposeAdmits(goalBin)).toBe(true);
    // A superseded link no longer admits it, and the negation is a definite answer, never NULL.
    await getDb().run("UPDATE workstream_links SET superseded_at = ?, superseded_reason = 'test' WHERE id = 'wsl_goal_cand'", [now]);
    expect(await binPurposeAdmits(goalBin)).toBe(false);
    const negated = await getDb().get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM bins WHERE id = ? AND NOT ${purposeAdmitsSql('')}`,
      [goalBin],
    );
    expect(Number(negated?.n)).toBe(1);
  });

  it('answers the owner-directed question once per statement, not once per bin (production 2026-11-24: 120 s timeout)', async () => {
    // 363 claimable bins and 4,727 missions made every dispatcher statement run
    // into the statement timeout. A scaled copy: the correlated form visits
    // bins x links x missions rows; the set form builds the goal's set once.
    const goalId = OWNER_DIRECTED_GOAL_IDS[0]!;
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [goalId, play.project.id, '$10K', 'Collect 10000 dollars', 'REVENUE_DIRECT', now, now],
    );
    const bins: string[] = [];
    for (let i = 0; i < 150; i += 1) bins.push(await bin(play.project.id, `AI receptionist pricing in Ohio ${i}`, 5));
    const missions = 3000;
    for (let start = 0; start < missions; start += 250) {
      const rows = Array.from({ length: Math.min(250, missions - start) }, (_, k) => start + k);
      await candidates(play.project.id, rows.map((i) => `cand_v${i}`), now);
      await getDb().run(
        `INSERT INTO russell_missions (id, project_id, objective, why_now, state, candidate_id, idempotency_key, created_at, updated_at)
         VALUES ${rows.map(() => "(?, ?, 'o', 'w', 'FAILED', ?, ?, ?, ?)").join(', ')}`,
        rows.flatMap((i) => [`rms_v${i}`, play.project.id, `cand_v${i}`, `key_v${i}`, now, now]),
      );
    }
    const links = 150;
    for (let start = 0; start < links; start += 75) {
      const rows = Array.from({ length: 75 }, (_, k) => start + k);
      await getDb().run(
        `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
         VALUES ${rows.map(() => "(?, ?, ?, ?, 'PURSUES', 'BRAIN', ?)").join(', ')}`,
        rows.flatMap((i) => [`wsl_v${i}`, goalId, i % 2 === 0 ? 'CANDIDATE' : 'MISSION', i % 2 === 0 ? `cand_v${i * 7}` : `rms_v${i * 11}`, now]),
      );
    }
    // One of the bins is the goal's, through the last mission a link names.
    await getDb().run("UPDATE russell_missions SET bin_id = ? WHERE id = 'rms_v1639'", [bins[42]!]);
    const started = Date.now();
    const row = await getDb().get<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM bins WHERE state = 'READY' AND ${purposeAdmitsSql('bins.')}`,
      [],
    );
    const elapsed = Date.now() - started;
    expect(Number(row?.n)).toBe(1);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('lets the routine claim the owner-directed goal’s items, not only be handed its bin', async () => {
    /*
     * Production, 2026-11-24: bin_8db9ec91086843b99067, the $10K goal's research
     * bin, was assigned to a routine five times — the bin rule admits it under
     * §118 — and every item in it was refused at the drain, because the
     * item-level rule still read only BRAIN_IMPROVEMENT. Brain handed the bin
     * back each time and it parked NEEDS_HUMAN at 5/5 with no research done.
     */
    const goalId = OWNER_DIRECTED_GOAL_IDS[0]!;
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [goalId, play.project.id, '$10K', 'Collect 10000 dollars', 'REVENUE_DIRECT', now, now],
    );
    const goalBin = await bin(play.project.id, 'What else could reach: Collect 10000 dollars', 3);
    const layer = await play.layerByName('Discovery Logic');
    const run = await createRun({ projectId: play.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const packet = await createOrchestration({ projectId: play.project.id, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    const otherRun = await createRun({ projectId: play.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'r' });
    const otherPacket = await createOrchestration({ projectId: play.project.id, layerId: layer.id, runId: otherRun.id, title: 'r', assignment: 'r', provider: 'WORKER', autoApprove: false });
    const otherBin = await bin(play.project.id, 'AI receptionist pricing in Ohio', 1);
    await getDb().run('UPDATE bins SET orchestration_id = ? WHERE id = ?', [packet.id, goalBin]);
    await getDb().run('UPDATE bins SET orchestration_id = ? WHERE id = ?', [otherPacket.id, otherBin]);
    await getDb().run(
      `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
       VALUES (?, ?, 'PACKET', ?, 'PURSUES', 'BRAIN', ?)`,
      ['wsl_goal_packet_items', goalId, packet.id, now],
    );
    // A packet's item, owned through the packet rather than by bin id — the production shape.
    const item = await enqueueWork({
      projectId: play.project.id,
      workType: 'GOAL_CONSTRUCTION_STEP',
      orchestrationId: packet.id,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });

    // One rule at both entrances: the bin rule admits it, and so does the item rule.
    expect(await workItemPurposeAdmits({ bin_id: null, orchestration_id: packet.id })).toBe(true);
    // And still no other play packet's item.
    expect(await workItemPurposeAdmits({ bin_id: null, orchestration_id: otherPacket.id })).toBe(false);

    const answer = await checkIn({ principal: routine(), workerId, sessionRef: 'cse_goal_items' });
    expect(answer.assigned).toBe(true);
    if (!answer.assigned) return;
    expect(answer.assignment.binId).toBe(goalBin);
    const next = await nextItemInBin({
      principal: routine(),
      workerId,
      proof: {
        binId: answer.assignment.binId,
        leaseId: answer.assignment.leaseId,
        leaseGeneration: answer.assignment.leaseGeneration,
        workerId,
      },
    });
    expect(next.held).toBe(true);
    if (next.held) expect(next.item?.workItemId).toBe(item.id);
    const handedBack = (await listBinEvents(goalBin)).filter((event) => event.eventType === 'BIN_RELEASED');
    expect(handedBack).toHaveLength(0);
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
    // With no bin, the project decides: a play project's item is denied, a Brain project's admitted.
    expect(await workItemPurposeAdmits({ bin_id: null, orchestration_id: null, project_id: play.project.id })).toBe(false);
    expect(await workItemPurposeAdmits({ bin_id: null, orchestration_id: null, project_id: brainProjectId })).toBe(true);
    const technical = await createProject({ name: 'Verification scope', slug: 'verification-scope' });
    await getDb().run("UPDATE projects SET purpose = 'TECHNICAL' WHERE id = ?", [technical.id]);
    expect(await workItemPurposeAdmits({ bin_id: null, orchestration_id: null, project_id: technical.id })).toBe(true);
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
