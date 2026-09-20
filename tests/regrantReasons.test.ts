/**
 * The reason codes `step10 regrant` accepts, held against the workflow that
 * has to pass them.
 *
 * §38 records why the codes are a closed set: a free-text reason is a caller
 * writing its own audit trail, and an audit row recording the wrong cause is
 * worse than one recording none. What that argument does not by itself
 * guarantee is that a code somebody adds can actually be *reached* — the
 * workflow accepts letters, digits, dash and underscore and refuses everything
 * else, so a code carrying a space, a dot or a slash would be unreachable at
 * exactly the moment an operator needed it, and the refusal would name the
 * argument rather than the code. §27 already has the sentence: a contract that
 * lies about its own inputs refuses work and says nothing.
 *
 * Nothing here judges whether a code's sentence is *true* of a bin — no test
 * can — so the failure mode this pins is the one a test can see.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = readFileSync(`${root}scripts/step10.ts`, 'utf8');
const workflow = readFileSync(`${root}.github/workflows/step10.yml`, 'utf8');

/**
 * The keys of the one `REASONS` map in the regrant command.
 *
 * Read from the source rather than imported, because the map is a local inside
 * a command branch — and reading it is the point: the thing being checked is
 * what a person can type, not what a module exports.
 */
function regrantReasonCodes(): string[] {
  const start = script.indexOf('const REASONS: Record<string, string> = {');
  expect(start, 'the regrant command still declares a closed REASONS map').toBeGreaterThan(-1);
  const end = script.indexOf('\n    };', start);
  expect(end, 'the REASONS map still closes at its own indentation').toBeGreaterThan(start);
  const block = script.slice(start, end);
  // Exactly six spaces, a quoted key, a colon, end of line. Comment lines in
  // this block are indented seven and begin with `*`, and the sentences are
  // continuation lines, so neither can be mistaken for a key.
  // Permissive between the quotes on purpose. A pattern that only matched
  // *valid* codes would skip an invalid one entirely and report nothing —
  // which is what the first version of this did, and it passed against a code
  // containing a space. A guard blind to the case it exists for reads as
  // coverage and is worse than none.
  return [...block.matchAll(/^ {6}'([^']*)':$/gm)].map((match) => match[1]!);
}

describe('the regrant reason codes', () => {
  it('has more than one, so choosing is a decision rather than a formality', () => {
    expect(regrantReasonCodes().length).toBeGreaterThan(1);
  });

  it('reads every key the map declares, including one it would refuse', () => {
    // The extractor is the half that can be silently wrong, so it is asserted
    // against the map's own count of top-level keys rather than trusted.
    const start = script.indexOf('const REASONS: Record<string, string> = {');
    const block = script.slice(start, script.indexOf('\n    };', start));
    const declared = [...block.matchAll(/^ {6}'/gm)].length;
    expect(regrantReasonCodes().length).toBe(declared);
  });

  it('can every one of them be typed into the workflow that calls this', () => {
    // The workflow's own guard, read from the workflow rather than restated:
    // a second copy of a character class is a second thing to forget.
    expect(workflow).toContain("''|*[!A-Za-z0-9_-]*)");
    const passable = /^[A-Za-z0-9_-]+$/;
    for (const code of regrantReasonCodes()) {
      expect(passable.test(code), `"${code}" would be refused by step10.yml before it arrived`).toBe(
        true,
      );
    }
  });

  it('gives each code a sentence of its own', () => {
    const codes = regrantReasonCodes();
    const start = script.indexOf('const REASONS: Record<string, string> = {');
    const block = script.slice(start, script.indexOf('\n    };', start));
    const sentences = codes.map((code) => {
      const at = block.indexOf(`'${code}':`);
      const next = codes
        .map((other) => block.indexOf(`'${other}':`))
        .filter((index) => index > at)
        .sort((a, b) => a - b)[0];
      return block
        .slice(at, next ?? block.length)
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
        .join(' ');
    });
    expect(new Set(sentences).size, 'two codes recording the same sentence record nothing').toBe(
      codes.length,
    );
  });
});
