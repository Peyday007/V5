// E-013: REF readObjective over dec1125c objectives (verbatim), fm1126a phrase classes (RECONSTRUCTED from the map's quoted fragments;
// the batch texts are not in the repository), a control set, and new paraphrases the W1i repair was not tuned on.
import { readObjective } from '../../../../../server/services/industry/construction/intent.ts';
import { write } from './lib.ts';

const now = new Date('2026-11-26T06:00:00Z');
type Exp = { amount?: number | null; window?: number | null; deadline?: string | null; capital?: number | null; hours?: number | null; hpw?: number | null; monthly?: boolean };
const C: { set: string; text: string; exp: Exp }[] = [
  // dec1125c, verbatim (planner probe objectives)
  { set: 'dec1125c', text: "I have a DJI Mavic 3 and my FAA Part 107 license, I'm in Phoenix. I want to clear $4,500 from drone work in the next 60 days. I can spend $1,500 and I can fly about 20 hours a week.", exp: { amount: 4500, window: 60, capital: 1500, hpw: 20 } },
  { set: 'dec1125c', text: 'Seattle. I have zero money to invest and I need $500 within 7 days. I can put in 15 hours this week. Figure out the fastest legit way.', exp: { amount: 500, window: 7, capital: 0, hours: 15 } },
  { set: 'dec1125c', text: "I want a business that does $20,000 in the next 90 days and keeps going after. I'm in Minneapolis, I have $5,000 to fund it, and I can't put any hours in myself at all, so it has to run without me. Choose whatever you think works.", exp: { amount: 20000, window: 90, capital: 5000, hours: 0 } },
  // fm1126a phrase classes, reconstructed around the fragments map.json quotes
  { set: 'fm1126a-recon', text: 'I want to go from nothing to $3,500 a month within 4 months.', exp: { amount: 3500, monthly: true, window: 120 } },
  { set: 'fm1126a-recon', text: 'I need $2,500 in about two weeks and I can spend $300.', exp: { amount: 2500, window: 14, capital: 300 } },
  { set: 'fm1126a-recon', text: 'Make $4,000 in 60 days without spending more than $1,000.', exp: { amount: 4000, window: 60, capital: 1000 } },
  { set: 'fm1126a-recon', text: "I want $3,000 within 10 weeks; 3 hours a week at most.", exp: { amount: 3000, window: 70, hpw: 3 } },
  { set: 'fm1126a-recon', text: 'I have $6,000 and zero time. I want $2,000 within 2 months.', exp: { amount: 2000, window: 60, capital: 6000, hours: 0 } },
  { set: 'fm1126a-recon', text: 'We want an extra $1,000 a month starting in March and can spend $250.', exp: { amount: 1000, monthly: true, deadline: '2027-03-31', capital: 250 } },
  { set: 'fm1126a-recon', text: "I'm in Tulsa with a pickup truck and my weekends are free. I want to make $200 this month with no money down.", exp: { amount: 200, deadline: '2026-11-30', capital: 0, hours: null } },
  // controls (plain phrasings the reader has always handled)
  { set: 'control', text: 'Make $10,000 in 30 days with a $2,000 budget and 10 hours a week.', exp: { amount: 10000, window: 30, capital: 2000, hpw: 10 } },
  { set: 'control', text: 'I want $5,000 in 90 days. I can invest $500.', exp: { amount: 5000, window: 90, capital: 500 } },
  // new paraphrases (not in tests/objectiveFreshPhrasings.test.ts nor the batch)
  { set: 'new', text: "I can only spare a couple of evenings a week. I'd like to make $1,500 by the end of January with no more than two grand.", exp: { amount: 1500, deadline: '2027-01-31', capital: 2000, hours: null } },
  { set: 'new', text: "Help me earn ten thousand bucks in the next three months; I won't do any selling myself and I've got $3k to put in.", exp: { amount: 10000, window: 90, capital: 3000, hours: null } },
  { set: 'new', text: 'I need 2k fast, within a fortnight. Zero budget. Maybe 6 hrs a week.', exp: { amount: 2000, window: 14, capital: 0, hpw: 6 } },
  { set: 'new', text: 'Target: $750/mo recurring by March 1st. Max spend $250. I work full time so maybe 5 hours weekly.', exp: { amount: 750, monthly: true, deadline: '2027-03-01', capital: 250, hpw: 5 } },
  { set: 'new', text: "I'd like to bring in about $8,000 before Christmas. I can put $1,200 toward it but I can't give it any time.", exp: { amount: 8000, deadline: '2026-12-25', capital: 1200, hours: 0 } },
  { set: 'new', text: 'Looking to net $600 this weekend. I have no money but plenty of time.', exp: { amount: 600, deadline: '2026-11-29', capital: 0, hours: null } },
  { set: 'new', text: 'Can you get me to $12k in revenue over the next 6 weeks? Budget is capped at $4k. Ten hours a week tops.', exp: { amount: 12000, window: 42, capital: 4000, hpw: 10 } },
  { set: 'new', text: "I want $3,000 in 45 days. I'm not putting a cent in.", exp: { amount: 3000, window: 45, capital: 0 } },
  { set: 'new', text: 'Earn $5k within 30 days, spending under $800, working no more than 2 hours a day.', exp: { amount: 5000, window: 30, capital: 800, hpw: 14 } },
  { set: 'new', text: "Half a grand in ten days, no upfront money, I'm free weekends only.", exp: { amount: 500, window: 10, capital: 0, hours: null } },
  { set: 'new', text: "I want twenty-five hundred dollars by New Year's Eve with a $300 budget.", exp: { amount: 2500, deadline: '2026-12-31', capital: 300 } },
  { set: 'new', text: "I can't spend more than $1k and can't work more than 8 hours total; goal is $2,000 in 3 weeks.", exp: { amount: 2000, window: 21, capital: 1000, hours: 8 } },
];
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86_400_000;
const rows = C.map(({ set, text, exp }) => {
  const r = readObjective(text, now);
  const capital = r.capitalCeiling ?? r.beforeProof ?? r.capitalAssumed?.amount ?? null;
  const span = r.windowDays ?? (r.deadline ? Math.round((Date.parse(r.deadline) - now.getTime()) / 86_400_000) : null);
  const verdict: Record<string, string> = {};
  const refused = r.kind !== 'CASH' || r.amount === null;
  if ('amount' in exp) verdict.amount = refused ? 'REFUSED' : r.amount === exp.amount ? 'OK' : `WRONG(${r.amount})`;
  if ('monthly' in exp) verdict.monthly = (r.recurring === 'MONTHLY') === exp.monthly ? 'OK' : `WRONG(${r.recurring})`;
  if ('window' in exp) verdict.window = span === null ? 'UNREAD' : Math.abs(span - exp.window!) <= 2 ? 'OK' : `WRONG(${span}d)`;
  if ('deadline' in exp) verdict.window = !r.deadline ? (span !== null ? `WRONG(span ${span}d)` : 'UNREAD') : dayDiff(r.deadline, exp.deadline!) <= 1 ? 'OK' : `WRONG(${r.deadline.slice(0, 10)})`;
  if ('capital' in exp) verdict.capital = capital === exp.capital ? 'OK' : capital === null ? 'UNREAD' : `WRONG(${capital})`;
  if ('hpw' in exp) verdict.hours = r.hoursPerWeek === exp.hpw ? 'OK' : `WRONG(hpw ${r.hoursPerWeek}, total ${r.hoursCeiling})`;
  else if ('hours' in exp) verdict.hours = r.hoursCeiling === exp.hours && (exp.hours !== null || r.hoursPerWeek === null) ? 'OK' : `WRONG(total ${r.hoursCeiling}, hpw ${r.hoursPerWeek})`;
  return { set, text, verdict, read: { kind: r.kind, amount: r.amount, recurring: r.recurring, deadline: r.deadline, windowDays: r.windowDays ?? null, capitalCeiling: r.capitalCeiling, beforeProof: r.beforeProof, capitalAssumed: r.capitalAssumed?.amount ?? null, hoursCeiling: r.hoursCeiling, hoursPerWeek: r.hoursPerWeek, unread: r.unread } };
});
const tally: Record<string, Record<string, number>> = {};
for (const row of rows) for (const [f, v] of Object.entries(row.verdict)) {
  const k = `${row.set}:${f}`;
  tally[k] ??= {};
  const cls = v.startsWith('WRONG') ? 'WRONG' : v;
  tally[k]![cls] = (tally[k]![cls] ?? 0) + 1;
}
write('raw/E-013/result.json', { rows, tally });
for (const r of rows) console.log(r.set.padEnd(14), JSON.stringify(r.verdict), '|', r.text.slice(0, 70), '|', JSON.stringify(r.read));
console.log(JSON.stringify(tally, null, 1));
