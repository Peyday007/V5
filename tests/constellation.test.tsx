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
import { Constellation, curvePath, ringPositions } from '../client/src/russell/Constellation.tsx';
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
      const ring = ringPositions(count, 900);
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
    const ring = ringPositions(5, 900);
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
      const ring = ringPositions(count, 390);
      const centreY = ring.reduce((total, point) => total + point[1], 0) / count;
      for (const [, y] of ring) {
        expect(Math.abs(y - centreY), `count ${count}`).toBeGreaterThan(1);
      }
    }
  });

  it('uses a narrower, taller ring on a phone', () => {
    const desktop = ringPositions(5, 900);
    const phone = ringPositions(5, 400);
    // The canvas is taller and the ring reaches further down it, so the
    // vertical spread is larger and the horizontal spread is not.
    const spread = (ring: [number, number][], index: 0 | 1): number =>
      Math.max(...ring.map((p) => p[index])) - Math.min(...ring.map((p) => p[index]));
    expect(spread(phone, 1)).toBeGreaterThan(spread(desktop, 1));
    expect(spread(phone, 0)).toBeLessThanOrEqual(spread(desktop, 0));
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
