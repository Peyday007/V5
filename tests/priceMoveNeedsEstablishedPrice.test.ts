/**
 * A price move multiplies a price somebody established; it never scales a
 * price nobody has (production 2026-11-20, goal C wst_4f0c312400e1425dab2e:
 * the plan led at 25.3% by raising a constructed postcard arrangement's
 * unestablished $349 ×3.75 on an assumed elasticity, against 8.3% as held).
 * General rule (invariant 39): an unknown may never rank a plan higher —
 * not as a member's capital (#1157), and not as a price a lever multiplies.
 */
import { describe, expect, it } from 'vitest';
import { repriceOpening } from '../server/services/goals/reasoning/directions.ts';
import { isEstablished } from '../server/services/goals/reasoning/rank.ts';

const input = (provenance: string, low: number, high: number, extra: Record<string, unknown> = {}) => ({ value: null, low, high, provenance, note: 'n', ...extra });

const opening = (price: ReturnType<typeof input>) =>
  ({
    opportunity: { id: 'cop_x', title: 'Constructed: Local businesses buying a slot on a shared direct-mail postcard' },
    price,
    close: input('UNKNOWN', 0.02, 0.5),
    volume: input('UNKNOWN', 1, 50),
    terms: { priceFactor: 1, shape: null, units: 1 },
  }) as never;

describe('a price move needs a price somebody established', () => {
  it('leaves an unestablished price where it is', () => {
    const o = opening(input('UNKNOWN', 200, 500));
    const r = repriceOpening(o, 3.75);
    expect(r.applied).toBe(1);
    expect(r.opening).toBe(o);
  });

  it('still moves an evidenced price, with the demand curve moving against it', () => {
    const o = opening(input('EVIDENCE', 200, 500));
    const r = repriceOpening(o, 2);
    expect(r.applied).toBe(2);
    const moved = r.opening as unknown as { price: { low: number }; close: { high: number } };
    expect(moved.price.low).toBe(400);
    expect(moved.close.high).toBeLessThan(0.5);
  });

  it('reads stated values, evidence, history and justified inferences as established, and nothing else', () => {
    expect(isEstablished({ ...input('ASSUMPTION', 1, 2), value: 300 } as never)).toBe(true);
    expect(isEstablished(input('HISTORICAL', 1, 2) as never)).toBe(true);
    expect(isEstablished(input('UNKNOWN', 1, 2, { inferred: { p10: 1, p50: 2, p90: 3, justified: true } }) as never)).toBe(true);
    expect(isEstablished(input('UNKNOWN', 1, 2) as never)).toBe(false);
    expect(isEstablished(input('ASSUMPTION', 1, 2) as never)).toBe(false);
  });
});
