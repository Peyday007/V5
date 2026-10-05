/**
 * The project's research goals: what each may use, what it has used, and the
 * server's own sentence about whether anything stops it.
 *
 * Read-only, and it composes no sentence of its own: the stopping sentence, the
 * authorizer's name and every count arrive from the server. It renders nothing
 * when there are none — and nothing while loading or when the read failed,
 * because this section is an addition to a page whose own decisions are the
 * authority, and a placeholder would announce a section nobody asked for.
 */
import { ResearchGoalsApi } from '../lib/researchGoalsApi.ts';
import type { GoalBudgetView } from '../lib/researchGoalsApi.ts';
import { useAsync } from './useAsync.ts';

export function ResearchBudgetsList({ goals }: { goals: GoalBudgetView[] }): JSX.Element | null {
  if (goals.length === 0) return null;
  return (
    <section className="rs-research-budgets" aria-label="Research budgets">
      <h3>Research budgets</h3>
      <ul className="rs-list">
        {goals.map((goal) => (
          <li key={goal.goalId}>
            <article className="rs-card rs-research-budget">
              <h4>{goal.name}</h4>
              <dl className="rs-facts">
                <dt>Packets</dt>
                <dd>
                  {Math.max(goal.packets.used, goal.packets.reserved)} of {goal.packets.ceiling}
                </dd>
                <dt>Fragments</dt>
                <dd>
                  {goal.fragments.committed} of {goal.fragments.ceiling}
                </dd>
                <dt>Deadline</dt>
                <dd>{goal.deadline ?? 'None'}</dd>
                <dt>Authorized by</dt>
                <dd>{goal.authorizedByName}</dd>
              </dl>
              <p className="rs-research-budget-sentence">{goal.stoppingSentence}</p>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ResearchBudgets({ projectId }: { projectId: string | null }): JSX.Element | null {
  const query = useAsync(
    () => (projectId ? ResearchGoalsApi.list(projectId) : Promise.resolve({ goals: [] })),
    [projectId],
  );
  return <ResearchBudgetsList goals={query.data?.goals ?? []} />;
}
