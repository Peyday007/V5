// @vitest-environment jsdom
/**
 * The research budgets section, rendered from a payload typed against the
 * server's own view type — so when the server's contract moves, this stops
 * compiling instead of going on passing against a shape the route cannot
 * produce.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchBudgets, ResearchBudgetsList } from '../client/src/russell/ResearchBudgets.tsx';
import type { GoalBudgetView } from '../server/services/research/goalBudgetView.ts';

const STOPPED: GoalBudgetView = {
  goalId: 'rgl_1',
  name: 'Michigan county records',
  state: 'ACTIVE',
  packets: { used: 2, reserved: 2, ceiling: 2 },
  fragments: { committed: 5, ceiling: 9 },
  deadline: '2026-12-01T00:00:00.000Z',
  authorizedBy: 'usr_owner',
  authorizedByName: 'Pat Owner',
  createdAt: '2026-10-01T00:00:00.000Z',
  stoppedBy: 'PACKETS',
  stoppingSentence: 'SERVER SENTENCE: the packet ceiling is reached; raising it is your decision.',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the research budgets section', () => {
  it('shows used of limit, the deadline, who authorized it, and the server’s sentence verbatim', () => {
    render(<ResearchBudgetsList goals={[STOPPED]} />);
    expect(screen.getByText('Michigan county records')).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(screen.getByText('5 of 9')).toBeTruthy();
    expect(screen.getByText('2026-12-01T00:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('Pat Owner')).toBeTruthy();
    expect(screen.getByText(STOPPED.stoppingSentence)).toBeTruthy();
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<ResearchBudgetsList goals={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('reads the project’s list route and renders what it answers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ goals: [STOPPED] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ResearchBudgets projectId="prj_1" />);
    await waitFor(() => expect(screen.getByText(STOPPED.stoppingSentence)).toBeTruthy());
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/projects/prj_1/research-goals');
  });

  it('renders nothing when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const { container } = render(<ResearchBudgets projectId="prj_1" />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.innerHTML).toBe('');
  });
});
