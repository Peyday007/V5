// @vitest-environment jsdom
/**
 * The Build page's repositories card says who approves a release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { BuildView } from '../client/src/russell/Build.tsx';
import type { RepositoryOnboarding } from '../client/src/lib/factoryApi.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SENTENCE = "Each repository is released only under its owner's approval.";

const repository: RepositoryOnboarding = {
  grantId: 'brain-worker-bootstrap',
  remote: 'https://github.com/Peyday007/brain-worker-bootstrap',
  repositoryId: 'Peyday007/brain-worker-bootstrap',
  description: 'The minimal checkout unattended Routines mount.',
  defaultBranch: 'main',
  mayOpenPullRequest: true,
  workerName: 'factory-brain-worker-bootstrap',
  workerId: null,
  scopesCorrect: false,
  routedFamilies: [],
  routedRepositories: [],
  surfaces: [],
  accountsServing: 0,
  eligibleSurfaces: 0,
  provenSurfaces: 0,
  summary: 'No Factory worker is registered for this repository in this project.',
  contributedSurfaces: [],
  connectorPath: '/mcp/factory',
  boundary: null,
  readiness: 'NOT_ONBOARDED',
  remaining: ['Onboard this repository, which registers a worker for it and issues one invitation.'],
  waiting: 0,
};

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = url.endsWith('/factory/campaigns')
      ? { campaigns: [] }
      : url.endsWith('/factory/change-requests')
        ? { changeRequests: [] }
        : url.endsWith('/factory/repositories')
          ? {
              repositories: [repository],
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

describe('Build repositories release sentence', () => {
  it('is on the screen directly beneath the Repositories heading', async () => {
    await act(async () => {
      render(<BuildView projectId="prj_1" />);
    });
    const heading = await screen.findByRole('heading', { name: 'Repositories' });
    const hint = await screen.findByText(SENTENCE);
    expect(hint.tagName).toBe('P');
    expect(hint.className).toBe('rs-hint');
    expect(heading.nextElementSibling).toBe(hint);
  });
});
