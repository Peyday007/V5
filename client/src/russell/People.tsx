/**
 * People & Capacity.
 *
 * Who has joined, whether my Claude is connected, how much research capacity is
 * usable, and the one next action if there is one. Those four questions are the
 * whole of the default view, in that order, and everything else is behind a
 * disclosure.
 *
 * ---------------------------------------------------------------------------
 * Three rules, each of them a defect this repository has already recorded
 * ---------------------------------------------------------------------------
 *
 * **Nothing here derives a count or a state.** Every number and every state
 * word comes from the server's own reading — `identity/people.ts` for who is a
 * person, `fleet/capacity.ts` for what the dispatcher would fire,
 * `capacity/connection.ts` for where a setup is. A screen that counted for
 * itself would be the second reader §29 keeps having to correct, and the last
 * time this fact had two readers they disagreed by a factor of four.
 *
 * **Nothing here composes a sentence about a permission or a remedy.** The
 * step text, the refusal, the reason a surface is not healthy and the headline
 * are all the server's words. A screen that paraphrased a remedy would
 * eventually send somebody to fix the wrong thing.
 *
 * **Every pasted value is its own box.** A member setting this up is copying
 * four strings into Claude, and a person who has to select part of a sentence
 * is a person who pastes a trailing space into a connector name.
 *
 * ---------------------------------------------------------------------------
 * What is *not* here
 * ---------------------------------------------------------------------------
 *
 * No fleet internals in the default view: no trigger refs, no worker ids, no
 * secret names of other people's surfaces, no fire counters. Those are behind
 * **Diagnostics**, which the server only sends to a Brain administrator — the
 * field is absent rather than hidden, so there is nothing here one refactor
 * away from rendering it.
 *
 * And no credential of any kind, ever. The one secret this journey involves
 * never reaches Brain: it goes into the deployment environment, and what is
 * shown here is the *name* of the variable.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAsync } from './useAsync.ts';
import {
  PeopleApi,
  type ConnectionView,
  type AccountFoundation,
  type PeopleAndCapacity,
  type PersonRow,
  type SurfaceReading,
} from '../lib/peopleApi.ts';
import { CashApi, type IssuedEnrollment, type MemberSlotLink } from '../lib/cashApi.ts';
/*
 * The connection experience is imported, never re-implemented.
 *
 * One component and one source of instructions for every account — see
 * `ClaudeConnection.tsx`. This page is where it is *mounted* in full; Home and
 * Your devices mount the compact entry point that opens this one. A second copy
 * here would be the drift this whole arrangement exists to prevent.
 */
import {
  ClaudeConnectionPanel,
  CONNECTION_LABEL,
  CopyBox,
  describeError as describe,
} from './ClaudeConnection.tsx';

const MEMBER_STATE_LABEL: Record<PersonRow['state'], string> = {
  READY: 'Joined',
  INVITED: 'Link sent',
  NOT_INVITED: 'No link yet',
  // The remedy, rather than the condition. Somebody reading this row has to
  // know what to press, and the control that does it is the next column.
  NEEDS_A_NEW_LINK: 'Needs a new link',
  // The condition, because here the remedy is a *decision* rather than a
  // button: which of the two people keeps the name is not something a screen
  // can choose, so it says what is wrong and the control beside it asks.
  NAME_IS_AMBIGUOUS: 'Cannot sign in — two accounts share this name',
};

/**
 * Which credential, in the words a person would use for it.
 *
 * `Joined` over a PIN and `Joined` over a password are the same word about two
 * different facts, and only one of them is the ordinary way in. A device is
 * named because the row is real and *not* because it is a route — the sign-in
 * screen does not offer one.
 */
const SIGNS_IN_LABEL: Record<PersonRow['signsInWith'], string | null> = {
  PIN: null,
  PASSWORD: 'password',
  DEVICE: 'device only',
  NONE: null,
};


/* ------------------------------------------------------------------ people */

/**
 * What is short, for this account, in the order it has to be fixed.
 *
 * Every sentence here is the server's. The client chooses no wording, derives
 * no verdict and has no branch on who is reading — `foundation` is absent from
 * the payload entirely for a member, so there is nothing to render rather than
 * something to hide, which is the only version of that distinction a forgotten
 * `.filter()` cannot undo.
 *
 * `NOT_APPLICABLE` is not printed. A dimension this account has not reached is
 * not a finding, and listing three of them under somebody who has simply not
 * started is the noise that teaches a reader to stop reading the list.
 */
function Foundation({ account }: { account?: AccountFoundation }): JSX.Element | null {
  if (!account) return null;
  const short = account.findings.filter((one) => one.verdict === 'BLOCKED');
  if (short.length === 0) {
    return <p className="rs-hint">Foundation complete.</p>;
  }
  return (
    <ul className="rs-hint rs-foundation">
      {short.map((one) => (
        <li key={one.dimension}>
          <strong>{FOUNDATION_LABEL[one.dimension] ?? one.dimension}</strong> &middot; {one.because}
          {one.nextAction ? (
            <>
              {' '}
              <em>{one.nextAction}</em> ({ACTOR_LABEL[one.owner] ?? one.owner})
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The server names the dimension; this only makes it readable. */
const FOUNDATION_LABEL: Record<string, string> = {
  IDENTITY: 'Identity',
  SIGN_IN: 'Sign-in',
  CLAUDE_CONNECTION: 'Claude connection',
  WORKER_ATTRIBUTION: 'Worker',
  CAPACITY: 'Capacity',
  RECOVERY: 'Recovery',
};

const ACTOR_LABEL: Record<string, string> = {
  MEMBER: 'them',
  BRAIN_ADMINISTRATOR: 'you',
  DEPLOYMENT_ADMINISTRATOR: 'deployment',
  BRAIN: 'Brain, by itself',
};

/**
 * The invite control.
 *
 * Rendered for a Brain administrator, and that is a **convenience rather than
 * the control**: `/api/members` refuses anybody else with the same 404 a
 * missing route gives, whatever this component decides to draw.
 *
 * A link is shown exactly once. The server stored a digest of it and cannot
 * show it again, so it stays on the screen until the administrator navigates
 * away — and re-reading the list never brings it back, which this component
 * never asks it to.
 */
function Invite({ onChanged }: { onChanged(): void }): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedEnrollment | null>(null);
  const [links, setLinks] = useState<MemberSlotLink[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const readLinks = useCallback(() => {
    CashApi.members().then(
      (answer) => setLinks(answer.links),
      () => {
        /* an ordinary member simply has no list here */
      },
    );
  }, []);
  useEffect(readLinks, [readLinks]);

  async function invite(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await CashApi.inviteMember(name.trim());
      setIssued(answer.enrollment);
      setName('');
      readLinks();
      onChanged();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  const live = links.filter((one) => one.state === 'LIVE');

  return (
    <div className="rs-ready">
      <label className="rs-field-label" htmlFor="member-name">
        Invite somebody
      </label>
      <input
        id="member-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="The name they should be shown as"
        disabled={busy}
      />
      <button
        type="button"
        className="rs-button"
        disabled={busy || name.trim().length < 2}
        onClick={() => void invite()}
      >
        {busy ? 'Making a link…' : 'Make a private link'}
      </button>
      <p className="rs-hint">
        They choose a six-digit PIN when they open it. No email address is asked for and no
        password is ever created.
      </p>
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      {issued ? (
        <div className="rs-ready-link">
          <p className="rs-item-title">A link for {issued.displayName}</p>
          <CopyBox
            label="Send this to them privately"
            value={`${window.location.origin}/enrol#${issued.token}`}
          />
          <p className="rs-hint">
            It works once, stops working on {new Date(issued.expiresAt).toLocaleString()}, and
            cannot be shown again — Brain stored a digest of it and not the link.
          </p>
        </div>
      ) : null}
      {live.length > 0 ? (
        <ul className="rs-ready-list">
          {live.map((one) => (
            <li key={one.id} className="rs-ready-row">
              <span>
                {one.displayName}
                {one.kind === 'RECOVERY' ? ' · recovery' : ''}
              </span>
              <button
                type="button"
                className="rs-button-quiet"
                onClick={() => {
                  void CashApi.withdrawLink(one.id, 'Withdrawn before it was used.').then(() => {
                    readLinks();
                    onChanged();
                  });
                }}
              >
                Withdraw this link
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Issuing somebody their Claude connector link.
 *
 * A Brain administrator's, because it mints a **worker identity** and grants it
 * a project membership — the level `/api/projects/:id/members` already carries
 * for exactly that reason. The route refuses anybody else with the same 404 a
 * missing route gives, whatever this renders.
 *
 * It has to be *here*, beside the person, and that is the correction this
 * component exists for: the route was built and nothing called it, which is the
 * defect this repository has recorded five times — a mechanism nothing calls is
 * not a mechanism. A member cannot authorize a connector without this link, so
 * a route with no control is a journey nobody can start.
 *
 * The link is shown once. It confers nothing on its own: holding it, a client
 * cannot read anything, call a tool or obtain a token until a person approves it
 * on Brain's own consent screen.
 */
function ConnectorLink({ person }: { person: PersonRow }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<ConnectionView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className="rs-button-quiet"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setProblem(null);
          PeopleApi.issueConnectorInvitation(person.userId).then(
            (view) => {
              setIssued(view);
              setBusy(false);
            },
            (error: unknown) => {
              setProblem(describe(error));
              setBusy(false);
            },
          );
        }}
      >
        {busy ? 'Making a link\u2026' : 'Claude connector link'}
      </button>
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      {issued?.invitationUrl ? (
        <div className="rs-ready-link">
          <p className="rs-item-title">A connector link for {person.displayName}</p>
          <CopyBox label="Send it to them privately" value={issued.invitationUrl} />
          <p className="rs-hint">
            Shown once. They open it, approve the connector, and the rest of their setup is on
            their own page. Their surface is called {issued.connection.routineName}.
          </p>
        </div>
      ) : null}
    </>
  );
}

/**
 * A fresh link for somebody who cannot get in.
 *
 * `NEEDS_A_NEW_LINK` is an escalation, so it needs an answering transition, and
 * it had one everywhere except where a person could reach it: `issueRecovery`
 * was a route, `CashApi.recoverMember` was a client function, and **nothing
 * called either**. That is this repository's own recurring sentence — a
 * mechanism nothing calls is not a mechanism — and it is the same correction
 * `ConnectorLink` directly above was written for.
 *
 * Recovery retires before it issues. Whatever the person was holding stops
 * working now rather than when the replacement is used, and every session that
 * credential opened ends with it: if the reason they cannot get in is that
 * somebody else has their device, waiting would be the whole defect.
 *
 * The link is shown once, and it ends in a PIN.
 */
function Recover({
  person,
  onChanged,
  mode,
}: {
  person: PersonRow;
  onChanged(): void;
  /*
   * Which operation this is, because they are two facts about the person.
   *
   * `RECOVER` retires whatever they are holding first, which is right when a
   * device may be in the wrong hands. `RELINK` retires nothing, because there
   * is nothing to retire — and calling that recovery would tell somebody who
   * has never signed in that their credentials have been taken out of service.
   */
  mode: 'RECOVER' | 'RELINK';
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedEnrollment | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const relink = mode === 'RELINK';

  return (
    <>
      <button
        type="button"
        className="rs-button-quiet"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setProblem(null);
          const asked = relink
            ? CashApi.relinkMember(person.userId)
            : CashApi.recoverMember(
                person.userId,
                'The sign-in screen no longer offers a device.',
              );
          asked.then(
            (answer) => {
              setIssued(answer.enrollment);
              setBusy(false);
              onChanged();
            },
            (error: unknown) => {
              setProblem(describe(error));
              setBusy(false);
            },
          );
        }}
      >
        {busy ? 'Making a link…' : relink ? 'Send them a link' : 'New sign-in link'}
      </button>
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      {issued ? (
        <div className="rs-ready-link">
          <p className="rs-item-title">A link for {issued.displayName}</p>
          <CopyBox
            label="Send this to them privately"
            value={`${window.location.origin}/enrol#${issued.token}`}
          />
          <p className="rs-hint">
            Shown once. It works once, stops working on{' '}
            {new Date(issued.expiresAt).toLocaleString()}, and they choose a six-digit PIN when
            they open it.
            {relink ? '' : ' Anything they were holding before has stopped working.'}
          </p>
        </div>
      ) : null}
    </>
  );
}

/**
 * Give one of them a name of their own.
 *
 * The answering transition for `NAME_IS_AMBIGUOUS`. A member enrolled from a
 * link holds no address, so their display name is the only identity they can
 * type — and a name two live accounts answer to is refused at the door, with
 * the same sentence a wrong PIN gets. Both of them are locked out, and neither
 * can do anything about it.
 *
 * It moves a label and nothing else: the account keeps its role, its
 * memberships, its PIN, its sessions and everything it owns. Which of the two
 * is renamed is a decision, so this asks rather than choosing — and the server
 * refuses a name that would simply move the collision.
 */
function Rename({ person, onChanged }: { person: PersonRow; onChanged(): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="rs-button-quiet" onClick={() => setOpen(true)}>
        Give them their own name
      </button>
    );
  }
  return (
    <div className="rs-field">
      <label className="rs-field-label" htmlFor={`rename-${person.userId}`}>
        A name that tells them apart
      </label>
      <input
        id={`rename-${person.userId}`}
        className="rs-input"
        type="text"
        value={name}
        placeholder="A surname, or an initial"
        onChange={(event) => setName(event.target.value)}
      />
      <button
        type="button"
        className="rs-button-quiet"
        disabled={busy || name.trim().length < 2}
        onClick={() => {
          setBusy(true);
          setProblem(null);
          CashApi.renameMember(person.userId, name.trim()).then(
            () => {
              setBusy(false);
              setOpen(false);
              onChanged();
            },
            (error: unknown) => {
              setProblem(describe(error));
              setBusy(false);
            },
          );
        }}
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      <p className="rs-hint">
        This changes what they type to sign in, and nothing else — they keep their PIN, their
        access and everything on their account. Tell them the new name.
      </p>
    </div>
  );
}

function People({
  page,
  onChanged,
}: {
  page: PeopleAndCapacity;
  onChanged(): void;
}): JSX.Element {
  const [showInvite, setShowInvite] = useState(false);
  return (
    <section className="rs-card">
      <h3>People</h3>
      <p className="rs-ready-count">
        <span>Members who can sign in</span>
        <strong>
          {page.people.joined} of {page.people.rows.length}
        </strong>
      </p>
      <ul className="rs-ready-list">
        {page.people.rows.map((one) => (
          <li key={one.userId} className="rs-ready-row">
            <span>
              {one.displayName}
              {one.isYou ? <span className="rs-hint"> &middot; you</span> : null}
              {one.isBrainAdmin ? <span className="rs-hint"> &middot; administrator</span> : null}
            </span>
            <span className="rs-ready-state" data-state={one.state}>
              {MEMBER_STATE_LABEL[one.state]}
              {/* How, not only whether. */}
              {SIGNS_IN_LABEL[one.signsInWith] ? (
                <span className="rs-hint"> &middot; {SIGNS_IN_LABEL[one.signsInWith]}</span>
              ) : null}
            </span>
            {page.you.isBrainAdmin && one.state === 'READY' ? (
              <ConnectorLink person={one} />
            ) : null}
            {page.you.isBrainAdmin && one.state === 'NEEDS_A_NEW_LINK' ? (
              <Recover person={one} onChanged={onChanged} mode="RECOVER" />
            ) : null}
            {/*
              * A slot nobody has filled, and — until now — nothing on this page
              * could fill it. `Invite somebody` makes a *new row*, so the only
              * route was a second account under the same name, which §43's
              * guard now refuses outright. A refusal whose remedy does not
              * exist is a stop rather than an improvement.
              */}
            {page.you.isBrainAdmin &&
            (one.state === 'NOT_INVITED' || one.state === 'INVITED') ? (
              <Recover person={one} onChanged={onChanged} mode="RELINK" />
            ) : null}
            {page.you.isBrainAdmin && one.state === 'NAME_IS_AMBIGUOUS' ? (
              <Rename person={one} onChanged={onChanged} />
            ) : null}
            <Foundation
              account={page.foundation?.accounts.find((each) => each.userId === one.userId)}
            />
          </li>
        ))}
      </ul>
      {/*
        * What the list left out, and why.
        *
        * Administrator depth, and reported rather than silently dropped: the
        * two identities `verify-hosted.ts` creates used to be rendered here as
        * people, and somebody who remembers seeing them has to be able to find
        * out where they went. Nothing was deleted to clear the screen.
        */}
      {page.people.excluded && page.people.excluded.systemIdentities > 0 ? (
        <p className="rs-hint">
          {page.people.excluded.systemIdentities} system identit
          {page.people.excluded.systemIdentities === 1 ? 'y is' : 'ies are'} deliberately not
          counted here — they are Brain's own verification machinery rather than people. Their
          rows and their history are untouched.
        </p>
      ) : null}

      {page.you.isBrainAdmin ? (
        <>
          <button
            type="button"
            className="rs-button-quiet"
            aria-expanded={showInvite}
            onClick={() => setShowInvite((open) => !open)}
          >
            {showInvite ? 'Close' : 'Invite somebody'}
          </button>
          {showInvite ? <Invite onChanged={onChanged} /> : null}
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------- capacity */

function Surface({ surface }: { surface: SurfaceReading }): JSX.Element {
  return (
    <li className="rs-ready-row">
      <span>{surface.name}</span>
      <span className="rs-ready-state" data-state={surface.health}>
        {surface.health}
      </span>
      {surface.because ? <span className="rs-hint">{surface.because}</span> : null}
      {surface.detail ? (
        <span className="rs-hint">
          {surface.detail.routineRef} &middot; secret {surface.detail.secretName}
          {surface.detail.secretPresent ? ' (set)' : ' (not set)'} &middot;{' '}
          {surface.detail.totalFires} fire(s), {surface.detail.totalRefusals} refused,{' '}
          {surface.detail.consecutiveNoShows} unanswered
          {surface.detail.stateReason ? ` · ${surface.detail.stateReason}` : ''}
        </span>
      ) : null}
    </li>
  );
}

function Capacity({ page }: { page: PeopleAndCapacity }): JSX.Element {
  const [showHistory, setShowHistory] = useState(false);
  const { capacity } = page;
  return (
    <section className="rs-card">
      <h3>Brain research capacity</h3>
      <p className="rs-ready-count">
        <span>Surfaces Brain can fire right now</span>
        <strong>{capacity.eligibleNow}</strong>
      </p>
      {/*
        * Three readings, labelled as three readings.
        *
        * They are genuinely different facts with different remedies, and the
        * last time they were collapsed into one fraction the page reported
        * `1 / 4 HEALTHY` about a fleet with four eligible Routines. The target
        * is named as a target rather than used as a denominator, because it is
        * a number somebody configured and it authorizes nothing.
        */}
      <ul className="rs-ready-list">
        <li className="rs-ready-row">
          <span>Proven by a completed session</span>
          <strong>{capacity.proven}</strong>
        </li>
        <li className="rs-ready-row">
          <span>Waiting on something an administrator does</span>
          <strong>{capacity.waiting}</strong>
        </li>
        <li className="rs-ready-row">
          <span>Not available</span>
          <strong>{capacity.unavailable}</strong>
        </li>
        {capacity.target === null ? null : (
          <li className="rs-ready-row">
            <span>Concurrency target somebody configured</span>
            <strong>{capacity.target}</strong>
          </li>
        )}
      </ul>

      <ul className="rs-ready-list">
        {capacity.surfaces.length === 0 ? (
          <li className="rs-ready-row">
            <span>No capacity surface is registered yet.</span>
          </li>
        ) : (
          capacity.surfaces.map((one) => <Surface key={one.routineId} surface={one} />)
        )}
      </ul>

      <p className="rs-hint">
        A surface is HEALTHY only once a session Brain fired has arrived and finished a piece of
        work on it. Being registered with a credential is CONFIGURING, which is a different word on
        purpose.
      </p>

      {/*
        * What each member's own connection contributes, and why not when it
        * contributes nothing.
        *
        * The counts above are the fleet the dispatcher sees; this is the same
        * fleet asked *per person*, which is the only way somebody can tell
        * "my surface is proven" from "my surface is being used". Every sentence
        * in it is the server's, and none of it gates anything.
        */}
      <h4>Contributed by members</h4>
      <p className="rs-ready-count">
        <span>Connections that are usable capacity</span>
        <strong>
          {page.contributed.usable} of {page.contributed.total}
        </strong>
      </p>
      <ul className="rs-ready-list rs-contributed">
        {page.contributed.surfaces.length === 0 ? (
          <li className="rs-ready-row">
            <span>Nobody has connected a Claude account yet.</span>
          </li>
        ) : (
          page.contributed.surfaces.map((one) => (
            <li key={one.userId} className="rs-ready-row">
              <span>{one.displayName}</span>
              <span className="rs-ready-state" data-state={one.usable ? 'HEALTHY' : 'WAITING'}>
                {one.usable ? 'Usable' : 'Not yet'}
              </span>
              {one.because ? <span className="rs-hint">{one.because}</span> : null}
              <span className="rs-hint">
                {one.routing
                  ? `Serves ${one.routing.families.join(', ')}${
                      one.routing.repositories.length > 0
                        ? ` · ${one.routing.repositories.join(', ')}`
                        : ''
                    }`
                  : 'Research only — no repository has been authorized for this worker.'}
              </span>
            </li>
          ))
        )}
      </ul>

      {capacity.historical.length > 0 ? (
        <>
          <button
            type="button"
            className="rs-button-quiet"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((was) => !was)}
          >
            {showHistory ? 'Hide retired surfaces' : `Retired surfaces (${capacity.historical.length})`}
          </button>
          {showHistory ? (
            <ul className="rs-ready-list">
              {capacity.historical.map((one) => (
                <Surface key={one.routineId} surface={one} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------- administrator's list */

/**
 * Every member's connection, and the one variable each is waiting on.
 *
 * Collapsed by default and only ever sent to a Brain administrator. It exists
 * because a connection sitting at *Waiting for administrator* is one deployment
 * variable away from working, and an administrator who had to open each
 * member's page to discover that is an administrator who does it late.
 *
 * It carries no value of any kind — the name of an environment variable, a
 * trigger id and a state.
 */
function Connections(): JSX.Element | null {
  const reading = useAsync(() => PeopleApi.connections(), []);
  const [open, setOpen] = useState(false);
  if (reading.error || !reading.data) return null;
  const waiting = reading.data.connections.filter((one) => one.state === 'WAITING_FOR_ADMIN');
  /*
   * The other half of the answering transition, and the one that has to be
   * visible first.
   *
   * A member asking for their connector link reaches an administrator through
   * this row and through no other channel — there is no email in this Brain and
   * no notification — so a list that buried the request behind a disclosure
   * would be an escalation nobody is asked about. It is named above the
   * disclosure, with the person, because the remedy is one button beside their
   * name in the list above.
   */
  const asked = reading.data.connections.filter(
    (one) => one.invitationRequestedAt !== null && one.invitationIssuedAt === null,
  );
  return (
    <section className="rs-card">
      <h3>Diagnostics</h3>
      {asked.length > 0 ? (
        <p className="rs-hint">
          {asked.map((one) => one.displayName).join(', ')} asked for a Claude connector link. Issue
          it with the button beside their name above, and send it to them privately — it is shown
          once.
        </p>
      ) : null}
      {waiting.length > 0 ? (
        <p className="rs-hint">
          {waiting.length} connection(s) are waiting for a deployment variable to be set. Each one
          needs exactly one action and nothing already done has to be redone.
        </p>
      ) : null}
      <button
        type="button"
        className="rs-button-quiet"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? 'Hide connections' : `Connections (${reading.data.connections.length})`}
      </button>
      {open ? (
        <ul className="rs-ready-list">
          {reading.data.connections.map((one) => (
            <li key={one.userId} className="rs-ready-row">
              <span>{one.displayName}</span>
              <span className="rs-ready-state" data-state={one.state}>
                {CONNECTION_LABEL[one.state]}
              </span>
              <span className="rs-hint">
                set {one.secretName}
                {one.triggerRef ? ` for ${one.triggerRef}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ page */

export function PeopleAndCapacityView(): JSX.Element {
  const reading = useAsync(() => PeopleApi.page(), []);
  const [me, setMe] = useState<ConnectionView | null>(null);

  const page = reading.data;
  const connection = me ?? page?.me ?? null;

  if (reading.error) {
    return (
      <section className="rs-view">
        <h2>People &amp; capacity</h2>
        <p className={`rs-state rs-state-${reading.error.status === 404 ? 'forbidden' : 'error'}`}>
          {reading.error.status === 404
            ? 'There is nothing here for you to see. That is the same answer a page that does not exist gives, on purpose.'
            : reading.error.message}
        </p>
      </section>
    );
  }

  /*
   * A re-read must not blank what is already showing.
   *
   * `loading` is true both when there is nothing yet and when the page is being
   * read again, and treating the second as "not ready" unmounts the section —
   * which is how Build once lost an invitation that was shown once, and how the
   * one-time connector link below would be lost on the reload that follows
   * issuing it.
   */
  if (!page || !connection) {
    return (
      <section className="rs-view">
        <h2>People &amp; capacity</h2>
        <p className="rs-state rs-state-loading">Reading who is here&hellip;</p>
      </section>
    );
  }

  return (
    <section className="rs-view rs-view-people">
      <h2>People &amp; capacity</h2>
      <p className="rs-hint">
        Who has joined this Brain, and what can run in it. Membership and Claude capacity are
        separate things: a person can join without contributing a Routine, a Routine serves every
        project here rather than owning any of it, and neither count starts or stops any work.
      </p>

      <People page={page} onChanged={reading.reload} />
      {/*
        * Answering a step changes the page, not only the card.
        *
        * Recording a trigger id **registers a surface**, so the capacity list
        * underneath is stale the instant it succeeds — §29's defect at this
        * surface, and the one it records twice already: a status that does not
        * agree with the control beside it teaches a person to stop reading it.
        *
        * The card's own answer is kept as well as re-read, because it is the
        * newer of the two and because a one-time connector link lives on it:
        * throwing it away on the reload that follows issuing one is how Build
        * lost an invitation that was shown once.
        */}
      <ClaudeConnectionPanel
        view={connection}
        onChanged={(next) => {
          setMe(next);
          reading.reload();
        }}
      />
      <Capacity page={page} />
      {page.you.isBrainAdmin ? <Connections /> : null}
    </section>
  );
}
