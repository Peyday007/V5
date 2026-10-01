import { describe, expect, it } from 'vitest';
import { buildNames, sanitizeFilename } from '../server/domain/naming.ts';

describe('sanitizeFilename edges', () => {
  it('leaves no trailing space or dot after truncating to 180', () => {
    const out = sanitizeFilename(`${'a'.repeat(179)} b`);
    expect(out).toBe('a'.repeat(179));
    expect(sanitizeFilename(`${'a'.repeat(179)}.b`)).toBe('a'.repeat(179));
  });

  it('keeps buildNames from producing a name ending in a space before the extension', () => {
    const { filename } = buildNames('a'.repeat(170), 'v1', '.pdf', 'x'.repeat(5));
    expect(filename).not.toMatch(/[ .]\.pdf$/);
  });

  it.each(['CON.txt', 'LPT1.pdf', 'nul.tar.gz', 'aux', 'COM3.log'])('rewrites reserved device name %s', (name) => {
    expect(sanitizeFilename(name)).toBe(`_${name}`);
  });

  it('leaves ordinary names unchanged', () => {
    expect(sanitizeFilename('Qualification Logic v3.1')).toBe('Qualification Logic v3.1');
    expect(sanitizeFilename('console.log')).toBe('console.log');
    expect(buildNames('Qualification Logic', 'v3.1').filename).toBe('Qualification Logic v3.1.pdf');
  });
});
