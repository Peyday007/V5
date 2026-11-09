/**
 * Reading a specification into located source items, without losing any of it.
 *
 * The extraction is deterministic and total: every non-blank line of the source
 * that is not a heading belongs to exactly one item, and every item's text is
 * exactly `source.slice(start, end)`. That property is what lets the map be
 * checked against the source rather than trusted — a requirement cites item ids,
 * and an item nobody cites is an omission the validator can name.
 *
 * Nothing here interprets the source. It locates, it flags words that make an
 * item open to more than one reading, and it marks which items state something
 * that must be true. Deciding what those items mean is the map's job, and the
 * map is checked against this.
 */
import crypto from 'node:crypto';
import type { SourceItem } from '../../../domain/factoryProgram.ts';

const NORMATIVE =
  /\b(must|shall|should|required?|requires|never|cannot|can ?not|may not|only|every|each|all|ensure|always|do not|don't|no (?:\w+ )?(?:may|can|is|are))\b/i;

/**
 * An imperative sentence is an obligation even without "must": "Preserve the
 * original document verbatim" is the owner telling Factory what to do. The list
 * is of verbs a specification commands with; a sentence that opens on one is
 * read as normative.
 */
const IMPERATIVE =
  /^(?:[-*+•]|\d+[.)]|[a-z][.)])?\s*(account|accept|add|allow|apply|avoid|build|check|classify|compare|continue|coordinate|create|decompose|deliver|demonstrate|deploy|derive|detect|determine|distinguish|enforce|expose|extend|find|fix|follow|give|identify|implement|inspect|integrate|keep|make|measure|merge|own|prevent|preserve|produce|prove|provide|quantify|read|recheck|record|recover|refuse|reject|remove|reopen|repair|replan|report|require|resume|retain|return|reuse|run|schedule|send|show|split|start|stop|store|strengthen|support|test|track|treat|update|use|verify|write)\b/i;

const AMBIGUITY =
  /\b(TBD|TODO|etc\.?|and\/or|as appropriate|where appropriate|if appropriate|appropriate(?:ly)?|if possible|wherever possible|as needed|when justified|if justified|reasonabl[ey]|maybe|possibly|unclear|approximately|or similar)(?=\W|$)|\?(?=\s|$)/gi;

const LIST_ITEM = /^(\s*)([-*+•]|\d+[.)]|[a-z][.)])\s+\S/;
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBERED_CAPS_HEADING = /^(\d+(?:\.\d+)*)\.?\s+([A-Z0-9][A-Z0-9 ,'’&()/:-]{2,})$/;
const CAPS_HEADING = /^[A-Z][A-Z0-9 ,'’&()/:-]{2,79}$/;

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Line {
  text: string;
  start: number;
  end: number;
  number: number;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let number = 1;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline;
    const raw = source.slice(start, end);
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text, start, end: start + text.length, number });
    if (newline === -1) break;
    start = newline + 1;
    number += 1;
  }
  return lines;
}

const blank = (line: Line | undefined): boolean => !line || line.text.trim() === '';

/** A heading, with its depth, or null. A caps line is a heading only when it stands alone. */
function headingOf(lines: Line[], index: number, inFence: boolean): { level: number; title: string } | null {
  if (inFence) return null;
  const line = lines[index]!;
  const text = line.text.trim();
  const md = MD_HEADING.exec(text);
  if (md) return { level: md[1]!.length, title: md[2]!.trim() };
  const standsAlone = blank(lines[index - 1]) && blank(lines[index + 1]);
  if (!standsAlone || /[.!?;]$/.test(text)) return null;
  const numbered = NUMBERED_CAPS_HEADING.exec(text);
  if (numbered && /[A-Z]{3}/.test(numbered[2]!)) {
    return { level: numbered[1]!.split('.').length, title: text };
  }
  if (CAPS_HEADING.test(text) && /[A-Z]{3}/.test(text) && text === text.toUpperCase()) {
    return { level: 1, title: text };
  }
  return null;
}

export function ambiguityMarkersIn(text: string): string[] {
  return [...new Set([...text.matchAll(AMBIGUITY)].map((match) => match[0]))];
}

/** "If production reveals a defect, reopen …" — a command behind a condition. */
const CONDITIONAL_COMMAND = new RegExp(
  `^(?:[-*+•]\\s*)?(?:if|when|once|where|unless|before|after|for)\\b[^.]*?,\\s*${IMPERATIVE.source.replace('^(?:[-*+•]|\\d+[.)]|[a-z][.)])?\\s*', '')}`,
  'i',
);

/** A negative definition is a rule: "A requirement is not complete because its PR merged." */
const NEGATIVE_RULE = /\b(?:is|are|does|do) not\b/i;

export function isNormative(text: string): boolean {
  const trimmed = text.trim();
  return NORMATIVE.test(trimmed) || IMPERATIVE.test(trimmed) || CONDITIONAL_COMMAND.test(trimmed) || NEGATIVE_RULE.test(trimmed);
}

/**
 * Locate every item of the source.
 *
 * List items inherit normativity from the lead-in they hang off ("Every
 * requirement must have:" makes "- A stable identifier." a requirement even
 * though the bullet alone says nothing about obligation). Over-reading is the
 * safe direction: a normative item the map does not cover is refused, while a
 * descriptive one only warns.
 */
export function extractSourceItems(source: string): SourceItem[] {
  const lines = splitLines(source);
  const items: SourceItem[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let inFence = false;
  let leadInNormative = false;
  let current: { first: Line; last: Line; isList: boolean; indent: number; fence: boolean } | null = null;

  const flush = (): void => {
    if (!current) return;
    const start = current.first.start + (current.first.text.length - current.first.text.trimStart().length);
    const end = current.last.end;
    const text = source.slice(start, end);
    const own = isNormative(text);
    const normative = !current.fence && (own || leadInNormative);
    items.push({
      id: `S-${String(items.length + 1).padStart(4, '0')}`,
      section: stack.map((entry) => entry.title),
      start,
      end,
      lineStart: current.first.number,
      lineEnd: current.last.number,
      text,
      normative,
      ambiguityMarkers: current.fence ? [] : ambiguityMarkersIn(text),
    });
    // Whatever a lead-in ending in a colon enumerates is what it requires, measures or tests.
    if (!current.isList) leadInNormative = /:\s*$/.test(text);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.text.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (!inFence) {
        flush();
        current = { first: line, last: line, isList: false, indent: 0, fence: true };
        inFence = true;
      } else {
        if (current) current.last = line;
        inFence = false;
        flush();
      }
      continue;
    }
    if (inFence) {
      if (current) current.last = line;
      continue;
    }
    if (trimmed === '') {
      // A blank line ends a paragraph; inside a list it ends the item, and the
      // list's lead-in still applies to the next item.
      flush();
      continue;
    }
    const heading = headingOf(lines, index, inFence);
    if (heading) {
      flush();
      leadInNormative = false;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
      stack.push(heading);
      continue;
    }
    const list = LIST_ITEM.exec(line.text);
    if (list) {
      flush();
      current = { first: line, last: line, isList: true, indent: list[1]!.length, fence: false };
      continue;
    }
    if (current) {
      current.last = line;
      continue;
    }
    current = { first: line, last: line, isList: false, indent: 0, fence: false };
  }
  flush();
  return items;
}

/**
 * The losslessness property, checked: every non-blank character that is not part
 * of a heading line lies inside exactly one item. Returns the offending line
 * numbers (empty when the extraction is total).
 */
export function uncoveredLines(source: string, items: SourceItem[]): number[] {
  const lines = splitLines(source);
  const covered = new Map<number, number>();
  for (const item of items) {
    for (let n = item.lineStart; n <= item.lineEnd; n += 1) covered.set(n, (covered.get(n) ?? 0) + 1);
  }
  const missing: number[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    const trimmed = line.text.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) inFence = !inFence;
    if (trimmed === '') return;
    if (!inFence && !(trimmed.startsWith('```') || trimmed.startsWith('~~~')) && headingOf(lines, index, false)) return;
    if ((covered.get(line.number) ?? 0) !== 1) missing.push(line.number);
  });
  return missing;
}
