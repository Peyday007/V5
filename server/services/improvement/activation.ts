/**
 * Free-lane improvement research activates itself when it is safe (§87).
 *
 * Owner's order, 2026-11-04: the self-improvement system must start when its
 * required components are ready, without anyone remembering to turn it on,
 * stay safely inactive while one is not, and come back by itself after a
 * failure. What it activates is one thing: the free lane (§85) may claim the
 * work items of the improvement loop's own method research goals, beside the
 * Claude routines that already take them (§84), so free AI does
 * Brain-improvement research and its settled packet moves the candidate to
 * engineering (`loop.ts`, `deriveStage`).
 *
 * Nothing here is a second scheduler, queue or monitor:
 *
 *   - **Evaluated by the existing ticks.** Every improvement pass of the
 *     durable Russell tick evaluates it first; the dispatch tick beside it is
 *     the fallback, evaluating (and running the improvement pass) whenever the
 *     last evaluation is older than `ACTIVATION_FALLBACK_MINUTES`, so a missed
 *     or dead Russell tick cannot leave it idle.
 *   - **State is a row.** `brain_switches.improvement_free_research`, beside
 *     `improvement_loop`: enabled, when it was last evaluated and every check's
 *     reading. It survives deploys, restarts and sessions because it is in the
 *     database; a restart re-reads it and re-evaluates within one tick.
 *   - **One activation.** A transition is a compare-and-set on the previous
 *     value, and only the instance whose statement changed the row records
 *     ACTIVATED or DEACTIVATED, so two instances or two passes cannot activate
 *     twice. Work items are claimed by the queue's own compare-and-swap.
 *   - **Only genuine dependencies.** The five checks are what the research
 *     needs to run and reach engineering. Unrelated development, open PRs and
 *     other candidates' Factory work are not among them.
 *   - **Bounded.** While active, the free lane holds at most
 *     `IMPROVEMENT_RESEARCH_SLOT_CAP` improvement leases at once and none under
 *     database pressure, so commercial research keeps the rest of the lane.
 *   - **Recovers.** It deactivates when a dependency is lost (the free lane
 *     stops getting answers accepted, the owner's loop switch is turned off,
 *     the Factory grant disappears) and reactivates when it returns. While
 *     active, research that sits claimable for an hour while the lane works
 *     elsewhere is recorded as rule 9's defect and the lane's memberships and
 *     pool are re-established.
 *
 * The owner's off switch is `improvement_loop`: with it off, results cannot
 * reach engineering, so this stays inactive.
 */
import { getDb } from '../../db/database.ts';
import {
  ACTIVATION_FALLBACK_MINUTES,
  decideActivation,
  FREE_LANE_OPERATING_HOURS,
  IMPROVEMENT_RESEARCH_SLOT_CAP,
  IMPROVEMENT_RESEARCH_STUCK_MINUTES,
  type ActivationCheck,
  type ActivationCheckKey,
} from '../../domain/improvement.ts';
import { BRAIN_PROJECT_SLUG } from '../../domain/binPurpose.ts';
import { BRAIN_REVISION } from '../../env.ts';
import { listImprovementEvents, recordImprovementEvent } from '../../repos/improvement.ts';
import { improvementPerson, improvementSwitch } from './authority.ts';

export const ACTIVATION_SWITCH = 'improvement_free_research';
const GATE = 'readiness-gate';
const HOUR = 3_600_000;
const FREE_WORKERS = "(SELECT k.id FROM workers k WHERE k.name IN ('free-lane-a', 'free-lane-b'))";

/** Work items of the loop's own open research goals. `w` is the work item. */
export const IMPROVEMENT_RESEARCH_ITEM = `w.orchestration_id IN (
  SELECT o.id FROM research_orchestrations o
    JOIN improvement_candidates c ON c.research_goal_id = o.goal_id
   WHERE c.decision IS NULL)`;

/**
 * Brain-architecture research packets Claude routines have left unclaimed this long are the free
 * lane's too while active: executable Brain-improvement work beside idle capacity is rule 9's defect.
 */
export const IDLE_BRAIN_RESEARCH_HOURS = 6;

/** Work items of Brain research packets no routine has taken for `IDLE_BRAIN_RESEARCH_HOURS`. Two params. */
const IDLE_BRAIN_RESEARCH_ITEM = `w.orchestration_id IN (
  SELECT b.orchestration_id FROM bins b JOIN projects p ON p.id = b.project_id
   WHERE b.purpose = 'BRAIN_IMPROVEMENT' AND b.kind = 'RESEARCH_PACKET' AND b.state = 'READY'
     AND b.orchestration_id IS NOT NULL AND p.slug = ? AND b.ready_at <= ?)`;

function idleParams(now = new Date()): string[] {
  return [BRAIN_PROJECT_SLUG, new Date(now.getTime() - IDLE_BRAIN_RESEARCH_HOURS * HOUR).toISOString()];
}

/** Free-lane-takeable Brain research queued now: the loop's own plus idle packets. */
export async function improvementResearchWaiting(now = new Date()): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w
      WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.attempt_count < w.max_attempts
        AND w.work_type IN ('RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT')
        AND (${IMPROVEMENT_RESEARCH_ITEM} OR ${IDLE_BRAIN_RESEARCH_ITEM})`,
    [now.toISOString(), ...idleParams(now)],
  );
  return Number(row?.n ?? 0);
}

export interface ActivationReading {
  state: 'ACTIVE' | 'INACTIVE';
  waitingOn: ActivationCheckKey[];
  checks: ActivationCheck[];
  checkedAt: string | null;
  via: string | null;
  transition: 'ACTIVATE' | 'DEACTIVATE' | null;
  recovered: string | null;
}

interface Row {
  enabled: boolean;
  updatedAt: string | null;
  reason: Record<string, unknown> | null;
}

async function readRow(): Promise<Row | null> {
  const row = await getDb().get<{ enabled: number | string; updated_at: string; reason: string | null }>(
    'SELECT enabled, updated_at, reason FROM brain_switches WHERE name = ?',
    [ACTIVATION_SWITCH],
  );
  if (!row) return null;
  let reason: Record<string, unknown> | null = null;
  try {
    reason = row.reason ? (JSON.parse(row.reason) as Record<string, unknown>) : null;
  } catch {
    reason = null;
  }
  return { enabled: Number(row.enabled) === 1, updatedAt: row.updated_at, reason };
}

/** Inactive until the gate says otherwise; a second instance inserting at once inserts nothing. */
async function ensureRow(now: string): Promise<void> {
  await getDb().run(
    `INSERT INTO brain_switches (name, enabled, updated_at, updated_by, reason)
     VALUES (?, 0, ?, ?, ?) ON CONFLICT (name) DO NOTHING`,
    [ACTIVATION_SWITCH, now, GATE, JSON.stringify({ waitingOn: ['NOT_YET_EVALUATED'] })],
  );
}

/* ------------------------------------------------------------------------- */
/* The checks                                                                 */
/* ------------------------------------------------------------------------- */

async function check(key: ActivationCheckKey, read: () => Promise<{ ok: boolean; detail: string }>): Promise<ActivationCheck> {
  try {
    return { key, ...(await read()) };
  } catch (error) {
    // A check that could not be read is not ready (invariant 39).
    return { key, ok: false, detail: `could not be read: ${String((error as Error).message ?? error).slice(0, 160)}` };
  }
}

/** Every dependency, read from rows and from this process. Read-only. */
export async function readiness(now: Date, currentlyEnabled: boolean): Promise<ActivationCheck[]> {
  const db = getDb();
  const since = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString();
  return Promise.all([
    check('DEPLOYED', async () => {
      // The loop's register and the free lane's capacity rows answer: the migrations this needs are applied
      // and the code reading them is the code running.
      await db.get('SELECT COUNT(*) AS n FROM improvement_candidates', []);
      await db.get('SELECT COUNT(*) AS n FROM free_lane_capacity', []);
      return { ok: true, detail: `running ${BRAIN_REVISION ?? 'an unrecorded revision'}; the improvement and free-lane schema answer` };
    }),
    check('FREE_LANE_OPERATING', async () => {
      const { laneConfig } = await import('../cheap/lane.ts');
      const config = laneConfig();
      if (!config) return { ok: false, detail: 'no free model is configured (BRAIN_CHEAP_LLM_URL)' };
      const last = await db.get<{ last: string | null }>(
        "SELECT MAX(at) AS last FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'SUBMITTED'",
        [],
      );
      const errors = await db.get<{ n: number | string }>(
        "SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND outcome = 'RELEASED_TRANSIENT' AND at >= ?",
        [since(1)],
      );
      const lastAt = last?.last ?? null;
      const ok = lastAt !== null && lastAt >= since(FREE_LANE_OPERATING_HOURS);
      return {
        ok,
        detail: `${config.models.length} model(s); last accepted answer ${lastAt ?? 'never'}; ${Number(errors?.n ?? 0)} provider failure(s) in the last hour` +
          (ok ? '' : ` — needs an accepted answer in the last ${FREE_LANE_OPERATING_HOURS} h`),
      };
    }),
    check('RESEARCH_ASSIGNABLE', async () => {
      const project = await db.get<{ id: string }>('SELECT id FROM projects WHERE slug = ?', [BRAIN_PROJECT_SLUG]);
      if (!project) return { ok: false, detail: `the ${BRAIN_PROJECT_SLUG} project is missing` };
      const layer = await db.get<{ id: string }>('SELECT id FROM layers WHERE project_id = ? LIMIT 1', [project.id]);
      if (!layer) return { ok: false, detail: `the ${BRAIN_PROJECT_SLUG} project has no layer to file research under` };
      const person = await improvementPerson();
      if (!person) return { ok: false, detail: 'no active Brain administrator owns improvement research goals' };
      return { ok: true, detail: `research goals open in ${BRAIN_PROJECT_SLUG}, owned by ${person.email}; the free lane is granted it when work exists` };
    }),
    check('RESULTS_REACH_ENGINEERING', async () => {
      const loop = await improvementSwitch();
      if (!loop.enabled) return { ok: false, detail: 'the owner\'s improvement_loop switch is off' };
      const factory = await db.get<{ project_id: string }>(
        "SELECT project_id FROM factory_project_repositories WHERE grant_id = 'brain' LIMIT 1",
        [],
      );
      if (!factory) return { ok: false, detail: 'no project holds the Brain repository grant for Factory' };
      return { ok: true, detail: 'the loop is on; a settled research packet moves its candidate to ENGINEER and a Factory objective' };
    }),
    check('NO_DISRUPTION', async () => {
      // Commercial research keeps the lane: improvement research starts only when the lane has room
      // beyond the commercial work already waiting. Once active it is never stopped for this (each claim
      // is capped and refused under database pressure instead), so a busy hour cannot make it flap.
      const { waitingNow, readCapacity } = await import('../freeLane/capacity.ts');
      const commercial = await waitingNow({ includeImprovement: false });
      const slots = (await readCapacity()).reduce((sum, row) => sum + row.target, 0);
      const room = slots - commercial;
      const ok = currentlyEnabled || room > 0;
      return {
        ok,
        detail: `${commercial} commercial item(s) waiting for ${slots} free-lane slot(s); improvement research holds at most ` +
          `${IMPROVEMENT_RESEARCH_SLOT_CAP} lease(s) and none while the database is saturated` +
          (ok ? '' : ' — the lane has no room beyond its commercial backlog'),
      };
    }),
  ]);
}

/* ------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* ------------------------------------------------------------------------- */

let cached: { at: number; active: boolean } | null = null;

export function resetActivationCache(): void {
  cached = null;
}

/** Whether the free lane may take improvement research now. Read at most once a minute per process. */
export async function improvementResearchActive(nowMs = Date.now()): Promise<boolean> {
  if (cached && nowMs - cached.at >= 0 && nowMs - cached.at < 60_000) return cached.active;
  const row = await readRow();
  cached = { at: nowMs, active: row?.enabled ?? false };
  return cached.active;
}

/**
 * Evaluate the gate, write the state, and record a transition once. `via` says
 * which tick asked: TICK (the improvement pass), FALLBACK (the dispatch tick,
 * because the improvement pass had not evaluated in time) or ADMIN.
 */
export async function evaluateActivation(now = new Date(), via: 'TICK' | 'FALLBACK' | 'ADMIN' = 'TICK'): Promise<ActivationReading> {
  const at = now.toISOString();
  await ensureRow(at);
  const before = await readRow();
  const wasEnabled = before?.enabled ?? false;
  const checks = await readiness(now, wasEnabled);
  const decision = decideActivation(checks, wasEnabled);
  const body = JSON.stringify({ waitingOn: decision.waitingOn, checks, checkedAt: at, via });
  let transition: ActivationReading['transition'] = null;
  if (decision.transition) {
    const changed = await getDb().run(
      'UPDATE brain_switches SET enabled = ?, updated_at = ?, updated_by = ?, reason = ? WHERE name = ? AND enabled = ?',
      [decision.enabled ? 1 : 0, at, GATE, body, ACTIVATION_SWITCH, wasEnabled ? 1 : 0],
    );
    if (changed.changes === 1) {
      transition = decision.transition;
      await recordImprovementEvent({
        candidateId: null,
        kind: decision.transition === 'ACTIVATE' ? 'ACTIVATED' : 'DEACTIVATED',
        detail: { via, waitingOn: decision.waitingOn, checks },
        at,
      });
    }
  } else {
    await getDb().run('UPDATE brain_switches SET updated_at = ?, reason = ? WHERE name = ?', [at, body, ACTIVATION_SWITCH]);
    if (!decision.enabled) {
      // Inactive: say what it waits on, once per change of what it waits on.
      const last = (await listImprovementEvents({ kinds: ['ACTIVATION_WAITING', 'DEACTIVATED'], limit: 1 }))[0];
      const prior = JSON.stringify((last?.detail['waitingOn'] as string[] | undefined) ?? null);
      if (prior !== JSON.stringify(decision.waitingOn)) {
        await recordImprovementEvent({ candidateId: null, kind: 'ACTIVATION_WAITING', detail: { via, waitingOn: decision.waitingOn, checks }, at });
      }
    }
  }
  cached = { at: now.getTime(), active: decision.enabled };
  const recovered = decision.enabled ? await recoverIfStuck(now).catch(() => null) : null;
  return { state: decision.enabled ? 'ACTIVE' : 'INACTIVE', waitingOn: decision.waitingOn, checks, checkedAt: at, via, transition, recovered };
}

/**
 * Active, yet the loop's research sits claimable for an hour while the free
 * lane answers other work: re-establish what the lane needs (its memberships,
 * its pool) and record rule 9's defect, at most once an hour.
 */
async function recoverIfStuck(now: Date): Promise<string | null> {
  const db = getDb();
  const stuckSince = new Date(now.getTime() - IMPROVEMENT_RESEARCH_STUCK_MINUTES * 60_000).toISOString();
  const waiting = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w
      WHERE w.state = 'QUEUED' AND w.available_at <= ? AND w.attempt_count < w.max_attempts AND ${IMPROVEMENT_RESEARCH_ITEM}`,
    [stuckSince],
  );
  if (Number(waiting?.n ?? 0) === 0) return null;
  const touched = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? AND ${IMPROVEMENT_RESEARCH_ITEM}`,
    [stuckSince],
  );
  if (Number(touched?.n ?? 0) > 0) return null;
  const leased = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w WHERE w.state = 'LEASED' AND w.worker_id IN ${FREE_WORKERS} AND ${IMPROVEMENT_RESEARCH_ITEM}`,
    [],
  );
  if (Number(leased?.n ?? 0) > 0) return null;
  const lastRecovery = (await listImprovementEvents({ kinds: ['ACTIVATION_RECOVERY'], limit: 1 }))[0];
  if (lastRecovery && now.getTime() - Date.parse(lastRecovery.at) < HOUR) return null;
  const { resetFreeLaneMemberships } = await import('../freeLane/worker.ts');
  resetFreeLaneMemberships();
  const { adaptivePoolRunning, startAdaptivePool } = await import('../freeLane/capacity.ts');
  const restarted = !adaptivePoolRunning();
  if (restarted) startAdaptivePool();
  const what = `${Number(waiting?.n)} improvement research item(s) claimable for ${IMPROVEMENT_RESEARCH_STUCK_MINUTES} min with no free-lane claim`;
  const action = `memberships re-read${restarted ? ', the free-lane pool restarted' : ''}`;
  const { recordIntervention } = await import('../../repos/engineering.ts');
  await recordIntervention({
    kind: 'IDLE_WITH_EXECUTABLE_WORK',
    rule: 'RULE_9_KEEP_CAPACITY_FED',
    attemptedAction: what,
    replacementAction: action,
    actorType: 'BRAIN',
    actorId: 'improvement:activation',
  });
  await recordImprovementEvent({ candidateId: null, kind: 'ACTIVATION_RECOVERY', detail: { what, action }, at: now.toISOString() });
  return `${what}; ${action}`;
}

/**
 * The fallback the dispatch tick runs: when the improvement pass has not
 * evaluated the gate for `ACTIVATION_FALLBACK_MINUTES`, evaluate it here and
 * run the improvement pass itself, so a missed trigger cannot leave the
 * process idle. Returns null when the regular pass is keeping up.
 */
export async function activationFallback(now = new Date()): Promise<ActivationReading | null> {
  const row = await readRow();
  const last = row?.updatedAt ? Date.parse(row.updatedAt) : 0;
  if (row && now.getTime() - last < ACTIVATION_FALLBACK_MINUTES * 60_000) return null;
  await recordImprovementEvent({
    candidateId: null,
    kind: 'ACTIVATION_FALLBACK',
    detail: { lastEvaluatedAt: row?.updatedAt ?? null, reason: `no evaluation for ${ACTIVATION_FALLBACK_MINUTES} min; the dispatch tick evaluated` },
    at: now.toISOString(),
  });
  const reading = await evaluateActivation(now, 'FALLBACK');
  const { improvementTickIfDue } = await import('./loop.ts');
  await improvementTickIfDue(now.getTime());
  return reading;
}

/** What `admin improvement show` prints about activation. */
export async function activationReading(): Promise<ActivationReading> {
  const row = await readRow();
  const reason = row?.reason ?? {};
  return {
    state: row?.enabled ? 'ACTIVE' : 'INACTIVE',
    waitingOn: (reason['waitingOn'] as ActivationCheckKey[] | undefined) ?? [],
    checks: (reason['checks'] as ActivationCheck[] | undefined) ?? [],
    checkedAt: (reason['checkedAt'] as string | undefined) ?? row?.updatedAt ?? null,
    via: (reason['via'] as string | undefined) ?? null,
    transition: null,
    recovered: null,
  };
}

/** The free lane's admission for an item whose owning bin is Brain's own (`worker.ts`). */
export async function freeLaneMayTakeImprovement(item: { id: string; orchestration_id: string | null }): Promise<boolean> {
  if (!item.orchestration_id) return false;
  if (!(await improvementResearchActive())) return false;
  // The lane controller's own graded reading (§86): saturation, not one momentary waiter.
  const { lastControlReading } = await import('../freeLane/capacity.ts');
  if (lastControlReading()?.pressure.db) return false;
  const db = getDb();
  const ours = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w WHERE w.id = ? AND (${IMPROVEMENT_RESEARCH_ITEM} OR ${IDLE_BRAIN_RESEARCH_ITEM})`,
    [item.id, ...idleParams()],
  );
  if (Number(ours?.n ?? 0) === 0) return false;
  // Every Brain-owned lease the free workers hold counts against the cap.
  const held = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM work_items w
      WHERE w.state = 'LEASED' AND w.lease_expires_at > ? AND w.worker_id IN ${FREE_WORKERS}
        AND EXISTS (SELECT 1 FROM bins b
                     WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
                       AND b.purpose = 'BRAIN_IMPROVEMENT')`,
    [new Date().toISOString()],
  );
  return Number(held?.n ?? 0) < IMPROVEMENT_RESEARCH_SLOT_CAP;
}

/** Projects holding research the free lane may take while active, for the free workers' memberships. */
export async function improvementResearchProjects(): Promise<string[]> {
  if (!(await improvementResearchActive())) return [];
  const rows = await getDb().all<{ project_id: string }>(
    `SELECT DISTINCT w.project_id FROM work_items w
      WHERE w.state IN ('QUEUED', 'LEASED') AND (${IMPROVEMENT_RESEARCH_ITEM} OR ${IDLE_BRAIN_RESEARCH_ITEM})`,
    idleParams(),
  );
  return rows.map((row) => row.project_id);
}

/** The loop's research and who is doing it, for the reading: proof the free lane took it and it moved on. */
export async function improvementResearchWork(sinceHours = 24): Promise<{
  goals: number;
  items: Record<string, number>;
  freeLane: Record<string, number>;
  /** Every free-lane outcome on Brain-owned research (the loop's and idle packets'). */
  freeLaneBrain: Record<string, number>;
  waitingNow: number;
  settledPackets: number;
}> {
  const db = getDb();
  const goals = await db.get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM improvement_candidates WHERE research_goal_id IS NOT NULL',
    [],
  );
  const items = await db.all<{ state: string; n: number | string }>(
    `SELECT w.state, COUNT(*) AS n FROM work_items w
      WHERE w.orchestration_id IN (SELECT o.id FROM research_orchestrations o
                                     JOIN improvement_candidates c ON c.research_goal_id = o.goal_id)
      GROUP BY w.state`,
    [],
  );
  const lane = await db.all<{ outcome: string; n: number | string }>(
    `SELECT e.outcome, COUNT(*) AS n FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ?
        AND w.orchestration_id IN (SELECT o.id FROM research_orchestrations o
                                     JOIN improvement_candidates c ON c.research_goal_id = o.goal_id)
      GROUP BY e.outcome`,
    [new Date(Date.now() - sinceHours * HOUR).toISOString()],
  );
  const idle = await db.all<{ outcome: string; n: number | string }>(
    `SELECT e.outcome, COUNT(*) AS n FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ?
        AND EXISTS (SELECT 1 FROM bins b
                     WHERE (b.id = w.bin_id OR (b.orchestration_id IS NOT NULL AND b.orchestration_id = w.orchestration_id))
                       AND b.purpose = 'BRAIN_IMPROVEMENT')
      GROUP BY e.outcome`,
    [new Date(Date.now() - sinceHours * HOUR).toISOString()],
  );
  const settled = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM research_orchestrations o JOIN improvement_candidates c ON c.research_goal_id = o.goal_id
      WHERE o.status IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED')`,
    [],
  );
  return {
    goals: Number(goals?.n ?? 0),
    items: Object.fromEntries(items.map((r) => [r.state, Number(r.n)])),
    freeLane: Object.fromEntries(lane.map((r) => [r.outcome, Number(r.n)])),
    freeLaneBrain: Object.fromEntries(idle.map((r) => [r.outcome, Number(r.n)])),
    waitingNow: await improvementResearchWaiting(),
    settledPackets: Number(settled?.n ?? 0),
  };
}
