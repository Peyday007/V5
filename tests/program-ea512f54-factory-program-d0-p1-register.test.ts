/**
 * GOV-11: the owner's decisions and open questions are a maintained register that
 * code reads. These tests pin the document to the code, the code to the source
 * wording, and an OPEN question to carrying no default.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import {
  OPEN_QUESTIONS,
  OWNER_DECISIONS,
  registerAgainstSource,
  registerShapeProblems,
  type RegisterQuestion,
} from '../server/services/goals/openQuestions.ts';
import '../server/services/goals/plan.ts';

const doc = readFileSync(new URL('../docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md', import.meta.url), 'utf8');

function rows(section: string): string[][] {
  return doc
    .split('\n')
    .filter((l) => l.startsWith(`| ${section}`))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
}

// The wording of the two source items, as the specification states them.
const S97 = [
  'Decisions established by the owner',
  ...OWNER_DECISIONS.map((d) => `- ${d.clause}`),
].join('\n');
const S98 = ['To define as the user continues', ...OPEN_QUESTIONS.map((q) => `- ${q.clause}`)].join('\n');

describe('GOV-11 register', () => {
  it('is the same register as the document, entry for entry, clause verbatim', () => {
    const decisions = rows('GOV-11-D');
    expect(decisions.map((r) => [r[0], r[2]])).toEqual(OWNER_DECISIONS.map((d) => [d.id, d.clause]));
    const questions = rows('GOV-11-Q');
    expect(questions.map((r) => [r[0], r[1], r[2]])).toEqual(OPEN_QUESTIONS.map((q) => [q.id, q.status, q.clause]));
    for (const r of questions) {
      const q = OPEN_QUESTIONS.find((x) => x.id === r[0])!;
      expect(r[3]).toBe(q.answer ?? 'none recorded');
    }
  });

  it('has a coherent shape: an OPEN question carries no answer, an ANSWERED one names where', () => {
    expect(registerShapeProblems()).toEqual([]);
    const defaulted: RegisterQuestion[] = [{ ...OPEN_QUESTIONS[0]!, answer: 'assume yes' }];
    expect(registerShapeProblems(OWNER_DECISIONS, defaulted)).toContain('GOV-11-Q1 is OPEN but carries an answer or default');
    const unmapped: RegisterQuestion[] = [{ ...OPEN_QUESTIONS[0]!, status: 'ANSWERED' }];
    expect(registerShapeProblems(OWNER_DECISIONS, unmapped).join()).toMatch(/ANSWERED but names no release/);
    expect(registerShapeProblems([OWNER_DECISIONS[0]!, OWNER_DECISIONS[0]!])).toContain('an entry id is repeated');
  });

  it('holds exactly what the source items state: verbatim, complete, nothing paraphrased', () => {
    expect(registerAgainstSource({ decisions: S97, questions: S98 })).toEqual([]);
    // PDF line wrapping does not matter, a changed word does.
    expect(registerAgainstSource({ decisions: S97.replace(/ /g, '\n'), questions: S98 })).toEqual([]);
    expect(registerAgainstSource({ decisions: S97.replace('examples', 'targets'), questions: S98 })).toContain('GOV-11-D1 is not verbatim in S-0097');
    expect(registerAgainstSource({ decisions: S97, questions: `${S98}\n- A new question the owner adds.` })).toContain('S-0098 states a question the register does not hold');
    expect(registerAgainstSource({ decisions: `${S97}\n- A new decision.`, questions: S98 })).toContain('S-0097 states a decision the register does not hold');
  });

  it('is judged by probe r01.gov-11, which fails with no program on record rather than passing', async () => {
    const probe = getProbe('r01.gov-11');
    expect(probe).not.toBeNull();
    await freshProject();
    const result = await probe!({});
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no program filed/);
  });
});
