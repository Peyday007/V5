/**
 * The living constellation.
 *
 * A site sits at the centre; its major ideas orbit it; selecting one moves it
 * into the centre and its ordinary ideas unfold around it. A breadcrumb keeps
 * orientation and a detail card says what the selected thing is, what state it
 * is in and what it connects to.
 *
 * Three things about this are deliberate and worth reading before changing it.
 *
 * **Every node comes from the API.** There is no demo data in this file and
 * there must never be. The approved interaction was prototyped against a
 * hardcoded Deal Dispatch tree; the prototype is a reference for *behaviour*,
 * and copying its nodes would have put invented structure on a screen a person
 * reads as truth.
 *
 * **The layout generalises rather than reproducing five hand-placed points.**
 * The prototype's ring was five coordinates chosen by eye, which is exactly
 * right for a prototype and wrong for a projection: a project with three major
 * ideas or eleven would clump or overflow. So the ring is an ellipse with the
 * prototype's proportions and the nodes are spaced evenly around it, which
 * reads as the same constellation for the common case and stays legible
 * outside it.
 *
 * **The map is not the only way to read the shape.** The same projection is
 * rendered as a list underneath, and the list is what a screen reader gets —
 * not a summary of the map, the same facts. A diagram that is the sole carrier
 * of the structure is a diagram that excludes people.
 */
import { useEffect, useRef, useState } from 'react';
import type { IdeaEdge, IdeaMap, IdeaNode } from '../lib/russellApi.ts';

/** Below this the canvas is taller and the ring is narrower. */
const PHONE_MAX = 520;

/** Where the nucleus sits, as a percentage of the canvas. */
function centreOf(width: number): [number, number] {
  return width <= PHONE_MAX ? [50, 43] : [50, 46];
}

/** The ring's radii, as percentages. The prototype's proportions, generalised. */
function radiiOf(width: number): [number, number] {
  return width <= PHONE_MAX ? [30, 38] : [31, 34];
}

/**
 * Where each orbiting node goes.
 *
 * Evenly spaced from the top, clockwise, so the ordering a person sees matches
 * the ordering the projection returned rather than being arbitrary.
 */
export function ringPositions(count: number, width: number): [number, number][] {
  if (count === 0) return [];
  const [cx, cy] = centreOf(width);
  const [rx, ry] = radiiOf(width);
  /*
   * Above six, neighbours are staggered onto two radii.
   *
   * Found by looking rather than by reasoning: eight nodes on one ellipse at a
   * 390-wide viewport overlapped each other into an unreadable pile, which no
   * assertion in this file would have caught. Alternating the radius separates
   * adjacent nodes radially instead of relying on an arc length the label
   * widths do not respect, and it still reads as one constellation.
   */
  const stagger = count > 6;
  /*
   * An even count is rotated by half a step so that no node sits on the
   * horizontal through the nucleus.
   *
   * Also found by looking. With eight children, two of them landed exactly
   * beside the centre node and overlapped it — on a phone the ring simply is
   * not wider than a label plus the nucleus. Half a step costs nothing and
   * guarantees a vertical gap of at least `ry · sin(π/count)`.
   */
  const offset = count % 2 === 0 ? Math.PI / count : 0;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + offset + (index * 2 * Math.PI) / count;
    const scale = stagger && index % 2 === 1 ? 0.62 : 1;
    return [cx + rx * scale * Math.cos(angle), cy + ry * scale * Math.sin(angle)] as [
      number,
      number,
    ];
  });
}

/**
 * The curve between two points, in canvas pixels.
 *
 * The prototype's quadratic, kept because the bend is what makes a hub-and-
 * spoke diagram read as a constellation rather than a bicycle wheel. The bend
 * is capped so a long spoke does not bow across the whole canvas.
 */
export function curvePath(
  from: [number, number],
  to: [number, number],
): string {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const bend = Math.min(38, Math.hypot(x2 - x1, y2 - y1) * 0.12);
  return `M ${x1} ${y1} Q ${mx + bend} ${my - bend} ${x2} ${y2}`;
}

/** The canvas's own size, watched, because the ring depends on it. */
function useElementSize(): [
  React.RefObject<HTMLDivElement>,
  { width: number; height: number },
] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** What the detail card says about one node. Never composed from a template. */
function connectionSentence(node: IdeaNode, edges: IdeaEdge[]): string {
  const feeds = edges.filter((edge) => edge.kind === 'FEEDS' && edge.from === node.id).length;
  const fedBy = edges.filter((edge) => edge.kind === 'FEEDS' && edge.to === node.id).length;
  const parts: string[] = [];
  if (node.counts.children > 0) {
    parts.push(`${node.counts.children} ${node.counts.children === 1 ? 'idea' : 'ideas'} inside`);
  }
  if (fedBy > 0) parts.push(`built on ${fedBy}`);
  if (feeds > 0) parts.push(`feeds ${feeds}`);
  if (node.counts.unknowns > 0) {
    parts.push(`${node.counts.unknowns} still open`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Nothing connects to this yet.';
}

export function Constellation({
  map,
  focusId,
  onFocus,
}: {
  map: IdeaMap;
  focusId: string;
  onFocus: (nodeId: string) => void;
}): JSX.Element {
  const [canvasRef, size] = useElementSize();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const centre = byId.get(focusId) ?? byId.get(map.rootId);
  const children = map.nodes.filter((node) => node.parentId === (centre?.id ?? map.rootId));

  // The breadcrumb, walked from the node rather than kept as a history stack —
  // so it is always the truth about where you are, even after a reload.
  const trail: IdeaNode[] = [];
  let walk = centre;
  let guard = map.nodes.length + 1;
  while (walk && guard-- > 0) {
    trail.unshift(walk);
    walk = walk.parentId ? byId.get(walk.parentId) : undefined;
  }

  const [cx, cy] = centreOf(size.width);
  const ring = ringPositions(children.length, size.width);
  const toPixels = ([x, y]: [number, number]): [number, number] => [
    (x / 100) * size.width,
    (y / 100) * size.height,
  ];

  const shown = selectedId ? (byId.get(selectedId) ?? centre) : centre;

  return (
    <section className="lim" aria-labelledby="lim-heading">
      <div className="lim-header">
        <h2 id="lim-heading">{centre ? centre.title : 'Nothing to show'}</h2>
        <span className="lim-depth">
          {centre?.level === 'SITE'
            ? 'Site → major ideas'
            : centre?.level === 'MAJOR'
              ? 'Major idea → ideas inside it'
              : 'One idea'}
        </span>
      </div>

      <nav className="lim-path" aria-label="Where you are">
        {trail.map((node, index) => (
          <button
            key={node.id}
            type="button"
            className="lim-crumb"
            disabled={index === trail.length - 1}
            onClick={() => {
              setSelectedId(null);
              onFocus(node.id);
            }}
          >
            {node.title}
          </button>
        ))}
      </nav>

      <div
        className="lim-canvas"
        ref={canvasRef}
        role="group"
        aria-label="The shape of this project. The same information is listed below."
      >
        <svg
          className="lim-lines"
          aria-hidden="true"
          viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`}
        >
          {ring.map((position, index) => {
            const child = children[index];
            if (!child) return null;
            return (
              <path
                key={child.id}
                className={`lim-line${selectedId === child.id ? ' is-active' : ''}`}
                d={curvePath(toPixels([cx, cy]), toPixels(position))}
              />
            );
          })}
        </svg>
        <div className="lim-halo" aria-hidden="true" style={{ left: `${cx}%`, top: `${cy}%` }} />
        <div className="lim-nodes">
          {centre ? (
            <button
              type="button"
              className="lim-node is-centre"
              data-depth="root"
              style={{ left: `${cx}%`, top: `${cy}%` }}
              aria-pressed={selectedId === null}
              onClick={() => setSelectedId(null)}
            >
              {centre.title}
            </button>
          ) : null}
          {children.map((child, index) => {
            const position = ring[index];
            if (!position) return null;
            return (
              <button
                key={child.id}
                type="button"
                className={`lim-node${selectedId === child.id ? ' is-selected' : ''}`}
                data-depth={child.level.toLowerCase()}
                style={{ left: `${position[0]}%`, top: `${position[1]}%` }}
                aria-pressed={selectedId === child.id}
                onClick={() => setSelectedId(child.id)}
                onDoubleClick={() => {
                  setSelectedId(null);
                  onFocus(child.id);
                }}
              >
                {child.title}
                {child.counts.children > 0 ? ` · ${child.counts.children}` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* One selected thing, described. Announced rather than silently swapped. */}
      <div className="lim-detail" aria-live="polite">
        {shown ? (
          <>
            <strong>{shown.title}</strong>
            <span className="lim-detail-text">
              {shown.purpose ?? shown.why ?? shown.stateLabel}
            </span>
            <span className="lim-connections">{connectionSentence(shown, map.edges)}</span>
          </>
        ) : null}
      </div>
      {shown && shown.id !== centre?.id ? (
        <button
          type="button"
          className="rs-more"
          onClick={() => {
            setSelectedId(null);
            onFocus(shown.id);
          }}
        >
          Open {shown.title}
        </button>
      ) : null}
    </section>
  );
}
