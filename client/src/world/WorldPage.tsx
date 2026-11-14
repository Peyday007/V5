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
import { PROTOTYPES, WorldPrototypes } from './prototypes/index.tsx';
import { OperationsLens } from './OperationsLens.tsx';
import { GoalLens } from './GoalLens.tsx';
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
  // Which proof of concept draws the World mode; the art direction is the owner's choice (S-0428).
  const [prototype, setPrototype] = useState<string>(PROTOTYPES[0]!.id);
  const [sampleCompare, setSampleCompare] = useState(false);

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
            {lens.mode === 'WORLD' ? (
              <>
                {/* The proofs of concept (UI-27-5) are the World mode itself: each draws this read's live facts, and the owner compares them here. */}
                <label className="numbers-muted">
                  <input type="checkbox" checked={sampleCompare} onChange={(e) => setSampleCompare(e.target.checked)} data-testid="world-sample-toggle" /> Compare
                  prototypes on sample state (clearly marked, not records)
                </label>
                {sampleCompare ? (
                  <WorldPrototypes mode={mode} chosen={prototype} onChoose={setPrototype} />
                ) : (
                  <WorldPrototypes facts={shown.facts} ctx={ctx} mode={mode} lens={lens} onLensAction={dispatch} chosen={prototype} onChoose={setPrototype} />
                )}
              </>
            ) : null}
            {lens.mode === 'OPERATIONS' ? <OperationsLens world={shown} ctx={ctx} lens={lens} onLensAction={dispatch} /> : null}
            {lens.mode === 'GOAL' ? (
              <GoalLens goal={goal} plans={[]} chain={[]} dependencies={[]} uncertainty={null} ctx={ctx} selected={selectedFact} onLensAction={dispatch} />
            ) : null}
            {lens.mode === 'GOAL' && goal?.href ? (
              <p className="numbers-muted">
                Plans, chain and uncertainty are read on the goal&rsquo;s own record: <a href={goal.href}>{goal.href}</a>
              </p>
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
