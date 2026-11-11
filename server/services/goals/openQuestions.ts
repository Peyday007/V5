/**
 * GOV-11: the owner's decisions and the design questions the owner has not yet
 * answered (source items S-0097 and S-0098), kept as a maintained register.
 *
 * `docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md` is the register
 * a person reads. The deployed image does not carry `docs/`, so the entries are
 * also held here, and `parseRegisterDocument` reads the document so a test can
 * refuse the two disagreeing. What this module enforces:
 *
 *  - verbatim: every clause is the owner's wording, checked word for word
 *    against the program source stored on production — not against a copy of
 *    itself;
 *  - retained: nothing S-0097/S-0098 states is missing from the register, and a
 *    re-map never removes an entry or rewrites its clause;
 *  - open means open: an OPEN question carries no answer and no default, and a
 *    reader asking for one gets `null`, never a favourable assumption (§7.39);
 *  - re-mapped, not frozen: answering a question moves it OPEN → ANSWERED with a
 *    pointer to the release or requirement that carries the answer.
 *
 * No new status set for requirements (§96/§97): OPEN/ANSWERED describe a
 * question, DECIDED a decision. Figures and examples in the clauses are data,
 * never a whitelist (R01-A1, §18.1).
 *
 * `checkOpenQuestionsRegister` reads production rows and returns a probe-shaped
 * result. It is deliberately not registered as `r01.gov-11` here: probes live
 * under the protected verification path, and an implementer may not write its
 * own exam (§96).
 */
import { getDb } from '../../db/database.ts';

export const REGISTER_SOURCE_ITEMS = { decisions: 'S-0097', questions: 'S-0098' } as const;
export const ARCHITECTURE_PROGRAM_SUBMISSION_KEY = 'brain-architecture';

export interface RegisterDecision {
  id: string;
  status: 'DECIDED';
  clause: string;
}

export interface RegisterQuestion {
  id: string;
  status: 'OPEN' | 'ANSWERED';
  clause: string;
  /** The release number or requirement id that carries the answer; null while OPEN. */
  answer: string | null;
}

export interface OpenQuestionsRegister {
  decisions: readonly RegisterDecision[];
  questions: readonly RegisterQuestion[];
}

export const OPEN_QUESTIONS_REGISTER: OpenQuestionsRegister = {
  decisions: [
    { id: 'GOV-11-D1', status: 'DECIDED', clause: 'Financial milestones such as 10K/100K/1M are examples, not hard-coded progressions.' },
    { id: 'GOV-11-D2', status: 'DECIDED', clause: 'Near-term collected-money objectives matter, but substantial reinvestment is expected during the build phase.' },
    { id: 'GOV-11-D3', status: 'DECIDED', clause: 'Different businesses are permitted to have different extraction, growth and creative-funding roles.' },
    { id: 'GOV-11-D4', status: 'DECIDED', clause: 'The range of commercial possibilities must not be limited to Brain’s database or to presently fashionable AI services.' },
    { id: 'GOV-11-D5', status: 'DECIDED', clause: 'Ideas should morph repeatedly, combine across markets and generate new opportunities from their own transformed elements.' },
    { id: 'GOV-11-D6', status: 'DECIDED', clause: 'The user will continue adding and refining the architecture; preserve the unabridged intent.' },
    { id: 'GOV-11-D7', status: 'DECIDED', clause: 'Avoid repeated rhetorical restatements and oversimplified explanations. Engage at a technical and strategic level.' },
  ],
  questions: [
    { id: 'GOV-11-Q1', status: 'OPEN', answer: null, clause: 'Exact mechanics and representation of the ‘thinking map’ and idea-transforming operations.' },
    { id: 'GOV-11-Q2', status: 'OPEN', answer: null, clause: 'What degree of novelty/diversity is useful, and how the system should prioritize emerging branches.' },
    { id: 'GOV-11-Q3', status: 'OPEN', answer: null, clause: 'Capital-governance policies and financial structures for differing business archetypes.' },
    { id: 'GOV-11-Q4', status: 'OPEN', answer: null, clause: 'How aggressively future objectives may consume scarce resources from present obligations.' },
    { id: 'GOV-11-Q5', status: 'OPEN', answer: null, clause: 'Exact target levels for concurrent research throughput, worker utilization and minimum exploration.' },
    { id: 'GOV-11-Q6', status: 'OPEN', answer: null, clause: 'Full product interaction and visualization requirements.' },
    { id: 'GOV-11-Q7', status: 'OPEN', answer: null, clause: 'Calibration/decision rules for optional or mandatory confidence thresholds in future goals.' },
  ],
};

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The answer the owner gave to a question, or null. Null means nobody has
 * answered: a caller must treat it as unknown — never as a default, and never as
 * a reason to rank anything higher (§7.39).
 */
export function ownerAnswer(questionId: string, register: OpenQuestionsRegister = OPEN_QUESTIONS_REGISTER): string | null {
  const q = register.questions.find((e) => e.id === questionId);
  return q && q.status === 'ANSWERED' ? q.answer : null;
}

/** The questions still open, verbatim. */
export function openQuestions(register: OpenQuestionsRegister = OPEN_QUESTIONS_REGISTER): RegisterQuestion[] {
  return register.questions.filter((q) => q.status === 'OPEN');
}

/** The register's own shape: unique ids, a clause on every entry, status and answer coherent. */
export function registerShapeProblems(register: OpenQuestionsRegister = OPEN_QUESTIONS_REGISTER): string[] {
  const problems: string[] = [];
  const entries = [...register.decisions, ...register.questions];
  const ids = entries.map((e) => e.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`${id} is repeated`);
  for (const e of entries) if (squash(e.clause) === '') problems.push(`${e.id} has no clause`);
  for (const d of register.decisions) if (d.status !== 'DECIDED') problems.push(`${d.id} is a decision but is not DECIDED`);
  for (const q of register.questions) {
    if (q.status === 'OPEN' && q.answer !== null) problems.push(`${q.id} is OPEN but carries an answer or default`);
    if (q.status === 'ANSWERED' && (q.answer === null || q.answer.trim() === '')) problems.push(`${q.id} is ANSWERED but names no release or requirement`);
    if (q.status !== 'OPEN' && q.status !== 'ANSWERED') problems.push(`${q.id} has status ${String(q.status)}`);
  }
  return problems;
}

/**
 * The clauses a source item states: its lead-in removed, its list split on the
 * " - " bullets the extractor leaves when it joins the item's lines.
 */
export function sourceClauses(itemText: string, leadIn: string): string[] {
  let text = squash(itemText);
  if (text.startsWith(leadIn)) text = text.slice(leadIn.length);
  return text
    .split(/(?:^|\s)-\s+/)
    .map(squash)
    .filter((c) => c !== '');
}

const LEAD_INS = { decisions: 'Decisions established by the owner', questions: 'To define as the user continues' } as const;

/**
 * The register against the specification text of S-0097 and S-0098: every
 * clause is verbatim in its item (verbatim), every clause the item states is in
 * the register (retained), in the item's order.
 */
export function registerAgainstSource(
  itemTexts: { decisions: string; questions: string },
  register: OpenQuestionsRegister = OPEN_QUESTIONS_REGISTER,
): string[] {
  const problems: string[] = [];
  const compare = (kind: 'decisions' | 'questions', entries: readonly { id: string; clause: string }[]): void => {
    const item = REGISTER_SOURCE_ITEMS[kind];
    const stated = sourceClauses(itemTexts[kind], LEAD_INS[kind]);
    const held = entries.map((e) => squash(e.clause));
    entries.forEach((e, i) => {
      if (!stated.includes(held[i]!)) problems.push(`${e.id} is not verbatim in ${item}`);
    });
    for (const clause of stated) if (!held.includes(clause)) problems.push(`${item} states a clause the register does not hold: "${clause.slice(0, 60)}"`);
    const order = stated.filter((c) => held.includes(c));
    if (order.length === held.length && order.some((c, i) => c !== held[i])) problems.push(`the register does not follow the order of ${item}`);
  };
  compare('decisions', register.decisions);
  compare('questions', register.questions);
  return problems;
}

/**
 * A re-map from one version of the register to the next. Allowed: an OPEN
 * question becomes ANSWERED with a pointer; new entries are appended. Refused:
 * an entry removed, a clause rewritten, an answer withdrawn or replaced.
 */
export function registerRemapProblems(before: OpenQuestionsRegister, after: OpenQuestionsRegister): string[] {
  const problems: string[] = [];
  const index = (r: OpenQuestionsRegister): Map<string, RegisterDecision | RegisterQuestion> =>
    new Map([...r.decisions, ...r.questions].map((e) => [e.id, e]));
  const next = index(after);
  for (const [id, prior] of index(before)) {
    const now = next.get(id);
    if (!now) {
      problems.push(`${id} was removed`);
      continue;
    }
    if (squash(now.clause) !== squash(prior.clause)) problems.push(`${id} had its clause rewritten`);
    if (prior.status === 'ANSWERED' && now.status !== 'ANSWERED') problems.push(`${id} went back from ANSWERED to ${now.status}`);
    if (prior.status === 'ANSWERED' && 'answer' in prior && 'answer' in now && prior.answer !== now.answer) problems.push(`${id} had its answer replaced`);
  }
  return [...problems, ...registerShapeProblems(after)];
}

/**
 * Read the register document: each `| GOV-11-… |` table row. Status, clause and
 * (for a question) answer; "none recorded" reads as no answer.
 */
export function parseRegisterDocument(markdown: string): OpenQuestionsRegister {
  const decisions: RegisterDecision[] = [];
  const questions: RegisterQuestion[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*(GOV-11-([DQ])\d+)\s*\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const cells = m[3]!.split('|').map((c) => c.trim());
    if (m[2] === 'D') decisions.push({ id: m[1]!, status: cells[0] as 'DECIDED', clause: cells[1] ?? '' });
    else {
      const answer = cells[2] ?? '';
      questions.push({
        id: m[1]!,
        status: cells[0] as 'OPEN' | 'ANSWERED',
        clause: cells[1] ?? '',
        answer: answer === '' || answer === 'none recorded' ? null : answer,
      });
    }
  }
  return { decisions, questions };
}

export interface RegisterCheck {
  ok: boolean;
  detail: string;
}

/**
 * The register against production records: the architecture program on file,
 * its stored source (with every appended release), and the S-0097/S-0098 items
 * in it. Read-only.
 */
export async function checkOpenQuestionsRegister(register: OpenQuestionsRegister = OPEN_QUESTIONS_REGISTER): Promise<RegisterCheck> {
  const { getProgram } = await import('../../repos/factoryProgram.ts');
  const { extractSourceItems, programSource, sha256 } = await import('../factory/program/spec.ts');
  const row = await getDb().get<{ id: string }>(`SELECT id FROM factory_programs WHERE submission_key = ? ORDER BY created_at LIMIT 1`, [
    ARCHITECTURE_PROGRAM_SUBMISSION_KEY,
  ]);
  const program = row ? await getProgram(row.id) : null;
  if (!program) return { ok: false, detail: `no program filed under "${ARCHITECTURE_PROGRAM_SUBMISSION_KEY}"` };
  if (sha256(program.sourceText) !== program.sourceSha256) return { ok: false, detail: `program ${program.id}: the stored source no longer matches its hash` };
  const source = programSource(program);
  const items = extractSourceItems(source);
  const decisions = items.find((i) => i.id === REGISTER_SOURCE_ITEMS.decisions);
  const questions = items.find((i) => i.id === REGISTER_SOURCE_ITEMS.questions);
  if (!decisions || !questions) return { ok: false, detail: `program ${program.id}: the source has no ${REGISTER_SOURCE_ITEMS.decisions}/${REGISTER_SOURCE_ITEMS.questions}` };
  const problems = [
    ...registerShapeProblems(register),
    ...registerAgainstSource({ decisions: source.slice(decisions.start, decisions.end), questions: source.slice(questions.start, questions.end) }, register),
  ];
  if (problems.length > 0) return { ok: false, detail: `program ${program.id}: ${problems.slice(0, 3).join('; ')}` };
  const open = openQuestions(register).length;
  return {
    ok: true,
    detail: `program ${program.id}: ${register.decisions.length} decisions and ${register.questions.length} questions verbatim in ${REGISTER_SOURCE_ITEMS.decisions}/${REGISTER_SOURCE_ITEMS.questions}; ${open} open with no default, ${register.questions.length - open} answered`,
  };
}
