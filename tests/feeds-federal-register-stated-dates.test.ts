/**
 * The Federal Register parser records a date the source states only in its
 * official `dates` field (effective_on null) as the marker sentence
 * "Stated effective YYYY-MM-DD." — the contract RULE_EFFECTIVE_SOON@6 reads.
 * Built from the recorded Coast Guard rows (2026-23230 Miami Winterfest,
 * 2026-23047 San Diego Fleet Week: action "Notification of enforcement of
 * regulation", effective_on null) and C1-2026-21030 (dates null).
 */
import { describe, expect, it } from 'vitest';
import { FEED_SOURCES, federalRegisterActionStatesEffect, federalRegisterStatedDate, parseFederalRegister } from '../server/services/feeds/sources.ts';

const USCG = [
  { id: 227, name: 'Homeland Security Department', parent_id: null },
  { id: 85, name: 'Coast Guard', parent_id: 227 },
];

const row = (over: Record<string, unknown>) => ({
  document_number: '2026-23230',
  title: 'Special Local Regulation: Marine Events Within the Captain of the Port Miami, Seminole Hard Rock Winterfest Holiday Boat Parade',
  html_url: 'https://www.federalregister.gov/documents/2026/11/16/2026-23230/special-local-regulation',
  publication_date: '2026-11-16',
  effective_on: null,
  abstract: 'The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.',
  agencies: USCG,
  action: 'Notification of enforcement of regulation.',
  correction_of: null,
  dates: 'The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on December 13, 2026.',
  ...over,
});

describe('parseFederalRegister: a date stated only in the DATES field', () => {
  it('writes "Stated effective" for a notification of enforcement with effective_on null, and no Effective sentence', () => {
    const [item] = parseFederalRegister({ results: [row({})] });
    expect(item!.body).toContain('Stated effective 2026-12-13.');
    expect(item!.body).not.toMatch(/\bEffective \d{4}-\d{2}-\d{2}\./);
  });

  it('reads 2026-23047 (enforced the day before publication) as its stated date; the detector, not the parser, judges it', () => {
    const [item] = parseFederalRegister({
      results: [row({
        document_number: '2026-23047',
        html_url: 'https://www.federalregister.gov/documents/2026/11/12/2026-23047/special-local-regulation',
        publication_date: '2026-11-12',
        dates: 'The regulations in 33 CFR 100.1101 will be enforced from 9 a.m. to 11 a.m. on November 11, 2026.',
      })],
    });
    expect(item!.body).toContain('Stated effective 2026-11-11.');
  });

  it('takes the earliest date when the field states several', () => {
    const [item] = parseFederalRegister({ results: [row({ dates: 'Enforced from December 20, 2026 through January 2, 2027, and on December 13, 2026.' })] });
    expect(item!.body).toContain('Stated effective 2026-12-13.');
  });

  it('keeps exactly the current body for a row that has effective_on', () => {
    const withEffective = row({ effective_on: '2026-11-12', dates: 'This rule is effective November 12, 2026.' });
    const [item] = parseFederalRegister({ results: [withEffective] });
    expect(item!.body).toBe('The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade. Effective 2026-11-12.');
  });

  it('parses a row whose dates field is null or states no "Month D, YYYY" date exactly as before', () => {
    const [none] = parseFederalRegister({ results: [row({ dates: null })] });
    expect(none!.body).toBe('The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.');
    const [vague] = parseFederalRegister({ results: [row({ dates: 'Effective upon publication; comments due within 30 days.' })] });
    expect(vague!.body).toBe('The Coast Guard will enforce a special local regulation for the Winterfest Boat Parade.');
  });

  it('leaves a correction (C1-2026-21030 shape: effective_on, dates and action null) as before', () => {
    const [item] = parseFederalRegister({
      results: [row({
        document_number: 'C1-2026-21030',
        html_url: 'https://www.federalregister.gov/documents/2026/11/12/C1-2026-21030/ap1000-design-certification-renewal',
        abstract: null,
        action: null,
        dates: null,
        correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-21030',
      })],
    });
    expect(item!.body).toBe('Corrects 2026-21030.');
  });

  it('never writes a marker for a correction, even when its dates field states a date', () => {
    const [item] = parseFederalRegister({
      results: [row({ correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-21030', dates: 'Effective December 13, 2026.' })],
    });
    expect(item!.body).not.toContain('Stated effective');
  });
});

describe('federalRegisterStatedDate', () => {
  it('reads only a real "Month D, YYYY" date', () => {
    expect(federalRegisterStatedDate('on December 13, 2026.')).toBe('2026-12-13');
    expect(federalRegisterStatedDate('on February 30, 2026.')).toBeNull();
    expect(federalRegisterStatedDate('on 2026-12-13.')).toBeNull();
    expect(federalRegisterStatedDate(null)).toBeNull();
  });
});

describe('a DATES field that also names dates that are not effective dates', () => {
  it('never reads a comment deadline as the stated effective date', () => {
    expect(federalRegisterStatedDate('Comments must be received by December 1, 2026.')).toBeNull();
    expect(federalRegisterStatedDate('This rule is effective December 15, 2026. Comments must be received by December 1, 2026.')).toBe('2026-12-15');
    expect(federalRegisterStatedDate('This rule is effective December 15, 2026; comments must be received by December 1, 2026.')).toBe('2026-12-15');
    expect(federalRegisterStatedDate('This rule is effective December 15, 2026, and comments must be received on or before December 1, 2026.')).toBe('2026-12-15');
  });

  it('never reads an earlier publication date as the stated effective date', () => {
    expect(federalRegisterStatedDate('The rule published March 3, 2025, will be enforced on December 13, 2026.')).toBe('2026-12-13');
    expect(federalRegisterStatedDate('This document corrects the rule published March 3, 2025.')).toBeNull();
  });

  it('reads no date a meeting cue introduces, and a bare date as before', () => {
    expect(federalRegisterStatedDate('A public meeting will be held on December 2, 2026.')).toBeNull();
    expect(federalRegisterStatedDate('A public meeting will be held on December 2, 2026. The rule is effective December 20, 2026.')).toBe('2026-12-20');
    expect(federalRegisterStatedDate('December 13, 2026.')).toBe('2026-12-13');
  });

  it('keeps every enforcement date of one sentence, from 5 p.m. through 8 p.m. included', () => {
    expect(federalRegisterStatedDate('The regulations in 33 CFR 100.1101 will be enforced from 5 p.m. through 8 p.m. on December 13, 2026.')).toBe('2026-12-13');
  });

  it('writes no marker from a row whose DATES names only a comment deadline', () => {
    const [item] = parseFederalRegister({ results: [row({ dates: 'Comments must be received by December 1, 2026.' })] });
    expect(item!.body).not.toContain('Stated effective');
  });
});

describe('federalRegisterActionStatesEffect: the action field limits who carries a stated date', () => {
  it('admits rules and notifications of enforcement', () => {
    expect(federalRegisterActionStatesEffect('Notification of enforcement of regulation.')).toBe(true);
    expect(federalRegisterActionStatesEffect('Final rule.')).toBe(true);
    expect(federalRegisterActionStatesEffect('Temporary final rule.')).toBe(true);
    expect(federalRegisterActionStatesEffect('Interim final rule; request for comments.')).toBe(true);
  });

  it('refuses a proposed rule, a notice, a correction and a missing action', () => {
    expect(federalRegisterActionStatesEffect('Proposed rule.')).toBe(false);
    expect(federalRegisterActionStatesEffect('Notice.')).toBe(false);
    expect(federalRegisterActionStatesEffect('Final rule; correction.')).toBe(false);
    expect(federalRegisterActionStatesEffect(null)).toBe(false);
  });

  it('writes no marker for a row whose action is a proposed rule, even when DATES states an effective date', () => {
    const [item] = parseFederalRegister({ results: [row({ action: 'Proposed rule.', dates: 'This rule will be enforced on December 13, 2026.' })] });
    expect(item!.body).not.toContain('Stated effective');
  });
});

describe('the request', () => {
  it('asks the API for dates and action alongside the existing fields', () => {
    const source = FEED_SOURCES.find((one) => one.id === 'federal-register-rules');
    expect(source?.url).toContain('fields%5B%5D=dates');
    expect(source?.url).toContain('fields%5B%5D=action');
    expect(source?.url).toContain('fields%5B%5D=effective_on');
    expect(source?.url).toContain('fields%5B%5D=correction_of');
  });
});
