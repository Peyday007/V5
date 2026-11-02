// @vitest-environment jsdom
/**
 * The Build campaign row's two readers, in a browser: the pull request a
 * campaign would open, and how fast it ran. Both fetch only when opened, and an
 * unmeasured figure says so rather than reading as zero.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { BuildView } from '../client/src/russell/Build.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = 'prj_1';
const CAMPAIGN = 'fcp_1';
const PR = `GET /api/factory/campaigns/${CAMPAIGN}/pull-request`;
const SPEED = `GET /api/factory/campaigns/${CAMPAIGN}/throughput`;

let routes: Record<string, unknown> = {};
let calls: string[] = [];

const campaign = {
  id: CAMPAIGN,
  changeRequestId: 'cr_1',
  projectId: PROJECT,
  state: 'AWAITING_RELEASE',
  stageDetail: null,
  baseSha: 'a'.repeat(40),
  integrationBranch: 'factory/campaign/fcp_1',
  integrationSha: 'b'.repeat(40),
  laneTarget: 1,
  laneTargetReason: 'test',
  blockerKind: null,
  blockerDetail: null,
  generation: 1,
  leaseOwner: null,
  leaseExpiresAt: null,
  reviewRounds: 1,
  prRef: 'factory/campaign/fcp_1',
  prUrl: null,
  startedAt: '2026-11-01T00:00:00.000Z',
  finishedAt: null,
};

const num = (value: number | null, evidence: string, basis: string) => ({ value, evidence, basis });

beforeEach(() => {
  calls = [];
  routes = {
    [`GET /api/projects/${PROJECT}/factory/repositories`]: {
      repositories: [],
      allocation: { windowHours: 24, reportExpiresAfterHours: 6, canReport: true, repositories: [] },
    },
    [`GET /api/projects/${PROJECT}/factory/campaigns`]: { campaigns: [campaign] },
    [`GET /api/projects/${PROJECT}/factory/change-requests`]: { changeRequests: [] },
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`;
    calls.push(key);
    const found = routes[key];
    const status = found === undefined ? 404 : 200;
    return {
      ok: status === 200,
      status,
      statusText: '',
      text: async () => JSON.stringify(found ?? { error: 'No such route.' }),
    } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(label: string): Promise<void> {
  const summary = await screen.findByText(label);
  const details = summary.closest('details') as HTMLDetailsElement;
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    render(<BuildView projectId={PROJECT} />);
  });
}

describe('the campaign row readers', () => {
  it('requests the pull request only when opened, once, and shows title and body', async () => {
    routes[PR] = { title: 'Add the thing', body: 'Line one\nLine two' };
    await mount();
    await screen.findByText('Read the pull request it would open');
    expect(calls).not.toContain(PR);
    await open('Read the pull request it would open');
    await waitFor(() => expect(screen.getByText('Add the thing')).toBeTruthy());
    expect(document.querySelector('pre')?.textContent).toBe('Line one\nLine two');
    expect(calls.filter((c) => c === PR)).toHaveLength(1);
    expect(calls).not.toContain(SPEED);
  });

  it('says plainly when no pull request has been rendered', async () => {
    routes[PR] = { title: null, body: null };
    await mount();
    await open('Read the pull request it would open');
    await waitFor(() => expect(screen.getByText(/No pull request has been rendered/)).toBeTruthy());
    expect(document.querySelector('pre')).toBeNull();
  });

  it('lists each figure with its evidence class and never shows an unmeasured one as zero', async () => {
    routes[SPEED] = {
      campaignId: CAMPAIGN,
      unitsPerHour: num(2.5, 'DERIVED', '5 units over 2 hours'),
      maxObservedConcurrency: num(3, 'MEASURED', 'session sweep'),
      concurrency: {
        observed: num(null, 'UNKNOWN', 'no session has ever run'),
        declared: num(4, 'DECLARED', 'lane target'),
      },
    };
    await mount();
    await screen.findByText('How fast it ran');
    expect(calls).not.toContain(SPEED);
    await open('How fast it ran');
    await waitFor(() => expect(screen.getByText(/Units per hour/)).toBeTruthy());
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Units per hour: 2\.5 \(derived\)/);
    expect(text).toMatch(/Most sessions at once: 3 \(measured\)/);
    expect(text).toMatch(/Concurrency declared: 4 \(declared\)/);
    expect(text).toMatch(/Concurrency observed: not measured \(unknown\) — no session has ever run/);
    expect(text).not.toMatch(/observed: 0/);
    expect(calls.filter((c) => c === SPEED)).toHaveLength(1);
  });
});
