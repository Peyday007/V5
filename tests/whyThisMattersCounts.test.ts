import { describe, expect, it } from 'vitest';
import { noteFor } from '../server/services/russell/whyThisMatters.ts';

const settled = (what: string, id: string) => ({ kind: 'LAYER_SETTLED', what, at: 'x', sourceId: id });

describe('noteFor counts', () => {
  it('keeps the two-foundation sentence for exactly two', () => {
    const note = noteFor({ milestones: [settled('A', 'a'), settled('B', 'b')], ambition: null, workingNow: 0 });
    expect(note).toMatch(/^Two foundations are settled now — A and B\./);
  });

  it('reports four settled foundations as four', () => {
    const note = noteFor({
      milestones: [settled('A', 'a'), settled('B', 'b'), settled('C', 'c'), settled('D', 'd')],
      ambition: null,
      workingNow: 0,
    });
    expect(note).toMatch(/^4 foundations are settled now, most recently A and B\./);
    expect(note).not.toMatch(/Two foundations/);
  });

  it('uses its own counts for filed and closed', () => {
    const filed = (id: string) => ({ kind: 'REPORT_FILED', what: 'r', at: 'x', sourceId: id });
    const closed = (id: string) => ({ kind: 'EDGE_CLOSED', what: 'e', at: 'x', sourceId: id });
    expect(noteFor({ milestones: [filed('1'), filed('2'), filed('3')], ambition: null, workingNow: 0 })).toMatch(/^3 reports/);
    expect(noteFor({ milestones: [closed('1'), closed('2'), closed('3'), closed('4')], ambition: 'x', workingNow: 0 })).toMatch(/^4 questions/);
  });
});
