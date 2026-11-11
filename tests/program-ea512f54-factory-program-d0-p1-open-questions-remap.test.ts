/**
 * GOV-11, the re-map half: "re-map it when the owner answers" is a mechanism.
 *
 * The register carries a ledger of the program releases it was re-mapped
 * against; the checker fails, naming the release, when the program has one the
 * register does not; and the goals tick re-runs the production check whenever a
 * release is appended (or a new revision runs) and records the verdict once per
 * change in the factory event ledger — against real program and amendment rows.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { appendAmendment, ensureProgram } from '../server/repos/factoryProgram.ts';
import { listFactoryEvents } from '../server/repos/factoryFleet.ts';
import { extractSourceItems, sha256 } from '../server/services/factory/program/spec.ts';
import { ARCHITECTURE_PROGRAM_KEY } from '../server/services/factory/program/probes.ts';
import { REGISTER_PATH, checkRegister, checkRegisterOnProduction, parseReleaseLedger } from '../server/services/goals/openQuestions.ts';
import {
  REGISTER_CHECK_KIND,
  REGISTER_WATCH_INTERVAL_MS,
  resetRegisterWatchForTests,
  watchRegister,
  watchRegisterIfDue,
} from '../server/services/goals/registerWatch.ts';
import { advanceGoals } from '../server/services/goals/tick.ts';

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

const RELEASE_02 = `# Release 02

## 12. Visualization

The product must show the thinking map as a navigable graph.
`;

const items = extractSourceItems(SOURCE);
const register = readFileSync(REGISTER_PATH, 'utf8');

describe('GOV-11 register re-map ledger', () => {
  it('the committed register is re-mapped through the original source', () => {
    expect(parseReleaseLedger(register)).toEqual([{ id: 'GOV-11-R0', number: 0, release: 'original source', answers: [] }]);
    expect(checkRegister(register, items, [])).toMatchObject({ ok: true, behind: [] });
  });

  it('fails, naming the release, when the program has a release the register was not re-mapped against', () => {
    const check = checkRegister(register, items, [{ number: 1, title: 'Release 02' }]);
    expect(check.ok).toBe(false);
    expect(check.behind).toEqual([1]);
    expect(check.errors.join('\n')).toMatch(/release 1 \("Release 02"\) is not re-mapped: the register has fallen behind/);
  });

  it('passes once the register is re-mapped: the ledger row, and every question it answers moved to ANSWERED', () => {
    const answered = register
      .replace(/\| GOV-11-Q6 \| OPEN \|([^|]+)\| none recorded \|/, '| GOV-11-Q6 | ANSWERED |$1| Release 02 (amendment 1) |')
      .replace('| GOV-11-R0 | original source | none |', '| GOV-11-R0 | original source | none |\n| GOV-11-R1 | Release 02 | GOV-11-Q6 |');
    const remapped = `${answered}\n### GOV-11-Q6\n\nThe product must show the thinking map as a navigable graph.\n`;
    expect(checkRegister(remapped, items, [{ number: 1, title: 'Release 02' }])).toMatchObject({ ok: true, behind: [], answered: 1 });

    // A ledger row that claims an answer the register did not re-map is refused.
    const claimedOnly = register.replace('| GOV-11-R0 | original source | none |', '| GOV-11-R0 | original source | none |\n| GOV-11-R1 | Release 02 | GOV-11-Q6 |');
    expect(checkRegister(claimedOnly, items, [{ number: 1, title: 'Release 02' }]).errors.join('\n')).toMatch(/GOV-11-R1 says it answered GOV-11-Q6, but GOV-11-Q6 is still OPEN/);
  });

  it('refuses a ledger row for a release the program does not have, or under another title', () => {
    const invented = register.replace('| GOV-11-R0 | original source | none |', '| GOV-11-R0 | original source | none |\n| GOV-11-R3 | Release 04 | none |');
    expect(checkRegister(invented, items, []).errors.join('\n')).toMatch(/GOV-11-R3 names a release the program does not have/);
    const retitled = register.replace('| GOV-11-R0 | original source | none |', '| GOV-11-R0 | original source | none |\n| GOV-11-R1 | Release Two | none |');
    expect(checkRegister(retitled, items, [{ number: 1, title: 'Release 02' }]).errors.join('\n')).toMatch(/GOV-11-R1 names "Release Two", but release 1 is "Release 02"/);
  });

  it('the production check fails a register behind a stored release', async () => {
    const behind = await checkRegisterOnProduction({
      loadItems: async () => ({ items, where: 'program fpg_test (1 release(s))', releases: [{ number: 1, title: 'Release 02' }] }),
      readRegister: async () => ({ text: register, where: 'register@rev' }),
    });
    expect(behind.ok).toBe(false);
    expect(behind.check?.behind).toEqual([1]);
  });
});

describe('GOV-11 register watch on the goals tick', () => {
  let projectId = '';
  beforeAll(async () => {
    projectId = (await freshProject()).project.id;
  });
  afterAll(async () => {
    await teardown();
  });

  const readRegister = async () => ({ text: register, where: 'register@rev' });

  it('looks at nothing when no architecture program is filed', async () => {
    expect(await watchRegister()).toEqual({ outcome: 'NO_PROGRAM' });
  });

  it('re-checks when a release is appended, records each changed verdict once, and stays quiet otherwise', async () => {
    const { program } = await ensureProgram({
      projectId,
      submissionKey: ARCHITECTURE_PROGRAM_KEY,
      title: 'Brain-architecture',
      sourceText: SOURCE,
      sourceSha256: sha256(SOURCE),
      repository: 'https://github.com/Peyday007/V5',
      baseBranch: 'production',
    });
    // The real production check, with the register side supplied (no forge in a test).
    const check = () => checkRegisterOnProduction({ readRegister });
    const events = async () => (await listFactoryEvents(null, { kinds: [REGISTER_CHECK_KIND] })).filter((one) => one.detail['programId'] === program.id);

    const first = await watchRegister({ check });
    expect(first).toMatchObject({ outcome: 'CHECKED', ok: true, behind: [], recorded: true });
    expect(await events()).toHaveLength(1);

    // Nothing moved: no check, no row.
    expect(await watchRegister({ check })).toMatchObject({ outcome: 'UNCHANGED' });
    expect(await events()).toHaveLength(1);

    // The §97 amendment path appends a release: the register is now behind it, and that is recorded.
    await appendAmendment({ programId: program.id, title: 'Release 02', sourceText: RELEASE_02, sourceSha256: sha256(RELEASE_02), actorType: 'PERSON', actorId: null });
    const afterRelease = await watchRegister({ check });
    expect(afterRelease).toMatchObject({ outcome: 'CHECKED', ok: false, behind: [1], recorded: true });
    const recorded = await events();
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.detail).toMatchObject({ ok: false, behind: [1], releases: 1, latestRelease: 1 });
    expect(String(recorded[1]!.detail['detail'])).toMatch(/release 1 \("Release 02"\) is not re-mapped/);
    // A failing verdict is looked at again (it may have been a read that failed),
    // but the same verdict is not recorded twice.
    expect(await watchRegister({ check })).toMatchObject({ outcome: 'CHECKED', ok: false, recorded: false });
    expect(await events()).toHaveLength(2);
  });

  it('a failed read is retried on the next look, and a recovered verdict is recorded', async () => {
    const { program } = await ensureProgram({
      projectId,
      submissionKey: ARCHITECTURE_PROGRAM_KEY,
      title: 'Brain-architecture',
      sourceText: SOURCE,
      sourceSha256: sha256(SOURCE),
      repository: 'https://github.com/Peyday007/V5',
      baseBranch: 'production',
    });
    const verdicts = async () => (await listFactoryEvents(null, { kinds: [REGISTER_CHECK_KIND] })).filter((one) => one.detail['programId'] === program.id).map((one) => one.detail['detail']);
    const before = (await verdicts()).length;
    const unreadable = async () => ({ ok: false, detail: 'the register is not readable: forge timed out', check: null });
    const readable = async () => ({ ok: true, detail: 'register re-mapped through every release', check: null });
    expect(await watchRegister({ check: unreadable })).toMatchObject({ outcome: 'CHECKED', ok: false, recorded: true });
    // The read failed, not the register: the next look tries again rather than trusting the failure.
    expect(await watchRegister({ check: readable })).toMatchObject({ outcome: 'CHECKED', ok: true, recorded: true });
    expect((await verdicts()).slice(before)).toEqual(['the register is not readable: forge timed out', 'register re-mapped through every release']);
    // A pass holds until something moves.
    expect(await watchRegister({ check: unreadable })).toMatchObject({ outcome: 'UNCHANGED' });
  });

  it('runs from advanceGoals at most once per interval, and a failing look never stops the tick', async () => {
    resetRegisterWatchForTests();
    const at = Date.parse('2026-11-11T08:00:00.000Z');
    const report = await advanceGoals({ now: new Date(at).toISOString() });
    expect(report.register).not.toBeNull();
    const again = await advanceGoals({ now: new Date(at + 1000).toISOString() });
    expect(again.register).toBeNull();
    const failing = await watchRegisterIfDue(at + REGISTER_WATCH_INTERVAL_MS, {
      fingerprint: async () => {
        throw new Error('database busy');
      },
    });
    expect(failing).toBeNull();
  });
});
