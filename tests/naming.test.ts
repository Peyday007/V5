import { describe, expect, it } from 'vitest';
import {
  buildCanonicalName,
  buildNames,
  filenameForDocument,
  finalNamingCheckBlock,
  namesMatch,
  namingRulesBlock,
  sanitizeFilename,
} from '../server/domain/naming.ts';

describe('buildNames', () => {
  it('produces the spec example exactly', () => {
    const names = buildNames('Qualification Logic', 'v3.1');
    expect(names.canonicalName).toBe('Qualification Logic v3.1');
    expect(names.conversationTitle).toBe('Qualification Logic v3.1');
    expect(names.filename).toBe('Qualification Logic v3.1.pdf');
  });

  it('normalises the version inside the name', () => {
    expect(buildCanonicalName('Discovery Logic', 'V1g')).toBe('Discovery Logic v1G');
  });

  it('keeps all three names in lockstep', () => {
    const names = buildNames('Decision Routing Rules', 'v1F');
    expect(names.conversationTitle).toBe(names.canonicalName);
    expect(names.filename).toBe(`${names.canonicalName}.pdf`);
  });
});

describe('sanitizeFilename', () => {
  it('strips characters filesystems reject', () => {
    expect(sanitizeFilename('World/Model: v1?')).toBe('World Model v1');
  });

  it('never returns an empty or reserved name', () => {
    expect(sanitizeFilename('   ')).toBe('untitled');
    expect(sanitizeFilename('con')).toBe('_con');
  });
});

describe('filenameForDocument', () => {
  it('keeps the original extension but takes the platform name', () => {
    // The platform controls the filename; the model's report title is ignored.
    expect(filenameForDocument('Discovery Logic v1G', 'Deep Research Report FINAL (3).PDF'))
      .toBe('Discovery Logic v1G.pdf');
    expect(filenameForDocument('Discovery Logic v1G', 'notes.md')).toBe('Discovery Logic v1G.md');
  });
});

describe('namesMatch', () => {
  it('ignores case and whitespace noise but not emptiness', () => {
    expect(namesMatch('Discovery Logic v1G', '  discovery   logic V1G ')).toBe(true);
    expect(namesMatch('', '')).toBe(false);
    expect(namesMatch(null, 'x')).toBe(false);
  });
});

describe('prompt naming blocks', () => {
  it('states the exact required names', () => {
    const names = buildNames('Monetization Logic', 'v1D');
    const rules = namingRulesBlock(names);
    expect(rules).toContain('Monetization Logic v1D');
    expect(rules).toContain('Monetization Logic v1D.pdf');
    expect(rules).toContain('NON-NEGOTIABLE');

    const check = finalNamingCheckBlock(names);
    expect(check).toContain('FINAL NAMING CHECK');
    expect(check).toContain('Monetization Logic v1D');
  });
});
