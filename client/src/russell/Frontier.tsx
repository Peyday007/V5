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
import type { FrontierRegionView, FrontierView } from '../lib/russellApi.ts';
import type { RussellFrontierItem } from '../../../server/domain/types.ts';
import type { SharedFindingView } from '../../../server/services/knowledge/shared.ts';
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

  return (
    <div className="rs-column">
      <p className="rs-eyebrow">Discovery frontier</p>
      <h3 className="rs-view-title">Where this runs out</h3>
      <p className="rs-lede">
        Read from the project's own records every time this page opens. Nothing here is an
        impression — each line names what it came from.
      </p>

      {state.phase !== 'READY' || !query.data ? (
        <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>{state.message}</p>
      ) : (
        <ProjectFrontier
          frontier={query.data.frontier}
          projectId={projectId}
          onChanged={query.reload}
        />
      )}

      {/*
        Shared across every project in this Brain — §31 — and deliberately
        independent of `projectId`: the pool is Brain-wide, so it renders
        whether or not a project is selected and whatever the state of the
        five regions above.
      */}
      <SharedFindings />
    </div>
  );
}

/**
 * The five project-scoped regions, the open lenses and the pass counts.
 *
 * Pulled out of `FrontierView_` so the `SharedFindings` section below it is
 * never nested inside this block's own loading/empty/error branches — the pool
 * is Brain-wide and must render whatever this project's own reading says.
 */
function ProjectFrontier({
  frontier,
  projectId,
  onChanged,
}: {
  frontier: FrontierView;
  projectId: string | null;
  onChanged(): void;
}): JSX.Element {
  const anything = frontier.regions.some((region) => region.items.length > 0);

  return (
    <>
      {!anything ? (
        <p className="rs-state rs-state-empty">
          Nothing has been recorded about this project yet, so there is no edge to read. This
          fills in as research is accepted and audits run.
        </p>
      ) : null}

      {frontier.regions.map((region) => (
        <Region key={region.region} region={region} projectId={projectId} onChanged={onChanged} />
      ))}

      {/*
        The questions a reader has to answer.

        Put, never answered: a Brain that filled these in from a template would
        be manufacturing insight, which is the one thing a discovery engine
        must not do. Each carries the subject it is about, because the same
        question asked about nothing is a slogan.
      */}
      <AskedLenses projectId={projectId} openLenses={frontier.openLenses} />

      {/* What this pass produced, so the capability can be measured rather
          than merely claimed. */}
      <p className="rs-hint rs-at-technical">
        {frontier.counts.live} live · {frontier.counts.dismissed} marked not required ·{' '}
        {frontier.counts.resolved} no longer on the frontier
      </p>
    </>
  );
}

/**
 * The questions only a reader can settle, and the path to settling one.
 *
 * These used to be a list with nothing behind it: five questions on a screen
 * and no way to ask any of them. A question a person can read and cannot act
 * on is the same defect as a state that says "waiting for a person" with no
 * transition out — so each one now carries **Ask this**, which opens a governed
 * inquiry, and the findings that come back are decided here rather than
 * applied.
 *
 * What is deliberately *not* here: any way for this screen to accept a finding
 * automatically, and any rendering of a finding that did not survive
 * validation. A discarded proposal is shown as a count and a reason, never as
 * something a person can promote — the server already decided it does not
 * resolve to a row, and offering it anyway would put the judgement back in the
 * place this whole path took it out of.
 */
function AskedLenses({
  projectId,
  openLenses,
}: {
  projectId: string | null;
  openLenses: { lens: string; question: string; about: string | null }[];
}): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.lenses(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const inquiries = query.data?.inquiries ?? [];

  return (
    <section className="rs-group rs-at-interested">
      <h4 className="rs-group-title">Questions Russell cannot answer by itself</h4>
      <ul className="rs-list">
        {openLenses.map((lens) => {
          const inquiry = inquiries.find((entry) => entry.lens === lens.lens) ?? null;
          return (
            <li key={lens.lens}>
              <article className="rs-card">
                <div className="rs-row">
                  <span className="rs-item-title">{lens.question}</span>
                  {inquiry ? (
                    <span className="rs-pill">{INQUIRY_WORDS[inquiry.state] ?? inquiry.state}</span>
                  ) : null}
                </div>
                {lens.about ? <p className="rs-item-meta">About: {lens.about}</p> : null}

                {inquiry === null || inquiry.state === 'FAILED' || inquiry.state === 'REFUSED' ? (
                  <button
                    type="button"
                    className="rs-button"
                    disabled={busy !== null || !projectId}
                    onClick={() => {
                      if (!projectId) return;
                      setBusy(lens.lens);
                      void RussellApi.askLens(projectId, lens.lens)
                        .then(() => query.reload())
                        .finally(() => setBusy(null));
                    }}
                  >
                    {busy === lens.lens ? 'Asking…' : 'Ask this'}
                  </button>
                ) : null}

                {inquiry?.refusalReason ? (
                  <p className="rs-item-meta">{inquiry.refusalReason}</p>
                ) : null}

                {inquiry && inquiry.state === 'ANSWERED' ? (
                  <Findings inquiry={inquiry} projectId={projectId} onChanged={query.reload} />
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What an inquiry's state means, in words rather than an enum. */
const INQUIRY_WORDS: Record<string, string> = {
  REQUESTED: 'Waiting for a worker',
  RUNNING: 'A worker is reading',
  ANSWERED: 'Answered',
  REFUSED: 'The answer did not hold up',
  FAILED: 'Nothing came back',
  CANCELLED: 'Stopped',
};

/**
 * What came back, and what a person does with it.
 *
 * Each finding shows the rows it cites, because that is what separates it from
 * an opinion: every one of those ids resolved to something this project holds
 * when the server stored it.
 */
function Findings({
  inquiry,
  projectId,
  onChanged,
}: {
  inquiry: {
    id: string;
    findings: { subject: string; statement: string; rationale: string; references: { kind: string; id: string }[] }[];
    discarded: number;
    discardReasons: string[];
    decisions: { findingIndex: number; decision: string; reason: string | null }[];
  };
  projectId: string | null;
  onChanged(): void;
}): JSX.Element {
  const [busy, setBusy] = useState<number | null>(null);
  const decide = (index: number, decision: 'ACCEPTED' | 'DISMISSED'): void => {
    if (!projectId) return;
    setBusy(index);
    void RussellApi.decideLensFinding(projectId, inquiry.id, index, decision)
      .then(() => onChanged())
      .finally(() => setBusy(null));
  };

  return (
    <div className="rs-nested">
      {inquiry.findings.length === 0 ? (
        <p className="rs-item-meta">
          Nothing survived. That is an answer: the worker looked and proposed nothing this
          project's own rows could support.
        </p>
      ) : null}
      <ul className="rs-list">
        {inquiry.findings.map((finding, index) => {
          const decided = inquiry.decisions.find((entry) => entry.findingIndex === index) ?? null;
          return (
            <li key={`${inquiry.id}-${index}`}>
              <div className="rs-row">
                <span className="rs-item-title">{finding.subject}</span>
                {decided ? <span className="rs-pill">{decided.decision === 'ACCEPTED' ? 'Kept' : 'Dismissed'}</span> : null}
              </div>
              <p className="rs-item-meta">{finding.statement}</p>
              <p className="rs-item-meta rs-at-interested">{finding.rationale}</p>
              <p className="rs-ref rs-at-technical">
                cites {finding.references.map((ref) => `${ref.kind} ${ref.id}`).join(', ')}
              </p>
              {decided === null ? (
                <div className="rs-row">
                  <button
                    type="button"
                    className="rs-button"
                    disabled={busy !== null}
                    onClick={() => decide(index, 'ACCEPTED')}
                  >
                    Put it on the frontier
                  </button>
                  <button
                    type="button"
                    className="rs-button rs-button-quiet"
                    disabled={busy !== null}
                    onClick={() => decide(index, 'DISMISSED')}
                  >
                    Not this
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {inquiry.discarded > 0 ? (
        <details className="rs-at-technical">
          <summary>{inquiry.discarded} proposal(s) did not survive validation</summary>
          <ul className="rs-list">
            {inquiry.discardReasons.map((reason, index) => (
              <li key={index}>
                <p className="rs-item-meta">{reason}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
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

/**
 * A validated finding from any project in this Brain, and the two decisions
 * that belong to whichever project produced it (§31).
 *
 * Brain-wide rather than project-scoped, so it fetches for itself rather than
 * taking anything from `ProjectFrontier` — the pool exists whether or not a
 * project is selected. Every sentence about a finding is the server's own:
 * `withheldReason` and `decideRefusal` are rendered verbatim, never composed
 * or inferred here, and a revoked or expired finding stays listed rather than
 * disappearing.
 */
function SharedFindings(): JSX.Element {
  const query = useAsync(() => RussellApi.sharedFindings(), []);

  if (query.loading && !query.data) {
    return (
      <section className="rs-group rs-frontier-shared">
        <h4 className="rs-group-title">Shared across this Brain</h4>
        <p className="rs-state rs-state-loading">Reading the shared finding pool…</p>
      </section>
    );
  }
  if (query.error) {
    return (
      <section className="rs-group rs-frontier-shared">
        <h4 className="rs-group-title">Shared across this Brain</h4>
        <p className="rs-state rs-state-error">{query.error.message}</p>
      </section>
    );
  }
  if (!query.data) {
    return (
      <section className="rs-group rs-frontier-shared">
        <h4 className="rs-group-title">Shared across this Brain</h4>
        <p className="rs-state rs-state-loading">Reading the shared finding pool…</p>
      </section>
    );
  }

  const { findings, total, reusable } = query.data;

  return (
    <section className="rs-group rs-frontier-shared">
      <h4 className="rs-group-title">Shared across this Brain</h4>
      <p className="rs-hint">
        A validated finding from any project here, kept whole with its evidence. Withdrawing one,
        or setting how long it is good for, is the producing project's own decision.
      </p>
      <p className="rs-hint">
        {total} finding(s) total · {reusable} Brain would reuse right now
      </p>

      {findings.length === 0 ? (
        <p className="rs-state rs-state-empty">Nothing has been shared into this pool yet.</p>
      ) : (
        <ul className="rs-list">
          {findings.map((finding) => (
            <SharedFindingItem key={finding.id} finding={finding} onChanged={query.reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One shared finding, and the withdraw / horizon controls its own origin
 * project may use.
 *
 * Both controls are always rendered — never removed — and are disabled with
 * `finding.decideRefusal` verbatim when `finding.mayDecide` is false, following
 * the `{enabled, disabledReason}` convention `ConnectionControl`
 * (`services/capacity/connection.ts`) already established: "there is no
 * button" and "the button is not for you" read very differently.
 */
function SharedFindingItem({
  finding,
  onChanged,
}: {
  finding: SharedFindingView;
  onChanged(): void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [horizon, setHorizon] = useState(finding.validUntil ? finding.validUntil.slice(0, 10) : '');
  const [problem, setProblem] = useState<string | null>(null);

  async function withdraw(): Promise<void> {
    if (busy || reason.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    try {
      await RussellApi.withdrawSharedFinding(finding.id, reason.trim());
      setWithdrawing(false);
      setReason('');
      onChanged();
    } catch {
      setProblem('That did not go through. Nothing was changed — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveHorizon(validUntil: string | null): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await RussellApi.setSharedFindingHorizon(finding.id, validUntil);
      onChanged();
    } catch {
      setProblem('That did not go through. Nothing was changed — try again.');
    } finally {
      setBusy(false);
    }
  }

  const scope = [
    finding.scope.geography,
    finding.scope.timeframe,
    finding.scope.population,
    finding.scope.definition,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

  return (
    <li>
      <article className="rs-card">
        <div className="rs-row">
          <span className="rs-item-title">{finding.statement}</span>
          <span className="rs-pill">{finding.claimType}</span>
        </div>

        <p className="rs-item-meta">
          {finding.source.publisher ?? 'No publisher recorded'}
          {finding.source.date ? ` · ${finding.source.date}` : ''}
          {finding.source.url ? (
            <>
              {' · '}
              <a href={finding.source.url} target="_blank" rel="noreferrer">
                {finding.source.url}
              </a>
            </>
          ) : null}
        </p>
        {finding.source.excerpt ? (
          <p className="rs-item-meta rs-at-interested">“{finding.source.excerpt}”</p>
        ) : null}
        {finding.source.locator ? <p className="rs-ref rs-at-technical">{finding.source.locator}</p> : null}

        {scope ? <p className="rs-item-meta rs-at-technical">{scope}</p> : null}

        <p className="rs-item-meta">
          {finding.state}
          {finding.withheldReason ? ` · ${finding.withheldReason}` : ''}
        </p>

        <p className="rs-item-meta rs-at-technical">
          {finding.provenance.originVisible
            ? `From project ${finding.provenance.originProjectId}`
            : 'Which project this came from is not shown to you.'}
        </p>

        <div className="rs-row">
          {withdrawing ? (
            <div className="rs-build-submit">
              <label className="rs-decision-label" htmlFor={`rs-shared-reason-${finding.id}`}>
                Why is this being withdrawn?
              </label>
              <input
                id={`rs-shared-reason-${finding.id}`}
                type="text"
                value={reason}
                maxLength={500}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="rs-row">
                <button
                  type="button"
                  className="rs-button"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() => void withdraw()}
                >
                  {busy ? 'Withdrawing…' : 'Withdraw'}
                </button>
                <button
                  type="button"
                  className="rs-button-quiet"
                  disabled={busy}
                  onClick={() => {
                    setWithdrawing(false);
                    setReason('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="rs-button-quiet"
              disabled={busy || !finding.mayDecide}
              onClick={() => setWithdrawing(true)}
            >
              Withdraw
            </button>
          )}

          <label className="rs-item-meta" htmlFor={`rs-shared-horizon-${finding.id}`}>
            Good until
          </label>
          <input
            id={`rs-shared-horizon-${finding.id}`}
            type="date"
            value={horizon}
            disabled={busy || !finding.mayDecide}
            onChange={(event) => setHorizon(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || !finding.mayDecide || horizon.trim().length === 0}
            onClick={() => void saveHorizon(new Date(horizon).toISOString())}
          >
            Set
          </button>
          {finding.validUntil ? (
            <button
              type="button"
              className="rs-button-quiet"
              disabled={busy || !finding.mayDecide}
              onClick={() => {
                setHorizon('');
                void saveHorizon(null);
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        {!finding.mayDecide && finding.decideRefusal ? (
          <p className="rs-item-meta rs-at-technical">{finding.decideRefusal}</p>
        ) : null}

        {problem ? (
          <p className="rs-state rs-state-error" role="alert">
            {problem}
          </p>
        ) : null}
      </article>
    </li>
  );
}

export const Frontier = FrontierView_;
