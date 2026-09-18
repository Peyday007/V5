/**
 * Connecting a Claude account — the one implementation, for every account.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module rather than a section of a page
 * ---------------------------------------------------------------------------
 *
 * It used to live inside `People.tsx`, which made it reachable from exactly one
 * destination in the More menu. A member who had just registered a device
 * landed on Home, was shown nothing about it, and had no reason to go looking —
 * so the honest description of that state is that connecting a Claude account
 * was a thing you had to be told about in a conversation, which is the same
 * defect `capacity/connection.ts` was written to fix one layer down.
 *
 * It is one component now, rendered by every surface that needs it. There is no
 * administrator variant and no member variant, and there is no second copy of
 * the instructions anywhere: **every word on this screen is composed by the
 * server**, in `services/capacity/connection.ts`, and this file renders what it
 * is given. Two screens paraphrasing one setup is how two accounts come to be
 * told two different things about one mechanism.
 *
 * ---------------------------------------------------------------------------
 * How parity is actually guaranteed, rather than asserted
 * ---------------------------------------------------------------------------
 *
 * **Nothing here branches on who is reading.** There is no `isBrainAdmin` in
 * this file, no role, no membership and no capability check. The only inputs
 * are the server's `ConnectionView` and the callbacks that post back.
 *
 * **Every control is always rendered.** `view.controls` is a fixed list in a
 * fixed order, and a control a particular reader may not use arrives
 * `enabled: false` carrying the server's own sentence for why. A screen that
 * *removed* a control would be a screen two accounts cannot be compared on, and
 * "there is no button" and "the button is not for you yet" are answers a person
 * reads very differently.
 *
 * **Every section is always present.** Checks, identity, steps and
 * troubleshooting are rendered for every state, including `NOT_STARTED`. What
 * varies inside them is the values and the words, which is the only thing that
 * legitimately varies between two accounts.
 *
 * ---------------------------------------------------------------------------
 * What is never on this screen
 * ---------------------------------------------------------------------------
 *
 * A credential of any kind. The one secret this journey involves — the bearer
 * Claude prints beside a Routine's trigger id — never reaches Brain at all: it
 * goes into the deployment environment, and what is shown here is the *name* of
 * the variable. There is no field on this screen that accepts a password, a
 * cookie, a session or a token, and the server refuses one if it arrives.
 */
import { useState } from 'react';
import { useAsync } from './useAsync.ts';
import {
  PeopleApi,
  type ConnectionCheck,
  type ConnectionControl,
  type ConnectionStep,
  type ConnectionView,
} from '../lib/peopleApi.ts';

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The state word, for every state there is.
 *
 * A `Record` over the union rather than a lookup with a fallback, so a state
 * added to the server and not to this map is a compile error instead of a blank
 * badge somebody finds in production.
 */
export const CONNECTION_LABEL: Record<ConnectionView['state'], string> = {
  NOT_STARTED: 'Not connected',
  INVITATION_REQUESTED: 'Link requested',
  CONNECTOR_AUTHORIZED: 'Connector authorized',
  ROUTINE_DETAILS_NEEDED: 'Routine details needed',
  WAITING_FOR_ADMIN: 'Waiting for administrator',
  CONFIGURED: 'Configured',
  PROBE_SENT: 'Self-test sent',
  ARRIVED: 'Session arrived',
  HEALTHY: 'Connected and verified',
  MISBOUND: 'Bound to the wrong surface',
  REVOKED: 'Revoked',
  FAILED: 'Needs attention',
};

const STEP_LABEL: Record<ConnectionStep['state'], string> = {
  DONE: 'Done',
  NOW: 'Do this now',
  ADMINISTRATOR: 'Waiting for administrator',
  LATER: 'Later',
};

const CHECK_LABEL: Record<ConnectionCheck['state'], string> = {
  PASS: 'Yes',
  FAIL: 'No',
  PENDING: 'Not yet',
};

/**
 * One value, in its own box, with one button that copies it.
 *
 * The value is always rendered as text as well as copied, because a copy button
 * that silently failed — a browser without the clipboard API, a page not in a
 * secure context — would leave a person with nothing at all.
 *
 * Exported because the same rule holds wherever a person has to paste something
 * into another application, and a second implementation of it would be a second
 * place for a trailing space to come from.
 */
export function CopyBox({ label, value }: { label: string; value: string }): JSX.Element {
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

function Step({ step }: { step: ConnectionStep }): JSX.Element {
  return (
    <li className="rs-step" data-state={step.state}>
      <p className="rs-item-title">
        {step.title}
        <span className="rs-ready-state" data-state={step.state}>
          {STEP_LABEL[step.state]}
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
 * One control, always drawn, disabled with the server's reason.
 *
 * The reason is rendered rather than hidden in a `title`: an explanation only a
 * mouse can reach is one a person on a phone never gets, and this screen is
 * read on a phone by exactly the people who have just registered a device.
 */
function Control({
  control,
  busy,
  onPress,
}: {
  control: ConnectionControl;
  busy: boolean;
  onPress(): void;
}): JSX.Element {
  return (
    <li className="rs-ready-row" data-control={control.key}>
      <button
        type="button"
        className="rs-button-quiet"
        disabled={busy || !control.enabled}
        onClick={onPress}
      >
        {control.label}
      </button>
      {control.disabledReason ? <span className="rs-hint">{control.disabledReason}</span> : null}
    </li>
  );
}

/**
 * The canonical Claude connection experience.
 *
 * Every account gets this component, with this structure, in this order. The
 * caller decides where it is mounted and nothing else — there is no prop that
 * removes a section, hides a control or changes a word.
 */
export function ClaudeConnectionPanel({
  view,
  onChanged,
}: {
  view: ConnectionView;
  onChanged(next: ConnectionView): void;
}): JSX.Element {
  const finished = view.state === 'HEALTHY' && !view.authorizationExpired;
  const [openSteps, setOpenSteps] = useState(!finished);
  const [openHelp, setOpenHelp] = useState(false);
  const [trigger, setTrigger] = useState('');
  const [revokeReason, setRevokeReason] = useState('');
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(work: () => Promise<ConnectionView>, said?: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      onChanged(await work());
      if (said) setNote(said);
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const control = (key: ConnectionControl['key']): ConnectionControl =>
    view.controls.find((one) => one.key === key) ?? {
      key,
      label: key,
      enabled: false,
      // Only reachable if the server stopped sending a control this screen
      // knows about, which is a contract break rather than a state — so it says
      // that rather than inventing a reason of its own.
      disabledReason: 'This control was not offered by the server.',
    };

  const triggerControl = control('SUBMIT_TRIGGER');

  return (
    <section className="rs-card rs-claude-connection">
      <h3>Your Claude connection</h3>
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

      {/* ------------------------------------------------------ what Brain read */}
      <h4>What Brain checked</h4>
      <ul className="rs-ready-list rs-checks">
        {view.checks.map((check) => (
          <li key={check.key} className="rs-ready-row" data-check={check.key}>
            <span>{check.title}</span>
            <span className="rs-ready-state" data-state={check.state}>
              {CHECK_LABEL[check.state]}
            </span>
            <span className="rs-hint">{check.detail}</span>
            {check.remedy ? <span className="rs-hint">{check.remedy}</span> : null}
          </li>
        ))}
      </ul>

      {/* ------------------------------------------------------------- identity */}
      <h4>What this connection is</h4>
      <ul className="rs-ready-list rs-identity">
        <li className="rs-ready-row">
          <span>Brain worker it authorizes</span>
          <strong>{view.identity.workerName}</strong>
        </li>
        <li className="rs-ready-row">
          <span>Connector Claude registered</span>
          <strong>{view.identity.connectorClientName ?? 'none yet'}</strong>
        </li>
        <li className="rs-ready-row">
          <span>Member it is bound to</span>
          <strong>{view.connection.connectorName}</strong>
        </li>
        <li className="rs-ready-row">
          <span>Membership it carries</span>
          <strong>
            {view.identity.membership
              ? `${view.identity.membership.projectName} · ${view.identity.membership.scopes.join(', ')}`
              : 'none yet'}
          </strong>
        </li>
        <li className="rs-ready-row">
          <span>Surface Brain fires</span>
          <strong>
            {view.identity.routineName ?? 'none yet'}
            {view.identity.accountName ? ` · ${view.identity.accountName}` : ''}
          </strong>
        </li>
        <li className="rs-ready-row">
          <span>Authorization</span>
          <strong>
            {view.identity.authorization.live
              ? 'live'
              : view.identity.authorization.everUsed
                ? 'lapsed or revoked'
                : 'none yet'}
          </strong>
        </li>
        <li className="rs-ready-row">
          <span>Last verified</span>
          <strong>
            {view.identity.lastVerifiedAt
              ? new Date(view.identity.lastVerifiedAt).toLocaleString()
              : 'never'}
          </strong>
        </li>
      </ul>
      <p className="rs-hint">
        Brain holds nothing about your Claude account itself — no password, no cookie, no session
        and no Anthropic token. What it has is a worker it minted and a token it issued against
        that worker, on the authority of a person it authenticated.
      </p>

      {/* ---------------------------------------------------------------- steps */}
      <button
        type="button"
        className="rs-button-quiet"
        aria-expanded={openSteps}
        onClick={() => setOpenSteps((was) => !was)}
      >
        {openSteps ? 'Hide the steps' : 'Show the steps'}
      </button>

      {openSteps ? (
        <ol className="rs-step-list">
          {view.steps.map((step) => (
            <Step key={step.key} step={step} />
          ))}
        </ol>
      ) : null}

      {/* -------------------------------------------------------- trigger entry */}
      <label className="rs-field-label" htmlFor="trigger-ref">
        Your Routine&rsquo;s trigger id
      </label>
      <input
        id="trigger-ref"
        value={trigger}
        onChange={(event) => setTrigger(event.target.value)}
        placeholder="trig_…"
        disabled={busy || !triggerControl.enabled}
      />
      <button
        type="button"
        className="rs-button"
        disabled={busy || !triggerControl.enabled || trigger.trim().length < 6}
        onClick={() => void run(() => PeopleApi.submitTrigger(trigger.trim()))}
      >
        {busy ? 'Recording…' : triggerControl.label}
      </button>
      {triggerControl.disabledReason ? (
        <p className="rs-hint">{triggerControl.disabledReason}</p>
      ) : null}
      <p className="rs-hint">
        Paste the trigger <em>id</em>, never the credential printed next to it. Brain refuses to
        store a credential here — that one goes to an administrator, who puts it into the
        deployment.
      </p>

      {/* ------------------------------------------------------------- controls */}
      <h4>What you can do</h4>
      <ul className="rs-ready-list rs-controls">
        <Control
          control={control('REQUEST_INVITATION')}
          busy={busy}
          onPress={() =>
            void run(
              () => PeopleApi.requestInvitation(),
              'Asked. A Brain administrator issues your link and sends it to you privately.',
            )
          }
        />
        <Control
          control={control('SEND_PROBE')}
          busy={busy}
          onPress={() => void run(() => PeopleApi.sendProbe())}
        />
        <Control
          control={control('VERIFY')}
          busy={busy}
          onPress={() => void run(() => PeopleApi.verify(), 'Checked, just now.')}
        />
        <Control
          control={control('REVOKE')}
          busy={busy}
          onPress={() => setConfirmingRevoke(true)}
        />
        <Control
          control={control('RECONNECT')}
          busy={busy}
          onPress={() =>
            void run(
              () => PeopleApi.reconnect(),
              'Reconnected. Approve the connector in Claude again — everything else was kept.',
            )
          }
        />
      </ul>

      {confirmingRevoke ? (
        <div className="rs-ready-link">
          <p className="rs-item-title">Take this connection back?</p>
          <p className="rs-hint">
            Every token Brain issued against your worker is revoked, any link still outstanding
            stops working, and Brain stops firing your surface. Your trigger id, your capacity
            account and your Routine are kept, so reconnecting later is one approval rather than a
            second setup.
          </p>
          <label className="rs-field-label" htmlFor="revoke-reason">
            Why, for the record
          </label>
          <input
            id="revoke-reason"
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            placeholder="Optional"
            disabled={busy}
          />
          <button
            type="button"
            className="rs-button"
            disabled={busy}
            onClick={() => {
              setConfirmingRevoke(false);
              void run(
                () => PeopleApi.revoke(revokeReason.trim()),
                'Taken back. Nothing Brain fires can authenticate as your worker now.',
              );
            }}
          >
            Yes, take it back
          </button>
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy}
            onClick={() => setConfirmingRevoke(false)}
          >
            Keep it
          </button>
        </div>
      ) : null}

      {note ? <p className="rs-hint">{note}</p> : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}

      {/* ------------------------------------------------------- troubleshooting */}
      <button
        type="button"
        className="rs-button-quiet"
        aria-expanded={openHelp}
        onClick={() => setOpenHelp((was) => !was)}
      >
        {openHelp ? 'Hide troubleshooting' : 'If something goes wrong'}
      </button>
      {openHelp ? (
        <ul className="rs-ready-list rs-troubleshooting">
          {view.troubleshooting.map((entry) => (
            <li key={entry.symptom} className="rs-step">
              <p className="rs-item-title">{entry.symptom}</p>
              <p className="rs-hint">{entry.meaning}</p>
              <p className="rs-hint">{entry.remedy}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The compact entry point.
 *
 * A dashboard is not the place to run a seven-step setup, and a dashboard that
 * said nothing at all is how somebody who joined this morning never discovers
 * there is one. So this says where the connection stands, in the server's own
 * words, and goes to the destination that owns the canonical panel — the *same*
 * panel every account gets, rather than a second smaller version of it.
 *
 * It is an ordinary link rather than a callback for one reason worth stating:
 * one behaviour on every surface. A card that navigated one way from Home and
 * another way from Your devices would be two entry points to maintain, which is
 * the drift this module exists to prevent, and the anchor is the idiom Your
 * devices already used to reach this page.
 *
 * It renders nothing while a connection is healthy and its authorization is
 * live, because a dashboard line about a thing that is working is a line a
 * person learns to skip over. `alwaysShow` is for the surfaces where it is the
 * permanent way in rather than a prompt.
 */
export function ClaudeConnectionCard({
  alwaysShow = false,
}: {
  alwaysShow?: boolean;
} = {}): JSX.Element | null {
  const reading = useAsync(() => PeopleApi.myConnection(), []);
  const view = reading.data;
  if (!view) return null;
  const settled = view.state === 'HEALTHY' && !view.authorizationExpired;
  if (settled && !alwaysShow) return null;

  return (
    <section className="rs-card rs-claude-card">
      <h3>Your Claude connection</h3>
      <p className="rs-ready-count">
        <span>{view.headline}</span>
        <strong className="rs-ready-state" data-state={view.state}>
          {CONNECTION_LABEL[view.state]}
        </strong>
      </p>
      {view.nextAction ? <p className="rs-hint">{view.nextAction}</p> : null}
      <a className="rs-button" href="/people">
        Open your Claude connection
      </a>
    </section>
  );
}
