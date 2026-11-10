/**
 * The GOV-11 register: the owner's decisions and the design questions the owner
 * has not yet answered (S-0097, S-0098), kept as data beside the program.
 *
 * It lives in code because the deployed image does not carry `docs/`: a register
 * that exists only as a document is one the running Brain cannot read, so
 * nothing could show it is maintained. `docs/programs/brain-architecture/
 * OPEN-QUESTIONS-REGISTER.md` is the same register for a person to read, and a
 * test refuses the two disagreeing.
 *
 * Rules (the document states them; this module enforces them):
 *  - every clause is the owner's wording, verbatim, and is checked against the
 *    program source stored on production, not against a copy of itself;
 *  - an OPEN question carries no answer and no default — an absent answer is
 *    never read as a favourable assumption (§7.39);
 *  - an ANSWERED question points at the release or requirement that answers it,
 *    and its question text is never rewritten;
 *  - entries are only ever added or re-mapped; none is removed.
 *
 * Probe `r01.gov-11` is registered here because `probes.ts` is a protected
 * path; `plan.ts` imports this module so it is registered wherever goals load.
 */
import { getDb } from '../../db/database.ts';
import { registerProbe, type ProbeResult } from '../factory/program/probes.ts';

export interface RegisterDecision {
  id: string;
  clause: string;
}

export interface RegisterQuestion {
  id: string;
  status: 'OPEN' | 'ANSWERED';
  clause: string;
  /** Release number or requirement id that carries the answer; null while OPEN. */
  answer: string | null;
}

export const OWNER_DECISIONS: readonly RegisterDecision[] = [
  { id: 'GOV-11-D1', clause: 'Financial milestones such as 10K/100K/1M are examples, not hard-coded progressions.' },
  { id: 'GOV-11-D2', clause: 'Near-term collected-money objectives matter, but substantial reinvestment is expected during the build phase.' },
  { id: 'GOV-11-D3', clause: 'Different businesses are permitted to have different extraction, growth and creative-funding roles.' },
  { id: 'GOV-11-D4', clause: 'The range of commercial possibilities must not be limited to Brain’s database or to presently fashionable AI services.' },
  { id: 'GOV-11-D5', clause: 'Ideas should morph repeatedly, combine across markets and generate new opportunities from their own transformed elements.' },
  { id: 'GOV-11-D6', clause: 'The user will continue adding and refining the architecture; preserve the unabridged intent.' },
  { id: 'GOV-11-D7', clause: 'Avoid repeated rhetorical restatements and oversimplified explanations. Engage at a technical and strategic level.' },
];

export const OPEN_QUESTIONS: readonly RegisterQuestion[] = [
  { id: 'GOV-11-Q1', status: 'OPEN', answer: null, clause: 'Exact mechanics and representation of the ‘thinking map’ and idea-transforming operations.' },
  { id: 'GOV-11-Q2', status: 'OPEN', answer: null, clause: 'What degree of novelty/diversity is useful, and how the system should prioritize emerging branches.' },
  { id: 'GOV-11-Q3', status: 'OPEN', answer: null, clause: 'Capital-governance policies and financial structures for differing business archetypes.' },
  { id: 'GOV-11-Q4', status: 'OPEN', answer: null, clause: 'How aggressively future objectives may consume scarce resources from present obligations.' },
  { id: 'GOV-11-Q5', status: 'OPEN', answer: null, clause: 'Exact target levels for concurrent research throughput, worker utilization and minimum exploration.' },
  { id: 'GOV-11-Q6', status: 'OPEN', answer: null, clause: 'Full product interaction and visualization requirements.' },
  { id: 'GOV-11-Q7', status: 'OPEN', answer: null, clause: 'Calibration/decision rules for optional or mandatory confidence thresholds in future goals.' },
];

const squash = (text: string): string => text.replace(/\s+/g, ' ').replace(/^[-•*]\s*/, '').trim();

/** Problems with the register's own shape: ids, status/answer coherence, no default on an open question. */
export function registerShapeProblems(
  decisions: readonly RegisterDecision[] = OWNER_DECISIONS,
  questions: readonly RegisterQuestion[] = OPEN_QUESTIONS,
): string[] {
  const problems: string[] = [];
  const ids = [...decisions.map((d) => d.id), ...questions.map((q) => q.id)];
  if (new Set(ids).size !== ids.length) problems.push('an entry id is repeated');
  for (const e of [...decisions, ...questions]) if (squash(e.clause).length === 0) problems.push(`${e.id} has no clause`);
  for (const q of questions) {
    if (q.status === 'OPEN' && q.answer !== null) problems.push(`${q.id} is OPEN but carries an answer or default`);
    if (q.status === 'ANSWERED' && (q.answer === null || q.answer.trim() === '')) problems.push(`${q.id} is ANSWERED but names no release or requirement`);
  }
  return problems;
}

/**
 * Check the register against the specification text. Each decision must be in the
 * text of source item S-0097 and each question in S-0098, word for word; and nothing
 * those items state may be missing from the register.
 */
export function registerAgainstSource(
  itemTexts: { decisions: string; questions: string },
  decisions: readonly RegisterDecision[] = OWNER_DECISIONS,
  questions: readonly RegisterQuestion[] = OPEN_QUESTIONS,
): string[] {
  const problems: string[] = [];
  const d = squash(itemTexts.decisions);
  const q = squash(itemTexts.questions);
  for (const e of decisions) if (!d.includes(squash(e.clause))) problems.push(`${e.id} is not verbatim in S-0097`);
  for (const e of questions) if (!q.includes(squash(e.clause))) problems.push(`${e.id} is not verbatim in S-0098`);
  // Retained: what is left of each source item once every register clause is removed must carry no further clause.
  const strip = (text: string, clauses: readonly string[]): string => clauses.reduce((rest, c) => rest.replace(squash(c), ''), text);
  const leftD = strip(d, decisions.map((e) => e.clause)).replace(/Decisions established by the owner|[-•\s.]/g, '');
  const leftQ = strip(q, questions.map((e) => e.clause)).replace(/To define as the user continues|[-•\s.]/g, '');
  if (leftD.length > 0) problems.push('S-0097 states a decision the register does not hold');
  if (leftQ.length > 0) problems.push('S-0098 states a question the register does not hold');
  return problems;
}

export const OPEN_QUESTIONS_PROBE = 'r01.gov-11';

export async function openQuestionsRegisterHolds(): Promise<ProbeResult> {
  const { ARCHITECTURE_PROGRAM_KEY } = await import('../factory/program/probes.ts');
  const { getProgram, getMap } = await import('../../repos/factoryProgram.ts');
  const { extractSourceItems, programSource } = await import('../factory/program/spec.ts');
  const row = await getDb().get<{ id: string }>(`SELECT id FROM factory_programs WHERE submission_key = ? ORDER BY created_at LIMIT 1`, [ARCHITECTURE_PROGRAM_KEY]);
  const program = row ? await getProgram(row.id) : null;
  if (!program) return { ok: false, detail: `no program filed under "${ARCHITECTURE_PROGRAM_KEY}"` };
  const items = extractSourceItems(programSource(program));
  const s97 = items.find((i) => i.id === 'S-0097');
  const s98 = items.find((i) => i.id === 'S-0098');
  if (!s97 || !s98) return { ok: false, detail: 'the program source on production has no S-0097/S-0098' };
  const text = (i: { start: number; end: number }): string => programSource(program).slice(i.start, i.end);
  const problems = [...registerShapeProblems(), ...registerAgainstSource({ decisions: text(s97), questions: text(s98) })];
  if (problems.length > 0) return { ok: false, detail: problems.slice(0, 3).join('; ') };
  const map = await getMap(program.id);
  if (!map) return { ok: false, detail: 'the program has no installed map to carry GOV-11' };
  const open = OPEN_QUESTIONS.filter((e) => e.status === 'OPEN').length;
  return {
    ok: true,
    detail: `${OWNER_DECISIONS.length} decisions and ${OPEN_QUESTIONS.length} questions verbatim in S-0097/S-0098 of program ${program.id}; ${open} open with no default, ${OPEN_QUESTIONS.length - open} answered`,
  };
}

registerProbe(OPEN_QUESTIONS_PROBE, openQuestionsRegisterHolds);
