/**
 * A spent forge read budget is named as that, not as a failed verification.
 *
 * Production, 2026-09-30: with no forge token, a pushed and tested integration
 * was refused "The forge answered 403.", the worker released, and the bin spent
 * its last attempt on a condition that was never about the work.
 */
import { describe, expect, it } from 'vitest';
import { rateLimitReason } from '../server/services/factory/forge.ts';

function reply(status: number, headers: Record<string, string>) {
  return { status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

describe('a forge rate limit', () => {
  it('is named, with when it ends, for an exhausted 403', () => {
    const reason = rateLimitReason(
      reply(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }),
      false,
    );
    expect(reason).toContain('rate limit is spent until 2026-09-21');
    expect(reason).toContain('without a token');
    expect(reason).toContain('not a fault in the work');
  });

  it('is named for a 429 and for a secondary limit carrying retry-after', () => {
    expect(rateLimitReason(reply(429, {}), true)).toContain('rate limit is spent');
    expect(rateLimitReason(reply(403, { 'retry-after': '60' }), true)).toContain('rate limit is spent');
  });

  it('leaves an ordinary refusal alone', () => {
    expect(rateLimitReason(reply(403, { 'x-ratelimit-remaining': '42' }), false)).toBeNull();
    expect(rateLimitReason(reply(500, {}), false)).toBeNull();
    expect(rateLimitReason(reply(404, {}), false)).toBeNull();
  });
});
