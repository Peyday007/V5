/**
 * ORIGINATED:UNMET_NEED:count-the-economics-of-v. A position need is raised by the regulated-role
 * reader without a blocker key, so the self-model grouped every one of them by its blocked action
 * with the quoted opening title erased: unrelated openings read as one "missing resource" that the
 * untyped WATCH owner never acquires. The cash tick (operate.ts) now gives each the key its own next
 * step names — the licensed partner it needs, by what the opening performs — routed to the commercial
 * workflow and never to a person. The key is the opening's own: two openings performing the same
 * activity can differ in product, location and contract, so an activity is not a shared resource.
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
import { recordMoney } from '../server/repos/cashLedger.ts';
import { recordConstraint } from '../server/repos/industry.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';

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
    // Performing the same activity is not sharing a resource: each need closes only on its own
    // opening's product, location and contract, so each key is that opening's own.
    expect(new Set(after.map((n) => n.blockerKey)).size).toBe(3);
    expect(keyOf.get(insuranceA)).not.toBe(keyOf.get(insuranceB));
    expect(keyOf.get(insuranceA)!.replace(/@.*$/, '')).toBe(keyOf.get(insuranceB)!.replace(/@.*$/, ''));
    expect(keyOf.get(mortgage)).not.toBe(keyOf.get(insuranceA));
    // No group keyed by the erased title remains, and no activity-wide group replaces it: nothing
    // claims that one acquisition serves several of these openings.
    const weaknesses = weaknessesOf(after);
    expect(weaknesses.map((w) => w.key)).not.toContain(FALSE_GROUP);
    expect(weaknesses).toEqual([]);
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

  it('keys every opening to itself, so openings sharing an activity never form a shared group', () => {
    const a = regulatedPositionBlockerKey('opp_a', []);
    const b = regulatedPositionBlockerKey('opp_b', []);
    // An opening with no recognised activity is not regulated: it lacks a finding, never a licensed partner.
    expect(a).toBe('EVIDENCE:regulated-position:opp_a');
    expect(a).not.toMatch(/licensed-partner/);
    expect(needExecutionOwner(a).route).toBe('RESEARCH');
    expect(a).not.toBe(b);
    expect(regulatedPositionBlockerKey('x', ['EARN_COMMISSION', 'BROKER', 'BROKER'])).toBe('SUPPLIER:licensed-partner/BROKER+EARN_COMMISSION@x');
    const same = ['opp_1', 'opp_2', 'opp_3'].map((id) => regulatedPositionBlockerKey(id, ['EARN_COMMISSION']));
    expect(new Set(same).size).toBe(3);
    // Fed to the self-model as open needs on three openings, they originate no weakness at all.
    const grouped = unmetNeedWeaknesses(
      same.map((key, i) => ({
        id: `need_${i}`,
        opportunityId: `opp_${i + 1}`,
        blockerKey: key,
        blockedAction: `count the economics of "opening ${i + 1}"`,
        recommendedPath: 'Establish what this role needs for its product and location.',
        expectedCostCents: null,
      })),
    );
    expect(grouped).toEqual([]);
  });

  it('an unregulated opening held back only for its settled cash is not said to need a licensed partner', async () => {
    // Research recorded a platform-terms constraint against an opening whose text names no regulated
    // activity: the reader withholds the not-regulated finding, so its settled cash is held back.
    const plain = await opening('Photo prints for a cafe wall');
    const layer = await getDb().all<{ id: string }>('SELECT id FROM layers WHERE project_id = ? LIMIT 1', [projectId]);
    const run = await createRun({ projectId, layerId: layer[0]!.id, runType: 'FOUNDATION', provider: 'WORKER' });
    const orchestration = await createOrchestration({ projectId, layerId: layer[0]!.id, runId: run.id, title: 'rpk fixture', assignment: 'terms', provider: 'WORKER' });
    const claimId = `clm_rpk_${Math.random().toString(36).slice(2, 10)}`;
    await getDb().run(
      `INSERT INTO research_claims
         (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
          source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
          retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
          validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
       VALUES (?, ?, NULL, NULL, 'RESEARCH', ?, ?, NULL, NULL, NULL, NULL, NULL, 'lane-1',
               ?, 0.9, 'UNCHALLENGED', NULL, 'VALID', NULL, 1, 0, '[]', 1, ?, ?)`,
      [claimId, orchestration.id, 'The marketplace terms govern resale of prints.', 'https://example.test/terms', '2026-11-01T00:00:00.000Z', `hash-${claimId}`, '2026-11-01T00:00:00.000Z'] as never[],
    );
    expect(await recordConstraint({ projectId, opportunityId: plain, nodeId: null, kind: 'PLATFORM_TERMS', statement: 'The marketplace terms govern resale of prints.', sourceClaimId: claimId })).not.toBeNull();
    const settled = await recordMoney({ projectId, opportunityId: plain, kind: 'SETTLEMENT', amountCents: 10_000, currency, verifiedReference: `ref-${plain}`, recordedBy: userId, idempotencyKey: `settle-${plain}` });
    expect(settled.ok).toBe(true);

    const role = await assessOpportunityRole({ projectId, opportunityId: plain });
    expect(role).toMatchObject({ regulated: false, countEconomics: false, activities: [] });

    const tick = await operate(projectId);
    expect(tick.failures.filter((f) => f.step === 'typeRegulatedPositionNeeds' || f.step === 'seekCompliantPositions')).toEqual([]);
    const need = (await positionNeeds()).find((n) => n.opportunityId === plain)!;
    expect(need).toBeDefined();
    expect(need.blockerKey).not.toBeNull();
    expect(need.blockerKey).not.toMatch(/licensed-partner/);
    expect(need.blockerKey!.startsWith('SUPPLIER:')).toBe(false);
    expect(need.blockerKey).toBe(`EVIDENCE:regulated-position:${plain}`);
    expect(parseBlockerKey(need.blockerKey)).toBe(need.blockerKey);
    expect(needExecutionOwner(need.blockerKey).route).toBe('RESEARCH');
  });
});
