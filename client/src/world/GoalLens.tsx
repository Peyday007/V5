/**
 * Goal mode (UI-27-3, S-0421): "focus on a chosen objective, its candidate and
 * accepted plans, execution chains, uncertainty, costs, revenue, acquisition
 * methods, dependencies, alternatives, actions, and feedback from real
 * outcomes."
 *
 * The lens draws what the caller read from Brain's existing goal and plan
 * routes; it computes nothing. Candidate and accepted plans are separate
 * sections, so a candidate is never shown as the plan, and every figure is
 * split by its truth class through `truth.ts`: a measured figure and a
 * modelled one never share a column, and a modelled figure cannot carry a
 * realised label.
 */
import type { WorldFact } from '../../../server/routes/world.ts';
import type { LensAction } from './lens.ts';
import { RecordDrawer } from './RecordDrawer.tsx';
import { displayAmount, displayFact, type AmountBasis, type DisplayValue, type TruthContext } from './truth.ts';
import './numbers.css';

export type PlanStatus = 'CANDIDATE' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';

export interface GoalFigure {
  label: string;
  basis: AmountBasis;
  amountCents: number | null;
  currency: string;
  asOf: string | null;
  source: string | null;
  owner?: string | null;
}

export interface GoalPlan {
  id: string;
  title: string;
  status: PlanStatus;
  href: string | null;
  figures: readonly GoalFigure[];
  /** How the plan acquires what it needs, verbatim from the plan record. */
  acquisition?: string | null;
}

export interface GoalLensProps {
  goal: WorldFact | null;
  plans: readonly GoalPlan[];
  /** The execution chain: the records doing the goal's work, in order. */
  chain: readonly WorldFact[];
  dependencies: readonly WorldFact[];
  /** The plan's own statement of what is uncertain, or null when it says nothing. */
  uncertainty: string | null;
  ctx: TruthContext;
  selected?: WorldFact | null;
  onLensAction: (action: LensAction) => void;
}

export function splitPlans(plans: readonly GoalPlan[]): { accepted: GoalPlan[]; candidate: GoalPlan[]; other: GoalPlan[] } {
  return {
    accepted: plans.filter((p) => p.status === 'ACCEPTED'),
    candidate: plans.filter((p) => p.status === 'CANDIDATE'),
    other: plans.filter((p) => p.status !== 'ACCEPTED' && p.status !== 'CANDIDATE'),
  };
}

export function splitFigures(figures: readonly GoalFigure[], ctx: TruthContext): { measured: Array<[GoalFigure, DisplayValue]>; modelled: Array<[GoalFigure, DisplayValue]> } {
  const shown = figures.map((f) => [f, displayAmount({ basis: f.basis, amountCents: f.amountCents, currency: f.currency, asOf: f.asOf, owner: f.owner ?? null, source: f.source, ctx })] as [GoalFigure, DisplayValue]);
  // A figure with no amount has UNKNOWN confidence; it stays on the side its basis puts it.
  const isModelled = ([f, v]: [GoalFigure, DisplayValue]) => v.confidence === 'MODELLED' || (v.confidence === 'UNKNOWN' && ['PROJECTED', 'SIMULATED', 'OFFERED', 'ESTIMATED', 'MODELLED'].includes(f.basis));
  return { measured: shown.filter((x) => !isModelled(x)), modelled: shown.filter(isModelled) };
}

function FigureTable({ caption, rows, testId }: { caption: string; rows: Array<[GoalFigure, DisplayValue]>; testId: string }) {
  return (
    <table className="numbers-table" data-testid={testId}>
      <caption>{caption}</caption>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td>None recorded</td>
          </tr>
        ) : (
          rows.map(([f, v], i) => (
            <tr key={`${f.label}:${i}`}>
              <th scope="row">{f.label}</th>
              <td>{v.basisLabel}</td>
              <td className="numbers-num" title={v.source}>
                {v.text}
              </td>
              <td>{v.asOf ?? 'unknown'}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function PlanSection({ title, plans, ctx, testId }: { title: string; plans: GoalPlan[]; ctx: TruthContext; testId: string }) {
  return (
    <div className="numbers-section" data-testid={testId}>
      <h3>{title}</h3>
      {plans.length === 0 ? <p className="numbers-muted">None.</p> : null}
      {plans.map((p) => {
        const { measured, modelled } = splitFigures(p.figures, ctx);
        return (
          <article key={p.id} data-plan={p.id} data-status={p.status}>
            <h4>
              {p.href ? (
                <a className="numbers-link" href={p.href}>
                  {p.title}
                </a>
              ) : (
                p.title
              )}{' '}
              <span className="numbers-tag">{p.status.toLowerCase()}</span>
            </h4>
            <p className="numbers-muted">Acquisition: {p.acquisition ?? 'unknown'}</p>
            <div className="numbers-columns">
              <FigureTable caption="Measured" rows={measured} testId={`${p.id}-measured`} />
              <FigureTable caption="Modelled — not observed" rows={modelled} testId={`${p.id}-modelled`} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function FactList({ title, facts, ctx, onLensAction, testId }: { title: string; facts: readonly WorldFact[]; ctx: TruthContext; onLensAction: (a: LensAction) => void; testId: string }) {
  return (
    <table className="numbers-table" data-testid={testId}>
      <caption>{title}</caption>
      <tbody>
        {facts.length === 0 ? (
          <tr>
            <td>None recorded</td>
          </tr>
        ) : (
          facts.map((f) => {
            const d = displayFact(f, ctx);
            return (
              <tr key={`${f.kind}:${f.recordId}`} data-record={`${f.kind}:${f.recordId}`}>
                <td>
                  <button type="button" className="numbers-link" onClick={() => onLensAction({ type: 'SELECT', selection: { kind: f.kind, id: f.recordId } })}>
                    {f.title}
                  </button>
                </td>
                <td>{d.state.label}</td>
                <td>{f.blocker ?? ''}</td>
                <td>{f.nextAction ?? ''}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

export function GoalLens({ goal, plans, chain, dependencies, uncertainty, ctx, selected = null, onLensAction }: GoalLensProps) {
  if (!goal) {
    return (
      <section className="numbers-lens" aria-label="Goal" data-testid="goal-lens">
        <h2>Goal</h2>
        <p className="numbers-muted">Choose a goal to focus on. Nothing is selected.</p>
      </section>
    );
  }
  const { accepted, candidate, other } = splitPlans(plans);
  const blocked = [goal, ...chain, ...dependencies].filter((f) => f.blocker !== null || f.nextAction !== null);
  return (
    <section className="numbers-lens" aria-label="Goal" data-testid="goal-lens">
      <header>
        <h2>{goal.title}</h2>
        <p className="numbers-muted">
          {displayFact(goal, ctx).state.label} · data as of {ctx.world.generatedAt}
        </p>
      </header>
      <PlanSection title="Accepted plan" plans={accepted} ctx={ctx} testId="goal-accepted" />
      <PlanSection title="Candidate plans — not accepted" plans={candidate} ctx={ctx} testId="goal-candidates" />
      {other.length > 0 ? <PlanSection title="Rejected or superseded" plans={other} ctx={ctx} testId="goal-other" /> : null}
      <div className="numbers-section">
        <h3>Uncertainty</h3>
        <p data-testid="goal-uncertainty">{uncertainty ?? 'unknown — the plan states none'}</p>
      </div>
      <FactList title="Execution chain" facts={chain} ctx={ctx} onLensAction={onLensAction} testId="goal-chain" />
      <FactList title="Dependencies" facts={dependencies} ctx={ctx} onLensAction={onLensAction} testId="goal-dependencies" />
      <FactList title="Blockers and next actions" facts={blocked} ctx={ctx} onLensAction={onLensAction} testId="goal-blockers" />
      {selected ? <RecordDrawer fact={selected} ctx={ctx} onClose={() => onLensAction({ type: 'SELECT', selection: null })} /> : null}
    </section>
  );
}
