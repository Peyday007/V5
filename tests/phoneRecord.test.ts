/**
 * What makes an attached phone reading evidence about a particular Brain.
 *
 * The reader this covers used to be a cast — `JSON.parse(...) as
 * DeployedPhoneRecord` — so any JSON object at all became a record, a reading
 * of a different deployment was read as evidence about this one, and a
 * `revisionMatches: true` beside two revisions that differ was believed. These
 * are the cases that used to pass.
 */
import { describe, expect, it } from 'vitest';
import { isPhoneRecord, phoneRecordProblems, type DeployedPhoneRecord } from '../scripts/phoneRecord.ts';

const HOST = 'northline-brain.fly.dev';
const REVISION = 'a'.repeat(40);

function record(over: Partial<DeployedPhoneRecord> = {}): DeployedPhoneRecord {
  return {
    brain: `https://${HOST}`,
    inspectedAt: '2026-09-14T10:00:00.000Z',
    deployedRevision: REVISION,
    expectedRevision: REVISION,
    revisionMatches: true,
    answeredQuestion: {
      found: true,
      status: 'COMPLETE',
      conversationId: 'rcv_one',
      excerpt: 'the fee is nineteen dollars',
      readOnScreen: true,
      screenSaw: 'READY: …',
    },
    missionLinkedResult: {
      found: true,
      missionId: 'rms_one',
      missionFromConversation: true,
      knowledgeId: 'rkn_one',
      statement: 'Washtenaw charges $19.',
      citesDocument: true,
      citesAudit: true,
      readOnScreen: true,
      screenSaw: 'READY: …',
    },
    screenshots: ['deployed-01-the-answer.png'],
    findings: [],
    ...over,
  };
}

describe('a reading has to be shaped like one', () => {
  it('accepts a complete record', () => {
    expect(isPhoneRecord(record())).toBe(true);
  });

  it.each([
    ['a bare object', {}],
    ['a string', 'not a record'],
    ['null', null],
    ['an array', []],
  ])('refuses %s', (_name, value) => {
    expect(isPhoneRecord(value)).toBe(false);
  });

  it('refuses a record whose halves are missing', () => {
    const partial = { ...record() } as Record<string, unknown>;
    delete partial['missionLinkedResult'];
    expect(isPhoneRecord(partial)).toBe(false);
  });

  it('refuses a timestamp that is not one', () => {
    expect(isPhoneRecord(record({ inspectedAt: 'yesterday' }))).toBe(false);
  });

  it('refuses findings that are not strings, which is how prose becomes a count', () => {
    expect(isPhoneRecord({ ...record(), findings: [{ note: 'something' }] })).toBe(false);
  });
});

describe('and it has to be about the Brain being judged', () => {
  const against = { intendedHost: HOST, revision: REVISION };

  it('accepts one of the intended host at this revision', () => {
    expect(phoneRecordProblems(record(), against)).toEqual([]);
  });

  it('refuses a reading of another deployment', () => {
    const problems = phoneRecordProblems(record({ brain: 'https://someone-else.fly.dev' }), against);
    expect(problems.join(' ')).toMatch(/evidence about something else/);
  });

  it('refuses an origin that is not https', () => {
    const problems = phoneRecordProblems(record({ brain: `http://${HOST}` }), against);
    expect(problems.join(' ')).toMatch(/not https/);
  });

  it('refuses a reading of a different revision of the same Brain', () => {
    const problems = phoneRecordProblems(record({ deployedRevision: 'b'.repeat(40) }), against);
    expect(problems.join(' ')).toMatch(/and this run is aaaaaaaa/);
  });

  it('refuses a reading that names no revision at all', () => {
    const problems = phoneRecordProblems(
      record({ deployedRevision: null, revisionMatches: null }),
      against,
    );
    expect(problems.join(' ')).toMatch(/names no deployed revision/);
  });

  /*
   * The contradiction cases. `revisionMatches` is the harness's own summary of
   * its own inputs, so a summary that disagrees with them means the record is
   * not internally consistent — at which point none of its other fields can be
   * trusted either, and it is refused rather than silently recomputed.
   */
  it('refuses a flag that says the revisions match when they do not', () => {
    const problems = phoneRecordProblems(
      record({ expectedRevision: 'c'.repeat(40), revisionMatches: true }),
      against,
    );
    expect(problems.join(' ')).toMatch(/revisionMatches says true/);
  });

  it('refuses a flag that says they differ when they are the same', () => {
    const problems = phoneRecordProblems(record({ revisionMatches: false }), against);
    expect(problems.join(' ')).toMatch(/revisionMatches says false/);
  });

  it('refuses a true flag with nothing to compare', () => {
    const problems = phoneRecordProblems(
      record({ expectedRevision: null, revisionMatches: true }),
      against,
    );
    expect(problems.join(' ')).toMatch(/one of the two revisions it compares is absent/);
  });

  it('accepts a null flag when only one revision is known, because that is honest', () => {
    expect(
      phoneRecordProblems(record({ expectedRevision: null, revisionMatches: null }), against),
    ).toEqual([]);
  });

  it('refuses everything when the run cannot say what it is judging', () => {
    const problems = phoneRecordProblems(record(), { intendedHost: null, revision: null });
    expect(problems.join(' ')).toMatch(/cannot say which Brain was intended/);
    expect(problems.join(' ')).toMatch(/cannot name its own revision/);
  });

  it('names each failure separately, because their remedies differ', () => {
    // Three at once: the wrong Brain, the wrong revision, and — because moving
    // the deployed revision leaves `revisionMatches: true` describing two
    // values that now differ — a record contradicting itself.
    const problems = phoneRecordProblems(
      record({ brain: 'https://elsewhere.fly.dev', deployedRevision: 'b'.repeat(40) }),
      against,
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/evidence about something else/);
    expect(problems[1]).toMatch(/and this run is aaaaaaaa/);
    expect(problems[2]).toMatch(/revisionMatches says true/);
  });
});
