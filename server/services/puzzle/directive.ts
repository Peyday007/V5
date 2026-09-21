/**
 * The directive, read rather than hashed.
 *
 * ---------------------------------------------------------------------------
 * The defect this module exists to close
 * ---------------------------------------------------------------------------
 *
 * §39 records it at a manufacturing programme and the shape is identical here.
 * A kernel that names `blueprints/PUZZLE-PRODUCTS-KERNEL.md` and stores the
 * sha-256 of its bytes has proved **integrity** and nothing else: integrity
 * says the file has not changed, and says nothing about whether one word of it
 * ever reached a worker. Left at that, the directive's core principle, its
 * honesty rule about reskins, its quality standard and its rights standard sit
 * in a file the deployed Brain copies into its image and never opens — and the
 * whole of what a worker is actually told comes from one sentence somebody
 * typed at start.
 *
 * So the file is **parsed into a brief**, and the brief's own sentences are
 * what `questions.ts` carries into every assignment. A test drives the kernel
 * to an opened work item and asserts the directive's words are in the
 * assignment a worker would read; it fails if the hash keeps being written
 * while the contents stop arriving, which is the exact failure a hash cannot
 * detect.
 *
 * ---------------------------------------------------------------------------
 * The seed lists, and the one thing this must not do with them
 * ---------------------------------------------------------------------------
 *
 * The directive names a long list of puzzle formats and then says, in its own
 * words, *seed — but do not permanently limit* and *continuously expand this
 * universe from evidence*. Both halves are load-bearing. Dropping the list
 * loses real discovery intelligence — crosswords through to mechanical
 * brainteasers is a genuine spread of scale and a genuine set of search seeds.
 * Treating it as the taxonomy answers the question the kernel exists to ask.
 *
 * So `universeSeed` returns the list **and its own refusal to be a limit as
 * one string**, which is what stops any caller printing a bounded taxonomy.
 * The seeds reach exactly two places: the opening question, as a spread to
 * search across, and the surface, as illustrations. They are never rows, never
 * an ordering, and nothing anywhere compares a format to one. This repository
 * still contains no list of puzzle formats in code, and
 * `tests/puzzleKernel.test.ts` reads the source to say so.
 *
 * ---------------------------------------------------------------------------
 * A missing section is a visible failure
 * ---------------------------------------------------------------------------
 *
 * Every getter below refuses rather than returning an empty string. A brief
 * that quietly lost its core principle would produce questions that read
 * almost right, and the kernel would go on running against a directive it had
 * stopped carrying — which is the silent half of the same defect.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from '../../env.ts';

export const BLUEPRINT_DIR = 'blueprints';
export const PUZZLE_DIRECTIVE_PATH = 'blueprints/PUZZLE-PRODUCTS-KERNEL.md';

/**
 * The sections a brief cannot be composed without.
 *
 * Declared rather than discovered, so a directive that lost one fails at the
 * moment it is read with the section named, instead of producing an assignment
 * missing the half that mattered.
 */
export const REQUIRED_SECTIONS = [
  'OBJECTIVE',
  'CORE PRINCIPLE',
  'LEVERAGE',
  'VALUE CHAIN',
  'PUZZLE UNIVERSE SEED',
  'MONETIZATION LEDGER',
  'QUALITY STANDARD',
  'RIGHTS STANDARD',
  'PROOF LADDER',
  'PHYSICAL PRODUCTION LADDER',
  'CHEAP BOOK INVESTIGATION',
  'AUTHORITY',
  'MATURITY VOCABULARY',
  'PRIME DIRECTIVE',
] as const;
export type DirectiveSection = (typeof REQUIRED_SECTIONS)[number];

export interface PuzzleDirective {
  path: string;
  digest: string;
  bytes: number;
  sections: ReadonlyMap<string, string>;
}

export type DirectiveRead =
  | { ok: true; directive: PuzzleDirective }
  | { ok: false; reason: string };

/** Headings to bodies, by the heading's own text. `##` and `###` alike. */
function splitSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (heading) out.set(heading, body.join('\n').trim());
    body = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const match = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = (match[1] ?? '').replace(/^\d+\.\s*/, '').trim().toUpperCase();
      continue;
    }
    body.push(line);
  }
  flush();
  return out;
}

export async function readPuzzleDirective(
  relativePath: string = PUZZLE_DIRECTIVE_PATH,
): Promise<DirectiveRead> {
  let raw: string;
  const absolute = join(REPO_ROOT, relativePath);
  try {
    raw = await readFile(absolute, 'utf8');
  } catch {
    return {
      ok: false,
      reason:
        `The directive at ${relativePath} could not be read. Nothing here runs without it: a ` +
        'kernel that carried only its hash would be one whose questions had quietly stopped ' +
        'saying what it was asked to do.',
    };
  }

  const sections = splitSections(raw);
  const missing = REQUIRED_SECTIONS.filter((name) => !(sections.get(name) ?? '').trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `The directive at ${relativePath} is missing ${missing.join(', ')}. A brief that lost a ` +
        'section would produce questions that read almost right, which is worse than a refusal ' +
        'somebody can see.',
    };
  }

  return {
    ok: true,
    directive: {
      path: relativePath,
      digest: createHash('sha256').update(raw, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(raw, 'utf8'),
      sections,
    },
  };
}

/** One section's body, refusing rather than returning nothing. */
export function section(directive: PuzzleDirective, name: DirectiveSection): string {
  const body = directive.sections.get(name);
  if (!body || !body.trim()) {
    throw new Error(
      `The directive has no ${name} section. Every question this kernel asks carries one, and ` +
        'a brief composed without it would be a question about something else.',
    );
  }
  return body.trim();
}

/**
 * A bounded excerpt of one section, ending at a sentence boundary.
 *
 * Bounded because an assignment carrying six paragraphs of directive is one a
 * worker skims. Ending at a sentence because a brief cut mid-clause reads as
 * an instruction that trails off — §27's truncation lesson at a prompt rather
 * than at a submission, and with the same failure mode: it arrives looking
 * like the whole thing.
 */
export function brief(
  directive: PuzzleDirective,
  name: DirectiveSection,
  maxChars = 700,
): string {
  const body = section(directive, name).replace(/\s+/g, ' ').trim();
  if (body.length <= maxChars) return body;
  const cut = body.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > maxChars / 3 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

/**
 * The format seeds **and** the directive's own refusal to be limited by them,
 * as one string.
 *
 * One string on purpose: a caller that took the list alone would print a
 * bounded taxonomy, which is exactly what §39 had to correct at a
 * manufacturing pyramid. The refusal travels with the list because the two are
 * one statement.
 */
export function universeSeed(directive: PuzzleDirective): string {
  return brief(directive, 'PUZZLE UNIVERSE SEED', 1200);
}

/** The ledger seeds, the same way and for the same reason. */
export function ledgerSeed(directive: PuzzleDirective): string {
  return brief(directive, 'MONETIZATION LEDGER', 1400);
}
