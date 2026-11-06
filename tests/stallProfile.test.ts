/**
 * The stall profile names the code that held the event loop.
 *
 * Labels open across a stall named the three loops that are always open; the
 * profile must name the function that actually ran. Pinned against V8's own
 * sampler on a real busy loop, so a change in the profile format fails here
 * rather than as an empty section of the connection report.
 */
import { Session } from 'node:inspector';
import { describe, expect, it } from 'vitest';
import { summarizeCpuProfile, type CpuProfile } from '../server/db/infra.ts';

function post<T>(session: Session, method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (err, result) => (err ? reject(err) : resolve(result as T)));
  });
}

function holdTheLoopForAWhile(ms: number): number {
  const until = Date.now() + ms;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);
  return n;
}

describe('stall profile', () => {
  it('charges a real busy loop to the function that ran it', async () => {
    const session = new Session();
    session.connect();
    try {
      await post(session, 'Profiler.enable');
      await post(session, 'Profiler.setSamplingInterval', { interval: 1000 });
      await post(session, 'Profiler.start');
      holdTheLoopForAWhile(300);
      const { profile } = await post<{ profile: CpuProfile }>(session, 'Profiler.stop');
      const summary = summarizeCpuProfile(profile);
      expect(summary.sampledMs).toBeGreaterThan(100);
      const top = summary.self[0]!;
      expect(top.frame).toContain('holdTheLoopForAWhile');
      expect(top.ms).toBeGreaterThan(100);
    } finally {
      session.disconnect();
    }
  });

  it('charges library time to the nearest Brain frame above it, and skips idle', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 5] },
        { id: 2, callFrame: { functionName: 'dispatchTick', url: 'file:///app/server/services/dispatch/loop.ts', lineNumber: 99 }, children: [3] },
        { id: 3, callFrame: { functionName: 'parse', url: 'file:///app/node_modules/pg/lib/result.js', lineNumber: 9 }, children: [4] },
        { id: 4, callFrame: { functionName: 'JSON.parse', url: '', lineNumber: -1 } },
        { id: 5, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
      ],
      samples: [4, 4, 3, 5, 5],
      timeDeltas: [0, 10_000, 10_000, 10_000, 500_000],
    };
    const summary = summarizeCpuProfile(profile);
    expect(summary.brain[0]).toEqual({ frame: 'dispatchTick server/services/dispatch/loop.ts:100', ms: 30 });
    expect(summary.self.map((f) => f.frame)).toContain('parse node_modules/pg/lib/result.js:10');
    expect(summary.self.map((f) => f.frame).join()).not.toContain('(idle)');
  });
});
