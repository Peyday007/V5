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
