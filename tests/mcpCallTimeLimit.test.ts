/**
 * A tool call that never returns must not lock its credential out.
 *
 * Production, 2026-11-02 ~18:45 UTC: every MCP call on the owner's credential
 * was refused "Too many calls in flight for this credential" for minutes with
 * no worker running. A slot was given back only when a tool returned, and
 * eight calls that never returned held all eight slots until a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audits: { result: string; metadata: Record<string, unknown> }[] = [];
const hang = { name: 'test_hang', plane: 'WORKLOAD', run: () => new Promise(() => {}) };
const quick = {
  name: 'test_quick',
  plane: 'WORKLOAD',
  run: async () => ({ value: { ok: true }, projectId: null }),
};

vi.mock('../server/mcp/tools.ts', () => ({
  findTool: (name: string) => (name === hang.name ? hang : name === quick.name ? quick : null),
}));
vi.mock('../server/repos/identity.ts', () => ({
  recordIdentityEvent: async (event: { result: string; metadata: Record<string, unknown> }) => {
    audits.push(event);
  },
}));

const { callTool, setToolCallTimeoutForTests } = await import('../server/mcp/execute.ts');
const limits = await import('../server/mcp/limits.ts');

function call(toolName: string) {
  return callTool({
    toolName,
    args: {},
    principal: { type: 'WORKER', id: 'wrk_1', credentialId: 'cred_1' } as never,
    requestId: `req_${Math.random()}`,
    clientName: null,
    protocolVersion: '2025-11-25',
    userAgent: null,
    remoteAddr: null,
  });
}

describe('an MCP call that never returns', () => {
  beforeEach(() => {
    limits.resetRateLimits();
    audits.length = 0;
    setToolCallTimeoutForTests(20);
  });
  afterEach(() => setToolCallTimeoutForTests(null));

  it('is answered at its time limit as retryable, frees its slot, and is recorded UNKNOWN', async () => {
    // More hung calls than the credential has slots.
    const hung = await Promise.all(
      Array.from({ length: limits.MAX_CONCURRENT_PER_CREDENTIAL + 2 }, () => call(hang.name)),
    );
    for (const { result } of hung) {
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: Record<string, unknown> }).error;
      // Either the time limit answered it, or it found the slots full — never a hang.
      expect(['TIMEOUT_OUTCOME_UNKNOWN', undefined]).toContain(error['kind']);
    }
    expect(
      hung.filter(({ result }) =>
        (result.structuredContent as { error: { retryable?: boolean } }).error.retryable === true,
      ).length,
    ).toBe(limits.MAX_CONCURRENT_PER_CREDENTIAL);

    // The credential is not locked out: the next call goes through.
    const after = await call(quick.name);
    expect(after.result.isError).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const unknown = audits.filter((a) => a.result === 'UNKNOWN');
    expect(unknown).toHaveLength(limits.MAX_CONCURRENT_PER_CREDENTIAL);
    expect(unknown[0]?.metadata['category']).toBe('TIMEOUT_OUTCOME_UNKNOWN');
    expect(audits.some((a) => a.result === 'FAILED')).toBe(false);
  });
});

describe('a leaked slot', () => {
  beforeEach(() => limits.resetRateLimits());

  it('expires on its own after the maximum age, so it can never lock a credential permanently', () => {
    const t0 = 1_000_000;
    // Taken and never released.
    for (let i = 0; i < limits.MAX_CONCURRENT_PER_CREDENTIAL; i += 1) limits.takeRateSlot('cred_leak', t0);
    expect(() => limits.takeRateSlot('cred_leak', t0 + 1)).toThrow(/in flight/);
    expect(() => limits.takeRateSlot('cred_leak', t0 + limits.SLOT_MAX_AGE_MS - 1)).toThrow(/in flight/);
    expect(() => limits.takeRateSlot('cred_leak', t0 + limits.SLOT_MAX_AGE_MS)).not.toThrow();
  });

  it('a late release after expiry does not free a newer slot', () => {
    const t0 = 2_000_000;
    const stale = limits.takeRateSlot('cred_late', t0);
    const later = t0 + limits.SLOT_MAX_AGE_MS;
    const fresh = Array.from({ length: limits.MAX_CONCURRENT_PER_CREDENTIAL }, () =>
      limits.takeRateSlot('cred_late', later),
    );
    stale.release();
    expect(() => limits.takeRateSlot('cred_late', later + 1)).toThrow(/in flight/);
    fresh.forEach((slot) => slot.release());
  });
});
