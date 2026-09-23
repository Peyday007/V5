/**
 * Work done through people — the project's view and the worker's own.
 *
 * Every sentence is the server's (`services/humanwork/view.ts`): the headline
 * Russell says, the stage, who acts next, what blocks it, whether the person
 * agreed and how that is known, what it costs and what is owed, and each
 * acceptance condition with how it was judged. The client composes none of
 * them, so this page, the briefing and the operator report cannot disagree.
 *
 * A control somebody may not use is disabled with the server's reason rather
 * than removed (§35), and every one is re-decided by the route.
 */
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';
import type { AssignmentView, HumanWorkOrderView, HumanWorkProjectView } from '../../../server/services/humanwork/view.ts';

interface ProjectResponse extends HumanWorkProjectView {
  capabilities: { mayOpenAndDecide: boolean; mayCoordinate: boolean; because: string | null };
}

const WHO: Record<string, string> = {
  PROJECT_ADMINISTRATOR: 'an administrator of this project',
  COORDINATOR: 'the coordinator',
  ASSIGNEE: 'the person doing the work',
  BRAIN_ADMINISTRATOR: 'a Brain administrator',
  BRAIN: 'Brain, by itself',
  NOBODY: 'nobody',
};

async function post(path: string, body: unknown): Promise<void> {
  await api(path, { method: 'POST', body: JSON.stringify(body) });
}

export function HumanWorkSection({ projectId }: { projectId: string }): JSX.Element | null {
  const query = useAsync<ProjectResponse>(() => api<ProjectResponse>(`/api/projects/${projectId}/human-work`), [projectId]);
  if (query.loading && !query.data) return null;
  if (query.error) return <section className="rs-card rs-human-work"><p className="rs-empty">{query.error.message}</p></section>;
  const view = query.data;
  if (!view) return null;
  return (
    <section className="rs-card rs-human-work" aria-label="Work done by people">
      <h3 className="rs-group-title">Work done by people</h3>
      {view.orders.length === 0 ? (
        <p className="rs-empty">
          No work here has been given to a person. When the labor map says a task needs one, it is opened here with
          the exact work, the standard it is accepted against, and who is doing it.
        </p>
      ) : (
        view.orders.map((one) => (
          <OrderCard key={one.order.id} view={one} projectId={projectId} capabilities={view.capabilities} reload={query.reload} />
        ))
      )}
    </section>
  );
}

function OrderCard({
  view,
  projectId,
  capabilities,
  reload,
}: {
  view: HumanWorkOrderView;
  projectId: string;
  capabilities: ProjectResponse['capabilities'];
  reload(): void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/projects/${projectId}/human-work${path}`, body);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const engagement = view.engagement;
  return (
    <article className="rs-human-work-order" data-stage={view.stage}>
      <p className="rs-mission-why"><strong>{view.headline}</strong></p>
      <p className="rs-mission-next">{view.order.work}</p>
      <p className="rs-item-meta">Why a person: {view.order.whyPerson}</p>
      <p className="rs-item-meta">{view.agreement}</p>
      {view.nextAction ? (
        <p className="rs-item-meta">
          Next — {WHO[view.nextAction.who] ?? view.nextAction.who}: {view.nextAction.text}
        </p>
      ) : null}
      {view.blockers.map((blocker) => (
        <p key={blocker.statement} className="rs-item-meta rs-human-work-blocker">
          {blocker.statement} {blocker.remedy}
        </p>
      ))}
      {view.obligations ? <p className="rs-item-meta">Money: {view.obligations.sentence}</p> : null}
      {view.timing.overdue.length ? <p className="rs-item-meta">Late: {view.timing.overdue.join('; ')}.</p> : null}
      <ul className="rs-milestones">
        {view.conditions.map((condition) => (
          <li key={condition.key} className={condition.verdict === 'MET' ? 'rs-milestone-done' : 'rs-milestone-open'}>
            {condition.statement} — {condition.verdict === 'NOT_JUDGED' ? 'not judged yet' : condition.verdict}
            {condition.judgedBy === 'BRAIN' ? ' (read by Brain from rows)' : ''}: {condition.because}
            {condition.repair ? ` Repair: ${condition.repair}` : ''}
          </li>
        ))}
      </ul>
      {view.invitationDraft ? (
        <details>
          <summary>The message to send</summary>
          <pre className="rs-human-work-draft">{view.invitationDraft}</pre>
        </details>
      ) : null}
      {view.candidates.length > 0 && !engagement ? (
        <ul className="rs-milestones">
          {view.candidates.map(({ candidate, qualification }) => (
            <li key={candidate.id}>
              {qualification.summary} {qualification.reliability.sentence}
            </li>
          ))}
        </ul>
      ) : null}
      {view.stage === 'READY_TO_ACCEPT' && view.nextAction?.who === 'PROJECT_ADMINISTRATOR' ? (
        <button
          type="button"
          className="rs-button"
          disabled={busy || !capabilities.mayOpenAndDecide}
          title={capabilities.mayOpenAndDecide ? undefined : capabilities.because ?? undefined}
          onClick={() => void act(`/orders/${view.order.id}/accept`, {})}
        >
          Accept the result
        </button>
      ) : null}
      {!capabilities.mayOpenAndDecide && capabilities.because && view.stage === 'READY_TO_ACCEPT' ? (
        <p className="rs-item-meta">{capabilities.because}</p>
      ) : null}
      {error ? <p className="rs-item-meta rs-error">{error}</p> : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// The person doing the work
// ---------------------------------------------------------------------------

/**
 * Your assignments — the one channel Brain holds to a team member.
 *
 * Rendered above every early return on Home, because the person most likely to
 * hold an assignment and no readable project is exactly the one engaged for a
 * single task. Renders nothing when there are none.
 */
export function MyAssignments(): JSX.Element | null {
  const query = useAsync<{ assignments: AssignmentView[] }>(() => api('/api/assignments'), []);
  const assignments = query.data?.assignments ?? [];
  const live = assignments.filter((one) => ['INVITED', 'ENGAGED'].includes(one.state));
  if (live.length === 0) return null;
  return (
    <section className="rs-card rs-assignments" aria-label="Your assignments">
      <h3 className="rs-group-title">Your assignments</h3>
      {live.map((one) => (
        <Assignment key={one.engagementId} view={one} reload={query.reload} />
      ))}
    </section>
  );
}

function Assignment({ view, reload }: { view: AssignmentView; reload(): void }): JSX.Element {
  const [text, setText] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/assignments/${view.engagementId}${path}`, body);
      setText('');
      setReference('');
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="rs-assignment">
      <p className="rs-mission-why"><strong>{view.title}</strong></p>
      <p className="rs-mission-next">{view.work}</p>
      <p className="rs-item-meta">Why you: {view.whyYou}</p>
      <p className="rs-item-meta">Deliver: {view.deliverables.join('; ')}</p>
      <p className="rs-item-meta">
        By: {view.schedule.map((item) => `${item.milestone}${item.due ? ` (${item.due})` : ''}`).join('; ')}
      </p>
      <p className="rs-item-meta">Compensation: {view.compensation}</p>
      <p className="rs-item-meta">Access you will be given: {view.access.length ? view.access.join('; ') : 'none'}</p>
      <p className="rs-item-meta">Confidentiality: {view.confidentiality}</p>
      {view.context.length ? <ul className="rs-milestones">{view.context.map((line) => <li key={line}>{line}</li>)}</ul> : null}
      <ul className="rs-milestones">
        {view.acceptance.map((item) => (
          <li key={item.key} className={item.verdict === 'MET' ? 'rs-milestone-done' : 'rs-milestone-open'}>
            {item.statement} — {item.verdict === 'NOT_JUDGED' ? 'not yet' : item.verdict}: {item.because}
            {item.repair ? ` Repair: ${item.repair}` : ''}
          </li>
        ))}
      </ul>
      {view.state === 'INVITED' ? (
        <div className="rs-row">
          <button type="button" className="rs-button" disabled={busy} onClick={() => void act('/answer', { accept: true })}>
            Accept this assignment
          </button>
          <button type="button" className="rs-button rs-button-quiet" disabled={busy} onClick={() => void act('/answer', { accept: false })}>
            Decline
          </button>
        </div>
      ) : (
        <div className="rs-stack">
          <label>
            Tell the coordinator something
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} />
          </label>
          <div className="rs-row">
            <button type="button" className="rs-button" disabled={busy || !text.trim()} onClick={() => void act('/updates', { kind: 'MILESTONE', text })}>
              Report progress
            </button>
            <button type="button" className="rs-button rs-button-quiet" disabled={busy || !text.trim()} onClick={() => void act('/updates', { kind: 'QUESTION', text })}>
              Ask a question
            </button>
          </div>
          <label>
            Hand in: where is the result?
            <input value={reference} onChange={(event) => setReference(event.target.value)} />
          </label>
          <button
            type="button"
            className="rs-button"
            disabled={busy || !reference.trim()}
            onClick={() => void act('/deliverables', { description: text.trim() || 'Handed in', reference })}
          >
            Hand in
          </button>
        </div>
      )}
      {view.updates.length ? (
        <ul className="rs-milestones">
          {view.updates.slice(-6).map((update) => (
            <li key={`${update.at}-${update.kind}`}>{update.summary}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="rs-item-meta rs-error">{error}</p> : null}
    </article>
  );
}
