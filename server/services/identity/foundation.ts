/**
 * The Account Foundation Standard: what "this account is set up" actually means.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Every fact this module reports was already derivable. `people.ts` says
 * whether somebody can sign in, `connection.ts` says where their Claude
 * connection is, `contribution.ts` says whether that connection is capacity a
 * dispatcher would fire, `ownership.ts` says whose worker a worker is, and
 * `attribution.ts` says whether a surface's sessions can be attributed at all.
 *
 * What did not exist is anywhere that holds them **against one account at
 * once**. So an administrator could read five healthy-looking surfaces and
 * still not be able to answer "is Caleb set up, and if not, what is the one
 * thing that would fix it" — which is the only question any of those readings
 * are collectively for. A person whose sign-in works, whose connection is
 * CONFIGURED, whose worker is bound to somebody else's Routine and whose
 * capacity is therefore zero reads as *mostly fine* on every individual screen
 * and is, in fact, contributing nothing and unable to be told so.
 *
 * ---------------------------------------------------------------------------
 * Three properties, each of which is the point rather than a detail
 * ---------------------------------------------------------------------------
 *
 * **It is a projection and it decides nothing.** Nothing here fires, claims,
 * binds, repoints, issues, revokes or writes. It is read on demand and stored
 * nowhere, for `placements`' own reason: a row is not a decision, and a stored
 * verdict is stale the moment the fact it waited on arrives. Deriving it is
 * also what lets it reach the accounts that are *already* stranded rather than
 * only the ones something remembers to re-check.
 *
 * **It composes; it never re-derives.** Every verdict below is read from the
 * module that owns that question. A second copy of "is this capacity usable"
 * living here would be the two-readers-disagreeing defect this repository has
 * corrected at a column, a status line, a review card and a routing table —
 * and the copy nobody reads is always the one that drifts.
 *
 * **`NOT_APPLICABLE` is a real answer and is never rounded to `PASS`.** A
 * member who has not started a Claude connection has no worker to attribute
 * and no capacity to measure; saying so is different from saying those are
 * fine, and different again from saying they are broken. Invariant 39, at a
 * matrix: an unanswered dimension may never make something read as ready.
 *
 * ---------------------------------------------------------------------------
 * What each dimension actually requires, and where that requirement comes from
 * ---------------------------------------------------------------------------
 *
 * These are read out of the system's own contracts rather than invented, which
 * matters most for the two that look like bookkeeping and are not:
 *
 *   * **IDENTITY** includes *display-name uniqueness*, because
 *     `getPinCredentialByIdentity` resolves a typed name with `LIMIT 2` and
 *     returns nothing when two rows match. Two people sharing a display name
 *     do not get a warning; they get a sign-in that cannot succeed and a
 *     refusal that — correctly — tells them nothing. It is an identity defect
 *     that presents as a credential one.
 *
 *   * **RECOVERY** asks whether the administrator's recovery actually retires
 *     what the person is holding, not merely whether a button exists. §32's
 *     rule is that a recovery which leaves the old credential working is "not
 *     a recovery, it is a second door" — so an account whose PIN would survive
 *     its own recovery is `BLOCKED` here however healthy it looks elsewhere.
 *
 * `SIGN_IN` asks the question the *served screen* answers rather than the one
 * the schema does: a passkey is a credential, and the sign-in screen does not
 * offer one, so an account holding only a device cannot get in. `people.ts`
 * already draws that distinction and calls it `NEEDS_A_NEW_LINK`; this reads
 * that answer rather than forming a second opinion about it.
 */
import type { User } from '../../domain/types.ts';
import { listUsers } from '../../repos/identity.ts';
import { countLivePasskeys } from '../../repos/passkeys.ts';
import { connectionForUser } from '../../repos/capacityConnections.ts';
import { getWorker, getWorkerByName } from '../../repos/identity.ts';
import { getRoutine, listRoutines } from '../../repos/fleet.ts';
import { namesFor } from '../capacity/connection.ts';
import { contributedCapacity } from '../capacity/contribution.ts';
import { ambiguousSignInNames, signInName } from '../../domain/signInName.ts';
import { recoveryRetiresEverything } from './recoveryContract.ts';
import { withoutDomain } from './people.ts';

/** PASS, BLOCKED, or genuinely not a question for this account yet. */
export type FoundationVerdict = 'PASS' | 'BLOCKED' | 'NOT_APPLICABLE';

/** The six things an account has to have for the product to work for them. */
export type FoundationDimension =
  | 'IDENTITY'
  | 'SIGN_IN'
  | 'CLAUDE_CONNECTION'
  | 'WORKER_ATTRIBUTION'
  | 'CAPACITY'
  | 'RECOVERY';

export const FOUNDATION_DIMENSIONS: readonly FoundationDimension[] = [
  'IDENTITY',
  'SIGN_IN',
  'CLAUDE_CONNECTION',
  'WORKER_ATTRIBUTION',
  'CAPACITY',
  'RECOVERY',
];

/**
 * Who performs the next action.
 *
 * `BRAIN` means it resolves by itself on a tick and nobody is being asked —
 * which is a different fact from nobody being needed, and is why it is not
 * folded into a null owner. `DEPLOYMENT_ADMINISTRATOR` is its own value
 * because `fire.ts` resolves a Routine's bearer with `process.env[name]`, so
 * that one step cannot be performed by anything in this repository however
 * much authority a caller holds.
 */
export type FoundationActor =
  | 'MEMBER'
  | 'BRAIN_ADMINISTRATOR'
  | 'DEPLOYMENT_ADMINISTRATOR'
  | 'BRAIN'
  | 'NOBODY';

export interface FoundationFinding {
  dimension: FoundationDimension;
  verdict: FoundationVerdict;
  /** What is true now, in one sentence. Always present, including on PASS. */
  because: string;
  /** The single next action, or null when there is nothing to do. */
  nextAction: string | null;
  /** Who performs it. `NOBODY` exactly when `nextAction` is null. */
  owner: FoundationActor;
}

export interface AccountFoundation {
  userId: string;
  /** Redacted the way every other member-facing reading redacts it. */
  displayName: string;
  isBrainAdmin: boolean;
  findings: FoundationFinding[];
  /** BLOCKED if any dimension is BLOCKED; otherwise PASS. */
  verdict: 'PASS' | 'BLOCKED';
}

/**
 * A surface that is firing under an identity no account owns.
 *
 * This is the Brain-level half of worker attribution, and it is separate from
 * the per-account findings because the thing that is wrong is not any one
 * account's: it is a Routine bound to a worker that no `capacity_connections`
 * row resolves to, which is exactly what a worker registered by hand before the
 * connection journey existed looks like.
 *
 * `ownership.ts` already decides whose a worker is and refuses to guess when
 * two connections resolve to one; this reads that answer and says which
 * enabled surfaces have no answer at all. It is reported and **never acted
 * on** — retiring or repointing a live surface is an operator's decision, and
 * a projection that took it would be exactly the blind redistribution that
 * loses running work.
 */
export interface UnattributedSurface {
  routineId: string;
  routineName: string;
  workerId: string;
  /** The neutral label, never the legacy operator handle. */
  workerLabel: string | null;
  /** Whether the dispatcher would fire it today. */
  enabled: boolean;
  because: string;
  nextAction: string;
}

export interface FoundationReading {
  accounts: AccountFoundation[];
  /** How many accounts satisfy every dimension that applies to them. */
  passing: number;
  /** How many are short of at least one. */
  blocked: number;
  /**
   * Surfaces running under an identity no account owns.
   *
   * Empty is the healthy answer and is not the same fact as nobody having
   * looked, which is why it is a list rather than a flag.
   */
  unattributed: UnattributedSurface[];
}

function pass(
  dimension: FoundationDimension,
  because: string,
): FoundationFinding {
  return { dimension, verdict: 'PASS', because, nextAction: null, owner: 'NOBODY' };
}

function blocked(
  dimension: FoundationDimension,
  because: string,
  nextAction: string,
  owner: Exclude<FoundationActor, 'NOBODY'>,
): FoundationFinding {
  return { dimension, verdict: 'BLOCKED', because, nextAction, owner };
}

function notApplicable(
  dimension: FoundationDimension,
  because: string,
): FoundationFinding {
  return { dimension, verdict: 'NOT_APPLICABLE', because, nextAction: null, owner: 'NOBODY' };
}

/**
 * Every intended human account, against every dimension.
 *
 * `SYSTEM` rows and disabled ones are left out for `people.ts`'s reason: a
 * screen asking about people gets people, and counting a deploy fixture as one
 * is the defect §34 already had to correct once. What is left out is reported
 * as a count rather than silently dropped.
 */
export async function foundationReading(): Promise<FoundationReading> {
  const all = await listUsers();
  const people = all.filter((one) => one.kind === 'PERSON' && one.disabledAt === null);

  /*
   * Read once, outside the loop.
   *
   * `contributedCapacity` walks every connection and the rows behind each, so
   * asking it per account would be that walk multiplied by the number of
   * accounts — for an answer that cannot differ between them. `onboard.ts`
   * hoisted the identical call for the identical reason.
   */
  const capacity = await contributedCapacity();

  /*
   * Display names, counted once, so the ambiguity check is a lookup rather
   * than a query per account.
   *
   * It is `ambiguousSignInNames` rather than a count written here, and that is
   * the merge obligation rather than a tidy-up. This counted `displayName`
   * verbatim across *every* row, on the stated reasoning that
   * `getPinCredentialByIdentity` did the same — which was exactly right about
   * the lookup as it was, and is false about the lookup now in both
   * directions. The door folds case, so *Caleb* and *caleb* are one identity
   * it refuses and this would have called two names and passed; and the door
   * skips disabled rows, so a retired account no longer makes a live person
   * unreachable and this would have told an administrator to rename somebody
   * when nothing was wrong.
   *
   * Either way round is a reading that contradicts the door, and the second is
   * the worse one: §27 records what a warning that cries wolf costs, and the
   * remedy this one names is a rename that would achieve nothing. One rule,
   * three readers — the lookup, the guard, and this.
   *
   * It still counts across every row rather than only the people above, and
   * the original reason is untouched: a SYSTEM row sharing a name still makes
   * the typed name resolve to two and therefore to none.
   */
  const nameCounts = ambiguousSignInNames(all);

  const accounts: AccountFoundation[] = [];
  for (const user of people) {
    const findings = await findingsFor(user, nameCounts, capacity);
    accounts.push({
      userId: user.id,
      displayName: withoutDomain(user.displayName),
      isBrainAdmin: user.isBrainAdmin,
      findings,
      verdict: findings.some((one) => one.verdict === 'BLOCKED') ? 'BLOCKED' : 'PASS',
    });
  }

  return {
    accounts,
    passing: accounts.filter((one) => one.verdict === 'PASS').length,
    blocked: accounts.filter((one) => one.verdict === 'BLOCKED').length,
    unattributed: await unattributedSurfaces(),
  };
}

/**
 * Every registered surface whose worker no account owns.
 *
 * A worker is owned when `ownership.ts` has resolved exactly one live
 * connection to it, which is the only evidence this Brain accepts — §22's rule
 * that an approver is not an owner, and `ownership.ts`'s that ambiguity is
 * null. A surface bound to a worker with no owner is capacity nobody's
 * foundation covers: it may be perfectly healthy and it cannot be attributed
 * to a person, so no account can be said to be contributing it.
 *
 * A `RETIRED` Routine is left out. It is already out of dispatch, which is one
 * of the two remedies, so naming it would be asking somebody to answer a
 * question that has been answered.
 */
async function unattributedSurfaces(): Promise<UnattributedSurface[]> {
  const routines = await listRoutines();
  const out: UnattributedSurface[] = [];

  for (const routine of routines) {
    if (routine.state === 'RETIRED') continue;
    if (routine.workerId === null) continue;
    const worker = await getWorker(routine.workerId);
    if (!worker || worker.archived) continue;
    if (worker.ownerUserId !== null) continue;

    out.push({
      routineId: routine.id,
      routineName: routine.name,
      workerId: worker.id,
      workerLabel: worker.label,
      enabled: routine.state === 'ENABLED',
      because:
        'This surface is bound to a worker identity no member’s connection resolves to, so ' +
        'the sessions it runs cannot be attributed to any account.',
      nextAction:
        'Adopt it by having its owner complete the connection journey and repointing the ' +
        'Routine to the worker that mints, or retire the surface with fleet set-state. ' +
        'Both are an operator’s decision; nothing here changes a live binding.',
    });
  }

  return out;
}

async function findingsFor(
  user: User,
  nameCounts: Map<string, number>,
  capacity: Awaited<ReturnType<typeof contributedCapacity>>,
): Promise<FoundationFinding[]> {
  const names = namesFor(user);
  const connection = await connectionForUser(user.id);
  const worker = await getWorkerByName(names.workerName);
  const routine = connection?.routineId ? await getRoutine(connection.routineId) : null;
  const surface = capacity.surfaces.find((one) => one.userId === user.id) ?? null;

  const findings: FoundationFinding[] = [];

  /* ------------------------------------------------------------- identity */

  const sharing = (nameCounts.get(signInName(user.displayName)) ?? 1) - 1;
  if (sharing > 0) {
    findings.push(
      blocked(
        'IDENTITY',
        `${sharing + 1} accounts share the display name “${withoutDomain(user.displayName)}”, so ` +
          'typing it at the sign-in screen resolves to none of them.',
        'Rename all but one of them, so the name identifies exactly one account.',
        'BRAIN_ADMINISTRATOR',
      ),
    );
  } else {
    findings.push(
      pass(
        'IDENTITY',
        'One account, named unambiguously, so the name resolves at the sign-in screen.',
      ),
    );
  }

  /* -------------------------------------------------------------- sign-in */

  const livePasskeys = await countLivePasskeys(user.id);
  if (user.pinUpdatedAt !== null) {
    findings.push(pass('SIGN_IN', 'A PIN is set, which is what the sign-in screen asks for.'));
  } else if (user.passwordUpdatedAt !== null) {
    /*
     * A password gets in, and is not the standard.
     *
     * `passwordDoorOpenFor` admits it only while the account has no proven
     * passkey, which is deliberately not the same condition as having no PIN —
     * the password is what `/recovery` takes, and closing it on a PIN would
     * remove the one route an administrator has back into their own Brain. So
     * this is a PASS on *can sign in* and a named gap on *signs in the way the
     * product intends*, rather than either alone.
     */
    findings.push(
      blocked(
        'SIGN_IN',
        'This account signs in with a password. It works, but the intended ordinary ' +
          'credential is a six-digit PIN, and the password stays only as the way back in.',
        /*
         * The exact address, because nothing links to it.
         *
         * `/recovery` is deliberately unlinked — an alternative credential on
         * the front door teaches everybody that this Brain has passwords — so
         * a remedy that said "the account page" would name a screen that does
         * not do this, which is the remedy-for-a-condition-that-was-never-true
         * defect §27 records.
         */
        'Open /recovery, sign in with the password, and set a six-digit PIN. The password ' +
          'keeps working for exactly that.',
        'MEMBER',
      ),
    );
  } else if (livePasskeys > 0) {
    findings.push(
      blocked(
        'SIGN_IN',
        'This account holds a passkey and no PIN. The served sign-in screen asks for a ' +
          'PIN and offers no way to present a device, so it cannot get in.',
        'Issue a recovery link from People & capacity; redeeming it ends in setting a PIN.',
        'BRAIN_ADMINISTRATOR',
      ),
    );
  } else {
    findings.push(
      blocked(
        'SIGN_IN',
        'This account holds no credential of any kind, so nobody can sign in as it.',
        'Issue an enrollment link from People & capacity; redeeming it ends in setting a PIN.',
        'BRAIN_ADMINISTRATOR',
      ),
    );
  }

  /* ---------------------------------------------------- claude connection */

  if (!connection) {
    findings.push(
      notApplicable(
        'CLAUDE_CONNECTION',
        'No connection has been started, so there is no lifecycle to be wrong about.',
      ),
    );
  } else if (connection.state === 'HEALTHY') {
    findings.push(
      pass('CLAUDE_CONNECTION', 'A session Brain fired arrived, was assigned work and finished it.'),
    );
  } else if (connection.state === 'REVOKED') {
    findings.push(
      blocked(
        'CLAUDE_CONNECTION',
        'This connection was taken back, so Brain does not fire it.',
        'Reconnect it from the connection page, which re-approves the same worker.',
        'MEMBER',
      ),
    );
  } else if (connection.state === 'MISBOUND') {
    findings.push(
      blocked(
        'CLAUDE_CONNECTION',
        'The registered surface is not the one this connection names, so its sessions ' +
          'would be attributed to another worker.',
        `Repoint it with: fleet repoint-worker --ref ${connection.triggerRef ?? '<trigger>'}`,
        'BRAIN_ADMINISTRATOR',
      ),
    );
  } else if (connection.state === 'WAITING_FOR_ADMIN') {
    findings.push(
      blocked(
        'CLAUDE_CONNECTION',
        `The surface is registered and ${connection.secretName} is not set in this deployment, ` +
          'so a fire would be refused.',
        `Set ${connection.secretName} in the deployment environment. Brain resumes by itself.`,
        'DEPLOYMENT_ADMINISTRATOR',
      ),
    );
  } else if (connection.state === 'INVITATION_REQUESTED') {
    findings.push(
      blocked(
        'CLAUDE_CONNECTION',
        'This member has asked for a connector link and has not been issued one.',
        'Issue the Claude connector link from the member list on People & capacity.',
        'BRAIN_ADMINISTRATOR',
      ),
    );
  } else {
    findings.push(
      blocked(
        'CLAUDE_CONNECTION',
        `The connection is at ${connection.state}, which is short of proven.`,
        'Open the connection page, which names the one step that is outstanding.',
        'MEMBER',
      ),
    );
  }

  /* --------------------------------------------------- worker attribution */

  if (!connection) {
    findings.push(
      notApplicable('WORKER_ATTRIBUTION', 'No connection, so no worker identity to attribute.'),
    );
  } else if (!worker) {
    findings.push(
      blocked(
        'WORKER_ATTRIBUTION',
        `No worker identity named ${names.workerName} exists yet, so nothing this member ` +
          'runs could be attributed to them.',
        'Issue the Claude connector link, which is what mints the identity.',
        'BRAIN_ADMINISTRATOR',
      ),
    );
  } else if (worker.archived) {
    findings.push(
      blocked(
        'WORKER_ATTRIBUTION',
        `This member’s worker identity is archived, which is terminal.`,
        'A Brain administrator resolves an archived identity; nothing in the flow can un-archive one.',
        'BRAIN_ADMINISTRATOR',
      ),
    );
  } else if (routine && routine.workerId !== null && routine.workerId !== worker.id) {
    findings.push(
      blocked(
        'WORKER_ATTRIBUTION',
        'The registered Routine is bound to a different worker, so this member’s sessions ' +
          'would be recorded as somebody else’s.',
        `Repoint it with: fleet repoint-worker --ref ${connection.triggerRef ?? '<trigger>'}`,
        'BRAIN_ADMINISTRATOR',
      ),
    );
  } else if (!routine) {
    findings.push(
      blocked(
        'WORKER_ATTRIBUTION',
        'A worker identity exists and no Routine is registered against it, so there is no ' +
          'surface whose sessions could be attributed.',
        'Submit the Routine’s trigger id on the connection page.',
        'MEMBER',
      ),
    );
  } else {
    findings.push(
      pass(
        'WORKER_ATTRIBUTION',
        'The registered surface is bound to this member’s own worker identity.',
      ),
    );
  }

  /* ------------------------------------------------------------- capacity */

  if (!connection) {
    findings.push(
      notApplicable('CAPACITY', 'No connection, so there is no capacity to be usable or not.'),
    );
  } else if (surface?.usable) {
    findings.push(pass('CAPACITY', 'The dispatcher would fire this surface.'));
  } else {
    findings.push(
      blocked(
        'CAPACITY',
        /*
         * The reason comes from `contribution.ts` rather than being restated.
         *
         * It is the module that decides usability, it already answers with the
         * remedy in the sentence, and a second wording here would eventually
         * describe a different rule from the one being applied.
         */
        surface?.because ?? 'This connection is not capacity the dispatcher would fire.',
        'Follow the reason above; the connection page names the same step.',
        'MEMBER',
      ),
    );
  }

  /* ------------------------------------------------------------- recovery */

  const retires = recoveryRetiresEverything({
    hasPin: user.pinUpdatedAt !== null,
    livePasskeys,
  });
  if (retires.complete) {
    findings.push(
      pass(
        'RECOVERY',
        'An administrator can issue a recovery link, and it retires everything this ' +
          'account currently holds before the replacement is redeemed.',
      ),
    );
  } else {
    findings.push(
      blocked(
        'RECOVERY',
        retires.because,
        retires.remedy,
        'BRAIN_ADMINISTRATOR',
      ),
    );
  }

  return findings;
}
