/**
 * The World destination (UI-08, UI-27-1, UI-27-3).
 *
 * One page, one read (`GET /api/projects/:id/world`), three lenses over it:
 * the spatial world, the operations tables and a goal's focus. They are
 * lenses, not products: the selection, timeframe, goal and filters live in one
 * lens state (`lens.ts`) written into the URL, so switching mode loses nothing
 * and `/world?…` is a deep link that restores exactly what was on screen.
 *
 * Beside every mode sit two things that do not change with it:
 *
 *   * **Decisions and blocks** — the world response's own explanations, each
 *     linking to the record it is about. Nothing here is composed by the page.
 *   * **The docked conversation** — the existing Russell thread, carrying the
 *     selected record (kind, id, address, state) into the turn on the existing
 *     turn route. The page has no action route of its own: anything done about
 *     a record is done by that record's authorized route, and the conversation
 *     shows the server's answer, never an assumed success.
 *
 * At phone width, with reduced motion, or without WebGL the render-mode
 * decision (`capability.ts`) falls back to the numbers-first view; every fact
 * stays reachable in every mode.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorldFact } from '../../../server/routes/world.ts';
import type { GoalView } from '../../../server/services/goals/model.ts';
import type { Construction } from '../../../server/services/industry/construction/construction.ts';
import type { Strategy } from '../../../server/services/industry/construction/strategy.ts';
import { api } from '../lib/api.ts';
import { GoalsApi } from '../lib/goalsApi.ts';
import { WorldApi } from '../lib/worldApi.ts';
import { useAsync } from '../russell/useAsync.ts';
import { Conversation } from '../russell/Conversation.tsx';
import { decideRenderMode, readCapabilitySignals, type WorldRenderMode } from './capability.ts';
import {
  LENS_MODES,
  TIMEFRAME_PRESETS,
  conversationGrounding,
  lensQuery,
  lensReducer,
  parseLensQuery,
  type LensAction,
  type LensMode,
  type LensState,
  type Timeframe,
} from './lens.ts';
import { WorldScene } from './WorldScene.tsx';
import { OperationsLens } from './OperationsLens.tsx';
import { GoalLens, type GoalFigure, type GoalPlan } from './GoalLens.tsx';
import { displayState, type TruthContext } from './truth.ts';
import './numbers.css';

export const WORLD_PATH = '/world';

const MODE_LABEL: Record<LensMode, string> = { WORLD: 'World', OPERATIONS: 'Operations', GOAL: 'Goal' };

const PRESET_MS: Record<string, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };

/**
 * Facts inside the lens timeframe. A fact with no recorded change time is
 * kept and shown as such — an unknown time is not evidence it is outside the
 * window (invariant 39).
 */
export function factsInTimeframe(facts: readonly WorldFact[], timeframe: Timeframe, nowMs: number): WorldFact[] {
  let from: number;
  let to: number;
  if ('preset' in timeframe) {
    if (timeframe.preset === 'all') return [...facts];
    from = nowMs - (PRESET_MS[timeframe.preset] ?? 0);
    to = Number.POSITIVE_INFINITY;
  } else {
    from = Date.parse(timeframe.from);
    to = Date.parse(timeframe.to);
  }
  return facts.filter((f) => {
    if (!f.lastChangedAt) return true;
    const t = Date.parse(f.lastChangedAt);
    return !Number.isFinite(t) || (t >= from && t <= to);
  });
}

/**
 * What Goal mode draws, read from the goal's own routes (S-0421): the goal
 * record (`GET /api/goals/:id`) for its work, dependencies, blockers and next
 * step, and its construction (`GET /api/goals/:id/construction`) for the
 * recommended plan, the alternatives it was compared with, their costs and
 * revenue, how each acquires its first business, and what is uncertain.
 *
 * Nothing here is derived beyond relabelling. The construction's
 * recommendation is a candidate — no route serves an acceptance of it, so the
 * accepted section stays empty rather than promoting a recommendation into a
 * plan (S-0406: never show an estimate as a contract). Every money figure is
 * an estimate or projection and is labelled so. A record the world read holds
 * is drawn from the world's own fact, so its state is the adapter's; one the
 * world read does not hold is drawn UNKNOWN with its record's status verbatim.
 */
export interface GoalRead {
  view: GoalView | null;
  viewError: string | null;
  construction: Construction | null;
  constructionError: string | null;
  /** When the construction was read: it is composed on request, so this is its as-of. */
  readAt: string;
}

export interface GoalLensInputs {
  plans: GoalPlan[];
  chain: WorldFact[];
  dependencies: WorldFact[];
  uncertainty: string | null;
}

const toCents = (dollars: number | null | undefined): number | null =>
  dollars === null || dollars === undefined || !Number.isFinite(dollars) ? null : Math.round(dollars * 100);

function strategyFigures(s: Strategy, source: string, asOf: string): GoalFigure[] {
  const entry = s.stages[0]?.economics ?? null;
  const fig = (label: string, basis: GoalFigure['basis'], dollars: number | null | undefined): GoalFigure => ({ label, basis, amountCents: toCents(dollars), currency: 'USD', asOf, source });
  return [
    fig('Entry exposure, worst case', 'ESTIMATED', s.entryExposure),
    fig('Entry upfront cost', 'ESTIMATED', entry?.mid?.upfront),
    fig('Entry monthly cost (direct + fixed)', 'ESTIMATED', entry?.mid ? entry.mid.directCost + entry.mid.indirectCost : null),
    fig('Entry monthly revenue', 'PROJECTED', entry?.mid?.revenue),
    fig('Monthly operating profit once every stage runs', 'PROJECTED', s.finalContribution),
  ];
}

function strategyAcquisition(s: Strategy): string {
  const path = s.stages.map((st) => `${st.business.label}${st.accounts > 1 ? ` ×${st.accounts}` : ''}`).join(' → ');
  const cash = s.firstCashDays === null ? 'first cash: unknown' : `first cash in about ${Math.round(s.firstCashDays)} days`;
  return `${path || 'no stages'}; ${cash}${s.feasible ? '' : `; not feasible: ${s.infeasibleBecause ?? 'no reason recorded'}`}`;
}

function unreadFact(kind: WorldFact['kind'], recordId: string, title: string, href: string | null, recordState: string | null, lastChangedAt: string | null, blocker: string | null, nextAction: string | null, table: string): WorldFact {
  const missing = ['owner', 'startedAt', ...(lastChangedAt ? [] : ['lastChangedAt'])];
  return {
    kind,
    recordId,
    href,
    title,
    owner: null,
    state: 'UNKNOWN',
    recordState,
    startedAt: null,
    lastChangedAt,
    blocker,
    nextAction,
    source: { table, id: recordId },
    freshness: lastChangedAt ? 'FRESH' : 'MISSING',
    missing,
    district: null,
  };
}

export function goalLensInputs(goalId: string, read: GoalRead, facts: readonly WorldFact[]): GoalLensInputs {
  const byKey = new Map(facts.map((f) => [`${f.kind}:${f.recordId}`, f] as const));
  const view = read.view;
  const chain: WorldFact[] = (view?.work ?? []).map(
    (w) =>
      byKey.get(`BIN:${w.binId}`) ??
      unreadFact('BIN', w.binId, `Bin ${w.binId}`, null, w.state, w.updatedAt, w.heldReason ?? w.dispatch?.refusal ?? null, w.dispatch?.message ?? null, 'bins'),
  );
  const dependencies: WorldFact[] = (view?.dependencies ?? []).map((d) => {
    const seen = byKey.get(`GOAL:${d.goalId}`);
    if (seen) return seen;
    const f = unreadFact('GOAL', d.goalId, d.title ?? `Goal ${d.goalId} (not readable by you)`, d.title ? `/api/goals/${encodeURIComponent(d.goalId)}` : null, d.lifecycle, null, d.met === false ? 'not met yet' : null, null, 'workstreams');
    return d.met === true ? { ...f, state: 'SUCCEEDED' } : d.met === false ? { ...f, state: 'WAITING' } : f;
  });

  const c = read.construction;
  const source = `/api/goals/${encodeURIComponent(goalId)}/construction`;
  const plans: GoalPlan[] = [];
  if (c?.recommended) {
    plans.push({
      id: `recommended:${c.recommended.key}`,
      title: `Recommended: ${c.decision.headline}`,
      status: 'CANDIDATE',
      href: source,
      figures: strategyFigures(c.recommended, source, read.readAt),
      acquisition: strategyAcquisition(c.recommended),
    });
  }
  for (const [i, a] of (c?.alternatives ?? []).entries()) {
    plans.push({ id: `alternative:${i}:${a.strategy}`, title: `Alternative: ${a.entry}`, status: 'CANDIDATE', href: source, figures: [], acquisition: `lost on ${a.lostOn} — ${a.detail}` });
  }

  const uncertain: string[] = [];
  if (c) {
    if (c.decision.decisiveObstacle) uncertain.push(`Decisive obstacle: ${c.decision.decisiveObstacle}`);
    for (const q of c.research.filter((r) => r.decisive)) uncertain.push(`Open question (${q.status}): ${q.question}`);
    for (const ch of c.challenges.filter((x) => x.verdict !== 'HOLDS')) uncertain.push(`Assumption ${ch.verdict.toLowerCase()}: ${ch.assumption} — ${ch.because}`);
  }
  return { plans, chain, dependencies, uncertainty: uncertain.length ? uncertain.join(' · ') : null };
}

async function readGoal(goalId: string): Promise<GoalRead> {
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const [view, construction] = await Promise.allSettled([
    GoalsApi.goal(goalId),
    api<{ construction: Construction }>(`/api/goals/${encodeURIComponent(goalId)}/construction`),
  ]);
  return {
    view: view.status === 'fulfilled' ? view.value.goal : null,
    viewError: view.status === 'rejected' ? message(view.reason) : null,
    construction: construction.status === 'fulfilled' ? construction.value.construction : null,
    constructionError: construction.status === 'rejected' ? message(construction.reason) : null,
    readAt: new Date().toISOString(),
  };
}

/** The lens state the current address describes. */
export function lensFromLocation(): LensState {
  return parseLensQuery(typeof window === 'undefined' ? '' : window.location.search);
}

export interface WorldPageProps {
  projectId: string | null;
  /** The person's open Russell thread, docked beside every mode. */
  conversationId: string | null;
  /** Overrides the device's render-mode decision (tests, a person's choice). */
  renderMode?: WorldRenderMode;
}

export function WorldPage({ projectId, conversationId, renderMode }: WorldPageProps): JSX.Element {
  const [lens, setLens] = useState<LensState>(lensFromLocation);
  const dispatch = useCallback((action: LensAction) => setLens((s) => lensReducer(s, action)), []);

  // The URL is the lens written down: every change is reflected, so a reload or a shared link restores it.
  useEffect(() => {
    if (typeof window === 'undefined' || window.location.pathname !== WORLD_PATH) return;
    const search = `?${lensQuery(lens)}`;
    if (window.location.search !== search) window.history.replaceState({}, '', `${WORLD_PATH}${search}`);
  }, [lens]);
  useEffect(() => {
    const onPop = (): void => setLens(lensFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const world = useAsync(() => (projectId ? WorldApi.world(projectId) : Promise.resolve(null)), [projectId]);
  const mode = renderMode ?? decideRenderMode(readCapabilitySignals()).mode;
  const nowMs = Date.now();
  const facts = useMemo(() => (world.data ? factsInTimeframe(world.data.facts, lens.timeframe, nowMs) : []), [world.data, lens.timeframe, nowMs]);
  const grounding = useMemo(() => conversationGrounding(lens, world.data?.facts ?? []), [lens, world.data]);
  const goals = (world.data?.facts ?? []).filter((f) => f.kind === 'GOAL');
  const goal = goals.find((g) => g.recordId === lens.goalId) ?? null;
  const goalFocus = lens.mode === 'GOAL' ? lens.goalId : null;
  const goalRead = useAsync(() => (goalFocus ? readGoal(goalFocus) : Promise.resolve(null)), [goalFocus]);
  const goalInputs = useMemo(
    () => (goalFocus && goalRead.data ? goalLensInputs(goalFocus, goalRead.data, world.data?.facts ?? []) : { plans: [], chain: [], dependencies: [], uncertainty: null }),
    [goalFocus, goalRead.data, world.data],
  );
  // The goal record's own blocker and next step, so Goal mode names them even when the world read carries none.
  const goalShown = goal && goalRead.data?.view
    ? { ...goal, blocker: goal.blocker ?? goalRead.data.view.blockers[0]?.text ?? null, nextAction: goal.nextAction ?? goalRead.data.view.next.action ?? null }
    : goal;
  const selectedFact = lens.selected ? (world.data?.facts ?? []).find((f) => f.kind === lens.selected!.kind && f.recordId === lens.selected!.id) ?? null : null;

  if (!projectId) {
    return (
      <section className="rs-view rs-view-world">
        <h2>World</h2>
        <p className="rs-state rs-state-empty">Choose a project to see its world.</p>
      </section>
    );
  }

  const ctx: TruthContext | null = world.data ? { world: { generatedAt: world.data.generatedAt, projectId: world.data.projectId }, nowMs } : null;
  const shown = world.data ? { ...world.data, facts } : null;

  return (
    <section className="rs-view rs-view-world" data-testid="world-page" data-mode={lens.mode}>
      <header className="numbers-controls">
        <h2>World</h2>
        <div role="tablist" aria-label="Lens" className="numbers-controls">
          {LENS_MODES.map((m) => (
            <button key={m} type="button" role="tab" className="numbers-button" aria-selected={lens.mode === m} onClick={() => dispatch({ type: 'SET_MODE', mode: m })}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <label>
          Timeframe{' '}
          <select
            aria-label="Timeframe"
            value={'preset' in lens.timeframe ? lens.timeframe.preset : 'custom'}
            onChange={(e) => dispatch({ type: 'SET_TIMEFRAME', timeframe: { preset: e.target.value as (typeof TIMEFRAME_PRESETS)[number] } })}
          >
            {'preset' in lens.timeframe ? null : <option value="custom">{`${lens.timeframe.from} – ${lens.timeframe.to}`}</option>}
            {TIMEFRAME_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          Goal{' '}
          <select aria-label="Goal" value={lens.goalId ?? ''} onChange={(e) => dispatch({ type: 'SET_GOAL', goalId: e.target.value || null })}>
            <option value="">None</option>
            {lens.goalId && !goal ? <option value={lens.goalId}>{`${lens.goalId} (not in this read)`}</option> : null}
            {goals.map((g) => (
              <option key={g.recordId} value={g.recordId}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
      </header>

      {world.error ? (
        <p className={`rs-state ${world.error.retryable ? 'rs-state-retrying' : 'rs-state-error'}`} role="alert">
          {world.error.retryable ? 'Brain could not read the world just now — this is temporary.' : `Brain could not read the world: ${world.error.message}`}{' '}
          <button type="button" onClick={world.reload}>
            Try again
          </button>
        </p>
      ) : null}
      {!world.data && !world.error ? <p className="rs-state rs-state-loading">Reading the world…</p> : null}

      {shown && ctx ? (
        <div className="world-page-body">
          <div className="world-page-lens" data-testid={`world-lens-${lens.mode.toLowerCase()}`}>
            {lens.mode === 'WORLD' ? <WorldScene facts={shown.facts} mode={mode} lens={lens} onLensAction={dispatch} ctx={ctx} /> : null}
            {lens.mode === 'OPERATIONS' ? <OperationsLens world={shown} ctx={ctx} lens={lens} onLensAction={dispatch} /> : null}
            {lens.mode === 'GOAL' ? (
              <GoalLens
                goal={goalShown}
                plans={goalInputs.plans}
                chain={goalInputs.chain}
                dependencies={goalInputs.dependencies}
                uncertainty={goalInputs.uncertainty}
                ctx={ctx}
                selected={selectedFact}
                onLensAction={dispatch}
              />
            ) : null}
            {lens.mode === 'GOAL' && goalFocus ? (
              <div className="numbers-muted" data-testid="goal-read-state">
                {!goalRead.data && !goalRead.error ? <p className="rs-state rs-state-loading">Reading the goal and its plan…</p> : null}
                {goalRead.error ? (
                  <p className="rs-state rs-state-error" role="alert">
                    Brain could not read this goal: {goalRead.error.message}{' '}
                    <button type="button" onClick={goalRead.reload}>
                      Try again
                    </button>
                  </p>
                ) : null}
                {goalRead.data?.viewError ? <p role="alert">The goal record could not be read: {goalRead.data.viewError}</p> : null}
                {goalRead.data?.constructionError ? <p role="alert">The goal&rsquo;s plan could not be read: {goalRead.data.constructionError}</p> : null}
                {goalRead.data ? (
                  <p>
                    Read from <a href={`/api/goals/${encodeURIComponent(goalFocus)}`}>the goal record</a> and{' '}
                    <a href={`/api/goals/${encodeURIComponent(goalFocus)}/construction`}>its construction</a> at {goalRead.data.readAt}. No route records an accepted plan, so the
                    recommendation is shown as a candidate.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <section className="numbers-section" aria-label="Decisions and blocks" data-testid="world-explanations">
            <h3>Decisions and blocks</h3>
            {shown.explanations.length === 0 ? <p className="numbers-muted">Nothing is blocked or waiting on a decision in this read.</p> : null}
            <ul>
              {shown.explanations.map((e, i) => (
                <li key={`${e.recordKind}:${e.recordId}:${i}`} data-kind={e.kind}>
                  <strong>{e.kind.toLowerCase()}</strong> — {e.text}{' '}
                  {e.href ? (
                    <a className="numbers-link" href={e.href}>
                      {e.recordKind} {e.recordId}
                    </a>
                  ) : (
                    <span>
                      {e.recordKind} {e.recordId} (no route serves it alone)
                    </span>
                  )}{' '}
                  <button type="button" className="numbers-link" onClick={() => dispatch({ type: 'SELECT', selection: { kind: e.recordKind, id: e.recordId } })}>
                    select
                  </button>{' '}
                  <span className="numbers-muted">{e.lastChangedAt ?? 'time unknown'}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}

      <aside className="world-page-conversation" aria-label="Conversation" data-testid="world-conversation">
        {selectedFact ? (
          <p className="numbers-muted">
            Selected: {selectedFact.title} — {displayState(selectedFact.state).label}
          </p>
        ) : null}
        {conversationId ? <Conversation conversationId={conversationId} grounding={grounding} showComposer /> : <p className="rs-state rs-state-loading">Opening a conversation…</p>}
      </aside>
    </section>
  );
}
