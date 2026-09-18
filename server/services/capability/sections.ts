/**
 * The sections of a blueprint, read from the document rather than guessed.
 *
 * ---------------------------------------------------------------------------
 * Why Brain derives the unit list instead of asking for one
 * ---------------------------------------------------------------------------
 *
 * A bin's units are what Brain declares *before* assignment, and a worker that
 * chose its own units would be deciding what counts as having read the
 * document — which is the one thing coverage has to be checkable against. So
 * the sections come from the document's own `HEADING` blocks, which the text
 * extractor produced deterministically from the file's markdown.
 *
 * That makes two questions answerable that a single free-form submission
 * cannot answer. **Did the worker read all of it?** Every declared section is a
 * declared unit, and a unit with no result is a section nobody read. **Is this
 * section a faculty?** The heading itself says so, so the number fourteen is
 * read off the document rather than carried in a constant that would be wrong
 * the day somebody adds a fifteenth.
 *
 * ---------------------------------------------------------------------------
 * What a "faculty section" is, and what it deliberately is not
 * ---------------------------------------------------------------------------
 *
 * A heading whose text begins with a decimal section number under the
 * definitions chapter — `5.1 Research Intelligence`, `5.14 Capability-…`. That
 * is a structural fact about the document, not a judgement about the content,
 * which is the point: a rule that read the *words* to decide whether something
 * is a faculty would be model judgement in the one place this module exists to
 * keep it out of.
 *
 * The Shared Executive is a chapter rather than a numbered definition, so it is
 * recognised by its own heading and carried as its own section kind. It is not
 * a faculty and must never be counted as one — the blueprint is explicit that
 * it is "not a fifteenth specialist department" — so the two kinds stay apart
 * here rather than being told apart by a reader downstream.
 */
import type { DocumentBlock } from '../../domain/types.ts';

export type SectionKind = 'FACULTY' | 'SHARED_EXECUTIVE';

export interface BlueprintSection {
  kind: SectionKind;
  /** The section number as the document writes it, e.g. "5.1". Null for a chapter. */
  number: string | null;
  /** The ordinal the number implies, e.g. 1 for "5.1". Null when there is none. */
  ordinal: number | null;
  /** The heading text with its numbering removed. */
  title: string;
  /** The heading block this came from, so a caller can resolve it. */
  blockId: string;
  blockIndex: number;
  pageNumber: number;
}

/**
 * `5.1 Research Intelligence` — the numbered definition headings.
 *
 * Anchored to the definitions chapter by the leading `5.`, because the document
 * numbers its other chapters too and a bare `\d+\.\d+` would collect section
 * 9.3 and 10.4 as faculties. The chapter number is a parameter rather than a
 * literal so a differently-organised blueprint is a call-site change instead of
 * a silent mis-read.
 */
const FACULTY_HEADING = /^(\d+)\.(\d+)\.?\s+(.+)$/;

/** The Shared Executive chapter, however it is numbered. */
const EXECUTIVE_HEADING = /^(?:\d+\.?\s+)?the\s+shared\s+executive\b/i;

export interface SectionScan {
  sections: BlueprintSection[];
  /** Headings that looked like a faculty but sat under another chapter. */
  skipped: string[];
}

/**
 * Scan a document's blocks for the sections a blueprint declares.
 *
 * `definitionsChapter` is which top-level chapter holds the faculty
 * definitions. It is discovered rather than assumed: the chapter that holds the
 * most numbered headings is the definitions chapter, because a blueprint's
 * definitions chapter is by construction its longest numbered one. A caller may
 * override it, and `skipped` reports what the choice left out so a wrong guess
 * is visible rather than silent.
 */
export function scanSections(
  blocks: DocumentBlock[],
  options: { definitionsChapter?: number } = {},
): SectionScan {
  const headings = blocks.filter((block) => block.blockType === 'HEADING');

  const byChapter = new Map<number, number>();
  for (const block of headings) {
    const match = FACULTY_HEADING.exec(block.normalizedText.trim());
    if (!match) continue;
    const chapter = Number(match[1]);
    byChapter.set(chapter, (byChapter.get(chapter) ?? 0) + 1);
  }

  let chapter = options.definitionsChapter ?? null;
  if (chapter === null) {
    let best = 0;
    for (const [candidate, count] of byChapter) {
      // Ties go to the lower chapter number, so the scan is deterministic
      // rather than dependent on Map iteration order for equal counts.
      if (count > best || (count === best && chapter !== null && candidate < chapter)) {
        best = count;
        chapter = candidate;
      }
    }
  }

  const sections: BlueprintSection[] = [];
  const skipped: string[] = [];

  for (const block of headings) {
    const text = block.normalizedText.trim();

    if (EXECUTIVE_HEADING.test(text)) {
      sections.push({
        kind: 'SHARED_EXECUTIVE',
        number: null,
        ordinal: null,
        title: text.replace(/^\d+\.?\s+/, ''),
        blockId: block.id,
        blockIndex: block.blockIndex,
        pageNumber: block.pageNumber,
      });
      continue;
    }

    const match = FACULTY_HEADING.exec(text);
    if (!match) continue;
    if (Number(match[1]) !== chapter) {
      skipped.push(text);
      continue;
    }
    sections.push({
      kind: 'FACULTY',
      number: `${match[1]}.${match[2]}`,
      ordinal: Number(match[2]),
      title: (match[3] ?? '').trim(),
      blockId: block.id,
      blockIndex: block.blockIndex,
      pageNumber: block.pageNumber,
    });
  }

  // One Shared Executive. The blueprint has one chapter for it and a table of
  // contents line that reads the same; keeping both would declare a unit nobody
  // can fill, and the first occurrence is the chapter.
  const seenExecutive = sections.findIndex((section) => section.kind === 'SHARED_EXECUTIVE');
  const deduped = sections.filter(
    (section, index) => section.kind !== 'SHARED_EXECUTIVE' || index === seenExecutive,
  );

  // One section per number. A blueprint that lists its faculties in a contents
  // table and then defines them repeats every heading, and a duplicate unit is
  // a unit nobody can satisfy twice.
  const byNumber = new Map<string, BlueprintSection>();
  const out: BlueprintSection[] = [];
  for (const section of deduped) {
    if (section.kind !== 'FACULTY' || section.number === null) {
      out.push(section);
      continue;
    }
    const seen = byNumber.get(section.number);
    if (seen) {
      // The later one wins: a contents line precedes the definition it points
      // at, and the definition is the section a worker has to read.
      out[out.indexOf(seen)] = section;
      byNumber.set(section.number, section);
      continue;
    }
    byNumber.set(section.number, section);
    out.push(section);
  }

  return { sections: out, skipped };
}

/** The unit key a section is assigned. Derived, so two scans agree. */
export function sectionUnitKey(section: BlueprintSection): string {
  return section.kind === 'SHARED_EXECUTIVE'
    ? 'shared_executive'
    : `faculty_${String(section.ordinal ?? 0).padStart(2, '0')}`;
}
