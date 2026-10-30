import { describe, expect, it } from 'vitest';
import {
  assertBoundary,
  checkBoundary,
  destinationFor,
} from '../server/services/routing/boundary/index.ts';
import { decideLane } from '../server/services/conversation/lanes.ts';

describe('routing boundary', () => {
  it('routes each domain to exactly one destination', () => {
    expect(destinationFor('SOFTWARE_CHANGE')).toBe('FACTORY');
    expect(destinationFor('RESEARCH')).toBe('RESEARCH_QUEUE');
  });

  it('refuses a crossing in both directions', () => {
    expect(checkBoundary('SOFTWARE_CHANGE', 'RESEARCH_QUEUE').ok).toBe(false);
    expect(checkBoundary('RESEARCH', 'FACTORY').ok).toBe(false);
    expect(checkBoundary('RESEARCH', 'RESEARCH_QUEUE').ok).toBe(true);
    expect(() => assertBoundary('SOFTWARE_CHANGE', 'RESEARCH_QUEUE')).toThrow();
    expect(() => assertBoundary('SOFTWARE_CHANGE', 'FACTORY')).not.toThrow();
  });

  it('sends a declared software change to the Factory', () => {
    const d = decideLane({
      text: 'Make the footer smaller',
      turnCount: 1,
      fastLaneAvailable: true,
      asksForSoftwareChange: true,
    });
    expect(d.lane).toBe('WORK');
    expect(d.destination).toBe('FACTORY');
  });

  it('keeps a research request on the research queue even if it says build', () => {
    const d = decideLane({
      text: 'research how others build the ledger',
      turnCount: 1,
      fastLaneAvailable: true,
    });
    expect(d.lane).toBe('WORK');
    expect(d.destination).toBe('RESEARCH_QUEUE');
  });

  it('gives no destination to a directly answered turn', () => {
    const d = decideLane({ text: 'what did we decide', turnCount: 1, fastLaneAvailable: true });
    expect(d.lane).toBe('FAST');
    expect(d.destination).toBeNull();
  });
});
