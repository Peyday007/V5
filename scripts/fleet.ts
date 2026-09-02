/**
 * `sh scripts/fleet.sh <command>` — the Step 11 operator surface.
 *
 * Step 12 owns the UI. This is the backend an operator needs to configure,
 * test and prove a fleet, and it follows the rule Step 10 paid for twice:
 * **a command that changes nothing must not print success.** `research-ready`
 * called `markBinReady` on a parked bin, changed no rows, and printed
 * `STEP10: OK` under the line the workflow greps — costing a full activation
 * window of waiting on a bin that had never moved. Every mutating command below
 * reports whether a row actually changed and exits non-zero when none did.
 *
 * No credential is read, printed or accepted here. Registration takes the
 * *name* of a deployment secret; the value stays in the deployment.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  credentialDigest,
  currentPolicy,
  effectiveTarget,
  getAccountByName,
  getRoutineByRef,
  listAccounts,
  listRoutines,
  policyHistory,
  setAccountState,
  setPolicy,
  setRoutineState,
} from '../server/repos/fleet.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import { resolveToken } from '../server/services/dispatch/fire.ts';
import { proposeScale, shouldQuarantine } from '../server/services/dispatch/scaler.ts';
import { referenceFleet, REFERENCE_SIZES, simulate } from '../server/services/dispatch/simulate.ts';
import { activationTrace, workloadProfile } from '../server/services/dispatch/profiles.ts';
import { listBins } from '../server/repos/bins.ts';
import { FLEET_STATES } from '../server/domain/types.ts';
import type { FleetState } from '../server/domain/types.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'show';
function arg(i: number): string | null {
  return argv[i + 1] ?? null;
}
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function option(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

const ACTOR = option('actor') ?? 'operator:fleet-cli';

function ok(line: string): void {
  console.log(`FLEET: OK ${line}`);
}
function refuse(line: string): void {
  console.log(`FLEET REFUSED: ${line}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();

  /* ---------------------------------------------------------------------- */
  /* Registration                                                            */
  /* ---------------------------------------------------------------------- */

  if (command === 'register-account') {
    const name = option('name');
    if (!name) return refuse('pass --name.');
    const existing = await getAccountByName(name);
    if (existing) {
      return refuse(`an account named "${name}" already exists (${existing.id}). Nothing changed.`);
    }
    if (flag('dry-run')) return ok(`dry-run register-account name=${name} (nothing written)`);
    const account = await createAccount({
      name,
      planLabel: option('plan'),
      declaredPlanPower: option('power'),
    });
    return ok(`register-account ${account.id} name=${account.name} plan=${account.planLabel ?? '—'}`);
  }

  if (command === 'register-routine') {
    const accountName = option('account');
    const ref = option('ref');
    const secret = option('secret');
    const name = option('name') ?? ref;
    if (!accountName || !ref || !secret) {
      return refuse('pass --account <name> --ref <trig_…> --secret <ENV_VAR_NAME>.');
    }
    const account = await getAccountByName(accountName);
    if (!account) return refuse(`no account named "${accountName}". Register it first.`);
    const clash = await getRoutineByRef(ref);
    if (clash) return refuse(`${ref} is already registered as ${clash.id}. Nothing changed.`);

    /*
     * The secret is read only to prove it is there and to take its digest.
     * The value is never stored, printed or returned — the digest is what lets
     * a later diagnostic say "the secret in this deployment is the one this row
     * was registered against" without either being recoverable.
     */
    const value = resolveToken(secret);
    if (!value) {
      return refuse(
        `the deployment has no secret named ${secret}. Set it first; Brain stores only the name ` +
          'and a digest, never the value.',
      );
    }
    if (flag('dry-run')) return ok(`dry-run register-routine ref=${ref} secret=${secret} (nothing written)`);
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: ref,
      name: name!,
      tokenSecretName: secret,
      tokenDigest: credentialDigest(value),
      routineVersion: option('version'),
      baseUrl: option('base-url'),
      capabilities: (option('capabilities') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    return ok(
      `register-routine ${routine.id} ref=${routine.routineRef} account=${account.name} ` +
        `secret=${secret} digest=${routine.tokenDigest?.slice(0, 12)}…`,
    );
  }

  if (command === 'bind-worker') {
    const ref = option('ref');
    const workerId = option('worker');
    if (!ref || !workerId) return refuse('pass --ref <trig_…> --worker <wkr_…>.');
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine registered as ${ref}.`);
    const changed = await bindRoutineWorker(routine.id, workerId);
    if (!changed) {
      return refuse(
        `${ref} is already bound to a different worker (${routine.workerId}). A Routine is not ` +
          're-pointed silently; retire it and register the new surface.',
      );
    }
    return ok(`bind-worker ${ref} -> ${workerId}`);
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  if (command === 'set-state') {
    // Case-insensitive, and an unrecognised kind is refused by name.
    //
    // It used to compare `kind === 'account'` and let everything else fall
    // through to the Routine branch, so `--kind ACCOUNT personal` reported
    // "no Routine registered as personal" — an answer that is true, unhelpful,
    // and points at the wrong half of the command.
    const kind = (option('kind') ?? '').toLowerCase();
    const ref = option('ref');
    const to = option('to')?.toUpperCase() as FleetState | null;
    const reason = (option('reason') ?? '').replace(/_/g, ' ');
    if (!kind || !ref || !to || !reason) {
      return refuse('pass --kind account|routine --ref <name|trig_…> --to <STATE> --reason <text>.');
    }
    if (kind !== 'account' && kind !== 'routine') {
      return refuse(`--kind must be account or routine, not "${kind}".`);
    }
    if (!FLEET_STATES.includes(to as FleetState)) {
      return refuse(`--to must be one of ${FLEET_STATES.join(', ')}.`);
    }
    if (kind === 'account') {
      const account = await getAccountByName(ref);
      if (!account) return refuse(`no account named "${ref}".`);
      const changed = await setAccountState({ accountId: account.id, from: account.state, to, reason });
      if (!changed) return refuse(`${ref} moved between the read and the write. Read it again.`);
      return ok(`set-state account ${ref} ${account.state} -> ${to}`);
    }
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine registered as ${ref}.`);
    const changed = await setRoutineState({ routineId: routine.id, from: routine.state, to, reason });
    if (!changed) return refuse(`${ref} moved between the read and the write. Read it again.`);
    return ok(`set-state routine ${ref} ${routine.state} -> ${to}`);
  }

  /* ---------------------------------------------------------------------- */
  /* Policy                                                                  */
  /* ---------------------------------------------------------------------- */

  if (command === 'set-target') {
    const scope = (option('scope') ?? 'FLEET').toUpperCase();
    const ref = option('ref');
    const target = Number(option('target') ?? 'NaN');
    const reason = (option('reason') ?? '').replace(/_/g, ' ');
    if (!Number.isInteger(target) || target < 0) return refuse('pass --target <non-negative integer>.');
    if (!reason) return refuse('pass --reason; a policy change with no reason answers nothing later.');

    let scopeId: string | null = null;
    if (scope === 'ACCOUNT') {
      const account = ref ? await getAccountByName(ref) : null;
      if (!account) return refuse('pass --ref <account name> for an ACCOUNT target.');
      scopeId = account.id;
    } else if (scope === 'ROUTINE') {
      const routine = ref ? await getRoutineByRef(ref) : null;
      if (!routine) return refuse('pass --ref <trig_…> for a ROUTINE target.');
      scopeId = routine.id;
    } else if (scope !== 'FLEET') {
      return refuse('--scope must be FLEET, ACCOUNT or ROUTINE.');
    }

    const before = await currentPolicy(scope as 'FLEET', scopeId);
    if (flag('dry-run')) {
      return ok(`dry-run set-target ${scope} ${before?.target ?? '—'} -> ${target} (nothing written)`);
    }
    const policy = await setPolicy({
      scope: scope as 'FLEET',
      scopeId,
      target,
      autoScale: option('auto-scale') === 'on' ? true : before?.autoScale ?? false,
      autoScaleCeiling: option('ceiling') ? Number(option('ceiling')) : before?.autoScaleCeiling ?? null,
      minReserve: before?.minReserve ?? 0,
      paused: option('paused') === 'on' ? true : option('paused') === 'off' ? false : before?.paused ?? false,
      actor: ACTOR,
      reason,
    });
    return ok(
      `set-target ${scope}${scopeId ? ` ${ref}` : ''} ${before?.target ?? '—'} -> ${policy.target} ` +
        `version=${policy.version} actor=${policy.actor}`,
    );
  }

  if (command === 'boost') {
    const minutes = Number(option('minutes') ?? '30');
    const target = Number(option('target') ?? 'NaN');
    const reason = (option('reason') ?? '').replace(/_/g, ' ');
    if (!Number.isInteger(target) || target <= 0) return refuse('pass --target <positive integer>.');
    if (!reason) return refuse('pass --reason.');
    const before = await currentPolicy('FLEET', null);
    const until = new Date(Date.now() + Math.max(1, minutes) * 60_000).toISOString();
    const policy = await setPolicy({
      scope: 'FLEET',
      target: before?.target ?? target,
      autoScale: before?.autoScale ?? false,
      autoScaleCeiling: before?.autoScaleCeiling ?? null,
      boostTarget: target,
      boostUntil: until,
      boostReason: reason,
      actor: ACTOR,
      reason: `Boost to ${target} until ${until}: ${reason}`,
    });
    return ok(`boost target=${target} until=${until} version=${policy.version} base=${policy.target}`);
  }

  if (command === 'pause' || command === 'resume') {
    const reason = (option('reason') ?? '').replace(/_/g, ' ') || `${command} by ${ACTOR}`;
    const before = await currentPolicy('FLEET', null);
    const policy = await setPolicy({
      scope: 'FLEET',
      target: before?.target ?? 0,
      autoScale: before?.autoScale ?? false,
      autoScaleCeiling: before?.autoScaleCeiling ?? null,
      paused: command === 'pause',
      actor: ACTOR,
      reason,
    });
    return ok(`${command} paused=${policy.paused} version=${policy.version}`);
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  if (command === 'show') {
    const now = new Date().toISOString();
    const accounts = await listAccounts();
    const routines = await listRoutines();
    const snapshot = await fleetSnapshot();
    const fleetPolicy = await currentPolicy('FLEET', null);

    console.log('FLEET');
    console.log(`  accounts    ${accounts.length}`);
    console.log(`  routines    ${routines.length}`);
    console.log(
      `  target      ${fleetPolicy ? effectiveTarget(fleetPolicy, now).target : 'not set'}` +
        (fleetPolicy?.boostUntil && fleetPolicy.boostUntil > now ? ` (boosted until ${fleetPolicy.boostUntil})` : ''),
    );
    console.log(`  in flight   ${snapshot.fleetInFlight}`);
    console.log(`  candidates  ${snapshot.candidates.length} routable now`);
    if (snapshot.missingSecrets.length > 0) {
      for (const miss of snapshot.missingSecrets) {
        console.log(`  MISSING SECRET  ${miss.routineId} expects ${miss.secretName}`);
      }
    }
    console.log('');
    for (const account of accounts) {
      const mine = routines.filter((r) => r.accountId === account.id);
      const policy = await currentPolicy('ACCOUNT', account.id);
      console.log(
        `  ${account.name}  ${account.state}  declared=${account.declaredPlanPower ?? '—'} ` +
          `plan=${account.planLabel ?? '—'} target=${policy?.target ?? '—'}` +
          (account.retryAt ? `  retry_at=${account.retryAt}` : ''),
      );
      for (const routine of mine) {
        const inFlight = snapshot.candidates.find((c) => c.routine.id === routine.id);
        console.log(
          `      ${routine.name}  ${routine.state}  ref=${routine.routineRef}  ` +
            `secret=${routine.tokenSecretName}  fires=${routine.totalFires} ` +
            `refusals=${routine.totalRefusals} no-shows=${routine.consecutiveNoShows}` +
            (inFlight ? `  in-flight=${inFlight.routineInFlight}` : '  (not routable)') +
            (routine.retryAt ? `  retry_at=${routine.retryAt}` : ''),
        );
      }
    }
    // Declared power is printed beside measured throughput and never multiplied
    // into a capacity number: the whole point of the distinction is that nobody
    // has measured what a "20x" account will actually complete per window.
    console.log('');
    console.log('  Declared plan power is what was bought. It is not a measured throughput and');
    console.log('  is never used as one.');
    return ok(`show accounts=${accounts.length} routines=${routines.length}`);
  }

  if (command === 'policy-history') {
    const scope = (option('scope') ?? 'FLEET').toUpperCase() as 'FLEET';
    for (const entry of await policyHistory(scope, null)) {
      console.log(
        `  v${entry.version}  target=${entry.target} auto=${entry.autoScale} paused=${entry.paused} ` +
          `boost=${entry.boostTarget ?? '—'}${entry.boostUntil ? ` until ${entry.boostUntil}` : ''}  ` +
          `${entry.actor}: ${entry.reason}`,
      );
    }
    return ok('policy-history');
  }

  if (command === 'explain-route') {
    // Positionally when typed, `--ref` when driven from the workflow, which
    // passes every value as a named flag.
    const binId = option('ref') ?? arg(0);
    if (!binId) return refuse('pass a bin id.');
    const bins = await listBins({ limit: 500 });
    const bin = bins.find((b) => b.id === binId);
    if (!bin) return refuse(`no bin ${binId}.`);
    const snapshot = await fleetSnapshot();
    const decision = routeBin({
      bin,
      candidates: snapshot.candidates,
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: snapshot.fleetInFlight,
      now: new Date().toISOString(),
    });
    console.log(`  bin        ${bin.id}  ${bin.state}  priority ${bin.priority}`);
    for (const entry of decision.considered) console.log(`  considered ${entry.routineId}  ${entry.verdict}`);
    console.log(`  decision   ${decision.ok ? 'ROUTED' : decision.refusal}`);
    console.log(`  reason     ${decision.reason}`);
    return ok(`explain-route ${binId} ${decision.ok ? 'ROUTED' : decision.refusal}`);
  }

  if (command === 'scale-advice') {
    const snapshot = await fleetSnapshot();
    const ready = (await listBins({ states: ['READY'], limit: 500 })).length;
    const proposal = proposeScale({
      policy: snapshot.fleetPolicy,
      signals: {
        queueDepth: ready,
        inFlight: snapshot.fleetInFlight,
        recentRefusals: 0,
        recentNoShows: 0,
        recentCompletions: 0,
      },
      now: new Date().toISOString(),
    });
    console.log(`  ${proposal.direction}  ${proposal.from} -> ${proposal.to}`);
    console.log(`  ${proposal.reason}`);
    console.log(`  automatic=${proposal.automatic}`);
    for (const routine of await listRoutines()) {
      const verdict = shouldQuarantine(routine);
      if (verdict.quarantine) console.log(`  QUARANTINE CANDIDATE ${routine.routineRef}: ${verdict.reason}`);
    }
    return ok(`scale-advice ${proposal.direction} ${proposal.from}->${proposal.to}`);
  }

  if (command === 'profile') {
    const profile = await workloadProfile({
      projectId: option('project'),
      orchestrationId: option('orchestration'),
      workloadClass: option('class'),
    });
    console.log(JSON.stringify(profile, null, 2));
    return ok(`profile bottleneck=${profile.bottleneck} evidence=${profile.evidence}`);
  }

  if (command === 'simulate') {
    const trace = await activationTrace();
    const queue = Number(option('queue') ?? '50');
    const horizon = Number(option('horizon-minutes') ?? '60') * 60_000;
    console.log(`  trace      ${trace.length} measured activation(s)`);
    console.log('  NOTE       every line below is SIMULATED, never observed throughput.');
    for (const size of REFERENCE_SIZES) {
      const result = simulate(referenceFleet(size, queue, horizon), trace);
      console.log(
        `  SIMULATED  ${String(size).padStart(2)} workers  completed=${result.binsCompleted}/` +
          `${queue} activations=${result.activations} wall=${Math.round(result.wallClockMs / 1000)}s ` +
          `trace=${result.traceId}`,
      );
    }
    // The live fleet, from the registry rather than from a reference shape.
    const accounts = await listAccounts();
    const routines = await listRoutines();
    if (accounts.length > 0) {
      const live = simulate(
        {
          label: 'live fleet',
          accounts: accounts.map((a) => ({
            name: a.name,
            routines: routines.filter((r) => r.accountId === a.id).length,
            concurrency: null,
            firesPerHour: null,
            unavailable: a.state !== 'ENABLED',
          })),
          queueDepth: queue,
          fleetTarget: null,
          horizonMs: horizon,
        },
        trace,
      );
      console.log(
        `  SIMULATED  live fleet   completed=${live.binsCompleted}/${queue} ` +
          `activations=${live.activations} trace=${live.traceId}`,
      );
      for (const unknown of live.unknowns) console.log(`             unknown: ${unknown}`);
    }
    return ok(`simulate trace=${trace.length}`);
  }

  refuse(
    `unknown command "${command}". Try: show, register-account, register-routine, bind-worker, ` +
      'set-state, set-target, boost, pause, resume, policy-history, explain-route, scale-advice, ' +
      'profile, simulate.',
  );
}

main()
  .catch((error) => {
    console.error('FLEET: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
