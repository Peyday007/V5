/**
 * A retry of a slow audit brief joins the build in flight; a failure is not kept.
 *
 * Production, 2026-10-11: briefs took 32–40s server-side on a 68-document layer
 * against a 60s client, and each retry rebuilt the brief the server had just
 * finished and discarded. See `briefOnce` in `server/mcp/researchTools.ts`.
 */
import { describe, expect, it } from 'vitest';
import { briefOnce } from '../server/mcp/researchTools.ts';

describe('the audit brief memo', () => {
  it('builds once for a key, however many callers ask', async () => {
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const build = async (): Promise<string> => {
      builds += 1;
      await gate;
      return 'the brief';
    };
    const first = briefOnce('wki_x:doc_y:t1', build);
    const second = briefOnce('wki_x:doc_y:t1', build);
    release();
    expect(await first).toBe('the brief');
    expect(await second).toBe('the brief');
    // And a retry after it finished reads it rather than building again.
    expect(await briefOnce('wki_x:doc_y:t1', build)).toBe('the brief');
    expect(builds).toBe(1);
    // A changed packet is a different key, built afresh.
    expect(await briefOnce('wki_x:doc_y:t2', build)).toBe('the brief');
    expect(builds).toBe(2);
  });

  it('does not keep a failure, so the next caller tries again', async () => {
    let calls = 0;
    await expect(
      briefOnce('wki_fail:doc:t', async () => {
        calls += 1;
        throw new Error('the predecessor has not run');
      }),
    ).rejects.toThrow('the predecessor has not run');
    expect(
      await briefOnce('wki_fail:doc:t', async () => {
        calls += 1;
        return 'built';
      }),
    ).toBe('built');
    expect(calls).toBe(2);
  });
});
