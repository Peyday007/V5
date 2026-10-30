import { describe, expect, it } from 'vitest';
import { assertBoundary, checkBoundary, destinationFor } from '../server/services/routing/boundary/boundary.ts';
import { decideLane } from '../server/services/conversation/lanes.ts';

const base = { text: 'a plain question', turnCount: 1, fastLaneAvailable: true };

describe('routing boundary', () => {
  it('sends each declared kind to exactly one destination', () => {
    expect(destinationFor('SOFTWARE_CHANGE')).toBe('FACTORY');
    expect(destinationFor('RESEARCH_QUESTION')).toBe('RESEARCH_QUEUE');
  });
  it('refuses a crossing in both directions, with the reason', () => {
    expect(checkBoundary('SOFTWARE_CHANGE', 'RESEARCH_QUEUE')).toMatchObject({ ok: false });
    expect(checkBoundary('RESEARCH_QUESTION', 'FACTORY').reason).toMatch(/research queue/);
    expect(checkBoundary('SOFTWARE_CHANGE', 'FACTORY')).toEqual({ ok: true, reason: null });
    expect(() => assertBoundary('RESEARCH_QUESTION', 'FACTORY')).toThrow();
    expect(() => assertBoundary('RESEARCH_QUESTION', 'RESEARCH_QUEUE')).not.toThrow();
  });
  it('lane decision routes a declared software change to the Factory, in the work lane', () => {
    const d = decideLane({ ...base, workKind: 'SOFTWARE_CHANGE' });
    expect(d.lane).toBe('WORK');
    expect(d.destination).toBe('FACTORY');
  });
  it('lane decision routes a declared research question to the research queue only', () => {
    const d = decideLane({ ...base, workKind: 'RESEARCH_QUESTION' });
    expect(d.lane).toBe('WORK');
    expect(d.destination).toBe('RESEARCH_QUEUE');
  });
  it('does not infer a kind from the words', () => {
    const d = decideLane({ ...base, text: 'implement the login page' });
    expect(d.destination).toBeNull();
  });
  it('keeps a declared kind out of the fast lane even when it reads like recall', () => {
    const d = decideLane({ ...base, text: 'what did we decide about the fee?', workKind: 'RESEARCH_QUESTION' });
    expect(d.lane).toBe('WORK');
  });
});
