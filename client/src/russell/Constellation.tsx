/**
 * The living constellation.
 *
 * A site sits at the centre; its major ideas orbit it; selecting one moves it
 * into the centre and its ordinary ideas unfold around it. A breadcrumb keeps
 * orientation and a detail card says what the selected thing is, what state it
 * is in and what it connects to.
 *
 * Four things about this are deliberate and worth reading before changing it.
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
 * **A ring is not the only shape this can be, and a phone is where it stops
 * being one.** This is a measured correction to two earlier attempts, recorded
 * rather than quietly applied. The first spread eight nodes on one ellipse and
 * they piled up; the second staggered every other node onto `0.62` of the
 * radius, on the reasoning that separating neighbours radially beats relying on
 * an arc length the label widths do not respect. Both were arrived at by
 * looking, and the second is *arithmetically impossible* at phone width rather
 * than merely imperfect: at a 390px viewport the canvas is 316px wide, so the
 * inner ring lands 59-75px from the centre while a node's half-width alone
 * reaches 73px. An inner node cannot clear the nucleus at any label size, so no
 * value of the stagger fixes it — which is why the stagger is **gone** rather
 * than tuned.
 *
 * Below `RING_MIN_CANVAS` the same graph is drawn as a **spine**: the nucleus at
 * the top, its children in two columns beneath it, and one connector per child
 * leaving the nucleus, running down the gutter between the columns and turning
 * out to that child's own edge. It is still a spatial diagram with a hub, real
 * edges and the same selection — and the nodes are placed by the *grid*, so two
 * of them overlapping is not one tuning failure away, it is geometrically
 * impossible. Nothing is truncated and nothing is abbreviated, and the node
 * count is untouched: what changes is the arrangement, never the graph.
 *
 * **The map is not the only way to read the shape.** The same projection is
 * rendered as a list underneath, and the list is what a screen reader gets —
 * not a summary of the map, the same facts. A diagram that is the sole carrier
 * of the structure is a diagram that excludes people.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { IdeaEdge, IdeaMap, IdeaNode } from '../lib/russellApi.ts';

/** Which of the two arrangements one canvas is drawing. */
export type LimLayout = 'ORBIT' | 'SPINE';

/**
 * The canvas's proportions in orbit, owned here rather than in the stylesheet.
 *
 * `limLayout` has to know how tall the canvas will be to know how much room the
 * ellipse has, and the stylesheet has to know it to size the box. Two copies of
 * one number is two numbers waiting to disagree, so this is the only one: the
 * component hands it down as `--lim-aspect` and `design.css` reads it.
 */
export const ORBIT_ASPECT = '16 / 10';
const ORBIT_RATIO = 16 / 10;

/** Where the nucleus sits, as a percentage of the canvas. */
const CENTRE: [number, number] = [50, 46];

/** The ring's radii, as percentages. The prototype's proportions, generalised. */
const RADII: [number, number] = [31, 34];

/**
 * The narrowest canvas a ring is allowed on.
 *
 * Not a phone breakpoint and not a matter of taste: below this the ellipse's own
 * minor radius is smaller than a node's half-width plus the nucleus's, which is
 * the condition in the header. 520 keeps the ring everywhere it fits and hands
 * the narrow case to a layout that cannot overlap, rather than to a smaller ring
 * that can.
 */
export const RING_MIN_CANVAS = 520;

/**
 * The least arc, in pixels, one node needs on the ring.
 *
 * A fixed number of pixels rather than a fraction of the canvas, because what
 * has to fit is a label — and a label does not get shorter when the window does.
 * This is what replaces the stagger: a ring that cannot give every node this
 * much room is not tightened, it becomes a spine. Twelve ideas on a desktop is
 * the case that used to pile up silently, and nothing before this could see it.
 *
 * **It is measured rather than derived, and the two readings that bracket it are
 * worth keeping.** With eight ideas the 1180px viewport gives an 866px canvas
 * and 179px of arc per node, and nothing overlaps; the 953px viewport gives a
 * 647px canvas and 134px of arc, and a pair is painted over each other there in
 * every reading taken — with the stagger and without it. So the boundary is
 * between those, and 160 is inside both margins.
 *
 * Saying "measured" matters, because it is the honest difference between the two
 * arrangements: the **spine cannot overlap** — the grid decides, and two things
 * in different cells are disjoint whatever the label does — while the ring is
 * only known not to overlap for the labels this projection actually produces. A
 * ring is the better picture where it holds, and this is what stops it being
 * used where it does not.
 */
export const RING_MIN_ARC = 160;

/** The ellipse's circumference, by Ramanujan's approximation. */
export function ringPerimeter(width: number): number {
  const a = (RADII[0] / 100) * width;
  const b = (RADII[1] / 100) * (width / ORBIT_RATIO);
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/**
 * Which arrangement this many nodes get on a canvas this wide.
 *
 * Deliberately a function of the count and the **width** only. The obvious
 * alternative — deciding from the canvas's measured height, or from the measured
 * node boxes — oscillates: a spine's height comes from its content, so a
 * decision that read the height would flip back to a ring, which would change
 * the height, for ever. An unmeasured canvas is `ORBIT`, so the first paint and
 * a test environment with no layout engine both render the ring they always
 * did; the real decision arrives in the same frame, before paint.
 */
export function limLayout(count: number, width: number): LimLayout {
  if (width <= 0 || count === 0) return 'ORBIT';
  if (width < RING_MIN_CANVAS) return 'SPINE';
  return ringPerimeter(width) / count >= RING_MIN_ARC ? 'ORBIT' : 'SPINE';
}

/**
 * Where each orbiting node goes.
 *
 * Evenly spaced from the top, clockwise, so the ordering a person sees matches
 * the ordering the projection returned rather than being arbitrary.
 */
export function ringPositions(count: number): [number, number][] {
  if (count === 0) return [];
  const [cx, cy] = CENTRE;
  const [rx, ry] = RADII;
  /*
   * Where the ring starts, and why an even count starts somewhere else.
   *
   * Found by looking. With eight children, two of them landed exactly beside
   * the centre node and covered it.
   *
   * An odd count starts at the top and never lands on the nucleus's own
   * horizontal, because no odd count divides an even number of half-turns. An
   * even count starts at `π/count`, which puts every node at an *odd* multiple
   * of `π/count` — and an odd multiple can never be a whole multiple of `π` when
   * the count is even, so no node can sit on that line for any even count at
   * all.
   *
   * The obvious fix — rotate the top-start by half a step — is wrong, and the
   * suite caught it: it works for four and eight and puts a node exactly on the
   * line for two and six.
   */
  const start = count % 2 === 0 ? Math.PI / count : -Math.PI / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = start + (index * 2 * Math.PI) / count;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] as [number, number];
  });
}

/**
 * The curve between two points, in canvas pixels.
 *
 * The prototype's quadratic, kept because the bend is what makes a hub-and-
 * spoke diagram read as a constellation rather than a bicycle wheel. The bend
 * is capped so a long spoke does not bow across the whole canvas.
 */
export function curvePath(from: [number, number], to: [number, number]): string {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const bend = Math.min(38, Math.hypot(x2 - x1, y2 - y1) * 0.12);
  return `M ${x1} ${y1} Q ${mx + bend} ${my - bend} ${x2} ${y2}`;
}

/**
 * One spine connector: out of the nucleus, down the gutter, out to a node.
 *
 * `from` is where the nucleus hands off — the middle of the gutter, at the
 * bottom of the hub — and `to` is a point on the node's own **inner edge**,
 * never its centre: a line carried on into the middle of a label would be drawn
 * across the words it is pointing at. The gutter is empty by construction (it is
 * the grid's column gap), so a connector to the last row cannot cross the rows
 * above it, which is the whole reason the route bends rather than going
 * straight.
 */
export function spinePath(from: [number, number], to: [number, number], bend = 12): string {
  const [hx, hy] = from;
  const [ex, ey] = to;
  // Too close to turn into, or level with the hub: an elbow would double back.
  if (Math.abs(ex - hx) <= bend || ey - hy <= bend) {
    return `M ${hx} ${hy} L ${hx} ${ey} L ${ex} ${ey}`;
  }
  const direction = ex > hx ? 1 : -1;
  return (
    `M ${hx} ${hy} L ${hx} ${ey - bend} ` +
    `Q ${hx} ${ey} ${hx + direction * bend} ${ey} L ${ex} ${ey}`
  );
}

/** The canvas's own size, watched, because the layout depends on it. */
function useElementSize(): [
  React.RefObject<HTMLDivElement>,
  { width: number; height: number },
] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  /*
   * A layout effect rather than an effect, so the arrangement is decided before
   * the browser paints. Measured in an ordinary effect, a phone rendered one
   * frame of the ring that cannot fit and then replaced it — a flash of exactly
   * the defect this change exists to remove.
   */
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void =>
      setSize((previous) =>
        previous.width === element.clientWidth && previous.height === element.clientHeight
          ? previous
          : { width: element.clientWidth, height: element.clientHeight },
      );
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

  const layout = limLayout(children.length, size.width);
  const [cx, cy] = CENTRE;
  const ring = ringPositions(children.length);
  const toPixels = ([x, y]: [number, number]): [number, number] => [
    (x / 100) * size.width,
    (y / 100) * size.height,
  ];

  /*
   * The spine's connectors, measured from the boxes the grid produced.
   *
   * The orbit knows where its nodes are because it put them there. The spine
   * does not: the grid decides, from the labels' own wrapping — which is exactly
   * what makes it impossible for two nodes to overlap, and it means the only
   * honest source for where an edge starts and ends is the rendered boxes. So
   * these are read back after layout and before paint, and re-read whenever the
   * canvas resizes or a font finishes loading and the rows move.
   *
   * There is no dependency list and the guard is the key: the effect runs after
   * every render, computes what the edges would be, and sets state only when
   * they have actually changed — which converges in one extra render and cannot
   * loop, because the edges are read from the boxes and nothing about the edges
   * moves a box.
   */
  const hubRef = useRef<HTMLButtonElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const [spine, setSpine] = useState<{ id: string; d: string }[]>([]);
  const spineKey = useRef('');
  useLayoutEffect(() => {
    if (layout !== 'SPINE') {
      if (spineKey.current !== '') {
        spineKey.current = '';
        setSpine([]);
      }
      return;
    }
    const canvas = canvasRef.current;
    const hub = hubRef.current;
    if (!canvas || !hub) return;
    const base = canvas.getBoundingClientRect();
    const hubBox = hub.getBoundingClientRect();
    // The gutter's middle, which is the canvas's middle: the grid's padding is
    // symmetric and the nucleus is centred in its own full-width row.
    const trunk = Math.round(base.width / 2);
    const from: [number, number] = [trunk, Math.round(hubBox.bottom - base.top)];
    const next: { id: string; d: string }[] = [];
    for (const child of children) {
      const element = nodeRefs.current.get(child.id);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      const y = Math.round(box.top - base.top + box.height / 2);
      const middle = box.left - base.left + box.width / 2;
      const edge = Math.round(middle >= trunk ? box.left - base.left : box.right - base.left);
      next.push({ id: child.id, d: spinePath(from, [edge, y]) });
    }
    const key = next.map((edge) => `${edge.id}:${edge.d}`).join('|');
    if (key !== spineKey.current) {
      spineKey.current = key;
      setSpine(next);
    }
  });

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
        data-layout={layout === 'ORBIT' ? 'orbit' : 'spine'}
        style={
          {
            // One master for the proportions; see ORBIT_ASPECT. A spine is as
            // tall as its own content, which is what stops a ninth idea being
            // squeezed into a square that was only ever big enough for six.
            '--lim-aspect': layout === 'ORBIT' ? ORBIT_ASPECT : 'auto',
          } as CSSProperties
        }
        role="group"
        aria-label="The shape of this project. The same information is listed below."
      >
        <svg
          className="lim-lines"
          aria-hidden="true"
          viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`}
        >
          {layout === 'ORBIT'
            ? ring.map((position, index) => {
                const child = children[index];
                if (!child) return null;
                return (
                  <path
                    key={child.id}
                    className={`lim-line${selectedId === child.id ? ' is-active' : ''}`}
                    d={curvePath(toPixels([cx, cy]), toPixels(position))}
                  />
                );
              })
            : spine.map((edge) => (
                <path
                  key={edge.id}
                  className={`lim-line${selectedId === edge.id ? ' is-active' : ''}`}
                  d={edge.d}
                />
              ))}
        </svg>
        {layout === 'ORBIT' ? (
          <div className="lim-halo" aria-hidden="true" style={{ left: `${cx}%`, top: `${cy}%` }} />
        ) : null}
        <div className="lim-nodes">
          {centre ? (
            <button
              type="button"
              ref={hubRef}
              className="lim-node is-centre"
              data-depth="root"
              style={layout === 'ORBIT' ? { left: `${cx}%`, top: `${cy}%` } : undefined}
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
                ref={(element) => {
                  if (element) nodeRefs.current.set(child.id, element);
                  else nodeRefs.current.delete(child.id);
                }}
                className={`lim-node${selectedId === child.id ? ' is-selected' : ''}`}
                data-depth={child.level.toLowerCase()}
                style={
                  layout === 'ORBIT'
                    ? { left: `${position[0]}%`, top: `${position[1]}%` }
                    : undefined
                }
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
