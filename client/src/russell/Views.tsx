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
import { useState, type ReactNode } from 'react';
import { Constellation } from './Constellation.tsx';
import { freshnessLabel, listState, readingState } from './present.ts';
import { useAsync } from './useAsync.ts';
import { RussellApi } from '../lib/russellApi.ts';
import type {
  IdeaNode,
  KnowsEntry,
  Progress,
  RussellHumanRequest,
  WhoView as WhoData,
  WorkEntry,
} from '../lib/russellApi.ts';

/**
 * Progress, shown as what it actually is.
 *
 * A stage word and a fraction *only when the server gave one* — `ratio` is null
 * whenever the milestone set is open, and rendering a bar over an unknown
 * denominator is exactly the invented precision the projection refuses to
 * produce. The milestones are listed underneath because "Forming" on its own
 * tells nobody what is left.
 */
export function ProgressLine({
  progress,
}: {
  /*
   * Deliberately wider than the current shape.
   *
   * A cached bundle against a restarted server sees the older briefing, where
   * progress was one sentence, and a component that threw on it would turn a
   * smaller answer into a blank screen — the same failure as printing "nothing
   * yet" over real data, reached from the other side. So a string renders as
   * the sentence it is, and a missing value renders nothing at all.
   */
  progress: Progress | string | null | undefined;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (progress === null || progress === undefined) return null;
  if (typeof progress === 'string') {
    return <p className="rs-progress-headline">{progress}</p>;
  }
  if (typeof progress.stage !== 'string') {
    // A shape neither this version nor the last one produces. Rendering the
    // headline if there is one beats rendering an exception.
    return <p className="rs-progress-headline">{String(progress.headline ?? '')}</p>;
  }
  return (
    <div className="rs-progress">
      <p className={`rs-progress-headline rs-stage-${progress.stage.toLowerCase()}`}>
        {progress.headline}
      </p>
      {progress.ratio ? (
        <div
          className="rs-progress-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.ratio.total}
          aria-valuenow={progress.ratio.done}
          aria-label={progress.headline}
        >
          <span style={{ width: `${(progress.ratio.done / progress.ratio.total) * 100}%` }} />
        </div>
      ) : null}
      {progress.blockedBy.length > 0 ? (
        <ul className="rs-progress-blocked">
          {progress.blockedBy.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {progress.completed.length + progress.missing.length > 0 ? (
        <>
          <button type="button" className="rs-more" onClick={() => setOpen(!open)}>
            {open ? 'Hide the details' : 'What is done, and what is left'}
          </button>
          {open ? (
            <ul className="rs-milestones">
              {progress.completed.map((milestone) => (
                <li key={milestone.key} className="rs-milestone-done">
                  {milestone.title}
                </li>
              ))}
              {progress.missing.map((milestone) => (
                <li key={milestone.key} className="rs-milestone-open">
                  {milestone.title}
                  {milestone.detail ? <span className="rs-item-meta"> — {milestone.detail}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

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

/**
 * Everything being worked on, in the five groups a person reads.
 *
 * Reads the server's whole-project projection rather than the mission table
 * alone. That is the fix for the defect that mattered most here: the Brain was
 * running a real research packet and this screen said there was no work,
 * because every packet predated Russell and lived in a different table.
 *
 * The technical toggle is off by default and says how much it is holding back.
 * "Nothing here" and "nothing here, and four harness rows hidden" are different
 * facts, and a person who cannot see the second one will eventually conclude
 * the first is a bug.
 */
export function WorkView({ projectId }: { projectId: string | null }): JSX.Element {
  const [technical, setTechnical] = useState(false);
  const query = useAsync(
    () =>
      projectId
        ? RussellApi.work(projectId, { technical })
        : Promise.resolve(null),
    [projectId, technical],
  );
  const work = query.data?.work;
  const state = listState<WorkEntry>({
    loading: query.loading,
    error: query.error,
    items: work?.items ?? null,
    noun: 'work',
    emptyReason: work?.emptyReason ?? null,
  });
  const groups = (work?.groups ?? []).filter((group) => group.entries.length > 0);
  return (
    <Panel title="Work" state={state} onRetry={query.reload}>
      {groups.map((group) => (
        <div key={group.group} className="rs-group">
          <h3 className="rs-group-title">{GROUP_TITLES[group.group] ?? group.group}</h3>
          <ul className="rs-list">
            {group.entries.map((entry) => (
              <li key={entry.id}>
                <span className="rs-item-title">{entry.title}</span>
                <span className="rs-item-meta">
                  {plainWorkState(entry)}
                  {entry.provenance !== 'PROJECT' ? ` · ${PROVENANCE_WORDS[entry.provenance]}` : ''}
                </span>
                {entry.why ? <span className="rs-item-meta">{entry.why}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {work && !technical && work.technicalHidden > 0 ? (
        <button type="button" className="rs-more" onClick={() => setTechnical(true)}>
          Also show {work.technicalHidden} technical{' '}
          {work.technicalHidden === 1 ? 'item' : 'items'} — fixtures, harness runs and
          conversation machinery
        </button>
      ) : null}
      {technical ? (
        <button type="button" className="rs-more" onClick={() => setTechnical(false)}>
          Hide technical items
        </button>
      ) : null}
    </Panel>
  );
}

/** The five headings. One mapping, so two screens cannot disagree. */
const GROUP_TITLES: Record<string, string> = {
  WORKING_NOW: 'Working now',
  UP_NEXT: 'Up next',
  EXPLORING: 'Exploring',
  WAITING: 'Waiting',
  FINISHED: 'Finished',
};

/** Plain words for where work came from, when it did not come from the project. */
const PROVENANCE_WORDS: Record<string, string> = {
  PROJECT: 'project work',
  FIXTURE: 'a written-in fixture',
  HARNESS: 'the machinery proving itself',
  CONVERSATION: 'answering you',
  TECHNICAL_SCOPE: 'a technical scope',
};

/** A state name a person would use, never the enum. */
function plainWorkState(entry: WorkEntry): string {
  switch (entry.group) {
    case 'WORKING_NOW':
      return 'being worked on now';
    case 'UP_NEXT':
      return 'about to start';
    case 'EXPLORING':
      return 'being decided about';
    case 'WAITING':
      return `waiting on ${entry.waitingOn ?? 'something outside Russell'}`;
    case 'FINISHED':
    default:
      return entry.state === 'DONE' || entry.state === 'COMPLETE'
        ? 'finished'
        : entry.state === 'CANCELLED'
          ? 'stopped'
          : 'did not work out';
  }
}

/**
 * Ideas — the site, its major ideas, and the ordinary ideas inside them.
 *
 * A drill-down over the same projection the constellation lays out, which is
 * why it is also the map's accessible fallback: not a second description of the
 * shape, the *same* one rendered as a list. A person on a screen reader and a
 * person dragging a map are looking at identical facts.
 *
 * Selecting a node moves focus into it and the breadcrumb keeps orientation.
 * There is no "back" that loses where you were, because the path is derived
 * from the node rather than from a history stack.
 */
export function IdeasView({
  projectId,
  focusId,
  onFocus,
}: {
  projectId: string | null;
  focusId?: string | null;
  onFocus?: (nodeId: string) => void;
}): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.ideas(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  const map = query.data?.map ?? null;
  const focus = focusId ?? localFocus ?? map?.rootId ?? null;

  const children = map && focus ? map.nodes.filter((node) => node.parentId === focus) : [];
  const current = map && focus ? map.nodes.find((node) => node.id === focus) : undefined;
  const state = listState<IdeaNode>({
    loading: query.loading,
    error: query.error,
    // The children of whatever is in focus. A leaf with none is genuinely
    // empty, and says so rather than showing the whole map again.
    items: map ? children : null,
    noun: 'ideas',
    emptyReason: query.data?.state.emptyReason ?? null,
  });

  function select(nodeId: string): void {
    setLocalFocus(nodeId);
    onFocus?.(nodeId);
  }

  const trail: IdeaNode[] = [];
  if (map && current) {
    const byId = new Map(map.nodes.map((node) => [node.id, node]));
    let walk: IdeaNode | undefined = current;
    let guard = map.nodes.length + 1;
    while (walk && guard-- > 0) {
      trail.unshift(walk);
      walk = walk.parentId ? byId.get(walk.parentId) : undefined;
    }
  }

  return (
    <Panel title="Ideas" state={state} onRetry={query.reload}>
      {/*
        The map and the list are the same projection at two resolutions. The
        map is the shape; the list is the same facts in reading order, which is
        what a screen reader gets and what a person gets when the shape is not
        what they need. Neither is a summary of the other.
      */}
      {map && focus ? (
        <Constellation map={map} focusId={focus} onFocus={select} />
      ) : null}
      {trail.length > 0 ? (
        <nav className="rs-crumbs" aria-label="Where you are">
          {trail.map((node, index) => (
            <button
              key={node.id}
              type="button"
              className="rs-crumb"
              disabled={index === trail.length - 1}
              onClick={() => select(node.id)}
            >
              {node.title}
            </button>
          ))}
        </nav>
      ) : null}
      {current ? (
        <div className="rs-node-detail">
          {current.purpose ? <p>{current.purpose}</p> : null}
          {current.why ? <p className="rs-item-meta">{current.why}</p> : null}
          <ProgressLine progress={current.progress} />
          <p className="rs-item-meta">
            {current.counts.knowledge} known · {current.counts.unknowns} still open ·{' '}
            {current.counts.work} {current.counts.work === 1 ? 'piece' : 'pieces'} of work
          </p>
        </div>
      ) : null}
      <ul className="rs-list">
        {state.items.map((node) => (
          <li key={node.id}>
            <button type="button" className="rs-node" onClick={() => select(node.id)}>
              <span className="rs-item-title">{node.title}</span>
              <span className="rs-item-meta">
                {node.stateLabel}
                {node.priorityLabel ? ` · ${node.priorityLabel}` : ''}
              </span>
              {node.why ? <span className="rs-item-meta">{node.why}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Who is here, and what can run.
 *
 * Two lists with different rules. People are collaborators; surfaces are
 * machinery. A caller who does not administer the project never receives the
 * second one from the server at all — this component cannot show it, because
 * there is nothing in the response to show, which is the point of doing the
 * gating on the server rather than in a conditional here.
 */
export function WhoView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.who(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const view: WhoData | null = query.data ?? null;
  const state = readingState({
    loading: query.loading,
    error: query.error,
    value: view,
    noun: 'people',
  });
  return (
    <Panel title="Who" state={state} onRetry={query.reload}>
      {view ? (
        <>
          <ul className="rs-list">
            {view.people.map((person) => (
              <li key={person.id}>
                <span className="rs-item-title">
                  {person.name}
                  {person.isYou ? ' (you)' : ''}
                </span>
                <span className="rs-item-meta">
                  {person.roleLabel}
                  {person.email ? ` · ${person.email}` : ''}
                  {person.active ? '' : ' · no longer active'}
                </span>
              </li>
            ))}
          </ul>
          {view.people.length === 0 ? (
            <p className="rs-state rs-state-empty">Nobody else is on this project yet.</p>
          ) : null}
          <h3 className="rs-group-title">What can run</h3>
          <p className="rs-fleet-line">{view.capacityExplanation}</p>
          {view.surfaces ? (
            <ul className="rs-list">
              {view.surfaces.map((surface) => (
                <li key={surface.id}>
                  <span className="rs-item-title">
                    {surface.name} · {surface.accountName}
                  </span>
                  <span className="rs-item-meta">
                    {surface.health}
                    {surface.target !== null ? ` · carrying up to ${surface.target}` : ''}
                    {surface.boundWorker ? ` · ${surface.boundWorker}` : ''}
                    {surface.configured ? '' : ' · not configured'}
                  </span>
                  {surface.reason ? <span className="rs-item-meta">{surface.reason}</span> : null}
                  <span className="rs-item-meta">
                    {surface.fires} {surface.fires === 1 ? 'run' : 'runs'} · {surface.refusals}{' '}
                    turned away · {surface.noShows} did not turn up
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
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
