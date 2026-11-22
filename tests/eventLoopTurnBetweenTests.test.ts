/**
 * Every test starts on a fresh turn of the event loop.
 *
 * vitest runs one file's tests as a single promise chain, and on SQLite the
 * whole repository layer is synchronous, so a file whose tests never wait on
 * real I/O never returns to the event loop at all: 121 tests of
 * `packet.test.ts` ran 73 s without a single macrotask (measured with an
 * interval timer, 2026-11-22). vitest's worker talks to the main process over
 * IPC, and the reply to its `onTaskUpdate` call is a macrotask. Once a stretch
 * like that passes 60 s, the call's own timeout timer fires before the reply is
 * read, `Timeout calling "onTaskUpdate"` rejects, every later update chains on
 * that rejection, and the file never reports — Deploy run 45016674213 failed
 * exactly so, twice, with every test in the file passing.
 *
 * `tests/setup.ts` gives each test a turn before it starts. This proves it the
 * only way that cannot depend on timing: a timer due immediately must have run
 * by the next test, with nothing in between that waits on I/O.
 */
import { describe, expect, it } from 'vitest';

describe('a file whose tests never wait on I/O', () => {
  let timerRan = false;
  let immediateRan = false;

  it('schedules a timer and an I/O-phase callback, then finishes without waiting', () => {
    setTimeout(() => {
      timerRan = true;
    }, 0);
    setImmediate(() => {
      immediateRan = true;
    });
    expect(timerRan).toBe(false);
  });

  it('still sees both run before it starts', () => {
    expect(immediateRan).toBe(true);
    expect(timerRan).toBe(true);
  });
});
