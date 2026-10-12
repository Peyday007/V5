// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPanel } from '../client/src/russell/Connections.tsx';

const SENTENCE = 'A retrying connection recovers by itself; only a reconnect needs you.';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Connections recovery hint', () => {
  it('shows the sentence beneath the heading, even while the page is still loading', () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const { container } = render(<ConnectionsPanel />);
    const hint = screen.getByText(SENTENCE);
    expect(hint.tagName).toBe('P');
    expect(hint.className).toBe('rs-hint');
    const heading = screen.getByRole('heading', { name: 'Connections' });
    expect(heading.nextElementSibling).toBe(hint);
    expect(container.contains(hint)).toBe(true);
  });
});
