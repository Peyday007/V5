/**
 * The SQUEEZE goal execution policy (owner, 2026-11-06): a cash target with a
 * deadline has no market-testing phase. An opening qualifies on what a
 * responsible offer needs, and demand, price acceptance and time to cash are
 * learned by selling — for every such goal, read from the goal rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { goalExecutionPolicy, LEARNED_BY_SELLING, SQUEEZE_QUALIFICATION } from '../server/domain/goalPolicy.ts';
import { qualificationKeys, TEST_FIRST_QUALIFICATION, UNIVERSAL_QUALIFICATION } from '../server/services/cash/tier.ts';
import { executionPolicyForProject, forgetExecutionPolicies } from '../server/services/goals/policy.ts';

describe('which goals are SQUEEZE goals', () => {
  it('is every goal with money still to collect and a deadline', () => {
    expect(goalExecutionPolicy({ daysLeft: 21, remainingCents: 1_000_000 })).toBe('SQUEEZE');
    expect(goalExecutionPolicy({ daysLeft: 400, remainingCents: 5_000 })).toBe('SQUEEZE');
    expect(goalExecutionPolicy({ daysLeft: null, remainingCents: 1_000_000 })).toBe('EVIDENCE_FIRST');
    expect(goalExecutionPolicy({ daysLeft: 21, remainingCents: 0 })).toBe('EVIDENCE_FIRST');
  });
});

describe('what a SQUEEZE goal needs before it sells', () => {
  it('asks what a responsible offer needs and leaves what selling reveals to the sale', () => {
    const squeeze = qualificationKeys(null, false, 'SQUEEZE');
    for (const key of ['payer', 'offer', 'access', 'delivery', 'fulfillment', 'directCosts', 'requiredCapital', 'eligibility', 'disqualifiers']) {
      expect(squeeze, key).toContain(key);
    }
    // Learned by selling, so never researched first to qualify an experiment.
    for (const key of ['timeToFirstCash', 'revenueRange', 'confidence', 'recommendation', 'laborNeeds', 'phoneDependency', 'fulfilmentModel']) {
      expect(squeeze, key).not.toContain(key);
    }
    expect(squeeze.length).toBeLessThan(UNIVERSAL_QUALIFICATION.length);
    expect([...SQUEEZE_QUALIFICATION].every((key) => (UNIVERSAL_QUALIFICATION as readonly string[]).includes(key))).toBe(true);
    // The rest of the Brain keeps its bar.
    expect(qualificationKeys(null)).toEqual([...UNIVERSAL_QUALIFICATION]);
    expect(qualificationKeys(null, true, 'SQUEEZE')).toEqual([...TEST_FIRST_QUALIFICATION]);
    expect(LEARNED_BY_SELLING).toContain('CONVERSION');
  });

  it('still requires what a kind of evidence needs to be delivered at all', () => {
    const resale = qualificationKeys('RESALABLE_ASSET_OPENING', false, 'SQUEEZE');
    const plain = qualificationKeys('RESALABLE_ASSET_OPENING');
    const extras = plain.filter((key) => !(UNIVERSAL_QUALIFICATION as readonly string[]).includes(key));
    expect(extras.length).toBeGreaterThan(0);
    for (const extra of extras) expect(resale).toContain(extra);
  });
});

describe('the policy is read from the goal rows, for every project', () => {
  beforeEach(async () => {
    await freshProject();
    forgetExecutionPolicies();
  });

  it('is SQUEEZE while a live goal with a target and a future deadline serves the project, and not otherwise', async () => {
    const db = getDb();
    const project = await db.get<{ id: string }>('SELECT id FROM projects LIMIT 1');
    const now = new Date();
    expect(await executionPolicyForProject(project!.id, now)).toBe('EVIDENCE_FIRST');
    forgetExecutionPolicies();
    await db.run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at, target_metric, target_amount_cents, target_project_id, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['wst_sq', project!.id, 'Cash', 'Collect cash', 'REVENUE_DIRECT', now.toISOString(), now.toISOString(), 'SETTLED_CASH', 500_000, project!.id, new Date(now.getTime() + 14 * 86_400_000).toISOString()],
    );
    expect(await executionPolicyForProject(project!.id, now)).toBe('SQUEEZE');
    // Paused, it no longer governs the project's selling.
    forgetExecutionPolicies();
    await db.run(`UPDATE workstreams SET paused_at = ? WHERE id = 'wst_sq'`, [now.toISOString()]);
    expect(await executionPolicyForProject(project!.id, now)).toBe('EVIDENCE_FIRST');
  });
});
