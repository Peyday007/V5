// @vitest-environment jsdom
/**
 * The capacity block on the Fleet page, in a browser.
 *
 * A server test cannot see this, and the two things worth asserting here are both
 * things a server test would have passed while the screen was wrong:
 *
 *   * **A null reading must read as "we could not tell", never as zeroes.** The
 *     server returns `capacity: null` when a reading could not be taken, and a
 *     block of zeroes says *there is no capacity* when it means *Brain cannot
 *     say*. Those are opposite facts and §29 records what it costs when a screen
 *     asserts the wrong one: a person stops believing the rest of the page.
 *   * **An empty user-action list must be a sentence, not an empty heading.** An
 *     absent list reads as a section that failed to render; the sentence is the
 *     answer, and it is usually the right one.
 *
 * The fixture is an annotated `FleetReading`, so the compiler checks it against
 * the real route's contract. §35 records what an un-annotated fixture costs: a
 * bare object literal goes on passing after the server's shape grows, until a
 * component reads a field that is not there.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetCentre } from '../client/src/russell/Fleet.tsx';
import type { FleetReading } from '../client/src/lib/russellApi.ts';

function reading(capacity: FleetReading['capacity']): FleetReading {
  return {
    provisioned: { value: 2, evidence: 'MEASURED', explanation: 'somebody configured two' },
    usable: { value: 1, evidence: 'MEASURED', explanation: 'one surface can be fired' },
    measured: { value: 3, evidence: 'MEASURED', explanation: 'three activations observed' },
    surfaces: [],
    accounts: [],
    active: 1,
    available: 0,
    cooling: 0,
    unhealthy: 0,
    backlog: { ready: 2, leased: 1, needsHuman: 0 },
    fits: null,
    bottleneck: 'NONE',
    bottleneckExplanation: 'Nothing is currently limiting throughput that Brain can see.',
    ifWeAddedCapacity: 'The capacity block below reports what has been demonstrated.',
    capacity,
    policy: { target: 2, paused: false, boostTarget: null, boostUntil: null, version: 4 },
    recentPolicyChanges: [],
  };
}

const FULL: NonNullable<FleetReading['capacity']> = {
  currentConfiguration: [
    { line: 'Routine definitions registered with Brain: ≥10 — MEASURED', evidence: 'ten registered' },
    { line: 'Active concurrency observed: ≥3 — MEASURED', evidence: 'three overlapped' },
  ],
  proven: [
    {
      label: 'Highest verified productive count',
      value: '≥2 — MEASURED',
      evidence: 'two overlapping sessions each produced distinct validated work',
    },
    {
      label: 'Provider-enforced ceiling',
      value: 'UNKNOWN',
      evidence: 'no provider refusal is recorded, so no ceiling has been observed',
    },
  ],
  mainBottleneck: {
    stage: 'LOCAL_TARGET',
    evidenceFor: 'two intents are held back by a target Brain itself configured.',
    evidenceAgainst: 'the target may be the right number and the work may not benefit from more.',
  },
  brainIsDoingNow: ['about to start CONCURRENCY_STAIRCASE: whether productive concurrency exceeds 2.'],
  youNeedToDo: [],
  nextExperiment: {
    change: 'fleet concurrency ceiling: 2 → 3',
    hypothesis: '3 concurrent sessions will each produce distinct validated work.',
    successEvidence: 'productive overlap reaching 3 with no provider refusal.',
    stopCondition: 'any provider refusal rolls the policy back to the recorded version.',
    resolves: 'whether productive concurrency exceeds 2.',
  },
  remainingUnknowns: ['SUSTAINABLE_CAPACITY — a level that stayed healthy: nothing has spanned the window.'],
};

function serve(capacity: FleetReading['capacity']): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/fleet')) {
      return new Response(JSON.stringify({ fleet: reading(capacity) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the capacity block on the Fleet page', () => {
  it('prints every proven figure with its evidence label and its own explanation', async () => {
    serve(FULL);
    render(<FleetCentre projectId="prj_1" />);

    await waitFor(() => expect(screen.getByText('Routine capacity')).toBeTruthy());

    // The bound and the evidence class travel with the number, never separately.
    expect(screen.getByText('≥2 — MEASURED')).toBeTruthy();
    // And an unestablished dimension says UNKNOWN rather than showing a zero.
    expect(screen.getByText('UNKNOWN')).toBeTruthy();
    expect(
      screen.getByText(/no provider refusal is recorded, so no ceiling has been observed/),
    ).toBeTruthy();

    // The diagnosis is never printed as a certainty: the case against it is on
    // the page, not in a tooltip.
    expect(screen.getByText(/Against: the target may be the right number/)).toBeTruthy();

    // Brain's own work and the next experiment are both shown.
    expect(screen.getByText(/about to start CONCURRENCY_STAIRCASE/)).toBeTruthy();
    expect(screen.getByText(/fleet concurrency ceiling: 2 → 3/)).toBeTruthy();
    expect(screen.getByText(/rolls the policy back to the recorded version/)).toBeTruthy();
  });

  it('says in words that nothing is needed, rather than leaving an empty heading', async () => {
    serve(FULL);
    render(<FleetCentre projectId="prj_1" />);
    await waitFor(() => expect(screen.getByText('You need to do')).toBeTruthy());
    expect(screen.getByText('No user action is needed for the next experiment.')).toBeTruthy();
  });

  it('surfaces a user action verbatim when there is one, under its own heading', async () => {
    const action =
      'Create one additional Routine on an existing capacity account, leave it on no schedule, then ' +
      'register it with `fleet register-routine`. Brain cannot create a Routine.';
    serve({ ...FULL, youNeedToDo: [action] });
    render(<FleetCentre projectId="prj_1" />);
    await waitFor(() => expect(screen.getByText('You need to do')).toBeTruthy());
    // The server's sentence, rendered rather than paraphrased.
    expect(screen.getByText(action)).toBeTruthy();
    expect(screen.queryByText('No user action is needed for the next experiment.')).toBeNull();
  });

  it('a null reading says Brain could not tell, and shows no zeroes', async () => {
    serve(null);
    render(<FleetCentre projectId="prj_1" />);
    await waitFor(() => expect(screen.getByText('Routine capacity')).toBeTruthy());

    expect(screen.getByText(/A capacity reading could not be taken just now/)).toBeTruthy();
    // The distinction is the whole point of the branch: a fleet with no capacity
    // and a Brain that cannot say are opposite facts.
    expect(screen.getByText(/That is not a fleet with no\s+capacity/)).toBeTruthy();
    // And none of the block's own headings are drawn, so nothing implies a
    // measured zero.
    expect(screen.queryByText('What is proven')).toBeNull();
    expect(screen.queryByText('You need to do')).toBeNull();
  });
});
