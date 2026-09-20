/**
 * What the release gate says when nothing answered it.
 *
 * This exists because the sentence was wrong, twice, in opposite directions.
 * First it was a bare `fetch failed` naming neither the call nor the wait, and
 * six deploys read as one unexplained condition. Then §27 added a fifteen-
 * minute bound and the sentence started asserting that fifteen minutes had
 * passed — and `AbortSignal.timeout` does not raise undici's `headersTimeout`,
 * so nothing ever waited that long. Measured on Node 22.22.2 against a server
 * that accepts and never replies, `AbortSignal.timeout(900_000)` throws after
 * **300.9s** with `UND_ERR_HEADERS_TIMEOUT`.
 *
 * A diagnostic that confidently states a wait nobody waited is worse than one
 * that says nothing, because it sends the next reader looking for a fifteen-
 * minute operation. So the only number the sentence may assert is the one that
 * was observed, and which limit fired is read from the cause rather than
 * assumed.
 */
import { describe, expect, it } from 'vitest';
import { describeTimeout } from '../scripts/mcpModernClient.ts';

describe('the sentence a stalled hosted verification prints', () => {
  it('reports the elapsed time that was measured, never the configured bound', () => {
    const said = describeTimeout(
      'tools/call',
      { name: 'brain_submit_audit' },
      319_600,
      new Error('fetch failed'),
      'UND_ERR_HEADERS_TIMEOUT',
    );
    expect(said).toContain('319.6s');
    // The production reading of 2026-09-20, and the number it must not claim.
    expect(said).not.toContain('within 900s');
  });

  it('names undici as what ended it, and says the client bound was not reached', () => {
    const said = describeTimeout(
      'tools/call',
      { name: 'brain_submit_synthesis' },
      335_100,
      new Error('fetch failed'),
      'UND_ERR_HEADERS_TIMEOUT',
    );
    expect(said).toContain('335.1s');
    expect(said).toMatch(/header wait/);
    expect(said).toMatch(/never reached/);
  });

  it('says the opposite when this client is genuinely what gave up', () => {
    const said = describeTimeout(
      'tools/call',
      { name: 'brain_submit_audit' },
      900_100,
      new Error('The operation was aborted due to timeout'),
      'TimeoutError',
    );
    expect(said).toContain('900.1s');
    expect(said).toMatch(/This client's own 900s limit ended it/);
    expect(said).not.toMatch(/never reached/);
  });

  it('still carries the method and the tool, because six runs read alike without them', () => {
    const said = describeTimeout(
      'tools/call',
      { name: 'brain_submit_audit' },
      1_000,
      new Error('socket hang up'),
      'ECONNRESET',
    );
    expect(said).toContain('tools/call (brain_submit_audit)');
    expect(said).toContain('ECONNRESET');
    // An unrecognised cause claims nothing about which limit fired.
    expect(said).not.toMatch(/limit/);
  });

  it('says the request was not refused, because an unknown outcome is not a denial', () => {
    const said = describeTimeout('tools/list', {}, 5_000, new Error('fetch failed'), undefined);
    expect(said).toContain('The request was not refused');
    expect(said).toContain('tools/list');
  });
});

describe('the release gate and the MCP client print one sentence', () => {
  /*
   * They were two printers of one sentence and drifted into being wrong in
   * both places at once: `verify-hosted.ts` and `mcpModernClient.ts` each had
   * their own `did not answer within ${REQUEST_TIMEOUT_MS}s`, and both were
   * false for the same reason. A rule applied by one of two readers is worse
   * than none, and so is a sentence composed by one of two printers.
   */
  it('has exactly one place that composes it', async () => {
    const fs = await import('node:fs/promises');
    const gate = await fs.readFile('scripts/verify-hosted.ts', 'utf8');
    expect(gate).toContain('describeTimeout(');
    expect(gate).not.toMatch(/did not answer within/);
  });

  it('lets the gate name its own bound, since the two need not be equal', () => {
    const said = describeTimeout(
      'POST /mcp',
      {},
      120_000,
      new Error('The operation was aborted due to timeout'),
      'TimeoutError',
      120_000,
    );
    expect(said).toMatch(/own 120s limit ended it/);
  });
});
