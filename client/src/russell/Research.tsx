/**
 * Research — what Brain is trying to learn, as a person follows it.
 *
 * Integration 3 gave research its own destination. Before it, a goal's budget
 * was a read-only list on Needs you, the packets under it were missions on
 * Work, and nothing showed the two together. This is one reading
 * (`services/research/overview.ts`): goal → budget → packets → evidence →
 * result, every packet in one of six plain kinds whose remedies differ —
 * running, continuing by itself, retrying, waiting on you, stopped, done.
 *
 * Every sentence is the server's. Packet ids and raw statuses are behind
 * Details, because a person follows research by its questions, not its rows.
 */
import { useAsync } from './useAsync.ts';
import { listState } from './present.ts';
import { humanWhen } from './present.ts';
import {
  ResearchGoalsApi,
  type GoalReading,
  type PacketKind,
  type PacketReading,
} from '../lib/researchGoalsApi.ts';

/** The six kinds, as a person reads them, with the tone each gets. */
export const KIND_WORDS: Record<PacketKind, { label: string; tone: string }> = {
  RUNNING: { label: 'Running', tone: 'accent' },
  WAITING: { label: 'Continuing by itself', tone: 'watch' },
  RETRYING: { label: 'Retrying automatically', tone: 'watch' },
  NEEDS_YOU: { label: 'Needs you', tone: 'bad' },
  STOPPED: { label: 'Stopped', tone: 'bad' },
  DONE: { label: 'Done', tone: 'good' },
};

export function ResearchView({
  projectId,
  onOpenNeedsYou,
}: {
  projectId: string | null;
  onOpenNeedsYou?: () => void;
}): JSX.Element {
  const query = useAsync(
    () => (projectId ? ResearchGoalsApi.overview(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const overview = query.data?.overview ?? null;
  const total = overview
    ? overview.goals.reduce((sum, goal) => sum + goal.packets.length, 0) + overview.other.length
    : null;
  const state = listState({
    loading: query.loading && overview === null,
    error: query.error,
    items: overview === null ? null : total === 0 && overview.goals.length === 0 ? [] : [overview],
    noun: 'research',
    explanation: overview?.headline ?? null,
  });

  return (
    <section className="rs-view rs-view-research" aria-labelledby="rs-research-title">
      <h2 id="rs-research-title">Research</h2>
      {overview && state.phase === 'READY' ? <p className="rs-lede">{overview.headline}</p> : null}
      {projectId && state.phase !== 'READY' ? (
        <p className={`rs-state rs-state-${state.phase.toLowerCase()}`} role={state.phase === 'ERROR' ? 'alert' : undefined}>
          {state.message}
          {state.retryable ? (
            <button type="button" className="rs-retry" onClick={query.reload}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
      {!projectId ? (
        <p className="rs-state rs-state-empty">There is no project here yet, so nothing is being researched.</p>
      ) : null}

      {overview && overview.counts.NEEDS_YOU > 0 && onOpenNeedsYou ? (
        <p className="rs-state rs-state-stale">
          {overview.counts.NEEDS_YOU === 1
            ? 'One piece of research is waiting on you.'
            : `${overview.counts.NEEDS_YOU} pieces of research are waiting on you.`}{' '}
          <button type="button" className="rs-link" onClick={onOpenNeedsYou}>
            Open Needs you
          </button>
        </p>
      ) : null}

      {overview?.goals.map((goal) => <Goal key={goal.budget.goalId} goal={goal} />)}

      {overview && overview.other.length > 0 ? (
        <section className="rs-card rs-research-other" aria-label="Research not under a goal">
          <h3>{overview.goals.length > 0 ? 'Other research' : 'What Brain is researching'}</h3>
          <p className="rs-hint">
            Questions Brain started from a conversation or an idea, rather than under a research goal.
          </p>
          <Packets packets={overview.other} />
        </section>
      ) : null}

      {overview && overview.technicalHidden > 0 ? (
        <p className="rs-hint">
          {overview.technicalHidden} technical {overview.technicalHidden === 1 ? 'run is' : 'runs are'} not
          shown — fixtures and the machinery proving itself.
        </p>
      ) : null}
    </section>
  );
}

function Goal({ goal }: { goal: GoalReading }): JSX.Element {
  const { budget } = goal;
  const packetsHeld = Math.max(budget.packets.used, budget.packets.reserved);
  return (
    <section className="rs-card rs-research-goal" aria-label={`Research goal ${budget.name}`}>
      <h3>{budget.name}</h3>
      <dl className="rs-facts">
        <dt>Budget</dt>
        <dd>
          {packetsHeld} of {budget.packets.ceiling} research runs, {budget.fragments.committed} of{' '}
          {budget.fragments.ceiling} questions
        </dd>
        <dt>Deadline</dt>
        <dd>{budget.deadline ? budget.deadline.slice(0, 10) : 'None'}</dd>
        <dt>Set by</dt>
        <dd>{budget.authorizedByName}</dd>
      </dl>
      <p className={budget.stoppedBy ? 'rs-state rs-state-stale' : 'rs-hint'}>{budget.stoppingSentence}</p>
      {goal.packets.length > 0 ? (
        <Packets packets={goal.packets} />
      ) : (
        <p className="rs-hint">No research has started under this goal yet.</p>
      )}
    </section>
  );
}

function Packets({ packets }: { packets: PacketReading[] }): JSX.Element {
  return (
    <ul className="rs-list rs-research-packets">
      {packets.map((packet) => (
        <li key={packet.id}>
          <Packet packet={packet} />
        </li>
      ))}
    </ul>
  );
}

function Packet({ packet }: { packet: PacketReading }): JSX.Element {
  const words = KIND_WORDS[packet.kind];
  const when = humanWhen(packet.updatedAt);
  const q = packet.questions;
  return (
    <article className={`rs-research-packet rs-research-${packet.kind.toLowerCase()}`}>
      <div className="rs-mission-head">
        <h4 className="rs-mission-objective">{packet.title}</h4>
        <span className={`rs-pill rs-pill-${words.tone}`}>{words.label}</span>
      </div>
      <p>
        {packet.phase}
        {when ? (
          <>
            {' · '}
            <time className="rs-when" dateTime={packet.updatedAt} title={when.exact}>
              {when.text}
            </time>
          </>
        ) : null}
      </p>
      {q.total > 0 ? (
        <p className="rs-hint">
          {q.answered} of {q.total} {q.total === 1 ? 'question' : 'questions'} answered
          {q.open ? `, ${q.open} still open` : ''}
          {q.refused ? `, ${q.refused} could not be answered` : ''}
          {packet.acceptedClaims > 0
            ? ` · ${packet.acceptedClaims} ${packet.acceptedClaims === 1 ? 'fact' : 'facts'} established from sources`
            : ''}
          {packet.filed ? ' · report filed' : ''}
        </p>
      ) : null}
      {packet.reason ? <p className="rs-hint rs-research-reason">{packet.reason}</p> : null}
      <details className="rs-details">
        <summary>Details</summary>
        <p className="rs-hint">
          Packet <code>{packet.id}</code> · status <code>{packet.status}</code> · attempt {packet.attempt}
          {packet.verdict ? (
            <>
              {' '}· review verdict <code>{packet.verdict}</code>
            </>
          ) : null}
          {packet.documentId ? (
            <>
              {' '}· report <code>{packet.documentId}</code>
            </>
          ) : null}
        </p>
      </details>
    </article>
  );
}
