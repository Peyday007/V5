/**
 * GOV-11: the owner-decisions and open-questions register is held to its own
 * promises by code — verbatim against the program source, retained, no default
 * on an OPEN question, and an answer is a re-map rather than a rewrite.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSourceItems } from '../server/services/factory/program/spec.ts';
import {
  REGISTER_PATH,
  checkRegister,
  checkRegisterOnProduction,
  clausesOf,
  parseRegister,
  DECISIONS_LEAD,
} from '../server/services/goals/openQuestions.ts';

// The two source items exactly as Release 01 words them, line breaks and all
// (the program's source is extracted from the PDF, so wording is wrapped).
const SOURCE = `# 11. Decisions and open questions

Decisions established by the owner - Financial milestones such as 10K/100K/1M are examples, not
hard-coded progressions. - Near-term collected-money objectives matter, but substantial reinvestment is
expected during the build phase. - Different businesses are permitted to have different extraction, growth and
creative-funding roles. - The range of commercial possibilities must not be limited to Brain’s database or to
presently fashionable AI services. - Ideas should morph repeatedly, combine across markets and generate
new opportunities from their own transformed elements. - The user will continue adding and refining the
architecture; preserve the unabridged intent. - Avoid repeated rhetorical restatements and oversimplified
explanations. Engage at a technical and strategic level.

To define as the user continues - Exact mechanics and representation of the ‘thinking map’ and
idea-transforming operations. - What degree of novelty/diversity is useful, and how the system should
prioritize emerging branches. - Capital-governance policies and financial structures for differing business
archetypes. - How aggressively future objectives may consume scarce resources from present obligations. -
Exact target levels for concurrent research throughput, worker utilization and minimum exploration. - Full
product interaction and visualization requirements. - Calibration/decision rules for optional or mandatory
confidence thresholds in future goals.
`;

const items = extractSourceItems(SOURCE);
const register = readFileSync(REGISTER_PATH, 'utf8');

describe('GOV-11 open-questions register', () => {
  it('splits a source item into its clauses without breaking hyphenated words', () => {
    const decisions = clausesOf(items.find((i) => i.text.startsWith(DECISIONS_LEAD))!.text, DECISIONS_LEAD);
    expect(decisions).toHaveLength(7);
    expect(decisions[1]).toBe('Near-term collected-money objectives matter, but substantial reinvestment is expected during the build phase.');
  });

  it('the register as committed passes: verbatim, retained, open questions carry no default', () => {
    const check = checkRegister(register, items);
    expect(check.errors).toEqual([]);
    expect(check).toMatchObject({ ok: true, decisions: 7, open: 7, answered: 0 });
    expect(parseRegister(register)).toHaveLength(14);
  });

  it('refuses a paraphrased clause', () => {
    const edited = register.replace('are examples, not hard-coded progressions.', 'are only examples.');
    const check = checkRegister(edited, items);
    expect(check.ok).toBe(false);
    expect(check.errors.join('\n')).toMatch(/GOV-11-D1 is not verbatim/);
  });

  it('refuses a removed entry', () => {
    const edited = register.split('\n').filter((line) => !line.startsWith('| GOV-11-Q4 ')).join('\n');
    expect(checkRegister(edited, items).errors.join('\n')).toMatch(/GOV-11-Q4 .* is missing/);
  });

  it('refuses a default slipped into an OPEN question', () => {
    const edited = register.replace(/(\| GOV-11-Q5 \| OPEN \|[^|]+\| )none recorded \|/, '$1assume 80% utilization |');
    expect(checkRegister(edited, items).errors.join('\n')).toMatch(/GOV-11-Q5 is OPEN but carries "assume 80% utilization"/);
  });

  it('accepts an answer only as a re-map: pointer in the row and the owner wording appended', () => {
    const pointerOnly = register.replace(/\| GOV-11-Q6 \| OPEN \|([^|]+)\| none recorded \|/, '| GOV-11-Q6 | ANSWERED |$1| Release 02 |');
    expect(checkRegister(pointerOnly, items).errors.join('\n')).toMatch(/GOV-11-Q6 is ANSWERED but the owner's wording is not appended/);
    const remapped = `${pointerOnly}\n### GOV-11-Q6\n\nThe owner's answer, verbatim.\n`;
    expect(checkRegister(remapped, items)).toMatchObject({ ok: true, open: 6, answered: 1 });
    const rewritten = remapped.replace('Full product interaction and visualization requirements.', 'A dashboard.');
    expect(checkRegister(rewritten, items).errors.join('\n')).toMatch(/GOV-11-Q6 is not verbatim/);
  });

  it('refuses an appended entry whose wording the source does not contain', () => {
    const edited = register.replace('| GOV-11-Q7 |', '| GOV-11-Q8 | OPEN | Invented question. | none recorded |\n| GOV-11-Q7 |');
    expect(checkRegister(edited, items).errors.join('\n')).toMatch(/GOV-11-Q8 is not wording the program source contains/);
  });

  it('the production check reads both sides and never passes on a side it could not read', async () => {
    const loadItems = async () => ({ items, where: 'program fpg_test (0 release(s))' });
    const passed = await checkRegisterOnProduction({ loadItems, readRegister: async () => ({ text: register, where: 'register@rev' }) });
    expect(passed.ok).toBe(true);
    expect(passed.detail).toMatch(/7 decisions verbatim, 7 open question\(s\) without a default/);
    const unreadable = await checkRegisterOnProduction({ loadItems, readRegister: async () => ({ text: null, where: 'not at rev' }) });
    expect(unreadable).toMatchObject({ ok: false });
    const noProgram = await checkRegisterOnProduction({ loadItems: async () => null, readRegister: async () => ({ text: register, where: 'x' }) });
    expect(noProgram.ok).toBe(false);
  });
});
