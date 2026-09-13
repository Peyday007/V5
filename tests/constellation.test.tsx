// @vitest-environment jsdom
/**
 * The living constellation.
 *
 * Two kinds of test here and they answer different questions.
 *
 * The **geometry** is pure, so it is asserted directly: a ring that clumps
 * three nodes at the top or pushes eleven off the canvas is a defect a
 * screenshot would show and a test would not, unless the test knows what to
 * look for. What it looks for is that the positions are distinct, inside the
 * canvas, and evenly distributed however many there are — the property the
 * prototype's five hand-placed coordinates could not have.
 *
 * The **interaction** is rendered, because the requirement is behavioural:
 * site → major idea → ordinary idea, with a breadcrumb that keeps orientation
 * and a list that carries the same facts for anybody not using the map.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import {
  Constellation,
  curvePath,
  limLayout,
  RING_MIN_ARC,
  RING_MIN_CANVAS,
  ringPerimeter,
  ringPositions,
  spinePath,
} from '../client/src/russell/Constellation.tsx';
import type { IdeaMap, IdeaNode } from '../client/src/lib/russellApi.ts';

afterEach(cleanup);

function node(over: Partial<IdeaNode> & Pick<IdeaNode, 'id' | 'level' | 'title'>): IdeaNode {
  return {
    parentId: null,
    purpose: null,
    why: null,
    state: 'ACTIVE',
    stateLabel: 'Active',
    progress: {
      stage: 'FORMING',
      headline: 'Forming — 1 of 3 settled.',
      completed: [],
      missing: [],
      ratio: { done: 1, total: 3 },
      blockedBy: [],
    },
    priority: null,
    priorityLabel: null,
    counts: { knowledge: 0, unknowns: 0, work: 0, conversations: 0, children: 0 },
    links: { projectId: 'prj', layerId: null, candidateId: null, conversationId: null },
    ...over,
  } as IdeaNode;
}

/** A three-level map, the shape the projection actually returns. */
function sampleMap(): IdeaMap {
  return {
    rootId: 'site:prj',
    nodes: [
      node({ id: 'site:prj', level: 'SITE', title: 'A site', purpose: 'what it is for' }),
      node({
        id: 'major:a',
        level: 'MAJOR',
        parentId: 'site:prj',
        title: 'First part',
        counts: { knowledge: 2, unknowns: 1, work: 1, conversations: 0, children: 1 },
      }),
      node({ id: 'major:b', level: 'MAJOR', parentId: 'site:prj', title: 'Second part' }),
      node({ id: 'idea:1', level: 'REGULAR', parentId: 'major:a', title: 'An idea inside' }),
    ],
    edges: [
      { from: 'site:prj', to: 'major:a', kind: 'CONTAINS', reason: 'part of this site' },
      { from: 'site:prj', to: 'major:b', kind: 'CONTAINS', reason: 'part of this site' },
      { from: 'major:a', to: 'major:b', kind: 'FEEDS', reason: 'the second is built on the first' },
      { from: 'major:a', to: 'idea:1', kind: 'CONTAINS', reason: 'an idea inside this part' },
    ],
  };
}

describe('the ring generalises rather than reproducing five fixed points', () => {
  it('spaces any number of nodes evenly and keeps them on the canvas', () => {
    for (const count of [1, 2, 3, 5, 8, 11]) {
      const ring = ringPositions(count);
      expect(ring).toHaveLength(count);
      // Distinct: two nodes at the same coordinates are one node as far as a
      // person can tell.
      expect(new Set(ring.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`)).size).toBe(count);
      for (const [x, y] of ring) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(100);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(100);
      }
    }
  });

  it('puts an odd count’s first node at the top and goes clockwise', () => {
    const ring = ringPositions(5);
    const first = ring[0]!;
    const second = ring[1]!;
    const last = ring[4]!;
    expect(first[0]).toBeCloseTo(50, 5);
    // Clockwise: the next one is to the right and lower, the last to the left.
    expect(second[0]).toBeGreaterThan(first[0]);
    expect(second[1]).toBeGreaterThan(first[1]);
    expect(last[0]).toBeLessThan(50);
  });

  it('rotates an even count so no node sits on the nucleus’s own line', () => {
    /*
     * The reason this rotation exists, asserted directly. With eight children
     * on a 390-wide canvas, two of them landed exactly beside the centre node
     * and covered it — the ring simply is not wider than a label plus the
     * nucleus. Half a step guarantees a vertical gap.
     */
    for (const count of [2, 4, 6, 8, 10]) {
      const ring = ringPositions(count);
      const centreY = ring.reduce((total, point) => total + point[1], 0) / count;
      for (const [, y] of ring) {
        expect(Math.abs(y - centreY), `count ${count}`).toBeGreaterThan(1);
      }
    }
  });

  it('puts every node on one ellipse, because the stagger did not work', () => {
    /*
     * The stagger is gone and this is what stops it coming back.
     *
     * It put every other node on 0.62 of the radius, to separate neighbours
     * radially rather than relying on an arc the label widths do not respect.
     * At phone width that is not imperfect, it is impossible: the inner ring
     * lands 59-75px from the centre of a 316px canvas while a node's half-width
     * alone reaches 73px, so an inner node cannot clear the nucleus at any label
     * size. The narrow case is a different arrangement now (see below), and the
     * ring is one ellipse again.
     */
    for (const count of [7, 8, 11]) {
      const ring = ringPositions(count);
      // Normalised by the ellipse's own radii, every node is one unit out.
      const radii = ring.map(([x, y]) => Math.hypot((x - 50) / 31, (y - 46) / 34));
      for (const radius of radii) expect(radius).toBeCloseTo(1, 6);
    }
  });

  it('bends a curve without letting a long spoke bow across the canvas', () => {
    const short = curvePath([0, 0], [10, 0]);
    const long = curvePath([0, 0], [2000, 0]);
    expect(short).toMatch(/^M 0 0 Q /);
    // Capped at 38 however long the spoke is.
    const controlX = Number(/Q (-?[\d.]+) /.exec(long)![1]);
    expect(controlX - 1000).toBeCloseTo(38, 5);
  });
});

/**
 * What the measurement found, and what is now impossible.
 *
 * These numbers are not invented for the test. They are the canvases the real
 * product produced at the three widths §24 names, read by
 * `scripts/visual-qa.ts --only=constellation` against a real server with the
 * ordinary seed's eight ideas:
 *
 *   1180px viewport -> 866x541 canvas -> 0 overlapping pairs
 *    953px viewport -> 647x404 canvas -> 1 pair before, 2 after the stagger went
 *    390px viewport -> 316x316 canvas -> 9 pairs, worst 2385px²
 *    360px viewport -> 286x286 canvas -> 13 pairs, worst 2316px²
 *
 * A jsdom test cannot reproduce any of that — it has no layout engine, which is
 * exactly why the pile-up survived a full suite. What it *can* pin is the
 * decision those readings produced, so an edit that quietly widens the ring back
 * over 647px fails here rather than in a screenshot somebody has to look at.
 */
describe('a canvas too small for a ring gets a different arrangement', () => {
  it('keeps the ring only where it was measured not to overlap', () => {
    expect(limLayout(8, 866)).toBe('ORBIT');
    expect(limLayout(8, 647)).toBe('SPINE');
    expect(limLayout(8, 316)).toBe('SPINE');
    expect(limLayout(8, 286)).toBe('SPINE');
  });

  it('decides from the count and the width, and from nothing else', () => {
    /*
     * The property that stops it oscillating. A spine's height comes from its
     * own content, so a decision that read the canvas's measured height would
     * flip back to a ring, which would change the height, for ever. There is no
     * height parameter to pass, and the same width and count always answer the
     * same thing.
     */
    expect(limLayout(8, 647)).toBe(limLayout(8, 647));
    // More nodes on one canvas can only ever move it toward the spine.
    const widths = [560, 700, 900, 1400];
    for (const width of widths) {
      const few = limLayout(3, width);
      const many = limLayout(40, width);
      expect(`${few}/${many}`).not.toBe('SPINE/ORBIT');
    }
  });

  it('refuses a ring narrower than one, whatever the count', () => {
    for (const count of [1, 2, 3, 8]) {
      expect(limLayout(count, RING_MIN_CANVAS - 1)).toBe('SPINE');
    }
  });

  it('is the ring while the canvas has not been measured yet', () => {
    // First paint and jsdom both arrive here. Deciding SPINE on an unmeasured
    // canvas would show the narrow arrangement for a frame on every desktop.
    expect(limLayout(8, 0)).toBe('ORBIT');
  });

  it('turns a crowded desktop ring into a spine rather than a pile', () => {
    // The case nothing could see before: the arc per node shrinks as the count
    // grows, and there was no rule that noticed.
    const width = 900;
    const roomy = Math.floor(ringPerimeter(width) / RING_MIN_ARC);
    expect(limLayout(roomy, width)).toBe('ORBIT');
    expect(limLayout(roomy + 1, width)).toBe('SPINE');
  });
});

describe('a spine connector leaves the hub, runs the gutter and turns out', () => {
  it('ends on the node’s own edge rather than in the middle of its label', () => {
    const path = spinePath([158, 60], [230, 300]);
    expect(path.endsWith('L 230 300')).toBe(true);
    expect(path.startsWith('M 158 60')).toBe(true);
  });

  it('runs down the gutter before it turns, so it cannot cross a row above', () => {
    const path = spinePath([158, 60], [230, 300], 12);
    // Straight down the trunk's own x to just above the target row, and only
    // then out. A direct line from the hub to the last row would be drawn
    // across every node between them.
    expect(path).toContain('L 158 288');
  });

  it('does not double back when the node is level with or beside the hub', () => {
    // Degenerate cases: an elbow here would leave the gutter and come back.
    expect(spinePath([158, 60], [160, 300])).toBe('M 158 60 L 158 300 L 160 300');
    expect(spinePath([158, 60], [230, 66])).toBe('M 158 60 L 158 66 L 230 66');
  });
});

describe('drilling in and back keeps a person oriented', () => {
  it('opens on the site with its major ideas in orbit', () => {
    render(<Constellation map={sampleMap()} focusId="site:prj" onFocus={() => {}} />);
    expect(screen.getByRole('heading', { name: 'A site' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /First part/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Second part/ })).toBeTruthy();
    // The idea *inside* a major is not on screen yet; that is the next level.
    expect(screen.queryByRole('button', { name: /An idea inside/ })).toBeNull();
  });

  it('reports which node is selected with aria-pressed, not with colour alone', () => {
    render(<Constellation map={sampleMap()} focusId="site:prj" onFocus={() => {}} />);
    const first = screen.getByRole('button', { name: /First part/ });
    expect(first.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      fireEvent.click(first);
    });
    expect(first.getAttribute('aria-pressed')).toBe('true');
  });

  it('describes the selected node in a region that announces itself', () => {
    const { container } = render(
      <Constellation map={sampleMap()} focusId="site:prj" onFocus={() => {}} />,
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /First part/ }));
    });
    // Counts come from the projection, and "1 idea inside" is a fact about
    // rows rather than a label somebody typed.
    expect(live!.textContent).toContain('First part');
    expect(live!.textContent).toContain('1 idea inside');
  });

  it('gives a breadcrumb whose last step is where you are and is not a link', () => {
    render(<Constellation map={sampleMap()} focusId="major:a" onFocus={() => {}} />);
    const crumbs = screen.getAllByRole('button').filter((button) =>
      button.className.includes('lim-crumb'),
    );
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['A site', 'First part']);
    expect((crumbs[1] as HTMLButtonElement).disabled).toBe(true);
    expect((crumbs[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks its parent to change focus rather than deciding by itself', () => {
    const seen: string[] = [];
    render(
      <Constellation map={sampleMap()} focusId="major:a" onFocus={(id) => seen.push(id)} />,
    );
    const crumbs = screen
      .getAllByRole('button')
      .filter((button) => button.className.includes('lim-crumb'));
    act(() => {
      fireEvent.click(crumbs[0]!);
    });
    // Focus is the caller's state, so the list and the map cannot disagree
    // about where a person is.
    expect(seen).toEqual(['site:prj']);
  });

  it('never renders a node the projection did not return', () => {
    const map = sampleMap();
    render(<Constellation map={map} focusId="site:prj" onFocus={() => {}} />);
    const titles = new Set(map.nodes.map((entry) => entry.title));
    for (const button of screen.getAllByRole('button')) {
      const label = (button.textContent ?? '').split(' · ')[0]!.trim();
      if (label === '') continue;
      // Nothing invented, and in particular none of the prototype's demo
      // vocabulary — Discovery, Qualification, Monetization and the rest.
      expect(titles.has(label)).toBe(true);
    }
  });
});

/**
 * The rule §29 states about every map, asked of the arrangement that changed.
 *
 * *Every map carries a synchronized outline built in the same pass, so the
 * screen-reader path and the picture cannot describe different graphs.* A
 * narrow layout that dropped a node to make room would satisfy every geometry
 * assertion above and break that — so what is pinned here is the count, at both
 * arrangements, from one projection.
 *
 * jsdom has no layout engine, so the canvas's width is stubbed. That is the
 * honest limit of this file and the reason `scripts/visual-qa.ts` measures the
 * same two facts — nodes drawn against rows listed — on a real screen.
 */
describe('the narrow arrangement is the same graph, not a smaller one', () => {
  function atCanvasWidth(width: number, body: () => void): void {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(): number {
        return width;
      },
    });
    try {
      body();
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'clientWidth', previous);
    }
  }

  it('marks which arrangement it drew, so a capture can be read back', () => {
    atCanvasWidth(316, () => {
      const { container } = render(
        <Constellation map={sampleMap()} focusId="site:prj" onFocus={() => {}} />,
      );
      expect(container.querySelector('.lim-canvas')?.getAttribute('data-layout')).toBe('spine');
    });
    cleanup();
    atCanvasWidth(866, () => {
      const { container } = render(
        <Constellation map={sampleMap()} focusId="site:prj" onFocus={() => {}} />,
      );
      expect(container.querySelector('.lim-canvas')?.getAttribute('data-layout')).toBe('orbit');
    });
  });

  it('draws the nucleus and every child at both arrangements', () => {
    const map = sampleMap();
    const children = map.nodes.filter((entry) => entry.parentId === 'site:prj').length;
    for (const width of [316, 286, 647, 866]) {
      cleanup();
      atCanvasWidth(width, () => {
        const { container } = render(
          <Constellation map={map} focusId="site:prj" onFocus={() => {}} />,
        );
        expect(container.querySelectorAll('.lim-node').length, `at ${width}px`).toBe(
          children + 1,
        );
      });
    }
  });

  it('stops positioning nodes by hand once the grid is placing them', () => {
    // Percentage coordinates left on a grid item would fight the cell it is in,
    // which is how a "responsive" absolute layout ends up overlapping anyway.
    atCanvasWidth(316, () => {
      const { container } = render(
        <Constellation map={sampleMap()} focusId="site:prj" onFocus={() => {}} />,
      );
      for (const node of container.querySelectorAll<HTMLElement>('.lim-node')) {
        expect(node.style.left).toBe('');
        expect(node.style.top).toBe('');
      }
    });
  });
});
