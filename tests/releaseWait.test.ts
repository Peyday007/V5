/**
 * The merge hold in `scripts/release-wait.ts`: a merge waits while a Deploy of
 * the canonical tip is in its gate, and goes otherwise. The forge is a stub.
 */
import { describe, expect, it } from 'vitest';
import { reachedFly, readLane, releaseLane, waitForReleaseLane, type GitHubGet, type LaneJob } from '../scripts/release-wait.ts';

const REPO = 'owner/repo';
const TIP = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const gating: LaneJob[] = [
  { name: 'Typecheck and tests', status: 'in_progress', steps: [{ name: 'Tests', status: 'in_progress' }] },
  { name: 'Deploy to Fly', status: 'queued', steps: [] },
];
const preflight: LaneJob[] = [
  { name: 'Typecheck and tests', status: 'completed' },
  {
    name: 'Deploy to Fly',
    status: 'in_progress',
    steps: [
      { name: 'Pre-flight against the cloud database', status: 'in_progress' },
      { name: 'Deploy', status: 'pending' },
    ],
  },
];
const flying: LaneJob[] = [
  { name: 'Typecheck and tests', status: 'completed' },
  {
    name: 'Deploy to Fly',
    status: 'in_progress',
    steps: [
      { name: 'The ref must still be the canonical tip, now', status: 'completed' },
      { name: 'Deploy', status: 'in_progress' },
    ],
  },
];

function forge(runs: { id: number; status: string; head_sha: string; jobs: LaneJob[] }[], tip = TIP): GitHubGet {
  return async (path) => {
    if (path === `/repos/${REPO}/branches/production`) return { commit: { sha: tip } };
    if (path.startsWith(`/repos/${REPO}/actions/workflows/deploy.yml/runs`)) {
      return { workflow_runs: runs.map(({ jobs: _jobs, ...run }) => ({ ...run, head_branch: 'production' })) };
    }
    const id = Number(/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
    const run = runs.find((r) => r.id === id);
    return run ? { jobs: run.jobs } : null;
  };
}

describe('releaseLane', () => {
  it('waits while a Deploy of the tip is in its test gate or pre-flight', async () => {
    expect((await readLane(forge([{ id: 1, status: 'in_progress', head_sha: TIP, jobs: gating }]), REPO, 'production'))?.decision).toBe('wait');
    expect((await readLane(forge([{ id: 2, status: 'in_progress', head_sha: TIP, jobs: preflight }]), REPO, 'production'))?.decision).toBe('wait');
    expect((await readLane(forge([{ id: 3, status: 'queued', head_sha: TIP, jobs: [] }]), REPO, 'production'))?.holding).toEqual([3]);
  });

  it('goes once the run has reached Fly, when it is over, or when nothing is in flight', async () => {
    expect((await readLane(forge([{ id: 1, status: 'in_progress', head_sha: TIP, jobs: flying }]), REPO, 'production'))?.decision).toBe('go');
    expect((await readLane(forge([{ id: 1, status: 'completed', head_sha: TIP, jobs: gating }]), REPO, 'production'))?.decision).toBe('go');
    expect((await readLane(forge([]), REPO, 'production'))?.decision).toBe('go');
  });

  it('goes past a run for an older commit: it is already superseded', async () => {
    expect((await readLane(forge([{ id: 1, status: 'in_progress', head_sha: OLD, jobs: gating }]), REPO, 'production'))?.decision).toBe('go');
  });

  it('reads reaching Fly from the Deploy step or a finished Fly job', () => {
    expect(reachedFly(flying)).toBe(true);
    expect(reachedFly(preflight)).toBe(false);
    expect(reachedFly([{ name: 'Deploy to Fly', status: 'completed', steps: [] }])).toBe(true);
    expect(releaseLane({ branch: 'production', tip: TIP, runs: [{ run: { id: 9, status: 'in_progress', head_branch: 'feature', head_sha: TIP }, jobs: gating }] }).decision).toBe('go');
  });
});

describe('waitForReleaseLane', () => {
  it('holds until the run reaches Fly, then goes — and cancels nothing', async () => {
    let clock = 0;
    let polls = 0;
    const calls: string[] = [];
    const get: GitHubGet = async (path) => {
      calls.push(path);
      return forge([{ id: 1, status: 'in_progress', head_sha: TIP, jobs: polls >= 2 ? flying : gating }])(path);
    };
    const lines: string[] = [];
    const result = await waitForReleaseLane({
      get,
      repo: REPO,
      branch: 'production',
      log: (line) => lines.push(line),
      now: () => clock,
      sleep: async (ms) => {
        polls += 1;
        clock += ms;
      },
    });
    expect(result).toBe('go');
    expect(polls).toBe(2);
    expect(lines.filter((l) => l.startsWith('RELEASE-LANE: WAIT'))).toHaveLength(2);
    expect(calls.every((path) => !/cancel/.test(path))).toBe(true);
  });

  it('is bounded: it stops waiting at the timeout', async () => {
    let clock = 0;
    const result = await waitForReleaseLane({
      get: forge([{ id: 1, status: 'in_progress', head_sha: TIP, jobs: gating }]),
      repo: REPO,
      branch: 'production',
      log: () => {},
      timeoutMs: 75 * 60_000,
      pollMs: 30_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result).toBe('timeout');
    expect(clock).toBe(75 * 60_000);
  });

  it('fails open when the Actions API cannot be read', async () => {
    expect(await waitForReleaseLane({ get: async () => null, repo: REPO, branch: 'production', log: () => {} })).toBe('unreadable');
  });
});
