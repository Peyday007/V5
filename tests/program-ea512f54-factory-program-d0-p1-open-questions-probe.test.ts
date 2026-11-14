/**
 * GOV-11's fixed check is `probe r01.gov-11({}) passes`. A probe is the exam a
 * requirement is judged by, so it lives under the protected verification path
 * (domain/factoryProgram.ts PROTECTED_VERIFICATION_PATHS) where no implementing
 * campaign can write or weaken it (§96). This pins that the open-questions
 * module — implementation, not verification — registers no probe of its own,
 * and that it exports the production read the verification owner's probe calls.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROTECTED_VERIFICATION_PATHS } from '../server/domain/factoryProgram.ts';
import * as openQuestions from '../server/services/goals/openQuestions.ts';

const SOURCE = 'server/services/goals/openQuestions.ts';

describe('probe r01.gov-11 is not the implementer\'s own exam', () => {
  it('the open-questions module is outside the protected verification paths', () => {
    const covered = PROTECTED_VERIFICATION_PATHS.some((pattern) =>
      pattern.endsWith('/**') ? SOURCE.startsWith(pattern.slice(0, -2)) : SOURCE === pattern,
    );
    expect(covered).toBe(false);
  });

  it('registers no probe: neither imports registerProbe nor calls it', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(source).not.toMatch(/\bregisterProbe\b/);
  });

  it('exports the production read the verification owner\'s probe calls, and the goals tick still loads the module', () => {
    expect(typeof openQuestions.checkRegisterOnProduction).toBe('function');
    expect(readFileSync('server/services/goals/tick.ts', 'utf8')).toMatch(/from '\.\/openQuestions\.ts'/);
  });
});
