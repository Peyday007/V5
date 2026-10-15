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
import { binScopeRefusal, surfaceIneligibility, type BinScopeRefusal } from '../dispatch/router.ts';
import { familyOf, repositoryIdOf } from '../bins/routing.ts';
import {
  arrivalMix,
  isMixed,
  latestWrongWorkerEvidence,
  WRONG_WORKER_MARK,
  wrongWorkerRemedy,
} from './arrivalIdentity.ts';
import { getDb } from '../../db/database.ts';
import { latestRecoveryProbeFor } from '../../repos/recoveryProbes.ts';
import { autoRecoveryExhausted, nextAutoProbeAt } from './autoRecovery.ts';
import { liftableQuarantine } from './recoveryProbe.ts';
import type { Bin, FleetRoutine } from '../../domain/types.ts';

export type ConnectionProblem =
  /** The Claude Routine selects a Brain connector that authenticates as another worker. */
  | 'WRONG_WORKER'
  /**
   * The Claude Routine holds both connectors and its sessions arrive as either
   * worker (CON-3); the remedy is to remove one, not to switch.
   */
  | 'MIXED_WORKERS'
  /** The connector's authorization is genuinely gone (read from token rows). */
  | 'REAUTH_REQUIRED'
  /** Quarantined by Brain; Brain will probe it again by itself. */
  | 'RECOVERING'
  /** Quarantined by Brain; Brain has stopped probing it and a person must look. */
  | 'RECOVERY_EXHAUSTED'
  /** Eligible, but its worker serves no project any waiting work is in. */
  | 'OUT_OF_SCOPE'
  /**
   * Eligible, and a member of the waiting work's project, but refused that work
   * by a repository, capability or delivery condition (CON-5b) — never a
   * reason to grant a project.
   */
  | 'CANNOT_TAKE_WAITING_WORK';

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
  /**
   * What this Routine has actually done lately, kept apart (CON-5c): an
   * ordinary fire, a recovery-probe fire and a session arriving are three
   * facts, and a sentence built from the first alone called a Routine that
   * checked in an hour ago "not fired since 09-27".
   */
  activity?: RoutineActivity;
}

export interface RoutineActivity {
  lastOrdinaryFireAt: string | null;
  lastProbeFireAt: string | null;
  lastArrivalAt: string | null;
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

/**
 * Past the fast budget Brain still checks once a day, so a fix made on the
 * Claude side without telling anybody is noticed by itself (§62's correction to
 * §59). Said, so the owner knows they need not come back and press anything.
 */
async function slowCheckSentence(routineId: string): Promise<string> {
  const next = await nextAutoProbeAt(routineId);
  return next ? ` Brain checks it again by itself at ${next}, once a day, and lifts it the moment a right session arrives.` : '';
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
  let wrongEvidence: Awaited<ReturnType<typeof latestWrongWorkerEvidence>> | null = null;
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
      /*
       * Derived from the arrival rows rather than the stored sentence: whether
       * the sessions are mixed, and which connector the owner can see in Claude
       * authorizes as which worker, are facts the rows answer now (CON-3,
       * CON-5a). A quarantine written before either derivation existed reads
       * correctly without being rewritten.
       */
      wrongEvidence ??= await latestWrongWorkerEvidence(new Date(now - 30 * 24 * 60 * 60_000).toISOString());
      const evidence = wrongEvidence.get(routine.id);
      const mix = await arrivalMix(routine.id, now);
      const mixed = isMixed(mix);
      alerts.push({
        ...base,
        problem: mixed ? 'MIXED_WORKERS' : 'WRONG_WORKER',
        detail: mixed
          ? `Its sessions arrive as both workers: in the last week ${mix.right} arrived as ${routine.workerId} and ` +
            `${mix.wrong} as ${mix.otherWorkers.join(', ') || 'another worker'}, interleaved. The Claude Routine holds both ` +
            'Brain connectors and picks one per session; one right arrival does not show it is fixed.'
          : firstSentences(reason, 2),
        action: evidence
          ? await wrongWorkerRemedy({
              routine,
              expectedWorkerId: evidence.expectedWorkerId,
              arrivedWorkerId: evidence.arrivedWorkerId,
              clientId: evidence.clientId,
              endpoint: evidence.endpoint,
              mixed,
            })
          : remedyFrom(reason),
        who: 'ACCOUNT_OWNER',
        since: routine.updatedAt,
      });
      continue;
    }
    if (routine.state === 'QUARANTINED' && liftableQuarantine(reason)) {
      const ran = exhausted.get(routine.id);
      if (ran?.lastProbeOutage) {
        /*
         * The probe that would have counted proved only that Brain was down
         * (CON-6). Nothing about the connector is established, so the account
         * owner is not sent to reconnect anything.
         */
        alerts.push({
          ...base,
          problem: 'RECOVERY_EXHAUSTED',
          detail:
            `Quarantined (${firstSentences(reason, 1)}). Brain's own automatic probes are spent, and the last one ` +
            `(${ran.lastProbeAt ?? 'unknown'}) was inconclusive because Brain itself was unavailable.`,
          action:
            `Nothing about the connector is indicated. Once Brain is healthy, an operator runs \`connectors probe ${routine.routineRef}\`; ` +
            'its result says who, if anybody, has to act.',
          who: 'OPERATOR',
          since: ran.lastProbeAt,
        });
      } else if (ran) {
        alerts.push({
          ...base,
          problem: 'RECOVERY_EXHAUSTED',
          detail:
            `Quarantined (${firstSentences(reason, 1)}) and Brain probed it ${ran.attempts} times by itself without proving it ` +
            `healthy; the last probe read ${ran.lastProbeState ?? 'unknown'} at ${ran.lastProbeAt ?? 'unknown'}.` +
            (await slowCheckSentence(routine.id)),
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
      // A bin pinned to another surface is that surface's probe, not work this one is missing.
      const open = waiting.filter((bin) => binScopeRefusal(candidate, bin) !== 'PINNED_ELSEWHERE');
      if (open.some((bin) => binScopeRefusal(candidate, bin) === null)) continue;
      /*
       * Only work of a kind this surface serves, stuck behind a project it is
       * not part of. A Factory surface idle beside research bins is not out of
       * scope; it has nothing of its own to do, and granting it a research
       * project would be the wrong remedy entirely.
       */
      const families = Array.isArray(candidate.servesFamilies) ? candidate.servesFamilies : null;
      const sameKind = open.filter((bin) => families === null || families.includes(familyOf(bin)));
      if (sameKind.length === 0) continue;
      const activity = await routineActivity(routine);
      const served = await projectNames(routine);
      /*
       * The explanation is the condition that refused, read from the same
       * predicate the router applies (`binScopeRefusal`) — CON-5b. Factory
       * surface 1 read "serves: Deal Dispatch · waiting in: Deal Dispatch" under
       * an instruction to grant Deal Dispatch: its membership passed, and what
       * refused it was something else. Only bins refused for their *project*
       * are a project question.
       */
      const refusals = new Map<BinScopeRefusal, typeof sameKind>();
      for (const bin of sameKind) {
        const refusal = binScopeRefusal(candidate, bin);
        if (refusal) refusals.set(refusal, [...(refusals.get(refusal) ?? []), bin]);
      }
      const byProject = refusals.get('PROJECT') ?? [];
      const other = [...refusals.entries()].filter(([kind]) => kind !== 'PROJECT');
      if (byProject.length === 0) {
        const waitingIn = await namesOf([...new Set(sameKind.map((b) => b.projectId))].slice(0, 4));
        alerts.push({
          ...base,
          problem: 'CANNOT_TAKE_WAITING_WORK',
          detail:
            `Eligible and a member of the waiting work's project, with ${describeActivity(activity)}; ` +
            `the ${sameKind.length} bin(s) of its kind waiting are refused to it by ` +
            other.map(([kind, bins]) => `${REFUSAL_WORDS[kind]} (${bins.length})`).join(', ') +
            '. Its project membership is not what refuses them.',
          projects: { served, waiting: waitingIn },
          action: other.map(([kind, bins]) => remedyFor(kind, routine, bins)).join(' '),
          who: 'OPERATOR',
          since: routine.lastFiredAt,
          activity,
        });
        continue;
      }
      const elsewhere = await namesOf([...new Set(byProject.map((b) => b.projectId))].slice(0, 4));
      alerts.push({
        ...base,
        problem: 'OUT_OF_SCOPE',
        activity,
        // No project is named here: this sentence reaches project administrators,
        // and other people's projects are not theirs to read. `projects` carries
        // the names for readers that may see them (the shell report, Brain administrators).
        detail:
          `Eligible, with ${describeActivity(activity)}: ${byProject.length} of the ${sameKind.length} bin(s) of its ` +
          'kind waiting are in projects its worker is not part of' +
          (other.length > 0
            ? `, and the rest are refused by ${other.map(([kind, bins]) => `${REFUSAL_WORDS[kind]} (${bins.length})`).join(', ')}`
            : '') +
          '. It is healthy and has nothing it may be given.',
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

const REFUSAL_WORDS: Record<BinScopeRefusal, string> = {
  PINNED_ELSEWHERE: 'a pin to another surface',
  PROJECT: 'project membership',
  FAMILY: 'workload family',
  REPOSITORY: 'a repository its worker is not routed to',
  CAPABILITY: 'a capability its Routine does not declare',
  DELIVERY_FAILED: 'a recorded refusal to push to that repository',
};

/** The operator's remedy for one refusal, naming the row that would change it. */
function remedyFor(kind: BinScopeRefusal, routine: FleetRoutine, bins: Bin[]): string {
  const repositories = [...new Set(bins.map((b) => repositoryIdOf(b)).filter(Boolean))];
  const repos = repositories.length > 0 ? ` (${repositories.join(', ')})` : '';
  switch (kind) {
    case 'REPOSITORY':
      return `Repository${repos}: an administrator authorizes it for ${routine.workerId} on Build (the worker's routing row), if this surface should do that work.`;
    case 'CAPABILITY':
      return `Capability: if this Routine can do that work, \`fleet set-capabilities --ref ${routine.routineRef} --capabilities <…>\` declares it.`;
    case 'DELIVERY_FAILED':
      return `Delivery${repos}: a push from this surface was refused; once the repository is attached to the Routine in Claude, \`fleet clear-delivery-refusal\` puts it back.`;
    case 'FAMILY':
      return `Family: its worker's routing row does not include this kind of work.`;
    case 'PROJECT':
      return `Project: an operator decides whether ${routine.workerId} should work there (\`admin access grant\`).`;
    case 'PINNED_ELSEWHERE':
      return '';
  }
}

/** Ordinary fires, probe fires and arrivals, read apart (CON-5c). */
async function routineActivity(routine: FleetRoutine): Promise<RoutineActivity> {
  const probe = await latestRecoveryProbeFor(routine.id);
  const arrival = await getDb().get<{ at: string | null }>(
    `SELECT MAX(at) AS at FROM bin_events
      WHERE routine_id = ? AND event_type IN ('DISPATCH_SESSION_ARRIVED', 'DISPATCH_WRONG_WORKER')`,
    [routine.id],
  );
  return {
    lastOrdinaryFireAt: routine.lastFiredAt,
    lastProbeFireAt: probe?.firedAt ?? null,
    lastArrivalAt: arrival?.at ?? null,
  };
}

function describeActivity(a: RoutineActivity): string {
  return (
    `no ordinary fire since ${a.lastOrdinaryFireAt ?? 'it was registered'}` +
    `${a.lastProbeFireAt ? `, a recovery probe fired ${a.lastProbeFireAt}` : ''}` +
    `${a.lastArrivalAt ? `, last session arrived ${a.lastArrivalAt}` : ', and no session recorded as arriving'}`
  );
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

