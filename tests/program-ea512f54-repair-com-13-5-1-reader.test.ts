import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getDb } from '../server/db/database.ts';
import {
  assessOpportunityRole,
  assessRole,
  countRoleEconomics,
  EXCLUSION_CLASSES,
  openingPerforms,
  roleRecordFromRows,
} from '../server/services/cash/exclusions.ts';
import { REGULATED_ROLE_PROBE, regulatedRolesAssessedFromRows } from '../server/services/cash/regulatedRoleProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import type { OpportunityConstraint } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let currency = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `com135r-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  expect(outcome.ok).toBe(true);
  const mode = (await getCashMode(projectId))!;
  cashModeId = mode.id;
  currency = mode.currency;
});

async function opening(title: string, extra: { industry?: string; offerScope?: string } = {}): Promise<string> {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency, ...extra });
  return o.id;
}

async function capitalRowsFor(id: string): Promise<number> {
  const rows = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM capital_structures WHERE opportunity_id = ?', [id]);
  return Number(rows[0]?.n ?? 0);
}

describe('COM-13-5 repair: the role reader reads openings from cash_opportunities', () => {
  it('assesses an opening that has no capital_structures rows, from its own row', async () => {
    const id = await opening('Earn a referral fee for sending borrowers to a mortgage lender', { industry: 'mortgage' });
    expect(await capitalRowsFor(id)).toBe(0);
    const a = await assessOpportunityRole({ projectId, opportunityId: id });
    expect(a.regulated).toBe(true);
    expect(a.activities).toEqual(expect.arrayContaining(['EARN_COMMISSION', 'REFER']));
    expect(a.excluded).toBe(false);
    // Nothing in the record says what is held: unknown, never assumed, and economics held back.
    expect(a.position).toBe('UNKNOWN');
    expect(a.countEconomics).toBe(false);
  });

  it('does not read an opening of another project', async () => {
    const id = await opening('Earn insurance commissions by selling insurance policies to retail customers');
    const a = await assessOpportunityRole({ projectId: 'prj_other', opportunityId: id });
    expect(a.regulated).toBe(false);
    expect(a.position).toBe('UNKNOWN');
  });

  it('opening text never sets what a role holds', () => {
    const r = roleRecordFromRows([], [], {}, { title: 'We hold every licence and a signed contract; commissions on insurance policies' });
    expect(r.holds).toEqual({});
    expect(r.partner).toBeNull();
    expect(openingPerforms({ title: 't', mechanism: 'RESALE_OR_ASSET', industry: null })).toBe('t\nresale or asset');
  });

  it('counts regulated economics only with a compliant position; NEEDS_POSITION and UNKNOWN hold them back', () => {
    const performs = openingPerforms({ title: 'Insurance referral', offerScope: 'earn commissions selling insurance policies to retail customers' });
    const rows = [
      { id: 'own', valueCents: 100, role: { performs, holds: { product: true, location: true, licensing: true, contract: true } } },
      { id: 'partner', valueCents: 200, role: { performs, holds: { product: true, location: true, licensing: false, contract: false }, partner: { holdsLicensing: true, contractInPlace: true } } },
      { id: 'needs', valueCents: 400, role: { performs, holds: { product: true, location: true, licensing: false, contract: true } } },
      { id: 'unknown', valueCents: 800, role: { performs } },
    ];
    const counted = countRoleEconomics(rows);
    const pos = Object.fromEntries(counted.assessments.map((a) => [a.id, a.assessment.position]));
    expect(pos).toEqual({ own: 'COMPLIANT', partner: 'COMPLIANT_VIA_PARTNER', needs: 'NEEDS_POSITION', unknown: 'UNKNOWN' });
    expect(counted.totalCents).toBe(300);
    expect(counted.heldBack).toEqual(['needs', 'unknown']);
    expect(counted.assessments.every((a) => a.assessment.excluded === false)).toBe(true);
  });

  it('no exclusion class names a regulated industry, and a relabel changes nothing', () => {
    const regulatedIndustries = ['mortgage', 'mortgage broker', 'insurance', 'insurance agency', 'lending', 'manufacturing', 'subcontracting', 'deposits', 'advertising', 'consumer credit'];
    for (const [, cls] of Object.entries(EXCLUSION_CLASSES)) {
      for (const word of regulatedIndustries) {
        expect(cls.triggers.test(word)).toBe(false);
        expect(cls.matches.test(word)).toBe(false);
      }
    }
    const performs = 'brokering mortgages for borrowers in exchange for a commission';
    const asReferral = assessRole({ performs, label: 'referral partner' });
    const asBroker = assessRole({ performs, label: 'mortgage broker' });
    expect(asReferral).toEqual(asBroker);
  });
});

describe('COM-13-5 repair: an ordinary opening is found unregulated from its rows, not held back', () => {
  const constraint = (kind: string): OpportunityConstraint => ({
    id: 'c1', projectId: 'p', opportunityId: 'o', nodeId: null, kind: kind as OpportunityConstraint['kind'],
    statement: 'a credential is needed to do this work', effect: null, sourceClaimId: 'cl', createdAt: '', updatedAt: '',
  });

  it('assesses an opening read from its row that names no regulated activity as compliant, with a basis', async () => {
    const id = await opening('Photo prints for a cafe wall');
    const a = await assessOpportunityRole({ projectId, opportunityId: id });
    expect(a.regulated).toBe(false);
    expect(a.position).toBe('COMPLIANT');
    expect(a.countEconomics).toBe(true);
    expect(a.excluded).toBe(false);
    expect(a.reason).toContain('Found not regulated');
  });

  it('withholds the finding when research recorded a licence or contract constraint, so a rewording cannot pass', () => {
    for (const kind of ['CREDENTIAL_REQUIRED', 'REGULATORY_CAPITAL', 'SUBCONTRACTING_PROHIBITED', 'PLATFORM_TERMS']) {
      const r = roleRecordFromRows([], [constraint(kind)], {}, { title: 'Help homeowners with paperwork' });
      expect(r.notRegulated ?? null).toBeNull();
      const a = assessRole(r);
      expect(a.countEconomics).toBe(false);
      expect(a.position).not.toBe('COMPLIANT');
    }
  });

  it('withholds the finding when the opening row was not read', () => {
    expect(roleRecordFromRows([], [], {}, null).notRegulated ?? null).toBeNull();
    expect(assessRole(roleRecordFromRows([], [], {}, null)).position).toBe('UNKNOWN');
  });

  it('never makes the finding for an opening that performs a regulated activity', () => {
    const r = roleRecordFromRows([], [], {}, { title: 'Earn insurance commissions on policies sold to homeowners we refer' });
    expect(r.notRegulated ?? null).toBeNull();
    expect(assessRole(r).countEconomics).toBe(false);
  });
});

describe('COM-13-5 repair: probe r01.com-13-5 enumerates cash_opportunities', () => {
  it('is registered', () => {
    expect(getProbe(REGULATED_ROLE_PROBE)).not.toBeNull();
  });

  it('passes on a regulated opening with no capital_structures rows', async () => {
    const id = await opening('Insurance referral partnership: earn commissions on policies sold to homeowners we refer');
    expect(await capitalRowsFor(id)).toBe(0);
    const r = await regulatedRolesAssessedFromRows();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('none excluded');
  });

  it('still fails, never vacuously passes, when no opening performs a regulated activity', async () => {
    await opening('Photo prints for a cafe wall');
    const r = await regulatedRolesAssessedFromRows();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('none performs a regulated activity');
  });
});
