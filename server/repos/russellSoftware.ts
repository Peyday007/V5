/**
 * The row a conversation produces when somebody asks for a software change, and
 * the compare-and-swap that turns it into a campaign.
 *
 * Two guards here are the ones worth reading, and they are the same two shapes
 * the rest of this codebase uses everywhere a claim happens.
 *
 * **Capture is idempotent by `(project_id, submission_key)`**, and the key is
 * `submissionKeyFor(projectId, objective)` — the factory's own. So the same ask
 * arriving twice, from a redelivered turn, a person repeating themselves, or a
 * second conversation about the same thing, is one row and therefore one card.
 * It cannot see a rewording; the factory's own collision on the same key is what
 * catches that, and neither is sufficient alone.
 *
 * **Authorization is a guarded `UPDATE ... WHERE state = 'PROPOSED'`.** Two
 * clicks, a retried request and two browser tabs produce exactly one winner, and
 * the loser is told the request is already settled rather than starting a second
 * campaign. The effect belongs on the far side of that update, which is §24's
 * "claim, then act" — with the same trade it names: a crash between the claim
 * and the submission loses the authorization and shows a request that has to be
 * authorized again, which is the right way round when the alternative is two
 * campaigns.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  RussellSoftwareRequest,
  RussellSoftwareRequestRow,
  SoftwareRequestState,
} from '../domain/types.ts';

function toRequest(row: RussellSoftwareRequestRow): RussellSoftwareRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    title: row.title,
    objective: row.objective,
    expectedOutcome: row.expected_outcome,
    grantId: row.grant_id,
    repositoryId: row.repository_id,
    baseBranch: row.base_branch,
    requestedScope: row.requested_scope ? parseJson<string[]>(row.requested_scope, []) : null,
    submissionKey: row.submission_key,
    state: row.state as SoftwareRequestState,
    changeRequestId: row.change_request_id,
    campaignId: row.campaign_id,
    authorizedByUserId: row.authorized_by_user_id,
    declineReason: row.decline_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Record the ask, or return the one that already exists.
 *
 * `created` says which, because the two are different things to tell a person:
 * "I have written this down for you to authorize" and "you already have this
 * waiting" are both true answers and only one of them is new.
 */
export async function captureSoftwareRequest(input: {
  projectId: string;
  conversationId: string;
  messageId: string | null;
  title: string;
  objective: string;
  expectedOutcome: string;
  submissionKey: string;
}): Promise<{ request: RussellSoftwareRequest; created: boolean }> {
  const existing = await getDb().get<RussellSoftwareRequestRow>(
    'SELECT * FROM russell_software_requests WHERE project_id = ? AND submission_key = ?',
    [input.projectId, input.submissionKey],
  );
  if (existing) return { request: toRequest(existing), created: false };

  const at = nowIso();
  const id = newId('rsw');
  try {
    await getDb().run(
      `INSERT INTO russell_software_requests
         (id, project_id, conversation_id, message_id, title, objective, expected_outcome,
          grant_id, repository_id, base_branch, requested_scope, submission_key, state,
          change_request_id, campaign_id, authorized_by_user_id, decline_reason,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 'PROPOSED',
               NULL, NULL, NULL, NULL, ?, ?)`,
      [
        id,
        input.projectId,
        input.conversationId,
        input.messageId,
        input.title,
        input.objective,
        input.expectedOutcome,
        input.submissionKey,
        at,
        at,
      ],
    );
  } catch {
    /*
     * Lost the race on the unique index, which is an ordinary outcome rather
     * than an error: somebody else's insert is the row this caller wanted. Read
     * it back rather than reporting a failure for a request that succeeded.
     */
    const other = await getDb().get<RussellSoftwareRequestRow>(
      'SELECT * FROM russell_software_requests WHERE project_id = ? AND submission_key = ?',
      [input.projectId, input.submissionKey],
    );
    if (other) return { request: toRequest(other), created: false };
    throw new Error('The software request could not be written and no existing one was found.');
  }
  const fresh = await getSoftwareRequest(id);
  if (!fresh) throw new Error('The software request vanished while being written.');
  return { request: fresh, created: true };
}

export async function getSoftwareRequest(id: string): Promise<RussellSoftwareRequest | null> {
  const row = await getDb().get<RussellSoftwareRequestRow>(
    'SELECT * FROM russell_software_requests WHERE id = ?',
    [id],
  );
  return row ? toRequest(row) : null;
}

export async function listSoftwareRequestsForConversation(
  conversationId: string,
): Promise<RussellSoftwareRequest[]> {
  const rows = await getDb().all<RussellSoftwareRequestRow>(
    'SELECT * FROM russell_software_requests WHERE conversation_id = ? ORDER BY created_at, id',
    [conversationId],
  );
  return rows.map(toRequest);
}

export async function listSoftwareRequests(input: {
  projectId: string;
  states?: readonly SoftwareRequestState[];
}): Promise<RussellSoftwareRequest[]> {
  const states = input.states;
  if (!states || states.length === 0) {
    const rows = await getDb().all<RussellSoftwareRequestRow>(
      'SELECT * FROM russell_software_requests WHERE project_id = ? ORDER BY created_at, id',
      [input.projectId],
    );
    return rows.map(toRequest);
  }
  const placeholders = states.map(() => '?').join(', ');
  const rows = await getDb().all<RussellSoftwareRequestRow>(
    `SELECT * FROM russell_software_requests
      WHERE project_id = ? AND state IN (${placeholders})
      ORDER BY created_at, id`,
    [input.projectId, ...states],
  );
  return rows.map(toRequest);
}

/**
 * Take the request, so exactly one caller may act on it.
 *
 * The guard is the whole design: `WHERE state = 'PROPOSED'` matches once, and
 * everything the winner then does — submitting the objective, approving it,
 * building the campaign — happens on the far side of it.
 */
export async function claimSoftwareRequest(id: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_software_requests
        SET state = 'AUTHORIZED', updated_at = ?
      WHERE id = ? AND state = 'PROPOSED'`,
    [nowIso(), id],
  );
  return result.changes === 1;
}

/** What the winner recorded, once the campaign exists. */
export async function recordSoftwareAuthorization(input: {
  id: string;
  grantId: string;
  repositoryId: string;
  baseBranch: string | null;
  requestedScope: string[];
  changeRequestId: string;
  campaignId: string;
  authorizedByUserId: string;
}): Promise<RussellSoftwareRequest | null> {
  await getDb().run(
    `UPDATE russell_software_requests
        SET grant_id = ?, repository_id = ?, base_branch = ?, requested_scope = ?,
            change_request_id = ?, campaign_id = ?, authorized_by_user_id = ?, updated_at = ?
      WHERE id = ?`,
    [
      input.grantId,
      input.repositoryId,
      input.baseBranch,
      toJson(input.requestedScope),
      input.changeRequestId,
      input.campaignId,
      input.authorizedByUserId,
      nowIso(),
      input.id,
    ],
  );
  return getSoftwareRequest(input.id);
}

/**
 * Put a claimed request back, when the effect on the far side of the claim
 * refused.
 *
 * A submission the contract rejects — an objective too short, a scope outside
 * the boundary, a repository the project was never given — must not leave the
 * request marked authorized with no campaign behind it. That would be a card
 * that vanished and a decision nobody can retake.
 */
export async function releaseSoftwareRequest(id: string): Promise<void> {
  await getDb().run(
    `UPDATE russell_software_requests
        SET state = 'PROPOSED', updated_at = ?
      WHERE id = ? AND state = 'AUTHORIZED' AND campaign_id IS NULL`,
    [nowIso(), id],
  );
}

/** A person saying no, with the reason kept. */
export async function declineSoftwareRequest(input: {
  id: string;
  reason: string;
  userId: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_software_requests
        SET state = 'DECLINED', decline_reason = ?, authorized_by_user_id = ?, updated_at = ?
      WHERE id = ? AND state = 'PROPOSED'`,
    [input.reason, input.userId, nowIso(), input.id],
  );
  return result.changes === 1;
}
