// @vitest-environment jsdom
/**
 * People & capacity says that joining and contributing are separate steps.
 * One sentence, asserted as what a person sees on the screen.
 *
 * The connection panel has its own suite (`peopleSection.test.tsx`), so it is
 * stood in for here and the page payload is only what this view reads.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../client/src/russell/ClaudeConnection.tsx', async (original) => ({
  ...(await original<object>()),
  ClaudeConnectionPanel: () => null,
}));

import { PeopleAndCapacityView } from '../client/src/russell/People.tsx';

const PAGE = {
  you: { userId: 'usr_nadia', isBrainAdmin: false },
  people: { rows: [], joined: 0, invited: 0 },
  capacity: { eligibleNow: 0, proven: 0, waiting: 0, unavailable: 0, target: null, surfaces: [], historical: [] },
  contributed: { surfaces: [], usable: 0, total: 0 },
  me: { state: 'NOT_STARTED' },
  contract: { mcpUrl: 'https://brain.example/mcp', bootstrapRepository: 'brain-worker-bootstrap' },
};

beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    statusText: '',
    text: async () => JSON.stringify(PAGE),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows that joining and contributing capacity are separate steps', async () => {
  await act(async () => {
    render(<PeopleAndCapacityView />);
  });
  expect(
    await screen.findByText('Joining this Brain and contributing capacity are separate steps.'),
  ).toBeTruthy();
});
