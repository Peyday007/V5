/**
 * The world scene (UI-27-1, UI-27-2, UI-27-3, UI-27-5).
 *
 * A DOM/SVG renderer of the facts `GET /api/projects/:id/world` returns — the
 * engine `renderers.ts` adopted — and nothing more. It holds no state of its
 * own beyond the camera: what is selected lives in the lens (`lens.ts`), so
 * World, Operations and Goal modes stay on the same selection, and every
 * label and number comes through `truth.ts`, so the scene cannot say what
 * the records do not.
 *
 *   * The same facts are drawn in every render mode. NUMBERS_ONLY draws no
 *     scene; ANIMATED and STATIC draw it; all three render the fact table,
 *     which is also the screen-reader path to the same facts.
 *   * A state is shown as a word and a shape, never by colour or motion
 *     alone. Only a WORKING fact (a live lease) gets an ambient cue, and only
 *     in ANIMATED mode.
 *   * The "working" count is the number of WORKING facts. Decorative
 *     characters are never counted.
 *   * Every object is a focusable button; Enter or Space selects exactly what
 *     a click selects.
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import type { WorldFact, WorldState } from '../../../server/routes/world.ts';
import type { WorldRenderMode } from './capability.ts';
import type { LensAction, LensState } from './lens.ts';
import { DRAGON_THEME, present, type PresentedFact, type ThemeDefinition } from './theme.ts';
import { displayFact, displayState, type TruthContext } from './truth.ts';
import './world.css';

export type SceneLayout = 'ISOMETRIC' | 'GRID' | 'RADIAL';

/** A shape per state, so a state never depends on colour. */
export const STATE_SHAPE: Readonly<Record<WorldState, 'diamond' | 'circle' | 'square' | 'triangle' | 'octagon' | 'cross' | 'ring' | 'question'>> = {
  WORKING: 'diamond',
  WAITING: 'ring',
  BLOCKED: 'octagon',
  NEEDS_APPROVAL: 'triangle',
  SUCCEEDED: 'circle',
  FAILED: 'cross',
  IDLE: 'square',
  UNKNOWN: 'question',
};

/** The number a surface may call "working": facts in WORKING state, nothing drawn. */
export function workingFactCount(facts: readonly Pick<WorldFact, 'state'>[]): number {
  return facts.filter((f) => f.state === 'WORKING').length;
}

export interface SceneGroup {
  key: string;
  label: string;
  x: number;
  y: number;
  items: Array<{ fact: WorldFact; presented: PresentedFact; x: number; y: number }>;
}

const UNPLACED = { key: '__unplaced', label: 'Unplaced records' };

/**
 * Group facts by the first district the theme gives them (or "unplaced"),
 * and place groups by layout. Pure, so the layout is testable without a DOM.
 */
export function layoutScene(facts: readonly WorldFact[], theme: ThemeDefinition, layout: SceneLayout): SceneGroup[] {
  const groups = new Map<string, SceneGroup>();
  for (const fact of facts) {
    const presented = present(fact, theme);
    const district = presented.objects.find((o) => o.kind === 'district');
    const key = district?.key ?? UNPLACED.key;
    const label = district?.label ?? UNPLACED.label;
    let g = groups.get(key);
    if (!g) {
      g = { key, label, x: 0, y: 0, items: [] };
      groups.set(key, g);
    }
    g.items.push({ fact, presented, x: 0, y: 0 });
  }
  const list = [...groups.values()];
  const n = list.length;
  list.forEach((g, i) => {
    if (layout === 'GRID') {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      g.x = 140 + (i % cols) * 240;
      g.y = 110 + Math.floor(i / cols) * 200;
    } else if (layout === 'RADIAL') {
      const angle = (2 * Math.PI * i) / Math.max(1, n);
      g.x = 400 + Math.cos(angle) * 250;
      g.y = 300 + Math.sin(angle) * 200;
    } else {
      // Isometric: a diamond lattice, rows offset by half a tile.
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const col = i % cols;
      const row = Math.floor(i / cols);
      g.x = 400 + (col - row) * 130;
      g.y = 90 + (col + row) * 85;
    }
    g.items.forEach((item, j) => {
      const perRow = 4;
      item.x = g.x - 60 + (j % perRow) * 40;
      item.y = g.y + 10 + Math.floor(j / perRow) * 40;
    });
  });
  return list;
}

function Shape({ shape }: { shape: (typeof STATE_SHAPE)[WorldState] }) {
  switch (shape) {
    case 'diamond':
      return <polygon points="0,-12 12,0 0,12 -12,0" />;
    case 'circle':
      return <circle r={11} />;
    case 'square':
      return <rect x={-10} y={-10} width={20} height={20} />;
    case 'triangle':
      return <polygon points="0,-12 12,10 -12,10" />;
    case 'octagon':
      return <polygon points="-5,-12 5,-12 12,-5 12,5 5,12 -5,12 -12,5 -12,-5" />;
    case 'cross':
      return <path d="M-10,-10 L10,10 M10,-10 L-10,10" strokeWidth={4} />;
    case 'ring':
      return <circle r={10} fill="none" strokeWidth={3} />;
    case 'question':
      return (
        <text textAnchor="middle" dominantBaseline="central" fontSize={20}>
          ?
        </text>
      );
  }
}

export interface WorldSceneProps {
  facts: readonly WorldFact[];
  mode: WorldRenderMode;
  lens: LensState;
  onLensAction: (action: LensAction) => void;
  ctx: TruthContext;
  theme?: ThemeDefinition;
  layout?: SceneLayout;
  /** True when the facts are sample state, not live records. Labelled visibly. */
  sample?: boolean;
  /** Distinguishes prototypes visually; carried as a data attribute and class. */
  variant?: string;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

export function WorldScene({ facts, mode, lens, onLensAction, ctx, theme = DRAGON_THEME, layout = 'ISOMETRIC', sample = false, variant = 'default' }: WorldSceneProps) {
  const [camera, setCamera] = useState({ zoom: 1, x: 0, y: 0 });
  const groups = useMemo(() => layoutScene(facts, theme, layout), [facts, theme, layout]);
  const working = workingFactCount(facts);
  const selectedFact = lens.selected ? facts.find((f) => f.kind === lens.selected!.kind && f.recordId === lens.selected!.id) ?? null : null;
  const selected = selectedFact ? displayFact(selectedFact, ctx) : null;
  const drawScene = mode !== 'NUMBERS_ONLY';
  const animate = mode === 'ANIMATED';

  const select = useCallback((fact: WorldFact) => onLensAction({ type: 'SELECT', selection: { kind: fact.kind, id: fact.recordId } }), [onLensAction]);
  const onKey = useCallback(
    (fact: WorldFact) => (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(fact);
      }
    },
    [select],
  );
  const zoomBy = (factor: number) => setCamera((c) => ({ ...c, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.zoom * factor)) }));
  const panBy = (dx: number, dy: number) => setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  const onSceneKey = (e: KeyboardEvent) => {
    const step = 40;
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(1 / 1.2);
    else if (e.key === 'ArrowLeft') panBy(step, 0);
    else if (e.key === 'ArrowRight') panBy(-step, 0);
    else if (e.key === 'ArrowUp') panBy(0, step);
    else if (e.key === 'ArrowDown') panBy(0, -step);
    else return;
    e.preventDefault();
  };

  return (
    <section className={`world-scene world-variant-${variant}`} data-variant={variant} data-mode={mode} aria-label="Brain world">
      <header className="world-header">
        {sample ? (
          <p className="world-sample" role="note" data-testid="world-sample">
            Sample state — these are not live records
          </p>
        ) : null}
        <p className="world-working" data-testid="world-working">
          {working} working (live lease) of {facts.length} records
        </p>
        <p className="world-refresh">Data as of {ctx.world.generatedAt}</p>
      </header>

      {drawScene ? (
        <div className="world-stage">
          <div className="world-camera-controls" role="toolbar" aria-label="Camera">
            <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
              +
            </button>
            <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
              −
            </button>
            <button type="button" onClick={() => panBy(40, 0)} aria-label="Pan left">
              ←
            </button>
            <button type="button" onClick={() => panBy(-40, 0)} aria-label="Pan right">
              →
            </button>
            <button type="button" onClick={() => panBy(0, 40)} aria-label="Pan up">
              ↑
            </button>
            <button type="button" onClick={() => panBy(0, -40)} aria-label="Pan down">
              ↓
            </button>
            <button type="button" onClick={() => setCamera({ zoom: 1, x: 0, y: 0 })} aria-label="Reset view">
              Reset
            </button>
          </div>
          <svg className="world-svg" viewBox="0 0 800 600" tabIndex={0} onKeyDown={onSceneKey} aria-label="World map; use arrow keys to pan and plus or minus to zoom" data-testid="world-svg">
            <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
              {groups.map((g) => (
                <g key={g.key} className="world-district" data-district={g.key}>
                  <polygon className="world-district-tile" points={`${g.x},${g.y - 50} ${g.x + 110},${g.y} ${g.x},${g.y + 50} ${g.x - 110},${g.y}`} />
                  <text className="world-district-label" x={g.x} y={g.y - 30} textAnchor="middle">
                    {g.label}
                  </text>
                  {g.items.map(({ fact, presented, x, y }) => {
                    const state = displayState(fact.state);
                    const isSelected = lens.selected?.kind === fact.kind && lens.selected.id === fact.recordId;
                    return (
                      <g
                        key={`${fact.kind}:${fact.recordId}`}
                        role="button"
                        tabIndex={0}
                        className={`world-object world-state-${fact.state.toLowerCase()}${animate && state.active ? ' world-ambient' : ''}${isSelected ? ' world-selected' : ''}`}
                        transform={`translate(${x} ${y})`}
                        aria-label={`${fact.title}: ${state.label}`}
                        aria-pressed={isSelected}
                        data-record={`${fact.kind}:${fact.recordId}`}
                        onClick={() => select(fact)}
                        onKeyDown={onKey(fact)}
                      >
                        <Shape shape={STATE_SHAPE[state.state]} />
                        <text className="world-object-glyph" y={24} textAnchor="middle">
                          {presented.glyph}
                        </text>
                      </g>
                    );
                  })}
                </g>
              ))}
            </g>
          </svg>
        </div>
      ) : (
        <p className="world-numbers-note">Numbers-first view: the map is not drawn on this device or setting. Every record is in the table below.</p>
      )}

      {selected ? (
        <aside className="world-details" aria-label="Selected record" data-testid="world-details">
          <h3>{selected.title}</h3>
          <dl>
            <dt>State</dt>
            <dd>
              {selected.state.label} (record says {selected.recordState})
            </dd>
            <dt>Owner</dt>
            <dd>{selected.owner}</dd>
            <dt>Started</dt>
            <dd>{selected.startedAt}</dd>
            <dt>Last changed</dt>
            <dd>{selected.lastChangedAt}</dd>
            <dt>Freshness</dt>
            <dd>{selected.freshness}</dd>
            <dt>Source</dt>
            <dd>{selected.source}</dd>
            <dt>Blocker</dt>
            <dd>{selected.blocker ?? 'None recorded'}</dd>
            <dt>Next action</dt>
            <dd>{selected.nextAction ?? 'None recorded'}</dd>
            {selected.missing.length > 0 ? (
              <>
                <dt>Not recorded</dt>
                <dd>{selected.missing.join(', ')}</dd>
              </>
            ) : null}
          </dl>
          {selected.note ? <p className="world-note">{selected.note}</p> : null}
          {selected.href ? <a href={selected.href}>Open the record</a> : <p>No route serves this record alone.</p>}
        </aside>
      ) : null}

      <table className="world-facts" data-testid="world-facts">
        <caption>Every record in this view</caption>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Kind</th>
            <th scope="col">State</th>
            <th scope="col">Last changed</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {facts.map((fact) => {
            const d = displayFact(fact, ctx);
            return (
              <tr key={`${fact.kind}:${fact.recordId}`} data-record={`${fact.kind}:${fact.recordId}`}>
                <td>
                  <button type="button" className="world-link" onClick={() => select(fact)}>
                    {fact.title}
                  </button>
                </td>
                <td>{fact.kind}</td>
                <td>{d.state.label}</td>
                <td>
                  {d.lastChangedAt}
                  {d.freshness !== 'CURRENT' ? ` (${d.freshness.toLowerCase()})` : ''}
                </td>
                <td>{d.source}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
