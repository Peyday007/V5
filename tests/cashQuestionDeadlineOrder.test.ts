/**
 * ORIGINATED:MISSED_OPPORTUNITY:DISCOVERED, the engine-question path.
 *
 * Production, 2026-11-12: 14 of 14 openings whose window ended expired while
 * still DISCOVERED. Under MAX_OPEN_ENGINE_QUESTIONS the question pass ranked by
 * fewest blanks and never read a recorded expiresAt, so a dated solicitation
 * with more blanks was never inside the cap before its window shut.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_OPEN_ENGINE_QUESTIONS,
  compareQuestionCandidates,
  type QuestionCandidate,
} from '../server/services/cash/operate.ts';

const NOW = '2026-11-12T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

function inDays(days: number): string {
  return new Date(Date.parse(NOW) + days * DAY).toISOString();
}

function candidate(
  name: string,
  fields: number,
  expiresAt: string | null,
  contribution: number | null = 1000,
): QuestionCandidate & { name: string } {
  return {
    name,
    opportunity: { expiresAt, peakFundingCents: 500, createdAt: `2026-10-01T00:00:${String(fields).padStart(2, '0')}.000Z` },
    fields: Array.from({ length: fields }, (_, i) => `field${i}`),
    contribution,
  };
}

/** Which openings get a question slot, one slot per field, as the pass spends them. */
function admitted(list: (QuestionCandidate & { name: string })[]): Set<string> {
  const out = new Set<string>();
  let slots = MAX_OPEN_ENGINE_QUESTIONS;
  for (const one of [...list].sort((a, b) => compareQuestionCandidates(a, b, NOW))) {
    for (const _field of one.fields) {
      if (slots === 0) return out;
      out.add(one.name);
      slots -= 1;
    }
  }
  return out;
}

describe('engine questions are raised Earliest Deadline First', () => {
  it('admits a dated opening with more blanks inside the cap ahead of undated ones', () => {
    const undated = Array.from({ length: MAX_OPEN_ENGINE_QUESTIONS }, (_, i) => candidate(`undated-${i}`, 1, null));
    const solicitation = candidate('solicitation', 4, inDays(10));
    const got = admitted([...undated, solicitation]);
    expect(got.has('solicitation')).toBe(true);
    expect(got.size).toBe(1 + (MAX_OPEN_ENGINE_QUESTIONS - 4));
  });

  it('orders two dated openings earliest window first, whatever their blanks', () => {
    const later = candidate('later', 1, inDays(20));
    const sooner = candidate('sooner', 5, inDays(8));
    const sorted = [later, sooner].sort((a, b) => compareQuestionCandidates(a, b, NOW));
    expect(sorted.map((one) => one.name)).toEqual(['sooner', 'later']);
  });

  it('reads a date-only expiresAt as the end of that day', () => {
    const dateOnly = candidate('date-only', 3, inDays(9).slice(0, 10));
    const timed = candidate('timed', 1, inDays(12));
    const sorted = [timed, dateOnly].sort((a, b) => compareQuestionCandidates(a, b, NOW));
    expect(sorted.map((one) => one.name)).toEqual(['date-only', 'timed']);
  });

  it('keeps the existing order for undated openings', () => {
    const a = candidate('two-blanks', 2, null, 5000);
    const b = candidate('one-blank-small', 1, null, 100);
    const c = candidate('one-blank-large', 1, null, 9000);
    const d = candidate('one-blank-unknown', 1, null, null);
    const sorted = [a, b, c, d].sort((x, y) => compareQuestionCandidates(x, y, NOW));
    expect(sorted.map((one) => one.name)).toEqual(['one-blank-large', 'one-blank-small', 'one-blank-unknown', 'two-blanks']);
  });

  it('gives no deadline priority to a window already inside the research runway, or an unparseable one', () => {
    const closing = candidate('closing', 3, inDays(1));
    const garbage = candidate('garbage', 3, 'next Tuesday');
    const undated = candidate('undated', 1, null);
    const sorted = [closing, garbage, undated].sort((x, y) => compareQuestionCandidates(x, y, NOW));
    expect(sorted[0]!.name).toBe('undated');
  });

  it('gives no deadline priority to a window beyond the horizon: it keeps the existing order like an undated one', () => {
    const far = candidate('far', 3, inDays(120));
    const near = candidate('near', 3, inDays(10));
    const undated = candidate('undated', 1, null);
    const sorted = [far, near, undated].sort((x, y) => compareQuestionCandidates(x, y, NOW));
    expect(sorted.map((one) => one.name)).toEqual(['near', 'undated', 'far']);
  });
});
