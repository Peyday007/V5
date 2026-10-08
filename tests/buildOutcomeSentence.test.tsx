// @vitest-environment jsdom
/**
 * The Build page's campaigns section says what an approved objective ends as.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { BuildView } from '../client/src/russell/Build.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = 'prj_1';
const SENTENCE = 'Approved objectives finish live and verified, or name exactly what is blocking them.';

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = url.endsWith('/factory/campaigns')
      ? { campaigns: [] }
      : url.endsWith('/factory/change-requests')
        ? { changeRequests: [] }
        : url.endsWith('/factory/repositories')
          ? {
              repositories: [],
              allocation: { windowHours: 24, reportExpiresAfterHours: 6, canReport: true, repositories: [] },
            }
          : {};
    return { ok: true, status: 200, statusText: '', text: async () => JSON.stringify(body) } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Build campaigns outcome sentence', () => {
  it('is on the screen beneath the heading with an empty campaign list', async () => {
    await act(async () => {
      render(<BuildView projectId={PROJECT} />);
    });
    const heading = await screen.findByText('What the factory is doing');
    const hint = await screen.findByText(SENTENCE);
    expect(hint.tagName).toBe('P');
    expect(hint.className).toBe('rs-hint');
    expect(heading.nextElementSibling).toBe(hint);
  });
});
