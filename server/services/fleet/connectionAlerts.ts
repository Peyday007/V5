/**
 * What is wrong with each connection, who has to act, and exactly what to do —
 * one derivation every surface reads (People, Fleet, Needs you, the operator's
 * connection report), so none of them invents its own answer.
 *
 * Two production cases decided its shape:
 *
 *   - **Airyn, 2026-10-11.** Four Research Routines whose Claude configuration
 *     selected his Factory-side connector were fired 115 times each before
 *     anybody noticed, and every screen said "quarantined for no-shows" — true
 *     and useless. The problem was nameable from the first arrival.
 *   - **Caleb.** Four Routines read ENABLED and routable on every screen and had
 *     not been fired since 2026-09-19, because the worker they run as is a member
 *     only of test projects and no real work is ever in scope for it. Nothing was
 *     red; the account simply contributed nothing for three weeks.
 *
 * Every alert is derived from rows on the read path and stored nowhere, and it
 * changes nothing: who-acts is `NOBODY` when Brain is already recovering it by
 * itself, so an inbox built on this never asks a person to wait for Brain.
 */
import { listAccounts, listRoutines } from '../../repos/fleet.ts';
import { listDispatchableBins } from '../../repos/bins.ts';
import { getProject } from '../../repos/projects.ts';
import { listMembershipsForPrincipal } from '../../repos/identity.ts';
import { fleetSnapshot } from '../dispatch/candidates.ts';
import { servesBinScope, surfaceIneligibility } from '../dispatch/router.ts';
import { familyOf } from '../bins/routing.ts';
import { WRONG_WORKER_MARK } from './arrivalIdentity.ts';
import { autoRecoveryExhausted, nextAutoProbeAt } from './autoRecovery.ts';
import { liftableQuarantine } from './recoveryProbe.ts';
import type { FleetRoutine } from '../../domain/types.ts';

export type ConnectionProblem =
  /** The Claude Routine selects a Brain connector that authenticates as another worker. */
  | 'WRONG_WORKER'
  /** The connector's authorization is genuinely gone (read from token rows). */
  | 'REAUTH_REQUIRED'
  /** Quarantined by Brain; Brain will probe it again by itself. */
  | 'RECOVERING'
  /** Quarantined by Brain; Brain has stopped probing it and a person must look. */
  | 'RECOVERY_EXHAUSTED'
  /** Eligible, but its worker serves no project any waiting work is in. */
  | 'OUT_OF_SCOPE';

export type WhoActs = 'ACCOUNT_OWNER' | 'OPERATOR' | 'NOBODY';

export interface ConnectionAlert {
  routineId: string;
  routineName: string;
  accountId: string;
  accountName: string;
  problem: ConnectionProblem;
  /** What is wrong, in one sentence, from the rows. */
  detail: string;
  /** The exact next step. */
  action: string;
  who: WhoActs;
  since: string | null;
  /** Project names, for OUT_OF_SCOPE, for readers allowed to see every project. */
  projects?: { served: string[]; waiting: string[] };
}

export interface StalledAccount {
  accountId: string;
  accountName: string;
  /** Every live Routine of the account, each with an alert a person must answer. */
  routineIds: string[];
}

export interface ConnectionAlerts {
  alerts: ConnectionAlert[];
  /** Accounts that contribute nothing until a person acts. */
  stalled: StalledAccount[];
}

const WAITING_PAGE = 200;

/**
 * What to do once Brain has stopped probing. A reconnect only when the token
 * rows prove consent is gone — silence (NO_MCP) is not that proof.
 */
async function exhaustedAction(routine: FleetRoutine, lastState: string | null): Promise<string> {
  if (routine.connectorId) {
    const { connectorHealth } = await import('./connectorHealth.ts');
    const health = await connectorHealth(routine.connectorId);
    if (health?.humanActionRequired) {
      return 'Its connector’s consent is gone: the account owner reconnects Brain from Claude while signed in to Brain.';
    }
  }
  return (
    `The last probe read ${lastState ?? 'nothing'}. In Claude, the account owner checks that this Routine still runs and ` +
    `that its Brain connector is attached and enabled; then \`connectors probe ${routine.routineRef}\` (or any re-enable) ` +
    'lets Brain try again.'
  );
}

/** How long an eligible surface may go unfired, with work waiting it cannot take, before that is a finding. */
export const IDLE_FINDING_MS = 24 * 60 * 60_000;

export async function connectionAlerts(now = Date.now()): Promise<ConnectionAlerts> {
  const accounts = new Map((await listAccounts()).map((a) => [a.id, a]));
  const snapshot = await fleetSnapshot(new Date(now));
  const candidates = new Map(snapshot.candidates.map((c) => [c.routine.id, c]));
  const exhausted = new Map((await autoRecoveryExhausted()).map((e) => [e.routineId, e]));
  let waiting: Awaited<ReturnType<typeof listDispatchableBins>> | null = null;

  const alerts: ConnectionAlert[] = [];
  const routines = await listRoutines();
  for (const routine of routines) {
    const account = accounts.get(routine.accountId);
    if (!account || account.kind !== 'CAPACITY' || routine.state === 'RETIRED' || account.state === 'RETIRED') continue;
    const base = { routineId: routine.id, routineName: routine.name, accountId: account.id, accountName: account.name };
    const candidate = candidates.get(routine.id);
    const reason = routine.stateReason ?? '';

    if (candidate?.connectorHealth?.state === 'HUMAN_REAUTH_REQUIRED') {
      alerts.push({
        ...base,
        problem: 'REAUTH_REQUIRED',
        detail: `Its Claude connector’s authorization is gone (${candidate.connectorHealth.reason}), read from its token rows.`,
        action:
          `The owner of the ${account.name} Claude account reconnects Brain from Claude while signed in to Brain ` +
          '(their consent screen offers only this connector’s worker); the surface comes back by itself.',
        who: 'ACCOUNT_OWNER',
        since: null,
      });
      continue;
    }
    if (routine.state === 'QUARANTINED' && reason.includes(WRONG_WORKER_MARK)) {
      alerts.push({
        ...base,
        problem: 'WRONG_WORKER',
        detail: firstSentences(reason, 2),
        action: remedyFrom(reason),
        who: 'ACCOUNT_OWNER',
        since: routine.updatedAt,
      });
      continue;
    }
    if (routine.state === 'QUARANTINED' && liftableQuarantine(reason)) {
      const ran = exhausted.get(routine.id);
      if (ran) {
        alerts.push({
          ...base,
          problem: 'RECOVERY_EXHAUSTED',
          detail:
            `Quarantined (${firstSentences(reason, 1)}) and Brain probed it ${ran.attempts} times by itself without proving it ` +
            `healthy; the last probe read ${ran.lastProbeState ?? 'unknown'} at ${ran.lastProbeAt ?? 'unknown'}.`,
          action: await exhaustedAction(routine, ran.lastProbeState),
          who: 'ACCOUNT_OWNER',
          since: ran.lastProbeAt,
        });
      } else {
        const next = await nextAutoProbeAt(routine.id);
        alerts.push({
          ...base,
          problem: 'RECOVERING',
          detail: `Quarantined (${firstSentences(reason, 1)}).`,
          action: next
            ? `Nothing to do: Brain probes it again by itself at ${next} and lifts the quarantine if a session arrives.`
            : 'Nothing to do yet: Brain probes it by itself when the probe slot is free.',
          who: 'NOBODY',
          since: routine.updatedAt,
        });
      }
      continue;
    }

    // Eligible, and quietly contributing nothing.
    if (routine.state === 'ENABLED' && candidate && surfaceIneligibility(candidate) === null) {
      const lastFired = routine.lastFiredAt ? Date.parse(routine.lastFiredAt) : 0;
      if (now - lastFired < IDLE_FINDING_MS) continue;
      waiting ??= await listDispatchableBins(WAITING_PAGE);
      // A full page cannot prove nothing servable lies beyond it: unknown is not a finding.
      if (waiting.length === 0 || waiting.length >= WAITING_PAGE) continue;
      if (waiting.some((bin) => servesBinScope(candidate, bin))) continue;
      /*
       * Only work of a kind this surface serves, stuck behind a project it is
       * not part of. A Factory surface idle beside research bins is not out of
       * scope; it has nothing of its own to do, and granting it a research
       * project would be the wrong remedy entirely.
       */
      const families = Array.isArray(candidate.servesFamilies) ? candidate.servesFamilies : null;
      const sameKind = waiting.filter((bin) => families === null || families.includes(familyOf(bin)));
      if (sameKind.length === 0) continue;
      const served = await projectNames(routine);
      const elsewhere = await namesOf([...new Set(sameKind.map((b) => b.projectId))].slice(0, 4));
      alerts.push({
        ...base,
        problem: 'OUT_OF_SCOPE',
        // No project is named here: this sentence reaches project administrators,
        // and other people's projects are not theirs to read. `projects` carries
        // the names for readers that may see them (the shell report, Brain administrators).
        detail:
          `Eligible, and not fired since ${routine.lastFiredAt ?? 'it was registered'}: the ${sameKind.length} bin(s) of its ` +
          'kind waiting are all in projects its worker is not part of. It is healthy and has nothing it may be given.',
        projects: { served, waiting: elsewhere },
        action:
          `An operator decides whether ${routine.workerId} should work on that project and, if so, grants it ` +
          `(\`admin access grant ${routine.workerId} "<project>"\`). Brain does not widen a worker's scope by itself.`,
        who: 'OPERATOR',
        since: routine.lastFiredAt,
      });
    }
  }

  // An account whose every live Routine needs a person contributes nothing.
  const byAccount = new Map<string, FleetRoutine[]>();
  for (const routine of routines) {
    const account = accounts.get(routine.accountId);
    if (!account || account.kind !== 'CAPACITY' || routine.state === 'RETIRED' || account.state === 'RETIRED') continue;
    byAccount.set(routine.accountId, [...(byAccount.get(routine.accountId) ?? []), routine]);
  }
  const needsPerson = new Set(alerts.filter((a) => a.who !== 'NOBODY').map((a) => a.routineId));
  const stalled: StalledAccount[] = [];
  for (const [accountId, live] of byAccount) {
    if (live.length === 0 || !live.every((r) => needsPerson.has(r.id))) continue;
    stalled.push({ accountId, accountName: accounts.get(accountId)!.name, routineIds: live.map((r) => r.id) });
  }
  return { alerts, stalled };
}

/** The alert for each Routine, for surfaces that read one at a time. */
export async function alertsByRoutine(now = Date.now()): Promise<Map<string, ConnectionAlert>> {
  return new Map((await connectionAlerts(now)).alerts.map((a) => [a.routineId, a]));
}

function firstSentences(text: string, n: number): string {
  const parts = text.split(/(?<=\.)\s+/).slice(0, n);
  return parts.join(' ').trim();
}

/** The "Fix one of:" half of a wrong-worker reason, which names both remedies. */
function remedyFrom(reason: string): string {
  const at = reason.indexOf('Fix one of:');
  return at >= 0 ? reason.slice(at) : reason;
}

async function projectNames(routine: FleetRoutine): Promise<string[]> {
  if (!routine.workerId) return [];
  const memberships = (await listMembershipsForPrincipal('WORKER', routine.workerId)).filter((m) => m.active);
  return namesOf(memberships.map((m) => m.projectId));
}

async function namesOf(projectIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of projectIds) out.push((await getProject(id))?.name ?? id);
  return out;
}

