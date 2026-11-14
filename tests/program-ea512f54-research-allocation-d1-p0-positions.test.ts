/**
 * RES-15-4 (S-0148, S-0149, S-0150): the intermediation positions, the per-position evidence
 * contract, and the family's dated priority.
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_FIELD_KEYS,
  ENTRY_POINTS,
  INTERMEDIATION_FAMILY,
  POSITION_KEYS,
  POSITIONS,
  familyCurrent,
  positionEvidenceGaps,
  positionsToExamine,
  renewFamily,
  resolvePosition,
  type EvidenceField,
} from '../server/services/cash/intermediationPositions.ts';
import { STRUCTURE_KEYS, coherent } from '../server/services/cash/properties.ts';

const S0148 = [
  'introducer',
  'referrer',
  'representative',
  'lead supplier',
  'broker',
  'coordinator',
  'distributor',
  'reseller',
  'subcontracting principal',
  'marketplace',
  'control-right holder',
];

describe('positions (S-0148)', () => {
  it('catalogues every named position with a coherent structure mapping and what to investigate', () => {
    expect(POSITION_KEYS).toHaveLength(S0148.length);
    for (const name of S0148) {
      const resolved = resolvePosition(name);
      expect(resolved.catalogued, name).not.toBeNull();
      const def = resolved.definition!;
      expect(def.label).toBe(name);
      expect(STRUCTURE_KEYS).toContain(def.design.base);
      expect(coherent(def.design), name).toBe(true);
      expect(resolved.facts).not.toBeNull();
      expect(def.capitalExposure.length).toBeGreaterThan(0);
      for (const list of Object.values(def.investigate)) expect(list.length, name).toBeGreaterThan(0);
      expect(Object.keys(def.investigate).sort()).toEqual(['contracts', 'counterpartyExpectations', 'liabilities', 'restrictions', 'rights']);
    }
  });

  it('reads who pays from the design: a referral is paid by the supplier, a subcontract by the buyer', () => {
    expect(resolvePosition('INTRODUCER').facts!.payer).toBe('SUPPLIER');
    expect(resolvePosition('subcontracting principal').facts!.payer).toBe('BUYER');
    expect(resolvePosition('distributor').facts!.riskBearer).toBe('ARRANGER');
  });

  it('accepts a discovered position and carries its name verbatim — the catalogue is not a whitelist', () => {
    const name = 'Capacity-swap  Agent (night shifts)';
    const resolved = resolvePosition(name);
    expect(resolved.name).toBe(name);
    expect(resolved.catalogued).toBeNull();
    const withDesign = resolvePosition(name, POSITIONS.BROKER.design);
    expect(withDesign.facts!.payer).toBe('BUYER');
    const examined = positionsToExamine([name, 'broker', '  ']);
    expect(examined).toHaveLength(S0148.length + 1);
    expect(examined.at(-1)!.name).toBe(name);
  });
});

describe('positionEvidenceGaps (S-0150)', () => {
  it('names every field when nothing is established', () => {
    const gaps = positionEvidenceGaps('broker', { fields: {} });
    expect(gaps.map((g) => (g.kind === 'FIELD' ? g.field : g.kind))).toEqual(EVIDENCE_FIELD_KEYS);
    expect(gaps[0]!.ask).toContain('broker position');
  });

  it('names exactly the missing fields', () => {
    const fields: Partial<Record<EvidenceField, string | number | null>> = {};
    for (const key of EVIDENCE_FIELD_KEYS) fields[key] = 'established';
    fields.spread = null;
    fields.timing = '  ';
    const gaps = positionEvidenceGaps(resolvePosition('reseller'), { fields, bases: ['OBSERVED_TRANSACTION'] });
    expect(gaps.map((g) => (g.kind === 'FIELD' ? g.field : g.kind))).toEqual(['spread', 'timing']);
  });

  it('names buyer access and conversion as separate gaps when only an asking price or market size is known', () => {
    for (const bases of [['PUBLIC_ASKING_PRICE'], ['TOTAL_MARKET_SIZE'], ['PUBLIC_ASKING_PRICE', 'TOTAL_MARKET_SIZE']]) {
      const gaps = positionEvidenceGaps('distributor', { fields: { price: 12000 }, bases });
      const kinds = gaps.map((g) => g.kind);
      expect(kinds).toContain('BUYER_ACCESS');
      expect(kinds).toContain('CONVERSION');
    }
    const backed = positionEvidenceGaps('distributor', { fields: { price: 12000 }, bases: ['PUBLIC_ASKING_PRICE', 'BUYER_INQUIRY'] });
    expect(backed.map((g) => g.kind)).not.toContain('BUYER_ACCESS');
  });

  it('works for a discovered position', () => {
    const gaps = positionEvidenceGaps('allocation trader', { fields: {}, bases: ['TOTAL_MARKET_SIZE'] });
    expect(gaps.some((g) => g.ask.includes('allocation trader'))).toBe(true);
    expect(gaps.filter((g) => g.kind !== 'FIELD')).toHaveLength(2);
  });
});

describe('the intermediation family (S-0148, S-0149)', () => {
  it('is high priority only inside its declared window, and a lapsed window reads as not current', () => {
    expect(INTERMEDIATION_FAMILY.priority).toBe('HIGH');
    expect(familyCurrent(INTERMEDIATION_FAMILY, INTERMEDIATION_FAMILY.since)).toBe(true);
    expect(familyCurrent(INTERMEDIATION_FAMILY, '2026-01-01T00:00:00Z')).toBe(false);
    expect(familyCurrent(INTERMEDIATION_FAMILY, INTERMEDIATION_FAMILY.reviewBy)).toBe(false);
    expect(familyCurrent(INTERMEDIATION_FAMILY, '2030-01-01T00:00:00Z')).toBe(false);
    const renewed = renewFamily(INTERMEDIATION_FAMILY, '2031-01-01');
    expect(familyCurrent(renewed, '2030-01-01T00:00:00Z')).toBe(true);
    expect(INTERMEDIATION_FAMILY.reviewBy).not.toBe('2031-01-01');
  });

  it('declares buyer-first and supply-first entry points and refuses the owner-centred defaults', () => {
    expect(ENTRY_POINTS.BUYER_FIRST.length).toBeGreaterThan(0);
    expect(ENTRY_POINTS.SUPPLY_FIRST.length).toBeGreaterThan(0);
    expect(INTERMEDIATION_FAMILY.notDefaults).toEqual(expect.arrayContaining(['cold email', 'physical presence']));
  });
});
