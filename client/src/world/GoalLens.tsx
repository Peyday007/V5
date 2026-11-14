/**
 * Goal mode (UI-27-3, S-0421; UI-27-6, S-0430 – S-0431).
 *
 * "Focus on a chosen objective, its candidate and accepted plans, execution
 * chains, uncertainty, costs, revenue, acquisition methods, dependencies,
 * alternatives, actions, and feedback from real outcomes."
 *
 * The goal itself, its blockers and next action come from the world fact the
 * world route served. Its plans come from the existing goal-plan read and are
 * passed in as `GoalPlanView`s; this file holds no plan state of its own.
 *
 * Two separations are enforced here and nowhere else in the lens:
 *   * a plan is ACCEPTED only when its own status says so — any other status,
 *     or none, is a candidate (invariant 39: an unknown is never the
 *     favourable reading);
 *   * every figure goes through `displayAmount`, and is listed under
 *     "measured" or "modelled" by its basis' confidence, so a projected
 *     revenue line can never sit beside collected cash as if it were one.
 */
import type { World, WorldEntityKind, WorldFact } from '../../../server/routes/world.ts';
import { displayAmount, displayFact, displayState, type AmountBasis, type DisplayValue, type TruthContext } from './truth.ts';
import { UNKNOWN_TEXT } from './RecordDrawer.tsx';
import './numbers.css';

export const GOAL_LENS_VERSION = 1 as const;

export interface GoalPlanFigure {
  /** What the figure is about: "cost", "revenue", "buyers"… */
  label: string;
  basis: AmountBasis;
  amountCents: number | null;
  currency: string;
  asOf: string | null;
  source: string | null;
}

export interface GoalPlanStep {
  title: string;
  kind: WorldEntityKind | null;
  recordId: string | null;
  href: string | null;
}

export interface GoalPlanView {
  id: string;
  title: string;
  /** The plan's own status word, verbatim. Only "ACCEPTED" makes it accepted. */
  status: string | null;
  href: string | null;
  owner: string | null;
  /** How the plan reaches its money: the acquisition method, as the record words it. */
  method: string | null;
  uncertainty: string | null;
  figures: readonly GoalPlanFigure[];
  chain: readonly GoalPlanStep[];
  dependencies: readonly GoalPlanStep[];
}

export type PlanStanding = 'ACCEPTED' | 'CANDIDATE';

export function planStanding(plan: Pick<GoalPlanView, 'status'>): PlanStanding {
  return plan.status === 'ACCEPTED' ? 'ACCEPTED' : 'CANDIDATE';
}

export function splitPlans(plans: readonly GoalPlanView[]): { accepted: GoalPlanView[]; candidates: GoalPlanView[] } {
  return {
    accepted: plans.filter((p) => planStanding(p) === 'ACCEPTED'),
    candidates: plans.filter((p) => planStanding(p) === 'CANDIDATE'),
  };
}

export interface FigureSplit {
  measured: Array<{ figure: GoalPlanFigure; value: DisplayValue }>;
  /** Modelled bases, and any figure with no amount (confidence UNKNOWN) — never shown as measured. */
  modelled: Array<{ figure: GoalPlanFigure; value: DisplayValue }>;
}

export function splitFigures(plan: GoalPlanView, ctx: TruthContext): FigureSplit {
  const out: FigureSplit = { measured: [], modelled: [] };
  for (const figure of plan.figures) {
    const value = displayAmount({
      basis: figure.basis,
      amountCents: figure.amountCents,
      currency: figure.currency,
      asOf: figure.asOf,
      owner: plan.owner,
      source: figure.source,
      ctx,
    });
    (value.confidence === 'MEASURED' ? out.measured : out.modelled).push({ figure, value });
  }
  return out;
}

export interface GoalLensProps {
  world: World;
  goalId: string | null;
  plans?: readonly GoalPlanView[];
  nowMs?: number;
  onSelect?: (selection: { kind: WorldEntityKind; id: string }) => void;
}

function Steps({ steps, label }: { steps: readonly GoalPlanStep[]; label: string }) {
  if (steps.length === 0) return <p className="wn-note">{label}: none recorded.</p>;
  return (
    <ol className="wn-list" aria-label={label}>
      {steps.map((s, i) => (
        <li key={`${s.recordId ?? 'step'}:${i}`}>{s.href ? <a href={s.href}>{s.title}</a> : s.title}</li>
      ))}
    </ol>
  );
}

function FigureTable({ rows, caption }: { rows: FigureSplit['measured']; caption: string }) {
  if (rows.length === 0) return <p className="wn-note">{caption}: none recorded.</p>;
  return (
    <table className="wn-table" aria-label={caption}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Figure</th>
          <th scope="col">What it is</th>
          <th scope="col" className="wn-right">
            Amount
          </th>
          <th scope="col">As of</th>
          <th scope="col">Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ figure, value }, i) => (
          <tr key={`${figure.label}:${i}`} data-confidence={value.confidence}>
            <th scope="row">{figure.label}</th>
            <td>{value.basisLabel}</td>
            <td className={value.value === null ? 'wn-right wn-unknown' : 'wn-right'}>{value.text}</td>
            <td className={value.asOf ? undefined : 'wn-unknown'}>{value.asOf ?? UNKNOWN_TEXT}</td>
            <td className={figure.source ? undefined : 'wn-unknown'}>{figure.source ?? UNKNOWN_TEXT}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlanCard({ plan, ctx }: { plan: GoalPlanView; ctx: TruthContext }) {
  const standing = planStanding(plan);
  const figures = splitFigures(plan, ctx);
  return (
    <article className="wn-card" data-standing={standing} data-testid={`plan-${plan.id}`}>
      <h4>
        <span className="wn-tag">{standing === 'ACCEPTED' ? 'Accepted plan' : 'Candidate — not accepted'}</span>{' '}
        {plan.href ? <a href={plan.href}>{plan.title}</a> : plan.title}
      </h4>
      <p className="wn-meta">
        Status {plan.status ?? UNKNOWN_TEXT} · method {plan.method ?? UNKNOWN_TEXT} · uncertainty {plan.uncertainty ?? UNKNOWN_TEXT}
      </p>
      <FigureTable rows={figures.measured} caption="Measured" />
      <FigureTable rows={figures.modelled} caption="Modelled — not observed" />
      <h5>Execution chain</h5>
      <Steps steps={plan.chain} label="Execution chain" />
      <h5>Dependencies</h5>
      <Steps steps={plan.dependencies} label="Dependencies" />
    </article>
  );
}

export function GoalLens({ world, goalId, plans = [], nowMs, onSelect }: GoalLensProps) {
  const ctx: TruthContext = { world, nowMs: nowMs ?? Date.now() };
  const goals = world.facts.filter((f) => f.kind === 'GOAL');
  const goal: WorldFact | null = goalId ? (goals.find((g) => g.recordId === goalId) ?? null) : null;

  if (!goalId) {
    return (
      <section className="wn-lens" aria-label="Goal" data-testid="goal-lens">
        <h2>Goal</h2>
        <p className="wn-note">Choose a goal to focus on.</p>
        <ul className="wn-list">
          {goals.map((g) => (
            <li key={g.recordId}>
              {onSelect ? (
                <button type="button" className="wn-link" onClick={() => onSelect({ kind: 'GOAL', id: g.recordId })}>
                  {g.title}
                </button>
              ) : (
                g.title
              )}{' '}
              · {displayState(g.state).label}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const { accepted, candidates } = splitPlans(plans);
  const shown = goal ? displayFact(goal, ctx) : null;
  const related = world.explanations.filter((e) => e.recordKind === 'GOAL' && e.recordId === goalId);

  return (
    <section className="wn-lens" aria-label="Goal" data-testid="goal-lens">
      <header className="wn-lens__head">
        <h2>{goal ? goal.href ? <a href={goal.href}>{goal.title}</a> : goal.title : `Goal ${goalId}`}</h2>
        {shown ? (
          <p className="wn-meta">
            {shown.state.label} (record: {goal?.recordState ?? UNKNOWN_TEXT}) · owner {goal?.owner ?? UNKNOWN_TEXT} · last changed{' '}
            {goal?.lastChangedAt ?? UNKNOWN_TEXT}
          </p>
        ) : (
          <p className="wn-note" data-testid="goal-not-found">
            {displayState('UNKNOWN').label}: this goal is not among the facts of the current world read.
          </p>
        )}
      </header>

      <section aria-label="Blockers and next actions">
        <h3>Blockers and next actions</h3>
        <dl className="wn-drawer__rows">
          <div className={goal?.blocker ? 'wn-drawer__row' : 'wn-drawer__row wn-unknown'}>
            <dt>Blocker</dt>
            <dd>{goal ? (goal.blocker ?? 'none recorded') : UNKNOWN_TEXT}</dd>
          </div>
          <div className={goal?.nextAction ? 'wn-drawer__row' : 'wn-drawer__row wn-unknown'}>
            <dt>Next action</dt>
            <dd>{goal?.nextAction ?? UNKNOWN_TEXT}</dd>
          </div>
        </dl>
        {related.length > 0 ? (
          <ul className="wn-list">
            {related.map((e, i) => (
              <li key={i}>
                <span className="wn-tag">{e.kind}</span> {e.text}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-label="Accepted plans" data-testid="accepted-plans">
        <h3>Accepted plans</h3>
        {accepted.length === 0 ? <p className="wn-note">No plan is accepted for this goal.</p> : accepted.map((p) => <PlanCard key={p.id} plan={p} ctx={ctx} />)}
      </section>

      <section aria-label="Candidate plans" data-testid="candidate-plans">
        <h3>Candidate plans</h3>
        {candidates.length === 0 ? <p className="wn-note">No candidate plan is recorded.</p> : candidates.map((p) => <PlanCard key={p.id} plan={p} ctx={ctx} />)}
      </section>
    </section>
  );
}
