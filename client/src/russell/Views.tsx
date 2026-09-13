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
import { Fragment, useState, type ReactNode } from 'react';
import { Constellation } from './Constellation.tsx';
import { Frontier } from './Frontier.tsx';
import { Maps } from './Maps.tsx';
import { freshnessLabel, humanWhen, listState, priorityTone, readingState } from './present.ts';
import { useAsync } from './useAsync.ts';
import { RussellApi } from '../lib/russellApi.ts';
import type { ConnectSiteResult, SiteConnectionState } from '../lib/russellApi.ts';
import type {
  CandidatePriority,
  IdeaNode,
  IssuedInvitation,
  KnowsEntry,
  Progress,
  RussellHumanRequest,
  WhoView as WhoData,
  WorkEntry,
} from '../lib/russellApi.ts';

/**
 * The priorities a person may choose, and what each one is *for*.
 *
 * The vocabulary comes from the server's own enum — the same list
 * `validateProposal` matches against and the override route re-checks — and the
 * sentence beside each is here because a ranking whose meaning a person has to
 * guess is one they will use wrongly. Deliberately not a shortened copy of the
 * server's `CANDIDATE_PRIORITY_LABELS`: that answers "what is this called", and
 * this answers "when would I pick it".
 */
const PRIORITY_CHOICES: { key: CandidatePriority; label: string; meaning: string }[] = [
  { key: 'MUST_DO', label: 'Must do', meaning: 'other work is waiting on this' },
  { key: 'BIG_MOVE', label: 'Big move', meaning: 'it changes what we can do, not just what we know' },
  { key: 'WORTH_DOING', label: 'Worth doing', meaning: 'useful, and nothing is blocking it' },
  { key: 'EXPLORE', label: 'Explore first', meaning: 'take a cheap look before committing to it' },
  { key: 'PARKED', label: 'Park it', meaning: 'not now — the reason says why' },
];

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
          <h3 className="rs-group-title">
            {GROUP_TITLES[group.group] ?? group.group}
            <span className="rs-count">{group.entries.length}</span>
          </h3>
          <ul className="rs-list">
            {group.entries.map((entry) => (
              <li key={entry.id}>
                <MissionCard entry={entry} />
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

/**
 * One piece of work, as §8 asks for it.
 *
 * Seven things: what Russell is trying to accomplish, rough progress, why it
 * matters, why it is ranked here, what changed, the next action, and whether it
 * is blocked. Every one of them is a field the server sent — there is no
 * sentence composed here, because a card that wrote its own explanation would
 * be the second implementation that disagrees with the briefing.
 *
 * The identifiers are real and are kept (§5), behind "How it is being done",
 * which is `details` so it is keyboard-reachable and screen-reader-announced
 * without any state of ours.
 */
function MissionCard({ entry }: { entry: WorkEntry }): JSX.Element {
  const when = humanWhen(entry.updatedAt);
  return (
    <article className={`rs-mission rs-mission-${priorityTone(entry.priority ?? '')}`}>
      <div className="rs-mission-head">
        <h4 className="rs-mission-objective">{entry.title}</h4>
        {entry.priorityLabel ? (
          <span className="rs-pill rs-pill-accent">{entry.priorityLabel}</span>
        ) : null}
        {entry.provenance !== 'PROJECT' ? (
          <span className="rs-pill">{PROVENANCE_WORDS[entry.provenance]}</span>
        ) : null}
      </div>

      {/* Why it matters, in the row's own words. */}
      {entry.why ? <p className="rs-mission-why">{entry.why}</p> : null}

      <p className={`rs-mission-next${entry.blocked ? ' rs-mission-blocked' : ''}`}>
        {plainWorkState(entry)}
        {when ? (
          <>
            {' · '}
            <time className="rs-when" dateTime={entry.updatedAt} title={when.exact}>
              {when.text}
            </time>
          </>
        ) : null}
      </p>

      {/* Why it is ranked here — Russell's stored reason, never re-derived. */}
      {entry.priorityReason ? (
        <p className="rs-hint rs-at-interested">{entry.priorityReason}</p>
      ) : null}

      {entry.how.length > 0 ? (
        <details className="rs-mission-how rs-at-technical">
          <summary>How it is being done</summary>
          <dl>
            {entry.how.map((pair) => (
              <Fragment key={`${pair.label}:${pair.value}`}>
                <dt>{pair.label}</dt>
                <dd>{pair.value}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      ) : null}
    </article>
  );
}

/**
 * How a decision is ranked (§16), in words.
 *
 * Three, and they mean different things to a person: something that cannot
 * wait, something that is holding real work up, and something to get to
 * whenever. A card that showed all three the same way would make the first one
 * stop registering, which is the §4.7 rule this whole surface exists to keep.
 */
const URGENCY_WORDS: Record<string, string> = {
  URGENT: 'Urgent',
  BLOCKING: 'Blocking important work',
  WHENEVER: 'Whenever convenient',
};

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
/**
 * A project, as a living model rather than a folder (§9).
 *
 * The map is the front door — approved 2026-09-12 — because it is the one view
 * nothing else in the product gives you: the shape of what the project is and
 * how its parts connect. The written summary sits under it, and the other four
 * subviews are the surfaces that already existed, reached from here rather than
 * from four different places.
 *
 * Nothing here is a second store. Each tab renders the same projection its own
 * section renders, so a person who reads "three foundations under way" on the
 * project cannot read something else on Work.
 */
const PROJECT_TABS = [
  { key: 'MAP' as const, label: 'Map' },
  { key: 'OVERVIEW' as const, label: 'Overview' },
  { key: 'MAPS' as const, label: 'Other maps' },
  { key: 'FRONTIER' as const, label: 'Frontier' },
  { key: 'WORK' as const, label: 'Work' },
  { key: 'KNOWLEDGE' as const, label: 'Knowledge' },
  { key: 'SYSTEM' as const, label: 'System' },
];

export function ProjectView({
  projectId,
  focusId,
  onFocus,
}: {
  projectId: string | null;
  focusId?: string | null;
  onFocus?: (nodeId: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<(typeof PROJECT_TABS)[number]['key']>('MAP');
  return (
    <div className="rs-view">
      <ul className="rs-tabs" role="tablist" aria-label="This project">
        {PROJECT_TABS.map((entry) => (
          <li key={entry.key} role="none">
            <button
              type="button"
              role="tab"
              aria-selected={tab === entry.key}
              onClick={() => setTab(entry.key)}
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
      {tab === 'MAP' ? (
        <IdeasView projectId={projectId} focusId={focusId} onFocus={onFocus} />
      ) : null}
      {tab === 'OVERVIEW' ? <ProjectOverview projectId={projectId} /> : null}
      {tab === 'MAPS' ? <Maps projectId={projectId} /> : null}
      {tab === 'FRONTIER' ? <Frontier projectId={projectId} /> : null}
      {tab === 'WORK' ? <WorkView projectId={projectId} /> : null}
      {tab === 'KNOWLEDGE' ? <KnowledgeView projectId={projectId} /> : null}
      {tab === 'SYSTEM' ? <SitesView projectId={projectId} /> : null}
    </div>
  );
}

/**
 * What the project currently is, in the words the rest of the product uses.
 *
 * Reads the one home projection rather than composing a second account of the
 * same rows — §6's rule, applied where it is most tempting to break: a project
 * page is exactly where somebody would write a fresh summary and end up with a
 * page that disagrees with the home screen about the same project.
 */
function ProjectOverview({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.home(projectId) : Promise.resolve(null)),
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
  const home = query.data.home;
  const progress = home.briefing.progress;
  const milestones = typeof progress === 'string' ? [] : (progress.milestones ?? []);
  return (
    <div className="rs-column">
      <p className="rs-eyebrow">What this is becoming</p>
      <h3 className="rs-view-title">{query.data.project.name}</h3>
      <p className="rs-lede">{home.briefing.focus}</p>

      <section className="rs-panel">
        <p className="rs-maturity-word">
          {typeof progress === 'string' ? progress : progress.headline}
        </p>
        <ul className="rs-foundations">
          {milestones.map((milestone) => (
            <li key={milestone.key} className={`rs-foundation rs-foundation-${TONE_WORDS[milestone.state]}`}>
              <span className="rs-foundation-name">{milestone.title}</span>
              <span className="rs-foundation-state">{STATE_WORDS_[milestone.state]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rs-group">
        <h4 className="rs-group-title">What Russell believes right now</h4>
        {home.briefing.latest ? (
          <p className="rs-mission-why">{home.briefing.latest}</p>
        ) : (
          <p className="rs-state rs-state-empty">
            Nothing has been concluded here yet. That is different from nothing being known —
            Knowledge holds what has been read.
          </p>
        )}
        <p className="rs-mission-next">{home.briefing.next}</p>
      </section>

      {Array.isArray(home.briefing.openGaps) && home.briefing.openGaps.length > 0 ? (
        <section className="rs-group">
          <h4 className="rs-group-title">What is still open</h4>
          <ul className="rs-milestones">
            {home.briefing.openGaps.map((gap) => (
              <li key={gap} className="rs-milestone-open">
                {gap}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const TONE_WORDS: Record<string, string> = {
  DONE: 'settled',
  WORKING: 'working',
  BLOCKED: 'blocked',
  OPEN: 'open',
};

const STATE_WORDS_: Record<string, string> = {
  DONE: 'Settled',
  WORKING: 'Under way',
  BLOCKED: 'Blocked',
  OPEN: 'Not started',
};

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

  const focused = map && focus ? (map.nodes.find((node) => node.id === focus) ?? null) : null;

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
      {/*
        What a person may do about the idea they are looking at.
        Below the map rather than inside it: the constellation is a projection
        and stays one, so the thing that changes rows is not tangled with the
        thing that draws them.
      */}
      {focused ? <IdeaDecision node={focused} onChanged={query.reload} /> : null}
      {/*
        No second breadcrumb and no second detail card. The constellation
        carries both, and two navigations describing the same position is the
        kind of duplication that later disagrees with itself.
      */}
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
 * The two things a person can do to one idea, and neither is decoration.
 *
 * **Disagree.** Russell ranks every idea and stores the reason; until this
 * existed, `overrideJudgment` had no caller at all and a person could read
 * Russell's opinion and do nothing about it. The override supersedes rather
 * than erases — what Russell thought stays on the row — so the previous
 * decision is shown here rather than replaced in the interface either.
 *
 * **Pull apart.** An idea can now be folded into another one automatically, by
 * a worker's judgement held to a similarity floor. A judgement that can be
 * wrong needs a visible way back, or automatic deduplication is a mechanism for
 * quietly losing somebody's question.
 *
 * `canOverride` and `canSplit` come from the server and are the same conditions
 * the routes enforce. Nothing is inferred here from the state string: a button
 * that appears and then fails is worse than one that is absent.
 *
 * A reason is required for both, and the control says so before it is used
 * rather than after — the server refuses an empty one, and a refusal a person
 * could have been warned about is a refusal that should not have happened.
 */
export function IdeaDecision({
  node,
  onChanged,
}: {
  node: IdeaNode;
  onChanged: () => void;
}): JSX.Element | null {
  const [priority, setPriority] = useState<CandidatePriority>(node.priority ?? 'WORTH_DOING');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidateId = node.links.candidateId;
  if (!candidateId || (!node.decision.canOverride && !node.decision.canSplit)) return null;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReason('');
      // Re-read rather than patch: what a person sees afterwards is what the
      // server did, so a refusal shows as a refusal instead of appearing to
      // work. The same rule the Needs You answer follows.
      onChanged();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-decision" aria-label={`What you can do about ${node.title}`}>
      {node.decision.mergedIn > 0 ? (
        <p className="rs-item-meta">
          {node.decision.mergedIn === 1
            ? 'One other question was folded into this one.'
            : `${node.decision.mergedIn} other questions were folded into this one.`}{' '}
          They are listed underneath it, and any of them can be pulled back out.
        </p>
      ) : null}

      {node.decision.overriddenReason ? (
        <p className="rs-item-meta">You already overruled Russell here: {node.decision.overriddenReason}</p>
      ) : null}

      <label className="rs-decision-label" htmlFor="rs-decision-reason">
        {node.decision.canSplit
          ? 'Why are these different questions?'
          : 'Why do you disagree with Russell?'}
      </label>
      <input
        id="rs-decision-reason"
        type="text"
        value={reason}
        maxLength={1_000}
        placeholder={
          node.decision.canSplit
            ? 'they look alike but they are asking different things'
            : 'valuation is blocked on this, so it is not merely useful'
        }
        onChange={(event) => setReason(event.target.value)}
      />

      {node.decision.canOverride ? (
        <div className="rs-choices">
          {PRIORITY_CHOICES.map((choice) => (
            <button
              key={choice.key}
              type="button"
              aria-pressed={priority === choice.key}
              title={choice.meaning}
              onClick={() => setPriority(choice.key)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="rs-choices">
        {node.decision.canOverride ? (
          <button
            type="button"
            disabled={busy || reason.trim().length === 0}
            onClick={() => {
              void run(() =>
                RussellApi.overrideJudgment(candidateId, {
                  priority,
                  // A person moving an idea up is saying to do it, so it goes
                  // into the queue Russell launches from. Parking it is the one
                  // case that does not, because a parked idea is not work.
                  state: priority === 'PARKED' ? 'PARKED' : 'QUEUED',
                  reason: reason.trim(),
                }),
              );
            }}
          >
            {busy ? 'Saving…' : 'Set this priority'}
          </button>
        ) : null}
        {node.decision.canSplit ? (
          <button
            type="button"
            disabled={busy || reason.trim().length === 0}
            onClick={() => {
              void run(() => RussellApi.splitIdea(candidateId, reason.trim()));
            }}
          >
            {busy ? 'Separating…' : 'These are different questions'}
          </button>
        ) : null}
      </div>

      {reason.trim().length === 0 ? (
        <p className="rs-item-meta">A reason is needed — it is what makes the decision reviewable later.</p>
      ) : null}
      {error ? (
        <p className="rs-state rs-state-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Inviting somebody, and the invitations already out.
 *
 * One action, prefilled, in the shape §24 gives the authority card: an address
 * and **Invite**, with the role starting on the server's own default and the
 * detailed choice behind *Change role*. Nothing asks a person to configure
 * machinery — there is no scope to pick, no user id to find, and no account to
 * create first.
 *
 * The link is shown **once**, held in this component's memory and nowhere else:
 * not in storage, not in the URL, and never fetched again. Navigating away loses
 * it, which is correct — a secret you can come back to is a secret that is
 * stored. If it is lost, inviting again issues a new one and withdraws the old.
 *
 * The list underneath shows expired and withdrawn invitations rather than hiding
 * them, each with the server's own sentence about what happened: an invitation
 * that quietly vanished when it aged out would leave a person unable to tell it
 * from one that was never sent.
 */
function InvitePanel({
  projectId,
  view,
  onChanged,
}: {
  projectId: string;
  view: WhoData;
  onChanged: () => void;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(view.defaultInviteRole ?? 'MEMBER');
  const [showRole, setShowRole] = useState(false);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invitations = view.invitations ?? [];
  const pending = invitations.filter((entry) => entry.state === 'PENDING');
  const past = invitations.filter((entry) => entry.state !== 'PENDING');

  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setIssued(await RussellApi.invite(projectId, email, role));
      setEmail('');
      setCopied(false);
      onChanged();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-invite" aria-labelledby="rs-invite-heading">
      <h3 className="rs-group-title" id="rs-invite-heading">
        Invite somebody
      </h3>

      {issued ? (
        <div className="rs-site-secret" role="group" aria-labelledby="rs-invite-link-heading">
          <h4 id="rs-invite-link-heading">Send this link to {issued.invitation.invitedEmail}</h4>
          {/* The server's own sentence about which branch accepting will take,
              rather than one composed here that could disagree with it. */}
          <p className="rs-item-meta">{issued.whatHappensNext}</p>
          <p>
            <code className="rs-secret">{issued.invitationUrl}</code>
          </p>
          <div className="rs-row">
            <button
              type="button"
              className="rs-primary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(issued.invitationUrl)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy the link'}
            </button>
            <button type="button" onClick={() => setIssued(null)}>
              I have sent it
            </button>
          </div>
          <p className="rs-item-meta">
            Shown once. Nobody can read it back afterwards, including an administrator — if it
            is lost, invite them again and a new link replaces this one. It expires{' '}
            {issued.expiresAt.slice(0, 10)}.
          </p>
        </div>
      ) : (
        <form className="rs-invite-form" onSubmit={(event) => void invite(event)}>
          <label className="rs-field-label" htmlFor="rs-invite-email">
            Their email address
          </label>
          <div className="rs-row">
            <input
              id="rs-invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="someone@example.com"
              required
            />
            <button type="submit" className="rs-primary" disabled={busy || email.length === 0}>
              {busy ? 'Inviting…' : 'Invite'}
            </button>
          </div>
          {showRole ? (
            <p className="rs-row">
              <label htmlFor="rs-invite-role">They join as</label>
              <select
                id="rs-invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {(view.invitableRoles ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </p>
          ) : (
            <p className="rs-item-meta">
              They join as {role.toLowerCase()}.{' '}
              <button type="button" className="rs-linklike" onClick={() => setShowRole(true)}>
                Change role
              </button>
            </p>
          )}
        </form>
      )}

      {error ? (
        <p className="rs-state rs-state-error" role="alert">
          {error}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <>
          <h4 className="rs-group-title">Waiting to be accepted</h4>
          <ul className="rs-list">
            {pending.map((entry) => (
              <li key={entry.id}>
                <span className="rs-item-title">{entry.email}</span>
                <span className="rs-item-meta">
                  {entry.roleLabel} · invited by {entry.invitedByName} · {entry.status}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void RussellApi.withdrawInvitation(projectId, entry.id).then(
                      onChanged,
                      (problem: unknown) =>
                        setError(
                          problem instanceof Error ? problem.message : 'That did not go through.',
                        ),
                    );
                  }}
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {past.length > 0 ? (
        <>
          <h4 className="rs-group-title">Earlier invitations</h4>
          <ul className="rs-list">
            {past.map((entry) => (
              <li key={entry.id}>
                <span className="rs-item-title">{entry.email}</span>
                <span className="rs-item-meta">
                  {entry.roleLabel} · {entry.status}
                  {entry.remedy ? ` ${entry.remedy}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
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
          {view.people.length <= 1 ? (
            <p className="rs-state rs-state-empty">Nobody else is on this project yet.</p>
          ) : null}
          {/* Only an administrator of this project is sent invitations at all —
              the server returns null otherwise, so there is nothing here to
              hide, which is the point of gating it there rather than here. */}
          {view.invitations ? (
            <InvitePanel projectId={projectId!} view={view} onChanged={query.reload} />
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
  /*
   * Understanding, organized — not a prettier document library (§10).
   *
   * The six kinds are grouped because they answer different questions and a
   * flat list makes a person read every line to find the one they wanted: what
   * is concluded, what is decided, what is assumed, what is unknown, what
   * contradicts, and what remains a gap. The order is what somebody is most
   * likely to want first.
   *
   * The grouping is over the *kind the server sent*. Nothing here reclassifies
   * anything — a knowledge row's kind is a fact about the row.
   */
  const groups = KNOWLEDGE_ORDER.map((kind) => ({
    kind,
    label: KNOWLEDGE_WORDS[kind],
    meaning: KNOWLEDGE_MEANINGS[kind],
    items: state.items.filter((entry) => entry.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <Panel title="What Russell knows" state={state} onRetry={query.reload}>
      {groups.map((group) => (
        <section key={group.kind} className="rs-group">
          <h3 className="rs-group-title">
            {group.label}
            <span className="rs-count">{group.items.length}</span>
          </h3>
          <p className="rs-hint">{group.meaning}</p>
          <ul className="rs-list">
            {group.items.map((entry) => (
              <li key={entry.id}>
                <article className="rs-card">
                  <div className="rs-row">
                    <span className="rs-item-title">{entry.statement}</span>
                    <span className={`rs-pill ${CONFIDENCE_TONE[entry.confidence] ?? ''}`.trim()}>
                      {CONFIDENCE_WORDS[entry.confidence] ?? entry.confidence}
                    </span>
                  </div>
                  {entry.detail ? <p className="rs-item-meta">{entry.detail}</p> : null}
                  <p className="rs-item-meta">
                    {STATUS_WORDS[entry.status] ?? entry.status.toLowerCase()}
                    {entry.provenance.sourceUrl ? ' · has a source' : ' · no source recorded'}
                    {entry.asOf ? ` · true as of ${entry.asOf.slice(0, 10)}` : ''}
                  </p>
                  {/*
                    A provisional entry says what it is short of. Hiding that
                    would make it read like an accepted one, which is the single
                    thing this surface must never do.
                  */}
                  {entry.missingEvidence.length > 0 ? (
                    <p className="rs-item-meta">
                      Still missing: {entry.missingEvidence.join('; ')}
                    </p>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Panel>
  );
}

/** The six kinds, in the order a person is most likely to want them. */
const KNOWLEDGE_ORDER = [
  'CONCLUSION',
  'DECISION',
  'CONTRADICTION',
  'ASSUMPTION',
  'UNKNOWN',
  'GAP',
] as const;

const KNOWLEDGE_WORDS: Record<string, string> = {
  CONCLUSION: 'Conclusions',
  DECISION: 'Decisions',
  CONTRADICTION: 'Contradictions',
  ASSUMPTION: 'Assumptions',
  UNKNOWN: 'Unknowns',
  GAP: 'Gaps',
};

const KNOWLEDGE_MEANINGS: Record<string, string> = {
  CONCLUSION: 'What the evidence supports.',
  DECISION: 'What was chosen, and by whom.',
  CONTRADICTION: 'Where the evidence disagrees with itself.',
  ASSUMPTION: 'Taken as true without being established.',
  UNKNOWN: 'Known not to be known.',
  GAP: 'Something an audit said is missing.',
};

/** Confidence follows evidence, never tone — so the words do too. */
const CONFIDENCE_WORDS: Record<string, string> = {
  ESTABLISHED: 'Established',
  SUPPORTED: 'Supported',
  UNCERTAIN: 'Uncertain',
  DISPUTED: 'Disputed',
};

const CONFIDENCE_TONE: Record<string, string> = {
  ESTABLISHED: 'rs-pill-good',
  SUPPORTED: 'rs-pill-good',
  UNCERTAIN: 'rs-pill-watch',
  DISPUTED: 'rs-pill-bad',
};

const STATUS_WORDS: Record<string, string> = {
  ACCEPTED: 'Accepted',
  PROVISIONAL: 'Provisional',
  UNDER_REVIEW: 'Under review',
  CONTRADICTED: 'Contradicted',
  STALE: 'Stale',
  SUPERSEDED: 'Superseded',
  REFUSED: 'Refused by an audit',
};

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

/**
 * What Russell may do on its own, and the decision that sets it.
 *
 * In "Needs you" because that is what this is: the one thing Russell cannot
 * decide for itself and cannot proceed without. It lived on the operator
 * console until now, which put the project owner's own decision behind an
 * administration surface — and that surface was deliberately taken off the
 * normal route in 12A. The correction is here rather than there.
 *
 * Three things it will not do:
 *
 * - **Invent a number.** The suggested limits come from the server, which is
 *   also where they are enforced, so the form cannot propose something the
 *   validator will refuse.
 * - **Describe the grant in its own words.** Every sentence under "This lets
 *   Russell" and "It will never" is composed on the server from the row. A
 *   screen that paraphrased a permission would eventually paraphrase it wrongly.
 * - **Pretend.** No optimistic update: the panel re-reads, so what a person
 *   sees afterwards is what was stored.
 */
/* --------------------------------------------------------------------------
 * Connected sites
 * ------------------------------------------------------------------------ */

/** The word a person reads for each state. One mapping, and it is not the enum. */
const SITE_STATE_LABEL: Record<SiteConnectionState, string> = {
  NOT_CONNECTED: 'Not connected',
  AWAITING_FIRST_CALL: 'Ready — waiting for the site',
  CONNECTED: 'Connected',
  NEEDS_REPAIR: 'Needs repair',
  DISCONNECTED: 'Disconnected',
};

/**
 * The one-time secret, and the one step Brain cannot take itself.
 *
 * Held in this component's memory and nowhere else: not in storage, not in the
 * URL, and never fetched again. Navigating away loses it, which is correct —
 * a secret you can come back to is a secret that is stored.
 */
function SiteSecret({
  result,
  onDone,
}: {
  result: ConnectSiteResult;
  onDone: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rs-site-secret" role="group" aria-labelledby="rs-site-secret-heading">
      <h4 id="rs-site-secret-heading">Put this into {result.status.name}, then it is done</h4>
      <p className="rs-item-meta">{result.instruction.reason}</p>
      <dl className="rs-site-vars">
        {result.instruction.variables.map((variable) => (
          <div key={variable.name}>
            <dt>{variable.name}</dt>
            <dd>
              {variable.secret ? (
                <code className="rs-secret">{result.secret}</code>
              ) : (
                <code>{variable.value ?? '—'}</code>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="rs-row">
        <button
          type="button"
          className="rs-primary"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(result.secret)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'Copied' : `Copy ${result.instruction.variables.find((v) => v.secret)?.name ?? 'the secret'}`}
        </button>
        <button type="button" onClick={onDone}>
          I have saved it
        </button>
      </div>
      <p className="rs-item-meta">
        Shown once. Nobody can read it back afterwards, including an
        administrator — if it is lost, connect again and a new one replaces it.
      </p>
    </div>
  );
}

/**
 * Every site this Brain can be a window for, and one action each.
 *
 * There is no worker to name, no scope to choose and no project to pick. Those
 * were three screens on a console, and the middle one had a wrong answer that
 * failed silently — a site granted the research scope set is refused by every
 * connector route with the same 404 a missing project gives. A decision already
 * settled is not a decision to put in front of somebody, so none of it is
 * asked.
 */
export function SitesView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.sites(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const [issued, setIssued] = useState<ConnectSiteResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (!projectId) {
    return (
      <p className="rs-state rs-state-empty">
        Open a project first — a site is connected to one project, and Brain has
        to know which.
      </p>
    );
  }
  if (query.loading) {
    return <p className="rs-state rs-state-loading">Reading what is connected…</p>;
  }
  if (query.error || !query.data) {
    return (
      <p className="rs-state rs-state-error" role="alert">
        What is connected here could not be read.{' '}
        <button type="button" onClick={query.reload}>
          Try again
        </button>
      </p>
    );
  }

  async function run(slug: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(slug);
    setError(null);
    try {
      await action();
      query.reload();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rs-sites" aria-labelledby="rs-sites-heading">
      <h2 id="rs-sites-heading">Connected sites</h2>
      <p className="rs-item-meta">
        A website is a window. Brain holds what it means; the site keeps being
        the master of its own operational fields.
      </p>

      {error ? (
        <p className="rs-state rs-state-error" role="alert">
          {error}
        </p>
      ) : null}

      {query.data.sites.map((site) => (
        <article key={site.system} className="rs-site">
          <div className="rs-row rs-site-head">
            <h3>{site.name}</h3>
            <span className={`rs-badge rs-site-${site.state.toLowerCase()}`}>
              {SITE_STATE_LABEL[site.state]}
            </span>
          </div>
          <p>{site.description}</p>
          {/* The server's own sentence about the state, never one composed here. */}
          <p className="rs-item-meta">{site.stateReason}</p>

          {site.state === 'CONNECTED' || site.state === 'DISCONNECTED' ? (
            <p className="rs-item-meta">
              {site.records} record(s) held
              {site.lastDeliveryAt ? ` · last delivery ${site.lastDeliveryAt.slice(0, 16).replace('T', ' ')}` : ''}
              {site.lastCommandAt ? ` · last asked for research ${site.lastCommandAt.slice(0, 10)}` : ''}
              {site.rejections > 0 ? ` · ${site.rejections} refused delivery kind(s)` : ''}
            </p>
          ) : null}

          {issued && issued.status.system === site.system ? (
            <SiteSecret result={issued} onDone={() => setIssued(null)} />
          ) : (
            <div className="rs-row">
              <button
                type="button"
                className="rs-primary"
                disabled={busy !== null}
                onClick={() =>
                  void run(site.slug, async () => {
                    setIssued(await RussellApi.connectSite(projectId, site.slug));
                  })
                }
              >
                {busy === site.slug
                  ? 'Working…'
                  : site.state === 'NOT_CONNECTED'
                    ? `Connect ${site.name}`
                    : site.state === 'NEEDS_REPAIR'
                      ? `Repair ${site.name}`
                      : `Issue a new secret for ${site.name}`}
              </button>

              {site.state !== 'NOT_CONNECTED' ? (
                confirming === site.slug ? (
                  <>
                    <span className="rs-item-meta">
                      Disconnecting revokes what {site.name} holds. Its records stay.
                    </span>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(site.slug, async () => {
                          await RussellApi.disconnectSite(projectId, site.slug, null);
                          setConfirming(null);
                        })
                      }
                    >
                      Yes, disconnect
                    </button>
                    <button type="button" onClick={() => setConfirming(null)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirming(site.slug)}>
                    Disconnect
                  </button>
                )
              ) : null}
            </div>
          )}

          {/* Issuing a new secret replaces the old one, and says so before it is
              pressed rather than afterwards. */}
          {site.liveCredentials > 0 && !issued ? (
            <p className="rs-item-meta">
              A secret is live. Issuing a new one revokes it immediately, so the
              site stops working until the new one reaches it.
            </p>
          ) : null}
        </article>
      ))}
    </section>
  );
}

export function AuthorityPanel({
  projectId,
  folded = false,
}: {
  projectId: string | null;
  /**
   * Whether an existing grant is folded behind a one-line summary.
   *
   * True on Needs You, where §16 is explicit: standing authority belongs
   * behind a concise "What Russell may do" summary, not a policy essay
   * occupying the inbox. The owner rejected exactly that — a long authority
   * card taking over an otherwise empty page.
   *
   * It never folds the case where there is *no* grant. That is not a reference
   * card; it is the one decision nothing can proceed without, and hiding it
   * behind a disclosure would be the status-contradicting-the-control defect
   * that §24 already had to correct once.
   */
  folded?: boolean;
}): JSX.Element | null {
  const query = useAsync(
    () => (projectId ? RussellApi.authority(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const [name, setName] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [limits, setLimits] = useState<Record<string, number> | null>(null);
  const [reason, setReason] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = query.data ?? null;
  if (!projectId) return null;

  // The limits come down with the view, so the form cannot offer a bound the
  // validator would refuse, and nothing from the server is bundled.
  const declared = view?.limits ?? [];
  /*
   * What the grant counts without capping it. Sent by the server beside
   * `limits` so the card names every line of its own spend record from the
   * server's own vocabulary rather than a second copy kept here.
   */
  const counters = view?.counters ?? [];
  const current = limits ?? ((view?.suggested ?? {}) as unknown as Record<string, number>);

  const proposedName = name ?? view?.suggestedApproval?.name ?? '';
  const proposedExpiry = expiresAt ?? view?.suggestedApproval?.expiresAt ?? '';
  const expiryValid = Number.isFinite(Date.parse(proposedExpiry));

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReason('');
      setWithdrawing(false);
      query.reload();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  if (query.loading) {
    return (
      <section className="rs-authority">
        <p className="rs-state rs-state-loading">Reading what Russell is allowed to do…</p>
      </section>
    );
  }
  if (query.error || !view) {
    return (
      <section className="rs-authority">
        <p className="rs-state rs-state-error" role="alert">
          What Russell is allowed to do here could not be read.{' '}
          <button type="button" onClick={query.reload}>
            Try again
          </button>
        </p>
      </section>
    );
  }

  /*
   * Folded means one line and everything behind it — never one line and a
   * pointer somewhere else.
   *
   * A summary that said "open the full card from the project" would move the
   * withdraw control to a page that does not have it, which is the
   * waiting-with-no-remedy defect at the smallest possible scale. `details`
   * keeps the whole card in the document, keyboard-reachable and
   * screen-reader-announced, one click from the compact state §16 asks for.
   */
  const body = (
    <>
      {/* The server's sentence, whether or not a grant exists. */}
      <p className="rs-authority-headline">{view.headline}</p>

      {view.grant ? (
        <>
          <p className="rs-item-meta">
            {view.grant.name} · set by {view.grant.grantedBy} on{' '}
            {view.grant.grantedAt.slice(0, 10)}
            {view.grant.expiresAt ? ` · runs until ${view.grant.expiresAt.slice(0, 10)}` : ''}
          </p>

          <h4>This lets Russell</h4>
          <ul className="rs-authority-list">
            {view.grant.permits.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>

          <h4>It will never</h4>
          <ul className="rs-authority-list rs-authority-never">
            {view.grant.neverPermits.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>

          <h4>Used so far</h4>
          <ul className="rs-authority-list">
            {/*
              * Counted, not rationed.
              *
              * These lines used to read "1 of 2" with a Raise control beside
              * them, and reaching the number meant Russell stopped until
              * somebody topped it up. Ordinary authorized work now runs
              * continuously on the subscription behind it, so there is no
              * denominator to show and nothing to replenish. The counting
              * stays because what this grant has done is worth seeing.
              *
              * A limit that genuinely caps something still shows one — that is
              * concurrency, which is real capacity rather than an allowance.
              */}
            {Object.entries(view.grant.spend).map(([key, spend]) => {
              const named =
                declared.find((limit) => limit.key === key) ??
                counters.find((counter) => counter.key === key);
              if (!named) return null;
              return (
                <li key={key}>
                  {named.label}:{' '}
                  {spend.limit === null
                    ? `${spend.used} so far`
                    : `${spend.used} of ${spend.limit}`}
                  {spend.active > 0 ? ` · ${spend.active} running now` : ''}
                </li>
              );
            })}
          </ul>

          {withdrawing ? (
            <>
              <label className="rs-decision-label" htmlFor="rs-authority-reason">
                Why are you withdrawing this?
              </label>
              <input
                id="rs-authority-reason"
                type="text"
                value={reason}
                maxLength={1_000}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="rs-choices">
                <button
                  type="button"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() => {
                    void run(() =>
                      RussellApi.revokeAuthority(projectId, view.grant!.id, reason.trim()),
                    );
                  }}
                >
                  {busy ? 'Withdrawing…' : 'Withdraw it'}
                </button>
                <button type="button" onClick={() => setWithdrawing(false)}>
                  Keep it
                </button>
              </div>
              <p className="rs-item-meta">
                Research already accepted stays. Withdrawing stops Russell starting anything new.
              </p>
            </>
          ) : (
            <div className="rs-choices">
              <button type="button" onClick={() => setWithdrawing(true)}>
                Withdraw this
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="rs-approval-summary">
            <h4>{proposedName || 'Research permission'}</h4>
            <p>
              Russell can keep researching this for as long as there is work worth doing,
              {current['maxConcurrent'] === 1
                ? ' one investigation at a time'
                : ` up to ${current['maxConcurrent']} investigations at once`}, on the
              subscription you already pay for. It breaks each one into as many bounded
              questions as the evidence needs.
            </p>
            <p>
              {expiryValid
                ? `Permission ends ${new Date(proposedExpiry).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}. You can withdraw it sooner.`
                : 'Choose an expiry before approving.'}
            </p>
            {/* The class of work, stated. Every ceiling above is a number
                *within* it, so a card that showed only the numbers would be
                describing how much of something it never named. */}
            <p>Research only — reading sources and writing findings into this Brain.</p>
            <p>No paid API spending, contacting people, or publishing outside this Brain.</p>
          </div>
          <button type="button" aria-expanded={editing} aria-controls="rs-authority-settings"
            onClick={() => setEditing(!editing)} disabled={busy}>
            {editing ? 'Hide details' : 'Change details'}
          </button>
          {editing ? (
            <div id="rs-authority-settings">
              <label className="rs-decision-label" htmlFor="rs-authority-name">
                What are you allowing it to look into?
              </label>
              <input id="rs-authority-name" type="text" value={proposedName}
                maxLength={200} disabled={busy}
                onChange={(event) => setName(event.target.value)} />
              {declared.map((limit) => (
                <div key={limit.key} className="rs-authority-limit">
                  <label className="rs-decision-label" htmlFor={`rs-authority-${limit.key}`}>
                    {limit.label}
                  </label>
                  <p className="rs-item-meta">{limit.meaning}</p>
                  <input id={`rs-authority-${limit.key}`} type="number" min={0} max={limit.max}
                    disabled={busy} value={current[limit.key] ?? limit.suggested}
                    onChange={(event) => setLimits({ ...current, [limit.key]: Number(event.target.value) })} />
                </div>
              ))}
              <label className="rs-decision-label" htmlFor="rs-authority-expires">Permission ends (UTC)</label>
              <input id="rs-authority-expires" type="datetime-local" disabled={busy}
                value={expiryValid ? new Date(proposedExpiry).toISOString().slice(0, 16) : ''}
                onChange={(event) => setExpiresAt(event.target.value ? `${event.target.value}:00.000Z` : '')} />
            </div>
          ) : null}
          <div className="rs-choices">
            <button type="button"
              disabled={busy || proposedName.trim().length === 0 || !expiryValid}
              onClick={() => {
                void run(() => RussellApi.grantAuthority(projectId, {
                  name: proposedName.trim(),
                  maxConcurrent: current['maxConcurrent'] ?? 0,
                  expiresAt: proposedExpiry,
                }));
              }}>
              {busy ? 'Approving…' : 'Approve'}
            </button>
          </div>
          {proposedName.trim().length === 0 ? (
            <p className="rs-item-meta">A purpose is needed before this permission can be approved.</p>
          ) : null}
        </>
      )}

      {view.history.length > 0 ? (
        <>
          <h4>Previously</h4>
          <ul className="rs-authority-list rs-authority-history">
            {view.history.map((past) => (
              <li key={past.id}>
                {past.name} — {past.endedReason ?? past.state.toLowerCase()}
                {past.endedAt ? ` (${past.endedAt.slice(0, 10)})` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {error ? (
        <p className="rs-state rs-state-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );

  if (folded && view.grant) {
    return (
      <details className="rs-panel rs-authority">
        <summary className="rs-approval-summary">
          What Russell may do on its own — {view.grant.name}
        </summary>
        {body}
      </details>
    );
  }

  return (
    <section className="rs-authority" aria-labelledby="rs-authority-heading">
      <h3 id="rs-authority-heading">What Russell may do on its own</h3>
      {body}
    </section>
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

  /*
   * Nothing needing a decision is good news, and must read as a settled state.
   *
   * The rejected screen put a long authority card on an empty inbox, which
   * made "you are not needed" look like a page full of obligations. §16 asks
   * for the opposite: a compact statement, what continues without anybody, and
   * the standing authority folded to one line.
   *
   * **The empty list is not the same fact as the empty page, and this page
   * used to treat them as one.** A project with no standing grant has exactly
   * one decision outstanding — the one nothing else can proceed without — and
   * `AuthorityPanel` correctly refuses to fold it. So the heading said
   * "Nothing needs your decision" directly above a card saying Russell may not
   * start research here, while the nav badge beside them both showed 1.
   *
   * That is §29's own correction reappearing one surface along. It was applied
   * to the briefing and to the badge, both of which now count an ungranted
   * project as one decision, and this page was left asserting the opposite
   * about the same fact. **A status that contradicts the control beside it is
   * worse than no status**, because it teaches a person to stop reading it.
   *
   * It asks the same question the badge asks, from the same route, rather than
   * inferring it from the list — two places counting the same thing is how
   * they come to disagree, which is exactly how this happened. While the
   * answer is still unknown the reassurance is simply withheld: an incomplete
   * page is a better wrong answer than a false settled one.
   */
  const authority = useAsync(
    () => (projectId ? RussellApi.authority(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const listEmpty = state.phase === 'EMPTY';
  const grantOutstanding = authority.data ? authority.data.grant === null : null;
  const nothingWaiting = listEmpty && grantOutstanding === false;

  return (
    <Panel
      title="Needs you"
      /*
       * An empty list is never the panel's own EMPTY message here, whichever
       * way the grant goes: either this page is settled and says so below, or
       * the approval is the decision and says so itself. A third sentence
       * announcing no decisions would be the same contradiction again.
       */
      state={{ ...state, phase: listEmpty ? 'READY' : state.phase }}
      onRetry={query.reload}
    >
      {nothingWaiting ? (
        <section className="rs-nothing">
          <h3>Nothing needs your decision</h3>
          <p>
            Russell carries on by itself: it keeps watching the project, ranking what is worth
            doing, and starting work it already has permission for. You will be asked here if it
            reaches something it cannot decide.
          </p>
        </section>
      ) : null}
      {/* Above the list when a decision is outstanding, folded to one line when
          the grant already exists — §16, and the rejected page's own fault. */}
      <AuthorityPanel key={projectId} projectId={projectId} folded={nothingWaiting} />
      <ul className="rs-list">
        {state.items.map((request) => (
          <li key={request.id}>
            <article className={`rs-decision rs-decision-${request.urgency.toLowerCase()}`}>
            <span className="rs-decision-label">{URGENCY_WORDS[request.urgency] ?? request.urgency}</span>
            <h4 className="rs-decision-what">{request.authorityNeeded}</h4>
            {/* Why Russell is asking rather than deciding. A request with no
                stated reason would be indistinguishable from Russell simply
                declining to do its job. */}
            <p className="rs-decision-why">{request.whyNotRussell}</p>
            {request.recommendation ? (
              <p className="rs-recommend">Russell suggests: {request.recommendation}</p>
            ) : null}
            {/* The consequence, beside the button that causes it.

                `askHuman` has refused a choice without one since it was
                written — "Every choice must carry a key, a label and its
                consequence" — and then this rendered the label alone. So the
                server enforced a promise the interface did not keep, and a
                person deciding between "record what could not be settled" and
                "authorize this plan" saw two verbs and no consequences. It is
                the one place in Russell where a wrong click spends real
                research or files a report into the archive. */}
            <ul className="rs-choices">
              {request.choices.map((choice) => (
                <li key={choice.key} className="rs-choice">
                  <span className="rs-choice-text">
                    <strong>{choice.label}</strong>
                    <span className="rs-choice-consequence">{choice.consequence}</span>
                  </span>
                  <button
                    type="button"
                    className="rs-button"
                    onClick={() => {
                      void answer(request.id, choice.key);
                    }}
                  >
                    Choose this
                  </button>
                </li>
              ))}
            </ul>
            </article>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
