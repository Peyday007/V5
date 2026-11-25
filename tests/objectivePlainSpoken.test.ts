import { describe, expect, it } from 'vitest';
import { readObjective, readResources } from '../server/services/industry/construction/intent.ts';

/**
 * Plain-spoken money goals (production, 2026-11-25): 3 of 12 fresh requests were
 * refused or read without an amount — a relative calendar deadline ("by end of
 * next month", "four months from now"), a recurring income phrased as money
 * "coming in" or that "pays me", approximate words. Each class is pinned by the
 * production phrasing and by phrasings written for this test that no rule names.
 */
const now = new Date('2026-11-25T12:00:00Z');
const read = (text: string) => readObjective(text, now);
const day = (iso: string) => iso.slice(0, 10);

describe('readObjective: the production failures of 2026-11-25', () => {
  it('reads "by end of next month" as the last day of next month, and the person\'s truck and weekends as resources', () => {
    const o = read("Need about $2,000 by end of next month. I don't have money to put in but I've got a pickup truck and my weekends are free.");
    expect(o).toMatchObject({ kind: 'CASH', amount: 2000, currency: 'USD', recurring: null, hoursCeiling: null });
    expect(day(o.deadline!)).toBe('2026-12-31');
    expect(o.unread).toEqual([]);
    expect(o.capitalAssumed?.amount).toBe(0);
    expect(o.resources).toEqual(['a pickup truck', 'my weekends are free']);
  });
  it('reads "$5k a month coming in on a recurring basis" as a monthly run-rate', () => {
    const o = read("I'd like $5k a month coming in on a recurring basis within 90 days. I have about $500 and can give it 10 hours a week.");
    expect(o).toMatchObject({ kind: 'CASH', amount: 5000, recurring: 'MONTHLY', capitalCeiling: 500, hoursPerWeek: 10, windowDays: 90 });
    expect(o.unread).toEqual([]);
  });
  it('reads "pays me around $3,000 a month by about four months from now"', () => {
    const o = read('Looking for something that pays me around $3,000 a month by about four months from now. I have $2,000 and only a few hours a week.');
    expect(o).toMatchObject({ kind: 'CASH', amount: 3000, recurring: 'MONTHLY', capitalCeiling: 2000, windowDays: 120, hoursPerWeek: 2 });
    expect(o.unread).toEqual([]);
  });
});

describe('readObjective: relative calendar deadlines', () => {
  const cases: [string, string, number | null][] = [
    ['Make $1,500 by the end of the month.', '2026-11-30', null],
    ['Make $1,500 before the end of this week.', '2026-11-29', null],
    ['Collect $9,000 by the end of next quarter.', '2027-03-31', null],
    ['Earn $3k by next month.', '2026-11-30', null],
    ['Get $10,000 by mid-January.', '2027-01-15', null],
    ['Clear $1,800 by the start of February.', '2027-01-31', null],
    ['Need $12,000 by late March.', '2027-03-20', null],
    ['Want $3,500 by this summer.', '2027-05-31', null],
    ['Want $3,500 by the end of summer.', '2027-08-31', null],
    ['Make $2,500 before Christmas.', '2026-12-24', null],
    ['Need $900 before Thanksgiving next year.', '2027-11-24', null],
    ['Target: 7,500 dollars by Valentine\'s Day.', '2027-02-14', null],
    ['Earn $750 by Friday.', '2026-11-27', null],
    ['My goal is $5,000 cash by the 15th of February.', '2027-02-15', null],
    ['Need $800 in a couple of weeks.', '2026-12-09', 14],
    ['Get $6,000 six weeks from now.', '2027-01-06', 42],
    ['Make $2k over the next few months.', '2027-02-25', 92],
    ['Earn $1,500 two months from today.', '2027-01-25', 61],
    ["Make $3k-ish in three weeks' time.", '2026-12-16', 21],
  ];
  for (const [text, date, window] of cases) {
    it(text, () => {
      const o = read(text);
      expect(o.kind, text).toBe('CASH');
      expect(o.deadline, text).not.toBeNull();
      expect(day(o.deadline!), text).toBe(date);
      expect(o.windowDays ?? null, text).toBe(window);
      expect(o.unread, text).toEqual([]);
    });
  }
  it('still names a deadline-shaped phrase it cannot read, and never reads "soon" as one', () => {
    expect(read('Make $1,000 soon.').unread).toEqual(expect.arrayContaining(['"soon": not a deadline', 'deadline: none stated']));
  });
});

describe('readObjective: recurring income', () => {
  const cases: [string, number][] = [
    ['I want a side income of $2,500/mo within the next few months.', 2500],
    ['Looking to bring in roughly $1,000 every month starting within 60 days.', 1000],
    ["I'd love $4,000 a month in steady income by the end of the quarter.", 4000],
    ['Want $2.5k coming in monthly within 120 days.', 2500],
    ['Something that earns $1,500 a month on the side, two months from today.', 1500],
    ['Want to replace my $4,000 a month salary by spring.', 4000],
    ['Want to bring in $4k/mo within 6 months.', 4000],
  ];
  for (const [text, amount] of cases) {
    it(text, () => {
      const o = read(text);
      expect(o, text).toMatchObject({ kind: 'CASH', amount, recurring: 'MONTHLY' });
      expect(o.unread, text).toEqual([]);
    });
  }
  it('reads a salary with no period as annual only from a figure no month\'s pay is', () => {
    expect(read('Need to replace my $60k salary within a year.')).toMatchObject({ amount: 5000, recurring: 'MONTHLY' });
    const small = read('Need to replace my $4,000 salary within a year.');
    expect(small.amount).toBeNull();
    expect(small.unread).toContain('"$4,000": a salary with no period');
  });
  it('does not read a monthly cost or a capital figure as income', () => {
    expect(read('Collect $3,000 within 30 days; my costs are $200 a month.').recurring).toBeNull();
    expect(read('Make $2,000 in 30 days. I have $300 a month in expenses.').recurring).toBeNull();
  });
});

describe('readObjective: approximate words, capital and hours', () => {
  it('reads "about", "around", "roughly", "-ish" as the figure', () => {
    expect(read('Make roughly $1,500 by the end of the month, I have around $300.')).toMatchObject({ amount: 1500, capitalCeiling: 300 });
    expect(read('Make $2,500-ish before Christmas. I have $200.')).toMatchObject({ amount: 2500, capitalCeiling: 200 });
  });
  it('reads the money a person has, however it is said', () => {
    expect(read("Want to bring in $4k/mo within 6 months. I've got $1,000 and maybe 8 hours a week.")).toMatchObject({ capitalCeiling: 1000, hoursPerWeek: 8 });
    expect(read("I'd love $4,000 a month by the end of the quarter. Got about $1,500.").capitalCeiling).toBe(1500);
    expect(read('Need $900 before Thanksgiving next year, have $100.').capitalCeiling).toBe(100);
    expect(read('Looking to bring in roughly $1,000 every month within 60 days, I can spare $300.').capitalCeiling).toBe(300);
  });
  it('reads "6 hrs/week" as a rate, and a vague time of week as a resource, never a figure', () => {
    expect(read('Make 3k in three weeks. I have $400 and 6 hrs/week.').hoursPerWeek).toBe(6);
    const o = read('I want $3,500 by this summer, I have around $600 and weekends.');
    expect(o.hoursPerWeek).toBeNull();
    expect(o.hoursCeiling).toBeNull();
    expect(o.resources).toEqual(['weekends']);
    expect(readResources('Get me $2k in two months, I own a pressure washer and my evenings are free.')).toEqual(['a pressure washer', 'my evenings are free']);
  });
});
