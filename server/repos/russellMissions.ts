/**
 * Missions, knowledge and the human decisions Russell may not take.
 *
 * A mission is the spine: it is the one row that links a conversation to a
 * candidate to a probe to a grant to a reservation to an orchestration to a bin
 * to a filed document to an audit to the knowledge that came out of it. Every
 * one of those is an id column or a foreign key, never a title match — Step 9
 * paid for that lesson, and an identity reconstructed by matching titles breaks
 * the first time two things are called the same thing.
 *
 * Three guards in here are the ones worth reading.
 *
 * **`launchMission` is idempotent by construction.** The key is derived from the
 * candidate and the grant, so a retried launch is the same mission rather than a
 * second one, and two concurrent launches resolve to one row.
 *
 * **`claimWriteback` is a compare-and-swap on `writeback_at IS NULL`.** That
 * single guarded update is what makes completion writeback exactly-once under
 * replay, a duplicated provider callback, two observers, or a restart in the
 * middle. Whoever wins does the work; everyone else is told it is already done.
 *
 * **A human request carries the transition that answers it.** `resume_key` is
 * unique, so a double-submitted answer resumes once, and a request cannot be
 * created without naming what will resume — which is what stops a Needs You
 * item from being a state nobody can clear.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  HumanRequestChoice,
  HumanRequestState,
  HumanRequestUrgency,
  KnowledgeAuthor,
  KnowledgeConfidence,
  KnowledgeKind,
  MissionGroup,
  MissionState,
  RussellHumanRequest,
  RussellHumanRequestRow,
  RussellKnowledge,
  RussellKnowledgeRow,
  RussellMission,
  RussellMissionRow,
  RussellVisibility,
} from '../domain/types.ts';

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

function mapMission(row: RussellMissionRow): RussellMission {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    visibility: row.visibility as RussellVisibility,
    candidateId: row.candidate_id,
    conversationId: row.conversation_id,
    probeId: row.probe_id,
    goalId: row.goal_id,
    reservationId: row.reservation_id,
    objective: row.objective,
    whyNow: row.why_now,
    state: row.state as MissionState,
    waitingOn: row.waiting_on,
    orchestrationId: row.orchestration_id,
    binId: row.bin_id,
    documentId: row.document_id,
    auditId: row.audit_id,
    writebackAt: row.writeback_at,
    nextMissionId: row.next_mission_id,
    terminalReason: row.terminal_reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * Which of the five groups a person sees this mission in.
 *
 * One function, so the projection is testable and the five names exist in one
 * place rather than in each view that renders them. `EXPLORING` is a mission
 * whose probe has not yet decided — it is genuinely a different thing from
 * queued work, and collapsing it into "Up next" would tell somebody that a
 * question Russell is still deciding about is work it has committed to.
 */
export function groupOf(mission: RussellMission): MissionGroup {
  switch (mission.state) {
    case 'RUNNING':
    case 'LAUNCHING':
      return 'WORKING_NOW';
    case 'PLANNED':
      return mission.probeId && !mission.orchestrationId ? 'EXPLORING' : 'UP_NEXT';
    case 'WAITING':
    case 'NEEDS_HUMAN':
      return 'WAITING';
    case 'DONE':
    case 'FAILED':
    case 'CANCELLED':
    default:
      return 'FINISHED';
  }
}

export async function launchMission(input: {
  projectId: string;
  layerId?: string | null;
  visibility: RussellVisibility;
  objective: string;
  whyNow: string;
  idempotencyKey: string;
  candidateId?: string | null;
  conversationId?: string | null;
  probeId?: string | null;
  goalId?: string | null;
  reservationId?: string | null;
}): Promise<{ mission: RussellMission; created: boolean }> {
  const id = newId('rms');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_missions
       (id, project_id, layer_id, visibility, candidate_id, conversation_id, probe_id,
        goal_id, reservation_id, objective, why_now, state, waiting_on, orchestration_id,
        bin_id, document_id, audit_id, writeback_at, next_mission_id, terminal_reason,
        idempotency_key, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.layerId ?? null,
      input.visibility,
      input.candidateId ?? null,
      input.conversationId ?? null,
      input.probeId ?? null,
      input.goalId ?? null,
      input.reservationId ?? null,
      input.objective,
      input.whyNow,
      input.idempotencyKey,
      at,
      at,
    ],
  );
  const rows = await getDb().all<RussellMissionRow>(
    'SELECT * FROM russell_missions WHERE idempotency_key = ?',
    [input.idempotencyKey],
  );
  if (!rows[0]) throw new Error('The mission disappeared immediately after being written.');
  return { mission: mapMission(rows[0]), created: rows[0].id === id };
}

export async function getMission(id: string): Promise<RussellMission | null> {
  const rows = await getDb().all<RussellMissionRow>('SELECT * FROM russell_missions WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapMission(rows[0]) : null;
}

export async function getMissionByOrchestration(
  orchestrationId: string,
): Promise<RussellMission | null> {
  const rows = await getDb().all<RussellMissionRow>(
    'SELECT * FROM russell_missions WHERE orchestration_id = ? ORDER BY created_at, rowid LIMIT 1',
    [orchestrationId],
  );
  return rows[0] ? mapMission(rows[0]) : null;
}

export async function listMissions(input: {
  projectId: string;
  states?: MissionState[];
  limit?: number;
}): Promise<RussellMission[]> {
  const states = input.states ?? [];
  const placeholders = states.map(() => '?').join(',');
  const rows = await getDb().all<RussellMissionRow>(
    `SELECT * FROM russell_missions
      WHERE project_id = ?
      ${states.length ? `AND state IN (${placeholders})` : ''}
      ORDER BY updated_at DESC, rowid DESC
      LIMIT ?`,
    [input.projectId, ...states, Math.min(500, Math.max(1, input.limit ?? 100))],
  );
  return rows.map(mapMission);
}

/** Attach the pipeline rows as they come into existence. */
export async function linkMission(input: {
  missionId: string;
  orchestrationId?: string | null;
  binId?: string | null;
  documentId?: string | null;
  auditId?: string | null;
}): Promise<boolean> {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (input.orchestrationId !== undefined) {
    sets.push('orchestration_id = ?');
    params.push(input.orchestrationId);
  }
  if (input.binId !== undefined) {
    sets.push('bin_id = ?');
    params.push(input.binId);
  }
  if (input.documentId !== undefined) {
    sets.push('document_id = ?');
    params.push(input.documentId);
  }
  if (input.auditId !== undefined) {
    sets.push('audit_id = ?');
    params.push(input.auditId);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(input.missionId);
  const result = await getDb().run(
    `UPDATE russell_missions SET ${sets.join(', ')} WHERE id = ?`,
    params,
  );
  return result.changes === 1;
}

/**
 * Move a mission, guarded on where the caller believes it is.
 *
 * A mission entering `WAITING` or `NEEDS_HUMAN` must say what for; the CHECK
 * constraint enforces it and this refuses it early with a sentence, because a
 * mission parked on nothing nameable is the state nobody can clear.
 */
export async function transitionMission(input: {
  missionId: string;
  from: MissionState;
  to: MissionState;
  waitingOn?: string | null;
  terminalReason?: string | null;
}): Promise<boolean> {
  if ((input.to === 'WAITING' || input.to === 'NEEDS_HUMAN') && !input.waitingOn) {
    throw new Error('A mission that waits must record what it is waiting for.');
  }
  const at = nowIso();
  const terminal = input.to === 'DONE' || input.to === 'FAILED' || input.to === 'CANCELLED';
  const result = await getDb().run(
    `UPDATE russell_missions
        SET state = ?, waiting_on = ?, terminal_reason = ?, updated_at = ?,
            completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
      WHERE id = ? AND state = ?`,
    [
      input.to,
      input.waitingOn ?? null,
      input.terminalReason ?? null,
      at,
      terminal ? 1 : 0,
      at,
      input.missionId,
      input.from,
    ],
  );
  return result.changes === 1;
}

/**
 * Take the right to perform this mission's completion writeback.
 *
 * One guarded update, and it is the whole of exactly-once. Whoever swaps
 * `writeback_at` from NULL does the promotion, the project summary, the
 * conversation annotation, the re-ranking, the briefing fact and the decision
 * about what comes next. Everyone else — a replay, a duplicated callback, a
 * second observer, a restart mid-way — gets `false` and does nothing.
 *
 * It is a swap rather than a `SELECT` then an `UPDATE` for the reason this
 * codebase has needed four times now: a read leaves a window, and a window is
 * where the duplicate lives.
 */
export async function claimWriteback(missionId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_missions SET writeback_at = ?, updated_at = ?
      WHERE id = ? AND writeback_at IS NULL`,
    [nowIso(), nowIso(), missionId],
  );
  return result.changes === 1;
}

export async function setNextMission(input: {
  missionId: string;
  nextMissionId: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_missions SET next_mission_id = ?, updated_at = ?
      WHERE id = ? AND next_mission_id IS NULL`,
    [input.nextMissionId, nowIso(), input.missionId],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

function mapKnowledge(row: RussellKnowledgeRow): RussellKnowledge {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    visibility: row.visibility as RussellVisibility,
    kind: row.kind as KnowledgeKind,
    statement: row.statement,
    detail: row.detail,
    provenance: parseJson<Record<string, unknown>>(row.provenance, {}),
    authorType: row.author_type as KnowledgeAuthor,
    confidence: row.confidence as KnowledgeConfidence,
    asOf: row.as_of,
    lastConfirmedAt: row.last_confirmed_at,
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    missionId: row.mission_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordKnowledge(input: {
  projectId: string;
  layerId?: string | null;
  visibility: RussellVisibility;
  kind: KnowledgeKind;
  statement: string;
  detail?: string | null;
  provenance: Record<string, unknown>;
  authorType: KnowledgeAuthor;
  confidence: KnowledgeConfidence;
  asOf?: string | null;
  missionId?: string | null;
  conversationId?: string | null;
  supersedesId?: string | null;
}): Promise<RussellKnowledge> {
  const id = newId('rkn');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_knowledge
       (id, project_id, layer_id, visibility, kind, statement, detail, provenance,
        author_type, confidence, as_of, last_confirmed_at, supersedes_id, superseded_by_id,
        mission_id, conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.layerId ?? null,
      input.visibility,
      input.kind,
      input.statement,
      input.detail ?? null,
      toJson(input.provenance),
      input.authorType,
      input.confidence,
      input.asOf ?? null,
      at,
      input.supersedesId ?? null,
      input.missionId ?? null,
      input.conversationId ?? null,
      at,
      at,
    ],
  );
  // Supersession points both ways, and the old row is never deleted: current
  // belief moves, the record of what was believed does not.
  if (input.supersedesId) {
    await getDb().run(
      'UPDATE russell_knowledge SET superseded_by_id = ?, updated_at = ? WHERE id = ?',
      [id, at, input.supersedesId],
    );
  }
  const rows = await getDb().all<RussellKnowledgeRow>(
    'SELECT * FROM russell_knowledge WHERE id = ?',
    [id],
  );
  return mapKnowledge(rows[0]!);
}

/** What the project currently believes: everything not superseded. */
export async function listCurrentKnowledge(input: {
  projectId: string;
  kinds?: KnowledgeKind[];
  includePrivate?: boolean;
  limit?: number;
}): Promise<RussellKnowledge[]> {
  const kinds = input.kinds ?? [];
  const placeholders = kinds.map(() => '?').join(',');
  const rows = await getDb().all<RussellKnowledgeRow>(
    `SELECT * FROM russell_knowledge
      WHERE project_id = ? AND superseded_by_id IS NULL
      ${kinds.length ? `AND kind IN (${placeholders})` : ''}
      ${input.includePrivate ? '' : `AND visibility = 'SHARED'`}
      ORDER BY updated_at DESC, rowid DESC
      LIMIT ?`,
    [input.projectId, ...kinds, Math.min(1000, Math.max(1, input.limit ?? 200))],
  );
  return rows.map(mapKnowledge);
}

export async function getKnowledge(id: string): Promise<RussellKnowledge | null> {
  const rows = await getDb().all<RussellKnowledgeRow>(
    'SELECT * FROM russell_knowledge WHERE id = ?',
    [id],
  );
  return rows[0] ? mapKnowledge(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Needs You
// ---------------------------------------------------------------------------

function mapRequest(row: RussellHumanRequestRow): RussellHumanRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    visibility: row.visibility as RussellVisibility,
    missionId: row.mission_id,
    candidateId: row.candidate_id,
    conversationId: row.conversation_id,
    authorityNeeded: row.authority_needed,
    whyNotRussell: row.why_not_russell,
    recommendation: row.recommendation,
    choices: parseJson<HumanRequestChoice[]>(row.choices, []),
    urgency: row.urgency as HumanRequestUrgency,
    state: row.state as HumanRequestState,
    answeredByUserId: row.answered_by_user_id,
    answeredChoice: row.answered_choice,
    answeredReason: row.answered_reason,
    answeredAt: row.answered_at,
    resumeKey: row.resume_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Ask a person for something Russell genuinely may not decide.
 *
 * Every choice must carry its consequence, and every choice must have a guarded
 * server transition behind it. An option somebody can press where nothing
 * happens is worse than no option: it looks like the system is waiting for
 * them when it is really stuck.
 *
 * `resume_key` is unique, so raising the same boundary twice — from a retry, a
 * second observer, or a restart — produces one request rather than a queue of
 * identical cards.
 */
export async function askHuman(input: {
  projectId: string;
  visibility?: RussellVisibility;
  missionId?: string | null;
  candidateId?: string | null;
  conversationId?: string | null;
  authorityNeeded: string;
  whyNotRussell: string;
  recommendation?: string | null;
  choices: HumanRequestChoice[];
  urgency?: HumanRequestUrgency;
  resumeKey: string;
}): Promise<{ request: RussellHumanRequest; created: boolean }> {
  if (input.choices.length === 0) {
    throw new Error('A human request must offer at least one choice with a stated consequence.');
  }
  for (const choice of input.choices) {
    if (!choice.key || !choice.label || !choice.consequence) {
      throw new Error('Every choice must carry a key, a label and its consequence.');
    }
  }
  const id = newId('rhr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_human_requests
       (id, project_id, visibility, mission_id, candidate_id, conversation_id,
        authority_needed, why_not_russell, recommendation, choices, urgency, state,
        answered_by_user_id, answered_choice, answered_reason, answered_at, resume_key,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT (resume_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.visibility ?? 'SHARED',
      input.missionId ?? null,
      input.candidateId ?? null,
      input.conversationId ?? null,
      input.authorityNeeded,
      input.whyNotRussell,
      input.recommendation ?? null,
      toJson(input.choices),
      input.urgency ?? 'WHENEVER',
      input.resumeKey,
      at,
      at,
    ],
  );
  const rows = await getDb().all<RussellHumanRequestRow>(
    'SELECT * FROM russell_human_requests WHERE resume_key = ?',
    [input.resumeKey],
  );
  if (!rows[0]) throw new Error('The request disappeared immediately after being written.');
  return { request: mapRequest(rows[0]), created: rows[0].id === id };
}

export async function getHumanRequest(id: string): Promise<RussellHumanRequest | null> {
  const rows = await getDb().all<RussellHumanRequestRow>(
    'SELECT * FROM russell_human_requests WHERE id = ?',
    [id],
  );
  return rows[0] ? mapRequest(rows[0]) : null;
}

export async function listOpenRequests(projectId: string): Promise<RussellHumanRequest[]> {
  const rows = await getDb().all<RussellHumanRequestRow>(
    `SELECT * FROM russell_human_requests
      WHERE project_id = ? AND state = 'OPEN'
      ORDER BY CASE urgency WHEN 'URGENT' THEN 0 WHEN 'BLOCKING' THEN 1 ELSE 2 END,
               created_at, rowid`,
    [projectId],
  );
  return rows.map(mapRequest);
}

export interface AnswerOutcome {
  ok: boolean;
  request: RussellHumanRequest | null;
  reason: string;
  /** True when the request was already answered — a reload or a double submit. */
  alreadyAnswered: boolean;
}

/**
 * Record a person's answer, once.
 *
 * The choice is validated against the choices the request actually offered, so
 * a caller cannot answer with something that was never on the card. The update
 * is guarded on `state = 'OPEN'`, so a double submit or a reload finds it
 * already answered and is told so rather than being shown a success for a
 * change that did not happen.
 *
 * Answering does not itself resume the work. It records the authority; the
 * resume is a separate guarded transition keyed on `resume_key`, which is what
 * makes the pair replay-safe.
 */
export async function answerHumanRequest(input: {
  requestId: string;
  actorUserId: string;
  choice: string;
  reason?: string | null;
}): Promise<AnswerOutcome> {
  const request = await getHumanRequest(input.requestId);
  if (!request) return { ok: false, request: null, reason: 'no such request', alreadyAnswered: false };
  if (request.state !== 'OPEN') {
    return {
      ok: false,
      request,
      reason: `the request is already ${request.state.toLowerCase()}`,
      alreadyAnswered: true,
    };
  }
  if (!request.choices.some((choice) => choice.key === input.choice)) {
    return { ok: false, request, reason: 'that is not one of the offered choices', alreadyAnswered: false };
  }
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE russell_human_requests
        SET state = 'ANSWERED', answered_by_user_id = ?, answered_choice = ?,
            answered_reason = ?, answered_at = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.actorUserId, input.choice, input.reason ?? null, at, at, input.requestId],
  );
  if (result.changes !== 1) {
    return {
      ok: false,
      request: await getHumanRequest(input.requestId),
      reason: 'somebody answered it first',
      alreadyAnswered: true,
    };
  }
  return { ok: true, request: await getHumanRequest(input.requestId), reason: 'answered', alreadyAnswered: false };
}

/**
 * Mark an answered request as having been acted on.
 *
 * Guarded on `ANSWERED`, so the resume runs once however many observers notice
 * the answer. This is the transition whose absence Step 10 called stuck: the
 * request is not finished when a person clicks, it is finished when the work
 * they authorized has actually moved.
 */
export async function markResumed(requestId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_human_requests SET state = 'RESUMED', updated_at = ?
      WHERE id = ? AND state = 'ANSWERED'`,
    [nowIso(), requestId],
  );
  return result.changes === 1;
}

/** Answered requests whose work has not yet been resumed. The loop reads this. */
export async function listAnsweredRequests(limit = 50): Promise<RussellHumanRequest[]> {
  const rows = await getDb().all<RussellHumanRequestRow>(
    `SELECT * FROM russell_human_requests WHERE state = 'ANSWERED'
      ORDER BY answered_at, rowid LIMIT ?`,
    [Math.min(500, Math.max(1, limit))],
  );
  return rows.map(mapRequest);
}
