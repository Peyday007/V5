/**
 * Finding the seams in a transcript.
 *
 * A retrieval chunk and a segment are different things and this module exists
 * because conflating them loses information. A chunk is sized for a model's
 * budget; cutting every 6000 characters puts a research assignment and the
 * report answering it in the same lump, and splits a decision down the middle.
 * A segment follows the document's own structure — who spoke, when, under which
 * heading, about what — so that "this part is an assignment and that part is the
 * audit of it" is a fact about the text rather than an accident of arithmetic.
 *
 * Fixed size still has a job: it is the backstop for a segment that runs away,
 * because a forty-page monologue with no markers is still better read in pieces.
 * It is never the only rule.
 *
 * Everything here is pattern matching over text that came from outside. It reads
 * the transcript; it never obeys it.
 */
import { createHash } from 'node:crypto';
import type { DocumentBlock } from '../../domain/types.ts';

/** What a segment turned out to be. */
export type SegmentType =
  | 'CONVERSATION'
  | 'RESEARCH_ASSIGNMENT'
  | 'RETURNED_RESEARCH'
  | 'AUDIT'
  | 'DECISION'
  | 'REVISION'
  | 'SUPERSEDED'
  | 'OPEN_GAP'
  | 'ATTACHMENT_REF'
  | 'OTHER';

export interface Segment {
  segmentIndex: number;
  segmentType: SegmentType;
  title: string;
  speaker: string | null;
  timestampText: string | null;
  blockStart: number;
  blockEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
  contentHash: string;
  confidence: number;
  rationale: string;
  warnings: string[];
}

/** A segment longer than this is split, so one runaway block is still readable. */
const MAX_SEGMENT_CHARS = 12_000;

/**
 * Speaker labels, in the forms transcripts actually use.
 *
 * Deliberately anchored to the start of a line and requiring the colon: a
 * sentence mentioning "the user:" mid-paragraph is prose, not a turn boundary.
 */
const SPEAKER_RE =
  /^\s{0,3}(?:\*\*|__)?(User|You|Me|Assistant|ChatGPT|GPT|Claude|Gemini|System|Researcher|Auditor|Analyst)(?:\*\*|__)?\s*:\s*/i;

/** "You said:" / "ChatGPT said:" — the shape a ChatGPT web export uses. */
const SAID_RE = /^\s{0,3}(You|ChatGPT|Assistant|User)\s+said\s*:?\s*$/i;

/** Timestamps in the forms that appear beside turns. */
const TIMESTAMP_RE =
  /(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?)|(\[\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\s*\])|(\d{1,2}\/\d{1,2}\/\d{2,4})/i;

/** Markdown and setext headings, plus bare ALL-CAPS section titles. */
const ATX_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const CAPS_HEADING_RE = /^\s{0,3}([A-Z][A-Z0-9 ,'()\/&.-]{5,80})\s*$/;
const RULE_RE = /^\s{0,3}([-=_*]{3,})\s*$/;

/** Vocabulary that types a segment. Ordered: the first match with the most hits wins. */
const TYPE_MARKERS: { type: SegmentType; weight: number; patterns: RegExp[] }[] = [
  {
    type: 'RESEARCH_ASSIGNMENT',
    weight: 1,
    patterns: [
      /\bresearch (?:assignment|brief|request|task)\b/i,
      /\b(?:DR|RUN)[-_ ]?\d+\b/,
      /\bplease (?:research|investigate|look into|find out)\b/i,
      /\b(?:your|the) (?:assignment|deliverable) is\b/i,
      /\bdeep research\b/i,
      /\bexpected (?:output|deliverable|contribution)\b/i,
    ],
  },
  {
    type: 'RETURNED_RESEARCH',
    weight: 1,
    patterns: [
      /\b(?:here is|attached is|returning) the (?:report|research|findings)\b/i,
      /\bresearch (?:report|findings|results)\b/i,
      /\bexecutive summary\b/i,
      /\b(?:completed|finished) (?:the )?(?:research|report)\b/i,
      /\bsources?\s*(?:consulted|cited)\b/i,
    ],
  },
  {
    type: 'AUDIT',
    weight: 1,
    patterns: [
      /\baudit (?:verdict|result|found|says|report)\b/i,
      /\bverdict\s*[:=]\s*(PASS|PATCH|FAIL|BLOCKED|MORE_RESEARCH)/i,
      /\b(?:foundational|targeted) gap\b/i,
      /\badversarial (?:pass|critique|check)\b/i,
      /\baudited\b/i,
    ],
  },
  {
    type: 'SUPERSEDED',
    weight: 2,
    patterns: [
      /\bsupersed(?:es|ed|ing)\b/i,
      /\bno longer (?:true|correct|holds|applies)\b/i,
      /\breplaces? (?:the )?(?:earlier|previous|prior)\b/i,
      /\bwe were wrong about\b/i,
      /\bscrap (?:that|the earlier)\b/i,
    ],
  },
  {
    type: 'REVISION',
    weight: 1,
    patterns: [
      /\brevis(?:e|ed|ion)\b/i,
      /\bv\d+(?:\.\d+)?[A-Z]?\s*(?:->|→|becomes)\s*v\d+/i,
      /\bupdated (?:to|the) version\b/i,
      /\bredo\b/i,
    ],
  },
  {
    type: 'DECISION',
    weight: 2,
    patterns: [
      /\b(?:we|I) (?:decided|agreed|concluded|settled on)\b/i,
      /\bdecision\s*[:=]/i,
      /\bgoing with\b/i,
      /\blocked in\b/i,
      /\bfinal(?:ly)? (?:decided|choice)\b/i,
    ],
  },
  {
    type: 'OPEN_GAP',
    weight: 2,
    patterns: [
      /\b(?:open|unresolved) (?:question|issue|gap)\b/i,
      /\bstill (?:unclear|unknown|open|unresolved)\b/i,
      /\bTBD\b/,
      /\bwe don'?t (?:yet )?know\b/i,
      /\bneeds? (?:more|further) (?:research|work|thought)\b/i,
      /\bto be (?:determined|decided)\b/i,
    ],
  },
  {
    type: 'ATTACHMENT_REF',
    weight: 1,
    patterns: [
      /\b(?:attached|attachment|see the file|uploaded)\b/i,
      /\b[\w ,'-]+\.(?:pdf|docx|md|txt|csv|xlsx)\b/i,
    ],
  },
];

interface RawSegment {
  blockStart: number;
  blockEnd: number;
  charStart: number;
  charEnd: number;
  lines: string[];
  speaker: string | null;
  timestampText: string | null;
  heading: string | null;
  reasons: string[];
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** The first non-empty line, trimmed to something that reads as a title. */
function titleFrom(lines: string[], heading: string | null, speaker: string | null): string {
  if (heading) return heading.slice(0, 120);
  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? '';
  const stripped = first.replace(SPEAKER_RE, '').replace(/^[#*_\s>-]+/, '').trim();
  const base = stripped.length > 0 ? stripped : first;
  const title = base.length > 120 ? `${base.slice(0, 117)}…` : base;
  return speaker && title.length > 0 ? title : title || (speaker ?? 'Segment');
}

/**
 * Decide what a segment is, from the vocabulary in it.
 *
 * Confidence is the share of the winning type's patterns that actually matched,
 * scaled by how decisively it beat the runner-up — so a passage with one weak
 * signal is reported as a weak signal rather than a classification.
 */
function classifyType(
  text: string,
  speaker: string | null,
): { type: SegmentType; confidence: number; rationale: string } {
  const scores: { type: SegmentType; hits: string[]; weight: number }[] = [];

  for (const marker of TYPE_MARKERS) {
    const hits: string[] = [];
    for (const pattern of marker.patterns) {
      const found = pattern.exec(text);
      if (found) hits.push(found[0].trim().slice(0, 60));
    }
    if (hits.length > 0) scores.push({ type: marker.type, hits, weight: marker.weight });
  }

  if (scores.length === 0) {
    return {
      type: speaker ? 'CONVERSATION' : 'OTHER',
      confidence: speaker ? 0.5 : 0.2,
      rationale: speaker
        ? `A conversation turn by ${speaker} with no assignment, report, audit or decision vocabulary in it.`
        : 'No recognisable structure or vocabulary; kept as an unclassified passage.',
    };
  }

  scores.sort((a, b) => b.hits.length * b.weight - a.hits.length * a.weight);
  const best = scores[0]!;
  const runnerUp = scores[1];
  const bestScore = best.hits.length * best.weight;
  const runnerScore = runnerUp ? runnerUp.hits.length * runnerUp.weight : 0;

  // A clear win is confident; a tie is explicitly not.
  const margin = runnerScore === 0 ? 1 : Math.min(1, (bestScore - runnerScore) / bestScore);
  const confidence = Number(Math.min(0.95, 0.35 + 0.3 * Math.min(best.hits.length, 3) * margin).toFixed(2));

  const rationale =
    `Matched ${best.hits.length} ${best.type.toLowerCase().replace(/_/g, ' ')} phrase(s): ` +
    `${best.hits.slice(0, 3).map((hit) => `"${hit}"`).join(', ')}` +
    (runnerUp ? `. Also resembles ${runnerUp.type} (${runnerUp.hits.length} phrase(s)).` : '.');

  return { type: best.type, confidence, rationale };
}

/**
 * Split a run's blocks into segments along the document's own boundaries.
 *
 * A new segment starts at a speaker label, a heading, a horizontal rule, or a
 * timestamp on its own line. Size is the last resort, not the first.
 */
export function segmentBlocks(blocks: DocumentBlock[]): Segment[] {
  const raw: RawSegment[] = [];
  let current: RawSegment | null = null;

  // A rule or a bare timestamp marks where the next thing begins; it is not a
  // thing itself. Holding it as pending metadata is what stops "---", the date
  // under it, and the turn under that from becoming three segments where the
  // transcript plainly contains one.
  let pendingTimestamp: string | null = null;
  let pendingReason: string | null = null;

  const begin = (block: DocumentBlock, reason: string, extras: Partial<RawSegment>): RawSegment => {
    const segment: RawSegment = {
      blockStart: block.blockIndex,
      blockEnd: block.blockIndex,
      charStart: block.charStart,
      charEnd: block.charEnd,
      lines: [],
      speaker: null,
      timestampText: pendingTimestamp,
      heading: null,
      reasons: [pendingReason ? `${pendingReason}, then ${reason}` : reason],
      ...extras,
    };
    if (!segment.timestampText) segment.timestampText = pendingTimestamp;
    pendingTimestamp = null;
    pendingReason = null;
    raw.push(segment);
    return segment;
  };

  for (const block of blocks) {
    const text = block.normalizedText;
    const lines = text.split('\n');
    const firstLine = lines[0] ?? '';

    const speakerMatch =
      SPEAKER_RE.exec(firstLine) ??
      (SAID_RE.test(firstLine.trim()) ? SAID_RE.exec(firstLine.trim()) : null);
    const atx = ATX_HEADING_RE.exec(firstLine);
    const isHeadingBlock = block.blockType === 'HEADING';
    const capsHeading = !atx && !isHeadingBlock ? CAPS_HEADING_RE.exec(firstLine) : null;
    const isRule = RULE_RE.test(text.trim());
    const bareTimestamp = TIMESTAMP_RE.test(firstLine) && text.trim().length <= 40;

    // Markers carrying no content of their own: remember them and move on.
    if (isRule && lines.length === 1) {
      pendingReason = 'a horizontal rule marking a topic change';
      continue;
    }
    if (bareTimestamp && !speakerMatch) {
      pendingTimestamp = TIMESTAMP_RE.exec(firstLine)?.[0] ?? null;
      if (!pendingReason) pendingReason = 'a timestamp on its own line';
      continue;
    }

    if (speakerMatch) {
      const speaker = (speakerMatch[1] ?? '').trim();
      current = begin(block, `speaker label "${speaker}"`, {
        speaker,
        timestampText: TIMESTAMP_RE.exec(firstLine)?.[0] ?? pendingTimestamp,
      });
    } else if (atx || isHeadingBlock || capsHeading) {
      const heading = (atx?.[2] ?? capsHeading?.[1] ?? text).trim();
      current = begin(block, `heading "${heading.slice(0, 60)}"`, { heading });
    } else if (!current) {
      current = begin(block, 'start of the document', {});
    } else if (pendingReason) {
      // A marker was seen and this is the content it introduced.
      current = begin(block, 'the passage after it', {});
    } else if (current.lines.join('\n').length + text.length > MAX_SEGMENT_CHARS) {
      // Size backstop: a segment that has run away is split, and the split says
      // so, because an arbitrary cut should never look like a real boundary.
      current = begin(block, `length: the previous segment passed ${MAX_SEGMENT_CHARS} characters`, {
        speaker: current.speaker,
      });
    }

    const target = current;
    target.lines.push(text);
    target.blockEnd = block.blockIndex;
    target.charEnd = block.charEnd;
    if (!target.timestampText) {
      const stamp = TIMESTAMP_RE.exec(text);
      if (stamp) target.timestampText = stamp[0];
    }
  }

  return raw
    .map((entry, index) => {
      const body = entry.lines.join('\n\n').trim();
      const typed = classifyType(body, entry.speaker);
      const warnings: string[] = [];
      if (typed.confidence < 0.5) {
        warnings.push('Low confidence: this segment matched little recognisable vocabulary.');
      }
      if (entry.reasons[0]?.startsWith('length:')) {
        warnings.push('Split on length rather than a real boundary; check the neighbouring segments.');
      }
      return {
        segmentIndex: index,
        segmentType: typed.type,
        title: titleFrom(entry.lines, entry.heading, entry.speaker),
        speaker: entry.speaker,
        timestampText: entry.timestampText,
        blockStart: entry.blockStart,
        blockEnd: entry.blockEnd,
        charStart: entry.charStart,
        charEnd: entry.charEnd,
        text: body,
        contentHash: hash(body),
        confidence: typed.confidence,
        rationale: `Boundary: ${entry.reasons[0]}. ${typed.rationale}`,
        warnings,
      };
    })
    .filter((segment) => segment.text.length > 0);
}
