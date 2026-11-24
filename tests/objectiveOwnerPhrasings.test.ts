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

  it('reads the second batch of ordinary phrasings in full (sealed set, 2026-11-24)', () => {
    const cases: [string, Partial<Record<'amount' | 'capitalCeiling' | 'hoursCeiling', number>>, string | null][] = [
      ['Earn 4000 dollars of settled cash in 30 days. I can put up to $500 into it.', { amount: 4000, capitalCeiling: 500 }, null],
      ['I want $10,000 a month recurring within 90 days. Budget is $2,000 and I can give it 10 hours a week.', { amount: 10000, capitalCeiling: 2000 }, 'MONTHLY'],
      ["I want to make $25k in collected revenue over the next 4 months. I've got 10k to invest and just a few hours a week.", { amount: 25000, capitalCeiling: 10000 }, null],
      ['Earn $1,000/mo recurring by the end of January. Budget about $300.', { amount: 1000, capitalCeiling: 300 }, 'MONTHLY'],
      ['Collect 12k in customer payments in 60 days. I can work 20 hrs a week and spend up to $2,000.', { amount: 12000, capitalCeiling: 2000 }, null],
      ['Use AI to write grant applications for Detroit nonprofits — I want $6k collected within 60 days.', { amount: 6000 }, null],
      ["Something in real estate. Collect $4,000 within 45 days, I've got $1,000 to start and maybe 5 hours a week.", { amount: 4000, capitalCeiling: 1000 }, null],
      ['Start a Google Business Profile optimization service for Detroit dentists at $300/month. Get it to $3,000 MRR in 90 days.', { amount: 3000 }, 'MONTHLY'],
      ["Sell resume rewrites to laid-off auto workers for $150 each. I need $1,200 within 14 days and I've got no money.", { amount: 1200 }, null],
      ['Run a Facebook ads agency for local gyms at $1,500/mo retainers. I want $4,500 MRR in 60 days. $500 budget, 10 hrs a week.', { amount: 4500, capitalCeiling: 500 }, 'MONTHLY'],
      ['Run a snow removal brokerage in metro Detroit this winter. $40,000 collected by end of March, $10k capital, I can do 20 hours a week of dispatching.', { amount: 40000, capitalCeiling: 10000 }, null],
      ['make 500 dollars this week, no capital', { amount: 500 }, null],
    ];
    for (const [text, want, recurring] of cases) {
      const o = read(text);
      expect(o.unread, text).toEqual([]);
      expect(o.currency, text).toBe('USD');
      expect(o.deadline, text).not.toBeNull();
      expect(o, text).toMatchObject(want);
      if (recurring) expect(o.recurring, text).toBe(recurring);
    }
  });
  it('reads a plain-spoken refusal to spend or to work as a limit of nothing, never as no limit', () => {
    expect(read("Collect $1,500 in customer payments within 10 days. I don't have any money to put in.").capitalAssumed?.amount).toBe(0);
    const o = read("Get me to $2,500/month in recurring revenue in 45 days. I don't want to spend anything and I'm not doing any of the work.");
    expect(o.capitalAssumed?.amount).toBe(0);
    expect(o.hoursCeiling).toBe(0);
    expect(read("Build $7,500 a month in recurring revenue within 5 months using up to $12,000. I don't want to put in any hours.").hoursCeiling).toBe(0);
    expect(read("What's the fastest way to collect $2,000 in 14 days? I can spend a couple hundred bucks.").capitalAssumed?.amount).toBe(200);
  });
});
