/**
 * The goals script reads plans in the released container, so it must register
 * the commercial providers the server registers at boot. Production
 * 2026-11-20 (goal wst_db2e…, run 44740200419): every outreach step of the
 * plan read printed "Instantly is not connected, and only the owner can supply
 * its credential" while the same read measured 930 sends a day on 12 healthy
 * Instantly accounts. The script had never called registerCommercialProviders,
 * so the messaging capability read MISSING in the script and PRESENT in the
 * server. General rule: every entry point that judges a capability registers
 * the providers first.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// scripts/goals.ts is only the entry point; the commands run in scripts/goalsCli.ts.
const ENTRY_POINTS = ['scripts/goalsCli.ts', 'scripts/cash-report.ts', 'server/index.ts'];

describe('an entry point that reads plans registers the commercial providers', () => {
  for (const file of ENTRY_POINTS) {
    it(`${file} calls registerCommercialProviders`, () => {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toMatch(/registerCommercialProviders\(\)/);
    });
  }

  it('the goals script registers them in main, before any command runs', () => {
    const text = fs.readFileSync('scripts/goalsCli.ts', 'utf8');
    const main = text.slice(text.indexOf('async function main()'));
    const register = main.indexOf('registerCommercialProviders()');
    const dispatch = main.indexOf('switch (command)');
    expect(register).toBeGreaterThan(0);
    expect(register).toBeLessThan(dispatch);
  });
});
