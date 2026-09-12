/**
 * The six specialized maps.
 *
 * Each is a view over the authoritative graph, and two things about the
 * rendering are load-bearing rather than cosmetic.
 *
 * **The outline is an equal, not a consolation.** §20 asks for an accessible
 * synchronized alternative, and it comes from the server in the same pass as
 * the nodes — so the list and the diagram cannot describe different graphs.
 * Both are always in the document; the toggle changes which one is shown, and
 * a person using a keyboard or a screen reader reaches the same facts.
 *
 * **An empty map says why.** A blank canvas with no sentence is the same
 * failure as an empty list that does not say whether it is loading, forbidden
 * or genuinely empty. The money-flow map in particular is usually empty here,
 * because Brain deliberately holds no money for this project — and saying so is
 * the honest output rather than a diagram of plausible arrows.
 */
import { useState } from 'react';
import { RussellApi } from '../lib/russellApi.ts';
import type { MapType, MapView } from '../lib/russellApi.ts';
import { useAsync } from './useAsync.ts';
import { readingState } from './present.ts';

const TYPES: { key: MapType; label: string }[] = [
  { key: 'SYSTEM', label: 'System' },
  { key: 'WORKFLOW', label: 'Workflow' },
  { key: 'KNOWLEDGE', label: 'Knowledge' },
  { key: 'DECISIONS', label: 'Decisions' },
  { key: 'TIMELINE', label: 'Timeline' },
  { key: 'MONEY_FLOW', label: 'Money flow' },
];

/** The tone a node carries, by what kind of thing it is. */
const KIND_TONE: Record<string, string> = {
  PROJECT: 'rs-pill-accent',
  FOUNDATION: 'rs-pill-good',
  CONNECTED_SITE: 'rs-pill-accent',
  CONCLUSION: 'rs-pill-good',
  DECISION: 'rs-pill-accent',
  ASSUMPTION: 'rs-pill-watch',
  UNKNOWN: 'rs-pill-watch',
  CONTRADICTION: 'rs-pill-bad',
  GAP: 'rs-pill-watch',
};

export function Maps({ projectId }: { projectId: string | null }): JSX.Element {
  const [type, setType] = useState<MapType>('SYSTEM');
  const [asList, setAsList] = useState(false);
  const query = useAsync(
    () => (projectId ? RussellApi.map(projectId, type) : Promise.resolve(null)),
    [projectId, type],
  );
  const state = readingState({
    loading: query.loading,
    error: query.error,
    value: query.data ?? null,
    noun: 'this map',
  });

  return (
    <div className="rs-column rs-column-wide">
      <p className="rs-eyebrow">Maps</p>
      <h2 className="rs-view-title">How the parts connect</h2>

      <ul className="rs-tabs" role="tablist" aria-label="Kind of map">
        {TYPES.map((entry) => (
          <li key={entry.key} role="none">
            <button
              type="button"
              role="tab"
              aria-selected={type === entry.key}
              onClick={() => setType(entry.key)}
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>

      {state.phase !== 'READY' || !query.data ? (
        <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>{state.message}</p>
      ) : (
        <Rendered map={query.data.map} asList={asList} onToggle={() => setAsList((now) => !now)} />
      )}
    </div>
  );
}

function Rendered({
  map,
  asList,
  onToggle,
}: {
  map: MapView;
  asList: boolean;
  onToggle(): void;
}): JSX.Element {
  return (
    <>
      <p className="rs-lede">{map.question}</p>

      <div className="rs-row">
        <button type="button" className="rs-button-quiet" onClick={onToggle}>
          {asList ? 'Show the diagram' : 'Show it as a list'}
        </button>
        <span className="rs-hint">
          {map.nodes.length} {map.nodes.length === 1 ? 'thing' : 'things'}, {map.edges.length}{' '}
          {map.edges.length === 1 ? 'connection' : 'connections'}
        </span>
      </div>

      {map.emptyReason ? (
        <p className="rs-state rs-state-empty">{map.emptyReason}</p>
      ) : null}

      {/*
        Both are always in the document.

        The outline is the keyboard and screen-reader path, and hiding it from
        the accessibility tree while showing the diagram would make it a
        consolation rather than an equal. `hidden` on the one not chosen keeps
        exactly one of them presented at a time without either being absent.
      */}
      <div hidden={asList}>
        <Diagram map={map} />
      </div>
      <div hidden={!asList}>
        <Outline map={map} />
      </div>
    </>
  );
}

/**
 * The diagram.
 *
 * Laid out by depth from the outline the server already computed, so the
 * picture and the list are the same graph arranged differently rather than two
 * derivations that can disagree. Deliberately simple: this is a view over
 * business truth, and dragging a node changes a layout and never a fact.
 */
function Diagram({ map }: { map: MapView }): JSX.Element | null {
  if (map.nodes.length === 0) return null;
  const byDepth = new Map<number, { id: string; label: string }[]>();
  for (const row of map.outline) {
    const list = byDepth.get(row.depth) ?? [];
    list.push({ id: row.id, label: row.label });
    byDepth.set(row.depth, list);
  }
  const depths = [...byDepth.keys()].sort((left, right) => left - right);
  const byId = new Map(map.nodes.map((node) => [node.id, node]));

  return (
    <div className="rs-map">
      {depths.map((depth) => (
        <div key={depth} className="rs-map-row">
          {(byDepth.get(depth) ?? []).map((entry) => {
            const node = byId.get(entry.id);
            return (
              <span
                key={entry.id}
                className={`rs-map-node ${KIND_TONE[node?.kind ?? ''] ?? ''}`.trim()}
                title={node?.detail ?? undefined}
              >
                {entry.label}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The same graph in reading order, indented by depth. */
function Outline({ map }: { map: MapView }): JSX.Element | null {
  if (map.outline.length === 0) return null;
  return (
    <ul className="rs-list" aria-label="The same map as a list">
      {map.outline.map((row) => (
        <li key={row.id} style={{ paddingLeft: `${Math.min(row.depth, 6) * 16}px` }}>
          <span className="rs-item-title">{row.label}</span>
          {row.detail ? <span className="rs-item-meta">{row.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}
