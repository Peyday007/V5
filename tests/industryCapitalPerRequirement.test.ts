/**
 * A requirement is counted once however many sources priced it, and is unpriced
 * only where no row for it carries a figure (CLAUDE.md §39).
 */
import { describe, expect, it } from 'vitest';
import { readCapital } from '../server/services/industry/capital.ts';
import type { CapitalStructure } from '../server/domain/types.ts';

let n = 0;
const entry = (over: Partial<CapitalStructure>): CapitalStructure => ({
  id: `cap_${++n}`,
  projectId: 'prj_1',
  opportunityId: 'cop_1',
  entryKind: 'REQUIREMENT',
  requirement: 'EQUIPMENT',
  mechanism: null,
  answersId: null,
  amountCents: null,
  residualCents: null,
  statement: 'a requirement',
  sourceClaimId: `clm_${n}`,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('capital per requirement', () => {
  it('does not sum one requirement once per source that priced it', () => {
    const reading = readCapital('cop_1', [
      entry({ amountCents: 500_000 }),
      entry({ amountCents: 700_000 }),
    ]);
    expect(reading.minimumOwnerCents).toBe(700_000);
    expect(reading.requirements).toHaveLength(1);
  });

  it('is not withheld by an unpriced row when another row priced the requirement', () => {
    const reading = readCapital('cop_1', [
      entry({ amountCents: null }),
      entry({ amountCents: 500_000 }),
    ]);
    expect(reading.minimumOwnerCents).toBe(500_000);
    expect(reading.unknown).toBeNull();
  });

  it('still withholds when no row of a requirement has a figure', () => {
    const reading = readCapital('cop_1', [
      entry({ amountCents: 500_000 }),
      entry({ requirement: 'LICENSING', amountCents: null }),
      entry({ requirement: 'LICENSING', amountCents: null }),
    ]);
    expect(reading.minimumOwnerCents).toBeNull();
    expect(reading.unknown).toBe('AMOUNT_UNKNOWN');
  });

  it('applies a residual answering any row of the group', () => {
    const unpriced = entry({ amountCents: null });
    const priced = entry({ amountCents: 500_000 });
    const reading = readCapital('cop_1', [
      unpriced,
      priced,
      entry({
        entryKind: 'RESTRUCTURING',
        requirement: null,
        mechanism: 'LEASE',
        answersId: unpriced.id,
        residualCents: 100_000,
      }),
    ]);
    expect(reading.minimumOwnerCents).toBe(100_000);
    expect(reading.removedCents).toBe(400_000);
  });
});
