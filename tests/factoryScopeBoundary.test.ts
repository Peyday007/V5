import { describe, expect, it } from 'vitest';
import { narrowsOrEqual } from '../server/services/factory/contract.ts';

describe('narrowsOrEqual scope boundary', () => {
  it('refuses a sibling that merely shares a string prefix with a file', () => {
    expect(narrowsOrEqual(['client/src/Home.tsx.bak'], ['client/src/Home.tsx'])).toBe(false);
  });
  it('refuses a sibling directory that shares a prefix', () => {
    expect(narrowsOrEqual(['sites/v4-private/**'], ['sites/v4'])).toBe(false);
  });
  it('accepts an exact file and paths beneath a directory entry', () => {
    expect(narrowsOrEqual(['client/src/Home.tsx'], ['client/src/Home.tsx'])).toBe(true);
    expect(narrowsOrEqual(['sites/v4/a.ts'], ['sites/v4'])).toBe(true);
    expect(narrowsOrEqual(['sites/v4/**'], ['sites/v4'])).toBe(true);
  });
  it('a directory entry written with a trailing slash admits what is beneath it, and still no sibling', () => {
    expect(narrowsOrEqual(['docs/x.md'], ['docs/'])).toBe(true);
    expect(narrowsOrEqual(['docs/a/b.md'], ['docs/'])).toBe(true);
    expect(narrowsOrEqual(['docs/**'], ['docs/'])).toBe(true);
    expect(narrowsOrEqual(['docs'], ['docs/'])).toBe(true);
    expect(narrowsOrEqual(['docs-private/x.md'], ['docs/'])).toBe(false);
    expect(narrowsOrEqual(['docsx'], ['docs/'])).toBe(false);
  });
  it('an entry of only slashes is never read as the allow-everything shortcut', () => {
    expect(narrowsOrEqual(['src/x.ts'], ['/'])).toBe(false);
    expect(narrowsOrEqual(['src/x.ts'], ['//'])).toBe(false);
  });
  it('keeps glob stems working', () => {
    expect(narrowsOrEqual(['src/x.ts'], ['src/**'])).toBe(true);
    expect(narrowsOrEqual(['src/a/**'], ['src/**'])).toBe(true);
    expect(narrowsOrEqual(['lib/x.ts'], ['src/**'])).toBe(false);
  });
  it('keeps the ** shortcut', () => {
    expect(narrowsOrEqual(['anything/at/all.ts'], ['**'])).toBe(true);
  });
  it('still refuses absolute and climbing paths', () => {
    expect(narrowsOrEqual(['/etc/passwd'], ['**'])).toBe(false);
    expect(narrowsOrEqual(['src/../x'], ['**'])).toBe(false);
  });
});
