/**
 * Russell's home.
 *
 * §6 fixes eight things and fixes their order, and this renders them in it:
 * what Russell is, what it is on, how far along that is, what changed, what is
 * next, whether a person is needed, what can run, and — from the shell around
 * it — a way to talk to it.
 *
 * Every sentence on this screen is composed on the server. That is not
 * ceremony: the rule §6 states is that one deterministic projection answers
 * progress, status, recent changes, next action and decisions everywhere, and a
 * client that composed its own copy of any of them would be the second
 * implementation that disagrees.
 *
 * The Pulse and the conversation list are the two things that make it a command
 * center rather than a dashboard, and both are absent when there is nothing
 * true to put in them.
 */
import { RussellApi } from '../lib/russellApi.ts';
import type { CollectionView, HomeView, RankedThread } from '../lib/russellApi.ts';
import type { Milestone } from '../../../server/services/russell/progress.ts';
import { useAsync } from './useAsync.ts';
import { foundationTone, humanWhen, listState } from './present.ts';

export function RussellHome({
  projectId,
  onOpenThread,
  onAsk,
  onStartThread,
  openThreadId,
  starting,
}: {
  projectId: string | null;
  onOpenThread(conversationId: string): void;
  onAsk(text: string): void;
  /** Begin a new thread. Without this a person can only ever see their newest. */
  onStartThread(): void;
  openThreadId: string | null;
  starting: boolean;
}): JSX.Element {
  const home = useAsync(
    () => (projectId ? RussellApi.home(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const collections = useAsync(() => RussellApi.collections(projectId), [projectId]);

  if (home.loading) {
    return <p className="rs-state rs-state-loading">Reading the project…</p>;
  }
  if (home.error) {
    // Four different screens, and this is not the empty one. The server cannot
    // distinguish absent from forbidden and neither may this.
    const state = listState({
      loading: false,
      error: home.error,
      items: null,
      noun: 'this project',
    });
    return <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>{state.message}</p>;
  }
  if (!home.data) {
    return (
      <div className="rs-column">
        <p className="rs-state rs-state-empty">
          There is no project here yet. Say what you are working on and Russell will make one.
        </p>
      </div>
    );
  }

  const view = home.data.home;
  return (
    <div className="rs-column rs-home">
      <Hero view={view} />
      <Maturity view={view} />
      <Changes view={view} />
      <WhyThisMatters projectId={projectId} />
      <Threads
        collections={collections.data?.collections ?? []}
        loading={collections.loading}
        openThreadId={openThreadId}
        onOpenThread={onOpenThread}
        onAsk={onAsk}
        onStartThread={onStartThread}
        starting={starting}
      />
    </div>
  );
}

/**
 * What Russell is, what it is on, and whether you are needed.
 *
 * The needs-you line is last of the three and is the only one that ever raises
 * its voice, which is the §4.7 rule rendered: Needs You is exceptional, so the
 * ordinary case must look ordinary or the exceptional one stops registering.
 */
function Hero({ view }: { view: HomeView }): JSX.Element {
  const needed = view.briefing.needsYou.startsWith('You are needed');
  return (
    <section className="rs-hero" aria-label="What Russell is doing">
      <p className="rs-eyebrow">
        {STATE_WORDS[view.state]} · {view.power.level === 'READY' ? 'full power' : POWER_WORDS[view.power.level]}
      </p>
      <h2 className="rs-hero-focus">{view.briefing.focus}</h2>
      <p className={`rs-hero-needs${needed ? ' is-needed' : ''}`}>{view.briefing.needsYou}</p>
      {/* The state's own reason, and what the power word means, at the depth
          somebody asked for rather than in front of everybody. */}
      <p className="rs-hint rs-at-interested">
        {view.stateReason} {view.power.explanation}
      </p>
      {view.pulse ? (
        <p className="rs-pulse">
          <span className="rs-pulse-label">Thinking about</span>
          <span>{view.pulse}</span>
        </p>
      ) : null}
    </section>
  );
}

const STATE_WORDS: Record<HomeView['state'], string> = {
  LIVE: 'Running',
  WAITING: 'Waiting',
  LIMITED: 'Limited',
  PAUSED: 'Paused',
  DEGRADED: 'Something is wrong',
};

const POWER_WORDS: Record<HomeView['power']['level'], string> = {
  READY: 'full power',
  LIMITED: 'reduced power',
  NONE: 'nowhere to run work',
  UNKNOWN: 'power unknown',
};

/**
 * The maturity word, and the strip underneath it.
 *
 * This is what replaced "0 of 8 settled" — the string the owner rejected,
 * which was accurate and read as failure on a project that was working. The
 * word comes from the server's declared stage vocabulary and the strip shows
 * each foundation's own state, so the same truth arrives as a shape.
 *
 * The bar renders only when the projection supplies a ratio over a closed
 * declared set. There is no branch here that guesses a denominator.
 */
function Maturity({ view }: { view: HomeView }): JSX.Element {
  const progress = view.briefing.progress;
  /*
   * A cached bundle against a restarted Brain.
   *
   * `progress` was a sentence before it was an object, and a component that
   * threw on the older shape would show a person nothing at all — which is
   * worse than showing them the older sentence. So the shape is checked rather
   * than assumed, and everything the older shape cannot supply is simply
   * absent.
   */
  if (typeof progress === 'string') {
    return (
      <section className="rs-panel rs-maturity" aria-label="How developed this is">
        <p className="rs-maturity-word">{progress}</p>
      </section>
    );
  }
  const ratio = progress.ratio;
  const milestones = Array.isArray(progress.milestones) ? progress.milestones : [];
  const blockedBy = Array.isArray(progress.blockedBy) ? progress.blockedBy : [];
  return (
    <section className="rs-panel rs-maturity" aria-label="How developed this is">
      <div className="rs-maturity-head">
        <p className={`rs-maturity-word rs-stage-${progress.stage.toLowerCase()}`}>
          {progress.headline}
        </p>
        {/* Accepted work, counted rather than translated into a percentage of
            anything. A project with nothing settled and real conclusions behind
            it must not read as nothing accomplished. */}
        {view.accepted.readable && view.accepted.conclusions > 0 ? (
          <span className="rs-pill rs-pill-good">
            {view.accepted.conclusions} accepted{' '}
            {view.accepted.conclusions === 1 ? 'conclusion' : 'conclusions'}
          </span>
        ) : null}
      </div>

      {ratio ? (
        <div className="rs-progress">
          <div
            className="rs-progress-bar"
            role="progressbar"
            aria-valuenow={ratio.done}
            aria-valuemin={0}
            aria-valuemax={ratio.total}
            aria-label={`${ratio.done} of ${ratio.total} ${progress.denominator} settled`}
          >
            <span style={{ width: `${(ratio.done / ratio.total) * 100}%` }} />
          </div>
        </div>
      ) : null}

      <ul className="rs-foundations">
        {milestones.map((milestone: Milestone) => (
          <li
            key={milestone.key}
            className={`rs-foundation rs-foundation-${TONE[milestone.state]}`}
          >
            <span className="rs-foundation-name">{milestone.title}</span>
            <span className="rs-foundation-state">{MILESTONE_WORDS[milestone.state]}</span>
          </li>
        ))}
      </ul>

      {blockedBy.length > 0 ? (
        <ul className="rs-milestones">
          {blockedBy.map((blocker) => (
            <li key={blocker} className="rs-progress-blocked">
              {blocker}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const TONE: Record<Milestone['state'], string> = {
  DONE: 'settled',
  WORKING: 'working',
  BLOCKED: 'blocked',
  OPEN: 'open',
};

const MILESTONE_WORDS: Record<Milestone['state'], string> = {
  DONE: 'Settled',
  WORKING: 'Under way',
  BLOCKED: 'Blocked',
  OPEN: 'Not started',
};

/** What changed, and what is next — the third and fourth of §6's sentences. */
function Changes({ view }: { view: HomeView }): JSX.Element | null {
  const { latest, next } = view.briefing;
  // `openGaps` postdates the first briefing shape, so an older server sends a
  // briefing without it. Absent is not empty and neither is a crash: the field
  // is checked rather than assumed, the same way `progress` is above.
  const openGaps = Array.isArray(view.briefing.openGaps) ? view.briefing.openGaps : [];
  if (!latest && !next && openGaps.length === 0) return null;
  return (
    <section className="rs-group" aria-label="What changed and what is next">
      <h3 className="rs-group-title">Where things stand</h3>
      {latest ? <p className="rs-mission-why">{latest}</p> : null}
      <p className="rs-mission-next">{next}</p>
      {openGaps.length > 0 ? (
        <ul className="rs-milestones rs-at-interested">
          {openGaps.map((gap) => (
            <li key={gap} className="rs-milestone-open">
              {gap}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Why this matters.
 *
 * §19's Easter egg, and the shape of it is the whole point: it is absent far
 * more often than it is present, it has no badge, streak, point or confetti in
 * it, and every line is something that genuinely happened with the row behind
 * it. The server returns null unless there is enough to be worth a person's
 * attention, so this renders nothing at all most of the time.
 */
function WhyThisMatters({ projectId }: { projectId: string | null }): JSX.Element | null {
  const query = useAsync(
    () => (projectId ? RussellApi.whyThisMatters(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const view = query.data?.whyThisMatters ?? null;
  // Silence is the common case and the correct one. A section that always had
  // something to say would be the productivity cliché §19 rules out.
  if (!view) return null;
  return (
    <section className="rs-why" aria-label="Why this matters">
      <h3>Why this matters</h3>
      {view.ambition ? <p>{view.ambition}</p> : null}
      {view.note ? <p>{view.note}</p> : null}
      {view.connection ? <p className="rs-hint">{view.connection}</p> : null}
      {view.milestones.length > 0 ? (
        <ul className="rs-why-milestones rs-at-interested">
          {view.milestones.map((milestone) => {
            const when = humanWhen(milestone.at);
            return (
              <li key={`${milestone.kind}:${milestone.sourceId}`}>
                {milestone.what}
                {when ? (
                  <>
                    {' — '}
                    <time dateTime={milestone.at} title={when.exact}>
                      {when.text}
                    </time>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The conversations, in collections, ranked by meaning.
 *
 * The ranking is the server's; this renders the order it was given and shows
 * the standing so nobody has to infer it from position. Starters come from the
 * collection's own state — when there are none the section simply has none,
 * rather than a prompt with nothing behind it.
 */
function Threads({
  collections,
  loading,
  openThreadId,
  onOpenThread,
  onAsk,
  onStartThread,
  starting,
}: {
  collections: CollectionView[];
  loading: boolean;
  openThreadId: string | null;
  onOpenThread(id: string): void;
  onAsk(text: string): void;
  onStartThread(): void;
  starting: boolean;
}): JSX.Element {
  /*
   * The control is offered in every state, including the empty and the failed
   * one. A person with no threads and no way to begin one has a shell they
   * cannot use, which is precisely the defect the thread picker was added to
   * fix and which must not come back with the picker's removal.
   */
  const start = (
    <button type="button" className="rs-button-quiet" onClick={onStartThread} disabled={starting}>
      {starting ? 'Starting…' : 'Start a new one'}
    </button>
  );
  if (loading) {
    return (
      <section aria-label="Your conversations">
        <p className="rs-state rs-state-loading">Loading your conversations…</p>
        {start}
      </section>
    );
  }
  if (collections.length === 0) {
    return (
      <section aria-label="Your conversations">
        <p className="rs-state rs-state-empty">
          You have no conversations yet. Say something below and this is where it will live.
        </p>
        {start}
      </section>
    );
  }
  return (
    <section aria-label="Your conversations">
      <div className="rs-collection-head">
        <h3 className="rs-group-title">Conversations</h3>
        {start}
      </div>
      <ul className="rs-collections">
        {collections.map((collection) => (
          <li key={collection.id ?? collection.name}>
            <div className="rs-collection-head">
              <h4 className="rs-collection-name">{collection.name}</h4>
              <span className="rs-count">
                {collection.threads.length}{' '}
                {collection.threads.length === 1 ? 'thread' : 'threads'}
              </span>
            </div>
            <ul className="rs-threads-list">
              {collection.threads.map((thread) => (
                <Thread
                  key={thread.id}
                  thread={thread}
                  open={thread.id === openThreadId}
                  onOpen={onOpenThread}
                />
              ))}
            </ul>
            {collection.starters.length > 0 ? (
              <ul className="rs-starters">
                {collection.starters.map((starter) => (
                  <li key={starter.text}>
                    <button
                      type="button"
                      className="rs-starter"
                      onClick={() => onAsk(starter.text)}
                    >
                      {starter.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Thread({
  thread,
  open,
  onOpen,
}: {
  thread: RankedThread;
  open: boolean;
  onOpen(id: string): void;
}): JSX.Element {
  const when = humanWhen(thread.updatedAt);
  const major = thread.standing === 'MAJOR_UNFINISHED' || thread.standing === 'UNFINISHED';
  return (
    <li>
      <button
        type="button"
        className={`rs-thread${major ? ' rs-thread-unfinished' : ''}`}
        aria-current={open ? 'true' : undefined}
        onClick={() => onOpen(thread.id)}
      >
        <span className="rs-thread-title">{thread.title}</span>
        {major ? (
          <span className="rs-pill rs-pill-watch">{thread.standingLabel}</span>
        ) : null}
        {when ? (
          <time className="rs-when" dateTime={thread.updatedAt} title={when.exact}>
            {when.text}
          </time>
        ) : null}
      </button>
      {/* Why it stands where it does, for a person who wants to know rather
          than in front of everybody. */}
      {thread.reason ? <p className="rs-hint rs-at-interested">{thread.reason}</p> : null}
    </li>
  );
}

export type { HomeView };
