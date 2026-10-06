/**
 * What Brain is trying to learn in one project, as a person reads it.
 *
 * Integration 3 gave research its own destination, and this is the one reading
 * behind it: goal → budget → packets → evidence → result. It composes rows that
 * already exist — the research goals and their budget readings, the packets
 * (`research_orchestrations`), their fragments and accepted claims, and any
 * Needs You card open on the mission that owns a packet — and stores nothing.
 *
 * Every packet is placed in exactly one of six **kinds**, because those are the
 * six answers a person needs and they have six different remedies:
 *
 *   - `RUNNING`    — a worker is on it now.
 *   - `WAITING`    — it will continue by itself (queued, repairing what review
 *                    found, out of allowance until it refreshes).
 *   - `RETRYING`   — it was interrupted and Brain is resuming it; nothing for
 *                    a person to do.
 *   - `NEEDS_YOU`  — it is stopped at a decision only a person can make, and
 *                    the card for that decision is open.
 *   - `STOPPED`    — it ended without an answer, or it stopped with nobody
 *                    being asked; the recorded reason is shown verbatim.
 *   - `DONE`       — filed and audited.
 *
 * The status names never reach the primary screen. A `phase` sentence does,
 * and the raw status stays on the row for the details view.
 *
 * It is deliberately a slim projection rather than `listOrchestrationsByProject`
 * re-served: that returns every packet's full report text, which on a project
 * with forty filed reports is megabytes a phone does not need to draw a list.
 */
import { getDb } from '../../db/database.ts';
import type { OrchestrationStatus } from '../../domain/types.ts';
import { listGoalBudgetViews, type GoalBudgetView } from './goalBudgetView.ts';

/** The most recent packets listed; older ones are counted rather than drawn. */
const PACKET_LIMIT = 200;

export const PACKET_KINDS = ['RUNNING', 'WAITING', 'RETRYING', 'NEEDS_YOU', 'STOPPED', 'DONE'] as const;
export type PacketKind = (typeof PACKET_KINDS)[number];

export interface PacketReading {
  id: string;
  title: string;
  goalId: string | null;
  /** Raw, for the details view only. */
  status: OrchestrationStatus;
  kind: PacketKind;
  /** One plain sentence: where this packet has got to. */
  phase: string;
  /** The recorded reason, verbatim, when the packet stopped or is waiting on something. */
  reason: string | null;
  /** `stuck` is blocked or waiting on a person; `open` is still being worked or queued. */
  questions: { total: number; answered: number; open: number; stuck: number; refused: number };
  acceptedClaims: number;
  /** True when a report was filed. */
  filed: boolean;
  documentId: string | null;
  verdict: string | null;
  attempt: number;
  updatedAt: string;
}

export interface GoalReading {
  budget: GoalBudgetView;
  packets: PacketReading[];
  /** Counts by kind across this goal's packets. */
  counts: Record<PacketKind, number>;
}

export interface ResearchOverview {
  goals: GoalReading[];
  /** Packets that belong to no research goal — a mission, a direct assignment. */
  other: PacketReading[];
  counts: Record<PacketKind, number>;
  /** How many fixture or harness packets were left out, so "nothing" is never ambiguous. */
  technicalHidden: number;
  /** How many older packets are not listed, when there are more than the list holds. */
  olderNotShown: number;
  /** The one sentence a person reads first. */
  headline: string;
}

/** Plain words for each status, and the kind it belongs to. Pure. */
export function classifyPacket(input: {
  status: OrchestrationStatus;
  openDecision: boolean;
  failureReason: string | null;
  cancelReason: string | null;
  repairReason: string | null;
  verdict: string | null;
}): { kind: PacketKind; phase: string; reason: string | null } {
  switch (input.status) {
    case 'QUEUED':
      return { kind: 'WAITING', phase: 'Waiting for a worker to pick it up.', reason: null };
    case 'PLANNING':
      return { kind: 'RUNNING', phase: 'Working out which questions to ask.', reason: null };
    case 'RESEARCHING':
      return { kind: 'RUNNING', phase: 'Researching: reading sources and checking each claim.', reason: null };
    case 'SYNTHESIZING':
      return { kind: 'RUNNING', phase: 'Writing up what the evidence established.', reason: null };
    case 'AUDITING':
      return {
        kind: 'RUNNING',
        phase: 'Being checked by three independent reviewers before it counts.',
        reason: null,
      };
    case 'AWAITING_REPAIR':
      return {
        kind: 'WAITING',
        phase: 'The review found gaps; Brain is repairing them by itself.',
        reason: input.repairReason,
      };
    case 'PAUSED_QUOTA':
      return {
        kind: 'WAITING',
        phase: 'Paused until the research allowance refreshes. Everything done so far is kept.',
        reason: null,
      };
    case 'INTERRUPTED':
      return {
        kind: 'RETRYING',
        phase: 'Interrupted; Brain is resuming it from where it stopped.',
        reason: input.failureReason,
      };
    case 'AWAITING_APPROVAL':
      return {
        kind: 'NEEDS_YOU',
        phase: 'Planned, and waiting for someone to approve the plan before anything is spent.',
        reason: null,
      };
    case 'NEEDS_HUMAN':
      return input.openDecision
        ? {
            kind: 'NEEDS_YOU',
            phase: 'Stopped at a decision only a person can make — it is in Needs you.',
            reason: input.failureReason,
          }
        : {
            kind: 'STOPPED',
            phase: 'Stopped, and nobody is currently being asked about it.',
            reason: input.failureReason,
          };
    case 'COMPLETE':
      return { kind: 'DONE', phase: 'Finished: the report is filed and passed review.', reason: null };
    case 'COMPLETE_WITH_GAPS':
      return {
        kind: 'DONE',
        phase: 'Finished with gaps: the report is filed, and the reviewers recorded what it could not settle.',
        reason: null,
      };
    case 'FAILED':
      return { kind: 'STOPPED', phase: 'Ended without an answer.', reason: input.failureReason };
    case 'CANCELLED':
      return { kind: 'STOPPED', phase: 'Stopped.', reason: input.cancelReason };
    default:
      return { kind: 'STOPPED', phase: 'In a state Brain does not describe.', reason: null };
  }
}

function zeroCounts(): Record<PacketKind, number> {
  return { RUNNING: 0, WAITING: 0, RETRYING: 0, NEEDS_YOU: 0, STOPPED: 0, DONE: 0 };
}

function countKinds(packets: PacketReading[]): Record<PacketKind, number> {
  const counts = zeroCounts();
  for (const packet of packets) counts[packet.kind] += 1;
  return counts;
}

/** The first sentence on the Research screen. Pure. */
export function researchHeadline(counts: Record<PacketKind, number>, goals: number): string {
  const total = PACKET_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  if (total === 0) {
    return goals > 0
      ? 'A research goal is set, and no research has started under it yet.'
      : 'Brain is not researching anything in this project right now.';
  }
  const parts: string[] = [];
  if (counts.RUNNING) parts.push(`${counts.RUNNING} being researched now`);
  if (counts.WAITING + counts.RETRYING) parts.push(`${counts.WAITING + counts.RETRYING} continuing by itself`);
  if (counts.NEEDS_YOU) parts.push(`${counts.NEEDS_YOU} waiting on you`);
  if (counts.DONE) parts.push(`${counts.DONE} finished`);
  if (counts.STOPPED) parts.push(`${counts.STOPPED} stopped`);
  return `${parts.join(', ')}.`;
}

interface PacketRow {
  id: string;
  title: string;
  goal_id: string | null;
  status: OrchestrationStatus;
  failure_reason: string | null;
  cancel_reason: string | null;
  repair_reason: string | null;
  document_id: string | null;
  verdict: string | null;
  attempt: number;
  fixture: number | null;
  updated_at: string;
}

export async function researchOverview(projectId: string): Promise<ResearchOverview> {
  const db = getDb();
  /*
   * Four reads, each bounded by the project, rather than one per packet: a
   * project's research list is drawn on a phone and must not cost a query per
   * row (Integration 3's rule that a dashboard must not create database
   * pressure to look live).
   */
  const [rows, fragmentRows, claimRows, decisionRows, budgets] = await Promise.all([
    db.all<PacketRow>(
      `SELECT id, title, goal_id, status, failure_reason, cancel_reason, repair_reason,
              document_id, verdict, attempt, fixture, updated_at
         FROM research_orchestrations
        WHERE project_id = ? AND fixture = 0
        ORDER BY updated_at DESC
        LIMIT ${PACKET_LIMIT}`,
      [projectId],
    ),
    db.all<{ orchestration_id: string; status: string; n: number }>(
      `SELECT f.orchestration_id AS orchestration_id, f.status AS status, COUNT(*) AS n
         FROM research_fragments f
         JOIN research_orchestrations o ON o.id = f.orchestration_id
        WHERE o.project_id = ?
        GROUP BY f.orchestration_id, f.status`,
      [projectId],
    ),
    db.all<{ orchestration_id: string; n: number }>(
      `SELECT c.orchestration_id AS orchestration_id, COUNT(*) AS n
         FROM research_claims c
         JOIN research_orchestrations o ON o.id = c.orchestration_id
        WHERE o.project_id = ? AND c.accepted = 1
        GROUP BY c.orchestration_id`,
      [projectId],
    ),
    db.all<{ orchestration_id: string }>(
      `SELECT DISTINCT m.orchestration_id AS orchestration_id
         FROM russell_missions m
         JOIN russell_human_requests r ON r.mission_id = m.id
        WHERE m.project_id = ? AND r.state = 'OPEN' AND m.orchestration_id IS NOT NULL`,
      [projectId],
    ),
    listGoalBudgetViews(projectId),
  ]);
  const totals = await db.all<{ fixture: number; n: number }>(
    'SELECT fixture, COUNT(*) AS n FROM research_orchestrations WHERE project_id = ? GROUP BY fixture',
    [projectId],
  );
  const hidden = totals.filter((row) => Number(row.fixture) !== 0).reduce((sum, row) => sum + Number(row.n), 0);
  const all = totals.filter((row) => Number(row.fixture) === 0).reduce((sum, row) => sum + Number(row.n), 0);

  const fragments = new Map<string, PacketReading['questions']>();
  for (const row of fragmentRows) {
    const entry = fragments.get(row.orchestration_id) ?? { total: 0, answered: 0, open: 0, stuck: 0, refused: 0 };
    const n = Number(row.n);
    entry.total += n;
    if (row.status === 'ACCEPTED') entry.answered += n;
    else if (row.status === 'REJECTED' || row.status === 'CANCELLED') entry.refused += n;
    else if (row.status === 'BLOCKED' || row.status === 'NEEDS_HUMAN') entry.stuck += n;
    else entry.open += n;
    fragments.set(row.orchestration_id, entry);
  }
  const claims = new Map(claimRows.map((row) => [row.orchestration_id, Number(row.n)]));
  const decided = new Set(decisionRows.map((row) => row.orchestration_id));

  const technicalHidden = hidden;
  const packets: PacketReading[] = [];
  for (const row of rows) {
    const placed = classifyPacket({
      status: row.status,
      openDecision: decided.has(row.id),
      failureReason: row.failure_reason,
      cancelReason: row.cancel_reason,
      repairReason: row.repair_reason,
      verdict: row.verdict,
    });
    packets.push({
      id: row.id,
      title: row.title,
      goalId: row.goal_id,
      status: row.status,
      kind: placed.kind,
      phase: placed.phase,
      reason: placed.reason,
      questions: fragments.get(row.id) ?? { total: 0, answered: 0, open: 0, stuck: 0, refused: 0 },
      acceptedClaims: claims.get(row.id) ?? 0,
      filed: row.document_id !== null,
      documentId: row.document_id,
      verdict: row.verdict,
      attempt: Number(row.attempt),
      updatedAt: row.updated_at,
    });
  }

  const byGoal = new Map<string, PacketReading[]>();
  const other: PacketReading[] = [];
  for (const packet of packets) {
    if (packet.goalId && budgets.some((budget) => budget.goalId === packet.goalId)) {
      const list = byGoal.get(packet.goalId) ?? [];
      list.push(packet);
      byGoal.set(packet.goalId, list);
    } else {
      other.push(packet);
    }
  }
  const goals: GoalReading[] = budgets.map((budget) => {
    const list = byGoal.get(budget.goalId) ?? [];
    return { budget, packets: list, counts: countKinds(list) };
  });
  const counts = countKinds(packets);
  return {
    goals,
    other,
    counts,
    technicalHidden,
    olderNotShown: Math.max(0, all - rows.length),
    headline: researchHeadline(counts, goals.length),
  };
}
