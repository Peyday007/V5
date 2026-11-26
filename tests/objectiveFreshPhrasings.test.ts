/**
 * Phrase classes the objective reader refused or misread on a fresh evaluation
 * batch (2026-11-26, planning failure map C01): a monthly figure with a start
 * month, a spending limit written "more than", a bare span ("about two weeks"),
 * an hours rate followed by "at most", and owners who give no time at all.
 * Each sentence here is a new wording of the class, not the batch's own text.
 */
import { describe, expect, it } from 'vitest';
import { readObjective } from '../server/services/industry/construction/intent.ts';

const now = new Date('2026-11-26T05:30:00Z');
const read = (text: string) => readObjective(text, now);

describe('objective phrasings a fresh batch exposed', () => {
  it('a monthly figure with a start month is due at the end of that month', () => {
    const r = read("We'd like an extra $1,200 a month starting in February, and we can spend up to $400.");
    expect([r.kind, r.amount, r.recurring, String(r.deadline).slice(0, 10), r.capitalCeiling]).toEqual(['CASH', 1200, 'MONTHLY', '2027-02-28', 400]);
  });
  it('"go from nothing to $X a month within N months" is a monthly run-rate', () => {
    const r = read('I want to go from zero to $2,000 a month within 3 months with $500 to start.');
    expect([r.kind, r.amount, r.recurring]).toEqual(['CASH', 2000, 'MONTHLY']);
  });
  it('"without spending more than $X" is the capital limit', () => {
    expect(read('I want $3,000 in the next 2 months without spending more than $600.').capitalCeiling).toBe(600);
  });
  it('a bare span sets the window when nothing else does, never an hours rate', () => {
    const r = read('My daughter and I want $400 over spring break, about ten days, maybe 20 hours a week between us.');
    expect(String(r.deadline).slice(0, 10)).toBe('2026-12-06');
    expect(r.hoursPerWeek).toBe(20);
  });
  it('"N hours a week at most" is a rate, not a total of N', () => {
    const r = read("I want $2,000 within 8 weeks and I'll put in 5 hours a week at most.");
    expect([r.hoursPerWeek, r.hoursCeiling]).toEqual([5, 40]);
  });
  it('an owner who gives no time has a limit of zero hours', () => {
    expect(read("I have $9,000 and zero time; I want $1,500 a month within 6 months.").hoursCeiling).toBe(0);
    expect(read("I'm not going to do any of the work myself. I have $4,000 and want $3,000 profit in 4 months.").hoursCeiling).toBe(0);
  });
  it('"don\'t want to put any money in" and "nothing — no savings" are no capital', () => {
    expect(read("I want $700 a month starting in March, 5 hours a week, and I don't want to put any money in.").capitalAssumed?.amount).toBe(0);
    expect(read('I have nothing, no savings at all. I need $800 within 30 days.').capitalAssumed?.amount).toBe(0);
  });
});
