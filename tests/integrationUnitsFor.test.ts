/**
 * An integration report is judged against what its own bin told the worker to
 * merge (production 2026-11-10: a unit integrated by an earlier round made every
 * honest report "not one of the units this bin was given", 18 attempts running).
 */
import { describe, expect, it } from 'vitest';
import { integrationUnitsFor } from '../server/services/factory/remote.ts';
import type { Bin } from '../server/domain/types.ts';

function bin(order: unknown[]): Bin {
  return {
    manifest: {
      units: [{ key: 'integrate', input: JSON.stringify({ integrationBranch: 'b', baseSha: 'a'.repeat(40), mergeInOrder: order }) }],
    },
  } as unknown as Bin;
}

describe('the units an integration is judged against', () => {
  it('keeps a manifest unit that has since been integrated, and adds any implemented since', () => {
    const units = integrationUnitsFor(
      bin([{ unitKey: 'tel-07-1', branch: 'x', headSha: '1'.repeat(40), ownedPaths: ['server/a.ts'] }]),
      [{ unitKey: 'repair-cost-scope', headSha: '2'.repeat(40), ownedPaths: ['server/b.ts'] }],
    );
    expect(units.map((u) => u.unitKey)).toEqual(['tel-07-1', 'repair-cost-scope']);
    expect(units[0]!.ownedPaths).toEqual(['server/a.ts']);
  });

  it('prefers the commit the manifest named over a later one for the same unit', () => {
    const units = integrationUnitsFor(
      bin([{ unitKey: 'u', headSha: '1'.repeat(40), ownedPaths: [] }]),
      [{ unitKey: 'u', headSha: '3'.repeat(40), ownedPaths: [] }],
    );
    expect(units).toEqual([{ unitKey: 'u', headSha: '1'.repeat(40), ownedPaths: [] }]);
  });

  it('falls back to the implemented units when the manifest carries no order', () => {
    expect(integrationUnitsFor({ manifest: { units: [] } } as unknown as Bin, [{ unitKey: 'u', headSha: '4'.repeat(40), ownedPaths: [] }]))
      .toEqual([{ unitKey: 'u', headSha: '4'.repeat(40), ownedPaths: [] }]);
  });
});
