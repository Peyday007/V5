/**
 * A repair that inherits a glob reaching a forbidden file is given the files the
 * glob matches less the forbidden ones (production 2026-11-12, authority-d0-p0:
 * `server/repos/**` reached `server/repos/factoryRelease.ts` and every repair was refused).
 */
import { describe, expect, it } from 'vitest';
import { ownedPathsClearOf, ownershipReachesForbidden } from '../server/services/factory/forbidden.ts';

describe('owned paths held clear of the forbidden ones', () => {
  it('lists a glob that reaches a forbidden file out as its files, less that file', () => {
    const forbidden = ['server/repos/factoryRelease.ts'];
    const owned = ownedPathsClearOf(['server/repos/**', 'tests/x.test.ts'], forbidden);
    expect(owned).toContain('tests/x.test.ts');
    expect(owned).toContain('server/repos/cashLedger.ts');
    expect(owned).not.toContain('server/repos/factoryRelease.ts');
    expect(owned).not.toContain('server/repos/**');
    for (const path of owned) expect(ownershipReachesForbidden(path, forbidden)).toBeNull();
  });

  it('leaves a glob clear of every forbidden path, and a concrete path, as written', () => {
    expect(ownedPathsClearOf(['server/services/cash/**', 'server/repos/cashLedger.ts'], ['server/repos/factoryRelease.ts']))
      .toEqual(['server/services/cash/**', 'server/repos/cashLedger.ts']);
  });

  it('leaves a glob with nothing under it as written, for the validator to refuse with its reason', () => {
    expect(ownedPathsClearOf(['nowhere/**'], ['nowhere/secret.ts'])).toEqual(['nowhere/**']);
  });
});
