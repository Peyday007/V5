/**
 * The free lane asks packets in the research allocation's order before its
 * ordinary scan. Ties used to break by packet id, so within one priority a few
 * projects' packets took every scarce fragment start (fragments start only
 * while web search can feed them) while another goal's research waited
 * (production 2026-11-26: dec1125c p10, nine fragments, none started). Each
 * project's best packet now goes before any project's second, as the claim
 * scan orders rows.
 */
import { describe, expect, it } from 'vitest';
import { packetsByAllocation } from '../server/services/freeLane/worker.ts';

describe('packets asked in the allocation order give each project its turn', () => {
  it('puts every project’s first packet before any project’s second at one priority, oldest first', () => {
    const order = packetsByAllocation([
      { id: 'orc_a1', top: 9, shift: 0, projectId: 'A', oldest: '2026-11-25T01:00:00Z' },
      { id: 'orc_a2', top: 9, shift: 0, projectId: 'A', oldest: '2026-11-25T02:00:00Z' },
      { id: 'orc_a3', top: 9, shift: 0, projectId: 'A', oldest: '2026-11-25T03:00:00Z' },
      { id: 'orc_z1', top: 9, shift: 0, projectId: 'Z', oldest: '2026-11-25T20:00:00Z' },
    ]);
    expect(order).toEqual(['orc_a1', 'orc_z1', 'orc_a2', 'orc_a3']);
  });

  it('still lets the decision’s step and stored priority come first', () => {
    const order = packetsByAllocation([
      { id: 'orc_low', top: 7, shift: 0, projectId: 'B', oldest: '2026-11-20T00:00:00Z' },
      { id: 'orc_stepped', top: 7, shift: 1, projectId: 'C', oldest: '2026-11-25T00:00:00Z' },
      { id: 'orc_a2', top: 9, shift: 0, projectId: 'A', oldest: '2026-11-25T02:00:00Z' },
      { id: 'orc_a1', top: 9, shift: 0, projectId: 'A', oldest: '2026-11-25T01:00:00Z' },
    ]);
    expect(order).toEqual(['orc_a1', 'orc_a2', 'orc_stepped', 'orc_low']);
  });
});
