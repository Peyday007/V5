/**
 * Who can get in, and what can run.
 *
 * Two counts and a list each, rendered from the server's own reading. Nothing
 * here derives a state, counts anything, or decides whether the button may be
 * pressed: `cashReadiness` answers that from rows, and a screen that formed its
 * own opinion would be the second reader §29 keeps having to correct — a status
 * that contradicts the control beside it teaches a person to stop reading it.
 *
 * **It says nothing private.** A member is a name and a state. Not an address,
 * not a device, not what they can reach. That is a property of the payload
 * rather than of this file: the server sends three fields.
 *
 * **A link is shown exactly once.** The server does not store it and cannot
 * show it again, so it stays on the screen until the administrator navigates
 * away, with what it is for written beside it. Re-reading the list does not
 * bring it back, and this component never asks it to.
 */
import { useCallback, useEffect, useState } from 'react';
import { CashApi, type CashReadiness, type IssuedEnrollment, type MemberSlotLink } from '../lib/cashApi.ts';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function LinkOnce({ link }: { link: IssuedEnrollment }): JSX.Element {
  const url = `${window.location.origin}/enrol#${link.token}`;
  return (
    <div className="rs-ready-link">
      <p className="rs-item-title">A link for {link.displayName}</p>
      <p>{url}</p>
      <p className="rs-hint">
        Send it to them privately. It works once, stops working on{' '}
        {new Date(link.expiresAt).toLocaleString()}, and cannot be shown again — Brain stored a
        digest of it and not the link.
      </p>
    </div>
  );
}

/**
 * The invite control.
 *
 * Only rendered for a Brain administrator, and that is a *convenience* rather
 * than the control: the route refuses anybody else with the same 404 a missing
 * one gives, whatever this component renders.
 */
function Invite({
  links,
  onChanged,
}: {
  links: MemberSlotLink[];
  onChanged(): void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedEnrollment | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function invite(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await CashApi.inviteMember(name.trim());
      setIssued(answer.enrollment);
      setName('');
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
      {issued ? <LinkOnce link={issued} /> : null}

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
                  void CashApi.withdrawLink(one.id, 'Withdrawn before it was used.').then(onChanged);
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

export function ReadinessPanel({
  readiness,
  isBrainAdmin,
}: {
  readiness: CashReadiness;
  isBrainAdmin: boolean;
}): JSX.Element {
  const [links, setLinks] = useState<MemberSlotLink[] | null>(null);
  const [failed, setFailed] = useState(false);

  const read = useCallback(() => {
    if (!isBrainAdmin) return;
    CashApi.members().then(
      (answer) => setLinks(answer.links),
      () => setFailed(true),
    );
  }, [isBrainAdmin]);

  useEffect(read, [read]);

  return (
    <div className="rs-ready">
      <div className="rs-ready-count">
        <span>Human members</span>
        <strong>
          {readiness.members.ready} / {readiness.members.required} READY
        </strong>
      </div>
      <ul className="rs-ready-list">
        {readiness.members.rows.map((row) => (
          <li key={row.userId} className="rs-ready-row">
            <span>{row.displayName}</span>
            <span className="rs-ready-state" data-state={row.state}>
              {row.state === 'READY' ? 'READY' : row.state === 'INVITED' ? 'Link sent' : 'No link yet'}
            </span>
          </li>
        ))}
      </ul>

      {/*
        * Two counts, because they count two things.
        *
        * This said `1 / 4 HEALTHY` next to a fleet reporting four eligible
        * research Routines, and both numbers were right: one account is
        * proven and it carries all four surfaces. A reader had no way to tell
        * which of the two they were looking at. Neither figure was changed to
        * make them agree — they are labelled as what they count.
        */}
      <div className="rs-ready-count">
        <span>Claude capacity accounts, with a proven surface</span>
        <strong>
          {readiness.capacity.healthy} / {readiness.capacity.rows.length} proven
        </strong>
      </div>
      <div className="rs-ready-count">
        <span>Execution surfaces Brain can fire</span>
        <strong>
          {readiness.capacity.eligibleSurfaces ?? 0} of {readiness.capacity.totalSurfaces ?? 0}{' '}
          eligible
        </strong>
      </div>
      <ul className="rs-ready-list">
        {readiness.capacity.rows.length === 0 ? (
          <li className="rs-ready-row">
            <span>No capacity account is registered yet.</span>
          </li>
        ) : (
          readiness.capacity.rows.map((row) => {
            /*
             * Optional access, for the reason every other reader here has one.
             *
             * A deploy replaces the server and the browser tab separately, so
             * a client built after these fields existed can be holding a
             * reading fetched before they did. Rendering the account without
             * its surface count is right there; throwing takes the whole
             * panel — and with it the invitation control — down over a number.
             */
            const surfaces = row.surfaces ?? [];
            return (
            <li key={row.accountId} className="rs-ready-row">
              <span>
                {row.name}
                {surfaces.length > 0 ? (
                  <small className="rs-hint">
                    {' '}
                    {row.eligibleSurfaces ?? 0} of {surfaces.length}{' '}
                    {surfaces.length === 1 ? 'surface' : 'surfaces'} eligible
                  </small>
                ) : null}
              </span>
              <span className="rs-ready-state" data-state={row.state}>
                {row.state}
              </span>
              {row.because ? <span className="rs-hint">{row.because}</span> : null}
              {surfaces
                .filter((surface) => !surface.eligible)
                .map((surface) => (
                  <span key={surface.routineId} className="rs-hint">
                    {surface.name} is {surface.state.toLowerCase()}
                    {surface.because ? `: ${surface.because}` : ''}
                  </span>
                ))}
            </li>
            );
          })
        )}
      </ul>
      <p className="rs-hint">
        An account holds a subscription allowance; a surface is a Routine Brain fires at. One
        account can carry four surfaces, so these two numbers are not the same number and are not
        meant to agree. An account is proven only once a session Brain fired has arrived and
        finished a piece of work — being registered is configured, which is a different word on
        purpose. Neither count starts or stops anything.
      </p>

      {isBrainAdmin && !failed ? <Invite links={links ?? []} onChanged={read} /> : null}
    </div>
  );
}
