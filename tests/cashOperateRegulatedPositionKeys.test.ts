/**
 * ORIGINATED:UNMET_NEED:count-the-economics-of-v. A position need is raised by the regulated-role
 * reader without a blocker key, so the self-model grouped every one of them by its blocked action
 * with the quoted opening title erased: unrelated openings read as one "missing resource" that the
 * untyped WATCH owner never acquires. The cash tick (operate.ts) now gives each the key its own next
 * step names — the licensed partner it needs, by what the opening performs — routed to the commercial
 * workflow and never to a person.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, listNeeds, setNeedBlockerKeyIfUnset } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { operate, regulatedPositionBlockerKey, typeRegulatedPositionNeeds } from '../server/services/cash/operate.ts';
import { assessOpportunityRole } from '../server/services/cash/exclusions.ts';
import { seekCompliantPositions } from '../server/services/cash/regulatedPositions.ts';
import { needExecutionOwner } from '../server/services/cash/needs.ts';
import { unmetNeedWeaknesses } from '../server/services/selfmodel/originate.ts';
import { parseBlockerKey } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let currency = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `rpk-${Math.random().toString(36).slice(2, 10)}@example.test`,
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

async function opening(title: string): Promise<string> {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency });
  return o.id;
}

async function positionNeeds() {
  return (await listNeeds({ projectId, states: ['OPEN'] })).filter((n) => n.requestKey?.startsWith('regulated-position:'));
}

function weaknessesOf(needs: Awaited<ReturnType<typeof positionNeeds>>) {
  return unmetNeedWeaknesses(
    needs.map((n) => ({
      id: n.id,
      opportunityId: n.opportunityId,
      blockerKey: n.blockerKey,
      blockedAction: n.blockedAction,
      recommendedPath: n.recommendedPath,
      expectedCostCents: null,
    })),
  );
}

const FALSE_GROUP = 'ORIGINATED:UNMET_NEED:count-the-economics-of-v';

describe('regulated-position needs carry a typed blocker key', () => {
  it('reproduces the false shared-resource group, and the cash tick dissolves it into typed keys', async () => {
    const insuranceA = await opening('Earn insurance commissions on policies sold to homeowners we refer');
    const insuranceB = await opening('Earn insurance commissions on policies sold to renters we refer');
    const mortgage = await opening('Broker mortgages for borrowers');

    // The failure class: untyped needs on unrelated openings collapse into one group.
    await seekCompliantPositions(projectId);
    const before = await positionNeeds();
    expect(before).toHaveLength(3);
    expect(before.every((n) => n.blockerKey === null)).toBe(true);
    expect(weaknessesOf(before).map((w) => w.key)).toContain(FALSE_GROUP);

    const tick = await operate(projectId);
    expect(tick.failures.filter((f) => f.step === 'typeRegulatedPositionNeeds' || f.step === 'seekCompliantPositions')).toEqual([]);

    const after = await positionNeeds();
    expect(after).toHaveLength(3);
    const keyOf = new Map(after.map((n) => [n.opportunityId, n.blockerKey]));
    for (const id of [insuranceA, insuranceB, mortgage]) {
      const key = keyOf.get(id)!;
      expect(key).toMatch(/^SUPPLIER:licensed-partner\//);
      expect(parseBlockerKey(key)).toBe(key);
      const activities = (await assessOpportunityRole({ projectId, opportunityId: id })).activities;
      expect(key).toBe(regulatedPositionBlockerKey(id, activities));
      const owner = needExecutionOwner(key);
      expect(owner.route).toBe('COMMERCIAL');
      expect(owner.route).not.toBe('PERSON');
    }
    // Openings that perform the same thing need the same licensed partner, and share its key.
    expect(keyOf.get(insuranceA)).toBe(keyOf.get(insuranceB));
    expect(keyOf.get(mortgage)).not.toBe(keyOf.get(insuranceA));
    // No group keyed by the erased title remains.
    expect(weaknessesOf(after).map((w) => w.key)).not.toContain(FALSE_GROUP);
  });

  it('is idempotent and never replaces a key a need already has', async () => {
    const own = await opening('Earn insurance commissions on policies sold to homeowners we refer');
    const other = await opening('Broker mortgages for borrowers');
    const pass = await seekCompliantPositions(projectId);
    const preset = (await positionNeeds()).find((n) => n.opportunityId === own)!;
    expect(await setNeedBlockerKeyIfUnset(preset.id, 'FIELD:licence')).toBe(true);

    const first = await typeRegulatedPositionNeeds(projectId, pass);
    expect(first).toHaveLength(1);
    const keyed = await positionNeeds();
    expect(keyed.find((n) => n.opportunityId === own)!.blockerKey).toBe('FIELD:licence');
    const otherKey = keyed.find((n) => n.opportunityId === other)!.blockerKey;
    expect(otherKey).toMatch(/^SUPPLIER:licensed-partner\//);

    const again = await typeRegulatedPositionNeeds(projectId, await seekCompliantPositions(projectId));
    expect(again).toEqual([]);
    expect((await positionNeeds()).find((n) => n.opportunityId === other)!.blockerKey).toBe(otherKey);
  });

  it('keys an opening with no recognised activity to itself, so it can never form a shared group', () => {
    const a = regulatedPositionBlockerKey('opp_a', []);
    const b = regulatedPositionBlockerKey('opp_b', []);
    expect(a).toBe('SUPPLIER:licensed-partner/unrecognised:opp_a');
    expect(a).not.toBe(b);
    expect(regulatedPositionBlockerKey('x', ['EARN_COMMISSION', 'BROKER', 'BROKER'])).toBe('SUPPLIER:licensed-partner/BROKER+EARN_COMMISSION');
  });
});
