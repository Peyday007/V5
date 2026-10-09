// @vitest-environment jsdom
/**
 * The Build page's waiting-for-approval section says what approving does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { BuildView } from '../client/src/russell/Build.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SENTENCE = 'Approve once: Brain carries it live, or names what is blocking it.';

const waitingRequest = {
  id: 'fcr_1',
  projectId: 'prj_1',
  objective: 'Add a hint',
  expectedOutcome: 'A hint',
  nonGoals: [],
  acceptanceConditions: [],
  repository: 'owner/name',
  baseBranch: 'production',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  mutationScope: [],
  environment: 'PRODUCTION',
  riskClass: 'LOW',
  deploymentPolicy: 'NONE',
  rollbackRequirement: 'revert',
  verificationCommands: [],
  state: 'PROPOSED',
  repositoryRoot: null,
  submittedByUserId: null,
  createdAt: '2026-10-09T00:00:00.000Z',
};

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = url.endsWith('/factory/campaigns')
      ? { campaigns: [] }
      : url.endsWith('/factory/change-requests')
        ? { changeRequests: [waitingRequest] }
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

describe('Build waiting-for-approval hint', () => {
  it('is on the screen directly beneath the heading', async () => {
    await act(async () => {
      render(<BuildView projectId="prj_1" />);
    });
    const heading = await screen.findByText('Pinned, waiting for you to approve');
    const hint = await screen.findByText(SENTENCE);
    expect(hint.tagName).toBe('P');
    expect(hint.className).toBe('rs-hint');
    expect(heading.nextElementSibling).toBe(hint);
  });
});
