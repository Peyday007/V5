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
  reconcileRegister,
  reconcileRegisterIfDue,
  releasesMapped,
  REGISTER_EVENT_KINDS,
  type RegisterEvent,
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

  it('states which appended releases it was re-mapped against', () => {
    expect(releasesMapped(register)).toBe(0);
    expect(checkRegister(register, items, { releases: [] }).errors).toEqual([]);
  });

  it('is behind a release appended after its marker, and current again once re-mapped', () => {
    const releases = [{ number: 1, title: 'Release 02' }];
    const behind = checkRegister(register, items, { releases });
    expect(behind.ok).toBe(false);
    expect(behind.errors.join('\n')).toMatch(/behind the program: release 1 "Release 02"/);
    const remapped = register.replace('**Appended releases mapped: 0**', '**Appended releases mapped: 1**');
    expect(checkRegister(remapped, items, { releases }).errors).toEqual([]);
    expect(checkRegister(remapped, items, { releases: [] }).errors.join('\n')).toMatch(/claims 1 appended release\(s\) mapped but the program has 0/);
    const unmarked = register.replace(/\*\*Appended releases mapped: 0\*\*/, 'Releases: see above');
    expect(checkRegister(unmarked, items, { releases: [] }).errors.join('\n')).toMatch(/states no "Appended releases mapped: N" line/);
  });

  it('a release listing a further open question needs its entry, numbered after the existing ones', () => {
    const release = `${SOURCE}\n# Release 02\n\nTo define as the user continues - Retention policy for superseded idea branches.\n`;
    const amended = extractSourceItems(release);
    const releases = [{ number: 1, title: 'Release 02' }];
    const marked = register.replace('**Appended releases mapped: 0**', '**Appended releases mapped: 1**');
    expect(checkRegister(marked, amended, { releases }).errors.join('\n')).toMatch(/GOV-11-Q8 .* is missing/);
    const added = marked.replace('| GOV-11-Q7 |', '| GOV-11-Q8 | OPEN | Retention policy for superseded idea branches. | none recorded |\n| GOV-11-Q7 |');
    expect(checkRegister(added, amended, { releases })).toMatchObject({ ok: true, open: 8 });
  });

  it('the goals tick records the outcome when it changes and stays silent when it does not', async () => {
    const recorded: RegisterEvent[] = [];
    let releases: { number: number; title: string }[] = [];
    let text = register;
    const ports = {
      check: () => checkRegisterOnProduction({
        loadItems: async () => ({ programId: 'fpg_test', items, releases, where: 'program fpg_test' }),
        readRegister: async () => ({ text, where: 'register@rev' }),
      }),
      latest: async () => recorded.at(-1) ?? null,
      record: async (kind: string, detail: Record<string, unknown>) => {
        recorded.push({ kind, detail });
      },
    };
    expect((await reconcileRegister(ports)).recorded).toBe(REGISTER_EVENT_KINDS.current);
    expect((await reconcileRegister(ports)).recorded).toBeNull();
    // A release appended through the amendment path: flagged on the next pass.
    releases = [{ number: 1, title: 'Release 02' }];
    const flagged = await reconcileRegister(ports);
    expect(flagged).toMatchObject({ ok: false, recorded: REGISTER_EVENT_KINDS.behind });
    expect(recorded.at(-1)!.detail.errors).toEqual([expect.stringMatching(/behind the program: release 1/)]);
    expect((await reconcileRegister(ports)).recorded).toBeNull();
    // The re-map reaches the running revision: recorded as current again.
    text = register.replace('**Appended releases mapped: 0**', '**Appended releases mapped: 1**');
    expect((await reconcileRegister(ports)).recorded).toBe(REGISTER_EVENT_KINDS.current);
    expect(recorded.map((e) => e.kind)).toEqual([REGISTER_EVENT_KINDS.current, REGISTER_EVENT_KINDS.behind, REGISTER_EVENT_KINDS.current]);
  });

  it('the tick pass is throttled and never throws into the tick', async () => {
    const failing = { check: async () => { throw new Error('forge down'); }, latest: async () => null, record: async () => {} };
    const start = 10 ** 13;
    expect(await reconcileRegisterIfDue(start, failing)).toEqual({ error: 'forge down' });
    expect(await reconcileRegisterIfDue(start + 1000, failing)).toBeNull();
  });
});
