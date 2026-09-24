import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFECT_CEILING,
  DEFECT_MIN_SAMPLE,
  isSystematicDefect,
  specFor,
} from '../server/services/puzzle/generate.ts';
import { formatFor } from '../server/services/puzzle/formats/index.ts';
import type { PuzzleMaster } from '../server/domain/types.ts';

/**
 * Deploy 336's test gate made two word searches out of twenty-five and stopped,
 * recording "a defect in the generator … rather than a run of bad luck" about a
 * generator that fails about 3% of the time. It was two unlucky seeds in the
 * first four. These pin that a rate is judged over a sample large enough to be
 * one, in both directions.
 */
describe('a batch stops for a defect, never for bad luck', () => {
  it('does not call two failures in four attempts a defect', () => {
    expect(isSystematicDefect(2, 4, 75)).toBe(false);
    expect(isSystematicDefect(2, 5, 75)).toBe(false);
    expect(isSystematicDefect(3, 8, 75)).toBe(false);
  });

  it('still names a generator that genuinely fails, once the sample is a sample', () => {
    expect(isSystematicDefect(DEFECT_MIN_SAMPLE, DEFECT_MIN_SAMPLE, 75)).toBe(true);
    const over = Math.floor(DEFECT_MIN_SAMPLE * DEFECT_CEILING) + 1;
    expect(isSystematicDefect(over, DEFECT_MIN_SAMPLE, 75)).toBe(true);
  });

  it('judges a small batch at its own ceiling, so a broken generator is never silent', () => {
    expect(isSystematicDefect(3, 3, 3)).toBe(true);
    expect(isSystematicDefect(0, 3, 3)).toBe(false);
  });

  it('a healthy word search generator is not stopped across many masters', () => {
    const format = formatFor('word search');
    expect(format?.render).toBeTruthy();
    let blocked = 0;
    let invalid = 0;
    let total = 0;
    for (let run = 0; run < 200; run += 1) {
      const master = {
        id: `pzm_${randomBytes(10).toString('hex')}`,
        formatKey: 'word search',
        corpusId: 'common-english-v1',
        generatorVersion: 1,
        difficulty: 'MEDIUM',
        parameters: {},
      } as unknown as PuzzleMaster;
      let bad = 0;
      for (let index = 0; index < 25; index += 1) {
        total += 1;
        const verdict = format!.validate(format!.render!(specFor(master, index)));
        if (verdict.state === 'INVALID') {
          bad += 1;
          invalid += 1;
          if (isSystematicDefect(bad, index + 1, 75)) {
            blocked += 1;
            break;
          }
        }
      }
    }
    // The measurement this rule rests on, asserted so it cannot drift silently.
    expect(invalid / total).toBeLessThan(0.1);
    expect(blocked).toBe(0);
  });
});
