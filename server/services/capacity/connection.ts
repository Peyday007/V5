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
  connectionForUser,
  ensureConnection,
  moveConnection,
  reconnectConnection,
  recordInvitationIssued,
  releaseProbe,
  requestInvitation,
  revokeConnection,
  setRegistration,
  setTrigger,
} from '../../repos/capacityConnections.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  getAccount,
  getAccountByName,
  getRoutine,
  getRoutineByRef,
  sessionsForRoutine,
  setRoutineState,
} from '../../repos/fleet.ts';
import {
  createWorker,
  getWorker,
  getWorkerByName,
  grantMembership,
  listMembershipsForPrincipal,
  recordIdentityEvent,
} from '../../repos/identity.ts';
import {
  getClientByClientId,
  listTokensForWorker,
  revokeTokensForWorker,
} from '../../repos/oauth.ts';
import { getProject } from '../../repos/projects.ts';
import { nowIso } from '../../repos/util.ts';
import { createInvitation, revokeInvitationsForWorker } from '../../repos/invitations.ts';
import { generateInvitationToken } from '../identity/secrets.ts';
import { withoutDomain } from '../identity/people.ts';
import { getBin, listDispatchesForBin, markBinReady, retireBin } from '../../repos/bins.ts';
import { resolveToken } from '../dispatch/fire.ts';
import { proveSurface } from '../dispatch/surfaceProof.ts';
import { createProbeBin, ProbeRefused } from '../fleet/probe.ts';
import { findCashRoot } from '../cash/root.ts';
import { CONNECTOR_SCOPES } from '../../domain/types.ts';
import { workerIdentity } from '../identity/authenticate.ts';
import type {
  Bin,
  BinDispatch,
  CapacityConnection,
  CapacityConnectionState,
  OAuthToken,
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
  /*
   * An address must not become a connector name, a Routine name or — worst of
   * the three — a deployment secret's name, which is deliberately visible to
   * whoever sets it and ends up in the app's own configuration. `bootstrap.ts`
   * names the first administrator after the address it was created with, so
   * this is not hypothetical: it would have produced
   * `BRAIN_ROUTINE_TOKEN_ROSSERPEYTON_GMAIL_COM_…`. The same redaction the
   * People reading applies, at the one place these names are minted.
   *
   * Existing rows keep the names they were written with — `ensureConnection`
   * is `ON CONFLICT DO NOTHING` — so this changes nothing already registered.
   */
  const shown = withoutDomain(user.displayName);
  const slug = shown
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
    connectorName: `Brain (${shown})`,
    routineName: `Brain Research — ${shown}`,
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

/**
 * One thing Brain actually read, and what it found.
 *
 * This is the verification, and it is deliberately not a single boolean: *the
 * connector has never authenticated*, *the credential is not deployed* and
 * *nothing Brain fired has ever come back* are three different facts with three
 * different remedies, and one word covering all of them sends somebody to fix
 * the wrong thing.
 *
 * Every check is a read of rows Brain wrote — the worker identity, the project
 * membership, the OAuth tokens minted against that worker, the registered
 * Routine and its bound worker, the deployment variable's presence, and
 * `proveSurface`'s four-row chain. Nothing here is a claim a caller made about
 * itself, which is the same rule `brain_whoami` answers under: the principal
 * comes from the credential and the rest comes from rows.
 *
 * `PENDING` is a third answer on purpose. *Nothing has happened yet* and
 * *something is wrong* have different remedies, and a check that reported the
 * first as a failure would make a healthy half-finished setup read as broken.
 */
export interface ConnectionCheck {
  key:
    | 'IDENTITY'
    | 'MEMBERSHIP'
    | 'AUTHORIZATION'
    | 'TRIGGER'
    | 'CREDENTIAL'
    | 'BINDING'
    | 'PROVEN';
  title: string;
  state: 'PASS' | 'FAIL' | 'PENDING';
  /** What was read. Never a credential, and never another member's surface. */
  detail: string;
  /** What to do about it. Always set when the state is not PASS. */
  remedy: string | null;
}

/**
 * Who this connection is, as far as Brain is concerned.
 *
 * **Nothing about the Claude account is in here, and that is §22 rather than an
 * omission.** Brain never learns a Claude handle, address, password, cookie or
 * session; what it holds is a worker it minted itself and a token it issued
 * against that worker on the authority of a person it authenticated. The
 * closest thing to a "Claude display name" that genuinely exists is
 * `connectorClientName` — the name the connector registered *itself* with when
 * it called `/oauth/register` — so that is what is reported, labelled as what
 * it is.
 */
export interface ConnectionIdentity {
  /** The worker Brain fires as. A name and an id, never a credential. */
  workerName: string;
  workerId: string | null;
  /** What the OAuth client called itself at registration, once one has connected. */
  connectorClientName: string | null;
  /** The project this worker is a member of, and the scopes that membership carries. */
  membership: { projectId: string; projectName: string; scopes: string[] } | null;
  /** The surface Brain fires and the capacity account it sits under. */
  routineName: string | null;
  accountName: string | null;
  /** The live authorization, when there is one. Never a token and never a digest. */
  authorization: {
    live: boolean;
    everUsed: boolean;
    lastUsedAt: string | null;
    /** The furthest-out expiry among the live tokens. */
    expiresAt: string | null;
  };
  /** When the four-row chain was last found complete. */
  lastVerifiedAt: string | null;
}

/**
 * The controls, every one of them, in one order, for every account.
 *
 * **The list never changes shape.** A control a particular reader may not use
 * is present and `enabled: false` with the server's own sentence for why —
 * because a screen that *removes* a control is a screen two accounts cannot be
 * compared on, and because "there is no button" and "the button is not for you"
 * are answers a person reads very differently. §29's rule that a status must
 * agree with the control beside it, applied to the control itself.
 */
export interface ConnectionControl {
  key:
    | 'REQUEST_INVITATION'
    | 'SUBMIT_TRIGGER'
    | 'SEND_PROBE'
    | 'VERIFY'
    | 'REVOKE'
    | 'RECONNECT';
  label: string;
  enabled: boolean;
  /** Why not. Always set when `enabled` is false, and never set when it is true. */
  disabledReason: string | null;
}

/** A likely failure, what it means, and what to do about it. */
export interface TroubleshootingEntry {
  symptom: string;
  meaning: string;
  remedy: string;
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
  /** What Brain read, and what it found. The verification, item by item. */
  checks: ConnectionCheck[];
  /** Who this is, to Brain. Never anything about the Claude account itself. */
  identity: ConnectionIdentity;
  /** Every control, always, with the server's reason when one is unavailable. */
  controls: ConnectionControl[];
  /** The same reference list for everybody. It describes the mechanism. */
  troubleshooting: TroubleshootingEntry[];
  /** Whether the deployment secret is present. Never its value. */
  secretPresent: boolean;
  /** Whether a live connector of theirs has authenticated as this worker. */
  connectorAuthenticated: boolean;
  /**
   * A connector authenticated once and holds nothing live now.
   *
   * Reported beside the state rather than as one: proof is history and does not
   * stop having happened, so a HEALTHY surface whose authorization has lapsed
   * is still HEALTHY *and* still needs reconnecting. Two facts, two fields.
   */
  authorizationExpired: boolean;
  /** The four-row chain, when it is closed. */
  proven: { sessionRef: string; binId: string; observedAt: string } | null;
  /** Shown exactly once, at issue. Absent on every subsequent read. */
  invitationUrl?: string;
  invitationExpiresAt?: string;
}

/**
 * What goes wrong, what it means, and what to do — the same list for everybody.
 *
 * It is a constant rather than a derivation because it describes the
 * *mechanism* rather than this connection: the five failures below are the ones
 * the flow can actually produce, and a reader hitting one needs the whole list
 * to recognise which they are in. Deriving it per state would mean two accounts
 * at two steps reading two different documents about one system, which is the
 * drift this whole surface is arranged to prevent.
 */
export const CONNECTION_TROUBLESHOOTING: readonly TroubleshootingEntry[] = [
  {
    symptom: 'Claude says a connector with this URL already exists in your organization.',
    meaning:
      'Claude keys its connector registry by URL, so one Claude organisation cannot hold two ' +
      'connectors pointing at the same address. Somebody there has already added this Brain.',
    remedy:
      'Use the connector that is already there — one connector is one Brain worker, so ' +
      'reusing it is correct — or remove the old one first if it belongs to a member who has ' +
      'left.',
  },
  {
    symptom: 'The approval screen offers a list of workers rather than naming yours.',
    meaning:
      'You are signed in to Brain as an administrator, and an administrator is asked which ' +
      'worker they are connecting before an invitation is looked at. It is not a broken link.',
    remedy:
      'Your own worker is preselected when your browser is holding your invitation. Check the ' +
      'name matches the one on this page and approve it.',
  },
  {
    symptom: 'The approval screen refuses the link.',
    meaning:
      'Absent, expired, already used and withdrawn are one message on purpose — a link is a ' +
      'secret somebody may be holding legitimately, so the refusal names the remedy rather ' +
      'than the reason.',
    remedy: 'Ask for a new connector link on this page. Nothing you have already done is lost.',
  },
  {
    symptom: 'Everything is recorded and nothing ever fires.',
    meaning:
      'The trigger credential is a deployment variable, and Brain structurally cannot write ' +
      'one: it reads the value from the environment and stores only the variable’s name.',
    remedy:
      'Send the credential Claude showed beside your trigger id to a Brain administrator. It ' +
      'goes into the deployment, never into a form here, and Brain will refuse to store it.',
  },
  {
    symptom: 'A self-test was sent and nothing came back.',
    meaning:
      'Brain fired your Routine and no session arrived, or one arrived and could not act. The ' +
      'commonest cause is the Routine having no repository attached, so its session stops at a ' +
      'permission prompt with nobody there to answer it.',
    remedy:
      'Check the Routine has the bootstrap repository attached and the connector enabled, then ' +
      'send the self-test again. Retrying creates no second account and no second Routine.',
  },
  {
    symptom: 'It worked and has stopped.',
    meaning:
      'An authorization that was live has lapsed or been withdrawn in Claude. Brain keeps the ' +
      'proof that it once worked, because that is history, and reports the authorization ' +
      'separately, because that is now.',
    remedy:
      'Reconnect on this page. Your trigger, your surface and your capacity account are kept, ' +
      'so it is an approval rather than a second setup.',
  },
];

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
async function reconcile(
  connection: CapacityConnection,
  workerId: string | null,
  connectorAuthenticated: boolean,
): Promise<CapacityConnection> {
  /*
   * Two states this never moves out of, for two different reasons.
   *
   * `REVOKED` is somebody's decision, and a derivation that overrode it would
   * be Brain deciding a person did not mean it. `reconnect` is the answering
   * transition and it is theirs to make.
   *
   * `HEALTHY` is history. The chain that proved it happened, and a later read
   * finding the fleet quiet does not make it un-happen — what a lapsed
   * authorization changes is reported beside the state rather than by rewriting
   * it.
   */
  if (connection.state === 'REVOKED' || connection.state === 'HEALTHY') return connection;

  /*
   * A registered surface does not make an unauthorized connector authorized,
   * and this is a correction rather than a precaution.
   *
   * Before `reconnect` existed, `NOT_STARTED` could only ever mean *nothing has
   * happened yet*, so a row in it never had a Routine and this branch could not
   * be reached. A reconnect breaks that: the tokens really were revoked, so the
   * member genuinely has to approve the connector again — while the trigger,
   * the account and the Routine are all still there, deliberately, because that
   * is what makes reconnecting one approval rather than a second setup.
   *
   * Without this the very next read derived `WAITING_FOR_ADMIN` from the
   * registered surface, and told somebody whose connector could not
   * authenticate that Brain was waiting on an administrator. §24's own
   * sentence: a state that says waiting on somebody else, when the one thing
   * outstanding is yours, is worse than no state at all.
   */
  if (connection.state === 'NOT_STARTED' && !connectorAuthenticated) return connection;

  if (!connection.routineId) return connection;
  const routine = await getRoutine(connection.routineId);
  if (!routine) return connection;

  /*
   * A surface that is not the one this row names.
   *
   * Two ways it happens, and they are the same defect: the Routine's own
   * `routine_ref` no longer matches the trigger recorded here, or it is bound
   * to a different worker. Either way Brain would fire a surface and attribute
   * its sessions to somebody else — §27 records at length what that costs — so
   * it gets a word rather than reading as an ordinary CONFIGURED.
   *
   * It is **reported and never acted on**. The Routine in question may belong
   * to another member, and disabling somebody else's surface from this member's
   * page is exactly the kind of reach this file exists not to have. The remedy
   * is `fleet repoint-worker`, which is an operator's.
   */
  const misbound =
    (connection.triggerRef !== null && routine.routineRef !== connection.triggerRef) ||
    (routine.workerId !== null && workerId !== null && routine.workerId !== workerId);
  if (misbound) {
    if (connection.state !== 'MISBOUND') {
      await moveConnection({
        connectionId: connection.id,
        from: connection.state,
        to: 'MISBOUND',
      });
    }
    return (await connectionForUser(connection.userId)) ?? connection;
  }

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

/**
 * What the OAuth rows say about this worker's authorization, right now.
 *
 * Live means a token that is neither revoked nor expired, of any kind: an
 * access token lives an hour and a refresh token outlives it, so a connector
 * that is set up and idle holds the second and not the first, and asking only
 * about access tokens would report a working connection as dead every hour.
 *
 * Ever-used is the separate fact that makes *expired* distinguishable from
 * *never started* — and those two have completely different remedies, which is
 * the whole reason both are read.
 */
function authorizationFrom(tokens: readonly OAuthToken[]): {
  live: boolean;
  everUsed: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
} {
  const at = nowIso();
  const alive = tokens.filter((token) => token.revokedAt === null && token.expiresAt > at);
  const used = tokens.filter((token) => token.lastUsedAt !== null);
  return {
    live: alive.length > 0,
    everUsed: used.length > 0,
    lastUsedAt: used.reduce<string | null>(
      (latest, token) => (latest === null || token.lastUsedAt! > latest ? token.lastUsedAt! : latest),
      null,
    ),
    expiresAt: alive.reduce<string | null>(
      (furthest, token) => (furthest === null || token.expiresAt > furthest ? token.expiresAt : furthest),
      null,
    ),
  };
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
  const invited = connection.invitationIssuedAt !== null;
  const asked = connection.invitationRequestedAt !== null;
  const revoked = connection.state === 'REVOKED';

  return [
    {
      key: 'INVITATION',
      title: 'Ask for your one-time connector link',
      detail:
        'Claude’s approval screen has to know which Brain worker it is connecting, and the ' +
        'link is what tells it. It is a Brain administrator’s to issue because it mints your ' +
        'worker identity and grants it a membership — so press the button below and they are ' +
        'shown one action. On its own the link can read nothing, call no tool and obtain no ' +
        'token: approving it in a browser is what does that. Open it in the same browser you ' +
        'are signed in to Brain with.',
      state: invited ? 'DONE' : asked ? 'ADMINISTRATOR' : revoked ? 'LATER' : 'NOW',
    },
    {
      key: 'CONNECTOR',
      title: 'Add Brain as a custom connector in Claude',
      detail:
        'In Claude, open Settings → Connectors → Add custom connector. Give it the name below ' +
        'and the URL below. Claude sends you to a Brain page to approve it; sign in there with ' +
        'your passkey and approve the worker named on this page. Nothing about your Claude ' +
        'account reaches Brain — no password, no cookie, no session, no Anthropic token. Brain ' +
        'stores a token it minted itself, against a worker it owns.',
      copy: [
        { label: 'Connector name', value: connection.connectorName },
        { label: 'MCP URL', value: mcpUrlFor(origin) },
      ],
      state: input.connectorAuthenticated ? 'DONE' : invited ? 'NOW' : 'LATER',
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
          : 'LATER',
    },
    {
      key: 'HEALTHY',
      title: 'Healthy',
      detail:
        'A session Brain fired arrived, authenticated as your worker, was handed a piece of ' +
        'work and finished it. That is the whole of what HEALTHY means here — a trigger id and ' +
        'a credential existing is CONFIGURED, which is a different word on purpose. Come back ' +
        'to this page any time to check it, reconnect it or take it back.',
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

function headlineFor(
  connection: CapacityConnection,
  secretPresent: boolean,
  authorizationExpired: boolean,
): {
  headline: string;
  nextAction: string | null;
} {
  /*
   * A lapsed authorization is reported wherever the journey happens to be.
   *
   * It is not a state, because proof is history: a surface that was proven
   * stays proven and a half-finished setup stays half-finished. What changes is
   * that the thing Brain would fire cannot authenticate any more, and that is
   * true at every step, so it is said first and the journey's own sentence is
   * said after it.
   */
  const lapsed = authorizationExpired
    ? 'Your connector authorized this Brain once and holds nothing live now. '
    : '';
  /*
   * The remedy for a lapsed authorization is **approving the connector again**,
   * and it used to say *reconnect*.
   *
   * That was wrong in the way §29 keeps having to correct: `RECONNECT` is
   * enabled only while a connection is `REVOKED`, so every other state was
   * telling somebody to press a button that was disabled beside it. Revoked has
   * its own branch below, with its own words, and that is the one place the
   * reconnect wording belongs.
   */
  const reconnect = authorizationExpired
    ? 'Approve the connector again in Claude. Your trigger, your surface and your capacity account are all kept.'
    : null;

  switch (connection.state) {
    case 'NOT_STARTED':
      return {
        headline: `${lapsed}Your Claude account is not connected yet.`,
        nextAction:
          reconnect ??
          'Ask for your one-time connector link, which is what Claude’s approval screen needs.',
      };
    case 'INVITATION_REQUESTED':
      return connection.invitationIssuedAt
        ? {
            headline: `${lapsed}Your connector link has been issued. It is shown once, to whoever issued it.`,
            nextAction:
              reconnect ?? 'Open the link you were sent, then add the connector in Claude.',
          }
        : {
            headline:
              'You have asked for your connector link. A Brain administrator issues it and ' +
              'sends it to you privately.',
            nextAction: null,
          };
    case 'CONNECTOR_AUTHORIZED':
    case 'ROUTINE_DETAILS_NEEDED':
      return {
        headline: `${lapsed}Your connector is authorized. Brain needs your Routine’s trigger id.`,
        nextAction: reconnect ?? 'Create the Routine in Claude and paste its trigger id here.',
      };
    case 'WAITING_FOR_ADMIN':
      return {
        headline:
          `${lapsed}Everything you can do is done. Brain is waiting for an administrator to add your ` +
          'trigger’s credential to the deployment.',
        nextAction: reconnect,
      };
    case 'CONFIGURED':
      return {
        headline:
          lapsed +
          (secretPresent
            ? 'Your surface is registered and Brain can fire it. Nothing has come back from it yet.'
            : 'Your surface is registered and its credential is not in the deployment yet.'),
        nextAction: reconnect ?? 'Send the bounded self-test, which is what proves it works.',
      };
    case 'PROBE_SENT':
      return {
        headline: `${lapsed}A self-test is waiting for your Routine to answer it.`,
        nextAction: reconnect,
      };
    case 'ARRIVED':
      return {
        headline:
          `${lapsed}A session Brain fired arrived and authenticated, and has not finished a piece of ` +
          'work here yet.',
        nextAction: reconnect,
      };
    case 'HEALTHY':
      return authorizationExpired
        ? {
            headline:
              'This surface was proven and its authorization has since lapsed, so nothing Brain ' +
              'fires at it can authenticate now.',
            nextAction: reconnect,
          }
        : { headline: 'Connected and proven.', nextAction: null };
    case 'MISBOUND':
      return {
        headline:
          'The Routine registered here is not the one this connection names, or it answers as ' +
          'another worker — so a session it started would be attributed to somebody else.',
        nextAction:
          'A Brain administrator repoints the surface (`fleet repoint-worker`). Nothing here ' +
          'changes it, because the Routine may belong to another member.',
      };
    case 'REVOKED':
      return {
        headline: connection.revokedReason
          ? `This connection was taken back: ${connection.revokedReason}`
          : 'This connection was taken back. Nothing Brain fires reaches your Claude account.',
        nextAction:
          'Reconnect when you want it back. Your trigger, your surface and your capacity ' +
          'account are all kept, so it is an approval rather than a second setup.',
      };
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
 * Where this connection actually is, settled against the rows behind it.
 *
 * This is the reconciliation `connectionView` has always done, lifted out so
 * that it is not something only the member's own page performs.
 *
 * **The defect it corrects is two readers of one fact.** `reconcile` had
 * exactly one caller — the member's read path — while the administrator's
 * `/people/connections` list and `contributedCapacity` both read
 * `capacity_connections.state` straight out of the row. So a connection whose
 * Routine had been repointed read `MISBOUND` on the member's screen and
 * `CONFIGURED` on the administrator's list, until the member happened to open
 * their page. The administrator is the person who repoints a surface, and the
 * dispatcher's own capacity reading was using the same stale column — which is
 * the fourth time this repository has had to write that a rule applied by one
 * of two readers is worse than none, and the first time the reader that was
 * wrong was the one holding the remedy.
 *
 * It is safe for a second caller for the reason the first one was safe: every
 * move inside `reconcile` is a guarded compare-and-swap naming the state it
 * comes from, so two readers settling the same connection at the same instant
 * produce one move and one ordinary loser. It writes nothing else, and it
 * cannot move a proven surface backwards.
 *
 * It deliberately does **not** call `ensureConnection`. Creating a row is the
 * member's own read path establishing the names they are about to paste into
 * Claude; an administrator glancing at a list must not mint connections for
 * people who have never opened the page.
 */
export interface SettledConnection {
  connection: CapacityConnection;
  worker: Awaited<ReturnType<typeof getWorkerByName>>;
  /** The worker's OAuth rows, so a caller need not read them a second time. */
  tokens: Awaited<ReturnType<typeof listTokensForWorker>>;
  authorization: ReturnType<typeof authorizationFrom>;
  /** A live connector of theirs has authenticated as this worker. */
  connectorAuthenticated: boolean;
  /** It authenticated once and holds nothing live now. Two facts, two fields. */
  authorizationExpired: boolean;
}

/**
 * Which worker this connection *is* — the recorded binding first, the derived
 * name only as a fallback.
 *
 * A name is not a binding, and for a long time this resolved one by composing
 * the member's display name with a slice of their user id. That finds a worker
 * Brain minted through this journey and finds **nothing** for a surface
 * registered on a terminal before the journey existed — which in production is
 * the four Routines doing most of the research. So the owner's page read no
 * worker, no tokens and `NOT_STARTED`, and told them their Claude account was
 * not connected while `Brain Research A` was firing for the three hundred and
 * fiftieth time.
 *
 * `capacity_connections.worker_id` is the binding: written when Brain mints the
 * worker, and when a person adopts an existing surface. The name lookup stays
 * for rows written before that column, so nothing that worked before stops
 * working, and where both answer the row wins.
 *
 * It is **one** function because all three callers are the same question asked
 * for different reasons, and the third is the one with teeth: `revoke` resolves
 * a worker to revoke its tokens, so a name-only lookup there would leave an
 * adopted surface's credentials live after a member had taken their connection
 * back. A rule applied by one of three readers is worse than none.
 */
async function workerFor(
  connection: CapacityConnection | null,
  workerName: string,
): Promise<Awaited<ReturnType<typeof getWorkerByName>>> {
  return (
    (connection?.workerId ? await getWorker(connection.workerId) : null) ??
    (await getWorkerByName(workerName))
  );
}

export async function settleConnection(
  user: Pick<User, 'id' | 'displayName'>,
  known?: CapacityConnection,
): Promise<SettledConnection> {
  const names = namesFor(user);
  let connection = known ?? (await connectionForUser(user.id));
  if (!connection) throw new Error('No connection for this member.');

  const worker = await workerFor(connection, names.workerName);
  const tokens = worker ? await listTokensForWorker(worker.id) : [];
  const authorization = authorizationFrom(tokens);
  const connectorAuthenticated = authorization.live && authorization.everUsed;
  const authorizationExpired = authorization.everUsed && !authorization.live;

  if (
    (connection.state === 'NOT_STARTED' || connection.state === 'INVITATION_REQUESTED') &&
    connectorAuthenticated
  ) {
    await moveConnection({
      connectionId: connection.id,
      from: connection.state,
      to: 'CONNECTOR_AUTHORIZED',
    });
    connection = (await connectionForUser(user.id)) ?? connection;
  }

  connection = await reconcile(connection, worker?.id ?? null, connectorAuthenticated);

  return { connection, worker, tokens, authorization, connectorAuthenticated, authorizationExpired };
}

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
   * Has a connector of theirs authorized this Brain, and does it still hold
   * anything live?
   *
   * Read from `oauth_tokens` for the worker this connection's identity is, and
   * never from anything the member said. **Live** rather than merely
   * ever-used, which is a correction: the first version asked only whether a
   * token had ever been used, so a connection whose tokens had all been revoked
   * — by the member taking it back, or by an administrator — went on reading as
   * an authorized connector for ever. A revoke that the screen above it
   * disagrees with is §29's defect at the one place it would matter most.
   */
  const settled = await settleConnection(input.user, connection);
  const { worker, tokens, authorization, connectorAuthenticated, authorizationExpired } = settled;
  connection = settled.connection;

  const routine = connection.routineId ? await getRoutine(connection.routineId) : null;
  const account = routine ? await getAccount(routine.accountId) : null;
  const secretPresent = routine ? resolveToken(routine.tokenSecretName) !== null : false;
  const proof =
    routine && routine.workerId
      ? await provenChainFor(routine.id, routine.workerId, routine.routineRef)
      : { chain: null, arrivals: 0 };

  /*
   * The name the connector registered *itself* with.
   *
   * This is the closest thing to a "Claude display name" that honestly exists
   * here, and saying so is better than inventing one: §22's rule is that
   * nothing about the Claude account enters the Brain, so there is no handle,
   * no address and no session to report. What there is, is the `client_name` a
   * client sent to `/oauth/register`, and it is reported as exactly that.
   */
  const clientId = tokens.find((token) => token.revokedAt === null)?.clientId ?? tokens[0]?.clientId;
  const client = clientId ? await getClientByClientId(clientId) : null;

  const membershipRow = worker
    ? (await listMembershipsForPrincipal('WORKER', worker.id)).find((one) => one.active)
    : undefined;
  const membershipProject = membershipRow ? await getProject(membershipRow.projectId) : null;

  const identity: ConnectionIdentity = {
    workerName: names.workerName,
    workerId: worker?.id ?? null,
    connectorClientName: client?.clientName ?? null,
    membership:
      membershipRow && membershipProject
        ? {
            projectId: membershipRow.projectId,
            projectName: membershipProject.name,
            scopes: [...membershipRow.scopes],
          }
        : null,
    routineName: routine?.name ?? null,
    accountName: account?.name ?? null,
    authorization,
    lastVerifiedAt: connection.healthyAt,
  };

  const { headline, nextAction } = headlineFor(connection, secretPresent, authorizationExpired);
  return {
    connection,
    state: connection.state,
    headline,
    nextAction,
    secretPresent,
    connectorAuthenticated,
    authorizationExpired,
    proven: proof.chain,
    identity,
    checks: checksFor({
      connection,
      worker: worker ?? null,
      membership: identity.membership,
      authorization,
      routine,
      secretPresent,
      proven: proof.chain,
      arrivals: proof.arrivals,
    }),
    controls: controlsFor({ connection, connectorAuthenticated }),
    troubleshooting: [...CONNECTION_TROUBLESHOOTING],
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

/**
 * The verification, item by item, from rows Brain wrote.
 *
 * Seven reads, in the order they have to succeed in, so the first `FAIL` is the
 * one to act on. Each carries its own remedy, because a verification that said
 * *not connected* and stopped is the generic failure this whole surface exists
 * to replace.
 */
function checksFor(input: {
  connection: CapacityConnection;
  worker: { id: string; label: string | null; name: string; archived: boolean; disabled: boolean } | null;
  membership: ConnectionIdentity['membership'];
  authorization: ConnectionIdentity['authorization'];
  routine: { id: string; name: string; routineRef: string; workerId: string | null; state: string } | null;
  secretPresent: boolean;
  proven: { sessionRef: string; binId: string; observedAt: string } | null;
  arrivals: number;
}): ConnectionCheck[] {
  const { connection, worker, membership, authorization, routine } = input;
  const revoked = connection.state === 'REVOKED';

  const identity: ConnectionCheck = worker
    ? worker.archived || worker.disabled
      ? {
          key: 'IDENTITY',
          title: 'Your worker identity',
          state: 'FAIL',
          detail: `${workerIdentity(worker)} exists and has been ${worker.archived ? 'archived' : 'disabled'}.`,
          remedy:
            'A Brain administrator resolves that. Nothing here can re-enable an identity, ' +
            'because an identity that could re-enable itself would not be one.',
        }
      : {
          key: 'IDENTITY',
          title: 'Your worker identity',
          state: 'PASS',
          detail: `Brain fires as ${workerIdentity(worker)}.`,
          remedy: null,
        }
    : {
        key: 'IDENTITY',
        title: 'Your worker identity',
        state: 'PENDING',
        detail: 'No worker identity has been minted for you yet.',
        remedy: 'Ask for your connector link. Issuing it is what mints the identity.',
      };

  const membershipCheck: ConnectionCheck = membership
    ? {
        key: 'MEMBERSHIP',
        title: 'What it may reach',
        state: 'PASS',
        detail: `A member of ${membership.projectName}, carrying ${membership.scopes.join(', ')}.`,
        remedy: null,
      }
    : {
        key: 'MEMBERSHIP',
        title: 'What it may reach',
        state: worker ? 'FAIL' : 'PENDING',
        detail: worker
          ? 'Your worker identity is a member of nothing, so every call it makes is refused.'
          : 'Nothing to be a member yet.',
        remedy: worker
          ? 'Ask for your connector link again. Issuing it rewrites the membership from a ' +
            'constant, so it is a repair as well as a setup.'
          : null,
      };

  const authorizationCheck: ConnectionCheck = authorization.live
    ? {
        key: 'AUTHORIZATION',
        title: 'Your Claude connector',
        state: 'PASS',
        detail: authorization.lastUsedAt
          ? `A live authorization, last used ${authorization.lastUsedAt}.`
          : 'A live authorization that has not been used yet.',
        remedy: null,
      }
    : authorization.everUsed
      ? {
          key: 'AUTHORIZATION',
          title: 'Your Claude connector',
          state: 'FAIL',
          detail: revoked
            ? 'Revoked. Nothing Brain fires can authenticate as your worker.'
            : 'It authorized this Brain once and holds nothing live now.',
          remedy: revoked
            ? 'Reconnect when you want it back.'
            : 'Approve the connector again in Claude. Your surface is kept.',
        }
      : {
          key: 'AUTHORIZATION',
          title: 'Your Claude connector',
          state: 'PENDING',
          detail: 'No connector of yours has authenticated as this worker.',
          remedy: 'Add the connector in Claude and approve it with your one-time link.',
        };

  const trigger: ConnectionCheck = connection.triggerRef
    ? {
        key: 'TRIGGER',
        title: 'The Routine Brain fires',
        state: 'PASS',
        detail: `${connection.triggerRef}${routine ? ` · ${routine.name}` : ''}`,
        remedy: null,
      }
    : {
        key: 'TRIGGER',
        title: 'The Routine Brain fires',
        state: 'PENDING',
        detail: 'No trigger id has been recorded.',
        remedy: 'Create the Routine in Claude and paste its trigger id here.',
      };

  const credential: ConnectionCheck = !routine
    ? {
        key: 'CREDENTIAL',
        title: 'The trigger credential',
        state: 'PENDING',
        detail: 'There is no registered surface for a credential to belong to yet.',
        remedy: null,
      }
    : input.secretPresent
      ? {
          key: 'CREDENTIAL',
          title: 'The trigger credential',
          state: 'PASS',
          detail: `${connection.secretName} is set in this deployment. Brain reads it and stores no value.`,
          remedy: null,
        }
      : {
          key: 'CREDENTIAL',
          title: 'The trigger credential',
          state: 'FAIL',
          detail: `${connection.secretName} is not set, so a fire would be refused.`,
          remedy:
            'Send the bearer Claude showed beside your trigger id to a Brain administrator. It ' +
            'goes into the deployment environment; Brain structurally cannot write one.',
        };

  const binding: ConnectionCheck =
    connection.state === 'MISBOUND'
      ? {
          key: 'BINDING',
          title: 'Bound to you',
          state: 'FAIL',
          detail:
            routine && connection.triggerRef && routine.routineRef !== connection.triggerRef
              ? `The registered surface fires ${routine.routineRef}, and this connection names ${connection.triggerRef}.`
              : 'The registered surface answers as another worker, so its sessions would be attributed to somebody else.',
          remedy:
            'A Brain administrator repoints it (`fleet repoint-worker`). Nothing here changes ' +
            'it, because the surface may belong to another member.',
        }
      : routine && routine.workerId && worker && routine.workerId === worker.id
        ? {
            key: 'BINDING',
            title: 'Bound to you',
            state: 'PASS',
            detail: `${routine.name} answers as ${workerIdentity(worker)}.`,
            remedy: null,
          }
        : {
            key: 'BINDING',
            title: 'Bound to you',
            state: 'PENDING',
            detail: 'Nothing is registered to be bound yet.',
            remedy: null,
          };

  const proven: ConnectionCheck = input.proven
    ? {
        key: 'PROVEN',
        title: 'Proven by a session Brain fired',
        state: 'PASS',
        detail: `Session ${input.proven.sessionRef} arrived at ${input.proven.observedAt}, was handed ${input.proven.binId} and finished it.`,
        remedy: null,
      }
    : {
        key: 'PROVEN',
        title: 'Proven by a session Brain fired',
        state: 'PENDING',
        detail:
          input.arrivals > 0
            ? `${input.arrivals} session(s) have arrived and none has finished a piece of work yet.`
            : 'Nothing Brain fired has come back yet.',
        remedy:
          'Send the bounded self-test. Being registered with a credential is CONFIGURED; this ' +
          'is what makes it proven.',
      };

  return [identity, membershipCheck, authorizationCheck, trigger, credential, binding, proven];
}

/**
 * Every control, always, with the server's reason when one is unavailable.
 *
 * The array's shape never varies — same keys, same order, same labels, for a
 * Brain administrator and for somebody who joined this morning — because a
 * screen that *removed* a control would be a screen two accounts cannot be
 * compared on, and because "there is no button" and "the button is not for you
 * yet" are answers a person reads very differently.
 */
function controlsFor(input: {
  connection: CapacityConnection;
  connectorAuthenticated: boolean;
}): ConnectionControl[] {
  const { connection } = input;
  const revoked = connection.state === 'REVOKED';
  const at = (enabled: boolean, reason: string) => ({ enabled, disabledReason: enabled ? null : reason });

  return [
    {
      key: 'REQUEST_INVITATION',
      label: 'Ask for a connector link',
      ...at(
        !revoked && connection.invitationRequestedAt === null,
        revoked
          ? 'This connection has been taken back. Reconnect first.'
          : connection.invitationIssuedAt !== null
            ? 'A link has already been issued to you. If you no longer have it, a Brain ' +
              'administrator can issue another — it replaces the old one rather than adding to it.'
            : 'You have already asked. A Brain administrator issues it and sends it to you privately.',
      ),
    },
    {
      key: 'SUBMIT_TRIGGER',
      label: 'Record your trigger id',
      ...at(
        !revoked && input.connectorAuthenticated && connection.triggerRef === null,
        revoked
          ? 'This connection has been taken back. Reconnect first.'
          : connection.triggerRef !== null
            ? 'A trigger is already recorded. A Brain administrator repoints a registered surface.'
            : 'Your connector has to authorize this Brain before a Routine of yours can be registered.',
      ),
    },
    {
      key: 'SEND_PROBE',
      label: 'Send the self-test',
      ...at(
        !revoked && connection.routineId !== null && connection.state !== 'MISBOUND',
        revoked
          ? 'This connection has been taken back. Reconnect first.'
          : connection.state === 'MISBOUND'
            ? 'The registered surface is not the one this connection names, so firing it would test somebody else’s.'
            : 'There is no registered surface to test yet.',
      ),
    },
    {
      key: 'VERIFY',
      label: 'Check this connection',
      // Always available, to everybody, in every state. It reads rows and
      // writes nothing anyone can see; a verification somebody could be
      // refused is one they would stop trusting.
      ...at(true, ''),
    },
    {
      key: 'REVOKE',
      label: 'Take this connection back',
      ...at(!revoked, 'It is already taken back.'),
    },
    {
      key: 'RECONNECT',
      label: 'Reconnect',
      ...at(revoked, 'This connection has not been taken back, so there is nothing to restore.'),
    },
  ];
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

  const connection = await ensureConnection({
    userId: input.user.id,
    connectorName: names.connectorName,
    routineName: names.routineName,
    secretName: names.secretName,
  });

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

  /*
   * The stamp that turns the member's first step from *do this* into *done*.
   *
   * Written before the audit row rather than after it for no clever reason —
   * both are in the same request — but written at all because the member's own
   * page is the only place this fact is ever read, and an administrator who
   * issued a link while the member's screen still said "ask for one" is an
   * administrator who gets asked again tomorrow.
   */
  await recordInvitationIssued(connection.id);

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

    const worker = await workerFor(connection, names.workerName);
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

  const answer = async (): Promise<ConnectionOutcome> => ({
    ok: true,
    view: await connectionView({ user: input.user, origin: input.origin }),
  });

  /*
   * A probe that is still live is not replaced, and a spent one is let go of
   * before another is offered.
   *
   * The release is guarded on the bin this caller read, so two readers of a
   * spent probe produce one release — and it is what makes retrying after a
   * failure create no second account and no second Routine.
   */
  if (connection.probeBinId) {
    const bin = await getBin(connection.probeBinId);
    if (bin && bin.state !== 'CANCELLED' && bin.state !== 'FAILED' && bin.state !== 'NEEDS_HUMAN') {
      return await answer();
    }
    await releaseProbe({
      connectionId: connection.id,
      binId: connection.probeBinId,
      to: 'CONFIGURED',
    });
  }

  /*
   * The bin is made as a **DRAFT**, offered, and only the winner's is marked
   * READY.
   *
   * `DISPATCHABLE_SQL` does not select a DRAFT, so a bin that loses the race
   * was never dispatchable and cancelling it closes no window — there is no
   * instant at which two probes for one surface could both be fired. The
   * alternative, claiming the state first, was tried and was wrong: the claim
   * had to be guarded on the state the caller had just read, and on Postgres the
   * second caller reads `PROBE_SENT` and then claims `WHERE state =
   * 'PROBE_SENT'`, which is the state it was claiming into. A guard satisfied by
   * the thing it guards against is not a guard, and only the second backend
   * showed it.
   *
   * This is §20's reconcilable-effect shape rather than claim-then-act, and it
   * is available here because the effect is Brain's own row: a DRAFT bin can be
   * given back. An external effect could not be.
   */
  let binId: string;
  try {
    binId = await createProbeBin({
      worker: { id: routine.workerId, name: routine.name },
      repositories: [],
      routine: { id: routine.id, name: routine.name, capabilities: routine.capabilities },
      family: 'RESEARCH',
      createdByType: 'HUMAN',
      createdById: input.actor.id,
      ready: false,
    });
  } catch (error: unknown) {
    if (error instanceof ProbeRefused) return { ok: false, reason: error.message };
    throw error;
  }

  if (!(await attachProbe({ connectionId: connection.id, binId }))) {
    /*
     * Somebody else's bin is the one this connection holds, so give ours back.
     *
     * `retireBin` is the guarded retirement rather than a delete: the DRAFT
     * keeps its row, its reason and its events, which is §5 — a bin that
     * stopped for a reason nobody wrote down is one somebody reopens by
     * mistake. It was never READY, so nothing could have been fired for it.
     */
    const draft = await getBin(binId);
    if (draft) {
      await retireBin({
        binId,
        leaseGeneration: draft.leaseGeneration,
        operator: `capacity-probe:${input.actor.id}`,
        reason: 'a concurrent request had already sent this surface a self-test',
      });
    }
    return await answer();
  }

  await markBinReady(binId);
  return await answer();
}

/**
 * The marker a member's own revoke leaves on their surface.
 *
 * `setRoutineState` writes a reason, and `reconnect` needs to know whether the
 * surface it is about to re-enable was taken out by *this* member's revoke or
 * by something else entirely — an operator draining it, a quarantine after a
 * refused fire. Re-enabling one that was disabled for another reason would be a
 * member undoing an operator's decision from a page that never mentions it.
 *
 * Compared exactly, and it is Brain's own string rather than anything a caller
 * supplies.
 */
const MEMBER_REVOKE_REASON = 'the member took this connection back from their own page';

/**
 * Ask for the one-time connector link.
 *
 * This is the transition that was missing, and its absence was the whole reason
 * an ordinary member could not start: the link mints a worker identity and
 * grants it a project membership, which is a Brain administrator's decision and
 * should stay one — but a decision nobody can *ask* for is §24's escalation
 * with no answering transition, at the very first step of the journey.
 *
 * It creates nothing, spends nothing and grants nothing. It writes one
 * timestamp, which is what puts the member in front of an administrator.
 * Idempotent by that timestamp, so pressing it twice asks once.
 */
export async function requestConnectorInvitation(input: {
  user: User;
  origin: string;
}): Promise<ConnectionOutcome> {
  const names = namesFor(input.user);
  const connection = await ensureConnection({
    userId: input.user.id,
    connectorName: names.connectorName,
    routineName: names.routineName,
    secretName: names.secretName,
  });

  if (connection.state === 'REVOKED') {
    return {
      ok: false,
      reason:
        'This connection has been taken back, so there is nothing for a link to connect. ' +
        'Reconnect first — your trigger and your surface are both still here.',
    };
  }

  /*
   * Asking never moves anybody backwards.
   *
   * A member who was issued a link without asking for one — an administrator
   * can do that, and does — still has an unclaimed request stamp, so the
   * control is offered to them. Pressing it from `CONFIGURED` must record the
   * ask and leave the journey where it is; the next read would put the state
   * back either way, but a state that visibly regresses and then corrects
   * itself is a screen somebody stops believing.
   *
   * A loser of the swap wanted exactly what the winner produced, so there is
   * nothing to report and nothing to retry.
   */
  await requestInvitation({
    connectionId: connection.id,
    to: connection.state === 'NOT_STARTED' ? 'INVITATION_REQUESTED' : connection.state,
  });
  return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
}

/**
 * Take a connection back.
 *
 * Three things happen and none of them destroys anything. Every OAuth token
 * minted against this worker is revoked, so nothing Brain fires can
 * authenticate as it; every live invitation is revoked, so a link somebody left
 * lying about stops working; and the registered surface is moved to
 * `UNAVAILABLE`, which is the state §23 reserves for *a person decided this*
 * rather than *health decided this*, so the dispatcher stops firing it.
 *
 * The trigger id, the capacity account, the Routine row, the probe and the
 * timestamp that says it was once proven all stay exactly as they were. That is
 * what makes `reconnect` an approval rather than a second setup, and it is §5:
 * a connection that stopped keeps the reason it stopped.
 *
 * A member may revoke their own; a Brain administrator may revoke anybody's,
 * which is the level every other membership change on this Brain carries. The
 * route decides which, and this records who.
 */
export async function revokeOwnConnection(input: {
  user: User;
  actor: User;
  reason: string;
  origin: string;
}): Promise<ConnectionOutcome> {
  const names = namesFor(input.user);
  const connection = await connectionForUser(input.user.id);
  if (!connection) {
    return { ok: false, reason: 'There is no connection here to take back.' };
  }
  if (connection.state === 'REVOKED') {
    // Idempotent: the effect is present after either call. Saying so is better
    // than a refusal that reads as though something went wrong.
    return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
  }

  const worker = await workerFor(connection, names.workerName);
  if (worker) {
    await revokeTokensForWorker(worker.id);
    await revokeInvitationsForWorker(worker.id);
  }

  /*
   * The surface stops being fired, and only if it is this member's own.
   *
   * Guarded on `ENABLED`, so a surface an operator has already drained,
   * quarantined or retired is left exactly where they put it — a revoke that
   * silently overwrote an operator's state would be the member reaching past
   * their own page again.
   */
  if (connection.routineId) {
    const routine = await getRoutine(connection.routineId);
    if (routine && routine.state === 'ENABLED' && routine.workerId === worker?.id) {
      await setRoutineState({
        routineId: routine.id,
        from: 'ENABLED',
        to: 'UNAVAILABLE',
        reason: MEMBER_REVOKE_REASON,
      });
    }
  }

  await revokeConnection({
    connectionId: connection.id,
    reason: input.reason,
    byUserId: input.actor.id,
  });

  if (worker) {
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: input.actor.id,
      action: 'REVOKE_WORKER_CREDENTIAL',
      targetType: 'WORKER',
      targetId: worker.id,
      result: 'SUCCESS',
      // The reason and whose connection it was. No token, no digest, no id of
      // anything that could be presented to anything.
      metadata: { forUserId: input.user.id, reason: input.reason },
    });
  }

  return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
}

/**
 * Put a revoked connection back into the journey.
 *
 * It re-enables the surface **only** when the surface was taken out by this
 * member's own revoke, compared against Brain's own marker string; anything
 * else stays where the operator left it and is reported rather than overridden.
 *
 * It returns the member to the start of the journey rather than to wherever
 * they were, because the tokens really were revoked and the connector really
 * does have to be approved again. A state claiming otherwise would be the
 * false-settled reading §29 keeps correcting — and the steps then show the
 * trigger and the credential already done, so what is actually left is one
 * approval.
 */
export async function reconnectOwnConnection(input: {
  user: User;
  actor: User;
  origin: string;
}): Promise<ConnectionOutcome> {
  const connection = await connectionForUser(input.user.id);
  if (!connection) {
    return { ok: false, reason: 'There is no connection here to reconnect.' };
  }
  if (connection.state !== 'REVOKED') {
    return {
      ok: false,
      reason:
        'This connection has not been taken back, so there is nothing to restore. Check it ' +
        'instead — that reads the rows and says what is missing.',
    };
  }

  if (connection.routineId) {
    const routine = await getRoutine(connection.routineId);
    if (routine && routine.state === 'UNAVAILABLE' && routine.stateReason === MEMBER_REVOKE_REASON) {
      await setRoutineState({
        routineId: routine.id,
        from: 'UNAVAILABLE',
        to: 'ENABLED',
        reason: 'the member reconnected it from their own page',
      });
    }
  }

  await reconnectConnection(connection.id);

  /*
   * Its own action rather than a nearby one.
   *
   * `UPDATE_WORKER` was the first choice and is wrong in a way that only shows
   * up when somebody reads the audit back: the target here is a **person's
   * connection**, and an action naming a worker beside a `USER` target is a row
   * that answers a different question than the one it was written for.
   */
  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actor.id,
    action: 'RECONNECT_CLAUDE_CONNECTION',
    targetType: 'USER',
    targetId: input.user.id,
    result: 'SUCCESS',
    metadata: { connectionId: connection.id },
  });

  return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
}

/**
 * Check a connection, for real.
 *
 * It is `connectionView` under another name, and that is the point rather than
 * a shortcut: the reading a person gets when they press *Check this connection*
 * has to be the same reading the page shows by itself, or the two disagree and
 * the button becomes the one people believe. Every answer in it is a read of
 * rows Brain wrote — the worker, its membership, the tokens minted against it,
 * the registered Routine, the deployment variable's presence and the four-row
 * chain — and none of it is a claim anybody made about themselves.
 *
 * It fires nothing and spends nothing, which is why it is available in every
 * state to every reader. Proving a surface is `sendProbe`; this says what is
 * already true.
 */
export async function verifyConnection(input: {
  user: User;
  origin: string;
}): Promise<ConnectionOutcome> {
  return { ok: true, view: await connectionView({ user: input.user, origin: input.origin }) };
}
