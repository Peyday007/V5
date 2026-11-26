/**
 * The objective reader against readings it did not write (test-validity review,
 * 2026-11-26: the earlier "matches a human reading" check was the reader's
 * author reading his own output). The 30 fresh evaluation requests and their
 * expected limits were written blind by an independent agent that saw only the
 * owners' words (tests/fixtures/freshBatchReadings.json). A deadline the expected
 * reading itself calls ambiguous may differ by up to a month; nothing else may.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readObjective } from '../server/services/industry/construction/intent.ts';
import { ownerLabourOffer, ownerLabourWithHours } from '../server/domain/operatingModel.ts';

interface Case {
  case: string;
  text: string;
  expected: { amount: number | null; recurring: string | null; deadline: string | null; capitalMax: number | null; hoursPerWeek: number | null; offersOwnLabour: boolean | null };
  notes: string | null;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/freshBatchReadings.json', import.meta.url), 'utf8')) as { readAt: string; cases: Case[] };
const now = new Date(fixture.readAt);
const day = 86_400_000;

describe('the objective reader agrees with blind human readings of 30 fresh requests', () => {
  for (const c of fixture.cases) {
    it(`${c.case}: ${c.text.slice(0, 70)}…`, () => {
      const r = readObjective(c.text, now);
      const e = c.expected;
      expect(r.amount).toBe(e.amount);
      expect(r.recurring ?? null).toBe(e.recurring ?? null);
      const tolerance = /ambiguous|could also mean/i.test(c.notes ?? '') ? 31 : 3;
      if (e.deadline === null) expect(r.deadline).toBeNull();
      else expect(Math.abs(Date.parse(String(r.deadline)) - Date.parse(e.deadline)) / day).toBeLessThanOrEqual(tolerance);
      expect(r.capitalCeiling ?? r.capitalAssumed?.amount ?? null).toBe(e.capitalMax);
      if (e.hoursPerWeek === 0) expect(r.hoursCeiling).toBe(0);
      else expect(r.hoursPerWeek ?? null).toBe(e.hoursPerWeek);
      if (e.offersOwnLabour !== null) expect(ownerLabourWithHours(ownerLabourOffer(c.text), { perWeek: r.hoursPerWeek, total: r.hoursCeiling }).offered).toBe(e.offersOwnLabour);
    });
  }
});
