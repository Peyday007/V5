import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCapitalEntry } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, insertClaims } from '../server/repos/research.ts';
import type { Layer } from '../server/domain/types.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { REGULATED_ROLE_PROBE, regulatedRolesAssessedFromRows } from '../server/services/cash/regulatedRoleProbe.ts';
import '../server/services/cash/exclusions.ts';

let projectId = '';
let userId = '';
let nodeId = '';
let cashModeId = '';
let currency = '';
let layer: Layer;
let claimId = '';


beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `com135-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  expect(outcome.ok).toBe(true);
  const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
  nodeId = seed.node.id;
  const mode = (await getCashMode(projectId))!;
  cashModeId = mode.id;
  currency = mode.currency;
  // capital_structures rows must cite a research claim; one real claim, unique per row via the entry's own kind.
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orch = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 't', assignment: 'a', provider: 'WORKER', autoApprove: false });
  await createFragments([
    { orchestrationId: orch.id, projectId, layerId: layer.id, geography: 'g', requiredEvidence: [{ id: 'lane', description: 'd', necessity: 'REQUIRED' }], acceptableSourceTypes: ['x'], excludedSourceTypes: ['y'], completionCriteria: ['z'], minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'k', question: 'q', dependsOn: [], attempt: 1 },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orch.id);
  const [claim] = await insertClaims([
    { orchestrationId: orch.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const, claim: 'c', sourceUrl: 'https://example.test/a', sourceTitle: 't', sourcePublisher: 'p', sourceDate: '2026-09-10', evidenceExcerpt: 'c', evidenceLocator: 'l', evidenceLane: 'lane', retrievedAt: '2026-09-12', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const, contentHash: 'h' },
  ] as unknown as Parameters<typeof insertClaims>[0]);
  claimId = claim!.id;
});

async function opening(title: string): Promise<string> {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency, industryNodeId: nodeId });
  return o.id;
}

describe('r01.com-13-5 reads production rows (COM-13-5)', () => {
  it('is a registered probe, so it never answers UNKNOWN', () => {
    expect(getProbe(REGULATED_ROLE_PROBE)).not.toBeNull();
  });

  it('does not pass with no rows to demonstrate on', async () => {
    expect((await regulatedRolesAssessedFromRows()).ok).toBe(false);
  });

  it('does not pass when no row performs a regulated activity', async () => {
    const id = await opening('Photo prints');
    await recordCapitalEntry({ projectId, opportunityId: id, entryKind: 'REQUIREMENT', requirement: 'EQUIPMENT', statement: 'buys a printer', sourceClaimId: claimId });
    const r = await regulatedRolesAssessedFromRows();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('none performs a regulated activity');
  });

  it('passes on a regulated role held back, not excluded, and reports its position', async () => {
    const id = await opening('Referral of borrowers');
    await recordCapitalEntry({ projectId, opportunityId: id, entryKind: 'REQUIREMENT', requirement: 'LICENSING', statement: 'earns a referral fee for sending borrowers to a lender', sourceClaimId: claimId });
    const r = await regulatedRolesAssessedFromRows();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('1 needing a position');
  });
});
