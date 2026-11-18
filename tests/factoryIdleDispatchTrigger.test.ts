/**
 * The factory tick asks for a dispatch pass when the line reads unexplained idle.
 *
 * Production 2026-11-18 (operator deficiency RECURRING_OPERATIONAL_FAILURE
 * aded8afab9854a88): the FACTORY pool read "1 piece(s) of executable work and 1
 * free surface(s), and nothing is running or arriving. That is a fault, not a
 * wait." The 20-second factory tick asked the dispatcher for a pass only when
 * it had just created a bin, so a READY bin that already existed — re-armed,
 * revived, or stranded by a wake that never came — sat beside a free surface.
 * These tests reproduce that class: no bin created on this tick, the line's
 * reading saying the idle is unexplained, and the tick must request a pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const linePass = vi.hoisted(() => ({
  unexplainedIdle: true,
}));
const dispatchSpy = vi.hoisted(() => vi.fn(async (_options: unknown) => true));

vi.mock('../server/services/factory/line.ts', () => ({
  runLinePass: vi.fn(async () => ({
    admission: { admitted: [] },
    reading: { unexplainedIdle: linePass.unexplainedIdle },
  })),
}));
vi.mock('../server/services/dispatch/loop.ts', () => ({
  dispatchTickIfIdle: dispatchSpy,
}));
vi.mock('../server/services/factory/program/loop.ts', () => ({
  tickAllProgramsIfDue: vi.fn(async () => undefined),
}));

import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  shouldDispatchAfterTick,
  startFactoryRemoteLoop,
  stopFactoryRemoteLoop,
} from '../server/services/factory/remoteLoop.ts';

describe('shouldDispatchAfterTick', () => {
  it('asks for a pass when the line reads unexplained idle and nothing was created this tick', () => {
    expect(shouldDispatchAfterTick([], { unexplainedIdle: true })).toBe(true);
    expect(shouldDispatchAfterTick([{ created: [] }], { unexplainedIdle: true })).toBe(true);
  });

  it('asks for a pass when this tick created a bin, whatever the line reads', () => {
    expect(shouldDispatchAfterTick([{ created: ['bin_x'] }], { unexplainedIdle: false })).toBe(true);
    expect(shouldDispatchAfterTick([{ created: ['bin_x'] }], null)).toBe(true);
  });

  it('does not ask when nothing was created and the idle is explained or unread', () => {
    expect(shouldDispatchAfterTick([{ created: [] }], { unexplainedIdle: false })).toBe(false);
    expect(shouldDispatchAfterTick([], null)).toBe(false);
  });
});

describe('factory remote loop on unexplained idle', () => {
  let project: TestProject;

  beforeEach(async () => {
    project = await freshProject();
    dispatchSpy.mockClear();
  });

  afterEach(async () => {
    stopFactoryRemoteLoop();
    await teardown();
  });

  it('dispatches although no campaign tick created a bin (the recorded failure class)', async () => {
    linePass.unexplainedIdle = true;
    startFactoryRemoteLoop(25);
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalled(), { timeout: 5_000, interval: 25 });
    expect(dispatchSpy).toHaveBeenCalledWith({});
  });

  it('stays quiet when the line explains its idle and nothing was created', async () => {
    linePass.unexplainedIdle = false;
    const { runLinePass } = await import('../server/services/factory/line.ts');
    const passes = vi.mocked(runLinePass);
    passes.mockClear();
    startFactoryRemoteLoop(25);
    await vi.waitFor(() => expect(passes.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 5_000,
      interval: 25,
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
