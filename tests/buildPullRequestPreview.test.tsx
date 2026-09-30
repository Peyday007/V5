// @vitest-environment jsdom
/**
 * The pull-request preview and the throughput report, on a campaign row.
 *
 * Both routes already existed and nothing in any browser called either — §27
 * records what that cost on the local plane: `assemble.ts` renders a pull
 * request's title and body and stops, and "the one person who has to act on
 * it had nowhere to read what they were about to open." This is the screen
 * half of closing that gap.
 *
 * A scripted `fetch`, in `buildRepositories.test.tsx`'s own style: what this
 * holds to is how the two disclosures read, not that a route does the right
 * thing (a server test already proves that).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { BuildView } from '../client/src/russell/Build.tsx';
import type { EvidenceNumber, FactoryCampaign, ThroughputReport } from '../client/src/lib/factoryApi.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];

const PROJECT = 'prj_1';
const CAMPAIGN_ID = 'fcp_a1';
const CAMPAIGNS = `GET /api/projects/${PROJECT}/factory/campaigns`;
const CAMPAIGN_DETAIL = `GET /api/factory/campaigns/${CAMPAIGN_ID}`;
const PULL_REQUEST = `GET /api/factory/campaigns/${CAMPAIGN_ID}/pull-request`;
const THROUGHPUT = `GET /api/factory/campaigns/${CAMPAIGN_ID}/throughput`;

/** Annotated on purpose: a fixture the compiler does not check is a fixture that tests itself. */
function campaign(over: Partial<FactoryCampaign> = {}): FactoryCampaign {
  return {
    id: CAMPAIGN_ID,
    changeRequestId: 'fcr_a1',
    projectId: PROJECT,
    state: 'COMPLETE',
    stageDetail: 'assembled',
    baseSha: 'a'.repeat(40),
    integrationBranch: 'factory/campaign/fcp_a1',
    integrationSha: 'b'.repeat(40),
    laneTarget: 1,
    laneTargetReason: 'test',
    blockerKind: null,
    blockerDetail: null,
    generation: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    reviewRounds: 1,
    prRef: 'factory/campaign/local-1',
    prUrl: null,
    startedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T01:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    executionMode: 'LOCAL',
    ...over,
  };
}

function campaignDetail(over: Record<string, unknown> = {}): unknown {
  return {
    objective: 'Fix the thing.',
    expectedOutcome: 'The thing is fixed.',
    stage: 'COMPLETE',
    stageDetail: 'assembled',
    blocker: null,
    decisionWaiting: null,
    campaign: campaign(),
    activeWork: [],
    units: [{ state: 'INTEGRATED' }],
    review: null,
    openFindings: [],
    metrics: {},
    ...over,
  };
}

function evidence(
  value: number | null,
  ev: EvidenceNumber['evidence'],
  basis: string,
): EvidenceNumber {
  return { value, evidence: ev, basis };
}

function throughputReport(over: Partial<ThroughputReport> = {}): ThroughputReport {
  return {
    campaignId: CAMPAIGN_ID,
    unitsPerHour: evidence(2.5, 'DERIVED', 'merged units divided by wall-clock hours'),
    sessionDurations: {
      total: evidence(0, 'MEASURED', 'sum'),
      samples: evidence(0, 'MEASURED', 'count'),
      average: evidence(null, 'UNKNOWN', 'no session has a recorded duration'),
    },
    queueTime: {
      total: evidence(0, 'MEASURED', 'sum'),
      samples: evidence(0, 'MEASURED', 'count'),
      average: evidence(null, 'UNKNOWN', 'no unit has both events'),
    },
    maxObservedConcurrency: evidence(2, 'MEASURED', 'peak overlap of session intervals'),
    concurrency: {
      observed: evidence(2, 'MEASURED', 'peak overlap of session intervals'),
      declared: evidence(null, 'UNKNOWN', 'no factory_campaigns row was supplied'),
    },
    ceiling: evidence(null, 'UNKNOWN', 'no RATE_LIMITED session has ever been recorded'),
    rateLimited: {
      sessions: evidence(0, 'PROVIDER_ENFORCED', 'count of RATE_LIMITED sessions'),
      deferredMs: evidence(0, 'MEASURED', 'ms deferred'),
    },
    perWorker: [],
    perRole: [],
    perAccountRef: [],
    ...over,
  };
}

function base(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = {
    [`GET /api/projects/${PROJECT}/factory/repositories`]: { body: { repositories: [] } },
    [`GET /api/projects/${PROJECT}/factory/change-requests`]: { body: { changeRequests: [] } },
    [CAMPAIGNS]: { body: { campaigns: [campaign()] } },
    [CAMPAIGN_DETAIL]: { body: campaignDetail() },
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`;
    calls.push(key);
    const found = routes[key];
    const answer: Reply = !found
      ? { status: 404, body: { error: 'No such route.' } }
      : typeof found === 'function'
        ? found()
        : found;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => JSON.stringify(answer.body),
    } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  await act(async () => {
    render(<BuildView projectId={PROJECT} />);
  });
}

function row(): HTMLElement {
  return document.querySelector('.rs-build-campaign') as HTMLElement;
}

/* -------------------------------------------------------------------------- */

describe('the pull-request preview', () => {
  it('does not fetch it before the disclosure is opened, and fetches it exactly once when it is', async () => {
    base({ [PULL_REQUEST]: { body: { title: 'Fix the thing', body: 'A patch that fixes the thing.' } } });
    await mount();
    await waitFor(() => expect(row()).toBeTruthy());
    expect(calls).not.toContain(PULL_REQUEST);

    await act(async () => {
      fireEvent.click(
        within(row()).getByRole('button', { name: /Read the pull request it would open/ }),
      );
    });
    await waitFor(() => expect(within(row()).getByText('Fix the thing')).toBeTruthy());
    expect(within(row()).getByText('A patch that fixes the thing.')).toBeTruthy();
    expect(calls.filter((one) => one === PULL_REQUEST)).toHaveLength(1);

    // Opening it again does not fetch a second time.
    await act(async () => {
      fireEvent.click(
        within(row()).getByRole('button', { name: /Hide the pull request it would open/ }),
      );
    });
    await act(async () => {
      fireEvent.click(
        within(row()).getByRole('button', { name: /Read the pull request it would open/ }),
      );
    });
    expect(calls.filter((one) => one === PULL_REQUEST)).toHaveLength(1);
  });

  it('says plainly that none has been rendered, and renders no empty body', async () => {
    base({ [PULL_REQUEST]: { body: { title: null, body: null } } });
    await mount();
    await waitFor(() => expect(row()).toBeTruthy());
    await act(async () => {
      fireEvent.click(
        within(row()).getByRole('button', { name: /Read the pull request it would open/ }),
      );
    });
    await waitFor(() =>
      expect(within(row()).getByText(/No pull request has been rendered yet/)).toBeTruthy(),
    );
    expect(row().querySelector('.rs-build-pr-body')).toBeNull();
    expect(row().querySelector('pre')).toBeNull();
  });

  it('renders the server refusal verbatim on a failed read', async () => {
    base({ [PULL_REQUEST]: { status: 500, body: { error: 'Something Brain could not read.' } } });
    await mount();
    await waitFor(() => expect(row()).toBeTruthy());
    await act(async () => {
      fireEvent.click(
        within(row()).getByRole('button', { name: /Read the pull request it would open/ }),
      );
    });
    await waitFor(() =>
      expect(within(row()).getByText(/Something Brain could not read/)).toBeTruthy(),
    );
  });
});

describe('the throughput report', () => {
  it('does not fetch it before opened, and lists every figure with its evidence class', async () => {
    base({ [THROUGHPUT]: { body: throughputReport() } });
    await mount();
    await waitFor(() => expect(row()).toBeTruthy());
    expect(calls).not.toContain(THROUGHPUT);

    await act(async () => {
      fireEvent.click(within(row()).getByRole('button', { name: /How fast it ran/ }));
    });
    await waitFor(() => expect(within(row()).getByText('Units per hour')).toBeTruthy());
    expect(calls.filter((one) => one === THROUGHPUT)).toHaveLength(1);
    // The observed peak, with its evidence class beside it.
    const peakRow = within(row())
      .getByText('Peak concurrency observed')
      .closest('li') as HTMLElement;
    expect(within(peakRow).getByText(/MEASURED/)).toBeTruthy();
  });

  it('renders a null figure as "not measured" and its basis, never 0 or a dash', async () => {
    base({ [THROUGHPUT]: { body: throughputReport() } });
    await mount();
    await waitFor(() => expect(row()).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(row()).getByRole('button', { name: /How fast it ran/ }));
    });
    await waitFor(() => expect(within(row()).getByText('Concurrency declared')).toBeTruthy());
    const declaredRow = within(row())
      .getByText('Concurrency declared')
      .closest('li') as HTMLElement;
    expect(within(declaredRow).getByText(/not measured/)).toBeTruthy();
    expect(within(declaredRow).getByText(/no factory_campaigns row was supplied/)).toBeTruthy();
    // Exactly the words, the evidence class and the basis: nothing else, so no
    // zero and no dash can be present in place of the missing figure.
    expect(declaredRow.textContent).toBe(
      'Concurrency declared' +
        'not measured · UNKNOWN' +
        'no factory_campaigns row was supplied',
    );
    const value = declaredRow.querySelector('.rs-ready-state') as HTMLElement;
    expect(value.firstChild?.textContent).toBe('not measured');
  });

  it('opening the throughput disclosure does not fetch the pull request, and vice versa', async () => {
    base({
      [PULL_REQUEST]: { body: { title: 'Fix the thing', body: 'A patch.' } },
      [THROUGHPUT]: { body: throughputReport() },
    });
    await mount();
    await waitFor(() => expect(row()).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(row()).getByRole('button', { name: /How fast it ran/ }));
    });
    await waitFor(() => expect(calls).toContain(THROUGHPUT));
    expect(calls).not.toContain(PULL_REQUEST);
  });
});
