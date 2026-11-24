import { describe, expect, it } from 'vitest';
import { readObjective } from '../server/services/industry/construction/intent.ts';

/**
 * The owner's ordinary phrasings (2026-11-24 investigation): 12 of 40 fresh requests were
 * refused at goal creation or read with no amount. Each is read in full, and nothing it says is
 * left unread.
 */
const now = new Date('2026-11-24T12:00:00Z');
const read = (text: string) => readObjective(text, now);

describe('readObjective: the owner’s ordinary phrasings', () => {
  it('reads "Build $X a month of recurring income" as a monthly run-rate', () => {
    const o = read('Build 1,000 dollars a month of recurring income from bookkeeping-type work within 60 days. Zero capital, I can give it 3 hours a week.');
    expect(o.unread).toEqual([]);
    expect(o.amount).toBe(1000);
    expect(o.recurring).toBe('MONTHLY');
  });
  it('reads "get to / reach $X a month" as a monthly run-rate', () => {
    const a = read('Launch a done-for-you LinkedIn ghostwriting service and get to 4,000 dollars a month within 60 days, with 500 dollars of capital and 5 hours a week.');
    expect(a.unread).toEqual([]);
    expect(a.amount).toBe(4000);
    expect(a.recurring).toBe('MONTHLY');
    expect(a.capitalCeiling).toBe(500);
    const b = read('Run a cold-email lead generation agency for HVAC companies and reach 6,000 dollars a month within 90 days, with 1,000 dollars of capital and 10 hours a week.');
    expect(b.amount).toBe(6000);
    expect(b.recurring).toBe('MONTHLY');
  });
  it('reads "Get $X a month in recurring revenue"', () => {
    const o = read('Get 5,000 dollars a month in recurring revenue within 90 days, with under 1,500 dollars of starting capital and 10 hours a week of my time.');
    expect(o.unread).toEqual([]);
    expect(o.amount).toBe(5000);
    expect(o.capitalCeiling).toBe(1500);
  });
  it('reads "using at most $X" as the capital limit', () => {
    const o = read('Get to 2,000 dollars a month in recurring revenue within 45 days, using at most 500 dollars and no more than 5 hours a week of my time.');
    expect(o.unread).toEqual([]);
    expect(o.amount).toBe(2000);
    expect(o.capitalCeiling).toBe(500);
    expect(read('Earn 5,000 dollars within 30 days with something in healthcare, using no more than 1,000 dollars.').capitalCeiling).toBe(1000);
  });
  it('reads zero owner hours as a limit of nothing, never as no limit', () => {
    expect(read('Make 1,000 dollars in 10 days with zero capital and zero hours of my time; Brain does everything.').hoursCeiling).toBe(0);
    expect(read('Get to 3,000 dollars a month in recurring revenue within 60 days without spending any of my own hours, using under 1,000 dollars of capital.').hoursCeiling).toBe(0);
  });
  it('reads "can put in N hours this week" as owner time, not a second deadline', () => {
    const o = read('Make 500 dollars within 7 days. I have 200 dollars and can put in 10 hours this week.');
    expect(o.unread).toEqual([]);
    expect(o.hoursCeiling).toBe(10);
    expect(o.capitalCeiling).toBe(200);
  });
  it('still leaves a bare rate with no verb of its own unread', () => {
    const o = read('Collect $3,000 within 30 days; my costs are $200 a month.');
    expect(o.amount).toBe(3000);
    expect(o.recurring).not.toBe('MONTHLY');
  });
});
