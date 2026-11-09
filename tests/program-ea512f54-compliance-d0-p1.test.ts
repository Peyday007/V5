import { describe, expect, it } from 'vitest';
import {
  EXCLUSION_CLASSES,
  REGULATED_ACTIVITIES,
  ROLE_REQUIREMENTS,
  assessRole,
  countRoleEconomics,
  regulatedActivitiesIn,
} from '../server/services/cash/exclusions.ts';

const ALL_HELD = { product: true, location: true, licensing: true, contract: true } as const;

describe('regulated roles are assessed, never excluded by category (COM-13-5)', () => {
  it('names no regulated industry as an exclusion class', () => {
    const words = JSON.stringify(Object.values(EXCLUSION_CLASSES).map((c) => c.matches.source));
    for (const industry of ['mortgage', 'insurance', 'manufactur', 'deposit', 'advertis']) {
      expect(words.toLowerCase()).not.toContain(industry);
    }
  });

  it('recognises activities by what is done', () => {
    expect(regulatedActivitiesIn('earns a referral fee for sending borrowers to a lender')).toEqual(
      expect.arrayContaining(['EARN_COMMISSION', 'REFER']),
    );
    expect(regulatedActivitiesIn('sells mineral deposits photos')).toEqual([]);
    expect(Object.keys(REGULATED_ACTIVITIES).length).toBeGreaterThan(0);
  });

  it('holds back economics until a compliant position exists, then counts them', () => {
    const performs = 'earns a referral fee for sending borrowers to a lender';
    const lacking = assessRole({ performs, holds: { ...ALL_HELD, licensing: false } });
    expect(lacking.position).toBe('NEEDS_POSITION');
    expect(lacking.countEconomics).toBe(false);
    expect(lacking.excluded).toBe(false);

    const viaPartner = assessRole({
      performs,
      holds: { ...ALL_HELD, licensing: false },
      partner: { holdsLicensing: true, contractInPlace: true },
    });
    expect(viaPartner.position).toBe('COMPLIANT_VIA_PARTNER');
    expect(viaPartner.countEconomics).toBe(true);
  });

  it('treats an unstated requirement as unknown, never as held', () => {
    const a = assessRole({ performs: 'sells insurance policies', holds: { product: true } });
    expect(a.position).toBe('UNKNOWN');
    expect(a.unknown).toEqual(ROLE_REQUIREMENTS.filter((r) => r !== 'product'));
    expect(a.countEconomics).toBe(false);
  });

  it('judges what a role does, not the label it was given', () => {
    const relabelled = assessRole({ performs: 'brokers a mortgage loan for a fee', label: 'marketing partner', holds: {} });
    expect(relabelled.activities).toContain('BROKER');
    expect(relabelled.countEconomics).toBe(false);
  });

  it('does not count unrecognised text without a finding that it is unregulated', () => {
    expect(assessRole({ performs: 'does something unusual' }).countEconomics).toBe(false);
    expect(assessRole({ performs: 'does something unusual', notRegulated: { basis: 'reviewed: no licensed activity' } }).countEconomics).toBe(true);
  });

  it('counts economics only through assessed roles and records every assessment', () => {
    const result = countRoleEconomics([
      { id: 'compliant', role: { performs: 'earns a referral fee', holds: ALL_HELD }, valueCents: 50_000 },
      { id: 'needs', role: { performs: 'sells insurance policies', holds: { ...ALL_HELD, licensing: false } }, valueCents: 90_000 },
      { id: 'no-value', role: { performs: 'earns a referral fee', holds: ALL_HELD }, valueCents: null },
    ]);
    expect(result.totalCents).toBe(50_000);
    expect(result.heldBack).toEqual(['needs']);
    expect(result.assessments).toHaveLength(3);
    expect(result.assessments.every((a) => a.assessment.excluded === false)).toBe(true);
  });
});
