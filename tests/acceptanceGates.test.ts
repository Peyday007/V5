/**
 * The gates, held to the conditions they claim to report on.
 *
 * A reporter cannot check itself. `scripts/step12a-acceptance.ts` runs against
 * production and prints verdicts, and for as long as it has existed three of
 * its gates were **weaker than the frozen standard** — which is invisible from
 * a green run, because a gate that cannot fail passes for free:
 *
 *   - `A05_DEDUPE` counted any merge in the chain. Condition 4 requires
 *     `method = 'SEMANTIC'` and says why: a fingerprint match would prove
 *     nothing about deduplication by meaning.
 *   - `A06_JUDGMENT_OVERRIDE` is named for an override and never looked at one,
 *     so condition 5's "supersedes rather than erases" was unchecked.
 *   - `A14_HUMAN_RESUME` counted `state = 'ANSWERED'`, which is the state a
 *     request sits in *before* the loop acts on it. `markResumed` moves it to
 *     `RESUMED` within a tick, so the gate could only ever have passed on a
 *     decision nothing had carried out — the exact failure condition 17 exists
 *     to catch.
 *
 * So each test below builds the failure shape and asserts the gate names it.
 * The scope still comes from `ACCEPTANCE_SCOPE`, so nothing here supplies the
 * standard it is judged against; the fixture only supplies rows for the chain
 * the reporter already declares.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { gates } from '../scripts/step12a-acceptance.ts';

/** The conversation the reporter's own scope names. Read, never chosen here. */
const ANCHOR = 'rcv_35d5b0340fc4479fa443';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `gates-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await getDb().run(
    `INSERT INTO russell_conversations
       (id, owner_user_id, project_id, title, visibility, attachment_confidence,
        attachment_source, grounding, legacy_conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, 'The anchor', 'SHARED', NULL, 'AUTOMATIC', '{}', NULL, ?, ?)`,
    [ANCHOR, userId, projectId, now(), now()],
  );
});

function now(): string {
  return new Date().toISOString();
}

async function candidate(
  id: string,
  fields: {
    canonicalId?: string | null;
    priority?: string | null;
    reason?: string | null;
    overrideUserId?: string | null;
    supersededDecision?: string | null;
  } = {},
): Promise<string> {
  await getDb().run(
    `INSERT INTO russell_candidates
       (id, project_id, visibility, conversation_id, source_message_id, title, statement,
        fingerprint, state, canonical_candidate_id, priority, ordinal, confidence, reason,
        judgment, supporting, contradicting, override_user_id, override_reason, override_at,
        superseded_decision, follow_on_of_mission_id, created_at, updated_at)
     VALUES (?, ?, 'SHARED', ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?,
             '{}', '[]', '[]', ?, NULL, NULL, ?, NULL, ?, ?)`,
    [
      id,
      projectId,
      ANCHOR,
      `Idea ${id}`,
      `statement ${id}`,
      `fp-${id}`,
      fields.canonicalId ? 'MERGED' : 'CAPTURED',
      fields.canonicalId ?? null,
      fields.priority ?? null,
      fields.reason ?? null,
      fields.overrideUserId ?? null,
      fields.supersededDecision ?? null,
      now(),
      now(),
    ],
  );
  return id;
}

async function merge(candidateId: string, canonicalId: string, method: string): Promise<void> {
  await getDb().run(
    `INSERT INTO russell_candidate_merges
       (id, candidate_id, canonical_id, action, method, confidence, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, 'MERGE', ?, NULL, 'because', NULL, ?)`,
    [`rcm_${Math.random().toString(36).slice(2, 12)}`, candidateId, canonicalId, method, now()],
  );
}

async function verdictOf(id: string): Promise<{ verdict: string; detail: string }> {
  const all = await gates();
  const found = all.find((gate) => gate.id === id);
  if (!found) throw new Error(`no gate ${id}`);
  return { verdict: found.verdict, detail: found.detail };
}

describe('A05 reports deduplication by meaning, not any merge at all', () => {
  it('refuses a fingerprint merge, which the scenario says proves nothing here', async () => {
    const canonical = await candidate('rcn_aaaaaaaaaaaaaaaaaaa1');
    const duplicate = await candidate('rcn_aaaaaaaaaaaaaaaaaaa2', { canonicalId: canonical });
    await merge(duplicate, canonical, 'FINGERPRINT');
    const result = await verdictOf('A05_DEDUPE');
    expect(result.verdict).not.toBe('PASS');
  });

  it('passes on a semantic merge whose canonical is in the same chain', async () => {
    const canonical = await candidate('rcn_aaaaaaaaaaaaaaaaaaa1');
    const duplicate = await candidate('rcn_aaaaaaaaaaaaaaaaaaa2', { canonicalId: canonical });
    await merge(duplicate, canonical, 'SEMANTIC');
    expect((await verdictOf('A05_DEDUPE')).verdict).toBe('PASS');
  });

  it('fails outright on a second canonical idea, which is the named falsifier', async () => {
    await candidate('rcn_aaaaaaaaaaaaaaaaaaa1');
    await candidate('rcn_aaaaaaaaaaaaaaaaaaa2');
    const result = await verdictOf('A05_DEDUPE');
    expect(result.verdict).toBe('FAIL');
    expect(result.detail).toMatch(/canonical/);
  });
});

describe('A06 checks both halves of the stored judgment', () => {
  it('fails a priority stored with no reason', async () => {
    await candidate('rcn_aaaaaaaaaaaaaaaaaaa1', { priority: 'MUST_DO', reason: null });
    const result = await verdictOf('A06_JUDGMENT_OVERRIDE');
    expect(result.verdict).toBe('FAIL');
    expect(result.detail).toMatch(/no stated reason/);
  });

  it('fails an override that erased what it replaced', async () => {
    await candidate('rcn_aaaaaaaaaaaaaaaaaaa1', {
      priority: 'MUST_DO',
      reason: 'a person moved it up',
      // A real user id: `override_user_id` is a foreign key, so an invented one
      // would fail the insert rather than exercise the gate.
      overrideUserId: userId,
      supersededDecision: null,
    });
    const result = await verdictOf('A06_JUDGMENT_OVERRIDE');
    expect(result.verdict).toBe('FAIL');
    expect(result.detail).toMatch(/erased/);
  });

  it('passes an override that kept it', async () => {
    await candidate('rcn_aaaaaaaaaaaaaaaaaaa1', {
      priority: 'MUST_DO',
      reason: 'a person moved it up',
      overrideUserId: userId,
      supersededDecision: JSON.stringify({ priority: 'WORTH_DOING', reason: 'Russell said so' }),
    });
    expect((await verdictOf('A06_JUDGMENT_OVERRIDE')).verdict).toBe('PASS');
  });
});

describe('A14 reports a decision that was carried out', () => {
  async function request(state: string, missionState: string | null): Promise<void> {
    let missionId: string | null = null;
    if (missionState) {
      missionId = 'rms_aaaaaaaaaaaaaaaaaaa1';
      const layer = (
        await getDb().all<{ id: string }>(`SELECT id FROM layers WHERE project_id = ? LIMIT 1`, [
          projectId,
        ])
      )[0]!.id;
      await getDb().run(
        `INSERT INTO russell_missions
           (id, project_id, layer_id, visibility, candidate_id, conversation_id, probe_id,
            goal_id, reservation_id, objective, why_now, state, waiting_on, orchestration_id,
            bin_id, document_id, audit_id, writeback_at, next_mission_id, terminal_reason,
            idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'SHARED', NULL, ?, NULL, NULL, NULL, 'o', 'w', ?, ?, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [
          missionId,
          projectId,
          layer,
          ANCHOR,
          missionState,
          // The schema's own CHECK: a mission that is waiting must say what
          // for. Honoured here rather than worked around, because the fixture
          // is meant to be a shape production can actually produce.
          missionState === 'WAITING' || missionState === 'NEEDS_HUMAN'
            ? 'a person: the packet stopped at a decision'
            : null,
          `k-${Math.random()}`,
          now(),
          now(),
        ],
      );
    }
    await getDb().run(
      `INSERT INTO russell_human_requests
         (id, project_id, visibility, mission_id, candidate_id, conversation_id,
          authority_needed, why_not_russell, recommendation, choices, urgency, state,
          answered_by_user_id, answered_choice, answered_reason, answered_at, resume_key,
          created_at, updated_at)
       VALUES (?, ?, 'SHARED', ?, NULL, ?, 'a decision', 'not Russell to make', NULL,
               '[{"key":"RECORD_GAPS","label":"x","consequence":"y"}]', 'BLOCKING', ?,
               ?, 'RECORD_GAPS', NULL, ?, ?, ?, ?)`,
      [
        `rhr_${Math.random().toString(36).slice(2, 12)}`,
        projectId,
        missionId,
        ANCHOR,
        state,
        userId,
        now(),
        `resume:${Math.random()}`,
        now(),
        now(),
      ],
    );
  }

  it('counts a decision the loop already resumed, which the old gate could not', async () => {
    // The regression this replaces: `state = 'ANSWERED'` only, so a request the
    // loop had acted on read as zero and the gate scored better the *less* the
    // mechanism worked.
    await request('RESUMED', 'RUNNING');
    expect((await verdictOf('A14_HUMAN_RESUME')).verdict).toBe('PASS');
  });

  it('fails when the mission is still waiting after the answer', async () => {
    await request('ANSWERED', 'NEEDS_HUMAN');
    const result = await verdictOf('A14_HUMAN_RESUME');
    expect(result.verdict).toBe('FAIL');
    expect(result.detail).toMatch(/waiting|changed nothing/);
  });
});
