/**
 * Brain's own outages, written down so they are never charged to a worker.
 *
 * A fired session that could not authenticate because the database did not
 * answer, or that checked in and could not be served, or that arrived while the
 * machine was restarting, never claims its bin — and the no-show pass used to
 * read every one of those as a surface that did not answer. Three of them
 * quarantined a Routine whose connector was perfectly healthy, and the remedy a
 * person was then told about was a reconnect.
 *
 * This module is the record that separates the two. Every infrastructure
 * failure Brain felt (`server/db/infra.ts`) and every arrival it could not serve
 * becomes an `infra_incidents` row; a restart becomes one spanning the time the
 * last process was last alive to the time this one listened. The no-show pass
 * asks `arrivalIncidentDuring` before charging a surface.
 *
 * **Recording an outage during the outage.** The rows are held in memory and
 * written on the control plane with retries, coalesced per minute so a storm of
 * failures is one row with a count rather than ten thousand. A process that dies
 * holding unwritten rows loses them, and the restart row it is followed by covers
 * the same window — which is why that row is derived from the liveness table
 * rather than from anything the dying process had to say.
 *
 * **Only failures on the arrival path excuse a no-show.** A research statement
 * timing out on the workload pool does not stop anybody arriving — that is what
 * the control plane is for — so it is recorded and does not excuse a surface
 * that did not answer. Excusing on every incident would keep a dead surface in
 * routing for as long as the database had a bad afternoon.
 */
import crypto from 'node:crypto';
import { databasePoolReadings, getDb, outsideTransaction } from '../../db/database.ts';
import {
  asWorkload,
  databaseFailureCounts,
  infraFailureCounts,
  latencySummary,
  onInfraFailure,
  type InfraFailureObservation,
} from '../../db/infra.ts';
import { newId, nowIso } from '../../repos/util.ts';
import { sameProviderSession, sessionSpellings } from '../../domain/sessionRef.ts';

/** How long after a fire a session that will arrive normally has arrived. */
export const ARRIVAL_WINDOW_MS = 15 * 60_000;

/** Incidents of one kind on one surface inside one bucket are one row. */
const BUCKET_MS = 60_000;

/**
 * The surfaces whose failure stops *any* fired session from arriving.
 *
 * Deliberately narrow, because an incident here excuses no-shows fleet-wide:
 * authentication at the MCP door and the token endpoint — the only two doors a
 * fired session uses. The API guard (`http:auth`) is a browser's, and counting
 * it let one person's page load excuse every no-show in its window —
 * a session that cannot authenticate or refresh cannot arrive, and Brain cannot
 * tell whose credential it was. Not check-in's choosing half (that runs on the
 * workload pool, and a session that reached it *did* arrive — its own
 * UNSERVED_ARRIVAL row says so, scoped to it), and not background writes.
 */
const ARRIVAL_SURFACES = new Set(['mcp:authenticate', 'oauth:token', 'check_in:establish']);

function onArrivalPath(observation: InfraFailureObservation): boolean {
  return ARRIVAL_SURFACES.has(observation.surface);
}

interface PendingIncident {
  /** Deterministic for a coalesced key, so a later flush adds to the same row. */
  id: string;
  kind: string;
  surface: string;
  workerId: string | null;
  sessionRef: string | null;
  startedAt: string;
  endedAt: string;
  occurrences: number;
  affectsArrival: boolean;
  detail: string | null;
  attempts: number;
  heldAt: number;
}

const pending = new Map<string, PendingIncident>();
/**
 * Rows a flush has taken and not yet written. Kept visible to the lookups:
 * clearing them out of `pending` before the write landed would hide exactly the
 * evidence the no-show pass needs, at the moment the database comes back.
 */
const inflight = new Map<string, PendingIncident>();

function heldIncidents(): PendingIncident[] {
  return [...pending.values(), ...inflight.values()];
}
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;

/** How long a held row is retried before it is given up — longer than any outage this repository has recorded. */
const GIVE_UP_AFTER_MS = 60 * 60_000;
/** Bound on held rows, so a storm of distinct surfaces cannot grow memory without limit. */
const MAX_PENDING = 2_000;

/** A row the no-show pass reads: an arrival-path failure, or a session that arrived. */
function isEvidence(incident: { affectsArrival: boolean; kind: string }): boolean {
  return incident.affectsArrival || incident.kind === 'UNSERVED_ARRIVAL';
}

function idFor(key: string): string {
  return `inc_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function hold(key: string, incident: Omit<PendingIncident, 'attempts' | 'occurrences' | 'heldAt' | 'id'>): void {
  const held = pending.get(key);
  if (held) {
    held.occurrences += 1;
    if (incident.startedAt < held.startedAt) held.startedAt = incident.startedAt;
    if (incident.endedAt > held.endedAt) held.endedAt = incident.endedAt;
    held.affectsArrival = held.affectsArrival || incident.affectsArrival;
  } else {
    // The cap bounds noise, never evidence: a row a no-show could depend on is
    // always held, and is never given up below.
    if (pending.size >= MAX_PENDING && !isEvidence(incident)) return;
    pending.set(key, { ...incident, id: idFor(key), occurrences: 1, attempts: 0, heldAt: Date.now() });
  }
  schedule(250);
}

/** One flush at a time: a flush already running reschedules itself when it ends. */
function schedule(delayMs: number): void {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = null;
    flushing = flush().finally(() => {
      flushing = null;
      if (pending.size > 0) schedule(nextDelay);
    });
  }, delayMs);
  timer.unref?.();
}

let nextDelay = 250;

/**
 * Write what is held. Outside any transaction the scheduling context carried,
 * and on the workload pool: these writes are not latency-critical, and they
 * must never compete with authentication for the control plane's connections.
 * A failure here is never noted as an incident (the adapter only counts it),
 * so the recorder cannot feed itself.
 */
async function flush(): Promise<void> {
  const batch = [...pending.entries()];
  pending.clear();
  for (const [key, incident] of batch) inflight.set(key, incident);
  let worst = 0;
  let failed = false;
  for (const [key, incident] of batch) {
    try {
      // After one failure the rest wait for the next flush rather than each
      // spending a checkout timeout on a database that has just said no.
      if (failed) throw new Error('deferred');
      await outsideTransaction(() => asWorkload(() => writeIncident(incident)));
      inflight.delete(key);
    } catch {
      inflight.delete(key);
      failed = true;
      incident.attempts += 1;
      if (!isEvidence(incident) && Date.now() - incident.heldAt > GIVE_UP_AFTER_MS) continue;
      const again = pending.get(key);
      if (again) {
        again.occurrences += incident.occurrences;
        if (incident.startedAt < again.startedAt) again.startedAt = incident.startedAt;
        if (incident.endedAt > again.endedAt) again.endedAt = incident.endedAt;
        again.attempts = Math.max(again.attempts, incident.attempts);
        again.heldAt = Math.min(again.heldAt, incident.heldAt);
      } else {
        pending.set(key, incident);
      }
      worst = Math.max(worst, incident.attempts);
    }
  }
  nextDelay = worst === 0 ? 250 : Math.min(60_000, 1_000 * 2 ** Math.min(worst, 6));
}

/**
 * One row per coalesced key, however many flushes it takes: a later flush of
 * the same key widens the window and adds to the count instead of writing a
 * second row, which is what "one row per minute" has to mean when a flush runs
 * every 250ms.
 */
async function writeIncident(incident: PendingIncident): Promise<void> {
  await getDb().run(
    `INSERT INTO infra_incidents
       (id, kind, surface, worker_id, session_ref, started_at, ended_at, occurrences, affects_arrival, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       occurrences = infra_incidents.occurrences + excluded.occurrences,
       started_at = CASE WHEN excluded.started_at < infra_incidents.started_at THEN excluded.started_at ELSE infra_incidents.started_at END,
       ended_at = CASE WHEN excluded.ended_at > infra_incidents.ended_at THEN excluded.ended_at ELSE infra_incidents.ended_at END,
       affects_arrival = CASE WHEN excluded.affects_arrival > infra_incidents.affects_arrival THEN excluded.affects_arrival ELSE infra_incidents.affects_arrival END`,
    [
      incident.id,
      incident.kind,
      incident.surface.slice(0, 200),
      incident.workerId,
      incident.sessionRef,
      incident.startedAt,
      incident.endedAt,
      incident.occurrences,
      incident.affectsArrival ? 1 : 0,
      incident.detail,
      nowIso(),
    ],
  );
}

/** Begin turning felt infrastructure failures into rows. Idempotent. */
export function startInfraIncidentRecorder(): void {
  if (unsubscribe) return;
  unsubscribe = onInfraFailure((observation) => {
    const bucket = Math.floor(Date.parse(observation.at) / BUCKET_MS);
    hold(`${observation.kind}|${observation.surface}|${observation.workloadClass}|${bucket}`, {
      kind: observation.kind,
      surface: `${observation.surface}@${observation.workloadClass}`,
      workerId: null,
      sessionRef: null,
      startedAt: observation.at,
      endedAt: observation.at,
      affectsArrival: onArrivalPath(observation),
      detail: null,
    });
  });
}

export function stopInfraIncidentRecorder(): void {
  unsubscribe?.();
  unsubscribe = null;
}

/**
 * A session that authenticated, checked in, and could not be served — the
 * database did not answer while choosing its work, or choosing ran out of time.
 * Its own row, carrying the session, because it is the most direct evidence
 * there is that a fire *was* answered.
 */
export function recordUnservedArrival(input: { workerId: string; sessionRef: string | null; kind: string }): void {
  const at = new Date().toISOString();
  hold(`UNSERVED|${input.workerId}|${input.sessionRef ?? ''}|${Math.floor(Date.now() / BUCKET_MS)}`, {
    kind: 'UNSERVED_ARRIVAL',
    surface: 'check_in',
    workerId: input.workerId,
    sessionRef: input.sessionRef,
    startedAt: at,
    endedAt: at,
    // Scoped, not fleet-wide: this is evidence that *this* session arrived,
    // read by `unservedArrivalFor` against the fire that started it.
    affectsArrival: false,
    detail: input.kind,
  });
}

/* ------------------------------------------------------------------------- */
/* Restarts                                                                   */
/* ------------------------------------------------------------------------- */

const INSTANCE_ID = newId('proc');
const PROCESS_STARTED_AT = new Date().toISOString();
let lastLiveness = 0;
const LIVENESS_EVERY_MS = 30_000;

/**
 * Whether this process is still establishing the window its predecessor left
 * unserved. While it is, the no-show pass does not judge: a fire whose session
 * met the dead machine is exactly what that window excuses, and judging before
 * it is known charged those fires to the surfaces.
 */
let restartPending = false;
let restartRetry: NodeJS.Timeout | null = null;

export function restartWindowPending(): boolean {
  return restartPending;
}

/**
 * Record the window the previous process left unserved, and announce this one.
 *
 * The window runs from the newest liveness any *other* instance wrote to the
 * moment this one is about to listen. Written directly, and held in memory as
 * evidence if the write fails — a degraded database right after boot is the
 * ordinary case (deploys 337 and 342), and a restart row lost to it would charge
 * every fire whose session hit the dead machine. A read that fails is asked
 * again in the background with the same `listeningAt`, and until it succeeds
 * the no-show pass waits (`restartWindowPending`). The gap cannot be erased by
 * waiting: it is measured against *other* instances' liveness, which this
 * process never writes.
 */
export async function recordProcessStart(listeningAt = new Date()): Promise<{ gapMs: number | null }> {
  restartPending = true;
  if (restartRetry) {
    clearTimeout(restartRetry);
    restartRetry = null;
  }
  try {
    const result = await establishRestartWindow(listeningAt.toISOString());
    restartPending = false;
    return result;
  } catch (error) {
    scheduleRestartRetry(listeningAt.toISOString(), 1);
    throw error;
  }
}

function scheduleRestartRetry(now: string, attempt: number): void {
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  restartRetry = setTimeout(() => {
    restartRetry = null;
    void outsideTransaction(() => asWorkload(() => establishRestartWindow(now))).then(
      () => {
        restartPending = false;
      },
      () => {
        // Bounded: after an hour of failing the pass judges again rather than
        // waiting for ever, with the evidence it can read.
        if (Date.now() - Date.parse(now) > GIVE_UP_AFTER_MS) restartPending = false;
        else scheduleRestartRetry(now, attempt + 1);
      },
    );
  }, delay);
  restartRetry.unref?.();
}

async function establishRestartWindow(now: string): Promise<{ gapMs: number | null }> {
  const previous = await getDb().get<{ alive_at: string | null }>(
    'SELECT MAX(alive_at) AS alive_at FROM runtime_liveness WHERE instance_id <> ?',
    [INSTANCE_ID],
  );
  const lastAlive = previous?.alive_at ?? null;
  let gapMs: number | null = null;
  if (lastAlive && lastAlive < now) {
    gapMs = Date.parse(now) - Date.parse(lastAlive);
    /*
     * Anchored at the last instant the previous process was alive, because the
     * fires it excuses were sent *before* that instant — nothing fires while no
     * process is running. A Brain that was off for more than a day is bounded
     * at the end rather than the start: capping the start used to drop exactly
     * the fires sent just before it went down.
     */
    const endedAt = gapMs > 24 * 3_600_000 ? new Date(Date.parse(lastAlive) + 24 * 3_600_000).toISOString() : now;
    const incident: PendingIncident = {
      id: idFor(`RESTART|${INSTANCE_ID}`),
      kind: 'PROCESS_RESTART',
      surface: 'process',
      workerId: null,
      sessionRef: null,
      startedAt: lastAlive,
      endedAt,
      occurrences: 1,
      affectsArrival: true,
      detail: `previous process last alive ${lastAlive}; this one listening ${now}`,
      attempts: 0,
      heldAt: Date.now(),
    };
    try {
      await writeIncident(incident);
    } catch (error) {
      // Held as evidence, which the recorder never gives up; the pass reads it
      // from memory until it lands.
      const { attempts: _a, occurrences: _o, heldAt: _h, id: _i, ...rest } = incident;
      hold(`RESTART|${INSTANCE_ID}`, rest);
      throw error;
    }
  }
  await touchLiveness(true);
  // Retention: a month of incidents is what a no-show pass or a report reads.
  await getDb().run('DELETE FROM infra_incidents WHERE ended_at < ?', [
    new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
  ]);
  await getDb().run('DELETE FROM runtime_liveness WHERE alive_at < ?', [
    new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(),
  ]);
  return { gapMs };
}

/** Move this process's liveness forward, at most every thirty seconds. */
export async function touchLiveness(force = false): Promise<void> {
  const nowMs = Date.now();
  if (!force && nowMs - lastLiveness < LIVENESS_EVERY_MS) return;
  lastLiveness = nowMs;
  const now = new Date(nowMs).toISOString();
  const readings = JSON.stringify(processReadings());
  await outsideTransaction(async () => {
    const updated = await getDb().run(
      'UPDATE runtime_liveness SET alive_at = ?, readings = ? WHERE instance_id = ?',
      [now, readings, INSTANCE_ID],
    );
    if (updated.changes === 0) {
      await getDb().run(
        'INSERT INTO runtime_liveness (instance_id, started_at, alive_at, readings) VALUES (?, ?, ?, ?)',
        [INSTANCE_ID, PROCESS_STARTED_AT, now, readings],
      );
    }
  });
}

/** What this process can say about its own connection system, right now. */
export function processReadings(): Record<string, unknown> {
  return {
    revision: process.env['BRAIN_REVISION'] ?? null,
    pools: databasePoolReadings(),
    infraFailures: infraFailureCounts(),
    databaseFailures: databaseFailureCounts(),
    latency: latencySummary(),
    pendingIncidentWrites: pending.size,
  };
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

export interface InfraIncident {
  id: string;
  kind: string;
  surface: string;
  workerId: string | null;
  sessionRef: string | null;
  startedAt: string;
  endedAt: string;
  occurrences: number;
  affectsArrival: boolean;
  detail: string | null;
}

interface IncidentRow {
  id: string;
  kind: string;
  surface: string;
  worker_id: string | null;
  session_ref: string | null;
  started_at: string;
  ended_at: string;
  occurrences: number;
  affects_arrival: number;
  detail: string | null;
}

function mapIncident(row: IncidentRow): InfraIncident {
  return {
    id: row.id,
    kind: row.kind,
    surface: row.surface,
    workerId: row.worker_id,
    sessionRef: row.session_ref,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    occurrences: Number(row.occurrences),
    affectsArrival: Number(row.affects_arrival) === 1,
    detail: row.detail,
  };
}

/**
 * The first arrival-path incident inside the window a fired session had to
 * arrive in, or null. Only an arrival-path incident counts — see the header.
 */
export async function arrivalIncidentDuring(sentAt: string, untilIso?: string): Promise<InfraIncident | null> {
  const until = untilIso ?? new Date(Date.parse(sentAt) + ARRIVAL_WINDOW_MS).toISOString();
  /*
   * The rows this process has not managed to write yet count too. During an
   * outage they wait in memory, and the no-show pass runs the moment the
   * database answers again — so reading only the table would charge exactly
   * the fires whose evidence is still on its way.
   */
  for (const held of heldIncidents()) {
    if (held.affectsArrival && held.startedAt <= until && held.endedAt >= sentAt) return heldAsIncident(held);
  }
  const row = await getDb().get<IncidentRow>(
    `SELECT * FROM infra_incidents
      WHERE affects_arrival = 1 AND started_at <= ? AND ended_at >= ?
      ORDER BY started_at, id LIMIT 1`,
    [until, sentAt],
  );
  return row ? mapIncident(row) : null;
}

/**
 * Whether a held or written unserved arrival names this fire's session.
 *
 * By the session, in any of its spellings (`domain/sessionRef.ts`), and then
 * with **no upper bound**: a session id is unique to the fire that produced it,
 * so its arrival after the fire is the answer however late it came — exactly as
 * `refusedOnArrival` reads an assignment. A fifteen-minute bound here used to
 * drop the direct evidence of a session that arrived at minute sixteen, and the
 * no-show pass, which judges at thirty, then charged the surface for it.
 *
 * A session that reported no id is matched by the worker it authenticated as —
 * imprecise where one worker serves several Routines, and stated so: it can
 * only excuse a miss inside its own arrival window.
 */
function unservedMatches(
  held: { sessionRef: string | null; workerId: string | null; startedAt: string },
  sessionRef: string | null,
  workerId: string | null,
  until: string,
): boolean {
  if (sessionRef !== null && sameProviderSession(held.sessionRef, sessionRef)) return true;
  return held.sessionRef === null && workerId !== null && held.workerId === workerId && held.startedAt <= until;
}

/**
 * The evidence this process holds in memory, with no database read at all —
 * asked first by the no-show pass, so a pass whose own reads fail under the
 * very pressure it is judging still sees what Brain already knows.
 */
export function heldArrivalEvidence(
  sessionRef: string | null,
  sentAt: string,
  workerId: string | null = null,
): InfraIncident | null {
  const until = new Date(Date.parse(sentAt) + ARRIVAL_WINDOW_MS).toISOString();
  for (const held of heldIncidents()) {
    if (held.endedAt < sentAt) continue;
    if (held.affectsArrival && held.startedAt <= until) return heldAsIncident(held);
    if (held.kind === 'UNSERVED_ARRIVAL' && unservedMatches(held, sessionRef, workerId, until)) {
      return heldAsIncident(held);
    }
  }
  return null;
}

/**
 * Did the session this fire started arrive and go unserved? Scoped to the one
 * session — the most direct evidence there is that the fire was answered.
 */
export async function unservedArrivalFor(
  sessionRef: string | null,
  sentAt: string,
  workerId: string | null = null,
): Promise<InfraIncident | null> {
  const until = new Date(Date.parse(sentAt) + ARRIVAL_WINDOW_MS).toISOString();
  for (const held of heldIncidents()) {
    if (held.kind === 'UNSERVED_ARRIVAL' && held.endedAt >= sentAt && unservedMatches(held, sessionRef, workerId, until)) {
      return heldAsIncident(held);
    }
  }
  const spellings = sessionSpellings(sessionRef);
  if (spellings.length === 0 && !workerId) return null;
  const bySession = spellings.length > 0 ? `session_ref IN (${spellings.map(() => '?').join(', ')})` : '1 = 0';
  const row = await getDb().get<IncidentRow>(
    `SELECT * FROM infra_incidents
      WHERE kind = 'UNSERVED_ARRIVAL' AND ended_at >= ?
        AND (${bySession} OR (session_ref IS NULL AND worker_id = ? AND started_at <= ?))
      ORDER BY started_at, id LIMIT 1`,
    [sentAt, ...spellings, workerId ?? '', until],
  );
  return row ? mapIncident(row) : null;
}

function heldAsIncident(held: PendingIncident): InfraIncident {
  return {
    id: held.id,
    kind: held.kind,
    surface: held.surface,
    workerId: held.workerId,
    sessionRef: held.sessionRef,
    startedAt: held.startedAt,
    endedAt: held.endedAt,
    occurrences: held.occurrences,
    affectsArrival: held.affectsArrival,
    detail: held.detail,
  };
}

export async function listIncidentsSince(sinceIso: string, limit = 200): Promise<InfraIncident[]> {
  const rows = await getDb().all<IncidentRow>(
    'SELECT * FROM infra_incidents WHERE ended_at >= ? ORDER BY started_at DESC, id DESC LIMIT ?',
    [sinceIso, limit],
  );
  return rows.map(mapIncident);
}

/** Tests: write everything held now. */
export async function settleInfraIncidents(): Promise<void> {
  for (let i = 0; i < 50 && (pending.size > 0 || flushing || timer); i += 1) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!flushing && pending.size > 0) {
      flushing = flush().finally(() => {
        flushing = null;
      });
    }
    if (flushing) await flushing;
  }
}

export function pendingInfraIncidents(): number {
  return pending.size;
}

export function processInstanceId(): string {
  return INSTANCE_ID;
}
