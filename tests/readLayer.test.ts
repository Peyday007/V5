/**
 * The read layer — Work, Ideas, Who, and the one progress projection.
 *
 * These tests exist because of a specific, reported failure: a person opened
 * the Brain, saw Work empty, Ideas empty and Knows nearly empty, and reasonably
 * concluded the Brain knew nothing and was doing nothing. It was doing a real
 * research packet at the time. Every projection here reads the *authoritative*
 * rows rather than only the ones Russell had started writing that week, and the
 * properties below are the ones that failure would have caught.
 *
 * Three of them are worth naming up front, because they are the ones that are
 * easy to break by making a screen read better:
 *
 *   - a projection that shows less than the Brain holds is a defect, not an
 *     empty state;
 *   - a technical row must never be counted as somebody's work;
 *   - a count is a disclosure, so it is scoped like a listing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { createBin } from '../server/repos/bins.ts';
import { createProject, getProject } from '../server/repos/projects.ts';
import { createCandidate, recordJudgment } from '../server/repos/russellCandidates.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import { createUser, grantMembership, listMembershipsForPrincipal } from '../server/repos/identity.ts';
import { createLayer, listLayers } from '../server/repos/layers.ts';
import {
  groupOfBin,
  groupOfOrchestration,
  provenanceOfBinKind,
  workForProject,
  groupWork,
} from '../server/services/russell/work.ts';
import { ideaMapForProject, childrenOf, pathTo } from '../server/services/russell/ideas.ts';
import { whoForProject } from '../server/services/russell/who.ts';
import {
  BUILD_MILESTONES,
  buildProgress,
  projectProgress,
  progressOf,
  stageFor,
} from '../server/services/russell/progress.ts';
import type { BinManifest, Principal, Project } from '../server/domain/types.ts';

/** The smallest manifest `createBin` accepts. The dispatcher never reads it here. */
function manifest(): BinManifest {
  return {
    objective: 'stand in for a real one',
    why: 'a bin has to be about something',
    lineage: { projectId: '', layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: [],
    excludedSources: [],
    evidence: [],
    outputs: [],
    authorizedActions: [],
    prohibitedActions: [],
    budgetUnits: 1,
    retry: { maxAttempts: 1, backoffSeconds: 30 },
    stoppingConditions: ['nothing to do'],
  };
}

let project: Project;
let layerId = '';
let ownerId = '';

/** A signed-in person, built the way `authenticate` builds one. */
function personPrincipal(input: {
  id: string;
  isBrainAdmin?: boolean;
  memberships?: Principal['memberships'];
}): Principal {
  return {
    type: 'HUMAN',
    id: input.id,
    handle: `${input.id}@example.test`,
    displayName: input.id,
    isBrainAdmin: input.isBrainAdmin ?? false,
    mustChangePassword: false,
    credentialId: `ses_${input.id}`,
    authMethod: 'SESSION_COOKIE',
    memberships: input.memberships ?? [],
    requestId: `req_${input.id}`,
  };
}

async function membershipsFor(userId: string): Promise<Principal['memberships']> {
  return listMembershipsForPrincipal('HUMAN', userId);
}

beforeEach(async () => {
  const fixture = await freshProject();
  project = fixture.project;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  const owner = await createUser({
    email: 'owner@example.test',
    displayName: 'The owner',
    password: 'a-long-enough-password',
    isBrainAdmin: false,
  });
  ownerId = owner.id;
  await grantMembership({
    projectId: project.id,
    principalType: 'HUMAN',
    principalId: owner.id,
    role: 'OWNER',
    scopes: [],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

/** A research packet, written the way Steps 9 to 11 wrote them. */
async function packet(input: { title: string; fixture?: boolean; status?: string }) {
  const run = await createRun({
    projectId: project.id,
    layerId,
    runType: 'FOUNDATION',
    provider: 'WORKER',
  });
  const orchestration = await createOrchestration({
    projectId: project.id,
    layerId,
    runId: run.id,
    title: input.title,
    assignment: 'find out the thing',
    provider: 'WORKER',
  });
  if (input.fixture) {
    await getDb().run('UPDATE research_orchestrations SET fixture = 1 WHERE id = ?', [
      orchestration.id,
    ]);
  }
  if (input.status) {
    await getDb().run('UPDATE research_orchestrations SET status = ? WHERE id = ?', [
      input.status,
      orchestration.id,
    ]);
  }
  return orchestration;
}

describe('Work shows what the Brain is actually doing', () => {
  it('projects a research packet that predates Russell entirely', async () => {
    // The exact reported failure: a real packet running, and a Work screen
    // reading one table that knew nothing about it.
    await packet({ title: 'Michigan licensing', status: 'RESEARCHING' });
    const work = await workForProject({ projectId: project.id });
    const titles = work.entries.map((entry) => entry.title);
    expect(titles).toContain('Michigan licensing');
    expect(work.entries.find((entry) => entry.title === 'Michigan licensing')!.group).toBe(
      'WORKING_NOW',
    );
  });

  it('counts one piece of work once, however many rows describe it', async () => {
    const orchestration = await packet({ title: 'One thing', status: 'RESEARCHING' });
    const bin = await createBin({
      projectId: project.id,
      layerId,
      kind: 'RESEARCH_PACKET',
      title: 'One thing, dispatched',
      objective: 'carry the packet',
      manifest: manifest(),
      completionContract: 'RESEARCH_PACKET_V1',
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const { mission } = await launchMission({
      projectId: project.id,
      layerId,
      visibility: 'SHARED',
      objective: 'One thing, as a mission',
      whyNow: 'because',
      idempotencyKey: 'k1',
    });
    await getDb().run(
      'UPDATE russell_missions SET orchestration_id = ?, bin_id = ? WHERE id = ?',
      [orchestration.id, bin.id, mission.id],
    );

    const work = await workForProject({ projectId: project.id });
    // A mission that owns a packet that owns a bin is one thing to do. Three
    // entries would tell somebody the Brain is three times busier than it is.
    expect(work.entries).toHaveLength(1);
    expect(work.entries[0]!.source).toBe('MISSION');
  });

  it('keeps fixtures, harness runs and conversation turns out of ordinary work', async () => {
    await packet({ title: 'Real research', status: 'RESEARCHING' });
    await packet({ title: 'A written-in fixture', fixture: true, status: 'COMPLETE' });
    await createBin({
      projectId: project.id,
      kind: 'DETERMINISTIC_CHECK',
      title: 'A harness run',
      objective: 'prove the dispatcher',
      manifest: manifest(),
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await createBin({
      projectId: project.id,
      kind: 'RUSSELL_TURN',
      title: 'Answering a question',
      objective: 'reply',
      manifest: manifest(),
      completionContract: 'RUSSELL_TURN_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });

    const ordinary = await workForProject({ projectId: project.id });
    expect(ordinary.entries.map((entry) => entry.title)).toEqual(['Real research']);
    // Held back, and *named*. "Nothing here" and "nothing here, and three rows
    // hidden" are different facts.
    expect(ordinary.technicalHidden).toBe(3);

    const opened = await workForProject({ projectId: project.id, includeTechnical: true });
    expect(opened.entries).toHaveLength(4);
    expect(opened.technicalHidden).toBe(0);
    const kinds = new Set(opened.entries.map((entry) => entry.provenance));
    expect(kinds).toEqual(new Set(['PROJECT', 'FIXTURE', 'HARNESS', 'CONVERSATION']));
  });

  it('treats everything inside a technical scope as technical', async () => {
    const scope = await createProject({
      name: 'Verification scope',
      slug: 'verification-scope-x',
      purpose: 'TECHNICAL',
    });
    const scopeLayer = await createLayer({
      projectId: scope.id,
      name: 'Scope layer',
      orderIndex: 1,
    });
    const run = await createRun({
      projectId: scope.id,
      layerId: scopeLayer.id,
      runType: 'FOUNDATION',
      provider: 'WORKER',
    });
    await createOrchestration({
      projectId: scope.id,
      layerId: scopeLayer.id,
      runId: run.id,
      title: 'Ordinary-looking work in a technical scope',
      assignment: 'prove something',
      provider: 'WORKER',
    });
    const work = await workForProject({ projectId: scope.id });
    // The project's own classification outranks the row's: a perfectly ordinary
    // packet inside the verifier's scope is not somebody's project work.
    expect(work.entries).toHaveLength(0);
    expect(work.technicalHidden).toBe(1);
    const opened = await workForProject({ projectId: scope.id, includeTechnical: true });
    expect(opened.entries[0]!.provenance).toBe('TECHNICAL_SCOPE');
  });

  it('puts a packet waiting for approval in Waiting, not Up next', async () => {
    // Stopped, with a person as the reason. Calling it "next" would hide that.
    expect(groupOfOrchestration('AWAITING_APPROVAL')).toBe('WAITING');
    expect(groupOfOrchestration('QUEUED')).toBe('UP_NEXT');
    expect(groupOfOrchestration('RESEARCHING')).toBe('WORKING_NOW');
    expect(groupOfOrchestration('COMPLETE_WITH_GAPS')).toBe('FINISHED');
  });

  it('classifies bins by state and kind rather than by name', () => {
    const base = {
      state: 'READY' as const,
      kind: 'RESEARCH_PACKET',
    };
    expect(groupOfBin({ ...base, state: 'LEASED' } as never)).toBe('WORKING_NOW');
    expect(groupOfBin({ ...base, state: 'DRAFT' } as never)).toBe('EXPLORING');
    expect(groupOfBin({ ...base, state: 'NEEDS_HUMAN' } as never)).toBe('WAITING');
    expect(provenanceOfBinKind('RUSSELL_TURN')).toBe('CONVERSATION');
    expect(provenanceOfBinKind('DETERMINISTIC_CHECK')).toBe('HARNESS');
    // An unrecognised kind is somebody's work, because the failure that matters
    // is hiding real work rather than showing one extra harness row.
    expect(provenanceOfBinKind('SOMETHING_NEW')).toBe('PROJECT');
  });

  it('splits into the five groups a person reads', async () => {
    await packet({ title: 'Running', status: 'RESEARCHING' });
    await packet({ title: 'Queued', status: 'QUEUED' });
    const work = await workForProject({ projectId: project.id });
    const groups = groupWork(work.entries);
    expect(groups.map((group) => group.group)).toEqual([
      'WORKING_NOW',
      'UP_NEXT',
      'EXPLORING',
      'WAITING',
      'FINISHED',
    ]);
    expect(groups[0]!.entries.map((entry) => entry.title)).toEqual(['Running']);
    expect(groups[1]!.entries.map((entry) => entry.title)).toEqual(['Queued']);
  });
});

describe('Ideas is a tree with real cross-links, not a decorated list', () => {
  it('puts the site at the root with its major ideas beneath it', async () => {
    const map = await ideaMapForProject({ projectId: project.id, viewerUserId: ownerId });
    expect(map).not.toBeNull();
    expect(map!.rootId).toBe(`site:${project.id}`);
    const majors = childrenOf(map!, map!.rootId).filter((node) => node.level === 'MAJOR');
    expect(majors.length).toBeGreaterThan(0);
    // The layer's internal name never reaches a person.
    expect(majors.some((node) => node.title === 'Monetization Logic')).toBe(false);
  });

  it('files an idea under the layer its own mission names, and says so when it cannot', async () => {
    const filed = await createCandidate({
      projectId: project.id,
      visibility: 'SHARED',
      title: 'A filed idea',
      statement: 'it belongs somewhere',
    });
    await launchMission({
      projectId: project.id,
      layerId,
      visibility: 'SHARED',
      objective: 'work on the filed idea',
      whyNow: 'because',
      idempotencyKey: 'k-filed',
      candidateId: filed.id,
    });
    const loose = await createCandidate({
      projectId: project.id,
      visibility: 'SHARED',
      title: 'An unfiled idea',
      statement: 'nothing has been launched for it',
    });

    const map = await ideaMapForProject({ projectId: project.id, viewerUserId: ownerId });
    const filedNode = map!.nodes.find((node) => node.id === `idea:${filed.id}`);
    const looseNode = map!.nodes.find((node) => node.id === `idea:${loose.id}`);
    expect(filedNode!.parentId).toBe(`major:${layerId}`);
    // Not forced under an arbitrary heading to make the map tidy.
    expect(looseNode!.parentId).toBe(`site:${project.id}`);
    expect(looseNode!.links.layerId).toBeNull();
  });

  it('carries Russell’s priority label and reason onto the idea', async () => {
    const captured = await createCandidate({
      projectId: project.id,
      visibility: 'SHARED',
      title: 'A judged idea',
      statement: 'worth doing',
    });
    await recordJudgment({
      candidateId: captured.id,
      state: 'PROMOTED',
      priority: 'MUST_DO',
      ordinal: 1,
      confidence: 80,
      reason: 'it unblocks everything else',
      judgment: {},
    });
    const map = await ideaMapForProject({ projectId: project.id, viewerUserId: ownerId });
    const node = map!.nodes.find((n) => n.id === `idea:${captured.id}`)!;
    expect(node.priorityLabel).toBe('Must do');
    expect(node.why).toBe('it unblocks everything else');
  });

  it('gives a breadcrumb that ends where you are', async () => {
    const map = await ideaMapForProject({ projectId: project.id, viewerUserId: ownerId });
    const major = map!.nodes.find((node) => node.level === 'MAJOR')!;
    const trail = pathTo(map!, major.id);
    expect(trail[0]!.id).toBe(map!.rootId);
    expect(trail[trail.length - 1]!.id).toBe(major.id);
  });

  it('does not count another person’s private conversations', async () => {
    const other = await createUser({
      email: 'other@example.test',
      displayName: 'Somebody else',
      password: 'a-long-enough-password',
      isBrainAdmin: false,
    });
    await createConversation({
      ownerUserId: other.id,
      title: 'Their private thread',
      projectId: project.id,
      visibility: 'PRIVATE',
    });
    await createConversation({
      ownerUserId: ownerId,
      title: 'My own thread',
      projectId: project.id,
      visibility: 'PRIVATE',
    });
    const map = await ideaMapForProject({ projectId: project.id, viewerUserId: ownerId });
    const site = map!.nodes.find((node) => node.id === map!.rootId)!;
    // A count is a disclosure. Two would say a thread exists that this person
    // may not open.
    expect(site.counts.conversations).toBe(1);
  });
});

describe('Who is role-gated at the server, not in the client', () => {
  it('gives an administrator the surfaces and a member none at all', async () => {
    const admin = personPrincipal({
      id: ownerId,
      memberships: await membershipsFor(ownerId),
    });
    const operatorView = await whoForProject({ principal: admin, projectId: project.id });
    expect(operatorView!.depth).toBe('OPERATOR');
    expect(operatorView!.surfaces).not.toBeNull();

    const viewer = await createUser({
      email: 'viewer@example.test',
      displayName: 'A viewer',
      password: 'a-long-enough-password',
      isBrainAdmin: false,
    });
    await grantMembership({
      projectId: project.id,
      principalType: 'HUMAN',
      principalId: viewer.id,
      role: 'VIEWER',
      scopes: [],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const viewerView = await whoForProject({
      principal: personPrincipal({ id: viewer.id, memberships: await membershipsFor(viewer.id) }),
      projectId: project.id,
    });
    expect(viewerView!.depth).toBe('COLLABORATOR');
    // Not a filtered copy — the field is absent, because the server never built
    // it. A field removed in the client is a field that was still sent.
    expect(viewerView!.surfaces).toBeNull();
    expect(viewerView!.capacityExplanation).not.toMatch(/\d/);
  });

  it('does not hand a viewer other people’s email addresses', async () => {
    const viewer = await createUser({
      email: 'viewer2@example.test',
      displayName: 'Another viewer',
      password: 'a-long-enough-password',
      isBrainAdmin: false,
    });
    await grantMembership({
      projectId: project.id,
      principalType: 'HUMAN',
      principalId: viewer.id,
      role: 'VIEWER',
      scopes: [],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const view = await whoForProject({
      principal: personPrincipal({ id: viewer.id, memberships: await membershipsFor(viewer.id) }),
      projectId: project.id,
    });
    expect(view!.people.length).toBeGreaterThan(0);
    expect(view!.people.every((person) => person.email === null)).toBe(true);
  });

  it('refuses a worker by principal type, whatever its membership says', async () => {
    const worker: Principal = {
      type: 'WORKER',
      id: 'wrk_1',
      handle: 'a-worker',
      displayName: 'a-worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'cred_1',
      authMethod: 'WORKER_BEARER',
      memberships: await membershipsFor(ownerId),
      requestId: 'req_w',
    };
    // No membership configuration turns a machine into a person, and the screen
    // that describes the machines is the last one a machine should reach.
    expect(await whoForProject({ principal: worker, projectId: project.id })).toBeNull();
  });

  it('never returns a secret name, a digest or a credential', async () => {
    const admin = personPrincipal({ id: ownerId, memberships: await membershipsFor(ownerId) });
    const view = await whoForProject({ principal: admin, projectId: project.id });
    const serialized = JSON.stringify(view);
    for (const forbidden of ['tokenDigest', 'tokenSecretName', 'credential', 'secret', 'brnw_']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('progress is milestone-backed everywhere or it is not a number', () => {
  it('uses the project’s own layers as the milestone set', async () => {
    const progress = await projectProgress({
      projectId: project.id,
      projectName: project.name,
    });
    const layers = await listLayers(project.id);
    expect(progress.ratio).toEqual({
      done: layers.filter((layer) => layer.status === 'FROZEN').length,
      total: layers.length,
    });
    expect(progress.completed.length + progress.missing.length).toBe(layers.length);
  });

  it('reports the build from a declared ledger rather than from row counts', () => {
    const before = buildProgress();
    expect(before.ratio).toEqual({
      done: BUILD_MILESTONES.filter((milestone) => milestone.done).length,
      total: BUILD_MILESTONES.length,
    });
    // Step 12A is open, and nothing a test inserts can close it. A build that
    // advanced because somebody wrote rows would be measuring the wrong thing.
    expect(BUILD_MILESTONES.find((milestone) => milestone.key === 'S12A')!.done).toBe(false);
  });

  it('never invents a denominator for an open-ended set', () => {
    const open = progressOf({
      milestones: [{ key: 'a', title: 'a', done: true, detail: null }],
      closed: false,
      started: true,
      blockedBy: [],
      noun: 'this work',
    });
    expect(open.ratio).toBeNull();
    expect(open.headline).not.toMatch(/\d+ of \d+/);
  });

  it('lets blocking outrank every other stage', () => {
    expect(stageFor({ done: 8, total: 8, started: true, blocked: true })).toBe('BLOCKED');
    expect(stageFor({ done: 0, total: 8, started: true, blocked: true })).toBe('BLOCKED');
  });

  it('says a blocked project is blocked, and names the reason', async () => {
    await getDb().run("UPDATE layers SET status = 'BLOCKED' WHERE id = ?", [layerId]);
    const fresh = await getProject(project.id);
    const progress = await projectProgress({
      projectId: fresh!.id,
      projectName: fresh!.name,
    });
    expect(progress.stage).toBe('BLOCKED');
    expect(progress.blockedBy.length).toBeGreaterThan(0);
    expect(progress.headline).toMatch(/^Blocked: /);
  });
});

describe('the person reading is always on the Who list', () => {
  it('shows a Brain administrator who reaches the project without a membership row', async () => {
    // Their access is real; it comes from `isBrainAdmin` rather than from a
    // membership. The first version of this screen told the only person
    // looking at it that nobody was on the project.
    const admin = personPrincipal({ id: 'usr_admin', isBrainAdmin: true, memberships: [] });
    const view = await whoForProject({ principal: admin, projectId: project.id });
    expect(view!.depth).toBe('OPERATOR');
    const you = view!.people.find((person) => person.isYou);
    expect(you).toBeDefined();
    expect(you!.roleLabel).toBe('Brain administrator');
  });

  it('does not list them twice when they do have a membership', async () => {
    const owner = personPrincipal({ id: ownerId, memberships: await membershipsFor(ownerId) });
    const view = await whoForProject({ principal: owner, projectId: project.id });
    expect(view!.people.filter((person) => person.id === ownerId)).toHaveLength(1);
    expect(view!.people.find((person) => person.id === ownerId)!.roleLabel).toBe('Owner');
  });
});
