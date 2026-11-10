/**
 * §100: every change class Brain recognizes has a live recognizer.
 *
 * The register (`server/domain/changeRecognition.ts`) names an existing
 * function and the running file that calls it. This fails when a recognizer is
 * renamed, deleted, or quietly unhooked from its loop — the failure that leaves
 * a change invisible while every reading still looks correct.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGE_RECOGNIZERS, type ChangeClass } from '../server/domain/changeRecognition.ts';

const CLASSES: ChangeClass[] = [
  'CONNECTORS_ROUTINES_WORKERS',
  'CREDENTIALS_PERMISSIONS_CONFIG',
  'PROVIDERS_GPU_CAPACITY',
  'FACTORY_CAMPAIGNS_DEPENDENCIES',
  'RESEARCH_OPPORTUNITIES_COMMERCIAL',
  'RESOURCES_BUDGETS_CONSTRAINTS',
  'IDLE_CAPACITY',
];

describe('§100 change recognition register', () => {
  it('covers every change class the owner named', () => {
    for (const c of CLASSES) expect(CHANGE_RECOGNIZERS.some((r) => r.changeClass === c)).toBe(true);
  });

  it.each(CHANGE_RECOGNIZERS.map((r) => [`${r.exportName} (${r.module})`, r] as const))(
    '%s exists and is called from its loop',
    async (_label, r) => {
      const mod = (await import(`../${r.module}`)) as Record<string, unknown>;
      expect(typeof mod[r.exportName]).toBe('function');
      const caller = readFileSync(r.calledFrom, 'utf8');
      // A call (or handed to one as a callback), not a mention in a comment or an import.
      expect(caller).toMatch(new RegExp(`\\b${r.exportName}\\s*\\(|\\(\\s*${r.exportName}\\s*\\)`));
      if (r.calledFrom === r.module) {
        // Self-scheduled: the module must call it beyond its own definition.
        expect(caller.match(new RegExp(`\\b${r.exportName}\\s*\\(`, 'g'))!.length).toBeGreaterThan(1);
      }
    },
  );

  it('justifies every periodic check, because an event is the default', () => {
    for (const r of CHANGE_RECOGNIZERS.filter((one) => one.trigger === 'PERIODIC')) {
      expect(r.why, r.exportName).toBeTruthy();
    }
  });
});
