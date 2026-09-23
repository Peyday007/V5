/**
 * Every goal, as a person coming back reads it.
 *
 * Four questions, answered in order across all goals first and then per goal:
 * *what happened, what is happening now, what happens next, what needs me?*
 * Every word here is the server's (`services/goals/`): this component chooses
 * an order and a disclosure and derives nothing, because two surfaces working
 * out their own status from one graph is how a person comes to read two
 * different answers about one goal (§29).
 *
 * A goal opens in place rather than on another page, so its evidence and
 * artifacts are one click away without losing the picture across goals.
 *
 * The pause, resume, cancel and reinstate controls render for every reader and
 * the server decides — a control somebody may not use is refused by the route
 * with the same 404 a missing goal gets, and never hidden (§35).
 */
import { useState } from 'react';
import { useAsync } from './useAsync.ts';
import { GoalsApi, type DecisionResult, type GoalBriefing, type GoalView } from '../lib/goalsApi.ts';

const BY: Record<string, string> = {
  BRAIN: 'Brain',
  PERSON: 'You',
  OPERATOR: 'An operator',
  NOBODY: 'Nobody',
};

function age(hours: number | null): string {
  if (hours === null) return '';
  if (hours >= 48) return ` · ${Math.round(hours / 24)} days`;
  return ` · ${hours} h`;
}

export function GoalsBrief({ briefing }: { briefing: GoalBriefing }): JSX.Element {
  return (
    <div className="rs-goals-brief">
      <p className="rs-card-title">{briefing.headline}</p>
      {briefing.delivered.length ? (
        <>
          <h3 className="rs-group-title">Delivered<span className="rs-count">{briefing.delivered.length}</span></h3>
          <ul className="rs-list">
            {briefing.delivered.slice(0, 5).map((item) => (
              <li key={`${item.goalId}-${item.ref}`} className="rs-item-meta">
                <strong>{item.title}</strong> — {item.evidence} <code>{item.ref}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {briefing.decisions.length ? (
        <>
          <h3 className="rs-group-title">Waiting on you<span className="rs-count">{briefing.decisions.length}</span></h3>
          <ul className="rs-list">
            {briefing.decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionCard decision={decision} goalTitle={decision.goalTitle} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {briefing.agingBlockers.length ? (
        <>
          <h3 className="rs-group-title">Stuck longest<span className="rs-count">{briefing.agingBlockers.length}</span></h3>
          <ul className="rs-list">
            {briefing.agingBlockers.slice(0, 5).map((item, index) => (
              <li key={`${item.goalId}-${index}`} className="rs-item-meta">
                <strong>{item.title}</strong>: {item.blocker}
                {age(item.ageHours)} — {BY[item.by] ?? item.by}: {item.remedy}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {briefing.commitments.length ? (
        <>
          <h3 className="rs-group-title">Commitments and deadlines</h3>
          <ul className="rs-list">
            {briefing.commitments.map((item) => (
              <li key={item.goalId} className="rs-item-meta">
                <strong>{item.title}</strong> — {item.commitment}
                {item.dueAt ? `, due ${item.dueAt.slice(0, 10)}${item.overdue ? ' (overdue)' : ''}` : ''}
                {item.obligations.length ? ` · ${item.obligations.join('; ')}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function DecisionCard({
  decision,
  goalTitle,
}: {
  decision: GoalBriefing['decisions'][number] | GoalView['decisions'][number];
  goalTitle?: string;
}): JSX.Element {
  return (
    <div className="rs-card rs-goal-decision">
      {goalTitle ? <p className="rs-quiet">{goalTitle}</p> : null}
      <p className="rs-card-title">{decision.question}</p>
      <p className="rs-card-why">{decision.proposedAction}</p>
      <ul className="rs-list">
        {decision.choices.map((choice) => (
          <li key={choice.label} className="rs-item-meta">
            <strong>{choice.label}</strong> — {choice.consequence}
          </li>
        ))}
      </ul>
      <p className="rs-quiet">Waiting on this: {decision.waitingWork.join('; ')}</p>
      <p className="rs-quiet">Afterwards: {decision.afterAnswer}</p>
    </div>
  );
}

function GoalCard({ goal, onChanged }: { goal: GoalView; onChanged: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(run: () => Promise<DecisionResult>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setResult(await run());
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  function ask(label: string): string | null {
    const reason = window.prompt(`${label} — why? (kept on the goal's history)`);
    return reason && reason.trim() ? reason.trim() : null;
  }

  return (
    <div className="rs-card rs-goal" data-lifecycle={goal.lifecycle}>
      <button type="button" className="rs-goal-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rs-card-title">{goal.title}</span>
        <span className="rs-quiet">
          {goal.lifecycle.toLowerCase()} · {goal.projectName ?? 'Brain-wide'}
          {goal.owner ? ` · ${goal.owner.name}` : ''}
          {goal.dueAt ? ` · due ${goal.dueAt.slice(0, 10)}${goal.overdue ? ' (overdue)' : ''}` : ''}
        </span>
      </button>
      <p className="rs-item-meta">
        <strong>Now:</strong> {goal.waiting.detail}
      </p>
      <p className="rs-item-meta">
        <strong>Next ({BY[goal.next.by] ?? goal.next.by}):</strong> {goal.next.action}
      </p>
      {open ? (
        <div className="rs-goal-detail">
          <p className="rs-quiet">For: {goal.intent}</p>
          <p className="rs-quiet">Finished when: {goal.outcome ?? 'nobody has said what counts as finished'}</p>
          <p className="rs-quiet">
            {goal.purposeLabel} · {goal.commitmentLabel}
          </p>
          <p className="rs-quiet">Authority: {goal.authority.research}</p>
          {goal.authority.commercial ? <p className="rs-quiet">{goal.authority.commercial}</p> : null}
          {goal.next.afterwards ? <p className="rs-quiet">Afterwards: {goal.next.afterwards}</p> : null}
          {goal.priority ? (
            <p className="rs-quiet">
              Position {goal.priority.rank + 1} among its owner’s goals here
              {goal.priority.binPriority !== null ? ` (work runs at priority ${goal.priority.binPriority})` : ''}
              {goal.priority.belowPrevious ? ` — below the one above because that one: ${goal.priority.belowPrevious.reason}` : ''}
              {goal.priority.aboveNext ? ` — above the next because ${goal.priority.aboveNext.reason}` : ''}.
            </p>
          ) : null}
          {goal.decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
          {goal.blockers.length ? (
            <ul className="rs-list">
              {goal.blockers.map((blocker, index) => (
                <li key={index} className="rs-item-meta">
                  Blocked: {blocker.text}
                  {age(blocker.ageHours)} — {BY[blocker.by] ?? blocker.by}: {blocker.remedy}
                </li>
              ))}
            </ul>
          ) : null}
          {goal.dependencies.length ? (
            <ul className="rs-list">
              {goal.dependencies.map((dependency) => (
                <li key={dependency.goalId} className="rs-item-meta">
                  Waits on {dependency.title ?? 'a goal outside your projects'} —{' '}
                  {dependency.met === null ? 'not readable here' : dependency.met ? 'met' : 'not yet'}
                </li>
              ))}
            </ul>
          ) : null}
          <h4 className="rs-group-title">Linked work</h4>
          <ul className="rs-list">
            {goal.linked.map((reading) => (
              <li key={reading.linkId} className="rs-item-meta">
                {reading.kind.toLowerCase().replace(/_/g, ' ')} <code>{reading.ref}</code>: {reading.status}{' '}
                <span className="rs-quiet">({reading.evidence})</span>
              </li>
            ))}
            {goal.work.map((work) => (
              <li key={work.binId} className="rs-item-meta">
                bin <code>{work.binId}</code>: {work.state.toLowerCase()}, priority {work.priority}, attempts {work.attempts}
                {work.heldReason ? `, held (${work.heldReason.toLowerCase().replace(/_/g, ' ')})` : ''}
                {work.workerOnIt ? ', a worker is on it' : ''}
                {work.dispatch?.refusal ? `, dispatcher: ${work.dispatch.refusal.toLowerCase().replace(/_/g, ' ')}` : ''}
              </li>
            ))}
          </ul>
          {goal.evidence.length ? (
            <>
              <h4 className="rs-group-title">Evidence</h4>
              <ul className="rs-list">
                {goal.evidence.map((item, index) => (
                  <li key={index} className="rs-item-meta">
                    {item.what} <code>{item.ref}</code> <span className="rs-quiet">({item.evidence})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {goal.obligations.length ? (
            <p className="rs-item-meta">Still owed: {goal.obligations.join('; ')}</p>
          ) : null}
          <div className="rs-goal-actions">
            {goal.lifecycle === 'ACTIVE' ? (
              <button type="button" className="rs-action" disabled={busy} onClick={() => {
                const reason = ask('Pause');
                if (reason) void act(() => GoalsApi.pause(goal.id, reason));
              }}>
                Pause
              </button>
            ) : null}
            {goal.lifecycle === 'PAUSED' ? (
              <button type="button" className="rs-action" disabled={busy} onClick={() => void act(() => GoalsApi.resume(goal.id))}>
                Resume
              </button>
            ) : null}
            {goal.lifecycle === 'ACTIVE' || goal.lifecycle === 'PAUSED' ? (
              <button type="button" className="rs-action" disabled={busy} onClick={() => {
                const reason = ask('Cancel');
                if (reason) void act(() => GoalsApi.cancel(goal.id, reason));
              }}>
                Cancel
              </button>
            ) : null}
            {goal.lifecycle === 'CANCELLED' ? (
              <button type="button" className="rs-action" disabled={busy} onClick={() => void act(() => GoalsApi.reinstate(goal.id))}>
                Reinstate
              </button>
            ) : null}
          </div>
          {result ? (
            <p className="rs-item-meta" role="status">
              {result.ok ? result.consequence : `Nothing changed: ${result.reason}`}
            </p>
          ) : null}
          {error ? <p className="rs-state rs-state-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Goals(): JSX.Element {
  const query = useAsync(() => GoalsApi.briefing(), []);
  const data = query.data;
  return (
    <section className="rs-panel rs-goals" aria-labelledby="rs-goals-title">
      <h2 id="rs-goals-title">Goals</h2>
      {query.loading && !data ? <p className="rs-state rs-state-loading">Loading goals…</p> : null}
      {query.error ? (
        <p className="rs-state rs-state-error" role="alert">
          Could not load the goals. {query.error.message}
          <button type="button" className="rs-retry" onClick={query.reload}>Try again</button>
        </p>
      ) : null}
      {data ? (
        <>
          <GoalsBrief briefing={data.briefing} />
          <ul className="rs-list">
            {data.goals.map((goal) => (
              <li key={goal.id}>
                <GoalCard goal={goal} onChanged={query.reload} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * The line Home carries: the headline across goals, and the next milestone of
 * each active goal. Everything else is one click away on Work, where the goals
 * open in place — Home must not grow into the dashboard §24 rejected.
 */
export function GoalsHome(): JSX.Element | null {
  const query = useAsync(() => GoalsApi.briefing(), []);
  const briefing = query.data?.briefing;
  if (!briefing) return null;
  return (
    <section className="rs-panel rs-goals-home" aria-label="Your goals">
      <h2>Goals</h2>
      <p className="rs-card-title">{briefing.headline}</p>
      <ul className="rs-list">
        {briefing.milestones.slice(0, 5).map((item) => (
          <li key={item.goalId} className="rs-item-meta">
            <strong>{item.title}</strong>: {item.next}
            {item.dueAt ? ` (due ${item.dueAt.slice(0, 10)}${item.overdue ? ', overdue' : ''})` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
