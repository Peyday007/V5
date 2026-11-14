/**
 * Surge B findings E-1 and I-1 (docs/INTELLIGENCE-RECOVERY-2026-11-14.md).
 *
 * E-1: a signed contract's deposit and milestone tranches counted $0 because
 * nothing read the stated payment terms into cash timing. `paymentSchedule`
 * reads them; only the share due before the balance moves earlier, and never
 * earlier than its latest stated day.
 *
 * I-1 is covered end to end by the independent evaluation's case I (a presale
 * reading is no longer refused as implausible on gross receipts that pass
 * straight back to the supplier); the critic now compares kept cash.
 */
import { describe, expect, it } from 'vitest';
import { paymentSchedule } from '../server/services/goals/portfolio.ts';

describe('paymentSchedule (E-1)', () => {
  it('reads deposit + milestone shares due before the balance, at the latest of their days', () => {
    const s = paymentSchedule('30% deposit at signing, 40% at the day 20 milestone, 30% balance net 30 after acceptance', 3);
    expect(s).not.toBeNull();
    expect(s!.share).toBeCloseTo(0.7, 5);
    expect(s!.day).toBe(20);
  });

  it('a deposit alone is its own share on the signing day', () => {
    const s = paymentSchedule('30% deposit at signing, 70% balance on delivery', 3);
    expect(s).not.toBeNull();
    expect(s!.share).toBeCloseTo(0.3, 5);
    expect(s!.day).toBe(3);
  });

  it('terms that state no early share move nothing earlier', () => {
    expect(paymentSchedule('net 30 after delivery', 0)?.share ?? 0).toBe(0);
    expect(paymentSchedule(null, 0)).toBeNull();
  });
});
