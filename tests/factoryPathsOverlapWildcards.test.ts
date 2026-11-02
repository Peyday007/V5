import { describe, expect, it } from 'vitest';

import { pathsOverlap } from '../server/repos/factory.ts';
import { ownershipReachesForbidden } from '../server/services/factory/forbidden.ts';

describe('pathsOverlap wildcards and normalisation', () => {
  it('treats ? as a wildcard', () => {
    expect(pathsOverlap(['src/?.ts'], ['src/a.ts'])).toBe(true);
  });
  it('treats [ and { as wildcards', () => {
    expect(pathsOverlap(['src/[ab].ts'], ['src/a.ts'])).toBe(true);
    expect(pathsOverlap(['src/{a,b}.ts'], ['src/a.ts'])).toBe(true);
  });
  it('ignores a leading ./', () => {
    expect(pathsOverlap(['./src/a.ts'], ['src/**'])).toBe(true);
    expect(pathsOverlap(['././src/a.ts'], ['src/a.ts'])).toBe(true);
  });
  it('normalises backslash separators', () => {
    expect(pathsOverlap(['src\\a.ts'], ['src/**'])).toBe(true);
  });
  it('keeps unrelated paths apart', () => {
    expect(pathsOverlap(['server/repos/factory.ts'], ['server/services/factory/**'])).toBe(false);
    expect(pathsOverlap(['src/a/?.ts'], ['src/b/c.ts'])).toBe(false);
  });
  it('an empty stem overlaps everything', () => {
    expect(pathsOverlap(['**'], ['src/a.ts'])).toBe(true);
    expect(pathsOverlap(['?'], ['src/a.ts'])).toBe(true);
  });
  it('refuses ownership reaching a forbidden glob through ?', () => {
    expect(ownershipReachesForbidden('.git?ub/**', ['.github/**'])).toBe('.github/**');
  });
});
