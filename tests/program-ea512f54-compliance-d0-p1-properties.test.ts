import { describe, expect, it } from 'vitest';
import {
  REGULATED_ACTIVITIES,
  ROLE_REQUIREMENTS,
  assessRole,
  countRoleEconomics,
  type RoleRecord,
  type RoleRequirement,
} from '../server/services/cash/exclusions.ts';

// Every held/lacking/unknown combination of the four requirements: 3^4 = 81 records.
const STATES = [true, false, undefined] as const;
function allHolds(): Partial<Record<RoleRequirement, boolean>>[] {
  let acc: Partial<Record<RoleRequirement, boolean>>[] = [{}];
  for (const req of ROLE_REQUIREMENTS) {
    acc = acc.flatMap((base) => STATES.map((s) => (s === undefined ? { ...base } : { ...base, [req]: s })));
  }
  return acc;
}
const PERFORMS = [
  'earns a referral fee for sending borrowers to a lender',
  'brokers a mortgage loan for a fee',
  'sells insurance policies',
  'takes customer deposits for made-to-order goods',
  'does something unusual',
];
const PARTNERS: RoleRecord['partner'][] = [null, { holdsLicensing: true, contractInPlace: true }, { holdsLicensing: true, contractInPlace: false }, { holdsLicensing: false, contractInPlace: true }];

describe('COM-13-5 properties', () => {
  it('a role is never excluded, whatever it performs, holds or has a partner for', () => {
    for (const performs of PERFORMS) for (const holds of allHolds()) for (const partner of PARTNERS) {
      expect(assessRole({ performs, holds, partner }).excluded).toBe(false);
    }
  });

  it('relabelling a role changes nothing about its assessment', () => {
    for (const performs of PERFORMS) for (const holds of allHolds()) for (const partner of PARTNERS) {
      const base = assessRole({ performs, holds, partner });
      for (const label of [null, 'marketing partner', 'consultant', 'not regulated', 'licensed broker']) {
        expect(assessRole({ performs, holds, partner, label })).toEqual(base);
      }
    }
  });

  it('the partner branch counts only when the partner holds the licence under a contract and nothing else is lacking or unknown', () => {
    const performs = 'earns a referral fee for sending borrowers to a lender';
    const full = { product: true, location: true, licensing: false, contract: true } as const;
    const ok = assessRole({ performs, holds: full, partner: { holdsLicensing: true, contractInPlace: true } });
    expect(ok.position).toBe('COMPLIANT_VIA_PARTNER');
    expect(ok.countEconomics).toBe(true);
    for (const partner of [null, { holdsLicensing: true, contractInPlace: false }, { holdsLicensing: false, contractInPlace: true }] as const) {
      expect(assessRole({ performs, holds: full, partner }).countEconomics).toBe(false);
    }
    // A partner cannot supply a missing product or location right, nor cover unstated requirements.
    expect(assessRole({ performs, holds: { ...full, product: false }, partner: { holdsLicensing: true, contractInPlace: true } }).countEconomics).toBe(false);
    expect(assessRole({ performs, holds: { licensing: false }, partner: { holdsLicensing: true, contractInPlace: true } })).toMatchObject({ position: 'NEEDS_POSITION', countEconomics: false });
  });

  it('economics enter a figure only for roles whose assessment allows it, for every combination', () => {
    for (const holds of allHolds()) {
      const role: RoleRecord = { performs: 'sells insurance policies', holds };
      const { totalCents, assessments, heldBack } = countRoleEconomics([{ id: 'r', role, valueCents: 1000 }]);
      const a = assessRole(role);
      expect(totalCents).toBe(a.countEconomics ? 1000 : 0);
      expect(heldBack).toEqual(a.countEconomics ? [] : ['r']);
      expect(assessments[0]?.assessment.excluded).toBe(false);
    }
  });

  it('no regulated industry is named as a blanket category in the activity patterns', () => {
    expect(Object.keys(REGULATED_ACTIVITIES)).not.toEqual(expect.arrayContaining(['MORTGAGE', 'INSURANCE']));
  });
});
