// @vitest-environment jsdom
/**
 * The world scene (UI-27-1, UI-27-3, UI-27-5): same facts in every render
 * mode, an honest working count, three distinct prototypes with labelled
 * sample state, and keyboard selection identical to a click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import type { WorldFact } from '../server/routes/world.ts';
import { WorldScene, layoutScene, workingFactCount } from '../client/src/world/WorldScene.tsx';
import { PROTOTYPES, WorldPrototypes } from '../client/src/world/prototypes/index.tsx';
import { SAMPLE_FACTS, SAMPLE_GENERATED_AT } from '../client/src/world/prototypes/sample.ts';
import { initialLensState, lensReducer, type LensAction } from '../client/src/world/lens.ts';
import { DRAGON_THEME, PLAIN_THEME } from '../client/src/world/theme.ts';
import type { WorldRenderMode } from '../client/src/world/capability.ts';
import type { TruthContext } from '../client/src/world/truth.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const ctx: TruthContext = { world: { generatedAt: SAMPLE_GENERATED_AT, projectId: 'sample_project' }, nowMs: Date.parse(SAMPLE_GENERATED_AT) };
const MODES: WorldRenderMode[] = ['ANIMATED', 'STATIC', 'NUMBERS_ONLY'];

function renderScene(mode: WorldRenderMode, facts: readonly WorldFact[] = SAMPLE_FACTS, onLensAction: (a: LensAction) => void = () => {}) {
  return render(createElement(WorldScene, { facts, mode, lens: initialLensState(), onLensAction, ctx, sample: true }));
}

function rowIds(container: HTMLElement): string[] {
  return [...within(container).getByTestId('world-facts').querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-record') ?? '');
}

describe('world scene: one set of facts in every mode', () => {
  it('renders the same facts in ANIMATED, STATIC and NUMBERS_ONLY, with a table of the same facts', () => {
    const expected = SAMPLE_FACTS.map((f) => `${f.kind}:${f.recordId}`);
    for (const mode of MODES) {
      const { container, unmount } = renderScene(mode);
      expect(rowIds(container)).toEqual(expected);
      const svg = container.querySelector('[data-testid="world-svg"]');
      if (mode === 'NUMBERS_ONLY') {
        expect(svg).toBeNull();
      } else {
        expect(svg).not.toBeNull();
        const drawn = [...container.querySelectorAll('.world-object')].map((g) => g.getAttribute('data-record'));
        expect(drawn.sort()).toEqual([...expected].sort());
      }
      unmount();
    }
  });

  it('shows ambient motion only in ANIMATED mode and only on WORKING facts', () => {
    const animated = renderScene('ANIMATED');
    const ambient = [...animated.container.querySelectorAll('.world-ambient')].map((g) => g.getAttribute('data-record'));
    expect(ambient.sort()).toEqual(SAMPLE_FACTS.filter((f) => f.state === 'WORKING').map((f) => `${f.kind}:${f.recordId}`).sort());
    animated.unmount();
    const still = renderScene('STATIC');
    expect(still.container.querySelectorAll('.world-ambient')).toHaveLength(0);
  });

  it('labels every drawn object with its state in words', () => {
    const { container } = renderScene('STATIC');
    for (const g of container.querySelectorAll('.world-object')) expect(g.getAttribute('aria-label')).toMatch(/: \S/);
  });
});

describe('world scene: working count', () => {
  it('equals the number of WORKING facts, never the number of characters', () => {
    const working = SAMPLE_FACTS.filter((f) => f.state === 'WORKING').length;
    expect(workingFactCount(SAMPLE_FACTS)).toBe(working);
    renderScene('STATIC');
    expect(screen.getByTestId('world-working').textContent).toContain(`${working} working`);
    const characters = SAMPLE_FACTS.filter((f) => f.kind === 'WORKER');
    expect(characters.length).toBeGreaterThan(0);
    expect(characters.every((c) => c.state !== 'WORKING')).toBe(true);
  });

  it('is zero when nothing holds a live lease, however many workers are drawn', () => {
    const idle = SAMPLE_FACTS.map((f) => ({ ...f, state: f.state === 'WORKING' ? ('WAITING' as const) : f.state }));
    renderScene('ANIMATED', idle);
    expect(screen.getByTestId('world-working').textContent).toContain('0 working');
  });
});

describe('world prototypes', () => {
  it('ships at least three distinct prototypes over the same facts, with sample state labelled', () => {
    expect(PROTOTYPES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(PROTOTYPES.map((p) => `${p.theme.id}/${p.layout}`)).size).toBe(PROTOTYPES.length);
    const expected = SAMPLE_FACTS.map((f) => `${f.kind}:${f.recordId}`);
    for (const p of PROTOTYPES) {
      const { container, unmount } = render(createElement(WorldPrototypes, { initial: p.id, mode: 'STATIC' }));
      expect(container.querySelector(`[data-variant="${p.id}"]`)).not.toBeNull();
      expect(within(container).getByTestId('world-sample').textContent).toMatch(/sample/i);
      expect(rowIds(container)).toEqual(expected);
      unmount();
    }
  });

  it('does not show the sample banner for live facts', () => {
    const live = SAMPLE_FACTS.map((f) => ({ ...f, title: f.title.replace('Sample', 'Live') }));
    render(createElement(WorldPrototypes, { facts: live, ctx, mode: 'STATIC' }));
    expect(screen.queryByTestId('world-sample')).toBeNull();
  });

  it('switches prototype by clicking without changing the facts', () => {
    const { container } = render(createElement(WorldPrototypes, { mode: 'STATIC' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ledger map' }));
    expect(container.querySelector('[data-variant="ledger"]')).not.toBeNull();
    expect(rowIds(container)).toHaveLength(SAMPLE_FACTS.length);
  });

  it('places groups differently per layout but keeps every fact', () => {
    for (const layout of ['ISOMETRIC', 'GRID', 'RADIAL'] as const) {
      const groups = layoutScene(SAMPLE_FACTS, PLAIN_THEME, layout);
      expect(groups.flatMap((g) => g.items).length).toBe(SAMPLE_FACTS.length);
    }
    const a = layoutScene(SAMPLE_FACTS, DRAGON_THEME, 'ISOMETRIC').map((g) => [g.x, g.y]);
    const b = layoutScene(SAMPLE_FACTS, DRAGON_THEME, 'RADIAL').map((g) => [g.x, g.y]);
    expect(a).not.toEqual(b);
  });
});

describe('world scene: keyboard and click select the same lens state', () => {
  it('Enter, Space and click on an object dispatch the identical SELECT', () => {
    const target = SAMPLE_FACTS[3]!;
    const actions: LensAction[] = [];
    const { container } = renderScene('STATIC', SAMPLE_FACTS, (a) => actions.push(a));
    const node = container.querySelector(`.world-object[data-record="${target.kind}:${target.recordId}"]`) as SVGGElement;
    expect(node.getAttribute('tabindex')).toBe('0');
    fireEvent.click(node);
    fireEvent.keyDown(node, { key: 'Enter' });
    fireEvent.keyDown(node, { key: ' ' });
    expect(actions).toHaveLength(3);
    expect(actions[1]).toEqual(actions[0]);
    expect(actions[2]).toEqual(actions[0]);
    expect(actions[0]).toEqual({ type: 'SELECT', selection: { kind: target.kind, id: target.recordId } });
    const after = lensReducer(initialLensState(), actions[0]!);
    expect(after.selected).toEqual({ kind: target.kind, id: target.recordId });
  });

  it('the table row button selects the same as the object, and details open in place', () => {
    const target = SAMPLE_FACTS[3]!;
    const onLensAction = vi.fn();
    const { container, rerender } = renderScene('NUMBERS_ONLY', SAMPLE_FACTS, onLensAction);
    fireEvent.click(within(container.querySelector(`tr[data-record="${target.kind}:${target.recordId}"]`) as HTMLElement).getByRole('button'));
    expect(onLensAction).toHaveBeenCalledWith({ type: 'SELECT', selection: { kind: target.kind, id: target.recordId } });
    const lens = lensReducer(initialLensState(), onLensAction.mock.calls[0]![0] as LensAction);
    rerender(createElement(WorldScene, { facts: SAMPLE_FACTS, mode: 'NUMBERS_ONLY', lens, onLensAction, ctx, sample: true }));
    const details = screen.getByTestId('world-details');
    expect(details.textContent).toContain(target.title);
    expect(details.textContent).toContain(target.blocker!);
  });

  it('camera controls are keyboard-reachable buttons', () => {
    const { container } = renderScene('STATIC');
    const toolbar = within(container).getByRole('toolbar', { name: 'Camera' });
    for (const name of ['Zoom in', 'Zoom out', 'Pan left', 'Pan right', 'Pan up', 'Pan down', 'Reset view']) {
      expect(within(toolbar).getByRole('button', { name }).tagName).toBe('BUTTON');
    }
    const svg = within(container).getByTestId('world-svg');
    const before = svg.querySelector('g')!.getAttribute('transform');
    fireEvent.keyDown(svg, { key: '+' });
    expect(svg.querySelector('g')!.getAttribute('transform')).not.toBe(before);
  });
});
