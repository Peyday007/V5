/**
 * Acceptance run 16 (frozen f458f03) discovery failure, kept as a regression with matched controls.
 *
 * ay-04 (d04): "I need to keep $3,500 after all direct costs within 21 days." Brain's objective reader stored no target
 * (kind OTHER, amount null): "keep … after … costs" was neither a contribution metric nor a target verb, so the goal
 * could not be planned at all. The reader now reads it as $3,500 of contribution; money kept aside is still not a target.
 */
import { describe, expect, it } from 'vitest';
import { readObjective } from '../server/services/industry/construction/intent.ts';

const read = (t: string) => readObjective(t, new Date('2026-11-28')) as unknown as { kind: string; metric: string; amount: number | null; windowDays: number | null; capitalCeiling: number | null };

describe('run 16, ay-04: "keep $X after all direct costs" is a contribution target', () => {
  it('the d04 objective reads as $3,500 of contribution in 21 days with a $300 cap', () => {
    expect(read('I need to keep $3,500 after all direct costs within 21 days. I can spend at most $300 up front.')).toMatchObject({ kind: 'CASH', metric: 'CONTRIBUTION', amount: 3500, windowDays: 21, capitalCeiling: 300 });
    expect(read('Help me pocket $2,000 after expenses within two weeks.')).toMatchObject({ metric: 'CONTRIBUTION', amount: 2000 });
  });

  it('controls: settled-cash and net phrasings are unchanged; money kept in reserve is not the target', () => {
    expect(read('Target is $12,000 of settled cash in 45 days. I can invest up to $2,500.')).toMatchObject({ metric: 'SETTLED_CASH', amount: 12000, capitalCeiling: 2500 });
    expect(read('Keep $3,000 of net cash — after every direct cost — settled within 30 days, using no up-front capital.')).toMatchObject({ metric: 'CONTRIBUTION', amount: 3000 });
    expect(read('I want $5,000 of settled cash in 30 days and keep $500 aside as a buffer.')).toMatchObject({ metric: 'SETTLED_CASH', amount: 5000 });
  });
});
