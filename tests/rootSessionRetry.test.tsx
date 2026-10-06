// @vitest-environment jsdom
/**
 * A session check Brain could not answer is not a sign-out.
 *
 * The guard answers `/api/auth/session` with `503 retryable` when its database
 * did not answer — the session was not judged. The root used to read any failed
 * session check as "nobody is signed in" and render the sign-in screen, so every
 * database hiccup showed a signed-in person, or an operator mid-consent in
 * another tab, a door they had already walked through.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Root from '../client/src/Root.tsx';

let answers: Array<{ status: number; body: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/api/auth/session')) {
        const next = answers.shift() ?? { status: 200, body: { user: null } };
        return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the root, when Brain could not check the session', () => {
  it('says Brain is temporarily unavailable, asks again, and never shows the sign-in screen for it', async () => {
    answers = [
      { status: 503, body: { error: 'Brain is temporarily unable to check credentials.', retryable: true } },
      { status: 503, body: { error: 'Brain is temporarily unable to check credentials.', retryable: true } },
      { status: 200, body: { user: null } },
    ];
    render(<Root />);
    expect(await screen.findByText(/temporarily unavailable/i)).toBeTruthy();
    expect(screen.queryByLabelText(/pin/i)).toBeNull();
    // Asked again on its own, and only an actual answer decides.
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    }
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
