import { describe, expect, it } from 'vitest';
import { containsAddress, looksLikeAddress, personName, refuseAddressAsName } from '../server/domain/personName.ts';

describe('a display name never carries an address', () => {
  it('strips a bracketed address and keeps the name', () => {
    expect(personName({ displayName: 'Rosser Peyton <rosserpeyton@gmail.com>' })).toBe('Rosser Peyton');
  });

  it('strips mailto: and trailing punctuation', () => {
    expect(personName({ displayName: 'Ann mailto:ann@example.com.' })).toBe('Ann');
    expect(personName({ displayName: 'Ann (ann@example.com),' })).toBe('Ann');
  });

  it('falls back to the local part when nothing else is left', () => {
    expect(personName({ displayName: 'mailto:a@b.com' })).toBe('a');
    expect(personName({ displayName: '<a@b.com>' })).toBe('a');
    expect(personName({ displayName: 'rosserpeyton@gmail.com' })).toBe('rosserpeyton');
  });

  it('refuses a name that contains an address', () => {
    for (const name of ['Rosser <r@x.com>', 'mailto:a@b.com', 'a@b.com', 'me a@b.com']) {
      expect(containsAddress(name)).toBe(true);
      expect(() => refuseAddressAsName(name)).toThrow();
    }
  });

  it('leaves names that merely contain an @ alone', () => {
    for (const name of ['DJ @ Night', '@handle', 'a@b', 'a@@b.com', 'Caleb']) {
      expect(containsAddress(name)).toBe(false);
      expect(personName({ displayName: name })).toBe(name);
      expect(() => refuseAddressAsName(name)).not.toThrow();
    }
  });

  it('keeps looksLikeAddress narrow', () => {
    expect(looksLikeAddress('Rosser <r@x.com>')).toBe(false);
    expect(looksLikeAddress('r@x.com')).toBe(true);
  });
});
