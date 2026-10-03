/**
 * The recovery probe: how a quarantined, unattributed Routine obtains the proof
 * nothing else can obtain for it.
 *
 * ---------------------------------------------------------------------------
 * The deadlock this answers
 * ---------------------------------------------------------------------------
 *
 * Connector attribution comes from a proven arrival — Brain fired Routine R,
 * and the session that arrived reported the provider session that fire
 * returned (`observeConnectorArrival`). An arrival needs a fire. Brain does not
 * fire a quarantined surface. And the quarantine lifts by itself only when the
 * Routine's *own connector* has a new consent (`recoverReauthorizedSurfaces`),
 * which needs the Routine to have a connector. So a Routine that is quarantined
 * and unattributed could leave that state only by an operator guessing which
 * OAuth client is whose, or re-enabling it blind and hoping — the first is the
 * guess §51 exists to refuse, and the second spends real fires and counts their
 * silence against the surface again.
 *
 * ---------------------------------------------------------------------------
 * What a probe is
 * ---------------------------------------------------------------------------
 *
 *   - **One fire, at exactly one Routine, outside routing.** The router is not
 *     asked, because asking it whether a quarantined surface may be fired has
 *     one answer. Everything else the router would check is checked here: the
 *     surface is not retired or disabled, its account is not disabled, it is
 *     bound to a live worker, and its trigger secret is deployed.
 *   - **One in the Brain at a time**, by a UNIQUE column the database enforces.
 *     Probing every Routine at once is the stampede this is meant to replace.
 *   - **A bin nobody else can take.** The probe's bin is a `DETERMINISTIC_CHECK`
 *     pinned to the Routine, so the pinned-bin guard offers it only to the
 *     session whose provider session matches the fire; it is created with one
 *     attempt, so it can never be re-dispatched; and the session the fire
 *     started is offered that bin and no other (`assignNextBin`). A probe cannot
 *     dispatch real engineering or research work.
 *   - **Not useful-work capacity and not a no-show.** Its fire is recorded as
 *     `RECOVERY_PROBE_FIRED`, which the activation ledger does not count, and
 *     the no-show pass skips it: an unanswered probe is settled here as NO_MCP
 *     and is never charged to the surface.
 *
 * ---------------------------------------------------------------------------
 * The proof chain
 * ---------------------------------------------------------------------------
 *
 *   probe fire F  ->  Routine R  ->  provider session S (the fire's own answer)
 *   ->  check-in reporting S  ->  authenticated with access token T of client C
 *   ->  therefore C is R's account's connector at T's endpoint.
 *
 * S is the challenge. Brain never shows it to anybody; only the provider and the
 * session it started know it, so a session reporting it *is* that session. It
 * is single-use (unique per probe), bound to one Routine, and expires with the
 * probe — a stale or replayed session matches no live probe and binds nothing,
 * and no other Routine can present it, because the probe names its Routine and
 * the pinned bin names the same one. No worker id is evidence anywhere in this:
 * Airyn, Caleb and the owner may all be worker-10.
 *
 * ---------------------------------------------------------------------------
 * Outcomes
 * ---------------------------------------------------------------------------
 *
 *   HEALTHY           arrived, authenticated, connector bound and healthy; a
 *                     quarantine Brain derived (no-shows, a refused fire) is
 *                     lifted, because this fire disproved both.
 *   REAUTH_REQUIRED   the connector is proven to need consent; the one human
 *                     action is prepared and named.
 *   NO_MCP            the provider started a session and nothing it started
 *                     reached Brain. Nothing is attached and nothing is charged.
 *   PROVIDER_REFUSED  the provider would not start a session; attribution is
 *                     untouched.
 *   AMBIGUOUS         it arrived, but the arrival does not prove one connector
 *                     (a worker bearer rather than OAuth, or a conflict with an
 *                     existing attribution); nothing is attached.
 */
import { getAccount, getRoutine, getRoutineByRef, setRoutineState } from '../../repos/fleet.ts';
import { getUser, getWorker, getWorkerRouting } from '../../repos/identity.ts';
import { getToken } from '../../repos/oauth.ts';
import { getConnector } from '../../repos/connectors.ts';
import { getBin, listBinEvents, markBinReady, recordRecoveryDispatch, retireBin } from '../../repos/bins.ts';
import {
  attachRecoveryBin,
  getRecoveryProbe,
  liveRecoveryProbe,
  listRecoveryProbes,
  markRecoveryFired,
  recordRecoveryArrival,
  reserveRecoveryProbe,
  settleRecoveryProbe,
  type RecoveryProbe,
} from '../../repos/recoveryProbes.ts';
import { sameProviderSession } from '../../domain/sessionRef.ts';
import type { FleetRoutine } from '../../domain/types.ts';
import { fireRoutine, resolveToken, type FireOutcome, type FireTarget } from '../dispatch/fire.ts';
import { attributeArrival, NO_SHOW_QUARANTINE_MARK, reconcileConnectorBindings } from './connectorBinding.ts';
import { connectorHealth, forgetRoutingHealth } from './connectorHealth.ts';
import { connectorOwners } from './memberReconnect.ts';
import { createProbeBin, ProbeRefused } from './probe.ts';

/**
 * How long a probe waits for its session. A Routine session boots, reads its
 * prompt and checks in within a minute or two when it can authenticate at all;
 * fifteen is generous, and stays well inside the thirty-minute in-flight window
 * so a probe never reads as a live activation after it has settled.
 */
export const RECOVERY_PROBE_WINDOW_MS = 15 * 60_000;

export const RECOVERY_PROBE_CREATOR = 'connector-recovery-probe';

export class RecoveryProbeRefused extends Error {}

/** Why this Routine may not be probed, or null when it may. */
export async function recoveryIneligibility(routine: FleetRoutine): Promise<string | null> {
  if (routine.state !== 'QUARANTINED' && routine.state !== 'ENABLED') {
    return (
      `it is ${routine.state}, which is a decision somebody made (drained, given back or retired); ` +
      'a probe recovers what Brain took out of routing, not what a person switched off.'
    );
  }
  if (routine.state === 'ENABLED' && routine.connectorId) {
    return 'it is enabled and already attributed to a connector; there is nothing to recover.';
  }
  if (!routine.workerId) return 'it is bound to no worker, so no arrival could be credited to it.';
  const worker = await getWorker(routine.workerId);
  if (!worker || worker.archived || worker.disabled) return `its worker ${routine.workerId} is disabled or archived.`;
  const account = await getAccount(routine.accountId);
  if (!account) return `its account ${routine.accountId} is not registered.`;
  if (account.state === 'UNAVAILABLE' || account.state === 'RETIRED') return `its account ${account.name} is ${account.state}.`;
  if (!resolveToken(routine.tokenSecretName)) {
    return `its trigger secret ${routine.tokenSecretName} is not deployed, so it cannot be fired at all.`;
  }
  return null;
}

/**
 * Which kind of probe bin proves this surface: a Factory one names a repository
 * the worker is authorized for, anything else is research.
 */
async function probeTarget(routine: FleetRoutine): Promise<{ family: 'FACTORY' | 'RESEARCH'; repositories: string[] }> {
  const routing = routine.workerId ? await getWorkerRouting(routine.workerId) : null;
  const factory =
    routing !== null &&
    routing.families.includes('FACTORY') &&
    routing.repositories.length > 0 &&
    !routing.families.includes('RESEARCH');
  return factory ? { family: 'FACTORY', repositories: routing.repositories } : { family: 'RESEARCH', repositories: [] };
}

export type Fire = (options: { target: FireTarget }) => Promise<FireOutcome>;

/**
 * Fire one recovery probe at one Routine. Returns the probe as it stands after
 * the fire: FIRED (waiting for the session) or PROVIDER_REFUSED.
 */
export async function startRecoveryProbe(input: {
  routineRef: string;
  requestedById: string;
  authorityChannel?: string;
  fire?: Fire;
  now?: number;
}): Promise<RecoveryProbe> {
  const routine = await getRoutineByRef(input.routineRef);
  if (!routine) throw new RecoveryProbeRefused(`No Routine is registered as ${input.routineRef}.`);
  const why = await recoveryIneligibility(routine);
  if (why) throw new RecoveryProbeRefused(`${routine.name} (${routine.routineRef}) cannot be probed: ${why}`);
  const live = await liveRecoveryProbe();
  if (live) {
    throw new RecoveryProbeRefused(
      `Probe ${live.id} for ${live.routineId} is still waiting for its session (until ${live.expiresAt}). ` +
        'Probes run one at a time; read it with `connectors probe-status` and probe again once it settles.',
    );
  }
  const now = input.now ?? Date.now();
  const probe = await reserveRecoveryProbe({
    routineId: routine.id,
    accountId: routine.accountId,
    workerId: routine.workerId,
    requestedById: input.requestedById,
    authorityChannel: input.authorityChannel ?? 'SHELL',
    expiresAt: new Date(now + RECOVERY_PROBE_WINDOW_MS).toISOString(),
  });
  if (!probe) throw new RecoveryProbeRefused('Another recovery probe was started at the same moment; probes run one at a time.');

  // A DRAFT bin, so nothing can dispatch it before the fire is recorded.
  const target = await probeTarget(routine);
  let binId: string;
  try {
    binId = await createProbeBin({
      worker: { id: routine.workerId!, name: routine.name },
      repositories: target.repositories,
      routine: { id: routine.id, name: routine.name, capabilities: routine.capabilities },
      family: target.family,
      createdByType: 'SYSTEM',
      createdById: RECOVERY_PROBE_CREATOR,
      ready: false,
      maxAttempts: 1,
      priority: 9,
    });
  } catch (error) {
    const reason = error instanceof ProbeRefused ? error.message : error instanceof Error ? error.message : String(error);
    await settleRecoveryProbe(probe.id, 'FIRING', {
      to: 'PROVIDER_REFUSED',
      outcome: `No probe bin could be made, so nothing was fired: ${reason}`,
      nextAction: 'Grant the worker a project (and, for a Factory surface, a repository), then probe again.',
    });
    return (await getRecoveryProbe(probe.id))!;
  }
  await attachRecoveryBin(probe.id, binId);

  const token = resolveToken(routine.tokenSecretName)!;
  const fire = input.fire ?? ((options) => fireRoutine(options));
  const outcome = await fire({
    target: { routineId: routine.routineRef, token, baseUrl: routine.baseUrl, routineVersion: routine.routineVersion },
  });
  if (!outcome.ok || !outcome.sessionRef) {
    await retireBin({ binId, leaseGeneration: 0, operator: RECOVERY_PROBE_CREATOR, reason: 'recovery probe was not fired' });
    await settleRecoveryProbe(probe.id, 'FIRING', {
      to: 'PROVIDER_REFUSED',
      outcome: outcome.ok
        ? 'The provider accepted the fire but returned no session id, so no arrival could ever be matched to it. Nothing was attributed.'
        : `The provider refused to start a session (${outcome.kind}: ${outcome.message.slice(0, 200)}). Attribution is untouched.`,
      nextAction: outcome.ok
        ? 'Probe again; if the provider keeps returning no session, this surface cannot be proven this way.'
        : outcome.kind === 'AUTH' || outcome.kind === 'NOT_FOUND' || outcome.kind === 'PAUSED'
          ? `Fix the Routine’s trigger (${routine.tokenSecretName}) or unpause it in Claude, then probe again.`
          : 'A transient provider condition; probe again later.',
    });
    return (await getRecoveryProbe(probe.id))!;
  }

  const bin = await getBin(binId);
  await recordRecoveryDispatch({
    binId,
    projectId: bin!.projectId,
    routineId: routine.id,
    routineRef: routine.routineRef,
    accountId: routine.accountId,
    sessionRef: outcome.sessionRef,
    probeId: probe.id,
  });
  await markRecoveryFired(probe.id, outcome.sessionRef);
  await markBinReady(binId);
  return (await getRecoveryProbe(probe.id))!;
}

/** A quarantine this probe's fire and arrival disprove, and so may lift. */
export function liftableQuarantine(reason: string | null): boolean {
  if (!reason) return false;
  return (
    reason.includes(NO_SHOW_QUARANTINE_MARK) ||
    reason.includes('consecutive fire failures') ||
    reason.startsWith('The provider refused a fire with')
  );
}

/** The one human action a connector needing consent requires, prepared. */
async function reconnectAction(connectorId: string, routine: FleetRoutine): Promise<string> {
  const connector = await getConnector(connectorId);
  const owners = (await connectorOwners()).get(connectorId);
  if (owners && owners.size === 1) {
    const [userId] = [...owners.keys()];
    const user = userId ? await getUser(userId) : null;
    return (
      `Self-service: ${user?.displayName ?? userId} (${userId}) reconnects Brain${connector ? ` at ${connector.resource}` : ''} ` +
      'from Claude while signed in to this Brain. The consent screen recognises this connector and offers only its worker; ' +
      'the new client attaches to the same connector and the quarantine lifts by itself.'
    );
  }
  return (
    `One bound reconnect: \`connectors reconnect ${connectorId} <member>\`, naming the person whose Claude account ` +
    `${routine.accountId} is (no row records that, so Brain does not guess it). They reconnect from Claude while signed ` +
    'in; after that consent, later reconnects are self-service and the quarantine lifts by itself.'
  );
}

interface Arrival {
  workerId: string | null;
  credentialId: string | null;
  sessionRef: string | null;
  at: string;
}

/** The session the probe's fire started, if it has taken the probe bin. */
async function arrivalFor(probe: RecoveryProbe): Promise<Arrival | null> {
  if (!probe.binId || !probe.providerSession) return null;
  for (const event of await listBinEvents(probe.binId)) {
    if (event.eventType !== 'BIN_ASSIGNED' && event.eventType !== 'BIN_TAKEOVER') continue;
    if (!sameProviderSession(event.sessionRef, probe.providerSession)) continue;
    const credentialId = typeof event.measures?.['credentialId'] === 'string' ? (event.measures['credentialId'] as string) : null;
    return { workerId: event.workerId, credentialId, sessionRef: event.sessionRef, at: event.at };
  }
  return null;
}

/** Settle one probe, if it can be settled now. Returns whether it moved. */
export async function settleRecoveryProbeNow(probe: RecoveryProbe, now = Date.now()): Promise<boolean> {
  const routine = await getRoutine(probe.routineId);
  if (!routine) {
    return settleRecoveryProbe(probe.id, probe.state, { to: 'AMBIGUOUS', outcome: 'The Routine no longer exists.' });
  }
  const expired = Date.parse(probe.expiresAt) <= now;

  if (probe.state === 'FIRING') {
    if (!expired) return false;
    // The process stopped between reserving and recording the fire. Whether a
    // session was started is unknown, and unknown is not evidence.
    const moved = await settleRecoveryProbe(probe.id, 'FIRING', {
      to: 'AMBIGUOUS',
      outcome: 'The fire’s outcome was never recorded (the process stopped mid-fire). Nothing was attributed.',
      nextAction: `Probe ${routine.routineRef} again.`,
    });
    await retireProbeBin(probe, 'recovery probe abandoned mid-fire');
    return moved;
  }
  if (probe.state !== 'FIRED') return false;

  const arrival = await arrivalFor(probe);
  if (arrival) {
    const clientId = arrival.credentialId ? ((await getToken(arrival.credentialId))?.clientId ?? null) : null;
    await recordRecoveryArrival(probe.id, { credentialId: arrival.credentialId, clientId, arrivedAt: arrival.at });
    if (!arrival.credentialId || !arrival.workerId) {
      return settleRecoveryProbe(probe.id, 'FIRED', {
        to: 'AMBIGUOUS',
        outcome: 'The fired session arrived, but the assignment recorded no credential, so it names no connector.',
        nextAction: `Probe ${routine.routineRef} again.`,
      });
    }
    const attribution = await attributeArrival({
      routineId: routine.id,
      workerId: arrival.workerId,
      credentialId: arrival.credentialId,
      proven: true,
    });
    if (attribution.outcome === 'NOT_EVIDENCE' || attribution.outcome === 'CONFLICT' || !attribution.connectorId) {
      return settleRecoveryProbe(probe.id, 'FIRED', {
        to: 'AMBIGUOUS',
        clientId: attribution.clientId,
        outcome: `The fired session ${arrival.sessionRef} arrived, but nothing was attached: ${attribution.reason ?? 'no connector'}.`,
        nextAction:
          attribution.outcome === 'CONFLICT'
            ? 'An operator reads `connectors show` and decides which attribution is wrong; Brain will not overwrite one.'
            : 'Reconnect this surface’s Claude connector over OAuth, then probe again.',
      });
    }
    const health = await connectorHealth(attribution.connectorId, now);
    if (health?.state === 'HEALTHY') {
      let lifted = 'It was not quarantined.';
      if (routine.state === 'QUARANTINED') {
        if (liftableQuarantine(routine.stateReason)) {
          const moved = await setRoutineState({
            routineId: routine.id,
            from: 'QUARANTINED',
            to: 'ENABLED',
            reason:
              `Recovery probe ${probe.id}: fired, arrived as ${arrival.sessionRef}, authenticated through connector ` +
              `${attribution.connectorId} (client ${attribution.clientId}), which is HEALTHY. The quarantine was Brain's ` +
              'and this fire disproved it. Re-enabled automatically; a surface that stops answering is quarantined again.',
          });
          lifted = moved ? 'Its quarantine was lifted automatically.' : 'Its state moved concurrently; nothing was overwritten.';
          forgetRoutingHealth();
        } else {
          lifted = `It stays quarantined: that quarantine was not Brain’s to lift (${(routine.stateReason ?? '').slice(0, 160)}).`;
        }
      }
      let siblings = '';
      try {
        const reconciled = await reconcileConnectorBindings();
        if (reconciled.routinesBound > 0) siblings = ` ${reconciled.routinesBound} sibling Routine(s) were bound from the same evidence.`;
      } catch {
        // Sibling binding is the tick's to retry.
      }
      const settled = await settleRecoveryProbe(probe.id, 'FIRED', {
        to: 'HEALTHY',
        connectorId: attribution.connectorId,
        clientId: attribution.clientId,
        health: `${health.state} ${health.reason}`,
        outcome: `Proven: session ${arrival.sessionRef} authenticated as client ${attribution.clientId} -> connector ${attribution.connectorId}. ${lifted}${siblings}`,
        nextAction: null,
      });
      return settled;
    }
    const human = health?.humanActionRequired ?? false;
    return settleRecoveryProbe(probe.id, 'FIRED', {
      to: human ? 'REAUTH_REQUIRED' : 'AMBIGUOUS',
      connectorId: attribution.connectorId,
      clientId: attribution.clientId,
      health: health ? `${health.state} ${health.reason}` : null,
      outcome: `Attributed: session ${arrival.sessionRef} -> client ${attribution.clientId} -> connector ${attribution.connectorId}, health ${health?.state ?? 'unknown'}. ${health?.detail ?? ''}`.trim(),
      nextAction: human ? await reconnectAction(attribution.connectorId, routine) : 'Probe again once the connector has been used.',
    });
  }

  if (!expired) return false;

  // Nothing arrived. If the Routine's connector is already known to need
  // consent, that is the answer; otherwise nothing is attributed and nothing
  // is charged — the silence is reported as exactly what it is.
  if (routine.connectorId) {
    const health = await connectorHealth(routine.connectorId, now);
    if (health?.humanActionRequired) {
      const moved = await settleRecoveryProbe(probe.id, 'FIRED', {
        to: 'REAUTH_REQUIRED',
        connectorId: routine.connectorId,
        health: `${health.state} ${health.reason}`,
        outcome:
          `The provider started ${probe.providerSession}; nothing reached Brain, and connector ${routine.connectorId} ` +
          `is proven to need consent: ${health.detail}`,
        nextAction: await reconnectAction(routine.connectorId, routine),
      });
      await retireProbeBin(probe, 'recovery probe: connector needs consent');
      return moved;
    }
  }
  const moved = await settleRecoveryProbe(probe.id, 'FIRED', {
    to: 'NO_MCP',
    outcome:
      `The provider started session ${probe.providerSession} at ${probe.firedAt}, and nothing it started reached Brain ` +
      `within ${RECOVERY_PROBE_WINDOW_MS / 60_000} minutes. Nothing was attributed and nothing was charged to the surface.`,
    nextAction:
      'Either the Brain connector in that Claude account cannot authenticate, or the Routine never calls Brain. ' +
      'Have the account holder reconnect Brain in Claude (consent through an invitation if they are not an administrator), ' +
      `then probe ${routine.routineRef} again: the probe attaches whichever client its session arrives with.`,
  });
  await retireProbeBin(probe, 'recovery probe: no session arrived');
  return moved;
}

async function retireProbeBin(probe: RecoveryProbe, reason: string): Promise<void> {
  if (!probe.binId) return;
  const bin = await getBin(probe.binId);
  if (!bin || ['COMPLETE', 'CANCELLED', 'FAILED'].includes(bin.state)) return;
  await retireBin({ binId: bin.id, leaseGeneration: bin.leaseGeneration, operator: RECOVERY_PROBE_CREATOR, reason });
}

/**
 * Settle every live probe that can be settled, and retire probe bins nobody is
 * still working on. Runs on the dispatch tick and from `connectors probe`.
 */
export async function settleRecoveryProbes(now = Date.now()): Promise<{ settled: string[] }> {
  const settled: string[] = [];
  for (const probe of await listRecoveryProbes(['FIRING', 'FIRED'])) {
    if (await settleRecoveryProbeNow(probe, now)) settled.push(probe.id);
  }
  // A settled probe whose bin outlived its window: the session that held it is
  // gone (or never came), and with one attempt the bin can go nowhere else.
  for (const probe of await listRecoveryProbes(['HEALTHY', 'REAUTH_REQUIRED', 'AMBIGUOUS', 'NO_MCP'])) {
    const closes = Date.parse(probe.expiresAt);
    if (closes > now || closes < now - 24 * 60 * 60_000) continue;
    await retireProbeBin(probe, 'recovery probe window closed');
  }
  return { settled };
}
