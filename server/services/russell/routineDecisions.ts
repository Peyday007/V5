/**
 * Research parks Brain answers itself, under the standing authority a person
 * already granted (§80).
 *
 * A packet that stops for a person raises a Needs You card with at most three
 * answers: authorize a plan the envelope refused, file the audited report with
 * its unresolved questions named, or stop. Production, 2026-11-01: 293 packets
 * sat at NEEDS_HUMAN and the owner was asked about each one. Two of the three
 * answers stay inside what the standing research grant already authorizes:
 *
 *   - **RECORD_GAPS** files what the evidence gate already accepted, with what
 *     it could not settle named beside it. It spends nothing beyond the grant's
 *     own concurrency, lowers no bar and claims nothing was answered that was
 *     not.
 *   - **STOP** declines further work. It keeps every row and every accepted
 *     claim.
 *
 * The third, **APPROVE_PLAN**, is authorization the grant does not hold, and
 * Brain never gives it. For research Brain compiled for itself (a packet with
 * an approval envelope) the plan the envelope refused is declined instead —
 * stopping is within authority, widening it is not. A packet a person's own
 * research goal started keeps its card, because whether to widen it is theirs.
 *
 * What is never answered here: a card about something other than a mission
 * (a capability authority, a stopped opportunity to reconsider), a project
 * with no live standing grant, and a judge park Brain is about to correct by
 * itself (`assessJudgeRound` RESUME). A card younger than
 * `ROUTINE_DECISION_GRACE_MS` waits too, so the passes that repair a park
 * (a corrected round, an envelope asked again) act first.
 *
 * The answer is recorded against the grant's owner — whose authority it
 * carries — with the reason saying in words that Brain decided it and under
 * which grant. The existing `answered-requests` pass then carries it out
 * through the same guarded transitions a person's answer takes.
 */
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { getOrchestration } from '../../repos/research.ts';
import { listGoals } from '../../repos/russellAuthority.ts';
import { answerHumanRequest, getHumanRequest, getMission, transitionMission } from '../../repos/russellMissions.ts';
import type { MissionState, RussellHumanRequest, ResearchOrchestration } from '../../domain/types.ts';
import { NEEDS_HUMAN_CHOICES, choicesFor, packetShape } from './needsHuman.ts';

/** How long a card waits before Brain answers it, so repair passes go first. */
export const ROUTINE_DECISION_GRACE_MS = 10 * 60_000;

const NOT_ABOUT_A_MISSION = ['capability-authority:', 'cash-reconsider:'];

export type RoutineChoice = 'RECORD_GAPS' | 'STOP';

/** The answer Brain gives a card, or null with why it is a person's. Pure. */
export function routineChoiceFor(input: {
  choiceKeys: readonly string[];
  /** The packet was compiled by Brain under an approval envelope. */
  brainCompiled: boolean;
}): { choice: RoutineChoice; why: string } | { choice: null; why: string } {
  const keys = new Set(input.choiceKeys);
  if (keys.has(NEEDS_HUMAN_CHOICES.RECORD_GAPS.key)) {
    return {
      choice: 'RECORD_GAPS',
      why:
        'the packet has accepted evidence and its repair ladder is spent, so its audited report is ' +
        'filed with the unresolved questions named rather than held open',
    };
  }
  if (keys.has(NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key)) {
    if (!input.brainCompiled) {
      return { choice: null, why: 'widening a person’s own research goal is theirs to decide' };
    }
    if (!keys.has(NEEDS_HUMAN_CHOICES.STOP.key)) return { choice: null, why: 'no answer within authority is offered' };
    return {
      choice: 'STOP',
      why:
        'the plan falls outside the envelope Brain may approve itself, and widening an envelope is ' +
        'not within the standing grant — so this research is declined and its rows are kept',
    };
  }
  if (keys.has(NEEDS_HUMAN_CHOICES.STOP.key)) {
    return {
      choice: 'STOP',
      why: 'nothing in the packet cleared its evidence gate, so there is no report to file and the work is stopped',
    };
  }
  return { choice: null, why: 'no answer within authority is offered' };
}

export interface RoutineDecision {
  requestId: string;
  missionId: string | null;
  choice: RoutineChoice | null;
  reason: string;
}

/** Answer every routine research park old enough to answer. Idempotent by the request's own state. */
export async function answerRoutineParks(input: {
  limit?: number;
  nowMs?: number;
} = {}): Promise<RoutineDecision[]> {
  const nowMs = input.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - ROUTINE_DECISION_GRACE_MS).toISOString();
  const rows = await getDb().all<{ id: string }>(
    /*
     * Only cards Brain could answer, so the rest cannot fill the window.
     *
     * The window is the oldest `limit` cards, and a card `decide` leaves open
     * keeps its old `created_at` — it is first in line on every tick. Once more
     * than `limit` of them existed, a newer RECORD_GAPS card was never reached
     * and went to Needs You as "the evidence bar was not met and the repair
     * ladder is spent": the starvation `parkStoppedMissions` documents for its
     * own window. Two of `decide`'s refusals are facts of the row and are
     * asked here instead: a card that is not about a mission, and a project
     * with no live standing grant. The grant test is the one `decide` makes —
     * `listGoals` returns only `purpose = 'STANDING'` rows, so a RESEARCH_GOAL
     * is no grant to either — and `decide` still checks both, so authority is
     * unchanged.
     */
    `SELECT r.id FROM russell_human_requests r
      WHERE r.state = 'OPEN' AND r.mission_id IS NOT NULL AND r.created_at <= ?
        AND ${NOT_ABOUT_A_MISSION.map(() => 'r.resume_key NOT LIKE ?').join(' AND ')}
        AND EXISTS (SELECT 1 FROM russell_goals g
                     WHERE g.project_id = r.project_id AND g.purpose = 'STANDING'
                       AND g.state = 'ACTIVE' AND (g.expires_at IS NULL OR g.expires_at > ?))
      ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
    [cutoff, ...NOT_ABOUT_A_MISSION.map((prefix) => `${prefix}%`), new Date(nowMs).toISOString(), input.limit ?? 200],
  );
  const owners = new Map<string, { goalId: string; name: string; ownerUserId: string } | null>();
  const out: RoutineDecision[] = [];
  for (const row of rows) {
    const request = await getHumanRequest(row.id);
    if (!request || request.state !== 'OPEN' || !request.missionId) continue;
    const decision = await decide(request, owners, nowMs);
    out.push(decision);
  }
  return out;
}

async function decide(
  request: RussellHumanRequest,
  owners: Map<string, { goalId: string; name: string; ownerUserId: string } | null>,
  nowMs: number,
): Promise<RoutineDecision> {
  const base = { requestId: request.id, missionId: request.missionId };
  if (NOT_ABOUT_A_MISSION.some((prefix) => request.resumeKey.startsWith(prefix))) {
    return { ...base, choice: null, reason: 'not a research park' };
  }
  if (!owners.has(request.projectId)) {
    const now = new Date(nowMs).toISOString();
    const live = (await listGoals(request.projectId)).find(
      (goal) => goal.state === 'ACTIVE' && (!goal.expiresAt || goal.expiresAt > now),
    );
    owners.set(request.projectId, live ? { goalId: live.id, name: live.name, ownerUserId: live.ownerUserId } : null);
  }
  const grant = owners.get(request.projectId) ?? null;
  if (!grant) return { ...base, choice: null, reason: 'the project has no live standing research grant' };

  const mission = await getMission(request.missionId!);
  const orchestration: ResearchOrchestration | null = mission?.orchestrationId
    ? await getOrchestration(mission.orchestrationId)
    : null;
  if (orchestration) {
    const { assessJudgeRound } = await import('../research/judgeRound.ts');
    const assessment = await assessJudgeRound(orchestration);
    if (assessment.kind === 'RESUME') {
      return { ...base, choice: null, reason: 'Brain is about to run a corrected round on it' };
    }
  }

  const picked = routineChoiceFor({
    choiceKeys: request.choices.map((choice) => choice.key),
    brainCompiled: orchestration?.approvalEnvelopeId != null,
  });
  if (picked.choice === null) return { ...base, choice: null, reason: picked.why };

  const reason = `Decided by Brain under the standing research grant “${grant.name}” (${grant.goalId}): ${picked.why}.`;
  const answered = await answerHumanRequest({
    requestId: request.id,
    actorUserId: grant.ownerUserId,
    choice: picked.choice,
    reason,
  });
  if (!answered.ok) return { ...base, choice: null, reason: answered.reason };
  await recordEvent({
    projectId: request.projectId,
    entityType: 'PROJECT',
    entityId: request.projectId,
    eventType: 'RUSSELL_ROUTINE_DECISION',
    payload: {
      requestId: request.id,
      missionId: request.missionId,
      orchestrationId: orchestration?.id ?? null,
      choice: picked.choice,
      grantId: grant.goalId,
      decidedBy: 'BRAIN_UNDER_STANDING_AUTHORITY',
      reason,
    },
  });
  return { ...base, choice: picked.choice, reason };
}

/**
 * The one step that files a stopped packet under the standing grant (§80, §88).
 *
 * Production, seven days to 2026-11-14: 305 of 334 Needs-You cards read
 * "Deciding whether this project accepts a report with unresolved questions
 * in it". `answerRoutineParks` answered that exact shape under the project's
 * standing grant — but only after `ROUTINE_DECISION_GRACE_MS`, so every routine
 * park was first raised to a person as a card. The grace exists so repair
 * passes act first, and for this shape the only repair is a corrected judge
 * round, which `assessJudgeRound` RESUME already detects. So the park pass asks
 * here first, and `answerUnaskedParks` uses the same step: one mechanism.
 *
 * Brain decides only when every condition the card answerers already apply
 * holds: RECORD_GAPS is among the honest answers (accepted evidence, research
 * reached), the packet is not already authorized, no corrected judge round is
 * about to run, the project holds a live STANDING grant, and its owner
 * resolves. Otherwise it returns which condition failed, so the cards that
 * remain are attributable by cause. Nothing is lowered: the gate decided what
 * was accepted, and only that is filed.
 */
export type GrantDeclineCondition =
  | 'RECORD_GAPS_NOT_OFFERED'
  | 'ALREADY_AUTHORIZED'
  | 'JUDGE_ROUND_RESUMING'
  | 'NO_LIVE_STANDING_GRANT'
  | 'GRANT_OWNER_UNRESOLVED';

export type GrantDecision =
  | { decided: true; grantId: string; reason: string; status: string }
  | { decided: false; condition: GrantDeclineCondition; reason: string };

export async function fileUnderStandingGrant(input: {
  orchestration: ResearchOrchestration;
  /** The answers an honest card for this packet would offer (`choicesFor`). */
  choiceKeys: readonly string[];
  /** The mission over the packet, returned to RUNNING before the packet advances. */
  mission: { id: string; state: MissionState } | null;
  why: string;
  nowMs?: number;
}): Promise<GrantDecision> {
  const { orchestration } = input;
  if (!input.choiceKeys.includes(NEEDS_HUMAN_CHOICES.RECORD_GAPS.key)) {
    return { decided: false, condition: 'RECORD_GAPS_NOT_OFFERED', reason: 'filing with the gaps named is not an answer this packet can take' };
  }
  if (orchestration.unresolvedGapPolicy === 'RECORD_GAPS') {
    return { decided: false, condition: 'ALREADY_AUTHORIZED', reason: 'filing with the gaps named is already authorized' };
  }
  const { assessJudgeRound } = await import('../research/judgeRound.ts');
  if ((await assessJudgeRound(orchestration)).kind === 'RESUME') {
    return { decided: false, condition: 'JUDGE_ROUND_RESUMING', reason: 'Brain is about to run a corrected round on it' };
  }
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  const grant = (await listGoals(orchestration.projectId)).find(
    (goal) => goal.state === 'ACTIVE' && (!goal.expiresAt || goal.expiresAt > now),
  );
  if (!grant) {
    return { decided: false, condition: 'NO_LIVE_STANDING_GRANT', reason: 'the project has no live standing research grant' };
  }
  const { getUser } = await import('../../repos/identity.ts');
  const owner = await getUser(grant.ownerUserId);
  if (!owner) {
    return { decided: false, condition: 'GRANT_OWNER_UNRESOLVED', reason: 'the grant owner cannot be resolved' };
  }

  const reason = `Decided by Brain under the standing research grant “${grant.name}” (${grant.id}): ${input.why}.`;
  const { authorizeUnresolvedGaps } = await import('../research/gapPolicy.ts');
  await authorizeUnresolvedGaps({ orchestrationId: orchestration.id, authorizedBy: { id: owner.id, email: owner.email } });
  await recordEvent({
    projectId: orchestration.projectId,
    entityType: 'PROJECT',
    entityId: orchestration.projectId,
    eventType: 'RUSSELL_ROUTINE_DECISION',
    payload: {
      orchestrationId: orchestration.id,
      missionId: input.mission?.id ?? null,
      choice: 'RECORD_GAPS',
      grantId: grant.id,
      decidedBy: 'BRAIN_UNDER_STANDING_AUTHORITY',
      reason,
    },
  });
  // Running before the packet advances, as `recordGaps` does: the advance can
  // carry the packet to terminal, and the writeback refuses a parked mission.
  if (input.mission && input.mission.state !== 'RUNNING') {
    await transitionMission({ missionId: input.mission.id, from: input.mission.state, to: 'RUNNING', waitingOn: null });
  }
  const { advancePacket } = await import('../research/packetRunner.ts');
  const advanced = await advancePacket(orchestration.id).catch((error: unknown) => ({
    status: `advance failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
  }));
  return { decided: true, grantId: grant.id, reason, status: advanced.status };
}

/**
 * Parks with no card: the same decision, where nobody was ever asked (§80, §88).
 *
 * Production, 2026-11-05 (`packets judge-parks`): eight packets sat at
 * NEEDS_HUMAN after two corrected judge rounds — "whether to file it short or
 * stop it is a person's decision" — and four had no Russell mission at all, so
 * no Needs-You card existed for `answerRoutineParks` to answer; the capability
 * map read DECISION.JOB_OUTCOME 0/6 and ANALYSIS.FILED 0 over three hours. A
 * park nobody is asked about is not waiting for a person: it is stuck.
 *
 * The decision is exactly `routineChoiceFor`'s RECORD_GAPS and nothing wider:
 * only a packet whose project holds a live standing grant, that has evidence
 * its gate accepted, that no open card already covers, and that Brain is not
 * about to correct itself (`assessJudgeRound` RESUME). It files what was
 * accepted with what it could not settle named beside it; it lowers no bar and
 * spends nothing beyond the grant. A packet with nothing accepted is left for
 * `concludeUnworkablePackets`, never filed.
 */
export interface UnaskedDecision {
  orchestrationId: string;
  decided: boolean;
  reason: string;
}

/** Advancing a packet is heavy; right after a restart the database is busiest (§88, Deploy 41963927835). */
export const UNASKED_BOOT_GRACE_MS = 10 * 60_000;
const processStartedAt = Date.now();

export async function answerUnaskedParks(input: { limit?: number; nowMs?: number; ignoreBootGrace?: boolean } = {}): Promise<UnaskedDecision[]> {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.ignoreBootGrace && nowMs - processStartedAt < UNASKED_BOOT_GRACE_MS) return [];
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - ROUTINE_DECISION_GRACE_MS).toISOString();
  const rows = await getDb().all<{ id: string; project_id: string }>(
    `SELECT o.id, o.project_id FROM research_orchestrations o
      WHERE o.status = 'NEEDS_HUMAN' AND o.updated_at <= ?
        AND (o.unresolved_gap_policy IS NULL OR o.unresolved_gap_policy <> 'RECORD_GAPS')
        AND EXISTS (SELECT 1 FROM research_fragments f WHERE f.orchestration_id = o.id AND f.status = 'ACCEPTED')
        AND NOT EXISTS (SELECT 1 FROM russell_missions m JOIN russell_human_requests r ON r.mission_id = m.id
                         WHERE m.orchestration_id = o.id AND r.state IN ('OPEN', 'ANSWERED'))
        AND EXISTS (SELECT 1 FROM russell_goals g
                     WHERE g.project_id = o.project_id AND g.purpose = 'STANDING'
                       AND g.state = 'ACTIVE' AND (g.expires_at IS NULL OR g.expires_at > ?))
      ORDER BY o.updated_at ASC, o.id ASC LIMIT ?`,
    [cutoff, now, input.limit ?? 5],
  );
  const out: UnaskedDecision[] = [];
  for (const row of rows) {
    const orchestration = await getOrchestration(row.id);
    if (!orchestration || orchestration.status !== 'NEEDS_HUMAN') continue;
    const choiceKeys = choicesFor(await packetShape(row.id)).map((choice) => choice.key);
    const decision = await fileUnderStandingGrant({
      orchestration,
      choiceKeys,
      mission: null,
      why:
        'the packet has accepted evidence and nothing left Brain may attempt, so its audited report is filed with the ' +
        'unresolved questions named rather than held for a person nobody asked',
      nowMs,
    });
    if (decision.decided) {
      out.push({ orchestrationId: row.id, decided: true, reason: `filed with gaps named; the packet is now ${decision.status}` });
    } else if (decision.condition === 'JUDGE_ROUND_RESUMING' || decision.condition === 'GRANT_OWNER_UNRESOLVED') {
      out.push({ orchestrationId: row.id, decided: false, reason: decision.reason });
    }
  }
  return out;
}

/** The 60 most recent NEEDS_HUMAN packets and what decides whether Brain may file it: for `admin packets parks` (newest first, so today's parks are not hidden behind September's). */
export async function parkReadings(): Promise<Array<Record<string, unknown>>> {
  return getDb().all(
    `SELECT o.id, o.verdict, p.slug AS project, o.updated_at,
            (SELECT COUNT(*) FROM research_fragments f WHERE f.orchestration_id = o.id AND f.status = 'ACCEPTED') AS accepted,
            o.unresolved_gap_policy AS gap_policy,
            (SELECT COUNT(*) FROM russell_goals g WHERE g.project_id = o.project_id AND g.purpose = 'STANDING' AND g.state = 'ACTIVE') AS standing_grants,
            (SELECT m.state FROM russell_missions m WHERE m.orchestration_id = o.id ORDER BY m.created_at DESC LIMIT 1) AS mission,
            (SELECT r.state || ':' || COALESCE(r.answered_choice, '-') FROM russell_missions m JOIN russell_human_requests r ON r.mission_id = m.id
              WHERE m.orchestration_id = o.id ORDER BY r.created_at DESC LIMIT 1) AS card
       FROM research_orchestrations o JOIN projects p ON p.id = o.project_id
      WHERE o.status = 'NEEDS_HUMAN' ORDER BY o.updated_at DESC LIMIT 60`,
  );
}

/**
 * A decision Brain already made that the packet never carried out.
 *
 * Production, 2026-11-06 10:42Z (`packets parks`): twenty packets answered
 * RECORD_GAPS — by Brain under the standing grant or on a card — sat at
 * NEEDS_HUMAN, re-parked by "an audit work item finished without recording
 * anything" because their audit items had spent every attempt during the
 * night's outages. The card reads RESUMED, so nothing asks again. The runner
 * now opens a fresh audit round when attempts are spent (`MAX_AUDIT_REOPENS`);
 * this re-advances the packets already parked that way, a few per tick.
 */
export async function refileDecidedParks(input: { limit?: number; nowMs?: number } = {}): Promise<{ orchestrationId: string; status: string }[]> {
  const now = input.nowMs ?? Date.now();
  const before = new Date(now - ROUTINE_DECISION_GRACE_MS).toISOString();
  const rows = await getDb().all<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM research_orchestrations
      WHERE status = 'NEEDS_HUMAN' AND unresolved_gap_policy = 'RECORD_GAPS'
        AND failure_reason LIKE '%finished without recording anything%' AND updated_at < ?
      ORDER BY updated_at LIMIT ?`,
    [before, input.limit ?? 5],
  );
  const { advancePacket, auditReopensSoFar, MAX_AUDIT_REOPENS } = await import('../research/packetRunner.ts');
  const { getMissionByOrchestration } = await import('../../repos/russellMissions.ts');
  const out: { orchestrationId: string; status: string }[] = [];
  for (const row of rows) {
    if ((await auditReopensSoFar({ id: row.id, projectId: row.project_id })) >= MAX_AUDIT_REOPENS) continue;
    const mission = await getMissionByOrchestration(row.id);
    if (mission && mission.state === 'NEEDS_HUMAN') {
      await transitionMission({ missionId: mission.id, from: 'NEEDS_HUMAN', to: 'RUNNING', waitingOn: null });
    }
    const result = await advancePacket(row.id);
    out.push({ orchestrationId: row.id, status: result.status });
  }
  return out;
}
