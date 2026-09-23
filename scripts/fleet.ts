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
  unansweredFiresByRoutine,
  sessionsForRoutine,
  listAccounts,
  listRoutines,
  renameAccount,
  renameRoutine,
  policyHistory,
  repointRoutineWorker,
  routineRegistrationCollision,
  setRoutineCapabilities,
  setRoutineSecret,
  setAccountState,
  setPolicy,
  setRoutineState,
} from '../server/repos/fleet.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import { proveSurface } from '../server/services/dispatch/surfaceProof.ts';
import { resolveToken } from '../server/services/dispatch/fire.ts';
import {
  decidedPairs,
  digestOfSecret,
  planPairs,
  recordPairAttempt,
  seedFromRows,
  stopsTrigger,
  tryPair,
  type DecidedPair,
} from '../server/services/dispatch/secretReconcile.ts';
import {
  NO_SHOW_QUARANTINE_THRESHOLD,
  proposeScale,
  shouldQuarantine,
} from '../server/services/dispatch/scaler.ts';
import { referenceFleet, REFERENCE_SIZES, simulate } from '../server/services/dispatch/simulate.ts';
import { activationTrace, workloadProfile } from '../server/services/dispatch/profiles.ts';
import { getBin, listBins, listDispatchesForBin } from '../server/repos/bins.ts';
import { getWorker, getWorkerRouting } from '../server/repos/identity.ts';
import { resolveWorkerRef } from '../server/services/identity/workerRef.ts';
import { listTokensForWorker } from '../server/repos/oauth.ts';
import { FLEET_STATES } from '../server/domain/types.ts';
import type { BinState, FleetState } from '../server/domain/types.ts';
import { workerIdentity } from '../server/services/identity/authenticate.ts';
import {
  AMBIGUATES,
  auditFleetAttribution,
  FINDING_DETAIL,
  traceWorkerSession,
} from '../server/services/identity/attribution.ts';

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

/**
 * A human name, which may have spaces in it.
 *
 * The dispatch workflow splits its arguments on whitespace, so a name with a
 * space cannot arrive as one argument at all — `--account Brain Research A`
 * reaches here as three. `rename` has always written those as underscores and
 * turned them back; `register-routine` did not, which made an account whose
 * name has a space in it unreachable from the one surface an operator has.
 * Every account in this fleet but two is named that way, so the convention was
 * right and it was applied in one of the two places that needed it.
 *
 * It is deliberately only for the options that carry a *name*. A `trig_…` ref,
 * a worker id and a secret name never contain a space, and folding underscores
 * in those would corrupt values that legitimately have them.
 */
function nameOption(name: string): string | null {
  return option(name)?.replace(/_/g, ' ') ?? null;
}

/**
 * An account named by `--ref`, where the same flag also carries `trig_…` ids.
 *
 * A trigger id has underscores in it, so folding `--ref` the way `nameOption`
 * folds a name would corrupt every one of them. The value is therefore tried
 * exactly as typed first and only then as a name with its underscores turned
 * back into spaces — a raw match always wins, so no account that was reachable
 * before becomes unreachable now.
 *
 * Without it an account whose name has a space in it could be created and then
 * never renamed, quarantined, re-enabled or given a target through the one
 * surface an operator has. §24's sentence at a command line: an escalation
 * whose remedy cannot be typed is not a remedy.
 */
async function accountByRef(ref: string | null): Promise<Awaited<ReturnType<typeof getAccountByName>>> {
  if (!ref) return null;
  return (await getAccountByName(ref)) ?? (await getAccountByName(ref.replace(/_/g, ' ')));
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
    const name = nameOption('name');
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
    const accountName = nameOption('account');
    const ref = option('ref');
    const secret = option('secret');
    const name = nameOption('name') ?? ref;
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
    /*
     * One trigger token per Routine, and the digest is what actually says so.
     *
     * `UNIQUE (routine_ref)` already stops the same trigger being registered
     * twice. It says nothing about the *token*, and a pool is exactly where that
     * gap bites: the intended arrangement is one Claude account, one connector,
     * one Routine and one deployment secret each, and the easy mistake is to
     * point the second Routine at the first one's secret — or at a new secret
     * name holding the same pasted value.
     *
     * Both are refused, and the digest check is the one that matters. A name
     * collision is visible to anybody reading `fleet show`; two different names
     * holding one token are indistinguishable there, and the fleet would look
     * like two surfaces while being one trigger fired twice — over-firing one
     * account while reporting headroom on another, which is `declared_plan_power`
     * arithmetic-on-a-fiction in a new place.
     *
     * The digest is already stored at registration (`token_digest`), so this
     * costs one read and reveals nothing: a digest is not recoverable to a value,
     * and the refusal names the Routine rather than either secret's contents.
     */
    const digest = credentialDigest(value);
    const collision = routineRegistrationCollision(await listRoutines(), {
      tokenSecretName: secret,
      tokenDigest: digest,
    });
    if (collision) return refuse(collision);
    if (flag('dry-run')) return ok(`dry-run register-routine ref=${ref} secret=${secret} (nothing written)`);
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: ref,
      name: name!,
      tokenSecretName: secret,
      tokenDigest: digest,
      routineVersion: option('version'),
      baseUrl: option('base-url'),
      capabilities: (option('capabilities') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    return ok(
      `register-routine ${routine.id} ref=${routine.routineRef} account=${account.name} ` +
        `secret=${secret} digest=${routine.tokenDigest?.slice(0, 12)}…`,
    );
  }

  /*
   * What a Routine may be given, corrected without SQL.
   *
   * `register-routine` takes a capability list and there was no way to change it
   * afterwards, which made a row that had become wrong permanent — and the only
   * remedies left were manual SQL, which invariant 2 forbids, or retiring a
   * healthy surface. A capability is an operational fact that changes.
   *
   * It declares nothing about access. Brain holds no credential for anything a
   * capability names; what this changes is which bins Brain will route here.
   */
  if (command === 'set-capabilities') {
    const ref = option('ref');
    const list = option('capabilities');
    if (!ref || list === undefined || list === null) {
      return refuse('pass --ref <trig_…> --capabilities <comma,separated> (empty clears them).');
    }
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine registered as ${ref}.`);
    const capabilities = list.split(',').map((tag) => tag.trim()).filter(Boolean);
    if (flag('dry-run')) {
      return ok(
        `dry-run set-capabilities ${ref} [${routine.capabilities.join(',')}] -> ` +
          `[${capabilities.join(',')}] (nothing written)`,
      );
    }
    const updated = await setRoutineCapabilities({
      routineId: routine.id,
      capabilities,
      actor: 'fleet-cli',
      reason: option('reason') ?? 'operator set the capabilities this surface may be given',
    });
    if (!updated) return refuse(`${ref} could not be updated.`);
    return ok(
      `set-capabilities ${ref} [${routine.capabilities.join(',')}] -> [${updated.capabilities.join(',')}]`,
    );
  }

  /*
   * Point a Routine at a different deployment secret.
   *
   * The companion to `set-capabilities`, and for the same reason: a row that is
   * wrong in an ordinary way, with no remedy but manual SQL — which invariant 2
   * forbids — or retiring a healthy surface. Here the wrongness is a trigger and
   * a bearer paired by hand and paired wrongly, which a provider `AUTH 401`
   * reports and does not diagnose.
   *
   * It moves no deployment variable and reads no value back: the named secret is
   * resolved once to prove it exists and to take its digest, exactly as
   * `register-routine` does. The digest is what keeps `routineRegistrationCollision`
   * true of the row afterwards, so "two names, one token" stays visible.
   */
  if (command === 'set-secret') {
    const ref = option('ref');
    const secret = option('secret');
    const reason = nameOption('reason') ?? option('reason');
    if (!ref || !secret) return refuse('pass --ref <trig_…> --secret <ENV_VAR_NAME>.');
    if (!reason) return refuse('pass --reason: a row that changed with no recorded why answers nothing later.');
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine registered with ref ${ref}.`);
    if (routine.tokenSecretName === secret) {
      return ok(`set-secret ${routine.id} already names ${secret}. Nothing changed.`);
    }
    const digest = digestOfSecret(secret);
    if (!digest) {
      return refuse(
        `the deployment has no secret named ${secret}. Set it first; Brain stores only the name ` +
          'and a digest, never the value.',
      );
    }
    if (flag('dry-run')) {
      return ok(`dry-run set-secret ${routine.id} ${routine.tokenSecretName} -> ${secret} (nothing written)`);
    }
    const after = await setRoutineSecret({
      routineId: routine.id,
      tokenSecretName: secret,
      tokenDigest: digest,
      actor: ACTOR,
      reason,
    });
    if (!after) return refuse(`no Routine ${routine.id}.`);
    return ok(
      `set-secret ${after.id} ${routine.tokenSecretName} -> ${after.tokenSecretName} ` +
        `digest=${after.tokenDigest?.slice(0, 12)}… state=${after.state}`,
    );
  }

  /*
   * Whether a named deployment variable is set, and nothing else about it.
   *
   * `register-routine` and `set-secret` both refuse when the named secret is
   * absent, which makes them a presence check that writes a row on the way
   * past — no use at all for the question an operator actually asks first:
   * *are the four secrets somebody says they created really in this
   * deployment?* Getting that wrong sends a person back to a browser to redo
   * work that was already done, or has them hunt a typo in a variable name by
   * watching fires fail.
   *
   * It answers `present` or `absent` and never a length, a prefix, a digest or
   * a shape. A boolean about a secret is not a secret; anything that narrowed
   * the value would be.
   */
  if (command === 'check-secret') {
    const names = (option('secret') ?? '').split(',').map((one) => one.trim()).filter(Boolean);
    if (names.length === 0) return refuse('pass --secret <ENV_VAR_NAME>[,<ENV_VAR_NAME>…].');
    let present = 0;
    for (const name of names) {
      const there = resolveToken(name) !== null;
      if (there) present += 1;
      console.log(`  ${there ? 'present' : 'absent '}  ${name}`);
    }
    return ok(`check-secret present=${present} absent=${names.length - present}`);
  }

  /*
   * Which of this account's bearers opens which of its triggers.
   *
   * See `services/dispatch/secretReconcile.ts` for why four refusals across four
   * diagonal pairings prove four cells of sixteen and nothing else. This walks
   * the rest of the square, once per cell for ever, locks a match out of the
   * space on both axes, and repoints the row it proved.
   *
   * It re-enables nothing. A quarantine is a health state a person answers with
   * `fleet set-state`, and a diagnostic that lifted one because it liked its own
   * result would be grading its own exam.
   */
  if (command === 'reconcile-secrets') {
    const accountName = nameOption('account');
    if (!accountName) return refuse('pass --account <name>.');
    const account = await accountByRef(option('account')) ?? (await getAccountByName(accountName));
    if (!account) return refuse(`no account named "${accountName}".`);

    const routines = (await listRoutines())
      .filter((one) => one.accountId === account.id)
      .filter((one) => one.state !== 'RETIRED');
    if (routines.length === 0) return refuse(`account "${account.name}" has no live Routines.`);

    /*
     * The durable log first, then the rows — and anything the rows say that the
     * log does not gets written down before a single repoint happens. After a
     * repoint a row names a different secret and its recorded reason is about a
     * pairing that no longer exists, so the log has to be the record by then.
     */
    const logged = await decidedPairs(routines.map((one) => one.id));
    const known = new Set(logged.map((one) => `${one.routineId}\u0000${one.secretName}`));
    for (const seed of seedFromRows(routines)) {
      if (known.has(`${seed.routineId}\u0000${seed.secretName}`)) continue;
      const routine = routines.find((one) => one.id === seed.routineId)!;
      if (!flag('dry-run')) {
        await recordPairAttempt(
          {
            routineId: routine.id,
            routineRef: routine.routineRef,
            routineName: routine.name,
            secretName: seed.secretName,
            outcome: 'ELIMINATED',
            kind: 'AUTH',
            detail: 'carried forward from the quarantine this row already records.',
          },
          ACTOR,
        );
      }
      logged.push(seed);
      known.add(`${seed.routineId}\u0000${seed.secretName}`);
    }

    const decided: DecidedPair[] = [...logged];
    const plan = planPairs(routines, decided);
    console.log(`RECONCILE  account ${account.name}`);
    console.log(`  square     ${routines.length} trigger(s) x ${plan.cells / routines.length} secret name(s) = ${plan.cells} cell(s)`);
    console.log(`  decided    ${plan.decided} already (${plan.locked.length} locked by a match)`);
    console.log(`  remaining  ${plan.pairs.length} cell(s) to ask about`);
    for (const pair of plan.pairs) console.log(`    would try  ${pair.routineName}  <-  ${pair.secretName}`);
    if (flag('dry-run')) return ok(`dry-run reconcile-secrets account=${account.name} remaining=${plan.pairs.length}`);

    const budget = Number(option('max') ?? String(plan.cells));
    if (!Number.isFinite(budget) || budget < 0) return refuse('--max must be a non-negative number.');

    const lockedRoutines = new Set(plan.locked.map((one) => one.routineId));
    const lockedSecrets = new Set(plan.locked.map((one) => one.secretName));
    const stopped = new Set<string>();
    let spent = 0;
    const matched: string[] = [];
    const eliminated: string[] = [];
    const inconclusive: string[] = [];
    const absent: string[] = [];

    console.log('');
    for (const pair of plan.pairs) {
      if (spent >= budget) break;
      if (lockedRoutines.has(pair.routineId) || lockedSecrets.has(pair.secretName)) continue;
      if (stopped.has(pair.routineId)) continue;
      const routine = routines.find((one) => one.id === pair.routineId)!;
      spent += 1;
      const verdict = await tryPair(pair, routine);
      await recordPairAttempt(verdict, ACTOR);
      console.log(`  ${verdict.outcome.padEnd(14)} ${pair.routineName}  <-  ${pair.secretName}`);
      console.log(`                 ${verdict.detail}`);
      if (verdict.outcome === 'MATCHED') {
        matched.push(`${pair.routineName} <- ${pair.secretName}`);
        lockedRoutines.add(pair.routineId);
        lockedSecrets.add(pair.secretName);
        if (routine.tokenSecretName !== pair.secretName) {
          const digest = digestOfSecret(pair.secretName);
          if (digest) {
            await setRoutineSecret({
              routineId: routine.id,
              tokenSecretName: pair.secretName,
              tokenDigest: digest,
              actor: ACTOR,
              reason: `reconcile-secrets: the provider accepted this bearer for ${pair.routineRef}.`,
            });
            console.log(`                 repointed ${routine.tokenSecretName} -> ${pair.secretName}`);
          }
        }
      } else if (verdict.outcome === 'ELIMINATED') {
        eliminated.push(`${pair.routineName} <- ${pair.secretName}`);
      } else if (verdict.outcome === 'SECRET_ABSENT') {
        absent.push(pair.secretName);
      } else {
        inconclusive.push(`${pair.routineName} <- ${pair.secretName} (${verdict.kind})`);
        if (stopsTrigger(verdict)) stopped.add(pair.routineId);
      }
    }

    const after = planPairs(routines, await decidedPairs(routines.map((one) => one.id)));
    console.log('');
    console.log(`  matched      ${matched.length}`);
    for (const line of matched) console.log(`    ${line}`);
    console.log(`  eliminated   ${eliminated.length} this run`);
    console.log(`  inconclusive ${inconclusive.length}${inconclusive.length > 0 ? ' — nothing was learned about these, and no cell was closed' : ''}`);
    for (const line of inconclusive) console.log(`    ${line}`);
    if (absent.length > 0) console.log(`  absent       ${[...new Set(absent)].join(', ')}`);
    console.log(`  still open   ${after.pairs.length} cell(s)`);
    for (const pair of after.pairs) console.log(`    ${pair.routineName}  <-  ${pair.secretName}`);
    if (after.pairs.length === 0 && after.locked.length < routines.length) {
      console.log('');
      console.log('  EXHAUSTED  every remaining pairing of these bearers with these triggers was refused.');
      console.log('             A bearer that opens none of them is not a mislabelling, and regenerating');
      console.log('             the tokens in the Claude account that owns them is the remaining remedy.');
    }
    return ok(
      `reconcile-secrets account=${account.name} tried=${spent} matched=${matched.length} ` +
        `open=${after.pairs.length}`,
    );
  }

  if (command === 'bind-worker') {
    const ref = option('ref');
    const given = option('worker');
    if (!ref || !given) return refuse('pass --ref <trig_…> --worker <wkr_… or a worker name>.');
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine registered as ${ref}.`);
    /*
     * By name as well as by id, because onboarding names the worker and never
     * shows the id. A runbook that has to say "find the id" is a runbook with a
     * step somebody invents; `factory-<grant>` is a value the operator already
     * has in front of them.
     *
     * Through the shared resolver rather than the two lookups this used to do
     * inline, so the label `workers list` prints resolves here too — and so
     * there is one answer to "what may somebody type" rather than one per
     * command. Its own header says why the third case is refused instead of
     * chosen between.
     */
    const resolved = await resolveWorkerRef(given);
    if (resolved.kind === 'AMBIGUOUS') {
      return refuse(
        `"${given}" names more than one worker (${resolved.matches
          .map((one) => one.id)
          .join(', ')}) — pass the id.`,
      );
    }
    if (resolved.kind === 'NONE') {
      return refuse(`no worker "${given}" — pass its id, its label, or the name onboarding gave it.`);
    }
    const workerId = resolved.worker.id;
    const changed = await bindRoutineWorker(routine.id, workerId);
    if (!changed) {
      return refuse(
        `${ref} is already bound to a different worker (${routine.workerId}). A Routine is not ` +
          're-pointed silently; retire it and register the new surface.',
      );
    }
    return ok(`bind-worker ${ref} -> ${workerId}`);
  }

  /*
   * The answering transition for the state `bind-worker` refuses.
   *
   * `bind-worker` is an observation and must not overwrite; this is a decision
   * and must, or a Routine bound to the wrong identity stays bound to it
   * forever. It is guarded on the binding the operator says is there, so it
   * cannot be a blind overwrite of one that moved while somebody was reading
   * it, and it is audited with both ends of the move.
   */
  if (command === 'repoint-worker') {
    const ref = option('ref');
    const workerId = option('worker');
    const expected = option('expect');
    const reason = (option('reason') ?? '').replace(/_/g, ' ');
    if (!ref || !workerId || !expected) {
      return refuse('pass --ref <trig_…> --expect <the wkr_… it is bound to now> --worker <wkr_…>.');
    }
    if (!reason) return refuse('pass --reason; a corrected binding with no reason answers nothing later.');
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine registered as ${ref}.`);
    if (!routine.workerId) {
      return refuse(
        `${ref} is not bound to anything, so there is nothing to correct. A first binding is ` +
          'observed from an arriving session, or set with bind-worker.',
      );
    }
    if (flag('dry-run')) {
      return ok(`dry-run repoint-worker ${ref} ${routine.workerId} -> ${workerId} (nothing written)`);
    }
    const changed = await repointRoutineWorker({
      routineId: routine.id,
      expectedWorkerId: expected,
      workerId,
      actor: ACTOR,
      reason,
    });
    if (!changed) {
      return refuse(
        `${ref} is not bound to ${expected}. Nothing changed. Read the current binding and pass it ` +
          'as --expect rather than widening the guard.',
      );
    }
    return ok(`repoint-worker ${ref} ${expected} -> ${workerId} actor=${ACTOR}`);
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
      const account = await accountByRef(ref);
      if (!account) return refuse(`no account named "${ref}".`);
      const changed = await setAccountState({ accountId: account.id, from: account.state, to, reason });
      if (!changed) return refuse(`${ref} moved between the read and the write. Read it again.`);
      return ok(`set-state account ${ref} ${account.state} -> ${to}`);
    }
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine registered as ${ref}.`);
    const changed = await setRoutineState({ routineId: routine.id, from: routine.state, to, reason });
    if (!changed) return refuse(`${ref} moved between the read and the write. Read it again.`);
    /*
     * And say what leaving QUARANTINED just did, because it is not obvious and
     * it is the whole reason the transition works.
     *
     * The no-show count is read from an append-only ledger since this surface's
     * own last arrival, and re-enabling produces no arrival. Without a boundary
     * the next tick would put it straight back, so leaving QUARANTINED writes
     * one — and an operator who is not told that will not know what to expect
     * if the condition was not actually fixed.
     */
    if (routine.state === 'QUARANTINED' && to !== 'QUARANTINED') {
      console.log(
        `  Unanswered fires before now are forgiven. If the condition is not actually fixed, ` +
          `${NO_SHOW_QUARANTINE_THRESHOLD} more unanswered fires take it out again.`,
      );
    }
    return ok(`set-state routine ${ref} ${routine.state} -> ${to}`);
  }

  /*
   * Rename a surface.
   *
   * A label and nothing else. `V1` and `V2` were the site names borrowed for
   * capacity surfaces, which is exactly the collision that makes a fleet reading
   * ambiguous — so a capacity surface is called `Brain Research A` and a site
   * keeps `V1`. Nothing about the credential, the trigger, the bound worker or
   * the state moves, which is why this is safe to run against a Routine that is
   * mid-packet.
   */
  if (command === 'rename') {
    const kind = (option('kind') ?? '').toLowerCase();
    // By the trigger it fires, or by what it is currently called — and what it
    // is called may have spaces in it, so the ref is read both ways below.
    const ref = option('ref');
    const to = nameOption('to');
    if (!kind || !ref || !to) {
      return refuse('pass --kind account|routine --ref <name|trig_\u2026> --to <New_Name>.');
    }
    if (kind !== 'account' && kind !== 'routine') {
      return refuse(`--kind must be account or routine, not "${kind}".`);
    }
    if (kind === 'account') {
      const account = await accountByRef(ref);
      if (!account) return refuse(`no account named "${ref}".`);
      if (account.name === to) return ok(`rename account ${ref}: already called that`);
      const changed = await renameAccount({ accountId: account.id, from: account.name, to });
      if (!changed) return refuse(`${ref} moved between the read and the write. Read it again.`);
      return ok(`rename account ${ref} -> ${to} (credential, state and routines untouched)`);
    }
    // By the trigger it fires, or by what it is currently called — the latter
    // raw first and then with underscores folded, for `accountByRef`'s reason.
    const all = await listRoutines();
    const routine =
      (await getRoutineByRef(ref)) ??
      all.find((one) => one.name === ref) ??
      all.find((one) => one.name === ref.replace(/_/g, ' ')) ??
      null;
    if (!routine) return refuse(`no Routine registered as ${ref}.`);
    if (routine.name === to) return ok(`rename routine ${ref}: already called that`);
    const changed = await renameRoutine({ routineId: routine.id, from: routine.name, to });
    if (!changed) return refuse(`${ref} moved between the read and the write. Read it again.`);
    return ok(
      `rename routine ${routine.routineRef} "${routine.name}" -> "${to}" ` +
        '(secret name, digest, worker binding and state untouched)',
    );
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
      const account = await accountByRef(ref);
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
    /*
     * Unanswered fires, per surface, since that surface last answered.
     *
     * Printed instead of `consecutive_no_shows`, which this line used to show
     * and which cannot express a pool: an arrival clears it for **every**
     * Routine bound to the same worker, so in a fleet of four Claude accounts
     * on one Factory identity a dead surface reads 0 because its healthy
     * siblings keep answering. It is also 1 on every working surface whose
     * worker is still booting, because it is advanced optimistically on each
     * successful fire.
     *
     * This is the number the dispatcher actually quarantines on, read from the
     * same function, so the screen and the decision cannot disagree.
     */
    const unanswered = await unansweredFiresByRoutine();

    console.log('FLEET');
    console.log(`  accounts    ${accounts.length}`);
    console.log(`  routines    ${routines.length}`);
    console.log(
      `  target      ${fleetPolicy ? effectiveTarget(fleetPolicy, now).target : 'not set'}` +
        (fleetPolicy?.boostUntil && fleetPolicy.boostUntil > now ? ` (boosted until ${fleetPolicy.boostUntil})` : ''),
    );
    console.log(`  in flight   ${snapshot.fleetInFlight}`);
    /*
     * "Considered", not "routable".
     *
     * `fleetSnapshot` builds the candidate list from registration and secret
     * presence; whether a candidate may actually take work is decided inside
     * `routeBin`, against account state, Routine state and retry_at. This line
     * used to say "routable now" and printed 2 while an account was
     * UNAVAILABLE and could take nothing — a report overstating what the fleet
     * could do, which is the one thing this step is least allowed to do.
     *
     * The eligible count is computed the same way the router computes it, by
     * asking the router.
     */
    const eligible = snapshot.candidates.filter((candidate) => {
      /*
       * Asked about a project this surface actually serves, because routing is
       * project-first and a bin with no project is not a thing that exists.
       *
       * `Bin.projectId` is NOT NULL, so every real bin carries one and
       * `routeBin` asks about it before anything else. The stub below used to
       * carry none, which made `servesProjects.includes(undefined)` false for
       * every candidate and printed `0 eligible now` over a fleet that was
       * demonstrably working — V1 had 294 fires and a completed bin behind it.
       * That is this line's *other* failure mode: the comment above records the
       * day it overstated what the fleet could do, and understating it is worse,
       * because a fleet that reports itself dead is one somebody starts
       * repairing.
       *
       * The question is asked per candidate, against a project that candidate
       * serves, so the project dimension is still applied rather than skipped.
       * A candidate serving no project is correctly ineligible: an unbound
       * Routine, or one whose worker holds no membership, can be handed nothing.
       */
      const [servedProject] = candidate.servesProjects;
      if (!servedProject) return false;
      const probe = routeBin({
        bin: { id: 'probe', projectId: servedProject, requiredCapabilities: [] } as never,
        candidates: [candidate],
        fleetPolicy: null,
        fleetInFlight: 0,
        now,
      });
      return probe.ok;
    }).length;
    console.log(`  candidates  ${snapshot.candidates.length} considered, ${eligible} eligible now`);
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
            // The binding is what `lineageForWorker` reads, so it is what
            // decides whether an audit role may run here. Printing everything
            // except the field the decision turns on is how an operator ends up
            // guessing at a refusal.
            `worker=${routine.workerId ?? '—'}  ` +
            // The capabilities too, for the reason the binding is printed: the
            // decision about which bin may be handed here turns on them, and an
            // operator reading everything except the deciding field guesses.
            `caps=[${routine.capabilities.join(',')}]  ` +
            `secret=${routine.tokenSecretName}  fires=${routine.totalFires} ` +
            `refusals=${routine.totalRefusals} unanswered=${unanswered.get(routine.id) ?? 0}` +
            (inFlight ? `  in-flight=${inFlight.routineInFlight}` : '  (not routable)') +
            (routine.retryAt ? `  retry_at=${routine.retryAt}` : ''),
        );
        /*
         * And why, when it is not ENABLED.
         *
         * `state_reason` has been written on every quarantine since the
         * first-`AUTH`-quarantines rule shipped, and until now it was read by
         * nothing at all — not here, not in the API, not in the UI. So a fleet
         * whose only dispatchable Routine had been taken out of routing showed
         * `QUARANTINED` and no way to find out what refused it, while the
         * answering transition `fleet set-state` is documented as being "once
         * the secret is fixed". **An escalation whose remedy names a thing to
         * correct is not a remedy while the thing to correct is invisible** —
         * §24's sentence, at a row.
         *
         * It is printed only for a surface that is not ENABLED, because a
         * healthy Routine's last recorded reason is history rather than a
         * condition, and printing it would read as a live problem.
         */
        if (routine.noShowsForgivenAt && routine.state === 'ENABLED') {
          /*
           * Only while it is a live fact. A surface an operator restored is
           * counting unanswered fires from that instant rather than from its
           * last arrival, and a reader comparing `unanswered=0` against a fire
           * count in the hundreds is owed the reason.
           */
          console.log(`          restored ${routine.noShowsForgivenAt}; unanswered counts from there`);
        }
        if (routine.state !== 'ENABLED' && routine.stateReason?.trim()) {
          /*
           * With the row's own timestamp, precisely labelled.
           *
           * `updated_at` is when this row was last written, which for a surface
           * sitting out of routing is when it was taken out — but only while
           * nothing else has written it since, and a health counter can. So it
           * says "row last written" rather than "quarantined at": the first is
           * what the column means and the second is an inference from it. There
           * is no column for the second, and inventing the stronger sentence
           * from the weaker fact is the rounding-up this file keeps refusing.
           */
          console.log(`          reason (row last written ${routine.updatedAt}):`);
          console.log(`            ${routine.stateReason.trim()}`);
        }
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
    /*
     * By id, not by scanning a page of them.
     *
     * It listed 500 bins ordered by priority and looked for the id in that page,
     * so a Brain with more than 500 bins answered "no bin <id>" about a bin that
     * plainly exists — and a diagnostic that misnames the cause sends whoever ran
     * it looking for the wrong thing, which is worse than no diagnostic.
     */
    const bin = await getBin(binId);
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

/**
 * One bounded self-test bin for a surface, of whichever kind it is.
 *
 * It was a factory-only probe, and the fleet it was pointed at had no factory
 * surface in it. Every research Routine — which is all of them here — refused
 * with five problems that all said the same thing in different words: *this is
 * not a factory surface*. `docs/CASH-DEPLOYMENT.md` names this command as the
 * gate before a sprint may be activated, so the documented gate could not pass
 * for the only kind of surface the documented topology has. A check that
 * refuses every healthy thing it is pointed at is not a check.
 *
 * The bin itself now lives in `server/services/fleet/probe.ts`. The People &
 * Capacity page needs the identical fire for the identical reason, and a second
 * copy of it would be the fourth time in this repository that one rule applied
 * by one of two readers turned out to be worse than none — here the two would
 * disagree about what "proven" costs and what a probe may touch.
 */
async function probeBin(input: {
  worker: { id: string; name: string };
  routing: { repositories: string[] };
  routine: { id: string; name: string; capabilities: string[] };
  family: 'FACTORY' | 'RESEARCH';
}): Promise<string> {
  const { createProbeBin } = await import('../server/services/fleet/probe.ts');
  return createProbeBin({
    worker: input.worker,
    repositories: input.routing.repositories,
    routine: input.routine,
    family: input.family,
    createdByType: 'SYSTEM',
    createdById: 'fleet-cli:verify-surface',
  });
}

  /*
   * Is this surface the worker we meant, and is that a reading or an assumption?
   *
   * The question this answers is the one a second connector cannot answer by
   * being named differently. A connector's name is a label in somebody's Claude
   * account; the identity that reaches Brain is whatever worker the OAuth token
   * resolves to, and a Routine whose connector was authorized against the
   * *research* worker would be a factory surface in every respect except the one
   * that decides what it may claim.
   *
   * So this prints two blocks that must not be confused, and labels them:
   *
   *   CONFIGURED — the rows an operator wrote. A binding, a scope, a secret.
   *   OBSERVED   — what has actually happened. A token minted for this worker and
   *                used, and a session that arrived on a fire Brain sent here.
   *
   * A green CONFIGURED block with an empty OBSERVED one is a plan, not a proof,
   * and it says so. That distinction is `evidence_class` at an operator's
   * command: a ceiling nobody has observed reads UNKNOWN and stays UNKNOWN.
   */
  if (command === 'verify-surface') {
    const ref = option('ref') ?? arg(0);
    if (!ref) return refuse('pass a Routine ref, e.g. --ref trig_...');
    const routine = await getRoutineByRef(ref);
    if (!routine) return refuse(`no Routine ${ref} is registered.`);
    const account = (await listAccounts()).find((a) => a.id === routine.accountId) ?? null;

    console.log('CONFIGURED');
    console.log(`  routine     ${routine.name}  ${routine.state}  ref=${routine.routineRef}`);
    console.log(`  account     ${account?.name ?? '—'}  ${account?.state ?? '—'}`);
    console.log(`  caps        [${routine.capabilities.join(',')}]`);
    console.log(
      `  secret      ${routine.tokenSecretName}  ` +
        (resolveToken(routine.tokenSecretName) ? 'present' : 'NOT PRESENT in this deployment'),
    );

    const problems: string[] = [];
    if (!routine.workerId) {
      console.log('  worker      — (no binding)');
      problems.push('this Routine is bound to no worker, so nothing can be verified about its identity');
    }
    const worker = routine.workerId ? await getWorker(routine.workerId) : null;
    const routing = routine.workerId ? await getWorkerRouting(routine.workerId) : null;
    if (worker) {
      console.log(
        `  worker      ${workerIdentity(worker)}  ${worker.id}` +
          (worker.label && worker.label !== worker.name ? `  (legacy handle ${worker.name})` : '') +
          (worker.archived ? '  ARCHIVED' : ''),
      );
      console.log(`  families    ${routing ? `[${routing.families.join(',')}]` : 'no routing row (derived default)'}`);
      console.log(`  repos       ${routing ? `[${routing.repositories.join(',')}]` : '— (a worker with no row may never be handed repository work)'}`);
      if (worker.archived) problems.push('the bound worker is archived');
      if (!routing) {
        problems.push('the bound worker has no routing row, so it may never be handed repository work');
      }
      /*
       * What this surface is *for* is read from the bound worker's own routing
       * row, never assumed.
       *
       * Every check below used to assume FACTORY, so a research Routine — which
       * is every Routine in this fleet — was refused with five problems that all
       * restated "this is not a factory surface". The instrument was pointed at
       * a fleet it could not describe, and `docs/CASH-DEPLOYMENT.md` names it as
       * the gate a sprint waits behind, so the gate could never open. A surface
       * is verified against the contract it actually has.
       */
      const surfaceFamily: 'FACTORY' | 'RESEARCH' = routing?.families.includes('FACTORY')
        ? 'FACTORY'
        : 'RESEARCH';
      console.log(`  verifying   as a ${surfaceFamily} surface, from the bound worker's routing row`);
      if (surfaceFamily === 'FACTORY') {
        /*
         * The check this command exists for. A worker that also serves research is
         * not a separated identity however its connector is named — it is the
         * research identity wearing a second label, and every routing boundary
         * downstream would pass while separating nothing.
         */
        if (routing && routing.families.some((family) => family !== 'FACTORY')) {
          problems.push(
            `the bound worker also serves [${routing.families.filter((f) => f !== 'FACTORY').join(',')}] — ` +
              'a factory surface must not share an identity with research work',
          );
        }
        if (routing && routing.repositories.length === 0) {
          problems.push('the bound worker is authorized for no repository, so no factory bin can route here');
        }
        for (const tag of ['repository', 'repository-write']) {
          if (!routine.capabilities.includes(tag)) problems.push(`this Routine does not declare ${tag}`);
        }
      } else {
        /*
         * The research mirror, and the asymmetry is deliberate. A factory surface
         * is refused for *also* serving research, because the thing being proved
         * there is separation. Nothing equivalent holds here: RESEARCH and
         * GENERAL together is the ordinary shape of a research worker, and
         * `airynworker2` has served both for this fleet's whole life.
         *
         * What does matter is that a research surface must never be able to take
         * repository work, and that it is a member of something — routing is
         * project-first, so a worker holding no membership can be handed nothing
         * whatever else is right about it.
         */
        if (routing && routing.repositories.length > 0) {
          problems.push(
            `the bound worker is authorized for [${routing.repositories.join(',')}] — ` +
              'a research surface must not be able to take repository work',
          );
        }
        for (const tag of ['repository', 'repository-write']) {
          if (routine.capabilities.includes(tag)) {
            problems.push(`this Routine declares ${tag}, which a research surface must not`);
          }
        }
        const { listMembershipsForPrincipal } = await import('../server/repos/identity.ts');
        const active = (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active);
        console.log(`  projects    ${active.length} active membership(s)`);
        if (active.length === 0) {
          problems.push('the bound worker is a member of no project, so no bin can route here');
        }
        /*
         * Said rather than counted as a problem. One worker across several
         * projects is invariant 41's shape and a privacy question for a person,
         * not a fact that makes this surface unusable — and calling it a problem
         * here would block the probe on a condition the probe cannot settle.
         */
        if (active.length > 1) {
          console.log(
            `  NOTE        this worker serves ${active.length} projects, so every Routine bound to it ` +
              'can be handed work from all of them (invariant 41)',
          );
        }
      }
    }

    if (flag('probe') && problems.length === 0 && worker && routing) {
      const created = await probeBin({
        worker,
        routing,
        routine,
        family: routing.families.includes('FACTORY') ? 'FACTORY' : 'RESEARCH',
      });
      console.log('');
      console.log(`  PROBE       created ${created} — a bounded self-test bin for this surface.`);
      console.log('              It names no objective, changes no repository and belongs to no');
      console.log('              campaign. Brain will fire this Routine for it within a tick;');
      console.log('              run verify-surface again once it has.');
    }

    console.log('');
    console.log('OBSERVED');
    if (!worker) {
      console.log('  nothing, because there is no worker to observe');
    } else {
      /*
       * A token is held by a *connector*, and nothing about a token says which
       * Routine holds it. So this is supporting evidence and never the proof —
       * see the chain below, which is the thing that is actually being asked.
       */
      const tokens = await listTokensForWorker(worker.id);
      const used = tokens.filter((token) => token.lastUsedAt !== null);
      console.log(`  oauth       ${tokens.length} token(s) minted for this worker, ${used.length} used`);
      console.log(`  fires       ${routine.totalFires} sent, ${routine.totalRefusals} refused`);
      /*
       * The derived per-surface count, never `consecutive_no_shows`.
       *
       * That column is cleared by an arrival on **any** Routine bound to the
       * same worker, which is exactly what a pool is — so on the one command
       * whose whole job is to ask whether *this* surface works, it read 0 for a
       * dead surface whose healthy siblings were answering. It is also 1 on a
       * working surface whose worker is still booting.
       */
      const unansweredHere = (await unansweredFiresByRoutine()).get(routine.id) ?? 0;
      console.log(`  arrivals    ${unansweredHere} fire(s) since the last arrival with nobody arriving`);

      /*
       * The correlation, which is the only thing that proves *this Routine* uses
       * *that worker*.
       *
       * Four links, each from a row Brain wrote rather than from anything a
       * worker said about itself: Brain fired this Routine (`bin_dispatch`, with
       * the session the provider returned); a session arrived and authenticated
       * (`worker_sessions`, written from that same dispatch row); it was handed a
       * bin; and that bin reached a terminal completion. A surface with a used
       * token and no such chain is a connector somebody authorized and a Routine
       * nothing has been shown to run on.
       */
      const sessions = await sessionsForRoutine(routine.id, 20);
      const bins = new Map<string, Awaited<ReturnType<typeof getBin>>>();
      const dispatches = new Map<string, Awaited<ReturnType<typeof listDispatchesForBin>>>();
      for (const session of sessions) {
        if (!bins.has(session.binId)) bins.set(session.binId, await getBin(session.binId));
        if (!dispatches.has(session.binId)) {
          dispatches.set(session.binId, await listDispatchesForBin(session.binId));
        }
      }
      const proof = proveSurface({
        boundWorkerId: worker.id,
        routineRef: routine.routineRef,
        sessions,
        bins,
        dispatches,
      });
      const proven = proof.chain;

      console.log(`  sessions    ${sessions.length} arrival(s) attributed to this Routine`);
      if (proven) {
        console.log(`    fired     ${proven.sentAt ?? 'recorded on the dispatch this arrival came from'}`);
        console.log(
          `    arrived   ${proven.sessionRef} authenticated as ${workerIdentity(worker)} ` +
            `at ${proven.observedAt}`,
        );
        console.log(`    assigned  ${proven.binId}`);
        console.log(`    completed ${proven.binId} reached COMPLETE`);
      }

      if (tokens.length === 0) {
        problems.push(
          'no OAuth token has ever been minted for this worker, so no connector has authenticated as it',
        );
      } else if (used.length === 0) {
        problems.push('a token exists for this worker but has never been used to call Brain');
      }
      problems.push(...proof.problems);
      if (unansweredHere > 0 && routine.totalFires > 0 && unansweredHere >= routine.totalFires) {
        problems.push('every fire to this Routine has gone unanswered');
      }
    }

    console.log('');
    if (problems.length === 0) {
      console.log('  VERIFIED  a fire to this Routine produced a session that authenticated as');
      console.log(`            ${worker!.name}, was handed a bin and completed it.`);
      return ok(`verify-surface ${ref} VERIFIED`);
    }
    for (const problem of problems) console.log(`  PROBLEM   ${problem}`);
    return refuse(`verify-surface ${ref}: ${problems.length} problem(s) above.`);
  }

  /*
   * Is the Factory a pool, and is every member of it proven?
   *
   * `verify-surface` answers that about one Routine. This answers it about the
   * set, and the difference is the whole reason it exists: a pool with one
   * surface missing or one surface never run looks, per-Routine, exactly like a
   * smaller healthy pool. The expected set is derived from rows — every Routine
   * bound to the named logical worker — so a Routine somebody forgot to register
   * is an absence this can see, and a Routine bound to the *wrong* worker is
   * named rather than quietly skipped.
   *
   * **It refuses success unless every surface closed its own chain**: Brain
   * fired that Routine, a session arrived and was attributed to the expected
   * worker from that same dispatch row, it was handed the bin, and the bin
   * reached COMPLETE. Nothing about a configured row counts, which is §23's
   * CONFIGURED/OBSERVED split applied to a set instead of a single surface.
   *
   * `--probe` creates one bounded self-test per unproven surface, **pinned to
   * that surface**. It proves pooled dispatch and identity and nothing else:
   * the manifest forbids every repository operation, so repository access stays
   * unproven until a real campaign does it.
   */
  if (command === 'work-audit') {
    /*
     * Every bin a worker could still be handed, fleet-wide, and the ones that
     * have stopped being able to finish.
     *
     * Read-only. It exists because the bin surfaces that already exist are
     * project-scoped — `step10 report` reads one slug — so the one question a
     * person actually asks after a worker reports being handed the same item
     * five times, *which item, in which packet, and why did it keep coming
     * back*, had nowhere to be asked.
     *
     * The column that matters is `attempts`. `DISPATCHABLE_SQL` carries
     * `attempt_count < max_attempts`, so a bin at its ceiling is neither
     * fireable nor assignable — and a bin at its ceiling that is still READY is
     * therefore a bin waiting for `reconcileBins` to turn it into one decision,
     * not a bin that can be handed out again. Both are printed, because reading
     * them as the same thing is how an exhausted bin gets "fixed" by hand.
     */
    const states: BinState[] = ['DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN'];
    const bins = await listBins({ states, limit: 500 });
    const now = new Date().toISOString();
    let exhausted = 0;
    let live = 0;
    let claimable = 0;
    console.log('WORK AUDIT');
    console.log(`  ${bins.length} bin(s) in ${states.join(', ')}`);
    console.log('');
    for (const bin of bins) {
      const spent = bin.attemptCount >= bin.maxAttempts;
      const leaseLive =
        bin.state === 'LEASED' && bin.leaseExpiresAt !== null && bin.leaseExpiresAt > now;
      const offerable = !spent && (bin.state === 'READY' || (bin.state === 'LEASED' && !leaseLive));
      if (spent) exhausted += 1;
      if (leaseLive) live += 1;
      if (offerable) claimable += 1;
      console.log(
        `  ${bin.id}  ${bin.state.padEnd(11)} attempts ${bin.attemptCount}/${bin.maxAttempts}` +
          `  gen ${bin.leaseGeneration}  ${bin.completionContract}` +
          (spent ? '  EXHAUSTED' : '') +
          (leaseLive ? '  HELD' : '') +
          (offerable ? '  CLAIMABLE' : ''),
      );
      console.log(`      ${bin.title}`);
      console.log(
        `      project ${bin.projectId}  packet ${bin.orchestrationId ?? '—'}` +
          `  pinned ${bin.pinnedRoutineId ?? '—'}  refusals ${bin.refusalCount}`,
      );
      if (bin.terminalReason) console.log(`      reason ${bin.terminalReason.slice(0, 200)}`);
      if (spent && (bin.state === 'READY' || bin.state === 'LEASED')) {
        console.log(
          '      NOTE this bin is out of attempts and not yet a decision. It cannot be fired or ' +
            'assigned; the next reconcile turns it into one NEEDS_HUMAN with the contract\u2019s reason.',
        );
      }
    }
    console.log('');
    console.log(`  claimable ${claimable}  held ${live}  exhausted ${exhausted}`);
    return ok(
      `work-audit bins=${bins.length} claimable=${claimable} held=${live} exhausted=${exhausted}`,
    );
  }

  if (command === 'attribution') {
    /*
     * Can Brain prove which surface an arriving session came from?
     *
     * Read-only, and deliberately so: it fires nothing, binds nothing,
     * repoints nothing and revokes nothing. §29's rule for the self-model at a
     * new table — a reading that acted on what it saw would be a control loop
     * whose input is its own output.
     *
     * Three facts per surface that no other command puts side by side: which
     * worker the Routine is bound to, which OAuth clients have actually minted
     * a token for that worker, and who approved those grants. The second is the
     * one that decides everything: a credential identifies a *connector*, so a
     * worker behind two connectors cannot tell its sessions apart however
     * correct the rest of the chain is.
     */
    const report = await auditFleetAttribution();
    console.log('FLEET ATTRIBUTION');
    console.log(
      `  surfaces ${report.surfaces.length}  proven ${report.proven}  ambiguous ${report.ambiguous}` +
        `  unverified ${report.unverified}  unbound ${report.unbound}`,
    );
    console.log('');
    console.log(
      '  worker        account            routine               trigger                          status',
    );
    for (const surface of report.surfaces) {
      console.log(
        `  ${(surface.workerLabel ?? '—').padEnd(12)}  ${surface.accountName.padEnd(18)} ` +
          `${surface.routineName.padEnd(20)} ${surface.routineRef.padEnd(32)} ${surface.status}`,
      );
      console.log(
        `      secret ${surface.secretName}  bearer ${surface.bearerFingerprint ?? '—'}  ` +
          `worker ${surface.workerId ?? '—'}  state ${surface.routineState}`,
      );
      if (surface.workerCreatedAt) {
        console.log(
          `      worker row written ${surface.workerCreatedAt} by ${surface.workerCreatedBy}` +
            `  owner ${surface.ownerUserId ?? 'not established'}` +
            (surface.ownerEvidence ? ` (${surface.ownerEvidence})` : ''),
        );
      }
      if (surface.workerLegacyName && surface.workerLegacyName !== surface.workerLabel) {
        console.log(
          `      legacy handle ${surface.workerLegacyName} — a lookup key only; it attributes nothing`,
        );
      }
      console.log(
        `      connectors ${surface.clientIds.length === 0 ? '—' : surface.clientIds.join(', ')}` +
          `  approvers ${surface.approverUserIds.length === 0 ? '—' : surface.approverUserIds.join(', ')}`,
      );
      for (const finding of surface.findings) {
        console.log(
          `      ${AMBIGUATES[finding] ? 'BLOCKING ' : 'note     '} ${finding}: ${FINDING_DETAIL[finding]}`,
        );
      }
    }
    if (report.orphanWorkerIds.length > 0) {
      console.log('');
      console.log(`  ORPHAN WORKERS (hold a credential, serve no registered Routine)`);
      for (const id of report.orphanWorkerIds) console.log(`      ${id}`);
    }
    for (const span of report.clientsSpanningWorkers) {
      console.log('');
      console.log(
        `  ONE CONNECTOR, ${span.workerIds.length} WORKERS  ${span.clientId} -> ${span.workerIds.join(', ')}`,
      );
    }
    console.log('');
    console.log(
      '  PROVEN means the credential identifies one account. AMBIGUOUS means it cannot,',
    );
    console.log('  and the finding beside it says why. Nothing here was changed.');
    return ok(
      `attribution surfaces=${report.surfaces.length} proven=${report.proven} ` +
        `ambiguous=${report.ambiguous} unbound=${report.unbound}`,
    );
  }

  if (command === 'trace-session') {
    /*
     * Given a worker-session id, exactly which registered Routine and which
     * credential produced it. Every link is a row Brain wrote itself; the only
     * thing taken from the caller is the id being asked about.
     */
    const ref = option('ref');
    if (!ref) return refuse('trace-session needs --ref <worker session id>');
    const trace = await traceWorkerSession(ref);
    if (!trace) {
      return refuse(
        `trace-session ${ref}: no worker_sessions row. Brain never observed that credential ` +
          'arriving and taking a bin, so there is nothing to trace.',
      );
    }
    console.log(`SESSION ${trace.sessionRef}`);
    console.log(`  worker      ${trace.workerLabel ?? '—'}  ${trace.workerId}`);
    if (trace.workerLegacyName && trace.workerLegacyName !== trace.workerLabel) {
      console.log(`  legacy      ${trace.workerLegacyName} — a lookup key; it attributes nothing`);
    }
    console.log(`  routine     ${trace.routineName ?? '—'}  ${trace.routineRef ?? '—'}  ${trace.routineId}`);
    console.log(`  account     ${trace.accountName ?? '—'}  ${trace.accountId}`);
    console.log(`  secret      ${trace.secretName ?? '—'}  bearer ${trace.bearerFingerprint ?? '—'}`);
    console.log(`  bin         ${trace.binId}  generation ${trace.leaseGeneration}`);
    console.log(`  packet      ${trace.orchestrationId ?? '—'}`);
    console.log(`  fired       ${trace.firedAt ?? '—'}  as ${trace.firedSessionRef ?? '—'}`);
    console.log(`  checked in  ${trace.observedAt}`);
    console.log(`  claimed     ${trace.claimedAt ?? '—'}`);
    if (trace.credential) {
      console.log(
        `  credential  ${trace.credential.tokenId}  ${trace.credential.kind}  ` +
          `client ${trace.credential.clientId}` +
          (trace.credential.clientName ? ` (${trace.credential.clientName})` : ''),
      );
      console.log(
        `              issued ${trace.credential.issuedAt}  used ${trace.credential.lastUsedAt ?? 'never'}` +
          (trace.credential.revokedAt ? `  revoked ${trace.credential.revokedAt}` : '') +
          (trace.credential.parentTokenId ? '  minted by a refresh' : '  from an authorization code'),
      );
    } else {
      console.log('  credential  — the token row is gone, so only Brain\u2019s own dispatch record remains');
    }
    console.log(`  approvers   ${trace.approverUserIds.join(', ') || '—'}`);
    console.log(`  status      ${trace.status}`);
    for (const finding of trace.findings) {
      console.log(`      ${AMBIGUATES[finding] ? 'BLOCKING ' : 'note     '} ${finding}: ${FINDING_DETAIL[finding]}`);
    }
    return ok(`trace-session ${trace.sessionRef} routine=${trace.routineRef ?? '—'} status=${trace.status}`);
  }

  if (command === 'verify-pool') {
    const repository = (option('repository') ?? option('repo') ?? '').trim().toLowerCase();
    const workerName = option('worker') ?? 'factory-brain';
    if (!repository) {
      return refuse('pass --repository <owner/name>, e.g. --repository peyday007/v5.');
    }
    const { verifyFactoryPool } = await import('../server/services/dispatch/pool.ts');
    let report;
    try {
      report = await verifyFactoryPool({ workerName, repository });
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }

    console.log(`POOL  ${report.repository}  as ${report.expectedWorkerName}`);
    // Two numbers, each labelled as what it counts. A pool of three Routines on
    // one subscription is not three accounts' capacity, and a line reading
    // `surfaces 3` alone is how it gets read as one.
    console.log(`  accounts   ${report.accounts}`);
    console.log(`  surfaces   ${report.surfaces.length}`);
    for (const surface of report.surfaces) {
      console.log('');
      console.log(`  ${surface.verdict.padEnd(8)} ${surface.routineName}  (${surface.accountName})`);
      console.log(`    ref       ${surface.routineRef}`);
      console.log(`    worker    ${surface.boundWorker ?? '— (no binding)'}` +
        (surface.authenticatesAsExpected ? '' : `  NOT ${report.expectedWorkerName}`));
      console.log(
        `    eligible  ${surface.eligible ? 'yes' : `no — ${surface.ineligibleBecause.join('; ')}`}`,
      );
      console.log(
        `    headroom  ${surface.headroom.used}/${surface.headroom.limit ?? '∞'} in flight` +
          (surface.cooldownUntil ? `  cooling until ${surface.cooldownUntil}` : ''),
      );
      console.log(`    fires     ${surface.lastOutcome}`);
      if (surface.chain) {
        /*
         * The word says which verdict this chain is under. A `STALE` surface
         * has a genuinely closed chain and printing "proven" over it would put
         * two answers to one question on one screen — §29's status
         * contradicting the line above it, which is what teaches a reader to
         * stop believing the verdict column.
         */
        const label = surface.verdict === 'STALE' ? 'was' : 'proven';
        console.log(`    ${label.padEnd(9)} fired ${surface.chain.sentAt ?? 'recorded on the dispatch'}`);
        console.log(`              arrived ${surface.chain.sessionRef} at ${surface.chain.observedAt}`);
        console.log(`              assigned and completed ${surface.chain.binId}`);
      }
      for (const problem of surface.problems) console.log(`    PROBLEM   ${problem}`);
    }

    if (flag('probe')) {
      const { createProbeBin, ProbeRefused } = await import('../server/services/fleet/probe.ts');
      console.log('');
      for (const surface of report.surfaces) {
        if (surface.verdict === 'PROVEN') continue;
        /*
         * A faulted surface is not probed. Its connector authenticates as
         * somebody else, so a fire would produce another foreign arrival and
         * another row saying the same thing — spending an activation to
         * re-learn a fact already on the screen. The remedy is to reconnect it
         * against the right worker, and that is a person's.
         */
        if (surface.verdict === 'FAULT') {
          console.log(`  SKIPPED   ${surface.routineName}: reconnect it as ${report.expectedWorkerName} first.`);
          continue;
        }
        /*
         * A `STALE` surface is probed exactly like an unproven one, and that is
         * the whole remedy for the verdict: its chain closed once and Brain's
         * later evidence disagrees, so the only thing that settles it is a new
         * fire that either arrives or does not.
         */
        const routine = await getRoutineByRef(surface.routineRef);
        const worker = routine?.workerId ? await getWorker(routine.workerId) : null;
        const routing = routine?.workerId ? await getWorkerRouting(routine.workerId) : null;
        if (!routine || !worker || !routing) {
          console.log(`  SKIPPED   ${surface.routineName}: nothing to probe until it is bound and routed.`);
          continue;
        }
        try {
          const created = await createProbeBin({
            worker,
            repositories: routing.repositories,
            routine,
            family: 'FACTORY',
            createdByType: 'SYSTEM',
            createdById: 'fleet-cli:verify-pool',
          });
          console.log(`  PROBE     ${surface.routineName}: ${created} — pinned to this surface.`);
        } catch (error) {
          const why = error instanceof ProbeRefused ? error.message : String(error);
          console.log(`  SKIPPED   ${surface.routineName}: ${why}`);
        }
      }
      console.log('');
      console.log('  Each probe names no objective, changes no repository and belongs to no');
      console.log('  campaign. Brain fires its own surface for it within a tick; run');
      console.log('  verify-pool again once they have been answered.');
    }

    console.log('');
    /*
     * Notes print on both paths, and that is the point of their being a
     * separate channel. They used to be problems, and this block returned on
     * `ok` before reaching the loop — so the single-surface caveat was printed
     * only by a run that had already failed for another reason, and never by
     * the green run that is the only place somebody could read "VERIFIED" as
     * "pooled". A caveat visible only on failure is not a caveat.
     */
    for (const note of report.notes) console.log(`  NOTE      ${note}`);
    if (report.notes.length > 0) console.log('');
    if (report.ok) {
      console.log(`  VERIFIED  ${report.surfaces.length} surface(s), each fired, each arrived as`);
      console.log(`            ${report.expectedWorkerName}, each handed a bin and each completing it.`);
      console.log('            This proves pooled dispatch and identity. It proves nothing about');
      console.log('            repository access — the first real campaign does that.');
      return ok(`verify-pool ${repository} VERIFIED surfaces=${report.surfaces.length}`);
    }
    for (const problem of report.problems) console.log(`  PROBLEM   ${problem}`);
    return refuse(`verify-pool ${repository}: ${report.problems.length} problem(s) above.`);
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
    /*
     * The same per-surface count the dispatcher decides on.
     *
     * This passed the Routine row straight in, so it advised on
     * `consecutive_no_shows` — a column a sibling's arrival clears — while the
     * tick quarantines on the derived count. Two readers of one question, and
     * the advice was the one that could not see a dead surface in a pool.
     *
     * It remains advice: nothing here changes a state. A surface the tick has
     * already taken out of routing is not proposed again.
     */
    const unanswered = await unansweredFiresByRoutine();
    for (const routine of await listRoutines()) {
      if (routine.state !== 'ENABLED') continue;
      const verdict = shouldQuarantine({
        consecutiveNoShows: unanswered.get(routine.id) ?? 0,
        consecutiveFailures: routine.consecutiveFailures,
      });
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
      'repoint-worker, rename, ' +
      'set-state, set-target, boost, pause, resume, policy-history, explain-route, verify-surface, ' +
      'attribution, trace-session, work-audit, ' +
      'verify-pool, scale-advice, ' +
      'profile, simulate.',
  );
}

main()
  .catch((error) => {
    console.error('FLEET: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
