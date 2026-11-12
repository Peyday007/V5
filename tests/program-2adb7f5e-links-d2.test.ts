import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guide = readFileSync('docs/FACTORY-PROGRAMS.md', 'utf8');
const checklist = readFileSync('docs/FACTORY-PROGRAMS-CHECKLIST.md', 'utf8');

describe('the Factory programs guide and checklist find each other (LINK-1)', () => {
  it('the guide links to the checklist as a markdown link', () => {
    expect(guide).toMatch(/\]\(FACTORY-PROGRAMS-CHECKLIST\.md\)/);
  });

  it('the checklist links back to the guide as a markdown link', () => {
    expect(checklist).toMatch(/\]\(FACTORY-PROGRAMS\.md\)/);
  });

  it('each link target is the other document, which exists beside it', () => {
    expect(guide).toContain('FACTORY-PROGRAMS-CHECKLIST.md');
    expect(checklist).toContain('(FACTORY-PROGRAMS.md)');
    expect(() => readFileSync('docs/FACTORY-PROGRAMS.md')).not.toThrow();
    expect(() => readFileSync('docs/FACTORY-PROGRAMS-CHECKLIST.md')).not.toThrow();
  });
});
