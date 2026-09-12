/**
 * The Discovery Frontier, as a person reads it.
 *
 * Five regions in the order that decides what to do next: what is known to be
 * unanswered, what is believed on thin evidence, what nobody has looked at,
 * what Russell found for itself, and — last, because it needs nothing — what is
 * understood well enough to build on.
 *
 * Two things here are not decoration. Every item names the row it was derived
 * from, so a person can tell a reading from an impression. And an unexamined
 * area can be marked deliberately not required, with a reason, which is the one
 * way a dark spot becomes an explicit decision instead of a silent absence.
 */
import { useState } from 'react';
import { RussellApi } from '../lib/russellApi.ts';
import type { FrontierRegionView } from '../lib/russellApi.ts';
import type { RussellFrontierItem } from '../../../server/domain/types.ts';
import { useAsync } from './useAsync.ts';
import { humanWhen, readingState } from './present.ts';

/** The modifier each region's pill carries. `rs-pill` is always the base. */
const REGION_TONE: Record<string, string> = {
  OPEN_QUESTION: 'rs-pill-watch',
  WEAK_GROUND: 'rs-pill-watch',
  UNEXAMINED: '',
  NEW_PATH: 'rs-pill-accent',
  SOLID_GROUND: 'rs-pill-good',
};

/**
 * Which question produced a reading, in words.
 *
 * The lens is what makes an item actionable — "believed on thin evidence" and
 * "an audit said this is missing" lead to different next moves, and a card that
 * showed only the region would flatten them into one.
 */
const LENS_WORDS: Record<string, string> = {
  UNSUPPORTED_ASSUMPTION: 'Never tested',
  CONTRADICTION: 'Findings disagree',
  UNSTUDIED_REGION: 'Not looked at',
  THIN_EVIDENCE: 'Thin evidence',
  OPEN_GAP: 'An audit said so',
};

/** Where a reading came from, in words rather than an enum. */
const SOURCE_WORDS: Record<string, string> = {
  KNOWLEDGE: 'from something Russell recorded',
  LAYER: 'from a part of the model',
  AUDIT_GAP: 'from an audit',
  CANDIDATE: 'from an idea Russell had',
  CONTRADICTION: 'from a disagreement in the evidence',
  ABSENCE: 'from something that is not there',
};

export function FrontierView_({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.frontier(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const state = readingState({
    loading: query.loading,
    error: query.error,
    value: query.data ?? null,
    noun: 'this project',
  });
  if (state.phase !== 'READY' || !query.data) {
    return <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>{state.message}</p>;
  }
  const frontier = query.data.frontier;
  const anything = frontier.regions.some((region) => region.items.length > 0);

  return (
    <div className="rs-column">
      <p className="rs-eyebrow">Discovery frontier</p>
      <h3 className="rs-view-title">Where this runs out</h3>
      <p className="rs-lede">
        Read from the project's own records every time this page opens. Nothing here is an
        impression — each line names what it came from.
      </p>

      {!anything ? (
        <p className="rs-state rs-state-empty">
          Nothing has been recorded about this project yet, so there is no edge to read. This
          fills in as research is accepted and audits run.
        </p>
      ) : null}

      {frontier.regions.map((region) => (
        <Region key={region.region} region={region} projectId={projectId} onChanged={query.reload} />
      ))}

      {/*
        The questions a reader has to answer.

        Put, never answered: a Brain that filled these in from a template would
        be manufacturing insight, which is the one thing a discovery engine
        must not do. Each carries the subject it is about, because the same
        question asked about nothing is a slogan.
      */}
      <section className="rs-group rs-at-interested">
        <h4 className="rs-group-title">Questions Russell cannot answer by itself</h4>
        <ul className="rs-list">
          {frontier.openLenses.map((lens) => (
            <li key={lens.lens}>
              <span className="rs-item-title">{lens.question}</span>
              {lens.about ? <span className="rs-item-meta">About: {lens.about}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      {/* What this pass produced, so the capability can be measured rather
          than merely claimed. */}
      <p className="rs-hint rs-at-technical">
        {frontier.counts.live} live · {frontier.counts.dismissed} marked not required ·{' '}
        {frontier.counts.resolved} no longer on the frontier
      </p>
    </div>
  );
}

function Region({
  region,
  projectId,
  onChanged,
}: {
  region: FrontierRegionView;
  projectId: string | null;
  onChanged(): void;
}): JSX.Element | null {
  if (region.items.length === 0) return null;
  return (
    <section className="rs-group">
      <h4 className="rs-group-title">
        {region.label}
        <span className="rs-count">{region.items.length}</span>
      </h4>
      <p className="rs-hint">{region.meaning}</p>
      <ul className="rs-list">
        {region.items.map((item) => (
          <li key={item.id}>
            <Item item={item} region={region.region} projectId={projectId} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Item({
  item,
  region,
  projectId,
  onChanged,
}: {
  item: RussellFrontierItem;
  region: string;
  projectId: string | null;
  onChanged(): void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const since = humanWhen(item.firstSeenAt);

  /*
   * The reason is passed, never read from state.
   *
   * "Put it back" used to set the reason and call this in the same handler,
   * which reads the *previous* render's value — so the server would have been
   * sent an empty reason and refused it, and the button would have looked
   * broken for a reason nobody could see from the screen.
   */
  async function set(dismissed: boolean, why: string): Promise<void> {
    if (!projectId || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await RussellApi.setFrontierDismissed(projectId, item.id, dismissed, why.trim());
      setOpen(false);
      setReason('');
      onChanged();
    } catch {
      setProblem('That did not go through. Nothing was changed — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rs-card">
      <div className="rs-row">
        <span className="rs-item-title">{item.subject}</span>
        {item.lens ? (
          <span className={`rs-pill ${REGION_TONE[region] ?? ''}`.trim()}>
            {LENS_WORDS[item.lens] ?? item.lens}
          </span>
        ) : null}
      </div>
      {item.detail ? <p className="rs-item-meta">{item.detail}</p> : null}
      <p className="rs-item-meta">
        {SOURCE_WORDS[item.sourceKind] ?? 'from the project’s records'}
        {since ? (
          <>
            {' · on the frontier since '}
            <time dateTime={item.firstSeenAt} title={since.exact}>
              {since.text}
            </time>
          </>
        ) : null}
      </p>

      {item.dismissedAt ? (
        <p className="rs-item-meta">
          Marked not required: {item.dismissedReason}{' '}
          <button
            type="button"
            className="rs-link"
            disabled={busy}
            onClick={() => void set(false, 'It is required after all.')}
          >
            Put it back
          </button>
        </p>
      ) : open ? (
        <div className="rs-build-submit">
          <label className="rs-decision-label" htmlFor={`rs-frontier-${item.id}`}>
            Why is this deliberately not required?
          </label>
          <input
            id={`rs-frontier-${item.id}`}
            type="text"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="rs-row">
            <button
              type="button"
              className="rs-button"
              disabled={busy || reason.trim().length === 0}
              onClick={() => void set(true, reason)}
            >
              {busy ? 'Saving…' : 'Mark not required'}
            </button>
            <button type="button" className="rs-button-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="rs-button-quiet" onClick={() => setOpen(true)}>
          Not required here
        </button>
      )}

      {problem ? (
        <p className="rs-state rs-state-error" role="alert">
          {problem}
        </p>
      ) : null}
    </article>
  );
}

export const Frontier = FrontierView_;
