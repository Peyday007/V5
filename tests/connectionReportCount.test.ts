/**
 * RES-12c: the connection report's "need a person" is counted from the alerts
 * it prints, by who has to act — never from a narrower reading beside them.
 *
 * It used to print "connectors needing a person: 0", from connector consent
 * alone, directly above alerts naming an account owner (a wrong worker) and an
 * operator (an out-of-scope account). Who acts is `connectionAlerts`' decision;
 * this only counts it.
 */
import { describe, expect, it } from 'vitest';
import { countAlertsNeedingAPerson } from '../scripts/connection-report.ts';

describe('the connection report counts what it shows', () => {
  it('counts every alert a person must act on, and none Brain is handling', () => {
    const counted = countAlertsNeedingAPerson([
      { who: 'ACCOUNT_OWNER' },
      { who: 'ACCOUNT_OWNER' },
      { who: 'OPERATOR' },
      { who: 'NOBODY' },
    ]);
    expect(counted).toEqual({ total: 3, accountOwner: 2, operator: 1, nobody: 1 });
  });

  it('says zero only when no alert names a person', () => {
    expect(countAlertsNeedingAPerson([{ who: 'NOBODY' }])).toEqual({ total: 0, accountOwner: 0, operator: 0, nobody: 1 });
    expect(countAlertsNeedingAPerson([])).toEqual({ total: 0, accountOwner: 0, operator: 0, nobody: 0 });
  });

  it('is importable without running the report', async () => {
    // The script ran `main()` on import, which opened a database; the guard
    // means a test (and anything else) can read its rule without that.
    const mod = await import('../scripts/connection-report.ts');
    expect(typeof mod.countAlertsNeedingAPerson).toBe('function');
  });
});

describe('the early warning reads only what preceded past quarantines', () => {
  const quiet = { name: 'R', unansweredSinceArrival: 0, fires24h: 10, arrivals24h: 9, quarantinedSiblings: [] };
  it('says nothing about a Routine that is answering', async () => {
    const { warningsFor } = await import('../scripts/connection-report.ts');
    expect(warningsFor(quiet)).toEqual([]);
    // Too few fires to call a ratio.
    expect(warningsFor({ ...quiet, fires24h: 3, arrivals24h: 0 })).toEqual([]);
  });
  it('names each sign that preceded a quarantine', async () => {
    const { warningsFor } = await import('../scripts/connection-report.ts');
    const w = warningsFor({ name: 'R', unansweredSinceArrival: 1, fires24h: 6, arrivals24h: 2, quarantinedSiblings: ['S'] });
    expect(w.map((x) => x.split(' ')[0])).toEqual(['FIRST_NO_SHOW', 'SIBLING_DOWN', 'FEW_ARRIVALS']);
  });
});
