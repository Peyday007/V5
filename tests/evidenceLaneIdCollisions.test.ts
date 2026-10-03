import { describe, expect, it } from 'vitest';
import { isLaneId, laneIdFrom, laneIds, parseLanes } from '../server/domain/evidenceLanes.ts';

describe('lane id collisions', () => {
  it('keeps both lanes when two prose lanes open with the same words', () => {
    const lanes = parseLanes([
      'Official county fee schedules for recording deeds',
      'Official county fee schedules for recording mortgages',
    ]);
    expect(lanes).toHaveLength(2);
    expect(laneIds(lanes)).toEqual(['official_county_fee_schedules', 'official_county_fee_schedules_2']);
    expect(lanes[1]?.description).toContain('mortgages');
    expect(lanes.every((l) => l.necessity === 'REQUIRED')).toBe(true);
  });

  it('prefixes digit-leading derivations rather than collapsing them', () => {
    expect(laneIdFrom('2024 annual filings')).toBe('lane_2024_annual_filings');
    const lanes = parseLanes(['2024 annual filings', '2025 quarterly filings']);
    expect(laneIds(lanes)).toEqual(['lane_2024_annual_filings', 'lane_2025_quarterly_filings']);
    expect(laneIds(lanes).every(isLaneId)).toBe(true);
  });

  it('suffixes a third collision and stays within the id limit', () => {
    const lanes = parseLanes(['alpha beta gamma delta one', 'alpha beta gamma delta two', 'alpha beta gamma delta three']);
    expect(laneIds(lanes)).toEqual(['alpha_beta_gamma_delta', 'alpha_beta_gamma_delta_2', 'alpha_beta_gamma_delta_3']);
    const long = 'x'.repeat(45);
    const ids = laneIds(parseLanes([`${long} a`, `${long} b`]));
    expect(ids[0]).toHaveLength(40);
    expect(ids[1]).toHaveLength(40);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(isLaneId)).toBe(true);
  });

  it('does not let a derived id take one a declared lane names', () => {
    const lanes = parseLanes([
      { description: 'Official county fee schedules for recording deeds' },
      { id: 'official_county_fee_schedules', description: 'declared', necessity: 'OPTIONAL' },
    ]);
    expect(laneIds(lanes)).toEqual(['official_county_fee_schedules_2', 'official_county_fee_schedules']);
  });

  it('keeps first-wins for genuinely duplicated declared ids', () => {
    const lanes = parseLanes([
      { id: 'operative_authority', description: 'first', necessity: 'REQUIRED' },
      { id: 'operative_authority', description: 'second', necessity: 'OPTIONAL' },
    ]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.description).toBe('first');
  });
});
