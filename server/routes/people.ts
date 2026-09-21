/**
 * People & Capacity: who has joined, and what can run.
 *
 * ---------------------------------------------------------------------------
 * Why this is its own door
 * ---------------------------------------------------------------------------
 *
 * These two questions were answered at the bottom of the Cash page, rendered
 * inline: a member list, an invite control, the outstanding links, and a list of
 * Claude capacity accounts. None of it is about Cash. A person joins a **Brain**
 * and a Routine serves every project in it; §32 removed the last count on that
 * surface that gated anything, so what was left was Brain-wide account
 * infrastructure living inside a temporary section that is meant to be wound
 * down in a month or two — §30's own first sentence failing in the navigation.
 *
 * So it is a destination, and Cash carries one link to it and renders none of
 * it.
 *
 * ---------------------------------------------------------------------------
 * Who may do what here
 * ---------------------------------------------------------------------------
 *
 * Every route calls `requirePerson`, so a worker principal is refused **by
 * type** at all of them, reads included: a machine that could enumerate this
 * Brain's members or mint itself a capacity surface is precisely what §22's
 * split forbids, and no membership configuration turns one into a person.
 *
 * Reading the page is every member's. The list is names and states — no
 * address, no device, no membership, nothing about what anybody can reach — so
 * there is nothing on it a co-member is not entitled to, and a team that cannot
 * see who else has joined cannot tell whether it is waiting for somebody.
 *
 * Administering people is `requireBrainAdmin`: inviting, recovering, and
 * withdrawing a link. Those already lived behind that guard on `/api/members`
 * and are unchanged — this router does not re-implement them.
 *
 * Your own Claude connection is yours. The routes below resolve the subject
 * from the **authenticated principal** and never from a path segment, so there
 * is no id a member could substitute to read somebody else's setup; the one
 * route that acts on another person's connection is an administrator's, and it
 * names them explicitly.
 *
 * ---------------------------------------------------------------------------
 * What reading does
 * ---------------------------------------------------------------------------
 *
 * No enqueue, no claim, no registration, no fire, no credential mutation, no
 * cancellation. `GET /api/people` is `listUsers`, `listEnrollments`,
 * `countLivePasskeys` and the dispatcher's own fleet snapshot.
 *
 * Two things *are* written, and naming them exactly is better than a sentence
 * that is nearly true. The connection row that assigns a member their three
 * names, because a name that changed between two reads would be one somebody
 * had already pasted into Claude. And that connection's `state`, reconciled
 * against what the rows say — a derivation rather than a hook, so it reaches a
 * connection already stranded and survives a tick that died halfway. Neither
 * creates an account, a Routine, a worker, a credential or a bin.
 */
import { Router } from 'express';
import {
  bodyOf,
  handler,
  notFound,
  requireBrainAdmin,
  requirePerson,
  requiredString,
  unprocessable,
} from './helpers.ts';
import { getUser } from '../repos/identity.ts';
import { peopleReading } from '../services/identity/people.ts';
import { capacityReading, withoutDiagnostics } from '../services/fleet/capacity.ts';
import { contributedCapacity } from '../services/capacity/contribution.ts';
import { listConnections } from '../repos/capacityConnections.ts';
import {
  BOOTSTRAP_REPOSITORY,
  connectionView,
  issueConnectorInvitation,
  mcpUrlFor,
  reconnectOwnConnection,
  requestConnectorInvitation,
  revokeOwnConnection,
  sendProbe,
  submitTrigger,
  verifyConnection,
} from '../services/capacity/connection.ts';
import { adoptSurface } from '../services/capacity/adopt.ts';
import { decideBrainAdmin } from '../services/identity/policy.ts';
import { currentPrincipal } from '../services/identity/context.ts';

export const peopleRouter: Router = Router();

/**
 * The same derivation `oauth.ts` and `factory.ts` use.
 *
 * One image runs locally, in CI and in production, and an MCP URL that named
 * the wrong host would be a URL a member pasted into Claude and could not
 * connect with.
 */
function originOf(req: { protocol: string; get(name: string): string | undefined }): string {
  const host = req.get('host') ?? '';
  const forwarded = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwarded === 'http' || forwarded === 'https' ? forwarded : req.protocol;
  return `${scheme}://${host}`;
}

function isAdmin(): boolean {
  return decideBrainAdmin(currentPrincipal()).allowed;
}

/**
 * The whole page, in one read.
 *
 * §29's one-projection rule: the client renders this and derives nothing of its
 * own, so the three sections cannot disagree about one fleet. The administrator
 * half is *absent* rather than blanked when the reader is not one, because a
 * field that arrives and is not rendered is a field one refactor away from
 * being rendered.
 */
peopleRouter.get(
  '/people',
  handler(async (req) => {
    const principal = requirePerson();
    const admin = isAdmin();

    const people = await peopleReading(principal.id);
    const capacity = await capacityReading();
    const me = await connectionView({
      user: (await getUser(principal.id))!,
      origin: originOf(req),
    });

    return {
      you: { userId: principal.id, isBrainAdmin: admin },
      people: {
        rows: people.people.map((one) => ({
          userId: one.userId,
          displayName: one.displayName,
          state: one.state,
          isYou: one.isYou,
          isBrainAdmin: one.isBrainAdmin,
          // Only an administrator is chasing an outstanding link, and only
          // they are shown when one lapses.
          ...(admin && one.linkExpiresAt ? { linkExpiresAt: one.linkExpiresAt } : {}),
        })),
        joined: people.joined,
        invited: people.invited,
        /*
         * What this reading left out, counted.
         *
         * Administrator depth, and reported rather than silently dropped:
         * somebody asking where *Hosted verification* went must be able to find
         * out, and a row that simply vanished answers nothing.
         */
        ...(admin ? { excluded: people.excluded } : {}),
      },
      capacity: admin ? capacity : withoutDiagnostics(capacity),
      /*
       * Which members' connections are usable capacity, and why not when they
       * are not.
       *
       * It is a reading rather than a gate — nothing calls it to decide whether
       * work may run — and it is here because "my surface is proven" and "my
       * surface is being used" are two facts a member cannot otherwise tell
       * apart. A connection that is not verified can never appear in it as
       * usable: see `services/capacity/contribution.ts` for the five
       * conditions, every one of them a row.
       */
      contributed: await contributedCapacity(),
      me,
      /*
       * The contract travels down with the view rather than being restated in
       * the client — §24's manifest lesson — so what a member is told to paste
       * and what Brain actually reads are one object.
       */
      contract: { mcpUrl: mcpUrlFor(originOf(req)), bootstrapRepository: BOOTSTRAP_REPOSITORY },
    };
  }),
);

/**
 * Your own connection, on its own, for the wizard's re-reads.
 *
 * The subject is the authenticated principal. There is no id in the path a
 * member could substitute, which is a stronger guarantee than a check on one:
 * there is nothing to forget to compare.
 */
peopleRouter.get(
  '/people/me/claude',
  handler(async (req) => {
    const principal = requirePerson();
    return await connectionView({
      user: (await getUser(principal.id))!,
      origin: originOf(req),
    });
  }),
);

/**
 * Record your Routine's trigger id, and register the surface.
 *
 * Yours, by principal. Idempotent by the trigger: submitting the same id twice
 * registers one account and one Routine and reports the state the first call
 * produced.
 */
peopleRouter.post(
  '/people/me/claude/trigger',
  handler(async (req) => {
    const principal = requirePerson();
    const user = (await getUser(principal.id))!;
    const outcome = await submitTrigger({
      user,
      actor: user,
      triggerRef: requiredString(bodyOf(req)['triggerRef'], 'triggerRef'),
      origin: originOf(req),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/**
 * Send the one bounded self-test.
 *
 * Yours, by principal. It creates a `DETERMINISTIC_CHECK` bin and nothing else:
 * the dispatcher picks it up on its own tick through the ordinary routing, so
 * no Routine is fired from here and no external effect is possible.
 */
peopleRouter.post(
  '/people/me/claude/probe',
  handler(async (req) => {
    const principal = requirePerson();
    const user = (await getUser(principal.id))!;
    const outcome = await sendProbe({ user, actor: user, origin: originOf(req) });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/**
 * Ask for your own one-time connector link.
 *
 * The transition that was missing, and its absence is why an ordinary member
 * could not start at all: Claude's approval screen needs to know which Brain
 * worker it is connecting, the link is what tells it, and issuing one mints a
 * worker identity — a Brain administrator's decision, correctly. What did not
 * exist was any way to *ask*, so the member read "add a custom connector" as
 * their next step and was refused at a screen that looks for an administrator
 * first and an invitation second. §24: an escalation with no answering
 * transition is stuck rather than waiting.
 *
 * Yours, by principal. It creates nothing, grants nothing and spends nothing —
 * it writes one timestamp, which is what puts you in front of an administrator.
 */
peopleRouter.post(
  '/people/me/claude/invitation-request',
  handler(async (req) => {
    const principal = requirePerson();
    const user = (await getUser(principal.id))!;
    const outcome = await requestConnectorInvitation({ user, origin: originOf(req) });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/**
 * Check your connection, for real.
 *
 * It re-reads the worker identity, its project membership, the OAuth tokens
 * minted against it, the registered Routine and its bound worker, whether the
 * deployment variable is present, and `proveSurface`'s four-row chain — and
 * returns what each of those said. Nothing in the answer is a claim anybody
 * made about themselves, which is the rule `brain_whoami` already answers
 * under.
 *
 * A POST because it is an action a person takes, and it still fires nothing and
 * spends nothing: the reconciliation it performs is the one every read of this
 * page performs anyway. Available in every state to every reader, because a
 * verification somebody could be refused is one they would stop trusting.
 */
peopleRouter.post(
  '/people/me/claude/verify',
  handler(async (req) => {
    const principal = requirePerson();
    const user = (await getUser(principal.id))!;
    const outcome = await verifyConnection({ user, origin: originOf(req) });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/**
 * Take your own connection back.
 *
 * Yours, by principal: there is no id here anybody could substitute. It revokes
 * every token minted against your worker, revokes any live invitation, and
 * stops the dispatcher firing your surface — and destroys nothing, which is
 * what makes reconnecting an approval rather than a second setup.
 */
peopleRouter.post(
  '/people/me/claude/revoke',
  handler(async (req) => {
    const principal = requirePerson();
    const user = (await getUser(principal.id))!;
    const reason = bodyOf(req)['reason'];
    const outcome = await revokeOwnConnection({
      user,
      actor: user,
      reason:
        typeof reason === 'string' && reason.trim().length > 0
          ? reason.trim().slice(0, 500)
          : 'the member took it back from their own page',
      origin: originOf(req),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/** Put your own connection back into the journey. Yours, by principal. */
peopleRouter.post(
  '/people/me/claude/reconnect',
  handler(async (req) => {
    const principal = requirePerson();
    const user = (await getUser(principal.id))!;
    const outcome = await reconnectOwnConnection({ user, actor: user, origin: originOf(req) });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/**
 * Record that a surface this Brain already fires is somebody's.
 *
 * A Brain administrator's decision, at the level every other change to what a
 * principal may reach already carries, and a worker principal is refused at
 * `requirePerson` before the level is even asked.
 *
 * It exists because no row could answer the question. Four production Routines
 * were registered on a terminal before this journey existed, fire every day,
 * and were attributable to nobody — so the People page told the owner of this
 * Brain that their Claude account was not connected. `services/identity/
 * ownership.ts` explains why the approver on an OAuth code is not the answer:
 * approving a grant is not the same fact as whose capacity it is. So the
 * evidence is a person saying so, recorded, with the channel it came in by.
 *
 * It creates no account, Routine, worker, credential or token, and it cannot
 * make a connection healthy — that stays `reconcile`'s, from the four-row
 * chain, on the next read.
 */
peopleRouter.post(
  '/people/:userId/claude/adopt',
  handler(async (req) => {
    const principal = requirePerson();
    await requireBrainAdmin();
    const body = bodyOf(req);
    const subject = await getUser(requiredString(req.params['userId'], 'userId'));
    // Absent and forbidden are one answer, exactly as the revoke route beside
    // this one has it.
    if (!subject) throw notFound('No such person.');
    const outcome = await adoptSurface({
      userId: subject.id,
      routineRef: requiredString(body['routineRef'], 'routineRef'),
      actorUserId: principal.id,
      // Somebody signed in, on a surface that authenticated them. The terminal
      // path records `SHELL` instead, and neither assumes the other.
      channel: 'BROWSER',
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { connection: outcome.connection, alreadyAdopted: outcome.alreadyAdopted };
  }),
);

/**
 * Take somebody else's connection back.
 *
 * A Brain administrator's, at the level every other change to what a principal
 * may reach already carries, and it exists for the case the member's own
 * control cannot cover: somebody who has lost the device they sign in with
 * cannot revoke a connector that is still authorized in their name.
 *
 * It is the same operation, recording who asked for it. A worker principal is
 * refused at `requirePerson` before the level is even asked.
 */
peopleRouter.post(
  '/people/:userId/claude/revoke',
  handler(async (req) => {
    const principal = requirePerson();
    await requireBrainAdmin();
    const subject = await getUser(requiredString(req.params['userId'], 'userId'));
    // The same 404 a missing route gives. A user id is not an oracle.
    if (!subject || subject.kind !== 'PERSON' || subject.disabledAt !== null) {
      throw notFound('No such route.');
    }
    const reason = bodyOf(req)['reason'];
    const outcome = await revokeOwnConnection({
      user: subject,
      actor: (await getUser(principal.id))!,
      reason:
        typeof reason === 'string' && reason.trim().length > 0
          ? reason.trim().slice(0, 500)
          : 'a Brain administrator took it back',
      origin: originOf(req),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/**
 * Issue a member's connector invitation.
 *
 * A Brain administrator's, because it creates a **worker identity** and grants
 * it a project membership, which is the level `/api/projects/:id/members`
 * already carries for exactly that reason. A worker principal is refused by
 * type at `requirePerson` before the level is even asked.
 *
 * The link is shown once and confers nothing on its own: a registered client
 * holding it cannot read anything, call a tool or obtain a token until a person
 * approves it on Brain's own consent screen.
 */
peopleRouter.post(
  '/people/:userId/claude/invitation',
  handler(async (req) => {
    const principal = requirePerson();
    await requireBrainAdmin();
    const subject = await getUser(requiredString(req.params['userId'], 'userId'));
    // The same 404 a missing route gives. A user id is not an oracle.
    if (!subject || subject.kind !== 'PERSON' || subject.disabledAt !== null) {
      throw notFound('No such route.');
    }
    const outcome = await issueConnectorInvitation({
      user: subject,
      actor: (await getUser(principal.id))!,
      origin: originOf(req),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return outcome.view;
  }),
);

/**
 * Every member's connection, for the administrator's one outstanding action.
 *
 * The point of it is the secret-name column: a connection sitting at
 * `WAITING_FOR_ADMIN` is one variable away from working, and an administrator
 * who had to open each member's page to find that out is an administrator who
 * does it late. It carries **no credential and no value** — the name of an
 * environment variable and the state of a row.
 */
peopleRouter.get(
  '/people/connections',
  handler(async () => {
    requirePerson();
    await requireBrainAdmin();
    const connections = await listConnections();
    return {
      connections: await Promise.all(
        connections.map(async (one) => ({
          userId: one.userId,
          displayName: (await getUser(one.userId))?.displayName ?? one.userId,
          state: one.state,
          secretName: one.secretName,
          triggerRef: one.triggerRef,
          routineId: one.routineId,
          failureReason: one.failureReason,
          /*
           * The other half of the answering transition.
           *
           * A member asking for their connector link is a request that reaches
           * an administrator through this column and through no other channel,
           * so a list that carried the state and not the stamp would leave
           * "asked an hour ago" and "asked in March" reading identically.
           */
          invitationRequestedAt: one.invitationRequestedAt,
          invitationIssuedAt: one.invitationIssuedAt,
          revokedAt: one.revokedAt,
          revokedReason: one.revokedReason,
          updatedAt: one.updatedAt,
        })),
      ),
    };
  }),
);
