import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The closeout report decides success by grepping the command's output for a
 * marker. A marker of `.` matches any output at all — a stack trace included —
 * so on 2026-10-13 a `campaigns` read that died on `ECHECKOUTTIMEOUT` before
 * printing a row went green. Every marker must be a line only success prints.
 */
describe('closeout-report markers', () => {
  const text = readFileSync('.github/workflows/closeout-report.yml', 'utf8');
  const markers = [...text.matchAll(/marker='([^']*)'/g)].map((m) => m[1]!);

  it('reads every marker the workflow declares', () => {
    expect(markers.length).toBeGreaterThanOrEqual(12);
  });

  it('declares no marker that a failure would also match', () => {
    for (const marker of markers) {
      expect(marker, `marker '${marker}'`).not.toBe('.');
      expect(marker.length, `marker '${marker}'`).toBeGreaterThan(3);
      for (const failure of [
        'PACKET-REPORT: FAILED',
        'DatabaseConfigurationError: Brain is configured for Postgres but could not reach',
      ]) {
        expect(new RegExp(marker, 'm').test(failure), `marker '${marker}' on '${failure}'`).toBe(false);
      }
    }
  });
});
