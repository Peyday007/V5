/**
 * A packet whose judge asked for more, resumed by Brain where Brain may.
 *
 * Production, 2026-10-20: 120 packets sat at NEEDS_HUMAN — 87 on a PATCH
 * verdict and 33 on MORE_RESEARCH — each saying a person must choose between
 * filing short and stopping. For most of them neither is the honest answer.
 *
 * - **PATCH** is defined in `GAP_CLASSIFICATIONS` as *"evidence already
 *   suffices; correct it in synthesis, no new research"*. What it asks for is a
 *   corrected report and an independent audit of it, and nothing about that
 *   needs a person or spends anything new. The runner treated it exactly like
 *   MORE_RESEARCH, so 87 packets waited for a decision nobody needed to make.
 * - **MORE_RESEARCH** whose judge wrote a bounded `research_question` on a
 *   research-justifying gap is work the packet's own approval may already
 *   cover. The question becomes a follow-up fragment created `PLANNED`, so it
 *   is approved by exactly the mechanism the original plan was — the envelope
 *   check, the research goal, or a person — and by nothing invented here.
 *
 * A resumed packet runs one more round: the follow-up fragments (if any), a new
 * synthesis that is told what the judge asked to be corrected, and all three
 * audit roles again. The round boundary is an append-only
 * `RESEARCH_ROUND_RESUMED` event read by `auditRound.ts`, so the previous
 * round's passes, report and verdict stay exactly as written (§5) and only stop
 * counting for the new round.
 *
 * What it never does: authorize unresolved gaps, lower an evidence bar, accept
 * a claim, approve a plan, or touch a packet a person has answered. Everything
 * that cannot be resumed this way stays at NEEDS_HUMAN with its reason, and the
 * reading says why (`assessJudgeRound`). Rounds are bounded by
 * `MAX_JUDGE_ROUNDS`, after which the question is genuinely a person's.
 */
import { getDb } from '../../db/database.ts';
import { getAudit } from '../../repos/audits.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  citableClaims,
  createFragments,
  currentFragments,
  FragmentBudgetRefused,
  getOrchestration,
  listFragments,
  updateOrchestration,
} from '../../repos/research.ts';
import {
  getMissionByOrchestration,
  transitionMission,
  withdrawRequest,
} from '../../repos/russellMissions.ts';
import { binForOrchestration, regrantBinAttempts, reopenNeedsHumanBin } from '../../repos/bins.ts';
import { parseJson } from '../../repos/util.ts';
import { RESEARCH_JUSTIFYING_GAPS } from '../../domain/types.ts';
import type { AuditGap, ResearchOrchestration } from '../../domain/types.ts';

/** How many corrected rounds Brain runs on one packet before the question is a person's. */
export const MAX_JUDGE_ROUNDS = 2;
/**
 * The floor on how many resumed packets may be in their new round at once.
 *
 * It was the whole limit, and production measured what that cost: six resumed
 * packets were live, four of them waiting in AUDITING for independent sessions,
 * so no further packet could be resumed and the backlog drained at about the
 * rate new ones parked. The live count is now sized to the research surfaces
 * that can run it (`liveJudgeRoundCap`), with this as the floor and
 * `MAX_LIVE_JUDGE_ROUNDS_CEILING` above it, and none at all while the database
 * is shedding optional work.
 */
export const MAX_LIVE_JUDGE_ROUNDS = 6;
/** The most resumed rounds that may be live however many surfaces there are. */
export const MAX_LIVE_JUDGE_ROUNDS_CEILING = 12;
/** Follow-up questions one round may add. */
export const MAX_FOLLOW_UPS_PER_ROUND = 3;
export const JUDGE_ROUND_EVENT = 'RESEARCH_ROUND_RESUMED';
const JUDGE_ROUND_ACTOR = 'SYSTEM:judge-round';
/** The one-time bin regrant a resumed round may receive when its bin is spent. */
const JUDGE_ROUND_BIN_ATTEMPTS = 5;
const DIVE_ENVELOPE = 'RUSSELL_CASH_VALIDATION_V1';
const RESUMABLE_VERDICTS = new Set(['PATCH', 'MORE_RESEARCH']);

export type JudgeRoundAssessment =
  | {
      kind: 'RESUME';
      verdict: string;
      auditId: string;
      round: number;
      judgeSummary: string;
      judgeNextAction: string | null;
      corrections: AuditGap[];
      followUps: AuditGap[];
    }
  | { kind: 'PERSON'; reason: string }
  | { kind: 'CONTINUED_ELSEWHERE'; reason: string }
  | { kind: 'NOT_PARKED' };

/** Whether this is the park this module answers: a judge asked for more, and a person was asked. */
export function isJudgePark(orchestration: ResearchOrchestration): boolean {
  return (
    orchestration.status === 'NEEDS_HUMAN' &&
    orchestration.verdict !== null &&
    RESUMABLE_VERDICTS.has(orchestration.verdict) &&
    /^The judge's verdict was (?:PATCH|MORE_RESEARCH)\b/.test(orchestration.failureReason ?? '')
  );
}

/** The corrected rounds this packet has already been given. */
export async function judgeRoundsSoFar(orchestration: ResearchOrchestration): Promise<number> {
  const rows = await getDb().all<{ payload: string }>(
    `SELECT payload FROM project_events WHERE project_id = ? AND event_type = ?`,
    [orchestration.projectId, JUDGE_ROUND_EVENT],
  );
  return rows.filter(
    (row) => parseJson<Record<string, unknown>>(row.payload, {})['orchestrationId'] === orchestration.id,
  ).length;
}

/**
 * Why a packet launched to answer a cash need no longer bears on any decision,
 * or null when it still does (invariant 43).
 *
 * A corrected round re-runs synthesis and three audits. Production,
 * 2026-10-21: September "Payer for …" packets about evidence-tier openings
 * were being resumed and re-parked while their need had been asked again in a
 * new shape, settled, or its opening declined — research capacity spent on
 * answers nothing reads. Read from rows: the need this idea asked (matched by
 * the need's own `blocked_action`, which is the idea's title), its state, and
 * its opening's. Not a cash need at all is null — this says nothing about it.
 */
async function noDecisionConsumes(projectId: string, candidateId: string): Promise<string | null> {
  const db = getDb();
  const candidate = await db.get<{ title: string }>('SELECT title FROM russell_candidates WHERE id = ?', [candidateId]);
  const need =
    (await db.get<{ id: string; state: string; opportunity_id: string | null; candidate_id: string | null }>(
      'SELECT id, state, opportunity_id, candidate_id FROM cash_needs WHERE candidate_id = ? LIMIT 1',
      [candidateId],
    )) ??
    (candidate
      ? await db.get<{ id: string; state: string; opportunity_id: string | null; candidate_id: string | null }>(
          `SELECT id, state, opportunity_id, candidate_id FROM cash_needs
            WHERE project_id = ? AND blocked_action = ? LIMIT 1`,
          [projectId, candidate.title],
        )
      : undefined);
  if (!need) return null;
  if (need.candidate_id && need.candidate_id !== candidateId) {
    return `Its cash need (${need.id}) has since been asked again by another idea, so this packet's answer is read by nothing.`;
  }
  if (need.state !== 'OPEN') {
    return `Its cash need (${need.id}) is ${need.state}, so no decision is waiting on this packet's answer.`;
  }
  if (need.opportunity_id) {
    const opportunity = await db.get<{ state: string; duplicate_of_id: string | null }>(
      'SELECT state, duplicate_of_id FROM cash_opportunities WHERE id = ?',
      [need.opportunity_id],
    );
    if (opportunity?.duplicate_of_id) {
      return `Its opening is a duplicate of ${opportunity.duplicate_of_id}, so no decision is waiting on this packet's answer.`;
    }
    if (opportunity && (opportunity.state === 'DECLINED' || opportunity.state === 'ARCHIVED')) {
      return `Its opening is ${opportunity.state}, so no decision is waiting on this packet's answer.`;
    }
  }
  return null;
}

/** What may be done about one parked packet, from its rows alone. Writes nothing. */
export async function assessJudgeRound(orchestration: ResearchOrchestration): Promise<JudgeRoundAssessment> {
  if (!isJudgePark(orchestration) || !orchestration.auditId) return { kind: 'NOT_PARKED' };
  // A person already authorized filing short: the runner files it, nothing to resume.
  if (orchestration.unresolvedGapPolicy === 'RECORD_GAPS') return { kind: 'NOT_PARKED' };
  if (orchestration.approvalEnvelopeId === DIVE_ENVELOPE) {
    return {
      kind: 'CONTINUED_ELSEWHERE',
      reason:
        'A cash deep dive: the opening it qualifies continues with its next dive round, which reads ' +
        'this packet\'s accepted claims, so resuming the packet would research the same question twice.',
    };
  }
  const mission = await getMissionByOrchestration(orchestration.id);
  if (mission && ['CANCELLED', 'FAILED', 'DONE'].includes(mission.state)) return { kind: 'NOT_PARKED' };
  if (mission) {
    const answered = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_human_requests WHERE mission_id = ? AND state = 'ANSWERED'`,
      [mission.id],
    );
    if (Number(answered?.n ?? 0) > 0) {
      return { kind: 'PERSON', reason: 'A person has answered this packet\'s question; their answer is carried out as given.' };
    }
  }
  if (mission?.candidateId) {
    const unconsumed = await noDecisionConsumes(orchestration.projectId, mission.candidateId);
    if (unconsumed) return { kind: 'CONTINUED_ELSEWHERE', reason: unconsumed };
  }
  const rounds = await judgeRoundsSoFar(orchestration);
  if (rounds >= MAX_JUDGE_ROUNDS) {
    return {
      kind: 'PERSON',
      reason:
        `Brain has already run ${rounds} corrected round(s) on this packet and the judge still asked for ` +
        'more; whether to file it short or stop it is a person\'s decision.',
    };
  }
  const audit = await getAudit(orchestration.auditId);
  if (!audit) return { kind: 'PERSON', reason: `The judge's audit ${orchestration.auditId} cannot be read.` };
  const followUps = audit.gaps.filter(
    (gap) =>
      (RESEARCH_JUSTIFYING_GAPS as readonly string[]).includes(gap.classification) &&
      (gap.researchQuestion ?? '').trim().length > 0,
  );
  const corrections = audit.gaps.filter((gap) => gap.classification === 'PATCH');
  if (orchestration.verdict === 'MORE_RESEARCH' && followUps.length === 0) {
    return {
      kind: 'PERSON',
      reason:
        'The judge asked for more research and named no bounded research question, so there is nothing ' +
        'Brain can research without deciding the scope itself.',
    };
  }
  if (followUps.length > 0 && (await currentFragments(orchestration.id)).length === 0) {
    return { kind: 'PERSON', reason: 'The packet has no fragment whose scope a follow-up question could inherit.' };
  }
  return {
    kind: 'RESUME',
    verdict: orchestration.verdict!,
    auditId: orchestration.auditId,
    round: rounds + 1,
    judgeSummary: audit.summary,
    judgeNextAction: audit.nextAction,
    corrections,
    followUps: followUps.slice(0, MAX_FOLLOW_UPS_PER_ROUND),
  };
}

export interface JudgeRoundResult {
  orchestrationId: string;
  outcome: 'RESUMED' | 'PERSON' | 'CONTINUED_ELSEWHERE' | 'SKIPPED';
  reason: string | null;
}

/**
 * Begin one corrected round, or say why not.
 *
 * The packet moves first, by a compare-and-swap naming the state and the audit
 * it was read with, so two ticks produce one round. Everything after it is
 * derived and idempotent: the fragments, the card withdrawal, the mission and
 * the bin, then the ordinary advance that queues the work.
 */
export async function resumeJudgeRound(orchestrationId: string): Promise<JudgeRoundResult> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) return { orchestrationId, outcome: 'SKIPPED', reason: 'no such packet' };
  const assessed = await assessJudgeRound(orchestration);
  if (assessed.kind === 'NOT_PARKED') return { orchestrationId, outcome: 'SKIPPED', reason: null };
  if (assessed.kind === 'PERSON') return { orchestrationId, outcome: 'PERSON', reason: assessed.reason };
  if (assessed.kind === 'CONTINUED_ELSEWHERE') {
    return { orchestrationId, outcome: 'CONTINUED_ELSEWHERE', reason: assessed.reason };
  }

  const now = new Date().toISOString();
  const moved = await getDb().run(
    `UPDATE research_orchestrations
        SET status = 'RESEARCHING', failure_reason = NULL, document_id = NULL, audit_id = NULL,
            verdict = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'NEEDS_HUMAN' AND audit_id = ?`,
    [now, orchestration.id, assessed.auditId],
  );
  if (moved.changes !== 1) return { orchestrationId, outcome: 'SKIPPED', reason: 'moved underneath' };

  const fragmentKeys: string[] = [];
  let budgetRefusal: string | null = null;
  if (assessed.followUps.length > 0) {
    const all = await listFragments(orchestration.id);
    const template =
      (await currentFragments(orchestration.id)).find((fragment) => fragment.status === 'ACCEPTED') ??
      (await currentFragments(orchestration.id))[0]!;
    const existingClaimIds = (await citableClaims(orchestration.id)).map((claim) => claim.id).slice(0, 200);
    let index = all.reduce((max, fragment) => Math.max(max, fragment.fragmentIndex), 0);
    const inputs = assessed.followUps.map((gap, i) => {
      index += 1;
      const key = `judge-r${assessed.round}-${i + 1}`;
      fragmentKeys.push(key);
      return {
        orchestrationId: orchestration.id,
        projectId: orchestration.projectId,
        layerId: orchestration.layerId,
        fragmentIndex: index,
        fragmentKey: key,
        question: gap.researchQuestion!.trim(),
        geography: template.geography,
        timeframe: template.timeframe,
        population: template.population,
        definitions: template.definitions,
        requiredEvidence: template.requiredEvidence,
        acceptableSourceTypes: template.acceptableSourceTypes,
        excludedSourceTypes: template.excludedSourceTypes,
        completionCriteria: template.completionCriteria,
        dependsOn: [],
        minIndependentSources: template.minIndependentSources,
        whyItMatters: `The judge's ${gap.classification}: ${gap.title}. ${gap.detail}`.slice(0, 1_000),
        missingEvidence: gap.detail.slice(0, 1_000),
        existingClaimIds,
        expectedClaimTypes: template.expectedClaimTypes,
        prohibitedEvidence: template.prohibitedEvidence,
        failureConditions: template.failureConditions,
        status: 'PLANNED' as const,
      };
    });
    try {
      await createFragments(inputs);
    } catch (error) {
      if (!(error instanceof FragmentBudgetRefused)) throw error;
      budgetRefusal = error.detail;
    }
  }

  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: JUDGE_ROUND_EVENT,
    payload: {
      orchestrationId: orchestration.id,
      round: assessed.round,
      roundStartedAt: now,
      previousAuditId: assessed.auditId,
      previousDocumentId: orchestration.documentId,
      verdict: assessed.verdict,
      judgeSummary: assessed.judgeSummary.slice(0, 2_000),
      judgeNextAction: assessed.judgeNextAction?.slice(0, 1_000) ?? null,
      corrections: assessed.corrections.map((gap) => ({ title: gap.title, detail: gap.detail })),
      followUpFragments: budgetRefusal ? [] : fragmentKeys,
      actor: JUDGE_ROUND_ACTOR,
    },
  });

  if (budgetRefusal) {
    // A ceiling a person set is theirs to raise; the round stops here, named.
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason: `The judge asked for more research and the research budget a person set refuses it: ${budgetRefusal}`,
    });
    return { orchestrationId, outcome: 'PERSON', reason: budgetRefusal };
  }

  const mission = await getMissionByOrchestration(orchestration.id);
  if (mission) {
    const open = await getDb().all<{ id: string }>(
      `SELECT id FROM russell_human_requests WHERE mission_id = ? AND state = 'OPEN'`,
      [mission.id],
    );
    for (const request of open) {
      await withdrawRequest({
        requestId: request.id,
        reason:
          `Withdrawn by Brain: the judge's ${assessed.verdict} named what to correct` +
          (assessed.followUps.length > 0 ? ' and what to research' : '') +
          ', so Brain is running a corrected round with a fresh independent audit. Nothing here needs deciding.',
      });
    }
    if (mission.state === 'NEEDS_HUMAN' && !mission.writebackAt) {
      await transitionMission({ missionId: mission.id, from: 'NEEDS_HUMAN', to: 'RUNNING', terminalReason: null });
    }
  }

  const bin = await binForOrchestration(orchestration.id);
  if (bin && bin.state === 'NEEDS_HUMAN') {
    if (bin.attemptCount >= bin.maxAttempts) {
      await regrantBinAttempts({
        binId: bin.id,
        maxAttempts: bin.attemptCount + JUDGE_ROUND_BIN_ATTEMPTS,
        reason: 'judge-round',
      });
    }
    await reopenNeedsHumanBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: JUDGE_ROUND_ACTOR,
      reason: `Corrected round ${assessed.round} after the judge's ${assessed.verdict}.`,
      resolutionEvidence: { orchestrationId: orchestration.id, previousAuditId: assessed.auditId },
    });
  }

  const { advancePacket } = await import('./packetRunner.ts');
  await advancePacket(orchestration.id);
  return { orchestrationId, outcome: 'RESUMED', reason: null };
}

/** Packets in a corrected round that has not finished yet. */
async function liveJudgeRounds(): Promise<number> {
  const rows = await getDb().all<{ payload: string }>(
    `SELECT payload FROM project_events WHERE event_type = ? ORDER BY created_at DESC LIMIT 500`,
    [JUDGE_ROUND_EVENT],
  );
  const ids = [...new Set(rows.map((row) => parseJson<Record<string, unknown>>(row.payload, {})['orchestrationId']))]
    .filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const live = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM research_orchestrations
      WHERE id IN (${placeholders}) AND status NOT IN ('COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELLED','NEEDS_HUMAN')`,
    ids,
  );
  return Number(live?.n ?? 0);
}

/**
 * How many resumed rounds may be live at once, from the fleet that runs them.
 *
 * A resumed round is a corrected synthesis and three audit roles, each from its
 * own session; what bounds how many can progress together is how many sessions
 * the fleet can start, which is one per routable research surface. So the cap is
 * that count, never below the old fixed six and never above the ceiling, and
 * zero while the database is shedding — a resumed round is optional work, and
 * starting more of it is what shedding exists to stop. An unreadable fleet is
 * the floor, never "plenty".
 */
export async function liveJudgeRoundCap(): Promise<number> {
  try {
    const { databasePressure } = await import('../../db/pressure.ts');
    if (databasePressure().state === 'SHEDDING') return 0;
  } catch {
    // An unreadable pressure reading changes nothing; the floor below still applies.
  }
  let surfaces = 0;
  try {
    const { sharedFleetSnapshot } = await import('../dispatch/candidates.ts');
    const { surfaceIneligibility } = await import('../dispatch/router.ts');
    const snapshot = await sharedFleetSnapshot();
    for (const candidate of snapshot.candidates) {
      if (surfaceIneligibility(candidate) !== null) continue;
      if (Array.isArray(candidate.servesFamilies) && !candidate.servesFamilies.includes('RESEARCH')) continue;
      surfaces += 1;
    }
  } catch {
    surfaces = 0;
  }
  return Math.min(MAX_LIVE_JUDGE_ROUNDS_CEILING, Math.max(MAX_LIVE_JUDGE_ROUNDS, surfaces));
}

/**
 * The tick's pass: resume what may be resumed, oldest park first, a few at a time.
 *
 * Derived from rows, so it reaches the packets already parked and every new
 * one, and bounded by `MAX_LIVE_JUDGE_ROUNDS` so a backlog drains beside fresh
 * work rather than instead of it.
 */
export async function resumeJudgeParkedPackets(
  input: { limit?: number; cap?: number } = {},
): Promise<JudgeRoundResult[]> {
  const cap = input.cap ?? (await liveJudgeRoundCap());
  const room = Math.min(input.limit ?? cap, cap - (await liveJudgeRounds()));
  if (room <= 0) return [];
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM research_orchestrations
      WHERE status = 'NEEDS_HUMAN' AND verdict IN ('PATCH', 'MORE_RESEARCH') AND audit_id IS NOT NULL
      ORDER BY updated_at ASC LIMIT 200`,
  );
  const results: JudgeRoundResult[] = [];
  let resumed = 0;
  for (const row of rows) {
    if (resumed >= room) break;
    const result = await resumeJudgeRound(row.id);
    if (result.outcome === 'SKIPPED') continue;
    results.push(result);
    if (result.outcome === 'RESUMED') resumed += 1;
  }
  return results;
}

/** Every parked judge packet and what this module would do about it, for the operator report. */
export async function judgeParkReadings(): Promise<Array<{ orchestration: ResearchOrchestration; assessed: JudgeRoundAssessment }>> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM research_orchestrations
      WHERE status = 'NEEDS_HUMAN' AND verdict IN ('PATCH', 'MORE_RESEARCH') ORDER BY updated_at ASC`,
  );
  const out: Array<{ orchestration: ResearchOrchestration; assessed: JudgeRoundAssessment }> = [];
  for (const row of rows) {
    const orchestration = await getOrchestration(row.id);
    if (!orchestration) continue;
    out.push({ orchestration, assessed: await assessJudgeRound(orchestration) });
  }
  return out;
}

/**
 * What a resumed round's synthesis must correct, from the event that began it.
 *
 * Null when the packet is in its first round, so an ordinary synthesis sees
 * exactly what it always did.
 */
export async function correctionsForRound(orchestration: ResearchOrchestration): Promise<{
  round: number;
  previousVerdict: string;
  judgeSummary: string;
  judgeNextAction: string | null;
  corrections: Array<{ title: string; detail: string }>;
  instruction: string;
} | null> {
  const rows = await getDb().all<{ payload: string }>(
    `SELECT payload FROM project_events WHERE project_id = ? AND event_type = ? ORDER BY created_at DESC`,
    [orchestration.projectId, JUDGE_ROUND_EVENT],
  );
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload, {});
    if (payload['orchestrationId'] !== orchestration.id) continue;
    const corrections = Array.isArray(payload['corrections'])
      ? (payload['corrections'] as Array<{ title?: unknown; detail?: unknown }>).map((entry) => ({
          title: String(entry.title ?? ''),
          detail: String(entry.detail ?? ''),
        }))
      : [];
    return {
      round: Number(payload['round'] ?? 1),
      previousVerdict: String(payload['verdict'] ?? ''),
      judgeSummary: String(payload['judgeSummary'] ?? ''),
      judgeNextAction: typeof payload['judgeNextAction'] === 'string' ? payload['judgeNextAction'] : null,
      corrections,
      instruction:
        'This is a corrected round. The previous report was judged ' +
        `${String(payload['verdict'] ?? '')}; write a new report from the claims to cite that fixes every ` +
        'correction listed here, cites only accepted claims, and says plainly what the evidence still ' +
        'does not settle rather than overstating it.',
    };
  }
  return null;
}

/** How far back a judge's corrections still teach a first synthesis. */
export const RECENT_CORRECTIONS_WINDOW_MS = 14 * 86_400_000;
/** At most this many are handed over, most frequent first. */
export const RECENT_CORRECTIONS_LIMIT = 6;
const recentCorrectionsCache = new Map<string, { at: number; value: RecentJudgeCorrections | null }>();

export interface RecentJudgeCorrections {
  /** How many PATCH corrections independent judges recorded in the window. */
  sample: number;
  corrections: Array<{ title: string; times: number }>;
  instruction: string;
}

/** Tests: forget the reading. */
export function resetRecentCorrections(): void {
  recentCorrectionsCache.clear();
}

/**
 * What independent judges in this project recently asked other reports to
 * correct, for a first synthesis to avoid before it is judged (§80).
 *
 * Production, 2026-11-01: of 45 packets judged in six hours, 22 drew PATCH or
 * MORE_RESEARCH, and a PATCH costs a corrected round — a new synthesis and all
 * three audit roles again, on the scarcest capacity Brain has (three
 * concurrent session identities). Telling the author what judges keep
 * correcting is context, never a control: the judge, the gate and the floor are
 * untouched, and the titles are the judges' own words. Cached ten minutes per
 * project, because a judgement a minute old changes nothing (§61).
 */
export async function recentJudgeCorrections(projectId: string, nowMs: number = Date.now()): Promise<RecentJudgeCorrections | null> {
  const hit = recentCorrectionsCache.get(projectId);
  const reuse = process.env['BRAIN_SHARED_SNAPSHOT_MS'] === '0' ? 0 : 10 * 60_000;
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < reuse) return hit.value;
  const since = new Date(nowMs - RECENT_CORRECTIONS_WINDOW_MS).toISOString();
  const rows = await getDb().all<{ title: string }>(
    `SELECT g.title AS title FROM audit_gaps g JOIN audits a ON a.id = g.audit_id
      WHERE a.project_id = ? AND g.classification = 'PATCH' AND g.created_at >= ?
      ORDER BY g.created_at DESC LIMIT 300`,
    [projectId, since],
  );
  const counts = new Map<string, { title: string; times: number }>();
  for (const row of rows) {
    const title = row.title.trim().slice(0, 200);
    if (!title) continue;
    const key = title.toLowerCase().replace(/\s+/g, ' ');
    const entry = counts.get(key) ?? { title, times: 0 };
    entry.times += 1;
    counts.set(key, entry);
  }
  const corrections = [...counts.values()]
    .sort((a, b) => b.times - a.times || a.title.localeCompare(b.title))
    .slice(0, RECENT_CORRECTIONS_LIMIT);
  const value: RecentJudgeCorrections | null =
    corrections.length === 0
      ? null
      : {
          sample: rows.length,
          corrections,
          instruction:
            'Independent judges recently asked other reports in this project to correct these. Before you submit, ' +
            'check this report does not make the same mistakes. This changes no rule: the judge still decides.',
        };
  recentCorrectionsCache.set(projectId, { at: nowMs, value });
  return value;
}
