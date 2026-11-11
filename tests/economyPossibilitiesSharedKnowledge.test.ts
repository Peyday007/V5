/**
 * A10: general knowledge one goal established supports a later goal without
 * the research being repeated — through the shared_findings boundary, with
 * real promoted rows, and with nothing private crossing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment,
} from '../server/repos/research.ts';
import { listFindings, promoteEligibleClaims } from '../server/repos/sharedFindings.ts';
import { watchersOf } from '../server/repos/economy.ts';
import { factKey } from '../server/services/economy/possibilities/screen.ts';
import { keepScreened, visiblePossibilities, type Actor } from '../server/services/economy/possibilities/store.ts';
import { answerFromSharedKnowledge } from '../server/services/economy/possibilities/knowledge.ts';

const SUBJECT = 'Commercial cleaning contracts';
const limits = { capitalLimitCents: 100_000, cashDeadlineDays: 30 };

let origin: TestProject;
let laterProjectId = '';
let bob: Actor;
let alice: Actor;
let n = 0;

beforeEach(async () => {
  origin = await freshProject();
  laterProjectId = (await createProject({ name: 'Later goal', slug: `later-${Math.random().toString(36).slice(2, 8)}` })).id;
  const mk = async (who: string) =>
    (await createUser({ email: `${who}-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: who, password: 'correct horse battery staple' })).id;
  bob = { type: 'PERSON', userId: await mk('bob') };
  alice = { type: 'PERSON', userId: await mk('alice') };
});

/** Research an earlier goal in the origin project already paid for: one accepted claim. */
async function earlierResearch(input: {
  definition: string; publisher: string; population?: string; geography?: string | null; accepted?: boolean;
}): Promise<string> {
  n += 1;
  const projectId = origin.project.id;
  const layer = await origin.layerByName('Monetization Logic');
  const run = await createRun({
    projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'earlier goal',
  });
  const orchestration = await createOrchestration({
    projectId, layerId: layer.id, runId: run.id, title: `earlier ${n}`, assignment: 'payment terms',
    provider: 'WORKER', autoApprove: false,
  });
  await createFragments([{
    orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'anywhere',
    requiredEvidence: [{ id: 'lane', description: 'a source', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['a published contract'], excludedSourceTypes: [], completionCriteria: ['one dated source'],
    minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: `frag-${n}`,
    question: 'When are cleaning contractors paid?', dependsOn: [], attempt: 1,
  }] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
  const [claim] = await insertClaims([{
    orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
    claim: `Commercial cleaning contracts pay on net terms (${n})`,
    sourceUrl: `https://${input.publisher.replace(/\s+/g, '').toLowerCase()}.example/terms-${n}`,
    sourceTitle: 'Terms', sourcePublisher: input.publisher, sourceDate: '2026-09-10',
    evidenceExcerpt: 'payment within 14 days of invoice', evidenceLocator: 'section 4', evidenceLane: 'lane',
    retrievedAt: '2026-09-12', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
    sourced: true, claimType: 'SOURCED_FACT' as const, contentHash: `h-${n}`,
    population: input.population ?? SUBJECT, geography: input.geography ?? null, definition: input.definition,
  }]);
  await decideClaim(claim!.id, input.accepted === false
    ? { accepted: false, rejectionReason: 'off scope' }
    : { accepted: true });
  await promoteEligibleClaims();
  return claim!.id;
}

const keepLater = (requirements: Record<string, string[]>) =>
  keepScreened({
    actor: alice, projectId: laterProjectId, ownerUserId: alice.userId, kind: 'OPPORTUNITY',
    title: 'Clean offices', requirements, limits,
  });

async function researchRowsIn(projectId: string): Promise<number> {
  const r = await getDb().get<{ k: number }>(
    'SELECT COUNT(*) AS k FROM research_orchestrations WHERE project_id = ?', [projectId]);
  return Number(r?.k ?? 0);
}

describe('shared knowledge supports a later goal without repeating the research', () => {
  it('answers the missing fact from two independent shared findings, advances, and starts no research', async () => {
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'Cleaning Trade Association' });
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'State Procurement Office' });
    expect((await listFindings()).length).toBe(2);

    const kept = await keepLater({ subject: [SUBJECT], capital: ['ownerCapitalCents:20000'] });
    expect(kept.screen.verdict).toBe('HOLD');
    expect((await watchersOf(laterProjectId, factKey('paidAfterDays'))).map((w) => w.possibilityId))
      .toEqual([kept.possibility.id]);

    const r = await answerFromSharedKnowledge({
      actor: alice, projectId: laterProjectId, ownerUserId: alice.userId, possibilityId: kept.possibility.id, limits,
    });
    expect(r.unanswered).toEqual([]);
    expect(r.answered).toHaveLength(1);
    expect(r.answered[0]!.fact).toBe('paidAfterDays');
    expect(r.answered[0]!.value).toBe(14);
    expect(r.answered[0]!.findingIds).toHaveLength(2);
    expect(r.screen.verdict).toBe('ADVANCE');

    // The watch was met by the shared findings, once; nothing is left waiting on research.
    expect(await watchersOf(laterProjectId, factKey('paidAfterDays'))).toEqual([]);
    const trig = await getDb().get<{ trigger_change_ref: string }>(
      'SELECT trigger_change_ref FROM possibility_conditions WHERE possibility_id = ?', [kept.possibility.id]);
    expect(trig!.trigger_change_ref).toMatch(/^shared:/);

    // Persisted, with the provenance of the answer, and no research in the later project.
    const [stored] = await visiblePossibilities(alice, laterProjectId, alice.userId);
    expect(stored!.requirements['knowledge']).toEqual(['paidAfterDays:14']);
    expect(stored!.requirements['sharedFindings']![0]).toMatch(/^paidAfterDays=/);
    expect(stored!.parkedReason).toBeNull();
    expect(await researchRowsIn(laterProjectId)).toBe(0);

    // Nothing private crossed: the later owner sees only their own possibility.
    expect((await visiblePossibilities(alice, laterProjectId, alice.userId)).map((p) => p.title)).toEqual(['Clean offices']);
  });

  it('a shared answer can reject as surely as a researched one, and the new limit is watched', async () => {
    await earlierResearch({ definition: 'paidAfterDays:60', publisher: 'A' });
    await earlierResearch({ definition: 'paidAfterDays:60', publisher: 'B' });
    const kept = await keepLater({ subject: [SUBJECT], capital: ['ownerCapitalCents:20000'] });
    const r = await answerFromSharedKnowledge({
      actor: alice, projectId: laterProjectId, ownerUserId: alice.userId, possibilityId: kept.possibility.id, limits,
    });
    expect(r.screen.verdict).toBe('REJECT');
    expect((await watchersOf(laterProjectId, 'CASH_DEADLINE')).map((w) => w.possibilityId)).toEqual([kept.possibility.id]);
  });

  it('one publisher, disagreement, a rejected claim, another subject or an unfitting geography leave the fact to research', async () => {
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'Only One' });
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'Rejected Pub', accepted: false });
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'Elsewhere', population: 'Residential window cleaning' });
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'Scoped', geography: 'Ontario' });
    const kept = await keepLater({ subject: [SUBJECT], capital: ['ownerCapitalCents:20000'] });
    const one = await answerFromSharedKnowledge({
      actor: alice, projectId: laterProjectId, ownerUserId: alice.userId, possibilityId: kept.possibility.id, limits,
    });
    expect(one.answered).toEqual([]);
    expect(one.unanswered[0]!.reason).toMatch(/only 1 independent publisher/);
    expect(one.screen.verdict).toBe('HOLD');

    await earlierResearch({ definition: 'paidAfterDays:45', publisher: 'Disagrees' });
    const split = await answerFromSharedKnowledge({
      actor: alice, projectId: laterProjectId, ownerUserId: alice.userId, possibilityId: kept.possibility.id, limits,
    });
    expect(split.answered).toEqual([]);
    expect(split.unanswered[0]!.reason).toMatch(/disagree/);
    expect(await watchersOf(laterProjectId, factKey('paidAfterDays'))).toHaveLength(1);
  });

  it('a possibility with no stated subject is never matched by guesswork', async () => {
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'A' });
    await earlierResearch({ definition: 'paidAfterDays:14', publisher: 'B' });
    const kept = await keepLater({ capital: ['ownerCapitalCents:20000'] });
    const r = await answerFromSharedKnowledge({
      actor: alice, projectId: laterProjectId, ownerUserId: alice.userId, possibilityId: kept.possibility.id, limits,
    });
    expect(r.answered).toEqual([]);
    expect(r.unanswered[0]!.reason).toMatch(/no subject/);
  });

  it('refuses a worker and another person, without saying whether the possibility exists', async () => {
    const kept = await keepLater({ subject: [SUBJECT], capital: ['ownerCapitalCents:20000'] });
    const ask = (actor: Actor) => answerFromSharedKnowledge({
      actor, projectId: laterProjectId, ownerUserId: alice.userId, possibilityId: kept.possibility.id, limits,
    });
    await expect(ask({ type: 'WORKER', userId: alice.userId })).rejects.toThrow(/nothing here/);
    await expect(ask(bob)).rejects.toThrow(/nothing here/);
    await expect(answerFromSharedKnowledge({
      actor: alice, projectId: laterProjectId, ownerUserId: alice.userId, possibilityId: 'pos_missing', limits,
    })).rejects.toThrow(/nothing here/);
  });
});
