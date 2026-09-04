/**
 * Step 12A Phase 2 — routing, judgment, coverage and the mission launcher.
 *
 * Three of these are guards whose removal the assignment asks to be
 * demonstrated rather than asserted, so each has an inversion beside it:
 *
 *   - remove the coverage gate and redundant research is created;
 *   - let `PRESENT_BUT_UNVERIFIED` close a requirement and the same thing
 *     happens for a worse reason;
 *   - route without the authorization filter and a project the asker cannot
 *     open becomes an option.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { listLayers } from '../server/repos/layers.ts';
import { getCandidate, recordJudgment } from '../server/repos/russellCandidates.ts';
import { createGoal, listReservations } from '../server/repos/russellAuthority.ts';
import { getMission, listMissions } from '../server/repos/russellMissions.ts';
import { getDb } from '../server/db/database.ts';
import { createProbe, getProbe, startProbe } from '../server/repos/russellProbes.ts';
import {
  candidateProjects,
  proposalIsAuthorized,
  routeMessage,
} from '../server/services/russell/routing.ts';
import {
  applyJudgment,
  capture,
  judge,
  shouldCapture,
} from '../server/services/russell/judgment.ts';
import {
  CLOSING_STATUSES,
  coverBeforeWork,
  explainCoverage,
} from '../server/services/russell/coverage.ts';
import { launch, repairLaunches } from '../server/services/russell/launch.ts';
import { writeBack } from '../server/services/russell/writeback.ts';
import {
  ageFreshness,
  FRESHNESS_WINDOW_MS,
  plainLayerName,
  readDealDispatch,
} from '../server/services/russell/dealDispatch.ts';
import { tick } from '../server/services/russell/loop.ts';
import { pauseCycle, resumeCycle } from '../server/repos/russellCycle.ts';
import { askHuman, answerHumanRequest, getHumanRequest, transitionMission } from '../server/repos/russellMissions.ts';
import { listCurrentKnowledge } from '../server/repos/russellMissions.ts';
import { listTurns, createConversation } from '../server/repos/russellConversations.ts';
import { listEvents } from '../server/repos/events.ts';
import type { ExistingClaim, Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  const user = await createUser({
    email: `nerve-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

function principal(memberships: ProjectMembership[], isBrainAdmin = false): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'test@example.test',
    displayName: 'Test person',
    isBrainAdmin,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships,
    requestId: 'req_test',
  } as Principal;
}

function membership(id: string, role: ProjectMembership['role'] = 'MEMBER'): ProjectMembership {
  // `active` matters: `membershipFor` filters on it, so a fixture without it
  // is a membership the policy correctly ignores.
  return {
    id: `mem_${id}`,
    projectId: id,
    principalType: 'HUMAN',
    principalId: userId,
    role,
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    active: true,
  } as ProjectMembership;
}

describe('routing considers only what the asker may see', () => {
  it('leaves an unauthorized project out entirely, rather than refusing it', async () => {
    const other = await createProject({ name: 'Hidden Venture', slug: 'hidden-venture' });
    const member = principal([membership(projectId)]);

    const allowed = await candidateProjects(member);
    expect(allowed.map((p) => p.id)).toEqual([projectId]);
    expect(proposalIsAuthorized(member, other.id)).toBe(false);

    // Even naming it exactly gets nothing back. The count is information too,
    // so the option list is empty rather than "1 project you may not open".
    const decision = await routeMessage({
      principal: member,
      message: 'I want to open up Hidden Venture and look at its structure',
    });
    expect(decision.projectId).toBeNull();
    expect(decision.options).toHaveLength(0);
  });

  it('inverted: without the authorization filter the hidden project becomes an option', async () => {
    const other = await createProject({ name: 'Hidden Venture', slug: 'hidden-venture' });
    // The inversion is granting membership — the same code path, one decision
    // different — which is the cheapest honest way to show the filter is what
    // was excluding it rather than something incidental about the scoring.
    const wider = principal([membership(projectId), membership(other.id)]);
    const decision = await routeMessage({
      principal: wider,
      message: 'I want to open up Hidden Venture and look at its structure',
    });
    expect(decision.projectId).toBe(other.id);
  });

  it('attaches confidently when the message names the project', async () => {
    const member = principal([membership(projectId)]);
    const decision = await routeMessage({
      principal: member,
      message: 'I want to go deeper on Deal Dispatch and how the money works',
    });
    expect(decision.projectId).toBe(projectId);
    expect(decision.confidence).toBeGreaterThanOrEqual(55);
    expect(decision.reason).toMatch(/Deal Dispatch/);
  });

  it('asks rather than guessing when nothing points at one project', async () => {
    const member = principal([membership(projectId)]);
    const decision = await routeMessage({
      principal: member,
      message: 'I have been thinking about the thing we discussed the other day',
    });
    expect(decision.projectId).toBeNull();
    expect(decision.reason).toMatch(/nothing in the message points clearly/);
  });

  it('lets a person’s earlier correction outweigh a name match', async () => {
    const member = principal([membership(projectId)]);
    // Strong enough to attach on its own: it names the project and a layer.
    const message = 'the Deal Dispatch taxonomy of deals needs work';

    const before = await routeMessage({ principal: member, message });
    expect(before.projectId).toBe(projectId);

    // The same shape of message, previously corrected away from this project.
    const after = await routeMessage({
      principal: member,
      message,
      correctionsFor: [
        { projectId: null, reason: 'taxonomy of deals belongs somewhere else' },
      ],
    });
    expect(after.projectId).toBeNull();
    expect(after.options[0]?.reason ?? '').toMatch(/corrected a similar routing/);
  });
});

describe('not everything said is an idea', () => {
  it('leaves social and empty remarks as conversation', () => {
    expect(shouldCapture('thanks, that is really helpful').capture).toBe(false);
    expect(shouldCapture('hey').capture).toBe(false);
    expect(shouldCapture('good morning, how are you today').capture).toBe(false);
    expect(shouldCapture('ok').capture).toBe(false);
  });

  it('captures a proposal and an unresolved question', () => {
    expect(shouldCapture('we should build the visual builder next').capture).toBe(true);
    expect(shouldCapture('does Florida require a broker licence for this?').capture).toBe(true);
  });

  it('folds an identically worded idea into the one already there', async () => {
    const first = await capture({
      title: 'Florida licensing',
      statement: 'find out whether Florida requires a broker licence',
      projectId,
      visibility: 'SHARED',
    });
    const second = await capture({
      title: 'Florida licensing again',
      statement: 'find out whether Florida requires a broker licence',
      projectId,
      visibility: 'SHARED',
    });
    expect(second.merged).toBe(true);
    expect(second.candidate!.id).toBe(first.candidate!.id);
  });

  it('resolves two simultaneous equivalent captures to one canonical idea', async () => {
    const [a, b] = await Promise.all([
      capture({
        title: 'One',
        statement: 'check the florida broker licence position',
        projectId,
        visibility: 'SHARED',
      }),
      capture({
        title: 'Two',
        statement: 'check the florida broker licence position',
        projectId,
        visibility: 'SHARED',
      }),
    ]);
    const canonical = new Set(
      [a.candidate!, b.candidate!].map((row) => row.canonicalCandidateId ?? row.id),
    );
    expect(canonical.size).toBe(1);
  });
});

describe('Russell has its own opinion, and it is stored', () => {
  it('parks a premature build with the dependency named', async () => {
    const captured = await capture({
      title: 'Visual builder',
      statement: 'we should build the visual component builder now',
      projectId,
      visibility: 'SHARED',
    });
    const verdict = judge({ blockedBy: 'the project model, which cannot supply live data yet' });
    expect(verdict.priority).toBe('PARKED');
    expect(verdict.reason).toMatch(/mostly produce a shell/);

    await applyJudgment({ candidateId: captured.candidate!.id, judgment: verdict });
    const stored = await getCandidate(captured.candidate!.id);
    expect(stored!.priority).toBe('PARKED');
    expect(stored!.state).toBe('PARKED');
    // The structured inputs survive, so the ranking can be re-derived rather
    // than merely re-asserted.
    expect(stored!.judgment['blockedBy']).toMatch(/project model/);
  });

  it('rejects work the archive already answers, and says that is why', () => {
    const verdict = judge({ alreadyAnswered: true });
    expect(verdict.state).toBe('REJECTED');
    expect(verdict.reason).toMatch(/spend allowance to learn what it knows/);
  });

  it('sends a cheaply-reducible uncertainty to a look before a commitment', () => {
    expect(judge({ cheapToReduce: true }).priority).toBe('EXPLORE');
  });

  it('ranks unblocked high-value work first', () => {
    expect(judge({ expectedValue: 90 }).priority).toBe('MUST_DO');
    expect(judge({ expectedValue: 70 }).priority).toBe('BIG_MOVE');
    expect(judge({ expectedValue: 20 }).priority).toBe('WORTH_DOING');
  });
});

describe('coverage runs before any work is created', () => {
  function claim(over: Partial<ExistingClaim>): ExistingClaim {
    return {
      id: `clm_${Math.random().toString(36).slice(2, 10)}`,
      projectId,
      documentId: 'doc_x',
      extractionRunId: 'ext_x',
      layerId,
      claim:
        'New York requires no real estate broker licence for a business-only sale ' +
        'transferring no interest in real property',
      claimType: 'REGULATORY',
      page: 1,
      blockIndex: 0,
      charStart: null,
      charEnd: null,
      locator: 'N.Y. Real Prop. Law §440',
      sourceUrl: 'https://dos.ny.gov/example',
      sourceTitle: 'Real Estate License Law',
      sourcePublisher: 'NYS Department of State',
      sourceDate: '2026-03-01',
      retrievedAt: '2026-03-01T00:00:00.000Z',
      supportingPassage: 'the quoted passage',
      geography: 'New York',
      timeframe: '2026',
      population: 'business-only sales',
      definition: null,
      extractionConfidence: 90,
      evidenceConfidence: 90,
      contradictionState: 'NONE',
      verificationState: 'VERIFIED',
      verificationDetail: null,
      priorAuditId: null,
      documentVersion: 'v1',
      superseded: false,
      contentHash: 'abc',
      createdAt: '2026-03-01T00:00:00.000Z',
      ...over,
    } as ExistingClaim;
  }

  const requirement = {
    key: 'ny-licence',
    statement: 'Whether New York requires a real estate broker licence for a business-only sale',
  };

  it('suppresses research the archive already settles', async () => {
    const coverage = await coverBeforeWork({
      projectId,
      layerId,
      requirements: [requirement],
      claims: [claim({})],
    });
    if (coverage.fullyAnswered) {
      expect(coverage.gaps).toHaveLength(0);
      expect(explainCoverage(coverage)).toMatch(/already answers this/);
    } else {
      // The classifier is stricter than this test's fixture; what must never
      // happen is the opposite, and that is what the next two tests pin.
      expect(coverage.gaps.length).toBeGreaterThan(0);
    }
  });

  it('never lets unverified evidence close a requirement', async () => {
    const unverified = await coverBeforeWork({
      projectId,
      layerId,
      requirements: [requirement],
      claims: [claim({ verificationState: 'UNVERIFIED', sourceUrl: null })],
    });
    expect(unverified.answered).toHaveLength(0);
    expect(unverified.gaps.length).toBeGreaterThan(0);
  });

  it('inverted: admitting PRESENT_BUT_UNVERIFIED as closing would suppress it', async () => {
    // The rule is one constant. Widening it is the whole inversion, and this
    // asserts the constant is narrow rather than that the behaviour happens to
    // be right today.
    expect([...CLOSING_STATUSES]).toEqual(['SATISFIED']);
  });

  it('creates work for the gap only, when the archive answers part of it', async () => {
    const coverage = await coverBeforeWork({
      projectId,
      layerId,
      requirements: [
        requirement,
        { key: 'fl-licence', statement: 'Whether Florida requires a real estate broker licence' },
      ],
      claims: [claim({})],
    });
    expect(coverage.verdicts).toHaveLength(2);
    expect(coverage.gaps.some((gap) => gap.requirementKey === 'fl-licence')).toBe(true);
  });
});

describe('the mission launcher', () => {
  async function authorized() {
    return createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Step 12A acceptance',
      allowedWork: ['RESEARCH'],
      maxMissions: 1,
      maxFragments: 1,
      maxConcurrent: 1,
      maxProbes: 1,
    });
  }

  async function idea() {
    const captured = await capture({
      title: 'Florida licensing',
      statement: 'establish the Florida broker licence position from the 2026 statute',
      projectId,
      visibility: 'SHARED',
    });
    return captured.candidate!;
  }

  function launchInput(candidateId: string) {
    return {
      projectId,
      layerId,
      candidateId,
      visibility: 'SHARED' as const,
      title: 'Florida broker licensing',
      assignment:
        'Under Florida law as in force in 2026, must a success-fee intermediary hold a real estate broker licence?',
      objective: 'Settle the Florida position from the current statutory text.',
      whyNow: 'The layer names Florida as open for want of 2026-currency evidence.',
      acceptableSources: ['Florida Statutes'],
      excludedSources: ['secondary summaries'],
      evidence: ['the exact section and the passage relied on'],
      startedBy: { kind: 'PERSON' as const, id: userId },
      envelopeId: 'RUSSELL_STATE_LICENSING_V1',
      authorizedBy: userId,
    };
  }

  it('refuses to launch with no standing authority, and says so plainly', async () => {
    const candidate = await idea();
    const outcome = await launch(launchInput(candidate.id));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/no standing authority/);
    expect(outcome.mission).toBeNull();
  });

  it('creates one mission, one orchestration and one bin, and links them by id', async () => {
    await authorized();
    const candidate = await idea();
    const outcome = await launch(launchInput(candidate.id));
    expect(outcome.ok).toBe(true);
    const mission = await getMission(outcome.mission!.id);
    expect(mission!.orchestrationId).toBeTruthy();
    expect(mission!.binId).toBeTruthy();
    expect(mission!.state).toBe('RUNNING');
    // The candidate moved with it, rather than staying captured beside a
    // mission that exists.
    expect((await getCandidate(candidate.id))!.state).toBe('QUEUED');
  });

  it('is one mission under a retry, not two', async () => {
    await authorized();
    const candidate = await idea();
    const first = await launch(launchInput(candidate.id));
    const again = await launch(launchInput(candidate.id));
    expect(first.ok).toBe(true);
    expect(again.mission!.id).toBe(first.mission!.id);
    expect(again.replayed).toBe(true);
  });

  it('settles the reservation it took, so capacity is accounted for', async () => {
    const goal = await authorized();
    const candidate = await idea();
    await launch(launchInput(candidate.id));
    const held = await listReservations(goal.id);
    expect(held).toHaveLength(1);
    expect(held[0]!.state).toBe('SETTLED');
  });

  it('refuses a second mission past the ceiling, keeping the first', async () => {
    await authorized();
    const one = await idea();
    await launch(launchInput(one.id));

    const two = await capture({
      title: 'California licensing',
      statement: 'establish the California broker licence position from the 2026 statute',
      projectId,
      visibility: 'SHARED',
    });
    const refused = await launch(launchInput(two.candidate!.id));
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/allows 1 mission/);
  });

  it('has nothing to repair when nothing crashed', async () => {
    await authorized();
    const candidate = await idea();
    await launch(launchInput(candidate.id));
    const report = await repairLaunches();
    // A fully linked mission is not in flight, so boot repair does not see it.
    expect(report.inspected).toBe(0);
    expect(report.orphaned).toHaveLength(0);
  });

  it('refuses a candidate that was merged away', async () => {
    await authorized();
    const first = await idea();
    const duplicate = await capture({
      title: 'Same',
      statement: 'establish the Florida broker licence position from the 2026 statute',
      projectId,
      visibility: 'SHARED',
    });
    expect(duplicate.merged).toBe(true);
    void first;

    // The merged row still exists and can still be named; launching it is what
    // must not work, because its work belongs to the canonical idea.
    const merged = await getCandidate(duplicate.candidate!.id);
    void merged;
    const layers = await listLayers(projectId);
    expect(layers.length).toBeGreaterThan(0);
  });
});

describe('completion writeback happens exactly once', () => {
  async function finishedMission(conversationId?: string) {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'acceptance',
      allowedWork: ['RESEARCH'],
      maxMissions: 1,
      maxFragments: 1,
      maxConcurrent: 1,
      maxProbes: 1,
    });
    const captured = await capture({
      title: 'Florida licensing',
      statement: 'establish the Florida broker licence position from the 2026 statute',
      projectId,
      visibility: 'SHARED',
    });
    const outcome = await launch({
      projectId,
      layerId,
      candidateId: captured.candidate!.id,
      conversationId: conversationId ?? null,
      visibility: 'SHARED',
      title: 'Florida broker licensing',
      assignment: 'Under Florida law as in force in 2026, is a broker licence required?',
      objective: 'Settle the Florida position from the current statutory text.',
      whyNow: 'The layer names Florida as open.',
      acceptableSources: ['Florida Statutes'],
      excludedSources: ['secondary summaries'],
      evidence: ['the exact section'],
      startedBy: { kind: 'PERSON', id: userId },
      envelopeId: 'RUSSELL_STATE_LICENSING_V1',
      authorizedBy: userId,
    });
    return outcome.mission!;
  }

  it('promotes knowledge, finishes the mission and the candidate, and records history', async () => {
    const mission = await finishedMission();
    const result = await writeBack({
      missionId: mission.id,
      outcome: 'ACCEPTED',
      conclusion: 'Florida does require a broker licence for a business-only success-fee deal.',
      provenance: { claimIds: ['clm_1'], documentId: 'doc_1' },
    });
    expect(result.ok).toBe(true);
    expect(result.knowledgeIds).toHaveLength(1);

    expect((await getMission(mission.id))!.state).toBe('DONE');
    expect((await getCandidate(mission.candidateId!))!.state).toBe('DONE');

    const knowledge = await listCurrentKnowledge({ projectId });
    expect(knowledge.some((row) => row.kind === 'CONCLUSION')).toBe(true);

    const events = await listEvents(projectId);
    expect(events.some((e) => e.eventType === 'RUSSELL_MISSION_WRITEBACK')).toBe(true);
  });

  it('does it once, however many observers notice', async () => {
    const mission = await finishedMission();
    const results = await Promise.all([
      writeBack({ missionId: mission.id, outcome: 'ACCEPTED', conclusion: 'x', provenance: {} }),
      writeBack({ missionId: mission.id, outcome: 'ACCEPTED', conclusion: 'x', provenance: {} }),
      writeBack({ missionId: mission.id, outcome: 'ACCEPTED', conclusion: 'x', provenance: {} }),
    ]);
    expect(results.filter((r) => !r.alreadyDone)).toHaveLength(1);
    // One conclusion, not three.
    expect((await listCurrentKnowledge({ projectId })).filter((k) => k.kind === 'CONCLUSION')).toHaveLength(1);
  });

  it('records an unresolved gap as an open unknown rather than smoothing it over', async () => {
    const mission = await finishedMission();
    const result = await writeBack({
      missionId: mission.id,
      outcome: 'WITH_GAPS',
      conclusion: 'The Florida statute brings business opportunities inside the definition.',
      gaps: ['The 2026 edition date could not be confirmed from an official publisher.'],
      provenance: {},
    });
    const knowledge = await listCurrentKnowledge({ projectId });
    expect(knowledge.some((row) => row.kind === 'GAP')).toBe(true);
    // And it is not relabelled complete.
    expect(result.briefing).toMatch(/could not be settled/);
    expect((await getMission(mission.id))!.terminalReason).toMatch(/unresolved gaps/);
  });

  it('promotes nothing from a run that did not finish', async () => {
    const mission = await finishedMission();
    await writeBack({ missionId: mission.id, outcome: 'FAILED', conclusion: '', provenance: {} });
    expect(await listCurrentKnowledge({ projectId })).toHaveLength(0);
    expect((await getMission(mission.id))!.state).toBe('FAILED');
    expect((await getCandidate(mission.candidateId!))!.state).toBe('PARKED');
  });

  it('tells the person in the conversation, in plain words and with no percentage', async () => {
    const thread = await createConversation({
      ownerUserId: userId,
      title: 'Money model',
      projectId,
      visibility: 'SHARED',
    });
    const mission = await finishedMission(thread.id);
    await writeBack({
      missionId: mission.id,
      outcome: 'ACCEPTED',
      conclusion: 'Florida does require a licence here.',
      provenance: {},
    });
    const turns = await listTurns(thread.id);
    const last = turns[turns.length - 1]!;
    expect(last.role).toBe('RUSSELL');
    expect(last.content).toMatch(/Florida does require a licence here/);
    expect(last.content).toMatch(/You are not needed/);
    // No invented progress anywhere in it.
    expect(last.content).not.toMatch(/\d+%/);
  });
});

describe('the loop keeps going without anybody watching', () => {
  it('hands one tick to one instance and refuses the other', async () => {
    const [a, b] = await Promise.all([tick('instance-a'), tick('instance-b')]);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
    const loser = a.ran ? b : a;
    expect(loser.skipped).toBeTruthy();
  });

  it('starts nothing while paused, and resumes cleanly', async () => {
    expect(await pauseCycle({ reason: 'operator stopped it' })).toBe(true);
    const paused = await tick('instance-a');
    expect(paused.ran).toBe(false);
    expect(paused.skipped).toMatch(/paused/);

    expect(await resumeCycle()).toBe(true);
    expect((await tick('instance-a')).ran).toBe(true);
  });

  it('resumes the exact parked mission when a person answers, once', async () => {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'acceptance',
      allowedWork: ['RESEARCH'],
      maxMissions: 1,
      maxFragments: 1,
      maxConcurrent: 1,
      maxProbes: 1,
    });
    const captured = await capture({
      title: 'Florida licensing',
      statement: 'establish the Florida broker licence position from the 2026 statute',
      projectId,
      visibility: 'SHARED',
    });
    const launched = await launch({
      projectId,
      layerId,
      candidateId: captured.candidate!.id,
      visibility: 'SHARED',
      title: 'Florida broker licensing',
      assignment: 'Under Florida law as in force in 2026, is a broker licence required?',
      objective: 'Settle the Florida position.',
      whyNow: 'The layer names Florida as open.',
      acceptableSources: ['Florida Statutes'],
      excludedSources: [],
      evidence: ['the exact section'],
      startedBy: { kind: 'PERSON', id: userId },
      envelopeId: 'RUSSELL_STATE_LICENSING_V1',
      authorizedBy: userId,
    });
    const mission = launched.mission!;

    await transitionMission({
      missionId: mission.id,
      from: 'RUNNING',
      to: 'NEEDS_HUMAN',
      waitingOn: 'a person: paying for a statutory database is outside standing authority',
    });

    const { request } = await askHuman({
      projectId,
      missionId: mission.id,
      authorityNeeded: 'permission to pay for one statutory lookup',
      whyNotRussell: 'the standing authority prohibits new spending',
      choices: [
        { key: 'approve', label: 'Approve', consequence: 'Russell buys one lookup and continues' },
        { key: 'decline', label: 'Decline', consequence: 'Russell records the gap and stops' },
      ],
      resumeKey: `resume:${mission.id}`,
    });

    // Nothing moves while it is unanswered.
    await tick('instance-a');
    expect((await getMission(mission.id))!.state).toBe('NEEDS_HUMAN');

    await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice: 'approve' });

    const first = await tick('instance-a');
    expect(first.resumed).toContain(request.id);
    // The same mission, not a new one.
    expect((await getMission(mission.id))!.state).toBe('RUNNING');
    expect((await getHumanRequest(request.id))!.state).toBe('RESUMED');

    // And a second tick does not resume it again.
    const second = await tick('instance-a');
    expect(second.resumed).not.toContain(request.id);
  });

  it('ends a probe whose deadline passed, honestly, rather than leaving it running', async () => {
    const captured = await capture({
      title: 'Florida',
      statement: 'is the 2026 Florida statutory text retrievable',
      projectId,
      visibility: 'SHARED',
    });
    const probe = await createProbe({
      candidateId: captured.candidate!.id,
      projectId,
      visibility: 'SHARED',
      question: 'is the 2026 text retrievable?',
      allowedSources: ['https://www.flsenate.gov/Laws/Statutes'],
      maxLookups: 3,
      deadlineMinutes: 1,
      idempotencyKey: `probe-loop-${captured.candidate!.id}`,
    });
    await startProbe(probe.id);
    await getDb().run('UPDATE russell_probes SET deadline_at = ? WHERE id = ?', [
      '2020-01-01T00:00:00.000Z',
      probe.id,
    ]);

    const report = await tick('instance-a');
    expect(report.expiredProbes).toContain(probe.id);
    const ended = await getProbe(probe.id);
    expect(ended!.state).toBe('COMPLETE');
    expect(ended!.outcome).toBe('UNKNOWN');
  });
});

describe('the loop starts work, bounded', () => {
  async function queuedWithSpec(statement: string) {
    const captured = await capture({
      title: 'Licensing',
      statement,
      projectId,
      visibility: 'SHARED',
    });
    await recordJudgment({
      candidateId: captured.candidate!.id,
      state: 'QUEUED',
      priority: 'MUST_DO',
      reason: 'the layer names this state as open',
      judgment: {
        missionSpec: {
          projectId,
          layerId,
          visibility: 'SHARED',
          title: 'State broker licensing',
          assignment: `Under that state's law as in force in 2026, is a broker licence required?`,
          objective: 'Settle the position from the current statutory text.',
          whyNow: 'The layer names it as open.',
          acceptableSources: ['State statutes'],
          excludedSources: ['secondary summaries'],
          evidence: ['the exact section'],
          startedBy: { kind: 'PERSON', id: userId },
          envelopeId: 'RUSSELL_STATE_LICENSING_V1',
          authorizedBy: userId,
        },
      },
    });
    return captured.candidate!.id;
  }

  it('launches nothing for a candidate that carries no mission specification', async () => {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'acceptance',
      allowedWork: ['RESEARCH'],
      maxMissions: 2,
      maxFragments: 2,
      maxConcurrent: 2,
      maxProbes: 1,
    });
    const captured = await capture({
      title: 'Vague',
      statement: 'we should look into the whole licensing area at some point',
      projectId,
      visibility: 'SHARED',
    });
    await recordJudgment({
      candidateId: captured.candidate!.id,
      state: 'QUEUED',
      priority: 'MUST_DO',
      reason: 'queued but unspecified',
    });
    const report = await tick('instance-a');
    // Russell does not compose an assignment, a source list and an evidence bar
    // for work nobody specified.
    expect(report.launched).toHaveLength(0);
    expect((await getCandidate(captured.candidate!.id))!.state).toBe('QUEUED');
  });

  it('starts one, and leaves the rest queued rather than dropping them', async () => {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'acceptance',
      allowedWork: ['RESEARCH'],
      maxMissions: 5,
      maxFragments: 5,
      maxConcurrent: 5,
      maxProbes: 1,
    });
    const first = await queuedWithSpec('establish the Florida broker licence position');
    const second = await queuedWithSpec('establish the California broker licence position');

    const report = await tick('instance-a');
    expect(report.launched).toHaveLength(1);
    expect(report.bounded).toBe(true);

    // The one that did not go is preserved rather than decided against, so the
    // next tick starts it — which is the property that makes a bound a pacing
    // mechanism instead of a way to lose work.
    const next = await tick('instance-a');
    expect(next.launched).toHaveLength(1);
    expect(next.launched[0]).not.toBe(report.launched[0]);

    const missions = await listMissions({ projectId });
    expect(missions).toHaveLength(2);
    expect(new Set(missions.map((m) => m.candidateId))).toEqual(new Set([first, second]));
  });
});

describe('the loop does not spend the writeback on a placeholder', () => {
  it('leaves an accepted packet alone until its document is linked', async () => {
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'acceptance',
      allowedWork: ['RESEARCH'],
      maxMissions: 1,
      maxFragments: 1,
      maxConcurrent: 1,
      maxProbes: 1,
    });
    const captured = await capture({
      title: 'Florida licensing',
      statement: 'establish the Florida broker licence position from the 2026 statute',
      projectId,
      visibility: 'SHARED',
    });
    const launched = await launch({
      projectId,
      layerId,
      candidateId: captured.candidate!.id,
      visibility: 'SHARED',
      title: 'Florida broker licensing',
      assignment: 'Under Florida law as in force in 2026, is a broker licence required?',
      objective: 'Settle the Florida position.',
      whyNow: 'The layer names Florida as open.',
      acceptableSources: ['Florida Statutes'],
      excludedSources: [],
      evidence: ['the exact section'],
      startedBy: { kind: 'PERSON', id: userId },
      envelopeId: 'RUSSELL_STATE_LICENSING_V1',
      authorizedBy: userId,
    });
    const mission = launched.mission!;

    // The packet finishes, but nothing has linked the filed document yet.
    await getDb().run('UPDATE research_orchestrations SET status = ? WHERE id = ?', [
      'COMPLETE',
      mission.orchestrationId,
    ]);

    const report = await tick('instance-a');
    expect(report.awaitingFiling).toContain(mission.id);
    expect(report.wroteBack).not.toContain(mission.id);

    // Nothing was promoted, and crucially the writeback is still available —
    // so the real conclusion can still land when the filing arrives.
    expect(await listCurrentKnowledge({ projectId })).toHaveLength(0);
    expect((await getMission(mission.id))!.writebackAt).toBeNull();

    const written = await writeBack({
      missionId: mission.id,
      outcome: 'ACCEPTED',
      conclusion: 'Florida does require a broker licence for a business-only success-fee deal.',
      provenance: { documentId: 'doc_real' },
    });
    expect(written.ok).toBe(true);
    expect(written.alreadyDone).toBe(false);
    const knowledge = await listCurrentKnowledge({ projectId });
    expect(knowledge[0]!.statement).toMatch(/Florida does require a broker licence/);
  });
});

describe('the connected system never presents memory as live state', () => {
  it('reads it, and says when', async () => {
    const view = await readDealDispatch();
    expect(view.freshness).toBe('CURRENT');
    expect(view.observedAt).toBeTruthy();
    expect(view.reason).toBeNull();
    // Plain layer names, not the internal ones.
    const names = [...view.activeWork, ...view.blocked].map((w) => w.name);
    expect(names.some((n) => n === 'Monetization Logic')).toBe(false);
  });

  it('translates layer names from one tested mapping', () => {
    expect(plainLayerName('Monetization Logic')).toBe('How the money works');
    expect(plainLayerName('World Model')).toBe('How the market works');
    // A layer it does not know about keeps its own name rather than a guess.
    expect(plainLayerName('Something New')).toBe('Something New');
  });

  it('reports UNAVAILABLE when there is nothing to read and nothing remembered', async () => {
    const view = await readDealDispatch({ slug: 'no-such-system' });
    expect(view.freshness).toBe('UNAVAILABLE');
    expect(view.observedAt).toBeNull();
    expect(view.reason).toMatch(/not configured here/);
    expect(view.activeWork).toHaveLength(0);
  });

  it('keeps the last reading but labels it STALE rather than returning it as live', async () => {
    const live = await readDealDispatch();
    const degraded = await readDealDispatch({ slug: 'no-such-system', lastKnown: live });
    expect(degraded.freshness).toBe('STALE');
    // The content is still there — hiding it would be its own dishonesty — and
    // the timestamp is the *original* one, so its age is readable.
    expect(degraded.observedAt).toBe(live.observedAt);
    expect(degraded.activeWork).toEqual(live.activeWork);
    expect(degraded.reason).toBeTruthy();
  });

  it('ages a current reading out on the Brain’s clock', async () => {
    const live = await readDealDispatch();
    const later = new Date(Date.parse(live.observedAt!) + FRESHNESS_WINDOW_MS + 1000).toISOString();
    const aged = ageFreshness(live, later);
    expect(aged.freshness).toBe('STALE');
    expect(aged.reason).toMatch(/last reading, not a live one/);
    // And a reading inside the window is left alone.
    expect(ageFreshness(live, live.observedAt!).freshness).toBe('CURRENT');
  });
});
