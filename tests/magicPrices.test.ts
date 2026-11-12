import { describe, expect, it } from 'vitest';
import { formatCents, parseUsdToCents } from '../server/services/magic/prices/money.ts';
import {
  alternatePrintings, approveSingles, canMarkApproved, priceFor, resolvePrinting, validateVerifiedEntry,
  type PrintingPrice, type VerifiedPrice,
} from '../server/services/magic/prices/prices.ts';

const p = (id: string, cents: number | null, oracle = 'o1', set = 'abc', n = '1'): PrintingPrice => ({
  printingId: id, oracleId: oracle, setCode: set, collectorNumber: n, scryfallCents: cents, scryfallFetchedAt: '2026-10-31T00:00:00Z',
});
const conf = (id: string, cents: number): VerifiedPrice => ({ printingId: id, priceCents: cents, source: 'LGS', observedOn: '2026-11-01', locked: true });

describe('money', () => {
  it('parses exact boundaries', () => {
    expect(parseUsdToCents('9.99')).toBe(999);
    expect(parseUsdToCents('10.00')).toBe(1000);
    expect(parseUsdToCents('$10.01')).toBe(1001);
    expect(parseUsdToCents('10.001')).toBeNull();
    expect(parseUsdToCents('abc')).toBeNull();
    expect(parseUsdToCents(0.001)).toBeNull();
    expect(formatCents(1001)).toBe('$10.01');
  });
});

describe('prices', () => {
  it('scryfall is an ESTIMATE, a person entry is CONFIRMED, none is null', () => {
    expect(priceFor(p('a', 250), []).status).toBe('ESTIMATE');
    expect(priceFor(p('a', 250), [conf('a', 300)])).toMatchObject({ status: 'CONFIRMED', priceCents: 300 });
    expect(priceFor(p('a', null), []).priceCents).toBeNull();
  });
  it('9.99 and 10.00 pass, 10.01 is refused', () => {
    const one = (c: number) => approveSingles([priceFor(p('a', null), [conf('a', c)])]);
    expect(one(999).eligible).toBe(true);
    expect(one(1000).eligible).toBe(true);
    const over = one(1001);
    expect(over.eligible).toBe(false);
    expect(over.reasons.join()).toContain('over');
  });
  it('an ESTIMATE cannot be approved', () => {
    const r = priceFor(p('a', 100), []);
    expect(canMarkApproved(r).ok).toBe(false);
    expect(approveSingles([r]).eligible).toBe(false);
    expect(canMarkApproved(priceFor(p('a', 100), [conf('a', 100)])).ok).toBe(true);
  });
  it('a missing price is not approved', () => {
    expect(approveSingles([priceFor(p('a', null), [])]).eligible).toBe(false);
  });
  it('validates verified entries', () => {
    expect(validateVerifiedEntry({ printingId: 'a', priceCents: 100, source: 'LGS', observedOn: '2026-11-01' })).toEqual([]);
    expect(validateVerifiedEntry({ printingId: 'a', priceCents: 1.5, source: '', observedOn: 'x' }).length).toBe(3);
    expect(validateVerifiedEntry({ printingId: 'a', priceCents: 1, source: 'Scryfall', observedOn: '2026-11-01' }).length).toBe(1);
  });
  it('alternate printings carry the delta', () => {
    const ref = p('a', 100);
    const alts = alternatePrintings(ref, [ref, p('b', 450, 'o1', 'xyz', '9'), p('c', null), p('d', 1, 'other')], []);
    expect(alts.map((x) => x.printingId)).toEqual(['b', 'c']);
    expect(alts[0]!.deltaCents).toBe(350);
    expect(alts[1]!.deltaCents).toBeNull();
  });
  it('surfaces ambiguous printings instead of guessing', () => {
    const c = { name: 'Sol Ring', printings: [p('a', 1), p('b', 2)] };
    expect(resolvePrinting(c).printing).toBeNull();
    expect(resolvePrinting(c).ambiguous.length).toBe(2);
    expect(resolvePrinting(c, 'b').printing?.printingId).toBe('b');
    expect(resolvePrinting(c, 'zz').printing).toBeNull();
    expect(resolvePrinting({ name: 'X', printings: [p('a', 1)] }).printing?.printingId).toBe('a');
  });
});
