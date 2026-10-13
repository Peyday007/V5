/**
 * Who actually arrived when Brain fired a Routine.
 *
 * Production, 2026-10-11: Airyn's four Research Routines were registered for
 * worker-05, and the Claude Routines behind them selected his other Brain
 * connector — the one at `/mcp/factory`, which authorizes as worker-12. Every
 * fire started a session, the session authenticated (worker-12's token was used
 * seven seconds after each recovery probe's fire), checked in, was offered
 * nothing a worker-12 session may take, and ended. Brain recorded none of it:
 * an arrival was credited only when the session took a bin, so each fire read
 * as a session that "never checked in", three of them quarantined the surface,
 * a person re-enabled it, and it went round again — 115 fires per Routine,
 * four Routines. The recovery probe then reported the same silence as NO_MCP
 * and told the operator to have Airyn reconnect Brain in Claude, which was
 * never the problem.
 *
 * The fact was on the table the whole time: the session reported the provider
 * session Brain's fire returned, so it provably *was* that fire, and the token
 * it presented names the worker it authenticated as. This module writes that
 * down at check-in and acts on it:
 *
 *   - `observeFiredSessionArrival` (check-in): a fired session that arrived is
 *     recorded once — `DISPATCH_SESSION_ARRIVED` when it is the registered
 *     worker, `DISPATCH_WRONG_WORKER` when it is another. Either is an answer
 *     to the fire, so the no-show pass stops charging it.
 *   - `quarantineWrongWorkerSurfaces` (tick): the *first* wrong-worker arrival
 *     takes the Routine out of routing, with the exact cause and the two
 *     remedies, instead of three no-shows and a reason about authorization.
 *   - `recoverRebindedSurfaces` (tick): once the Routine is registered for the
 *     worker its sessions were proven to authenticate as — an operator's
 *     `repoint-worker` — it comes back by itself, bound to that connector.
 *
 * Nothing here changes a Routine's registered worker, a membership, a scope, a
 * routing row or a consent. A wrong worker is never adopted: the Routine is
 * stopped and a person says which identity is intended (in Claude, by choosing
 * the connector; or in Brain, by repointing). Brain only notices, stops
 * spending, and restores what a person already corrected.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { getRoutine, setRoutineState } from '../../repos/fleet.ts';
import { getWorker, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { getToken } from '../../repos/oauth.ts';
import { connectorClient, endpointOf, getConnector, listConnectors, type Connector } from '../../repos/connectors.ts';
import { normalizeSessionRef, sessionSpellings } from '../../domain/sessionRef.ts';
import type { FleetRoutine } from '../../domain/types.ts';
import { parseJson } from '../../repos/util.ts';

/** The phrase every wrong-worker quarantine reason carries, so a reader can find it. */
export const WRONG_WORKER_MARK = 'its sessions authenticate as a different worker than it is registered for';

/** How long after a fire its session may still check in and be recognised. */
export const ARRIVAL_LOOKBACK_MS = 6 * 60 * 60_000;

/**
 * How long a wrong-worker arrival waits before it is acted on. A Claude session
 * may hold both of a person's Brain connectors and check in through each with
 * the same session; the one that authenticates as the registered worker is the
 * answer, and the other is noise.
 */
export const WRONG_WORKER_GRACE_MS = 2 * 60_000;

/**
 * Did the same fired session also arrive as the registered worker? Then it is
 * not a wrong-connector Routine — it holds both connectors and used the right
 * one too.
 */
export async function sessionAlsoArrivedRight(sessionRef: string | null, workerId: string): Promise<boolean> {
  const spellings = sessionSpellings(sessionRef);
  if (spellings.length === 0) return false;
  const row = await getDb().get<{ hit: number }>(
    `SELECT 1 AS hit FROM bin_events
      WHERE event_type IN ('DISPATCH_SESSION_ARRIVED', 'BIN_ASSIGNED', 'BIN_TAKEOVER')
        AND worker_id = ? AND session_ref IN (${spellings.map(() => '?').join(', ')}) LIMIT 1`,
    [workerId, ...spellings],
  );
  return !!row;
}

/** How soon after its fire an arrival may name a connector — the in-flight window. */
const ATTRIBUTION_WINDOW_MS = 30 * 60_000;

/** How far back a wrong-worker arrival still counts as evidence for recovery. */
const EVIDENCE_WINDOW_MS = 30 * 24 * 60 * 60_000;

export type ArrivalVerdict =
  | { kind: 'NONE' }
  | { kind: 'MATCH'; routineId: string; binId: string }
  | { kind: 'WRONG_WORKER'; routineId: string; binId: string; expectedWorkerId: string; arrivedWorkerId: string };

export interface WrongWorkerEvidence {
  routineId: string;
  binId: string | null;
  at: string;
  sessionRef: string | null;
  expectedWorkerId: string;
  arrivedWorkerId: string;
  credentialId: string | null;
  clientId: string | null;
  endpoint: string | null;
}

/**
 * A worker checked in reporting a provider session. If that session is one
 * Brain fired, record that it arrived and as whom. A database failure is
 * thrown for the caller to classify (check-in records the session as unserved
 * rather than losing the evidence silently); the caller never lets it refuse
 * the session its work.
 */
export async function observeFiredSessionArrival(input: {
  workerId: string;
  credentialId: string | null;
  sessionRef: string | null | undefined;
  now?: number;
}): Promise<ArrivalVerdict> {
  {
    const spellings = sessionSpellings(input.sessionRef);
    if (spellings.length === 0) return { kind: 'NONE' };
    const now = input.now ?? Date.now();
    const since = new Date(now - ARRIVAL_LOOKBACK_MS).toISOString();
    const ph = spellings.map(() => '?').join(', ');
    const fired = await getDb().get<{
      bin_id: string;
      routine_id: string;
      routine_ref: string | null;
      lease_generation: number;
      project_id: string;
      sent_at: string;
      probe: number;
    }>(
      `SELECT d.bin_id AS bin_id, d.routine_id AS routine_id, d.routine_ref AS routine_ref,
              d.lease_generation AS lease_generation, b.project_id AS project_id, d.sent_at AS sent_at,
              CASE WHEN EXISTS (SELECT 1 FROM connector_recovery_probes p WHERE p.bin_id = d.bin_id) THEN 1 ELSE 0 END AS probe
         FROM bin_dispatch d JOIN bins b ON b.id = d.bin_id
        WHERE d.session_ref IN (${ph}) AND d.routine_id IS NOT NULL AND d.sent_at >= ?
        ORDER BY d.sent_at DESC LIMIT 1`,
      [...spellings, since],
    );
    if (!fired) return { kind: 'NONE' };
    const routine = await getRoutine(fired.routine_id);
    if (!routine?.workerId) return { kind: 'NONE' };

    const wrong = routine.workerId !== input.workerId;
    const verdict: ArrivalVerdict = wrong
      ? {
          kind: 'WRONG_WORKER',
          routineId: routine.id,
          binId: fired.bin_id,
          expectedWorkerId: routine.workerId,
          arrivedWorkerId: input.workerId,
        }
      : { kind: 'MATCH', routineId: routine.id, binId: fired.bin_id };
    const eventType = wrong ? 'DISPATCH_WRONG_WORKER' : 'DISPATCH_SESSION_ARRIVED';

    // Once per fired session: a session checks in again after every bin.
    const seen = await getDb().get<{ hit: number }>(
      `SELECT 1 AS hit FROM bin_events WHERE event_type = ? AND bin_id = ? AND session_ref IN (${ph}) LIMIT 1`,
      [eventType, fired.bin_id, ...spellings],
    );
    if (seen) return verdict;

    const token = input.credentialId ? await getToken(input.credentialId) : null;
    const endpoint = token ? endpointOf(token.resource) : null;
    await recordBinEvent({
      eventType,
      binId: fired.bin_id,
      projectId: fired.project_id,
      leaseGeneration: fired.lease_generation,
      routineRef: fired.routine_ref,
      routineId: routine.id,
      accountId: routine.accountId,
      workerId: input.workerId,
      sessionRef: input.sessionRef ?? null,
      evidenceClass: 'MEASURED',
      outcome: wrong ? 'WRONG_WORKER' : 'ARRIVED',
      measures: {
        expectedWorkerId: routine.workerId,
        arrivedWorkerId: input.workerId,
        credentialId: input.credentialId,
        clientId: token?.clientId ?? null,
        endpoint,
      },
      reason: wrong
        ? `Brain fired ${routine.name} (registered for ${routine.workerId}); its session arrived authenticated as ` +
          `${input.workerId}${endpoint ? ` through ${endpoint}` : ''}. The Claude Routine selects a different Brain connector.`
        : `The session Brain fired at ${routine.name} arrived as its registered worker.`,
    });
    /*
     * A proven arrival of the registered worker names this Routine's connector
     * whether or not the session then takes a bin. Waiting for an assignment
     * left a working connector unattributed — and so its health unreadable —
     * whenever its sessions found nothing to take.
     */
    /*
     * Only for an ordinary fire, and only while it is fresh. A recovery probe
     * attributes from its own settlement, inside its own window; and a session
     * id presented long after its fire — late, or replayed with another
     * account's credential on a shared worker — must bind nothing.
     */
    const fresh = now - Date.parse(fired.sent_at) <= ATTRIBUTION_WINDOW_MS;
    if (!wrong && input.credentialId && !routine.connectorId && !Number(fired.probe) && fresh) {
      try {
        const { observeConnectorArrival } = await import('./connectorBinding.ts');
        await observeConnectorArrival({
          routineId: routine.id,
          workerId: input.workerId,
          credentialId: input.credentialId,
          proven: true,
        });
      } catch {
        // Evidence; the tick's reconciliation retries it.
      }
    }
    return verdict;
  }
}

/* ------------------------------------------------------------------------- */
/* Mixed arrivals (CON-3)                                                      */
/* ------------------------------------------------------------------------- */

/** The phrase a wrong-worker quarantine carries once its arrivals are proven mixed. */
export const MIXED_ARRIVALS_REASON_MARK = 'its sessions have arrived as both workers';

/** How far back a Routine's arrivals are read to judge whether its configuration is consistent. */
export const ARRIVAL_MIX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * How many sessions in a row must arrive as the registered worker, after the
 * last that arrived as another, before a Routine whose arrivals were mixed is
 * believed corrected. One is not evidence for a Routine that chooses between
 * two connectors per session: production 2-C arrived right twice and wrong
 * three times in three hours, interleaved, and one right probe lifted it every
 * time. Three in a row is still reachable by a Routine that genuinely was fixed
 * (each probe that proves it is one), and is bounded by the automatic budget for
 * one that was not.
 */
export const CONSISTENT_RIGHT_SESSIONS = 3;

export interface ArrivalMix {
  /** Distinct fired sessions that arrived as the registered worker (at least once). */
  right: number;
  /** Distinct fired sessions that arrived only as another worker. */
  wrong: number;
  /** The newest wrong-only session, if any. */
  lastWrongAt: string | null;
  /** Right sessions that began after the newest wrong-only one. */
  rightSinceLastWrong: number;
  /** Whether any right session preceded the newest wrong-only one inside the window. */
  rightBeforeLastWrong: boolean;
  /** The workers the wrong-only sessions authenticated as. */
  otherWorkers: string[];
}

/**
 * Who this Routine's fired sessions arrived as, grouped by session, from the
 * arrival rows check-in writes (`observeFiredSessionArrival`). A session that
 * arrived through both of a person's connectors counts as right, exactly as
 * `sessionAlsoArrivedRight` already decides. Recovery-probe sessions count too:
 * a probe is a session the Routine started, and which connector it chose is the
 * same question.
 */
export async function arrivalMix(routineId: string, now = Date.now()): Promise<ArrivalMix> {
  const since = new Date(now - ARRIVAL_MIX_WINDOW_MS).toISOString();
  const rows = await getDb().all<{ event_type: string; at: string; session_ref: string | null; worker_id: string | null }>(
    `SELECT event_type, at, session_ref, worker_id FROM bin_events
      WHERE routine_id = ? AND at >= ?
        AND event_type IN ('DISPATCH_SESSION_ARRIVED', 'DISPATCH_WRONG_WORKER')
      ORDER BY at, rowid`,
    [routineId, since],
  );
  const sessions = new Map<string, { at: string; right: boolean; worker: string | null }>();
  for (const row of rows) {
    const key = normalizeSessionRef(row.session_ref) ?? `${row.event_type}:${row.at}`;
    const right = row.event_type === 'DISPATCH_SESSION_ARRIVED';
    const seen = sessions.get(key);
    if (!seen) sessions.set(key, { at: row.at, right, worker: right ? null : row.worker_id });
    else if (right) seen.right = true;
  }
  const ordered = [...sessions.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let lastWrongIndex = -1;
  ordered.forEach((s, i) => {
    if (!s.right) lastWrongIndex = i;
  });
  const wrongSessions = ordered.filter((s) => !s.right);
  return {
    right: ordered.length - wrongSessions.length,
    wrong: wrongSessions.length,
    lastWrongAt: lastWrongIndex >= 0 ? ordered[lastWrongIndex]!.at : null,
    rightSinceLastWrong: ordered.slice(lastWrongIndex + 1).filter((s) => s.right).length,
    rightBeforeLastWrong: lastWrongIndex > 0 && ordered.slice(0, lastWrongIndex).some((s) => s.right),
    otherWorkers: [...new Set(wrongSessions.map((s) => s.worker).filter((w): w is string => !!w))],
  };
}

/** Whether a mix says the Routine chooses between two connectors, rather than having switched once. */
export function isMixed(mix: ArrivalMix): boolean {
  return mix.wrong > 0 && mix.rightBeforeLastWrong;
}

/**
 * Why a wrong-worker quarantine must not be lifted yet, or null when it may.
 *
 * Three readings, kept apart:
 *
 *   - **No right session since the last wrong one** — nothing has shown the
 *     configuration changed. No evidence is not proof of correction.
 *   - **A clean switch** — only wrong sessions, then right ones: the account
 *     owner changed the connector. One right session is enough, which is what
 *     keeps the automatic recovery for a genuinely corrected Routine.
 *   - **Mixed** — right sessions before the last wrong one: the Routine holds
 *     both connectors and picks per session. It lifts only after
 *     `CONSISTENT_RIGHT_SESSIONS` right sessions in a row.
 */
export async function wrongWorkerLiftRefusal(
  routineId: string,
  now = Date.now(),
): Promise<{ sentence: string; mix: ArrivalMix } | null> {
  const mix = await arrivalMix(routineId, now);
  if (mix.wrong === 0) return null;
  if (mix.rightSinceLastWrong === 0) {
    return {
      mix,
      sentence:
        `No session has arrived as its registered worker since the last one that arrived as another (${mix.lastWrongAt}), ` +
        'so nothing shows the configuration changed.',
    };
  }
  if (!isMixed(mix)) return null;
  if (mix.rightSinceLastWrong >= CONSISTENT_RIGHT_SESSIONS) return null;
  return { mix, sentence: mixedSentence(mix) };
}

function mixedSentence(mix: ArrivalMix): string {
  return (
    `In the last ${ARRIVAL_MIX_WINDOW_MS / 86_400_000} days ${mix.right} of its sessions arrived as its registered worker and ` +
    `${mix.wrong} as ${mix.otherWorkers.join(', ') || 'another worker'}, interleaved (the newest wrong one at ${mix.lastWrongAt}), ` +
    'so the Claude Routine holds both Brain connectors and picks one per session. Remove the incorrect connector from this ' +
    `Routine in Claude; Brain lifts the quarantine by itself once ${CONSISTENT_RIGHT_SESSIONS} sessions in a row arrive as ` +
    `the registered worker (${mix.rightSinceLastWrong} so far).`
  );
}

/* ------------------------------------------------------------------------- */
/* A remedy the account owner can act on (CON-5a)                            */
/* ------------------------------------------------------------------------- */

function describeConnector(connector: Connector): string {
  return `the Brain connector at ${connector.resource}${connector.label ? ` ("${connector.label}")` : ''}`;
}

async function workerLabel(workerId: string): Promise<string> {
  const worker = await getWorker(workerId);
  return worker?.label ?? worker?.displayName ?? workerId;
}

/**
 * The account owner's remedy, naming connectors by what they can see in Claude
 * — the connector's URL and label — and resolving which connector authorizes as
 * which worker from Brain's verified bindings (`connectors.worker_id`, the
 * client attribution), never from the URL's wording: production had Airyn's
 * `/mcp` authorizing as the factory worker and `/mcp/factory` as his research
 * one, the opposite of what the paths suggest.
 */
export async function wrongWorkerRemedy(input: {
  routine: FleetRoutine;
  expectedWorkerId: string;
  arrivedWorkerId: string;
  clientId: string | null;
  endpoint: string | null;
  mixed: boolean;
}): Promise<string> {
  const inAccount = (await listConnectors()).filter((c) => c.accountId === input.routine.accountId);
  const right = inAccount.filter((c) => c.workerId === input.expectedWorkerId);
  const attributed = input.clientId ? await connectorClient(input.clientId) : null;
  const wrongConnector =
    (attributed ? await getConnector(attributed.connectorId) : null) ??
    (inAccount.filter((c) => c.workerId === input.arrivedWorkerId).length === 1
      ? inAccount.find((c) => c.workerId === input.arrivedWorkerId)!
      : null);
  const expected = await workerLabel(input.expectedWorkerId);
  const arrived = await workerLabel(input.arrivedWorkerId);
  const wrongText = wrongConnector
    ? `${describeConnector(wrongConnector)} (verified to authorize as ${arrived})`
    : `the Brain connector${input.endpoint ? ` at ${input.endpoint}` : ''} that authorizes as ${arrived}`;
  const rightText =
    right.length === 1
      ? `${describeConnector(right[0]!)}, which Brain has verified authorizes as ${expected}`
      : right.length > 1
        ? `one of ${right.map(describeConnector).join(' or ')} (each verified to authorize as ${expected})`
        : `a Brain connector that authorizes as ${expected} — none in this Claude account is verified yet, so ` +
          'Brain cannot name it; it becomes known the first time a session arrives through it';
  const owner = input.mixed
    ? `(account owner) in Claude, remove ${wrongText} from ${input.routine.name}, keeping ${rightText}`
    : `(account owner) in Claude, set ${input.routine.name}'s Brain connector to ${rightText}, instead of ${wrongText}`;
  return (
    `Fix one of: ${owner}; or (operator, if ${input.arrivedWorkerId} is the intended identity) ` +
    `\`fleet repoint-worker --ref ${input.routine.routineRef} --expect ${input.expectedWorkerId} --worker ${input.arrivedWorkerId}\`, ` +
    'after which Brain re-enables it by itself.'
  );
}

/** The newest wrong-worker arrival recorded for each Routine since `since`. */
export async function latestWrongWorkerEvidence(since: string): Promise<Map<string, WrongWorkerEvidence>> {
  const rows = await getDb().all<{
    routine_id: string;
    bin_id: string | null;
    at: string;
    session_ref: string | null;
    measures: string | null;
  }>(
    `SELECT routine_id, bin_id, at, session_ref, measures FROM bin_events
      WHERE event_type = 'DISPATCH_WRONG_WORKER' AND routine_id IS NOT NULL AND at >= ?
      ORDER BY at DESC, rowid DESC`,
    [since],
  );
  const out = new Map<string, WrongWorkerEvidence>();
  for (const row of rows) {
    if (out.has(row.routine_id)) continue;
    const m = parseJson<Record<string, unknown>>(row.measures, {});
    const expected = typeof m['expectedWorkerId'] === 'string' ? m['expectedWorkerId'] : null;
    const arrived = typeof m['arrivedWorkerId'] === 'string' ? m['arrivedWorkerId'] : null;
    if (!expected || !arrived) continue;
    out.set(row.routine_id, {
      routineId: row.routine_id,
      binId: row.bin_id,
      at: row.at,
      sessionRef: row.session_ref,
      expectedWorkerId: expected,
      arrivedWorkerId: arrived,
      credentialId: typeof m['credentialId'] === 'string' ? m['credentialId'] : null,
      clientId: typeof m['clientId'] === 'string' ? m['clientId'] : null,
      endpoint: typeof m['endpoint'] === 'string' ? m['endpoint'] : null,
    });
  }
  return out;
}

/** The sentence a wrong-worker quarantine carries: the cause, and both remedies. */
export function wrongWorkerReason(input: {
  routineName: string;
  routineRef: string;
  evidence: WrongWorkerEvidence;
}): string {
  const e = input.evidence;
  return (
    `${WRONG_WORKER_MARK}. Brain fired ${input.routineName} for ${e.expectedWorkerId}, and its session ` +
    `${e.sessionRef ?? '(unreported)'} authenticated as ${e.arrivedWorkerId}` +
    `${e.endpoint ? ` through the Brain connector at ${e.endpoint}` : ''}${e.clientId ? ` (client ${e.clientId})` : ''} ` +
    `at ${e.at}. This is the Claude Routine choosing the wrong connector, not an expired authorization and not a Brain outage, ` +
    'so it was stopped after one activation instead of being fired until it was quarantined for no-shows. ' +
    `Fix one of: (account owner) in Claude, set this Routine's Brain connector to the one that authorizes as ${e.expectedWorkerId}; ` +
    `or (operator, if ${e.arrivedWorkerId} is the intended identity) \`fleet repoint-worker --ref ${input.routineRef} ` +
    `--expect ${e.expectedWorkerId} --worker ${e.arrivedWorkerId}\`, after which Brain re-enables it by itself.`
  );
}

/**
 * The first wrong-worker arrival takes the Routine out of routing.
 *
 * Only while the registration still names the worker that did not arrive
 * (a repoint since is the answer, handled below), and only for evidence newer
 * than the last time a person forgave this surface — so an operator who
 * re-enables it deliberately gets one more fire before it is stopped again,
 * not an immediate re-quarantine on the same row.
 */
export async function quarantineWrongWorkerSurfaces(now = Date.now()): Promise<string[]> {
  const quarantined: string[] = [];
  const evidence = await latestWrongWorkerEvidence(new Date(now - ARRIVAL_LOOKBACK_MS * 4).toISOString());
  for (const [routineId, e] of evidence) {
    // A grace period, so the same session's call through its other connector can land first.
    if (now - Date.parse(e.at) < WRONG_WORKER_GRACE_MS) continue;
    const routine = await getRoutine(routineId);
    if (!routine || routine.state !== 'ENABLED') continue;
    if (routine.workerId !== e.expectedWorkerId) continue;
    if (routine.noShowsForgivenAt && e.at <= routine.noShowsForgivenAt) continue;
    if (await sessionAlsoArrivedRight(e.sessionRef, routine.workerId)) continue;
    const mix = await arrivalMix(routineId, now);
    const base = wrongWorkerReason({ routineName: routine.name, routineRef: routine.routineRef, evidence: e });
    const moved = await setRoutineState({
      routineId,
      from: 'ENABLED',
      to: 'QUARANTINED',
      reason: isMixed(mix) ? `${base} ${MIXED_ARRIVALS_REASON_MARK}: ${mixedSentence(mix)}` : base,
    });
    if (moved) quarantined.push(routineId);
  }
  return quarantined;
}

/**
 * A Routine whose sessions were proven to authenticate as worker W, and which
 * an operator has since registered for W, comes back by itself.
 *
 * The proof is the recorded arrival (the provider session matched the fire);
 * the decision is the operator's repoint, which Brain never makes. What Brain
 * adds is noticing that the two now agree, so nobody has to also remember
 * `fleet set-state`. It binds the Routine to the connector that arrival came
 * through, and it leaves alone a worker that cannot be handed work or whose
 * connector needs consent — re-enabling those would only spend fires.
 */
export async function recoverRebindedSurfaces(now = Date.now()): Promise<string[]> {
  const recovered: string[] = [];
  const evidence = await latestWrongWorkerEvidence(new Date(now - EVIDENCE_WINDOW_MS).toISOString());
  for (const [routineId, e] of evidence) {
    const routine = await getRoutine(routineId);
    if (!routine || routine.state !== 'QUARANTINED') continue;
    // Only the quarantine this evidence explains, and only evidence from this episode:
    // a later quarantine for something else must wait for its own recovery.
    if (!(routine.stateReason ?? '').includes(WRONG_WORKER_MARK)) continue;
    if (routine.noShowsForgivenAt && e.at <= routine.noShowsForgivenAt) continue;
    if (routine.workerId !== e.arrivedWorkerId) continue;
    const worker = await getWorker(e.arrivedWorkerId);
    if (!worker || worker.disabled || worker.archived) continue;
    const memberships = (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active);
    if (memberships.length === 0) continue;

    /*
     * The connector is not bound from this evidence: it may be days old, and a
     * session id presented long after its fire binds nothing. The next fire's
     * own arrival binds it (`observeFiredSessionArrival`).
     */
    const connectorId: string | null = routine.connectorId;
    if (connectorId) {
      const { connectorHealth } = await import('./connectorHealth.ts');
      const health = await connectorHealth(connectorId, now);
      if (health?.humanActionRequired) continue;
    }
    const moved = await setRoutineState({
      routineId,
      from: 'QUARANTINED',
      to: 'ENABLED',
      reason:
        `Re-enabled automatically: its fired session ${e.sessionRef ?? ''} was proven (${e.at}) to authenticate as ` +
        `${e.arrivedWorkerId}, and the Routine is now registered for ${e.arrivedWorkerId}, so the mismatch that stopped it ` +
        'is resolved. A surface that still does not answer is quarantined again.',
    });
    if (moved) recovered.push(routineId);
  }
  if (recovered.length > 0) {
    const { forgetRoutingHealth } = await import('./connectorHealth.ts');
    forgetRoutingHealth();
  }
  return recovered;
}
