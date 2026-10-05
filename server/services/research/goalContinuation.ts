/**
 * Autonomous continuation for a research goal.
 *
 * A person approves a research goal once — its ceilings, its deadline, what it
 * is for. After that Brain creates the packets the goal needs, inside those
 * ceilings, without asking again. This is the whole of that: one pass, run on
 * the durable Russell tick, that decides for each active goal whether another
 * packet is needed and starts it through the existing `startPacket` in
 * GOAL_BUDGET mode.
 *
 * It adds no queue, no scheduler and no polling loop. It is derived from rows
 * every time, so a restart, a second instance or a retry produces the same
 * answer, and the one thing that makes two passes produce one packet is the key
 * they both compute: `round-<n>`, where n is one more than the goal's packet
 * count. `startPacket` replays a packet it already holds for that key, so the
 * exclusion is the database's (`UNIQUE (goal_id, goal_packet_key)`), never a
 * lock in this process.
 *
 *   - The archive is asked first, through `coverBeforeWork`. When it already
 *     answers the assignment nothing starts: a ceiling is a ceiling, not a
 *     target, and zero packets is a correct number of packets.
 *   - A goal with a live packet is left alone. A packet waiting on a person
 *     (`NEEDS_HUMAN`) is live: starting another beside it would spend a
 *     ceiling on a question already being asked.
 *   - A ceiling that stops a packet is not a failure. It raises exactly one
 *     request for a person, naming the ceiling, because raising one is their
 *     decision and never this code's. Everything accepted stays.
 *   - Money is not here at all. `startPacket` pins it at zero and refuses a
 *     claim otherwise.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { nowIso } from '../../repos/util.ts';
import { askHuman } from '../../repos/russellMissions.ts';
import { listCoverage, listRequirements } from '../../repos/reconciliation.ts';
import { coverBeforeWork } from '../russell/coverage.ts';
import { inventoryProject } from '../reconcile/plan.ts';
import { TERMINAL_ORCHESTRATION } from './outcome.ts';
import { GoalBudgetExhausted, startPacket } from './startPacket.ts';

/** How many goals one pass looks at. A pass is bounded; the next tick takes the rest. */
export const MAX_GOALS_PER_PASS = 5;

/** What the pass did, for the tick's report. Nothing here is state. */
export interface GoalContinuationReport {
  considered: number;
  started: { goalId: string; packetKey: string; orchestrationId: string }[];
  /** Goals whose assignment the archive already answers. */
  answeredByArchive: string[];
  /** Goals a ceiling stopped, and which one. */
  stopped: { goalId: string; ceiling: 'PACKETS' | 'FRAGMENTS' | 'DEADLINE'; asked: boolean }[];
  /** Goals that could not be advanced, with a reason. Left exactly as they were. */
  skipped: { goalId: string; reason: string }[];
}

interface GoalRow {
  id: string;
  project_id: string;
  name: string;
  research_assignment: string;
  research_layer_id: string | null;
  max_missions: number;
  max_fragments: number;
  expires_at: string | null;
  research_archive_marker: string | null;
}

interface PacketRow {
  id: string;
  status: string;
}

/** Coverage that leaves nothing for research to do on a requirement. */
const SETTLED_COVERAGE = new Set(['SATISFIED', 'NOT_REQUIRED', 'OWNED_ELSEWHERE', 'SUPERSEDED']);

/**
 * Did a finished packet leave something unanswered?
 *
 * Read from the packet's own rows, never from prose: a filed-short packet says
 * so in its status, and otherwise a mandatory research requirement whose latest
 * coverage is not settled is an unresolved one. A requirement with no coverage
 * row at all is unresolved, because nothing established that it was answered.
 */
async function leftUnresolved(packet: PacketRow): Promise<boolean> {
  if (packet.status === 'COMPLETE_WITH_GAPS') return true;
  const [requirements, coverage] = await Promise.all([
    listRequirements(packet.id),
    listCoverage(packet.id),
  ]);
  const latest = new Map<string, string>();
  for (const row of coverage) latest.set(row.requirementId, row.status);
  return requirements.some((requirement) => {
    if (requirement.necessity !== 'MANDATORY' || requirement.kind !== 'RESEARCH') return false;
    const status = latest.get(requirement.id);
    return status === undefined || !SETTLED_COVERAGE.has(status);
  });
}

type Ceiling = 'PACKETS' | 'FRAGMENTS' | 'DEADLINE';

/**
 * The question's key: the goal, the ceiling and the value that ceiling holds
 * now. The value is what lets a ceiling a person raised and then reached again
 * ask a new question; with only the goal and the ceiling the answered row would
 * be returned for ever and nobody would be asked. Never a clock, an attempt or a
 * lease.
 */
function ceilingRequestKey(
  goalId: string,
  ceiling: Ceiling,
  limits: { max_missions: number; max_fragments: number; expires_at: string | null },
): string {
  const value =
    ceiling === 'PACKETS' ? limits.max_missions : ceiling === 'FRAGMENTS' ? limits.max_fragments : limits.expires_at;
  return `goal-budget:${goalId}:${ceiling}:${value ?? 'none'}`;
}

/** Is a question about this goal's current ceilings still waiting on a person? */
async function hasOpenCeilingRequest(goal: GoalRow): Promise<boolean> {
  const keys = (['PACKETS', 'FRAGMENTS', 'DEADLINE'] as const).map((ceiling) =>
    ceilingRequestKey(goal.id, ceiling, goal),
  );
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM russell_human_requests
      WHERE state = 'OPEN' AND resume_key IN (?, ?, ?) LIMIT 1`,
    keys,
  );
  return rows.length > 0;
}

async function askAboutCeiling(
  goal: GoalRow,
  ceiling: Ceiling,
  detail: string,
): Promise<boolean> {
  const { created } = await askHuman({
    projectId: goal.project_id,
    authorityNeeded: `Raising the research goal's ${ceiling} ceiling`,
    whyNotRussell:
      `The research goal "${goal.name}" has reached its ${ceiling} ceiling, so Brain has stopped ` +
      `creating work for it. ${detail} Raising a ceiling is your decision, not Brain's. ` +
      'Everything already researched, accepted and filed stays exactly as it is.',
    recommendation: null,
    choices: [
      {
        key: 'LEAVE_STOPPED',
        label: 'Leave it stopped',
        consequence: 'Nothing more is researched for this goal. All accepted work stays.',
      },
      {
        key: 'RAISE_CEILING',
        label: `Raise the ${ceiling.toLowerCase()} ceiling`,
        consequence:
          'You raise it on the goal itself; Brain then continues from where it stopped, ' +
          'with no packet repeated.',
      },
    ],
    urgency: 'WHENEVER',
    // The goal, the ceiling and its value: the same stop asked on every tick is
    // one request, and a raised ceiling reached again is a new one.
    resumeKey: ceilingRequestKey(goal.id, ceiling, goal),
  });
  return created;
}

/**
 * What the archive looked like when it was asked, from narrow indexed reads and
 * from state that already moves when the inputs to `coverBeforeWork` move: the
 * project's newest event (every import, extraction and filing records one), the
 * shared findings the coverage reads (their count, newest change, and the
 * earliest expiry still ahead of Brain's clock, so passing it changes the
 * marker), and the goal's own assignment and layer. Never a timer: an unchanged
 * marker is the only reason the archive is not read again.
 */
async function archiveMarker(goal: GoalRow, now: string): Promise<{ marker: string; since: string }> {
  const db = getDb();
  const [events, findings, expiry] = await Promise.all([
    db.all<{ at: string | null }>(
      'SELECT MAX(created_at) AS at FROM project_events WHERE project_id = ?',
      [goal.project_id],
    ),
    db.all<{ n: number | string; at: string | null }>(
      'SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM shared_findings',
      [],
    ),
    db.all<{ at: string | null }>(
      `SELECT MIN(valid_until) AS at FROM shared_findings
        WHERE state = 'ACTIVE' AND valid_until IS NOT NULL AND valid_until > ?`,
      [now],
    ),
  ]);
  const lastEvent = events[0]?.at ?? '';
  const count = Number(findings[0]?.n ?? 0);
  const lastFinding = findings[0]?.at ?? '';
  const nextExpiry = expiry[0]?.at ?? '';
  const own = createHash('sha256')
    .update(`${goal.research_assignment}\u0000${goal.research_layer_id ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return {
    marker: `v1|e=${lastEvent}|n=${count}|u=${lastFinding}|x=${nextExpiry}|g=${own}`,
    since: [lastEvent, lastFinding].filter(Boolean).sort().pop() ?? 'the goal began',
  };
}

async function recordArchiveMarker(goalId: string, marker: string | null): Promise<void> {
  await getDb().run('UPDATE russell_goals SET research_archive_marker = ? WHERE id = ?', [marker, goalId]);
}

async function advanceOne(goal: GoalRow, report: GoalContinuationReport): Promise<void> {
  if (!goal.research_layer_id) {
    report.skipped.push({ goalId: goal.id, reason: 'the goal names no layer to file under' });
    return;
  }
  if (await hasOpenCeilingRequest(goal)) {
    report.skipped.push({ goalId: goal.id, reason: 'waiting on a person about a ceiling' });
    return;
  }

  // The goal's own packets: one narrow read on the indexed goal_id.
  const packets = await getDb().all<PacketRow>(
    `SELECT id, status FROM research_orchestrations
      WHERE goal_id = ? ORDER BY created_at, id`,
    [goal.id],
  );
  if (packets.some((packet) => !TERMINAL_ORCHESTRATION.has(packet.status))) {
    report.skipped.push({ goalId: goal.id, reason: 'a packet of this goal is still live' });
    return;
  }

  const latest = packets[packets.length - 1];
  if (latest) {
    // A person cancelled it; continuing is not the goal's call to make.
    if (latest.status === 'CANCELLED') {
      report.skipped.push({ goalId: goal.id, reason: 'the latest packet was cancelled' });
      return;
    }
    if (!(await leftUnresolved(latest))) {
      report.skipped.push({ goalId: goal.id, reason: 'the latest packet left nothing unresolved' });
      return;
    }
  }

  // Ask the archive first. A goal it already answers starts nothing.
  // A marker taken when it last answered, and unchanged since, is the same
  // answer: the archive is read again only when something it reads moved.
  const now = nowIso();
  const current = await archiveMarker(goal, now);
  if (goal.research_archive_marker !== null && goal.research_archive_marker === current.marker) {
    report.answeredByArchive.push(goal.id);
    report.skipped.push({
      goalId: goal.id,
      reason: `answered by the archive; unchanged since ${current.since}`,
    });
    return;
  }

  // Inventory first, as startPacket does: a document that was read and never
  // inventoried has no stored claims, and would read MISSING here while the
  // archive in fact answers the assignment.
  const inventory = await inventoryProject(goal.project_id);
  const coverage = await coverBeforeWork({
    projectId: goal.project_id,
    layerId: goal.research_layer_id,
    claims: inventory.claims,
    requirements: [
      { key: 'goal-assignment', statement: goal.research_assignment, necessity: 'MANDATORY' },
    ],
  });
  if (coverage.fullyAnswered) {
    // Recorded against the marker taken before the read, so a change that lands
    // during it is seen again on the next pass rather than absorbed.
    await recordArchiveMarker(goal.id, current.marker);
    report.answeredByArchive.push(goal.id);
    return;
  }
  if (goal.research_archive_marker !== null) await recordArchiveMarker(goal.id, null);

  const packetKey = `round-${packets.length + 1}`;
  try {
    const started = await startPacket({
      projectId: goal.project_id,
      layerId: goal.research_layer_id,
      title: `${goal.name} — round ${packets.length + 1}`,
      assignment: goal.research_assignment,
      approval: {
        mode: 'GOAL_BUDGET',
        goalId: goal.id,
        packetKey,
        budget: {
          maxPackets: null,
          maxFragments: null,
          deadline: null,
          externalSpendCents: 0,
          paidOveragesEnabled: false,
        },
      },
      startedBy: { kind: 'BRAIN', id: goal.id },
    });
    report.started.push({ goalId: goal.id, packetKey, orchestrationId: started.orchestration.id });
  } catch (error) {
    if (error instanceof GoalBudgetExhausted) {
      const asked = await askAboutCeiling(goal, error.ceiling, error.message);
      report.stopped.push({ goalId: goal.id, ceiling: error.ceiling, asked });
      return;
    }
    throw error;
  }
}

/**
 * One pass over the active research goals that have an assignment.
 *
 * Bounded to `MAX_GOALS_PER_PASS`, least recently considered first (never
 * considered first), so a quiet goal never starves behind a busy one across ticks. A goal that throws is recorded and left as it
 * was; the rest are still considered.
 */
export async function advanceResearchGoals(): Promise<GoalContinuationReport> {
  const report: GoalContinuationReport = {
    considered: 0,
    started: [],
    answeredByArchive: [],
    stopped: [],
    skipped: [],
  };
  const goals = await getDb().all<GoalRow>(
    `SELECT id, project_id, name, research_assignment, research_layer_id,
            max_missions, max_fragments, expires_at, research_archive_marker
       FROM russell_goals
      WHERE purpose = 'RESEARCH_GOAL' AND state = 'ACTIVE' AND research_assignment IS NOT NULL
      ORDER BY COALESCE(research_considered_at, ''), created_at, id
      LIMIT ?`,
    [MAX_GOALS_PER_PASS],
  );
  for (const goal of goals) {
    report.considered += 1;
    // Stamped whatever the outcome, so the next pass takes the goals this one
    // did not reach, and a restart resumes the rotation from rows.
    await getDb().run('UPDATE russell_goals SET research_considered_at = ? WHERE id = ?', [nowIso(), goal.id]);
    try {
      await advanceOne(goal, report);
    } catch (error) {
      report.skipped.push({
        goalId: goal.id,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'unreadable',
      });
    }
  }
  return report;
}
