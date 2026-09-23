// @vitest-environment jsdom
/**
 * The Goals surface in a browser: it renders the server's words, opens a goal
 * in place so its evidence is one click away without leaving the picture
 * across goals, and a decision posts to the route that makes it.
 *
 * The fixture is typed against the server's own shapes, because an untyped
 * fixture passes against payloads the real route can no longer produce (§35).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Goals } from '../client/src/russell/Goals.tsx';
import type { GoalBriefing, GoalView } from '../client/src/lib/goalsApi.ts';

const goal: GoalView = {
  id: 'wst_a',
  title: 'Qualify the transcription opening',
  projectId: 'prj_1',
  projectName: 'Cash Mode 1',
  intent: 'Find out who would pay us for transcription.',
  outcome: 'A qualified opening with a named payer.',
  purpose: 'REVENUE_DIRECT',
  purposeLabel: 'Pursuing money directly',
  owner: { userId: 'usr_1', name: 'Pat' },
  dueAt: null,
  overdue: false,
  commitment: 'NONE',
  commitmentLabel: 'No outside commitment',
  lifecycle: 'ACTIVE',
  lifecycleReason: 'being pursued',
  state: 'IN_PROGRESS',
  stateEvidence: 'MISSION: russell_missions.state = RUNNING',
  authority: { research: 'Russell may research here until 2026-10-06.', commercial: null },
  linked: [
    {
      linkId: 'wsl_1',
      kind: 'MISSION',
      ref: 'rms_1',
      status: 'mission RUNNING',
      state: 'IN_PROGRESS',
      missing: false,
      blocker: null,
      evidence: 'russell_missions.state = RUNNING',
    },
  ],
  sources: [],
  work: [
    { binId: 'bin_1', state: 'READY', priority: 8, attempts: '0/5', heldReason: null, workerOnIt: false, exhausted: false, updatedAt: '2026-09-23T00:00:00.000Z' },
  ],
  dependencies: [],
  dependents: [],
  waiting: { kind: 'CAPACITY', detail: 'bin bin_1 is queued at priority 8', since: null },
  next: { action: 'Brain fires the next free Routine at bin bin_1.', by: 'BRAIN', afterwards: 'The dispatcher does this on its own tick; nothing has to be pressed.' },
  blockers: [],
  decisions: [],
  evidence: [{ kind: 'DOCUMENT', ref: 'doc_1', what: 'a report filed by mission rms_0', evidence: 'russell_missions.document_id' }],
  obligations: [],
  priority: { ownerKey: 'prj_1:usr_1', rank: 0, binPriority: 8, aboveNext: null, belowPrevious: null, lastMove: null },
  pausedAt: null,
  pausedReason: null,
  cancelledAt: null,
  cancelledReason: null,
  archivedAt: null,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
};

const briefing: GoalBriefing = {
  headline: '1 active goal(s) · nothing waits on you.',
  delivered: [{ goalId: 'wst_a', title: goal.title, evidence: 'a report filed by mission rms_0', ref: 'doc_1' }],
  active: [],
  milestones: [],
  agingBlockers: [],
  commitments: [],
  decisions: [],
  counts: { active: 1, paused: 0, cancelled: 0, complete: 0, needsYou: 0, blocked: 0 },
  generatedAt: '2026-09-23T00:00:00.000Z',
};

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push(key);
    const body =
      key === 'GET /api/goals'
        ? { briefing, goals: [goal] }
        : key === 'POST /api/goals/wst_a/pause'
          ? { ok: true, reason: null, consequence: 'On its next tick Brain holds every live bin this goal pursues.' }
          : { error: 'No such route.' };
    const status = body && 'error' in body ? 404 : 200;
    return { ok: status === 200, status, statusText: '', text: async () => JSON.stringify(body) } as Response;
  });
  vi.stubGlobal('prompt', () => 'waiting for the customer to reply');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Goals surface', () => {
  it('leads with the briefing and every goal’s now and next, in the server’s words', async () => {
    await act(async () => {
      render(<Goals />);
    });
    await waitFor(() => expect(screen.getByText(briefing.headline)).toBeTruthy());
    expect(screen.getByText(/bin bin_1 is queued at priority 8/)).toBeTruthy();
    expect(screen.getByText(/Brain fires the next free Routine/)).toBeTruthy();
  });

  it('opens a goal in place to its authority, linked work and evidence', async () => {
    await act(async () => {
      render(<Goals />);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Qualify the transcription opening/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Qualify the transcription opening/ }));
    expect(screen.getByText(/Russell may research here/)).toBeTruthy();
    expect(screen.getByText(/A qualified opening with a named payer/)).toBeTruthy();
    expect(screen.getAllByText('doc_1').length).toBeGreaterThan(0);
    expect(screen.getByText(/priority 8, attempts 0\/5/)).toBeTruthy();
    // The picture across goals is still on the page.
    expect(screen.getByText(briefing.headline)).toBeTruthy();
  });

  it('pauses through the route and shows what the pause will cause', async () => {
    await act(async () => {
      render(<Goals />);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Qualify the transcription opening/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Qualify the transcription opening/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    });
    await waitFor(() => expect(calls).toContain('POST /api/goals/wst_a/pause'));
    await waitFor(() => expect(screen.getByText(/holds every live bin this goal pursues/)).toBeTruthy());
  });
});
