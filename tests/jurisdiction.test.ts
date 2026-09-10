/**
 * Where the work is, and what Brain may say about it.
 *
 * The defect this file exists for was visible in production and looked like
 * nothing: a compiled objective read *"Establish, from official Michigan public
 * records, … Brightpath Family Dental … in Westbrook, OH"*. Every row was
 * healthy, the mission ran, and the specification asked a question about the
 * wrong state — which a worker would then have researched correctly and
 * answered wrongly.
 *
 * Two things caused it and both are tested here: a postal abbreviation is not
 * the word, and a jurisdiction nothing named is not a jurisdiction to assert.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  properName,
  stateFromField,
  stateFromPlace,
  statesNamedIn,
} from '../server/domain/jurisdiction.ts';
import { subjectContextFor } from '../server/services/russell/subject.ts';
import { compileMission } from '../server/services/russell/compiler.ts';
import { syncRecords, runCommand } from '../server/services/connect/service.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { freshProject, teardown, type TestProject } from './helpers.ts';

describe('reading a jurisdiction out of a field', () => {
  it('reads a postal code, because the column means a state', () => {
    expect(stateFromField('OH')).toBe('ohio');
    expect(stateFromField('mi')).toBe('michigan');
    expect(stateFromField('M.I.')).toBe('michigan');
    expect(stateFromField(' NY ')).toBe('new york');
  });

  it('reads a full name', () => {
    expect(stateFromField('Michigan')).toBe('michigan');
    expect(stateFromField('north carolina')).toBe('north carolina');
  });

  it('answers null rather than guessing', () => {
    expect(stateFromField('XX')).toBeNull();
    expect(stateFromField('')).toBeNull();
    expect(stateFromField('Ontario')).toBeNull();
    expect(stateFromField(42)).toBeNull();
    expect(stateFromField(null)).toBeNull();
  });
});

describe('reading a jurisdiction out of a place', () => {
  it('takes the state after the last comma', () => {
    expect(stateFromPlace('Westbrook, OH')).toBe('ohio');
    expect(stateFromPlace('Oakland County, Michigan')).toBe('michigan');
    expect(stateFromPlace('Detroit, MI 48226')).toBe('michigan');
  });

  it('reads a bare name but never a bare code', () => {
    expect(stateFromPlace('Michigan')).toBe('michigan');
    // `OR` with no comma is far more often the word.
    expect(stateFromPlace('OR')).toBeNull();
  });

  it('answers null on a place it cannot read', () => {
    expect(stateFromPlace('Somewhere')).toBeNull();
    expect(stateFromPlace('Toronto, ON')).toBeNull();
  });
});

describe('reading a jurisdiction out of prose', () => {
  it('finds a full name anywhere', () => {
    expect(statesNamedIn('does Michigan license this?')).toEqual(['michigan']);
  });

  it('finds a postal abbreviation only in the form that is unambiguous', () => {
    expect(statesNamedIn('a deal in Westbrook, OH that needs roofing')).toEqual(['ohio']);
    // The whole reason the rule is narrow: these are English, not states.
    expect(statesNamedIn('do we roof this, or not')).toEqual([]);
    expect(statesNamedIn('the work is in progress')).toEqual([]);
    expect(statesNamedIn('tell me, ok')).toEqual([]);
    expect(statesNamedIn('write to me, hi there')).toEqual([]);
  });

  it('reports two when the text genuinely names two', () => {
    expect(statesNamedIn('compare Michigan and Ohio')).toEqual(['michigan', 'ohio']);
  });

  it('gives the display form callers render', () => {
    expect(properName('ohio')).toBe('Ohio');
    expect(properName('new york')).toBe('New York');
  });
});

describe('the subject behind an idea', () => {
  let ctx: TestProject;

  const delivery = (over: Record<string, unknown> = {}) => ({
    sourceRecordType: 'OPPORTUNITY',
    sourceRecordId: 'opp_alpha',
    sourceVersion: '2026-09-01T10:00:00.000Z',
    title: 'Roof replacement across 40 units',
    summary: 'A property manager needs 40 roofs replaced before winter.',
    sourceRef: '/opportunities/opp_alpha',
    attributes: { stage: 'QUALIFYING', ...over },
  });

  async function register(over: Record<string, unknown> = {}): Promise<string> {
    await syncRecords({
      projectId: ctx.project.id,
      sourceSystem: 'DEAL_DISPATCH',
      records: [delivery(over)],
    });
    const result = await runCommand({
      projectId: ctx.project.id,
      sourceSystem: 'DEAL_DISPATCH',
      sourceRecordId: 'opp_alpha',
      command: 'RESEARCH_FURTHER',
    });
    return result.candidateId;
  }

  beforeEach(async () => {
    ctx = await freshProject();
  });

  afterEach(async () => {
    await teardown();
  });

  it('prefers the column that means a state', async () => {
    const id = await register({ state: 'OH', location: 'Westbrook, MI' });
    const subject = await subjectContextFor({ id });
    expect(subject.jurisdiction).toEqual({ value: 'Ohio', from: 'RECORD_STATE' });
    expect(subject.origin?.recordId).toBe('opp_alpha');
  });

  it('falls back to the location when there is no state column', async () => {
    const id = await register({ location: 'Westbrook, OH' });
    const subject = await subjectContextFor({ id });
    expect(subject.jurisdiction).toEqual({ value: 'Ohio', from: 'RECORD_LOCATION' });
  });

  it('says it does not know rather than defaulting', async () => {
    const id = await register({ location: 'Somewhere' });
    const subject = await subjectContextFor({ id });
    expect(subject.jurisdiction).toBeNull();
    expect(subject.origin).not.toBeNull();
  });

  it('answers nothing at all for an idea with no structured subject', async () => {
    const subject = await subjectContextFor({ id: 'rcn_not_a_real_candidate' });
    expect(subject.jurisdiction).toBeNull();
    expect(subject.origin).toBeNull();
  });
});

describe('what the compiler may assert', () => {
  let ctx: TestProject;

  async function registerAndCommand(over: Record<string, unknown>): Promise<string> {
    await syncRecords({
      projectId: ctx.project.id,
      sourceSystem: 'DEAL_DISPATCH',
      records: [
        {
          sourceRecordType: 'OPPORTUNITY',
          sourceRecordId: 'opp_alpha',
          sourceVersion: '2026-09-01T10:00:00.000Z',
          title: 'Roof replacement across 40 units',
          summary: 'A property manager needs 40 roofs replaced before winter.',
          attributes: over,
        },
      ],
    });
    const result = await runCommand({
      projectId: ctx.project.id,
      sourceSystem: 'DEAL_DISPATCH',
      sourceRecordId: 'opp_alpha',
      command: 'RESEARCH_FURTHER',
    });
    return result.candidateId;
  }

  beforeEach(async () => {
    ctx = await freshProject();
  });

  afterEach(async () => {
    await teardown();
  });

  it('refuses a record in a jurisdiction the standing authorization does not cover', async () => {
    const id = await registerAndCommand({ state: 'OH', location: 'Westbrook, OH' });
    const candidate = (await getCandidate(id))!;
    const compiled = await compileMission({
      candidate,
      project: ctx.project,
      archive: { claimsConsidered: 0, contradicting: [] },
    });

    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    // The exact failure the production objective hid: it must never compile a
    // Michigan specification for an Ohio record.
    expect(compiled.reason).toContain('Ohio');
    expect(compiled.reason).toContain('Michigan');
    expect(compiled.reason).toContain('decision for a person');
  });

  it('compiles a record the authorization does cover, and says where it is', async () => {
    const id = await registerAndCommand({ state: 'MI', location: 'Oakland County, MI' });
    const candidate = (await getCandidate(id))!;
    const compiled = await compileMission({
      candidate,
      project: ctx.project,
      archive: { claimsConsidered: 0, contradicting: [] },
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.mission.jurisdiction).toEqual({ value: 'Michigan', from: 'SUBJECT' });
    expect(compiled.mission.spec.objective).toContain('official Michigan public records');
  });

  it('names the authorization rather than the subject when nothing says where it is', async () => {
    const id = await registerAndCommand({ stage: 'QUALIFYING' });
    const candidate = (await getCandidate(id))!;
    const compiled = await compileMission({
      candidate,
      project: ctx.project,
      archive: { claimsConsidered: 0, contradicting: [] },
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.mission.jurisdiction.from).toBe('ENVELOPE');
    expect(compiled.mission.spec.objective).toContain('this project is authorized to search');
    expect(compiled.mission.spec.objective).toContain('names a jurisdiction of its own');
  });
});
