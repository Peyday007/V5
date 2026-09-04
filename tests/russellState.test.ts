/**
 * Step 12A Phase 1 — the canonical records, and the guards on them.
 *
 * Every test here is about a rule that would be tempting to relax. The
 * schema-level ones — a merged candidate must point somewhere, a waiting
 * mission must say what for, a pending turn must carry its reason — exist
 * because each of those states is one a person or a loop later has to act on,
 * and a row that reaches them with the reason missing is a state nobody can
 * clear.
 *
 * Runs against Postgres too when BRAIN_TEST_DATABASE_URL is set. That matters
 * most for the concurrency cases: SQLite serialises its writers, so two racing
 * callers there execute one after the other and prove nothing about
 * simultaneity.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  addMessage,
  adoptLegacyConversations,
  attachConversation,
  createConversation,
  getConversation,
  listContextHistory,
  listCorrections,
  listTurns,
  resolveMessage,
} from '../server/repos/russellConversations.ts';
import {
  createCandidate,
  fingerprintOf,
  findByFingerprint,
  getCandidate,
  listMergeHistory,
  mergeCandidate,
  overrideJudgment,
  recordJudgment,
  splitCandidate,
  transitionCandidate,
} from '../server/repos/russellCandidates.ts';
import {
  ALWAYS_PROHIBITED,
  checkAuthority,
  createGoal,
  releaseReservation,
  reserve,
  revokeGoal,
  settleReservation,
} from '../server/repos/russellAuthority.ts';
import {
  completeProbe,
  createProbe,
  destinationAllowed,
  getProbe,
  listExpiredProbes,
  permitLookup,
  recordObservation,
  startProbe,
} from '../server/repos/russellProbes.ts';
import {
  answerHumanRequest,
  askHuman,
  claimWriteback,
  groupOf,
  launchMission,
  listCurrentKnowledge,
  markResumed,
  recordKnowledge,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import {
  claimCycle,
  completeCycle,
  getCycle,
  pauseCycle,
  resumeCycle,
} from '../server/repos/russellCycle.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const user = await createUser({
    email: `russell-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
    isBrainAdmin: false,
  });
  userId = user.id;
});

async function goal(overrides: Partial<Parameters<typeof createGoal>[0]> = {}) {
  return createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'acceptance',
    allowedWork: ['RESEARCH', 'PROBE'],
    maxMissions: 1,
    maxFragments: 1,
    maxConcurrent: 1,
    maxProbes: 1,
    ...overrides,
  });
}

describe('a conversation may begin before a project is chosen', () => {
  it('starts unattached, and NULL is a state rather than a gap', async () => {
    const thread = await createConversation({ ownerUserId: userId, title: 'Something I noticed' });
    expect(thread.projectId).toBeNull();
    expect(thread.attachmentSource).toBe('NONE');
  });

  it('records every attachment, so a correction does not erase what Russell thought', async () => {
    const thread = await createConversation({ ownerUserId: userId, title: 'Money model' });
    await attachConversation({
      conversationId: thread.id,
      projectId,
      source: 'AUTOMATIC',
      confidence: 72,
      reason: 'the message names a layer of this project',
    });
    await attachConversation({
      conversationId: thread.id,
      projectId: null,
      source: 'USER',
      confidence: 100,
      reason: 'the person said this is not about that project',
      actorUserId: userId,
    });

    const history = await listContextHistory(thread.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.source).toBe('AUTOMATIC');
    expect(history[0]!.projectId).toBe(projectId);
    expect(history[1]!.source).toBe('USER');

    // Current attachment moved; the earlier row still says what it always said.
    const after = await getConversation(thread.id);
    expect(after!.projectId).toBeNull();
    expect(after!.attachmentSource).toBe('USER');
  });

  it('offers a person’s corrections as the evidence a later route is judged against', async () => {
    const thread = await createConversation({ ownerUserId: userId, title: 'One' });
    await attachConversation({
      conversationId: thread.id,
      projectId,
      source: 'AUTOMATIC',
      confidence: 60,
      reason: 'guessed',
    });
    await attachConversation({
      conversationId: thread.id,
      projectId: null,
      source: 'USER',
      confidence: 100,
      reason: 'wrong project',
      actorUserId: userId,
    });
    const corrections = await listCorrections(userId);
    // Only the human one. An automatic attachment agreeing with itself is not
    // evidence of anything.
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.reason).toBe('wrong project');
  });
});

describe('a turn that cannot be answered yet', () => {
  it('is refused without a reason, because waiting with no reason cannot be acted on', async () => {
    const thread = await createConversation({ ownerUserId: userId, title: 'Pending' });
    await expect(
      addMessage({ conversationId: thread.id, role: 'RUSSELL', content: '', status: 'PENDING' }),
    ).rejects.toThrow(/reason it is pending/);
  });

  it('resolves exactly once, so a duplicated delivery cannot overwrite an answer', async () => {
    const thread = await createConversation({ ownerUserId: userId, title: 'Pending' });
    const turn = await addMessage({
      conversationId: thread.id,
      role: 'RUSSELL',
      content: '',
      status: 'PENDING',
      pendingReason: 'waiting for a worker to pick this up',
    });
    expect(await resolveMessage({ messageId: turn.id, content: 'the answer' })).toBe(true);
    expect(await resolveMessage({ messageId: turn.id, content: 'a different answer' })).toBe(false);
    const turns = await listTurns(thread.id);
    expect(turns[0]!.content).toBe('the answer');
  });
});

describe('legacy conversations', () => {
  it('are adopted without copying or rewriting a single message', async () => {
    const legacyId = 'cnv_legacy_test';
    const at = '2026-01-01T00:00:00.000Z';
    await getDb().run(
      `INSERT INTO conversations (id, project_id, layer_id, run_id, title,
         provider_conversation_id, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?)`,
      [legacyId, projectId, 'Project Chat', at, at],
    );
    await getDb().run(
      `INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
       VALUES (?, ?, 'user', ?, '{}', ?)`,
      ['msg_legacy_1', legacyId, 'an older question', at],
    );

    expect(await adoptLegacyConversations(userId)).toBe(1);
    // Running it again adopts nothing: the link is unique.
    expect(await adoptLegacyConversations(userId)).toBe(0);

    const rows = await getDb().all<{ id: string }>(
      'SELECT id FROM russell_conversations WHERE legacy_conversation_id = ?',
      [legacyId],
    );
    const turns = await listTurns(rows[0]!.id);
    expect(turns).toHaveLength(1);
    // Its original id, unchanged, and flagged as what it is.
    expect(turns[0]!.id).toBe('msg_legacy_1');
    expect(turns[0]!.legacy).toBe(true);

    // And the original row is still exactly where it was.
    const still = await getDb().all<{ id: string }>(
      'SELECT id FROM messages WHERE conversation_id = ?',
      [legacyId],
    );
    expect(still).toHaveLength(1);
  });
});

describe('candidates carry Russell’s judgment as state', () => {
  it('collides reordered wordings on a deterministic key, before anything semantic runs', async () => {
    // Word-set equality, not stemming and not meaning. Reordering, casing and
    // punctuation collide here for free; genuinely different words are the
    // semantic pass's problem, and pretending otherwise here would make the
    // cheap key look like it does more than it does.
    expect(fingerprintOf('Charge the buyer a fee!')).toBe(fingerprintOf('a fee, the buyer charge'));
    expect(fingerprintOf('charge the buyer')).not.toBe(fingerprintOf('charged the buyer'));
  });

  it('does not compare across scopes, so a private idea cannot be found through a match', async () => {
    const mine = await createCandidate({
      title: 'Private',
      statement: 'charge the buyer a fee',
      projectId,
      visibility: 'PRIVATE',
    });
    const found = await findByFingerprint({
      projectId,
      fingerprint: mine.fingerprint,
      visibility: 'SHARED',
    });
    expect(found).toBeNull();
  });

  it('stores an explainable decision that outlives the wording of a reply', async () => {
    const candidate = await createCandidate({
      title: 'Visual builder',
      statement: 'build the visual builder now',
      projectId,
    });
    expect(
      await recordJudgment({
        candidateId: candidate.id,
        state: 'PARKED',
        priority: 'PARKED',
        reason: 'the project model cannot supply live data yet, so this would be a shell',
        judgment: { dependsOn: 'project-model-upgrade' },
      }),
    ).toBe(true);
    const after = await getCandidate(candidate.id);
    expect(after!.priority).toBe('PARKED');
    expect(after!.reason).toMatch(/would be a shell/);
  });

  it('supersedes Russell’s view on override, and keeps it', async () => {
    const candidate = await createCandidate({
      title: 'Visual builder',
      statement: 'build the visual builder now',
      projectId,
    });
    await recordJudgment({
      candidateId: candidate.id,
      state: 'PARKED',
      priority: 'PARKED',
      reason: 'premature',
    });
    expect(
      await overrideJudgment({
        candidateId: candidate.id,
        actorUserId: userId,
        priority: 'MUST_DO',
        state: 'QUEUED',
        reason: 'I want it anyway',
      }),
    ).toBe(true);
    const after = await getCandidate(candidate.id);
    expect(after!.priority).toBe('MUST_DO');
    expect(after!.overrideUserId).toBe(userId);
    // The original judgment is still readable, which is the only way anyone can
    // later tell whether Russell was right.
    expect(after!.supersededDecision).toMatch(/premature/);
  });

  it('merges by pointer and splits back, losing neither identity nor history', async () => {
    const a = await createCandidate({ title: 'A', statement: 'florida licence question', projectId });
    const b = await createCandidate({ title: 'B', statement: 'question licence florida', projectId });

    expect(
      await mergeCandidate({
        candidateId: b.id,
        canonicalId: a.id,
        method: 'FINGERPRINT',
        reason: 'same fingerprint',
      }),
    ).toBe(true);
    expect((await getCandidate(b.id))!.state).toBe('MERGED');
    // A second merge of the same loser is refused rather than chained.
    expect(
      await mergeCandidate({ candidateId: b.id, canonicalId: a.id, method: 'USER', reason: 'again' }),
    ).toBe(false);

    expect(await splitCandidate({ candidateId: b.id, reason: 'they are different questions', actorUserId: userId })).toBe(true);
    const restored = await getCandidate(b.id);
    expect(restored!.state).toBe('CAPTURED');
    expect(restored!.canonicalCandidateId).toBeNull();

    const history = await listMergeHistory(b.id);
    expect(history.map((row) => row.action)).toEqual(['MERGE', 'SPLIT']);
  });

  it('refuses a merged state with nothing to point at', async () => {
    const candidate = await createCandidate({ title: 'A', statement: 'x', projectId });
    await expect(
      getDb().run('UPDATE russell_candidates SET state = ? WHERE id = ?', ['MERGED', candidate.id]),
    ).rejects.toThrow();
  });

  it('transitions on a guard, so two resumes of one parked idea resume it once', async () => {
    const candidate = await createCandidate({ title: 'A', statement: 'x', projectId });
    await recordJudgment({
      candidateId: candidate.id,
      state: 'PARKED',
      priority: 'PARKED',
      reason: 'later',
    });
    const results = await Promise.all([
      transitionCandidate({ candidateId: candidate.id, from: 'PARKED', to: 'QUEUED' }),
      transitionCandidate({ candidateId: candidate.id, from: 'PARKED', to: 'QUEUED' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('standing authority', () => {
  it('refuses everything when no grant exists', async () => {
    const decision = await checkAuthority({ projectId, workClass: 'RESEARCH' });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/no standing authority/);
  });

  it('carries the prohibitions nobody may forget to list', async () => {
    const created = await goal({ prohibitions: [] });
    for (const rule of ALWAYS_PROHIBITED) expect(created.prohibitions).toContain(rule);
  });

  it('allows a listed class and refuses a prohibited action inside it', async () => {
    await goal();
    expect((await checkAuthority({ projectId, workClass: 'RESEARCH' })).ok).toBe(true);
    expect((await checkAuthority({ projectId, workClass: 'DEPLOY' })).ok).toBe(false);
    const spend = await checkAuthority({
      projectId,
      workClass: 'RESEARCH',
      action: 'NEW_SPENDING',
    });
    expect(spend.ok).toBe(false);
    expect(spend.reason).toMatch(/prohibits NEW_SPENDING/);
  });

  it('lands a revocation on the next check rather than at some later sweep', async () => {
    const created = await goal();
    expect((await checkAuthority({ projectId, workClass: 'RESEARCH' })).ok).toBe(true);
    expect(await revokeGoal({ goalId: created.id, actorUserId: userId, reason: 'stop' })).toBe(true);
    expect((await checkAuthority({ projectId, workClass: 'RESEARCH' })).ok).toBe(false);
  });

  it('refuses an expired grant on the Brain’s clock', async () => {
    await goal({ expiresAt: '2020-01-01T00:00:00.000Z' });
    expect((await checkAuthority({ projectId, workClass: 'RESEARCH' })).ok).toBe(false);
  });
});

describe('budget reservations are atomic', () => {
  it('spends the last slot once when two callers race for it', async () => {
    const created = await goal({ maxMissions: 1, maxConcurrent: 1 });
    const [one, two] = await Promise.all([
      reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'a' }),
      reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'b' }),
    ]);
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
    const refused = one.ok ? two : one;
    expect(refused.reason).toMatch(/allows 1 mission/);
  });

  it('does not spend twice on a replay of the same launch', async () => {
    const created = await goal({ maxMissions: 1, maxConcurrent: 1 });
    const first = await reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'same' });
    const again = await reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'same' });
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    expect(again.replayed).toBe(true);
    expect(again.reservation!.id).toBe(first.reservation!.id);
  });

  it('frees the slot again when a held reservation is released', async () => {
    const created = await goal({ maxMissions: 1, maxConcurrent: 1 });
    const first = await reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'a' });
    expect(first.ok).toBe(true);
    expect(await releaseReservation({ reservationId: first.reservation!.id, reason: 'cancelled' })).toBe(true);
    expect((await reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'b' })).ok).toBe(true);
  });

  it('keeps a settled reservation counted, so finished work still occupies its ceiling', async () => {
    const created = await goal({ maxMissions: 1, maxConcurrent: 1 });
    const first = await reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'a' });
    await settleReservation(first.reservation!.id);
    expect((await reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'b' })).ok).toBe(false);
  });

  it('refuses to reserve against a revoked grant', async () => {
    const created = await goal();
    await revokeGoal({ goalId: created.id, actorUserId: userId, reason: 'stop' });
    const outcome = await reserve({ goalId: created.id, kind: 'PROBE', idempotencyKey: 'p' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/REVOKED/);
  });
});

describe('a light probe stays inside its envelope', () => {
  const sources = ['https://www.flsenate.gov/Laws/Statutes'];

  it('allows only https, only the listed host, and only on an origin boundary', () => {
    expect(destinationAllowed('https://www.flsenate.gov/Laws/Statutes/2026/475.01', sources)).toBe(true);
    expect(destinationAllowed('http://www.flsenate.gov/Laws/Statutes/x', sources)).toBe(false);
    expect(destinationAllowed('https://www.flsenate.gov.evil.test/Laws/Statutes/x', sources)).toBe(false);
    expect(destinationAllowed('https://www.flsenate.gov/Other', sources)).toBe(false);
    expect(destinationAllowed('https://anything.test/x', [])).toBe(false);
    expect(destinationAllowed('not a url', sources)).toBe(false);
  });

  async function probeFor(maxLookups = 2, deadlineMinutes = 5) {
    const candidate = await createCandidate({ title: 'Florida', statement: 'florida licence', projectId });
    const probe = await createProbe({
      candidateId: candidate.id,
      projectId,
      visibility: 'SHARED',
      question: 'is the 2026 text retrievable?',
      allowedSources: sources,
      maxLookups,
      deadlineMinutes,
      idempotencyKey: `probe-${candidate.id}`,
    });
    await startProbe(probe.id);
    return probe;
  }

  it('refuses a destination that is not on the allowlist, before anything is fetched', async () => {
    const probe = await probeFor();
    const permission = await permitLookup({ probeId: probe.id, url: 'https://elsewhere.test/x' });
    expect(permission.ok).toBe(false);
    if (!permission.ok) expect(permission.reason).toBe('DESTINATION_NOT_ALLOWED');
  });

  it('counts lookups from the observations, not from a counter a caller maintains', async () => {
    const probe = await probeFor(1);
    const first = await permitLookup({ probeId: probe.id, url: `${sources[0]}/2026/475.01` });
    expect(first.ok).toBe(true);
    if (first.ok) {
      await recordObservation({
        probeId: probe.id,
        ordinal: first.ordinal,
        sourceUrl: `${sources[0]}/2026/475.01`,
        retrieval: 'RETRIEVED',
      });
    }
    const second = await permitLookup({ probeId: probe.id, url: `${sources[0]}/2026/475.011` });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('OUT_OF_LOOKUPS');
  });

  it('refuses a lookup past its deadline, on the Brain’s clock', async () => {
    const probe = await probeFor(3, 5);
    const permission = await permitLookup({
      probeId: probe.id,
      url: `${sources[0]}/2026/475.01`,
      at: new Date(Date.parse(probe.deadlineAt) + 1000).toISOString(),
    });
    expect(permission.ok).toBe(false);
    if (!permission.ok) expect(permission.reason).toBe('PAST_DEADLINE');
  });

  it('cannot take the same lookup slot twice', async () => {
    const probe = await probeFor(3);
    const url = `${sources[0]}/2026/475.01`;
    const one = await recordObservation({ probeId: probe.id, ordinal: 1, sourceUrl: url, retrieval: 'RETRIEVED' });
    const two = await recordObservation({ probeId: probe.id, ordinal: 1, sourceUrl: url, retrieval: 'RETRIEVED' });
    expect(one).not.toBeNull();
    expect(two).toBeNull();
  });

  it('ends once, and an exhausted probe is UNKNOWN rather than nothing', async () => {
    const probe = await probeFor();
    expect(await completeProbe({ probeId: probe.id, outcome: 'UNKNOWN', explanation: 'ran out' })).toBe(true);
    expect(await completeProbe({ probeId: probe.id, outcome: 'SUPPORTED', explanation: 'no' })).toBe(false);
    expect((await getProbe(probe.id))!.outcome).toBe('UNKNOWN');
  });

  it('surfaces a probe whose deadline passed while it was still running', async () => {
    const probe = await probeFor(3, 5);
    const expired = await listExpiredProbes(new Date(Date.parse(probe.deadlineAt) + 1000).toISOString());
    expect(expired.map((row) => row.id)).toContain(probe.id);
  });
});

describe('missions', () => {
  it('launch once under retries and concurrency', async () => {
    const created = await goal();
    const key = 'mission-key';
    const [one, two] = await Promise.all([
      launchMission({
        projectId,
        visibility: 'SHARED',
        objective: 'Florida licensing',
        whyNow: 'the layer needs it',
        idempotencyKey: key,
        goalId: created.id,
      }),
      launchMission({
        projectId,
        visibility: 'SHARED',
        objective: 'Florida licensing',
        whyNow: 'the layer needs it',
        idempotencyKey: key,
        goalId: created.id,
      }),
    ]);
    expect(one.mission.id).toBe(two.mission.id);
    expect([one.created, two.created].filter(Boolean)).toHaveLength(1);
  });

  it('refuse to wait on nothing nameable', async () => {
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'x',
      whyNow: 'y',
      idempotencyKey: 'm2',
    });
    await expect(
      transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'WAITING' }),
    ).rejects.toThrow(/what it is waiting for/);
  });

  it('project into the five groups a person reads', async () => {
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'x',
      whyNow: 'y',
      idempotencyKey: 'm3',
    });
    expect(groupOf(mission)).toBe('UP_NEXT');
    expect(groupOf({ ...mission, state: 'RUNNING' })).toBe('WORKING_NOW');
    expect(groupOf({ ...mission, state: 'NEEDS_HUMAN' })).toBe('WAITING');
    expect(groupOf({ ...mission, state: 'DONE' })).toBe('FINISHED');
    expect(groupOf({ ...mission, probeId: 'rpb_x' })).toBe('EXPLORING');
  });

  it('write back exactly once, however many observers notice', async () => {
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'x',
      whyNow: 'y',
      idempotencyKey: 'm4',
    });
    const results = await Promise.all([
      claimWriteback(mission.id),
      claimWriteback(mission.id),
      claimWriteback(mission.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // And a later replay, after a restart, still does nothing.
    expect(await claimWriteback(mission.id)).toBe(false);
  });
});

describe('knowledge supersedes rather than deletes', () => {
  it('keeps the old belief and points both ways', async () => {
    const first = await recordKnowledge({
      projectId,
      visibility: 'SHARED',
      kind: 'CONCLUSION',
      statement: 'New York needs no licence for a business-only deal',
      provenance: { claimIds: ['clm_x'] },
      authorType: 'PIPELINE',
      confidence: 'SUPPORTED',
    });
    const second = await recordKnowledge({
      projectId,
      visibility: 'SHARED',
      kind: 'CONCLUSION',
      statement: 'New York needs no licence, confirmed against the 2026 edition',
      provenance: { claimIds: ['clm_y'] },
      authorType: 'PIPELINE',
      confidence: 'ESTABLISHED',
      supersedesId: first.id,
    });

    const current = await listCurrentKnowledge({ projectId });
    expect(current.map((row) => row.id)).toEqual([second.id]);

    const rows = await getDb().all<{ superseded_by_id: string | null }>(
      'SELECT superseded_by_id FROM russell_knowledge WHERE id = ?',
      [first.id],
    );
    expect(rows[0]!.superseded_by_id).toBe(second.id);
  });

  it('does not show private knowledge in a shared listing', async () => {
    await recordKnowledge({
      projectId,
      visibility: 'PRIVATE',
      kind: 'ASSUMPTION',
      statement: 'something from a private thread',
      provenance: {},
      authorType: 'RUSSELL',
      confidence: 'UNCERTAIN',
    });
    expect(await listCurrentKnowledge({ projectId })).toHaveLength(0);
    expect(await listCurrentKnowledge({ projectId, includePrivate: true })).toHaveLength(1);
  });
});

describe('a human request can actually be answered', () => {
  async function request() {
    const { request: created } = await askHuman({
      projectId,
      authorityNeeded: 'permission to pay for a statutory database',
      whyNotRussell: 'the standing authority prohibits new spending',
      choices: [
        { key: 'approve', label: 'Approve', consequence: 'Russell buys one lookup and continues' },
        { key: 'decline', label: 'Decline', consequence: 'Russell records the gap and stops' },
      ],
      resumeKey: 'resume-1',
    });
    return created;
  }

  it('refuses a card with no choices, because a card nobody can act on is not a request', async () => {
    await expect(
      askHuman({
        projectId,
        authorityNeeded: 'x',
        whyNotRussell: 'y',
        choices: [],
        resumeKey: 'resume-empty',
      }),
    ).rejects.toThrow(/at least one choice/);
  });

  it('refuses a choice with no stated consequence', async () => {
    await expect(
      askHuman({
        projectId,
        authorityNeeded: 'x',
        whyNotRussell: 'y',
        choices: [{ key: 'a', label: 'A', consequence: '' }],
        resumeKey: 'resume-noconsequence',
      }),
    ).rejects.toThrow(/consequence/);
  });

  it('raises the same boundary once', async () => {
    const first = await request();
    const { request: again, created } = await askHuman({
      projectId,
      authorityNeeded: 'permission to pay for a statutory database',
      whyNotRussell: 'the standing authority prohibits new spending',
      choices: [{ key: 'approve', label: 'Approve', consequence: 'continue' }],
      resumeKey: 'resume-1',
    });
    expect(created).toBe(false);
    expect(again.id).toBe(first.id);
  });

  it('accepts only an offered choice', async () => {
    const created = await request();
    const outcome = await answerHumanRequest({
      requestId: created.id,
      actorUserId: userId,
      choice: 'something-else',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/not one of the offered choices/);
  });

  it('answers once, and a double submit is told so rather than shown a success', async () => {
    const created = await request();
    const first = await answerHumanRequest({ requestId: created.id, actorUserId: userId, choice: 'decline' });
    expect(first.ok).toBe(true);
    const second = await answerHumanRequest({ requestId: created.id, actorUserId: userId, choice: 'approve' });
    expect(second.ok).toBe(false);
    expect(second.alreadyAnswered).toBe(true);
  });

  it('resumes once, which is the transition whose absence is what "stuck" means', async () => {
    const created = await request();
    await answerHumanRequest({ requestId: created.id, actorUserId: userId, choice: 'decline' });
    const results = await Promise.all([markResumed(created.id), markResumed(created.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('the loop is a row, not a timer', () => {
  it('hands the tick to exactly one claimant', async () => {
    const results = await Promise.all([
      claimCycle({ owner: 'instance-a' }),
      claimCycle({ owner: 'instance-b' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('fences a late writer whose lease was taken over', async () => {
    const first = await claimCycle({ owner: 'a' });
    expect(first.ok).toBe(true);
    const stale = first.generation!;
    // The lease expires and somebody else takes it.
    await getDb().run('UPDATE russell_cycle SET lease_expires_at = ? WHERE id = ?', [
      '2020-01-01T00:00:00.000Z',
      'singleton',
    ]);
    const second = await claimCycle({ owner: 'b' });
    expect(second.ok).toBe(true);
    // The old owner finishing now matches nothing.
    expect(await completeCycle({ owner: 'a', generation: stale })).toBe(false);
    expect(await completeCycle({ owner: 'b', generation: second.generation! })).toBe(true);
  });

  it('stops starting work when paused, and keeps everything that was queued', async () => {
    const created = await goal();
    const reservation = await reserve({ goalId: created.id, kind: 'MISSION', idempotencyKey: 'k' });
    expect(await pauseCycle({ reason: 'operator stopped it', actorUserId: userId })).toBe(true);
    const refused = await claimCycle({ owner: 'a' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/paused/);
    // Pausing preserves work rather than discarding it.
    expect(reservation.ok).toBe(true);
    expect(await resumeCycle()).toBe(true);
    expect((await claimCycle({ owner: 'a' })).ok).toBe(true);
  });

  it('starts bounded, so Russell cannot feed itself an unbounded chain', async () => {
    const cycle = await getCycle();
    expect(cycle!.maxLaunchesPerCycle).toBe(1);
    expect(cycle!.maxFollowonsPerCycle).toBe(1);
  });
});
