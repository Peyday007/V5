/**
 * The thin views.
 *
 * Thin is the specification, not a shortcut: each of these answers one question
 * a person actually asks — what is being worked on, what does Russell know, who
 * is doing it, what do you need from me — and stops. Anything richer is Step
 * 12B, and building it here would be building the thing that was deferred.
 *
 * Every one of them renders through `listState`, so loading, empty, forbidden
 * and error are decided in one tested place rather than five untested ones.
 */
import type { ReactNode } from 'react';
import { freshnessLabel, listState, readingState } from './present.ts';
import { useAsync } from './useAsync.ts';
import { RussellApi } from '../lib/russellApi.ts';
import type {
  RussellCandidate,
  RussellHumanRequest,
  KnowsEntry,
  RussellMission,
} from '../lib/russellApi.ts';

/** The shared frame: a heading, a state sentence, and whatever is ready. */
function Panel(props: {
  title: string;
  state: { phase: string; message: string; retryable: boolean };
  onRetry?: () => void;
  children?: ReactNode;
}): JSX.Element {
  const { title, state, onRetry, children } = props;
  return (
    <section className="rs-panel" aria-labelledby={`rs-${title.replace(/\s+/g, '-').toLowerCase()}`}>
      <h2 id={`rs-${title.replace(/\s+/g, '-').toLowerCase()}`}>{title}</h2>
      {state.phase !== 'READY' ? (
        <p className={`rs-state rs-state-${state.phase.toLowerCase()}`} role={state.phase === 'ERROR' ? 'alert' : undefined}>
          {state.message}
          {state.retryable && onRetry ? (
            <button type="button" className="rs-retry" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function WorkView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.work(projectId) : Promise.resolve({ missions: [] })),
    [projectId],
  );
  const state = listState<RussellMission>({
    loading: query.loading,
    error: query.error,
    items: query.data?.missions ?? null,
    noun: 'work',
  });
  return (
    <Panel title="Work" state={state} onRetry={query.reload}>
      <ul className="rs-list">
        {state.items.map((mission) => (
          <li key={mission.id}>
            <span className="rs-item-title">{mission.objective}</span>
            <span className="rs-item-meta">{plainMissionState(mission)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** A state name a person would use, never the enum. */
function plainMissionState(mission: RussellMission): string {
  switch (mission.state) {
    case 'RUNNING':
      return 'being worked on now';
    case 'PLANNED':
    case 'LAUNCHING':
      return 'about to start';
    case 'WAITING':
      return `waiting on ${mission.waitingOn ?? 'something outside Russell'}`;
    case 'NEEDS_HUMAN':
      return 'waiting for you';
    case 'DONE':
      return 'finished';
    case 'FAILED':
      return 'did not work out';
    case 'CANCELLED':
      return 'stopped';
  }
}

export function ProjectsView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.candidates(projectId) : Promise.resolve({ candidates: [] })),
    [projectId],
  );
  const state = listState<RussellCandidate>({
    loading: query.loading,
    error: query.error,
    items: query.data?.candidates ?? null,
    noun: 'ideas',
  });
  return (
    <Panel title="Ideas" state={state} onRetry={query.reload}>
      <ul className="rs-list">
        {state.items.map((candidate) => (
          <li key={candidate.id}>
            <span className="rs-item-title">{candidate.title}</span>
            <span className="rs-item-meta">{candidate.reason ?? ''}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * What the Brain knows — its own captures *and* the research archive.
 *
 * The archive half is the point. Before it, this panel read one table Russell
 * had barely started filling and told a person there was nothing here, while
 * every claim Steps 9 to 11 filed sat one join away. A missing projection and
 * an empty Brain look identical from a screen, which is why the server now
 * returns the reason a list is empty rather than leaving the interface to
 * guess.
 */
export function KnowledgeView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () =>
      projectId
        ? RussellApi.knowledge(projectId)
        : Promise.resolve({
            knowledge: [],
            knows: { items: [], emptyReason: 'EMPTY' as const, explanation: null },
          }),
    [projectId],
  );
  const state = listState<KnowsEntry>({
    loading: query.loading,
    error: query.error,
    /*
     * Optional all the way down, deliberately.
     *
     * A Brain serving the older shape has no `knows` field at all, and a view
     * that throws on a missing field turns a smaller answer into a blank
     * screen — which is the same failure as printing "nothing yet" over real
     * data, arrived at from the other direction.
     */
    items: query.data?.knows?.items ?? null,
    // The server's own sentence when it gave one, so "nothing active" is never
    // rendered as "nothing yet".
    noun: query.data?.knows?.explanation ?? 'findings',
  });
  return (
    <Panel title="What Russell knows" state={state} onRetry={query.reload}>
      <ul className="rs-list">
        {state.items.map((entry) => (
          <li key={entry.id}>
            <span className="rs-item-title">{entry.statement}</span>
            <span className="rs-item-meta">
              {entry.status.toLowerCase()} · {entry.confidence.toLowerCase()}
              {entry.provenance.sourceUrl ? ' · cited' : ''}
            </span>
            {/*
              A provisional entry says what it is short of. Hiding that would
              make it read like an accepted one, which is the single thing this
              surface must never do.
            */}
            {entry.missingEvidence.length > 0 && (
              <span className="rs-item-meta">
                still missing: {entry.missingEvidence.join('; ')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * The fleet, as one honest sentence.
 *
 * Deliberately not a control panel: Step 12B owns that. What a person needs
 * here is whether the thing that does the work is reachable and when this was
 * last true, and a reading Russell could not refresh says so rather than
 * silently ageing.
 */
export function FleetView(): JSX.Element {
  const query = useAsync(() => RussellApi.dealDispatch(), []);
  const view = query.data;
  // A reading, not a list: `readingState` owns loading, forbidden and error and
  // has no empty case, because "nothing could be read" is itself a reading.
  const state = readingState({
    loading: query.loading,
    error: query.error,
    value: view,
    noun: 'fleet',
  });
  return (
    <Panel title="Who is doing the work" state={state} onRetry={query.reload}>
      {view ? (
        <>
          {view.purpose ? <p className="rs-fleet-line">{view.purpose}</p> : null}
          {view.reason ? <p className="rs-fleet-line">{view.reason}</p> : null}
          <p className="rs-fleet-line">
            {view.openMissionCount === 0
              ? 'Nothing is being worked on right now.'
              : `${view.openMissionCount} ${view.openMissionCount === 1 ? 'thing is' : 'things are'} being worked on.`}
          </p>
          {view.activeWork.length > 0 ? (
            <ul className="rs-list">
              {view.activeWork.map((entry) => (
                <li key={entry.name}>
                  <span className="rs-item-title">{entry.name}</span>
                  <span className="rs-item-meta">{entry.state}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {view.blocked.length > 0 ? (
            <p className="rs-fleet-line">
              {view.blocked.length} {view.blocked.length === 1 ? 'part is' : 'parts are'} stuck:{' '}
              {view.blocked.map((entry) => entry.name).join(', ')}.
            </p>
          ) : null}
          {/* Freshness is shown always, not only when stale: a person reading a
              current answer should be able to see that it is current. */}
          <p className={`rs-state rs-state-${view.freshness.toLowerCase()}`}>
            {freshnessLabel({ freshness: view.freshness, asOf: view.observedAt })}
          </p>
        </>
      ) : null}
    </Panel>
  );
}

export function NeedsYouView({
  projectId,
  onAnswered,
}: {
  projectId: string | null;
  onAnswered?: () => void;
}): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.needsYou(projectId) : Promise.resolve({ requests: [] })),
    [projectId],
  );
  const state = listState<RussellHumanRequest>({
    loading: query.loading,
    error: query.error,
    items: query.data?.requests ?? null,
    noun: 'decisions',
  });

  async function answer(requestId: string, choice: string): Promise<void> {
    // No optimistic update. The list re-reads from the server, so what a person
    // sees after answering is what actually happened rather than what was asked
    // for — and a refused answer shows as refused instead of appearing to work.
    await RussellApi.answer(requestId, choice);
    query.reload();
    onAnswered?.();
  }

  return (
    <Panel title="Needs you" state={state} onRetry={query.reload}>
      <ul className="rs-list">
        {state.items.map((request) => (
          <li key={request.id}>
            <span className="rs-item-title">{request.authorityNeeded}</span>
            {/* Why Russell is asking rather than deciding. A request with no
                stated reason would be indistinguishable from Russell simply
                declining to do its job. */}
            <span className="rs-item-meta">{request.whyNotRussell}</span>
            {request.recommendation ? (
              <span className="rs-item-meta">Russell suggests: {request.recommendation}</span>
            ) : null}
            <div className="rs-choices">
              {request.choices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => {
                    void answer(request.id, choice.key);
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
