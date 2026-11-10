import { describe, expect, it } from 'vitest';
import { forgeOnly } from '../server/services/bins/service.ts';

const LIMIT = "The forge could not confirm factory/campaign/fcp_x: The forge's read rate limit is spent until 2026-11-09T14:12:39.000Z (Brain reads it without a token, so the budget is 60 an hour). This is not a fault in the work: keep the lease, heartbeat, and report again once it resets.";

describe('a bin out of attempts only because the forge refused reads', () => {
  it('is not a decision for a person; any other outstanding reason, or a HUMAN verdict, still is', () => {
    expect(forgeOnly({ disposition: 'RETRY', reasons: [LIMIT] })).toBe(true);
    expect(forgeOnly({ disposition: 'RETRY', reasons: [LIMIT, LIMIT] })).toBe(true);
    expect(forgeOnly({ disposition: 'SATISFIED', reasons: [] })).toBe(true);
    expect(forgeOnly({ disposition: 'RETRY', reasons: [LIMIT, 'unit u1 has no integrated commit'] })).toBe(false);
    expect(forgeOnly({ disposition: 'HUMAN', reasons: [LIMIT] })).toBe(false);
  });
});
