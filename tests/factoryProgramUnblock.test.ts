import { describe, expect, it } from 'vitest';
import { widenScope } from '../server/services/factory/program/unblock.ts';

describe('widening a campaign scope', () => {
  it('widens files to their directory, keeps globs, and never reaches the program verification code', () => {
    expect(widenScope(['server/services/cash/funnel.ts', 'server/services/quant/mechanism.ts', 'client/src/world/**', 'tests/program-x-y*.test.ts']))
      .toEqual(['client/src/world/**', 'server/services/cash/**', 'server/services/quant/**', 'tests/program-x-y*.test.ts']);
    expect(widenScope(['server/domain/factoryProgram.ts', 'server/services/factory/program/probes.ts', 'server/services/factory/release/outcome.ts']))
      .toEqual(['server/domain/factoryProgram.ts', 'server/services/factory/program/probes.ts', 'server/services/factory/release/**']);
  });
});
