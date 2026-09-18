/**
 * Connecting one member's Claude account to this Brain, end to end.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * An enrolled member had no self-contained path to contributing a Routine.
 * Everything needed to do it existed — a worker invitation, an OAuth consent
 * screen, `fleet register-account`, `fleet register-routine`, `fleet
 * bind-worker`, a deployment secret, `verify-surface --probe` — and every one of
 * them lived either on a terminal or in somebody's memory of a conversation. So
 * the honest description of the old state is that a friend could not connect
 * their account without asking the owner for instructions that had never been
 * written down.
 *
 * ---------------------------------------------------------------------------
 * The shape, and the one thing Brain cannot do
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/fire.ts` resolves a Routine's bearer with
 * `process.env[secretName]`. That is a **deployment secret**, and nothing in
 * this repository can write one — not a route, not a tick, not an
 * administrator's session. The credential model was traced before this was
 * built precisely so that no second, weaker registration route would be
 * invented beside it: there is no column here that could hold a token, and
 * `fleet_routines` keeps only the *name* of the variable and a digest taken
 * once at registration.
 *
 * So one step of nine belongs to a Brain administrator with deployment access,
 * and the design is arranged around that rather than against it:
 *
 *   * the member does every non-privileged step and is told exactly where they
 *     are — **Waiting for administrator**, not a vague failure;
 *   * the administrator is shown one exact remaining action: this app, this
 *     secret name, this value, entered where deployment secrets are entered;
 *   * once it is set, Brain resumes from rows. Neither person repeats anything.
 *
 * The friend is never told to open Fly, and is never given access to the
 * owner's organisation. They read a trig_… id out of their own Claude account
 * and paste it here; the bearer that goes with it is handled by whoever already
 * holds deployment access, through the channel they already use.
 *
 * ---------------------------------------------------------------------------
 * What HEALTHY means, and what it does not
 * ---------------------------------------------------------------------------
 *
 * Not "a trigger id exists". Not "a secret is set". §32 and §23 both say the
 * same thing and this obeys it: a registered surface with a credential is
 * **CONFIGURED**, and it becomes HEALTHY only when `proveSurface`'s four rows
 * are all present — Brain fired it, a session arrived and was attributed to the
 * bound worker from that same dispatch row, it was handed a bin, and the bin
 * reached `COMPLETE`. The probe is what creates something to be fired for; the
 * chain is what is read afterwards; and nothing here writes HEALTHY from
 * anything a member typed.
 *
 * ---------------------------------------------------------------------------
 * Resumability
 * ---------------------------------------------------------------------------
 *
 * Every transition is a guarded `UPDATE` naming the state it moves from, and
 * every derived state is re-read from rows rather than remembered. A refresh
 * resumes; a restart resumes; two tabs produce one effect; re-submitting the
 * same trigger id is the same outcome as submitting it once. A failed probe is
 * retried against the **same** connection, the same account and the same
 * Routine — nothing is created twice, which is the property a person retrying
 * something after an error most needs and most rarely gets.
 */
import {
  attachProbe,
  claimProbe,
  connectionForUser,
  ensureConnection,
  moveConnection,
  releaseProbeClaim,
  setRegistration,
  setTrigger,
} from '../../repos/capacityConnections.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  getAccountByName,
  getRoutine,
  getRoutineByRef,
  sessionsForRoutine,
} from '../../repos/fleet.ts';
import {
  createWorker,
  getWorkerByName,
  grantMembership,
  recordIdentityEvent,
} from '../../repos/identity.ts';
import { listTokensForWorker } from '../../repos/oauth.ts';
import { createInvitation, revokeInvitationsForWorker } from '../../repos/invitations.ts';
import { generateInvitationToken } from '../identity/secrets.ts';
import { getBin, listDispatchesForBin } from '../../repos/bins.ts';
import { resolveToken } from '../dispatch/fire.ts';
import { proveSurface } from '../dispatch/surfaceProof.ts';
import { createProbeBin, ProbeRefused } from '../fleet/probe.ts';
import { findCashRoot } from '../cash/root.ts';
import { CONNECTOR_SCOPES } from '../../domain/types.ts';
import type {
  Bin,
  BinDispatch,
  CapacityConnection,
  CapacityConnectionState,
  User,
} from '../../domain/types.ts';

/**
 * The connector the member registers in Claude, the Routine they create, and
 * the deployment secret whose value goes with it.
 *
 * Derived from the person's own id so nobody has to invent a name and two
 * members cannot choose the same one. The secret name is upper-cased and
 * stripped to what an environment variable may contain, because it is pasted
 * into a deployment console by hand and a name that needed quoting would be a
 * name somebody got wrong.
 */
export function namesFor(user: Pick<User, 'id' | 'displayName'>): {
  connectorName: string;
  routineName: string;
  secretName: string;
  workerName: string;
} {
  const slug = user.displayName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 24);
  // The id's own suffix, so two people called Alex get two distinct names
  // without anybody being asked to disambiguate themselves.
  const tail = user.id.replace(/^usr_/, '').slice(0, 6);
  const base = slug.length > 0 ? `${slug}-${tail}` : tail;
  return {
    connectorName: `Brain (${user.displayName})`,
    routineName: `Brain Research — ${user.displayName}`,
    secretName: `BRAIN_ROUTINE_TOKEN_${base.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
    workerName: `research-${base}`,
  };
}

/** The MCP endpoint a connector is pointed at. Built from the request's origin. */
export function mcpUrlFor(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

export interface ConnectionStep {
  key: string;
  title: string;
  /** What to do, in the words the person doing it needs. */
  detail: string;
  /** A value to copy verbatim, each in its own box. Never a credential. */
  copy?: { label: string; value: string }[];
  state: 'DONE' | 'NOW' | 'LATER' | 'ADMINISTRATOR';
}

export interface ConnectionView {
  connection: CapacityConnection;
  /** Where this is, in one word a person can act on. */
  state: CapacityConnectionState;
  /** One sentence: what is happening, or what is wrong and what fixes it. */
  headline: string;
  /** The one thing to do next, or null when there is nothing. */
  nextAction: string | null;
  steps: ConnectionStep[];
  /** Whether the deployment secret is present. Never its value. */
  secretPresent: boolean;
  /** Whether a connector of theirs has ever authenticated as this worker. */
  connectorAuthenticated: boolean;
  /** The four-row chain, when it is closed. */
  proven: { sessionRef: string; binId: string; observedAt: string } | null;
  /** Shown exactly once, at issue. Absent on every subsequent read. */
  invitationUrl?: string;
  invitationExpiresAt?: string;
}

/* ------------------------------------------------------------------------ */
/* Deriving where a connection actually is                                   */
/* ------------------------------------------------------------------------ */

async function provenChainFor(routineId: string, workerId: string, routineRef: string): Promise<{
  chain: { sessionRef: string; binId: string; observedAt: string } | null;
  arrivals: number;
}> {
  const sessions = await sessionsForRoutine(routineId, 20);
  const bins = new Map<string, Bin | null>();
  const dispatches = new Map<string, readonly BinDispatch[]>();
  for (const session of sessions) {
    if (!bins.has(session.binId)) bins.set(session.binId, await getBin(session.binId));
    if (!dispatches.has(session.binId)) {
      dispatches.set(session.binId, await listDispatchesForBin(session.binId));
    }
  }
  const proof = proveSurface({ boundWorkerId: workerId, routineRef, sessions, bins, dispatches });
  return {
    chain: proof.chain
      ? { sessionRef: proof.chain.sessionRef, binId: proof.chain.binId, observedAt: proof.chain.observedAt }
      : null,
    arrivals: sessions.length,
  };
}

/**
 * Bring the stored state into line with what the rows say, once.
 *
 * Derived on the read path rather than hooked to the moment something changed,
 * which is the distinction this repository has needed four times: a derivation
 * reaches the connections already stranded, survives a tick that died halfway,
 * and cannot be missed by a code path that forgot to call a hook.
 *
 * Every move is a compare-and-swap naming the state it came from, so a
 * concurrent administrator action and a concurrent read produce one transition.
 * It never moves a connection *backwards* out of HEALTHY: a surface that has
 * been proven stays proven, because the chain it was proven by is history and
 * history does not stop having happened.
 */
async function reconcile(connection: CapacityConnection): Promise<CapacityConnection> {
  if (connection.state === 'HEALTHY') return connection;

  if (!connection.routineId) return connection;
  const routine = await getRoutine(connection.routineId);
  if (!routine) return connection;

  const secretPresent = resolveToken(routine.tokenSecretName) !== null;
  if (!secretPresent) {
    if (connection.state !== 'WAITING_FOR_ADMIN') {
      await moveConnection({
        connectionId: connection.id,
        from: connection.state,
        to: 'WAITING_FOR_ADMIN',
      });
    }
    return (await connectionForUser(connection.userId)) ?? connection;
  }

  if (!routine.workerId) return connection;
  const { chain, arrivals } = await provenChainFor(routine.id, routine.workerId, routine.routineRef);

  let target: CapacityConnectionState;
  if (chain) target = 'HEALTHY';
  else if (arrivals > 0) target = 'ARRIVED';
  else if (connection.probeBinId) target = 'PROBE_SENT';
  else target = 'CONFIGURED';

  if (target !== connection.state) {
    await moveConnection({
      connectionId: connection.id,
      from: connection.state,
      to: target,
      healthy: target === 'HEALTHY',
    });
  }
  return (await connectionForUser(connection.userId)) ?? connection;
}

/* ------------------------------------------------------------------------ */
/* The journey, as steps                                                     */
/* ------------------------------------------------------------------------ */

function stepsFor(input: {
  connection: CapacityConnection;
  origin: string;
  secretPresent: boolean;
  connectorAuthenticated: boolean;
  proven: boolean;
  arrived: boolean;
}): ConnectionStep[] {
  const { connection, origin } = input;
  const hasTrigger = connection.triggerRef !== null;
  const registered = connection.routineId !== null;

  const done = (when: boolean): ConnectionStep['state'] => (when ? 'DONE' : 'LATER');

  return [
    {
      key: 'CONNECTOR',
      title: 'Add Brain as a custom connector in Claude',
      detail:
        'In Claude, open Settings → Connectors → Add custom connector. Give it the name below ' +
        'and the URL below. Claude will send you to a Brain page to approve it; sign in there ' +
        'with your passkey and approve. Nothing about your Claude account reaches Brain — it ' +
        'stores a token it minted itself, against a worker it owns.',
      copy: [
        { label: 'Connector name', value: connection.connectorName },
        { label: 'MCP URL', value: mcpUrlFor(origin) },
      ],
      state: input.connectorAuthenticated ? 'DONE' : 'NOW',
    },
    {
      key: 'ROUTINE',
      title: 'Create the Routine',
      detail:
        'In Claude, create a Routine with the name below. Attach the bootstrap repository so ' +
        'the session finds its permissions, enable the connector you just added, and leave ' +
        'scheduling OFF — Brain fires it on demand and a timer beside that would start ' +
        'sessions nobody asked for. Then open the Routine’s API trigger and copy the ' +
        'trigger id (it begins trig_).',
      copy: [
        { label: 'Routine name', value: connection.routineName },
        { label: 'Repository to attach', value: BOOTSTRAP_REPOSITORY },
        { label: 'Connector to enable', value: connection.connectorName },
        { label: 'Schedule', value: 'off — no cron' },
      ],
      state: input.connectorAuthenticated ? (hasTrigger ? 'DONE' : 'NOW') : 'LATER',
    },
    {
      key: 'TRIGGER',
      title: 'Paste the trigger id here',
      detail:
        'The trigger id is an address rather than a secret: holding it lets Brain start your ' +
        'Routine and nothing else. Pasting the same one twice is the same as pasting it once.',
      ...(hasTrigger ? { copy: [{ label: 'Recorded trigger', value: connection.triggerRef! }] } : {}),
      state: hasTrigger ? 'DONE' : input.connectorAuthenticated ? 'NOW' : 'LATER',
    },
    {
      key: 'SECRET',
      title: 'A Brain administrator adds the trigger credential',
      detail:
        'Claude shows the trigger’s bearer once, beside the trigger id. It is a credential, ' +
        'so it goes into the deployment environment rather than into Brain’s database — ' +
        'Brain reads it from there and stores only this variable’s name and a digest. Send ' +
        'the value to a Brain administrator through whatever private channel you already use; ' +
        'you do not need access to the deployment and will never be asked for one.',
      copy: [{ label: 'Secret name to set', value: connection.secretName }],
      state: input.secretPresent ? 'DONE' : registered ? 'ADMINISTRATOR' : 'LATER',
    },
    {
      key: 'PROBE',
      title: 'Brain sends one bounded self-test',
      detail:
        'A single deterministic check: Brain fires your Routine, the session authenticates, is ' +
        'handed the check and returns one hash. It touches no document, no repository and no ' +
        'money, and it is what turns a configured surface into a proven one.',
      state: input.proven
        ? 'DONE'
        : connection.probeBinId
          ? input.arrived
            ? 'DONE'
            : 'NOW'
          : done(false),
    },
    {
      key: 'HEALTHY',
      title: 'Healthy',
      detail:
        'A session Brain fired arrived, authenticated as your worker, was handed a piece of ' +
        'work and finished it. That is the whole of what HEALTHY means here — a trigger id and ' +
        'a credential existing is CONFIGURED, which is a different word on purpose.',
      state: input.proven ? 'DONE' : 'LATER',
    },
  ];
}

/**
 * The repository a Routine attaches so its worker finds its permissions.
 *
 * §22 records why: a fired worker reads `.claude/settings.json` from the
 * repository its Routine attaches, and that file's `permissions.allow` is what
 * pre-approves the connector's tools. Without it the session stops at a
 * permission prompt nobody is there to answer. It is named here because a
 * member who had to be told this in a conversation is a member who cannot
 * finish on their own.
 */
export const BOOTSTRAP_REPOSITORY = 'brain-worker-bootstrap';

function headlineFor(connection: CapacityConnection, secretPresent: boolean): {
  headline: string;
  nextAction: string | null;
} {
  switch (connection.state) {
    case 'NOT_STARTED':
      return {
        headline: 'Your Claude account is not connected yet.',
        nextAction: 'Add Brain as a custom connector in Claude and approve it.',
      };
    case 'CONNECTOR_AUTHORIZED':
    case 'ROUTINE_DETAILS_NEEDED':
      return {
        headline: 'Your connector is authorized. Brain needs your Routine’s trigger id.',
        nextAction: 'Create the Routine in Claude and paste its trigger id here.',
      };
    case 'WAITING_FOR_ADMIN':
      return {
        headline:
          'Everything you can do is done. Brain is waiting for an administrator to add your ' +
          'trigger’s credential to the deployment.',
        nextAction: null,
      };
    case 'CONFIGURED':
      return {
        headline:
          secretPresent
            ? 'Your surface is registered and Brain can fire it. Nothing has come back from it yet.'
            : 'Your surface is registered and its credential is not in the deployment yet.',
        nextAction: 'Send the bounded self-test, which is what proves it works.',
      };
    case 'PROBE_SENT':
      return {
        headline: 'A self-test is waiting for your Routine to answer it.',
        nextAction: null,
      };
    case 'ARRIVED':
      return {
        headline:
          'A session Brain fired arrived and authenticated, and has not finished a piece of ' +
          'work here yet.',
        nextAction: null,
      };
    case 'HEALTHY':
      return { headline: 'Connected and proven.', nextAction: null };
    default:
      return {
        headline: connection.failureReason ?? 'Something needs a person.',
        nextAction: connection.failureReason,
      };
  }
}

/* ------------------------------------------------------------------------ */
/* Reading                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * One member's connection as it stands, creating the row if they have none.
 *
 * Creating is safe on a read because it is the *assignment of three names* and
 * nothing else — no account, no Routine, no worker, no credential, no fire. A
 * person opening the page has to be told which connector name and which secret
 * name are theirs, and a name that changed between two reads would be a name
 * somebody had already pasted somewhere.
 */
export async function connectionView(input: {
  user: User;
  origin: string;
}): Promise<ConnectionView> {
  const names = namesFor(input.user);
  let connection = await ensureConnection({
    userId: input.user.id,
    connectorName: names.connectorName,
    routineName: names.routineName,
    secretName: names.secretName,
  });

  /*
   * Has a connector of theirs ever authenticated as their worker?
   *
   * Read from `oauth_tokens` for the worker this connection's identity is, and
   * never from anything the member said. A token that exists and has been used
   * is what "the connector is authorized" actually means, and it is the one
   * step of theirs Brain can observe rather than be told about.
   */
  const worker = await getWorkerByName(names.workerName);
  const tokens = worker ? await listTokensForWorker(worker.id) : [];
  const connectorAuthenticated = tokens.some((token) => token.lastUsedAt !== null);

  if (connection.state === 'NOT_STARTED' && connectorAuthenticated) {
    await moveConnection({
      connectionId: connection.id,
      from: 'NOT_STARTED',
      to: 'CONNECTOR_AUTHORIZED',
    });
    connection = (await connectionForUser(input.user.id)) ?? connection;
  }

  connection = await reconcile(connection);

  const routine = connection.routineId ? await getRoutine(connection.routineId) : null;
  const secretPresent = routine ? resolveToken(routine.tokenSecretName) !== null : false;
  const proof =
    routine && routine.workerId
      ? await provenChainFor(routine.id, routine.workerId, routine.routineRef)
      : { chain: null, arrivals: 0 };

  const { headline, nextAction } = headlineFor(connection, secretPresent);
  return {
    connection,
    state: connection.state,
    headline,
    nextAction,
    secretPresent,
    connectorAuthenticated,
    proven: proof.chain,
    steps: stepsFor({
      connection,
      origin: input.origin,
      secretPresent,
      connectorAuthenticated,
      proven: proof.chain !== null,
      arrived: proof.arrivals > 0,
    }),
  };
}

/* ------------------------------------------------------------------------ */
/* Acting                                                                    */
/* ------------------------------------------------------------------------ */

export type ConnectionOutcome =
  | { ok: true; view: ConnectionView }
  | { ok: false; reason: string };

/**
 * Mint this member's worker identity and hand back the one-time invitation that
 * lets their Claude connector authenticate as it.
 *
 * `onboardRepository`'s shape, for `connectSite`'s reason: the identity, the
 * membership and the scope set are written from constants, so there is nothing
 * to get silently wrong — and a worker given the wrong scopes is refused by
 * every route with the same 404 a missing project gives, which tells nobody
 * anything.
 *
 * Idempotent by identity: asking twice reuses the worker, rewrites the
 * membership from the constant and **replaces** the invitation rather than
 * adding a second one, so there is never more than one live link to reason
 * about. It is a repair and a rotation as much as a setup.
 *
 * It issues no bearer of any kind. What comes back is a single-use expiring
 * invitation which on its own cannot read anything, call a tool or obtain a
 * token — the consent screen is where a person authorizes it.
 */
export async function issueConnectorInvitation(input: {
  user: User;
  actor: User;
  origin: string;
}): Promise<ConnectionOutcome> {
  const names = namesFor(input.user);
  const root = await findCashRoot();
  if (!root) {
    return {
      ok: false,
      reason:
        'There is no shared frontier for a research worker to be a member of yet. A Brain ' +
        'administrator starts Cash Mode, and this can be picked up straight afterwards.',
    };
  }

  const existing = await getWorkerByName(names.workerName);
  if (existing?.archived) {
    return {
      ok: false,
      reason:
        `The identity for this member (${names.workerName}) was archived, which is terminal. ` +
        'A Brain administrator resolves that; nothing here can un-archive an identity.',
    };
  }

  const worker =
    existing ??
    (await createWorker({
      name: names.workerName,
      displayName: `Research · ${input.user.displayName}`,
      workerType: 'MCP',
      description: `Research capacity contributed by ${input.user.displayName}.`,
      createdByType: 'HUMAN',
      createdById: input.actor.id,
    }));

  await grantMembership({
    projectId: root.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: [...CONNECTOR_SCOPES],
    grantedByType: 'HUMAN',
    grantedById: input.actor.id,
  });

  await revokeInvitationsForWorker(worker.id);
  const token = generateInvitationToken();
  const invitation = await createInvitation({
    workerId: worker.id,
    tokenPrefix: token.prefix,
    tokenDigest: token.digest,
    createdByUserId: input.actor.id,
    note: `Connecting ${input.user.displayName}'s Claude account as research capacity.`,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actor.id,
    action: 'ISSUE_WORKER_INVITATION',
    targetType: 'WORKER',
    targetId: worker.id,
    projectId: root.id,
    result: 'SUCCESS',
    // The invitation *id*, never the token. §27's rule at a new door.
    metadata: { invitationId: invitation.id, forUserId: input.user.id },
  });

  const view = await connectionView({ user: input.user, origin: input.origin });
  return {
    ok: true,
    view: {
      ...view,
      invitationUrl: `${input.origin.replace(/\/+$/, '')}/oauth/invite/${token.plaintext}`,
      invitationExpiresAt: invitation.expiresAt,
    },
  };
}

const TRIGGER_PATTERN = /^trig_[A-Za-z0-9]{10,64}$/;

/**
 * Record the trigger, register the surface, and say what is left.
 *
 * Idempotent by the trigger: submitting the same id twice registers one account
 * and one Routine, and the second call reports the state the first produced.
 * That is the property a person retrying after a timeout most needs —
 * idempotency means the effect is present after either call, not that the
 * second call does nothing.
 *
 * It does **not** make anything healthy. Registration produces a routable row
 * whose credential may not be deployed yet, which is `WAITING_FOR_ADMIN`; the
 * probe and the chain are what move it past that.
 */
export async function submitTrigger(input: {
  user: User;
  actor: User;
  triggerRef: string;
  origin: string;
}): Promise<ConnectionOutcome> {
  const triggerRef = input.triggerRef.trim();
  if (!TRIGGER_PATTERN.test(triggerRef)) {
    return {
      ok: false,
      reason:
        'That is not a Routine trigger id. Claude shows it beside the Routine’s API ' +
        'trigger and it begins with trig_. Paste the id, never the credential printed next ' +
        'to it — that one goes to an administrator, and Brain will refuse to store it.',
    };
  }

  const names = namesFor(input.user);
  const connection = await ensureConnection({
    userId: input.user.id,
    connectorName: names.connectorName,
    routineName: names.routineName,
    secretName: names.secretName,
  });

  /*
   * Somebody else's trigger, refused before anything is written.
   *
   * The unique index would refuse it anyway; naming it here is what turns a
   * constraint violation into a sentence a person can act on. Two members
   * cannot share a Routine: Brain would fire one surface and attribute its
   * sessions to whichever worker the connector actually resolves to, and §27
   * records at length what a surface wearing somebody else's identity costs.
   */
  const claimed = await getRoutineByRef(triggerRef);
  if (claimed && claimed.id !== connection.routineId) {
    return {
      ok: false,
      reason:
        'That trigger is already registered to another surface in this Brain. If it is yours, ' +
        'a Brain administrator can repoint it; if it is not, create your own Routine and use ' +
        'its trigger id.',
    };
  }

  /*
   * A different trigger is refused **before** anything is written.
   *
   * The first version wrote first and refused on a lost compare-and-swap, and
   * the swap was guarded on the *state* rather than on the trigger — so a
   * submission naming a different id matched, succeeded, and replaced a
   * recorded trigger while the refusal below could never fire. Once a Routine
   * is registered that leaves this row and `fleet_routines.routine_ref`
   * disagreeing, which is Brain firing one surface while its own record names
   * another. A refusal after a successful write is not a refusal.
   */
  if (connection.triggerRef !== null && connection.triggerRef !== triggerRef) {
    return {
      ok: false,
      reason:
        'This connection already names a different trigger. A Brain administrator repoints a ' +
        'registered surface; replacing one silently would leave sessions attributed to a ' +
        'Routine that is no longer the one being fired.',
    };
  }

  if (connection.triggerRef === null) {
    /*
     * A compare-and-swap on `trigger_ref IS NULL`. Losing it means another tab
     * recorded the same id first, which is the outcome this call wanted — so
     * there is nothing to report and nothing to retry.
     */
    await setTrigger({ connectionId: connection.id, triggerRef, to: 'ROUTINE_DETAILS_NEEDED' });
  }

  const current = (await connectionForUser(input.user.id))!;

  if (!current.routineId) {
    /*
     * One account per contributing member, because an account is what carries a
     * subscription allowance and each member brings their own. §23's first
     * distinction: an account is not a Routine, and two Routines under one
     * account share one allowance however fast they can be fired.
     */
    const accountName = `member-${names.workerName.replace(/^research-/, '')}`;
    const account =
      (await getAccountByName(accountName)) ??
      (await createAccount({
        name: accountName,
        kind: 'CAPACITY',
        planLabel: 'contributed',
        // A label the router never does arithmetic on. Nobody has measured this
        // account's throughput, so `unknown` is the honest value and stays one.
        declaredPlanPower: 'unknown',
      }));

    const worker = await getWorkerByName(names.workerName);
    if (!worker) {
      return {
        ok: false,
        reason:
          'Your worker identity has not been created yet, so a Routine registered now could be ' +
          'bound to nothing. Ask a Brain administrator to issue your connector invitation first ' +
          '— your trigger id is recorded and you will not be asked for it again.',
      };
    }

    const routine =
      claimed ??
      (await createRoutine({
        accountId: account.id,
        routineRef: triggerRef,
        name: current.routineName,
        tokenSecretName: current.secretName,
        workerId: worker.id,
      }));
    if (claimed && claimed.workerId === null) await bindRoutineWorker(claimed.id, worker.id);

    await setRegistration({
      connectionId: current.id,
      accountId: account.id,
      routineId: routine.id,
      state: 'WAITING_FOR_ADMIN',
    });
  }

  return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
}

/**
 * Send the one bounded self-test, or say why it cannot be sent yet.
 *
 * Reuses the connection's existing account, Routine and worker — retrying a
 * failed probe creates no second anything. The bin it makes is
 * `SURFACE_PROBE_RESEARCH_V1`, belongs to no campaign, forbids every external
 * effect, and is picked up by the ordinary dispatcher tick through the ordinary
 * routing: nothing here fires a Routine directly.
 */
export async function sendProbe(input: {
  user: User;
  actor: User;
  origin: string;
}): Promise<ConnectionOutcome> {
  const connection = await connectionForUser(input.user.id);
  if (!connection?.routineId) {
    return { ok: false, reason: 'There is no registered surface here to test yet.' };
  }
  const routine = await getRoutine(connection.routineId);
  if (!routine?.workerId) {
    return { ok: false, reason: 'This surface is bound to no worker identity, so nothing could be handed to it.' };
  }
  if (resolveToken(routine.tokenSecretName) === null) {
    return {
      ok: false,
      reason:
        `Brain has no credential for this Routine yet, so firing it would spend an activation to ` +
        `be refused. A Brain administrator sets ${routine.tokenSecretName} in the deployment and ` +
        'this can be sent straight afterwards — nothing already done has to be redone.',
    };
  }

  /*
   * A live probe is not replaced.
   *
   * Pressing the button twice must make one bin: a second would be a second
   * activation against the same surface for the same question, which is exactly
   * the double fire the whole dispatch design exists to prevent.
   */
  if (connection.probeBinId) {
    const bin = await getBin(connection.probeBinId);
    if (bin && bin.state !== 'CANCELLED' && bin.state !== 'FAILED' && bin.state !== 'NEEDS_HUMAN') {
      return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
    }
  }

  /*
   * **Claim, then act.** §24's own rule, and the check above is not a substitute
   * for it: two concurrent presses both read a connection with no live probe,
   * and a version that created the bin first would build two and then discover
   * that one of them had lost the swap. The bin is the effect, so the guard has
   * to be on the far side of nothing.
   *
   * The window this opens loses a *claim* rather than an effect — `PROBE_SENT`
   * with no bin derives straight back to `CONFIGURED` on the next read, because
   * the read path maps the bin's presence rather than remembering a state.
   */
  if (!(await claimProbe({ connectionId: connection.id, from: connection.state }))) {
    return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
  }

  let binId: string;
  try {
    binId = await createProbeBin({
      worker: { id: routine.workerId, name: routine.name },
      repositories: [],
      routine: { id: routine.id, name: routine.name, capabilities: routine.capabilities },
      family: 'RESEARCH',
      createdByType: 'HUMAN',
      createdById: input.actor.id,
    });
  } catch (error: unknown) {
    await releaseProbeClaim({ connectionId: connection.id, to: connection.state });
    if (error instanceof ProbeRefused) return { ok: false, reason: error.message };
    throw error;
  }

  await attachProbe({ connectionId: connection.id, binId });
  return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
}
