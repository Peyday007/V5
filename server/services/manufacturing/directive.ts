/**
 * The directive, read rather than hashed.
 *
 * ---------------------------------------------------------------------------
 * The defect this module exists to close
 * ---------------------------------------------------------------------------
 *
 * A programme that names `blueprints/MANUFACTURING-EMPIRE-KERNEL.md` and
 * records the sha-256 of its bytes has proved **integrity** and nothing else.
 * Integrity says the file has not changed; it says nothing about whether one
 * word of it ever reached a worker. Without this module the directive's own
 * core principle, its evaluation dimensions, its compounding questions, its
 * vertical-integration tests and its scale bands lived in a file the deployed
 * Brain copied into its image and never opened — and the whole of what a
 * worker was actually told came from one sentence a person typed at start.
 *
 * So the file is **parsed into a brief**, and the brief's own sentences are
 * what the questions in `questions.ts` carry. A test drives a programme to an
 * opened work item and asserts the directive's words are in the assignment a
 * worker would read; it fails if the hash keeps being written while the
 * contents stop arriving, which is the exact failure a hash cannot detect.
 *
 * ---------------------------------------------------------------------------
 * The pyramid, and the one thing this must not do with it
 * ---------------------------------------------------------------------------
 *
 * The directive names six levels and then says, in its own capitals, that they
 * are **examples, NOT mandatory sequencing** and that the kernel must not
 * follow 1 → 2 → 3 → 4 → 5 → 6. Both halves are load-bearing, and the earlier
 * reading took only one of them: erasing the levels entirely lost real
 * discovery intelligence, because *pressure washers through to cargo aircraft*
 * is a genuine spread of scale and a genuine set of search seeds.
 *
 * What is built here is the narrow thing that keeps both. The bands are
 * **parsed from the file, never declared in code** — so this repository still
 * contains no list of machine categories, and `manufacturingKernel` still
 * reads the source to say so. They reach exactly two places: the opening
 * question, as a *spread to search across* with the directive's own refusal of
 * sequencing carried beside them, and the surface, as *illustrations of scale*.
 * They are never rows, never an ordering, never a `level` column, and nothing
 * anywhere compares a category to one. `bands` is deliberately not exported as
 * an ordered promise — the order is the file's, and it is printed with the
 * refusal attached because the two are one statement.
 *
 * ---------------------------------------------------------------------------
 * A section that is missing is a boot-visible failure
 * ---------------------------------------------------------------------------
 *
 * Every getter below refuses rather than returning an empty list. A brief that
 * quietly lost its core principle would produce questions that read almost
 * right, and the kernel would go on running against a directive it had stopped
 * carrying — which is the silent half of the same defect. `readDirective`
 * throws with the section it could not find, and the caller reports it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../../env.ts';

/** Where a directive may live, and the only place one is read from. */
export const BLUEPRINT_DIR = 'blueprints';

/**
 * One level of the directive's example pyramid.
 *
 * A *band*, not a rung: nothing orders them, nothing ranks by them, and
 * nothing decides anything from `ordinal` — it is carried so the spread can be
 * printed in the file's own order, which is how a person reads a spread.
 */
export interface ScaleBand {
  ordinal: number;
  name: string;
  examples: string;
}

/** One of the directive's evaluation dimensions, with what it asks for. */
export interface EvaluationDimension {
  name: string;
  considerations: string;
}

export interface Directive {
  /** The path as given, relative to the repository root. */
  path: string;
  sha256: string;
  /** Bytes, so a caller can record a length without re-reading the file. */
  bytes: number;
  /** The eight steps before "THEN manufacture", in the directive's own words. */
  corePrinciple: string[];
  /** The one sentence that says which way the pull runs. */
  pullStatement: string;
  /** The seven capability-compounding questions, verbatim. */
  compounding: string[];
  /** DEMAND, ECONOMICS, ENTRY, DISTRIBUTION, STRATEGIC VALUE. */
  evaluation: EvaluationDimension[];
  /** The example pyramid as a spread, never as a sequence. */
  bands: ScaleBand[];
  /** The directive's own refusal of its own sequence, verbatim. */
  sequencingRefusal: string;
  /** What the directive says should decide a vertical-integration question. */
  integrationTests: string;
  /** The master-brand constraint, which is a decision and not a research task. */
  brandConstraint: string;
}

export type DirectiveRead = { ok: true; directive: Directive } | { ok: false; reason: string };

/**
 * Read and parse a directive at a repository-relative path.
 *
 * The path is confined to `blueprints/` and a path that climbs is refused
 * rather than normalized into something that happens to be safe — §18's rule,
 * at a file a caller names. Nothing about this trusts a hash a caller
 * supplied: the sha-256 is computed here from the bytes actually opened, which
 * is the only way a provenance column can mean anything afterwards.
 */
export async function readDirective(relativePath: string): Promise<DirectiveRead> {
  const cleaned = relativePath.replace(/\\/g, '/').trim();
  if (!cleaned) return { ok: false, reason: 'No directive path was given.' };
  if (path.isAbsolute(cleaned) || cleaned.split('/').includes('..')) {
    return {
      ok: false,
      reason:
        `A directive is named by a path inside ${BLUEPRINT_DIR}/, relative to the repository ` +
        'root. An absolute path, or one that climbs out, is refused rather than resolved.',
    };
  }
  if (!cleaned.startsWith(`${BLUEPRINT_DIR}/`)) {
    return {
      ok: false,
      reason: `A directive must live under ${BLUEPRINT_DIR}/. "${cleaned}" does not.`,
    };
  }

  let text: string;
  try {
    text = await readFile(path.join(REPO_ROOT, cleaned), 'utf8');
  } catch {
    return {
      ok: false,
      reason:
        `No directive is readable at ${cleaned}. In a deployed Brain that means the file was ` +
        'not copied into the image; see the Dockerfile.',
    };
  }

  const parsed = parse(text);
  if (!parsed.ok) return { ok: false, reason: `${cleaned}: ${parsed.reason}` };

  return {
    ok: true,
    directive: {
      ...parsed.value,
      path: cleaned,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(text, 'utf8'),
    },
  };
}

type Parsed =
  | { ok: true; value: Omit<Directive, 'path' | 'sha256' | 'bytes'> }
  | { ok: false; reason: string };

/**
 * The parse, which is deliberately shallow and deliberately strict.
 *
 * Shallow because a directive is a document somebody wrote and not a schema:
 * anything clever enough to restructure it would be reading intent out of
 * prose, which is the thing §25 records the cost of. Strict because a section
 * that silently came back empty would produce a question that read almost
 * right — so every one of them refuses by name, and the refusal reaches a
 * person rather than a log.
 */
function parse(text: string): Parsed {
  const sections = splitSections(text);

  const core = sections.get('CORE PRINCIPLE');
  if (!core) return { ok: false, reason: 'no CORE PRINCIPLE section' };
  const corePrinciple = numbered(core);
  if (corePrinciple.length < 3) {
    return { ok: false, reason: 'CORE PRINCIPLE names fewer than three steps' };
  }
  const pullStatement = core
    .split('\n')
    .map((one) => one.trim())
    .find((one) => /pull manufacturing forward/i.test(one));
  if (!pullStatement) {
    return { ok: false, reason: 'CORE PRINCIPLE does not say which way the pull runs' };
  }

  const compoundingSection = sections.get('CAPABILITY COMPOUNDING');
  if (!compoundingSection) return { ok: false, reason: 'no CAPABILITY COMPOUNDING section' };
  const compounding = compoundingSection
    .split('\n')
    .map((one) => one.trim())
    .filter((one) => one.startsWith('- ') && one.endsWith('?'))
    .map((one) => one.slice(2).trim());
  if (compounding.length < 4) {
    return { ok: false, reason: 'CAPABILITY COMPOUNDING asks fewer than four questions' };
  }

  const evaluationSection = sections.get('OPPORTUNITY EVALUATION');
  if (!evaluationSection) return { ok: false, reason: 'no OPPORTUNITY EVALUATION section' };
  const evaluation = dimensions(evaluationSection);
  if (evaluation.length < 4) {
    return { ok: false, reason: 'OPPORTUNITY EVALUATION names fewer than four dimensions' };
  }
  if (!evaluation.some((one) => /^ENTRY$/i.test(one.name))) {
    return {
      ok: false,
      reason:
        'OPPORTUNITY EVALUATION has no ENTRY dimension, which is where required capital is ' +
        'named — the one entry fact the rest of this kernel cannot derive without it',
    };
  }

  const pyramid = sections.get('CURRENT MANUFACTURING PYRAMID');
  if (!pyramid) return { ok: false, reason: 'no CURRENT MANUFACTURING PYRAMID section' };
  const bands = scaleBands(pyramid);
  if (bands.length < 2) {
    return { ok: false, reason: 'CURRENT MANUFACTURING PYRAMID names fewer than two levels' };
  }

  /*
   * The refusal travels with the bands, from the file, and is required.
   *
   * A brief that carried the six levels and lost the sentence saying they are
   * not a sequence would be the rigid roadmap with extra steps — so the parse
   * refuses rather than printing a spread with nothing attached.
   */
  const sequencingRefusal = refusal(text);
  if (!sequencingRefusal) {
    return {
      ok: false,
      reason:
        'nothing in it refuses its own sequence. The levels are carried only together with ' +
        'the directive\'s own statement that they are examples rather than an order, because ' +
        'a spread printed without it reads as a roadmap',
    };
  }

  const integration = sections.get('VERTICAL INTEGRATION');
  if (!integration) return { ok: false, reason: 'no VERTICAL INTEGRATION section' };
  // A paragraph rather than a line: the directive wraps this one across two,
  // and a line-wise read returns "Integrate when doing" — a sentence that
  // stops exactly before the seven things it says should decide.
  const integrationTests = paragraphs(integration).find((one) => /integrate when/i.test(one));
  if (!integrationTests) {
    return {
      ok: false,
      reason: 'VERTICAL INTEGRATION does not say what should decide whether to integrate',
    };
  }

  const brand = sections.get('BRAND ARCHITECTURE');
  if (!brand) return { ok: false, reason: 'no BRAND ARCHITECTURE section' };
  const brandConstraint = paragraphs(brand)[0];
  if (!brandConstraint) return { ok: false, reason: 'BRAND ARCHITECTURE says nothing' };

  return {
    ok: true,
    value: {
      corePrinciple,
      pullStatement,
      compounding,
      evaluation,
      bands,
      sequencingRefusal,
      integrationTests,
      brandConstraint,
    },
  };
}

/**
 * Headings to bodies, by the heading's own text.
 *
 * Any `#` depth, because the directive nests its preserved original under a
 * wrapper and a parse keyed to one depth would stop finding half of it the
 * first time somebody restructured the document.
 */
function splitSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading) out.set(heading, body.join('\n').trim());
    body = [];
  };
  for (const line of lines) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) {
      flush();
      heading = match[1].replace(/^\d+\.\s*/, '').trim().toUpperCase();
      continue;
    }
    body.push(line);
  }
  flush();
  return out;
}

/**
 * Numbered list items, with their wrapped continuation lines joined back on.
 *
 * A line-wise read is what the first version did, and it silently produced
 * *"Understand pricing, margins, failure modes, servicing, replacement
 * cycles,"* and *"Determine whether internal manufacturing creates a
 * meaningful economic or"* — two of the directive's eight steps cut mid-clause
 * because the document wraps at eighty columns. §27 records why that is the
 * worst available failure: **truncation is reported as success**, so the
 * assignment would have carried a sentence that stopped before its own point
 * and nothing anywhere would have said so. A continuation is any non-blank
 * line that does not itself open a new item.
 */
function numbered(section: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of section.split('\n')) {
    const line = raw.trim();
    if (/^\d+\.\s+\S/.test(line)) {
      out.push(line.replace(/^\d+\.\s+/, '').trim());
      open = true;
      continue;
    }
    /*
     * A blank line closes the item, and that is the half that makes this
     * correct rather than merely longer.
     *
     * Without it the last item swallows every paragraph after the list — the
     * directive's step 8 is "THEN manufacture." and the two sentences that
     * follow it are the *statement of which way the pull runs*, which is
     * carried separately and would then have been said twice, once inside a
     * step it is not part of.
     */
    if (!line) {
      open = false;
      continue;
    }
    // A heading, bullet, block quote or new item ends it rather than wrapping.
    if (!open || /^([-*•>#]|\d+[.)]|```)/.test(line)) {
      open = false;
      continue;
    }
    out[out.length - 1] = `${out[out.length - 1]} ${line}`.replace(/\s+/g, ' ').trim();
  }
  return out;
}

function paragraphs(section: string): string[] {
  return section
    .split(/\n\s*\n/)
    .map((one) => one.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** `**DEMAND** — market size, growth, …` into a name and what it asks for. */
function dimensions(section: string): EvaluationDimension[] {
  const out: EvaluationDimension[] = [];
  for (const block of paragraphs(section)) {
    const match = /^\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/.exec(block);
    if (!match?.[1] || !match[2]) continue;
    out.push({
      name: match[1].trim(),
      considerations: match[2].replace(/\s+/g, ' ').trim().replace(/\.$/, ''),
    });
  }
  return out;
}

/** `**LEVEL 1 — POWERED MACHINES.** Commercial pressure washers, …` */
function scaleBands(section: string): ScaleBand[] {
  const out: ScaleBand[] = [];
  for (const block of paragraphs(section)) {
    const match = /^\*\*LEVEL\s+(\d+)\s*[—–-]\s*(.+?)\.?\*\*\s*(.*)$/i.exec(block);
    if (!match?.[1] || !match[2]) continue;
    const rest = (match[3] ?? '').trim();
    /*
     * Only the examples, and never the "Purpose:" prose that follows them.
     *
     * The prose is where the directive explains what a level is *for*, and
     * carrying it into a search prompt would be handing a worker an argument
     * about sequencing dressed as context. What is useful as a seed is the
     * machines it names.
     */
    const examples = rest.split(/\bPurpose:|\bDevelop\b|\bThis level\b/)[0] ?? rest;
    out.push({
      ordinal: Number(match[1]),
      name: match[2].trim().replace(/\.$/, ''),
      examples: examples.replace(/\s+/g, ' ').trim().replace(/[.,;]$/, ''),
    });
  }
  return out;
}

/** The directive's own sentence refusing its own order, wherever it sits. */
function refusal(text: string): string | null {
  const candidates = text
    .split('\n')
    .map((one) => one.replace(/\*\*/g, '').trim())
    .filter(Boolean);
  return (
    candidates.find((one) => /NOT mandatory sequencing/i.test(one)) ??
    candidates.find((one) => /DO NOT blindly follow/i.test(one)) ??
    null
  );
}

// ---------------------------------------------------------------------------
// WHAT A QUESTION CARRIES
//
// Each of these is the directive's own words, shaped for one assignment. They
// are functions rather than strings so that a brief with a section missing
// cannot produce a question at all, and so that `questions.ts` names what it
// is asking for rather than reaching into a structure.
// ---------------------------------------------------------------------------

/**
 * The spread of scale, with the refusal of sequencing attached to it.
 *
 * The two are returned as **one string** on purpose. A caller that could take
 * the bands without the refusal would be one edit away from printing a ladder,
 * and this is the exact place where losing the second half turns discovery
 * intelligence back into the roadmap the directive refuses.
 */
export function searchSpread(directive: Directive): string {
  const spread = directive.bands
    .map((band) => `${band.name.toLowerCase()} (${band.examples})`)
    .join('; ');
  return (
    'The programme directive illustrates the span this is meant to cover, from ' +
    `${spread}. Those are named as a spread of scale to search across, and the directive says ` +
    `of them: "${directive.sequencingRefusal}" Do not treat them as an order, do not restrict ` +
    'yourself to them, and report classes of machine they do not cover — they are there to ' +
    'stop the search settling at one scale, not to say which scale to start at.'
  );
}

/**
 * Directive sentences as things the directive *says*, one clause each.
 *
 * ---------------------------------------------------------------------------
 * Why the shape and not just the words
 * ---------------------------------------------------------------------------
 *
 * `planFitsEnvelope` runs `ownActionMatches` over a fragment's question,
 * definitions, population and completion criteria, and `actorScope.ts`'
 * rule is that a forbidden phrase reads as **Brain's own action** unless a
 * governor near it turns it into a described thing. The directive is full of
 * imperatives aimed at the company — *"Observe what customers actually
 * purchase"*, *"market size, growth, customer concentration, purchase
 * frequency"* — and pasted raw they read to that screen as instructions to go
 * and buy something. Production has already paid for that exact confusion once
 * (§33: six of ten correctly-shaped plans refused before a source was read).
 *
 * So each excerpt is quoted **behind an adjacent governor**, which is true as
 * well as convenient: these are things a document says, and saying so is the
 * accurate framing rather than a way around the screen. The words themselves
 * are untouched, which is what keeps the directive-reaches-the-worker test
 * meaningful.
 *
 * The 40-character governor window makes the spacing load-bearing, so it is
 * **asserted rather than reasoned about**: `tests/manufacturingDirective.test.ts`
 * runs every brief this module renders through the real screen with the real
 * envelope patterns, and fails naming the phrase if the directive's wording
 * ever drifts past it.
 */
function saysEach(lead: string, sentences: readonly string[]): string {
  return (
    `${lead} ` +
    sentences
      .map((one) => `says "${one.replace(/\s+/g, ' ').trim().replace(/[.;]$/, '')}"`)
      .join('; ') +
    '.'
  );
}

/**
 * One evaluation dimension, as the list of things to look up that it is.
 *
 * Split on the directive's own commas and rejoined one per clause, each behind
 * `about`, for the reason above: *"customer concentration, purchase
 * frequency"* puts `purchase` 44 characters past any governor and is refused,
 * while *"about purchase frequency"* is plainly a topic. Nothing is added or
 * dropped — the considerations are the directive's, in its order.
 */
export function dimension(directive: Directive, name: string): string | null {
  const found = directive.evaluation.find(
    (one) => one.name.toUpperCase() === name.toUpperCase(),
  );
  if (!found) return null;
  const topics = found.considerations
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean);
  return (
    `The directive's ${found.name} dimension asks what the sources establish ` +
    topics.map((one) => `about ${one}`).join('; ') +
    '.'
  );
}

/** The core principle as the numbered steps it is, with the pull statement. */
export function corePrincipleBrief(directive: Directive): string {
  return (
    saysEach(
      'The programme directive orders what must happen before manufacturing, and this question ' +
        'is part of it: it',
      directive.corePrinciple,
    ) + ` It says "${directive.pullStatement.replace(/[.]$/, '')}".`
  );
}

/** The seven compounding questions, which are what a capability round is for. */
export function compoundingBrief(directive: Directive): string {
  return (
    saysEach('The programme directive asks of every product: it', directive.compounding) +
    ' Answer those about the category, from published sources about the industry.'
  );
}
