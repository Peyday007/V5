/**
 * GOV-11: the owner's decisions and open questions are a maintained register
 * that code reads. The document is pinned to the code, the code to the real
 * program source, an OPEN question to carrying no default, and a re-map to
 * never removing or rewriting an entry.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { ensureProgram } from '../server/repos/factoryProgram.ts';
import { extractSourceItems, sha256 } from '../server/services/factory/program/spec.ts';
import {
  ARCHITECTURE_PROGRAM_SUBMISSION_KEY,
  OPEN_QUESTIONS_REGISTER,
  checkOpenQuestionsRegister,
  openQuestions,
  ownerAnswer,
  parseRegisterDocument,
  registerAgainstSource,
  registerRemapProblems,
  registerShapeProblems,
  type OpenQuestionsRegister,
} from '../server/services/goals/openQuestions.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const doc = read('../docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md');
const source = read('../objectives/programs/brain-architecture/release-01.md');
const items = extractSourceItems(source);
const itemText = (id: string): string => {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`release-01 has no ${id}`);
  return source.slice(item.start, item.end);
};
const S97 = itemText('S-0097');
const S98 = itemText('S-0098');

afterAll(teardown);

describe('GOV-11 open-questions register', () => {
  it('the document and the code are the same register, entry for entry', () => {
    expect(parseRegisterDocument(doc)).toEqual(OPEN_QUESTIONS_REGISTER);
  });

  it('holds S-0097 and S-0098 of the real program source verbatim, completely and in order', () => {
    expect(registerAgainstSource({ decisions: S97, questions: S98 })).toEqual([]);
    // Line wrapping does not matter; a changed word, a lost clause or a new one does.
    expect(registerAgainstSource({ decisions: S97.replace(/ /g, '\n'), questions: S98 })).toEqual([]);
    expect(registerAgainstSource({ decisions: S97.replace('are examples', 'are targets'), questions: S98 })).toContain('GOV-11-D1 is not verbatim in S-0097');
    expect(registerAgainstSource({ decisions: S97, questions: `${S98} - A question the owner adds later.` }).join()).toMatch(/S-0098 states a clause the register does not hold/);
    const dropped: OpenQuestionsRegister = { ...OPEN_QUESTIONS_REGISTER, questions: OPEN_QUESTIONS_REGISTER.questions.slice(1) };
    expect(registerAgainstSource({ decisions: S97, questions: S98 }, dropped).join()).toMatch(/S-0098 states a clause the register does not hold: "Exact mechanics/);
    const reordered: OpenQuestionsRegister = { ...OPEN_QUESTIONS_REGISTER, decisions: [...OPEN_QUESTIONS_REGISTER.decisions].reverse() };
    expect(registerAgainstSource({ decisions: S97, questions: S98 }, reordered)).toContain('the register does not follow the order of S-0097');
  });

  it('an OPEN question carries no answer and no default, and a reader gets null', () => {
    expect(registerShapeProblems()).toEqual([]);
    expect(openQuestions().map((q) => q.id)).toEqual(['GOV-11-Q1', 'GOV-11-Q2', 'GOV-11-Q3', 'GOV-11-Q4', 'GOV-11-Q5', 'GOV-11-Q6', 'GOV-11-Q7']);
    for (const q of OPEN_QUESTIONS_REGISTER.questions) expect(ownerAnswer(q.id)).toBeNull();
    const defaulted: OpenQuestionsRegister = {
      ...OPEN_QUESTIONS_REGISTER,
      questions: [{ ...OPEN_QUESTIONS_REGISTER.questions[0]!, answer: 'assume 20% exploration' }],
    };
    expect(registerShapeProblems(defaulted)).toContain('GOV-11-Q1 is OPEN but carries an answer or default');
    expect(ownerAnswer('GOV-11-Q1', defaulted)).toBeNull();
  });

  it('answering re-maps the entry; removing, rewriting or un-answering is refused', () => {
    const before = OPEN_QUESTIONS_REGISTER;
    const answered: OpenQuestionsRegister = {
      ...before,
      questions: before.questions.map((q) => (q.id === 'GOV-11-Q5' ? { ...q, status: 'ANSWERED' as const, answer: 'Release 02' } : q)),
    };
    expect(registerRemapProblems(before, answered)).toEqual([]);
    expect(ownerAnswer('GOV-11-Q5', answered)).toBe('Release 02');
    expect(openQuestions(answered)).toHaveLength(6);

    const unmapped = { ...before, questions: before.questions.map((q) => (q.id === 'GOV-11-Q5' ? { ...q, status: 'ANSWERED' as const } : q)) };
    expect(registerRemapProblems(before, unmapped).join()).toMatch(/GOV-11-Q5 is ANSWERED but names no release/);
    const removed = { ...before, questions: before.questions.filter((q) => q.id !== 'GOV-11-Q2') };
    expect(registerRemapProblems(before, removed)).toContain('GOV-11-Q2 was removed');
    const rewritten = { ...before, decisions: before.decisions.map((d) => (d.id === 'GOV-11-D1' ? { ...d, clause: 'Reach 10K, then 100K, then 1M.' } : d)) };
    expect(registerRemapProblems(before, rewritten)).toContain('GOV-11-D1 had its clause rewritten');
    expect(registerRemapProblems(answered, before)).toContain('GOV-11-Q5 went back from ANSWERED to OPEN');
    const replaced = { ...answered, questions: answered.questions.map((q) => (q.id === 'GOV-11-Q5' ? { ...q, answer: 'R03' } : q)) };
    expect(registerRemapProblems(answered, replaced)).toContain('GOV-11-Q5 had its answer replaced');
  });

  it('is checked against the program rows: fails with none on file, passes on the real source, fails on an altered one', async () => {
    const { project } = await freshProject();
    const none = await checkOpenQuestionsRegister();
    expect(none.ok).toBe(false);
    expect(none.detail).toMatch(/no program filed/);

    const { program } = await ensureProgram({
      projectId: project.id,
      submissionKey: ARCHITECTURE_PROGRAM_SUBMISSION_KEY,
      title: 'Brain architecture',
      sourceText: source,
      sourceSha256: sha256(source),
      repository: 'Peyday007/V5',
      baseBranch: 'production',
    });
    const held = await checkOpenQuestionsRegister();
    expect(held.ok).toBe(true);
    expect(held.detail).toContain(program.id);
    expect(held.detail).toMatch(/7 decisions and 7 questions verbatim in S-0097\/S-0098; 7 open with no default, 0 answered/);

    const altered: OpenQuestionsRegister = {
      ...OPEN_QUESTIONS_REGISTER,
      questions: OPEN_QUESTIONS_REGISTER.questions.map((q) => (q.id === 'GOV-11-Q3' ? { ...q, clause: 'Capital governance is settled.' } : q)),
    };
    const refused = await checkOpenQuestionsRegister(altered);
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(/GOV-11-Q3 is not verbatim in S-0098/);
  });
});
