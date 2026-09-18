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
  type ConnectionStep,
  type ConnectionView,
  type PeopleAndCapacity,
  type PersonRow,
  type SurfaceReading,
} from '../lib/peopleApi.ts';
import { CashApi, type IssuedEnrollment, type MemberSlotLink } from '../lib/cashApi.ts';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MEMBER_STATE_LABEL: Record<PersonRow['state'], string> = {
  READY: 'Joined',
  INVITED: 'Link sent',
  NOT_INVITED: 'No link yet',
};

const CONNECTION_LABEL: Record<ConnectionView['state'], string> = {
  NOT_STARTED: 'Not started',
  CONNECTOR_AUTHORIZED: 'Connector authorized',
  ROUTINE_DETAILS_NEEDED: 'Routine details needed',
  WAITING_FOR_ADMIN: 'Waiting for administrator',
  CONFIGURED: 'Configured',
  PROBE_SENT: 'Probe sent',
  ARRIVED: 'Arrived',
  HEALTHY: 'Healthy',
  FAILED: 'Failed — action required',
};

/**
 * One value, in its own box, with one button that copies it.
 *
 * The value is always rendered as text as well as copied, because a copy button
 * that silently failed — a browser without the clipboard API, a page not in a
 * secure context — would leave a person with nothing at all.
 */
function CopyBox({ label, value }: { label: string; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rs-copy">
      <span className="rs-copy-label">{label}</span>
      <code className="rs-copy-value">{value}</code>
      <button
        type="button"
        className="rs-button-quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => {
              /* the value is on the screen either way */
            },
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ people */

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
        They register a device when they open it. No email address is asked for and no password is
        ever created.
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
              {/*
                * How, not only whether.
                *
                * `Joined` over a password account and `Joined` over a device
                * are the same word about two different facts, and the second
                * is the one a lost-device recovery applies to.
                */}
              {one.signsInWith === 'PASSWORD' ? (
                <span className="rs-hint"> &middot; password</span>
              ) : null}
            </span>
            {page.you.isBrainAdmin && one.state === 'READY' ? (
              <ConnectorLink person={one} />
            ) : null}
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

/* --------------------------------------------------------- my connection */

function Step({ step }: { step: ConnectionStep }): JSX.Element {
  return (
    <li className="rs-step" data-state={step.state}>
      <p className="rs-item-title">
        {step.title}
        <span className="rs-ready-state" data-state={step.state}>
          {step.state === 'DONE'
            ? 'Done'
            : step.state === 'NOW'
              ? 'Do this now'
              : step.state === 'ADMINISTRATOR'
                ? 'Waiting for administrator'
                : 'Later'}
        </span>
      </p>
      <p className="rs-hint">{step.detail}</p>
      {step.copy?.map((one) => (
        <CopyBox key={one.label} label={one.label} value={one.value} />
      ))}
    </li>
  );
}

/**
 * The member's own setup, resumable at whatever step they are on.
 *
 * It opens by itself while the connection is incomplete and collapses once it
 * is HEALTHY, which is the progressive disclosure the default view asks for: a
 * person who has finished should see one line, and a person who has not should
 * see the wizard without having to find it.
 */
function MyClaude({
  view,
  onChanged,
}: {
  view: ConnectionView;
  onChanged(next: ConnectionView): void;
}): JSX.Element {
  const finished = view.state === 'HEALTHY';
  const [open, setOpen] = useState(!finished);
  const [trigger, setTrigger] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function run(work: () => Promise<ConnectionView>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      onChanged(await work());
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-card">
      <h3>My Claude connection</h3>
      <p className="rs-ready-count">
        <span>{view.headline}</span>
        <strong className="rs-ready-state" data-state={view.state}>
          {CONNECTION_LABEL[view.state]}
        </strong>
      </p>
      {/*
        * The next action is the server's sentence, never one composed here. A
        * state that says "waiting" which its own reader cannot resolve is §24's
        * stuck rather than waiting, so every state either names something to do
        * or says plainly that it is waiting on somebody else.
        */}
      {view.nextAction ? <p className="rs-hint">{view.nextAction}</p> : null}

      {view.invitationUrl ? (
        <div className="rs-ready-link">
          <p className="rs-item-title">Your one-time connector link</p>
          <CopyBox label="Open this to authorize the connector" value={view.invitationUrl} />
          <p className="rs-hint">
            Shown once. It works until{' '}
            {view.invitationExpiresAt
              ? new Date(view.invitationExpiresAt).toLocaleString()
              : 'it expires'}
            , and on its own it cannot read anything, call a tool or obtain a token — approving it
            in a browser is what does that.
          </p>
        </div>
      ) : null}

      <button
        type="button"
        className="rs-button-quiet"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? 'Hide the steps' : 'Show the steps'}
      </button>

      {open ? (
        <>
          <ol className="rs-step-list">
            {view.steps.map((step) => (
              <Step key={step.key} step={step} />
            ))}
          </ol>

          {view.connectorAuthenticated && view.connection.triggerRef === null ? (
            <>
              <label className="rs-field-label" htmlFor="trigger-ref">
                Your Routine&rsquo;s trigger id
              </label>
              <input
                id="trigger-ref"
                value={trigger}
                onChange={(event) => setTrigger(event.target.value)}
                placeholder="trig_…"
                disabled={busy}
              />
              <button
                type="button"
                className="rs-button"
                disabled={busy || trigger.trim().length < 6}
                onClick={() => void run(() => PeopleApi.submitTrigger(trigger.trim()))}
              >
                {busy ? 'Recording…' : 'Record this trigger'}
              </button>
              <p className="rs-hint">
                Paste the trigger <em>id</em>, never the credential printed next to it. Brain
                refuses to store a credential here — that one goes to an administrator, who puts it
                into the deployment.
              </p>
            </>
          ) : null}

          {view.connection.routineId && view.state !== 'HEALTHY' ? (
            <button
              type="button"
              className="rs-button"
              disabled={busy}
              onClick={() => void run(() => PeopleApi.sendProbe())}
            >
              {busy ? 'Sending…' : 'Send the self-test'}
            </button>
          ) : null}

          {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}

          {view.proven ? (
            <p className="rs-hint">
              Proven: session {view.proven.sessionRef} arrived at{' '}
              {new Date(view.proven.observedAt).toLocaleString()}, was handed {view.proven.binId}{' '}
              and finished it.
            </p>
          ) : null}
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
  return (
    <section className="rs-card">
      <h3>Diagnostics</h3>
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
      <MyClaude
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
