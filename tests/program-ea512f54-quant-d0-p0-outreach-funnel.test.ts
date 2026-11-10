import { describe, expect, it } from 'vitest';
import { rateRange, searchOutreachMix, type OutreachMechanism } from '../server/services/cash/funnel.ts';

const base: OutreachMechanism = {
  key: 'k', mechanism: 'm', channel: 'email', mode: 'VOLUME', permission: true, openings: 5,
  messagesSent: 100, uniqueProspects: 90, undeliverable: 10, replied: 8, qualified: 4, agreed: 2,
  settled: 1, repeat: 0, settledCents: 5000, capacityPerDay: 900, unknownStages: [],
};

describe('COM-13-3 outreach funnel', () => {
  it('bounds buyers by prospects reached, never by messages sent', () => {
    const { ranked } = searchOutreachMix([{ ...base, agreed: 500 }]);
    expect(ranked[0]!.reachedProspects.high).toBe(80);
    expect(ranked[0]!.buyers.high!).toBeLessThanOrEqual(80);
  });
  it('leaves a mechanism with no messages unranked, with unknowns named', () => {
    const r = searchOutreachMix([{ ...base, messagesSent: null, uniqueProspects: null, unknownStages: ['replied'] }]);
    expect(r.ranked).toHaveLength(0);
    expect(r.unranked).toHaveLength(1);
  });
  it('reports unknown rates as null, not zero', () => {
    expect(rateRange(null, null)).toEqual({ low: null, high: null });
    expect(rateRange(0, 0)).toEqual({ low: null, high: null });
  });
});
