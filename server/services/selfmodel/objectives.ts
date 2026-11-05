/**
 * A substantial objective is checked against Brain's capability maps once (§88).
 *
 * When a goal arrives that commits real scope — money, a horizon of weeks, or
 * several stated outcomes — Brain reads which maps it depends on
 * (`mapsFor`), what in those maps production reads BROKEN or MISSING, and
 * records that as a `CAPABILITY_ASSESSED` event on the goal. A small goal is
 * never assessed (`isSubstantial`). It is recorded again only when the set of
 * blocking gaps changes, so the record is a history of what stood in the way,
 * not a heartbeat.
 *
 * The gaps themselves reach Factory through the improvement loop
 * (`capabilityWeaknesses` in `detectWeaknesses`), exactly as a detected
 * failure class does; this names, on the objective, which of them it is
 * waiting on. Nothing here engineers, approves or notifies.
 */
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { assessObjective, type ObjectiveAssessment } from '../../domain/capabilityMap.ts';
import { assessAll, type MapAssessment } from './capabilities.ts';

const DAY = 86_400_000;

export interface ObjectiveCheck {
  goalId: string;
  recorded: boolean;
  assessment: ObjectiveAssessment;
}

/** Assess every live goal whose blocking set is new. At most `limit` goals a pass. */
export async function assessLiveObjectives(input: { now?: Date; limit?: number; assessments?: MapAssessment[] } = {}): Promise<ObjectiveCheck[]> {
  const now = input.now ?? new Date();
  const goals = await getDb().all<{
    id: string;
    project_id: string | null;
    intent: string;
    outcome: string | null;
    due_at: string | null;
    capital_ceiling_cents: number | string | null;
  }>(
    `SELECT id, project_id, intent, outcome, due_at, capital_ceiling_cents FROM workstreams
      WHERE archived_at IS NULL AND cancelled_at IS NULL AND project_id IS NOT NULL
      ORDER BY created_at DESC LIMIT ?`,
    [Math.max(1, input.limit ?? 20)],
  );
  if (goals.length === 0) return [];
  let assessments: MapAssessment[] | null = input.assessments ?? null;
  const out: ObjectiveCheck[] = [];
  for (const goal of goals) {
    const text = [goal.intent, goal.outcome].filter(Boolean).join('\n');
    const due = goal.due_at ? Date.parse(goal.due_at) : NaN;
    const shape = {
      text,
      budget: goal.capital_ceiling_cents == null ? null : Number(goal.capital_ceiling_cents) / 100,
      horizonDays: Number.isFinite(due) ? (due - now.getTime()) / DAY : null,
    };
    // Cheap gate first: a small objective never costs an assessment.
    const small = assessObjective(shape, {});
    if (!small.substantial) continue;
    assessments ??= await assessAll({ now, hours: 24 });
    const assessment = assessObjective(shape, Object.fromEntries(assessments.map((a) => [a.map, a.assessed])));
    const blocking = assessment.blocking.map((g) => `${g.status}:${g.id}`).sort();
    const last = await getDb().get<{ payload: string }>(
      `SELECT payload FROM project_events WHERE entity_type = 'WORKSTREAM' AND entity_id = ? AND event_type = 'CAPABILITY_ASSESSED'
        ORDER BY created_at DESC LIMIT 1`,
      [goal.id],
    );
    let previous: string[] | null = null;
    try {
      previous = last ? ((JSON.parse(last.payload) as { blocking?: string[] }).blocking ?? []) : null;
    } catch {
      previous = null;
    }
    const changed = previous === null || previous.join('|') !== blocking.join('|');
    if (changed) {
      await recordEvent({
        projectId: goal.project_id!,
        entityType: 'WORKSTREAM',
        entityId: goal.id,
        eventType: 'CAPABILITY_ASSESSED',
        payload: {
          maps: assessment.maps,
          ready: assessment.ready,
          blocking,
          gaps: assessment.blocking.slice(0, 10).map((g) => ({ id: g.id, status: g.status, why: g.why, external: g.externalLimit })),
        },
      });
    }
    out.push({ goalId: goal.id, recorded: changed, assessment });
  }
  return out;
}
